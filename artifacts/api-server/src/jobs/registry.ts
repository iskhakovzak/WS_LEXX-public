/**
 * Background-job registry (ARCHITECTURE.md §2.7, backend.md Phase 3). The ONLY place that starts timers.
 *
 *   registerJob({ name, cron, run, timeoutMs })   declare (module import has no side effects)
 *   startJobScheduler()                          index.ts, after listen
 *   stopJobScheduler()                           graceful shutdown: no new runs, waits for in-flight ones
 *   runJobNow(name, { trigger, payload })        admin «Запустить» / tests; resolves with the run status
 *   emitJobEvent(event, payload)                 domain event → every job with `on: [event]` (fire-and-forget)
 *
 * Every run:
 *   • takes `pg_try_advisory_lock(hashtext('job:' || name))` on a dedicated connection — a second process (deploy
 *     overlap, a dev server on the same DB) skips the run and records `skipped`;
 *   • is also guarded in-process (no overlap of the same job);
 *   • writes one `job_runs` row: running → ok | error | timeout | skipped, with duration, error text and the job's
 *     returned details (JSON);
 *   • gets an AbortSignal that fires at `timeoutMs`; the row is marked `timeout`, the lock is held until the run
 *     really settles, so a timed-out run can never overlap the next one.
 *
 * Schedules are 5-field cron on New York wall-clock time (jobs/cron.ts). The tick runs once per minute.
 */
import os from "node:os";
import { pool } from "@workspace/db";
import { logger as appLogger } from "../lib/logger";
import { cronMatches, nextCronRun, parseCron, type CronExpr } from "./cron";
import type { LoggerLike, PgPoolLike } from "../db/runner";

export type JobTrigger = "schedule" | "startup" | "manual" | "event";
export type JobStatus = "running" | "ok" | "error" | "timeout" | "skipped";

export type JobContext = {
  signal: AbortSignal;
  trigger: JobTrigger;
  /** Event payload (for `on:` triggers) or the manual payload. */
  payload?: unknown;
  logger: LoggerLike;
  runId: number | null;
};

export type JobDef = {
  /** Stable id, also the i18n key suffix on the admin page (`jobs.names.<name>`): "propreports.sync". */
  name: string;
  /** 5-field cron in America/New_York. Omit for event/manual-only jobs. */
  cron?: string;
  /** Domain events that trigger a run (emitJobEvent). */
  on?: string[];
  /** Run once after start (delay in ms). */
  runOnStartMs?: number;
  timeoutMs: number;
  /** false ⇒ not scheduled (e.g. not configured in this environment); still listed on the admin page. */
  enabled?: () => boolean;
  /** Returned value is stored in job_runs.details (keep it small). */
  run: (ctx: JobContext) => Promise<unknown>;
};

type Registered = JobDef & { expr: CronExpr | null };

const jobs = new Map<string, Registered>();
const inFlight = new Map<string, Promise<JobStatus>>();
let deps: { pool: PgPoolLike; logger: LoggerLike } = { pool: pool as unknown as PgPoolLike, logger: appLogger };
let tickTimer: NodeJS.Timeout | null = null;
const startTimers = new Set<NodeJS.Timeout>();
let stopping = false;
let started = false;
const HOST = `${os.hostname()}:${process.pid}`;

/** Tests: inject a pool/logger (e.g. a scratch database). */
export function setJobDeps(d: Partial<typeof deps>): void {
  deps = { ...deps, ...d };
}

export function registerJob(def: JobDef): void {
  if (!/^[a-z][a-z0-9_.-]*$/.test(def.name)) throw new Error(`job name "${def.name}" must be lower-case dotted`);
  if (jobs.has(def.name)) throw new Error(`job "${def.name}" registered twice`);
  jobs.set(def.name, { ...def, expr: def.cron ? parseCron(def.cron) : null });
}

/** Tests only. */
export function clearJobs(): void {
  jobs.clear();
}

export function listJobs(): readonly Registered[] {
  return [...jobs.values()];
}

function isEnabled(j: JobDef): boolean {
  try {
    return j.enabled ? j.enabled() : true;
  } catch {
    return false;
  }
}

async function insertRun(name: string, trigger: JobTrigger, status: JobStatus, error: string | null = null): Promise<number | null> {
  try {
    const c = await deps.pool.connect();
    try {
      const { rows } = await c.query(
        `INSERT INTO job_runs (job, trigger, status, error, host, finished_at, duration_ms)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $3 = 'running' THEN NULL ELSE now() END, CASE WHEN $3 = 'running' THEN NULL ELSE 0 END)
         RETURNING id`,
        [name, trigger, status, error, HOST],
      );
      return Number(rows[0]?.id ?? 0) || null;
    } finally {
      c.release();
    }
  } catch (err) {
    deps.logger.warn({ err, job: name }, "jobs: could not write job_runs");
    return null;
  }
}

async function finishRun(id: number | null, status: JobStatus, ms: number, error: string | null, details: unknown): Promise<void> {
  if (id == null) return;
  let json: string | null = null;
  try {
    json = details === undefined ? null : JSON.stringify(details)?.slice(0, 20_000) ?? null;
    if (json !== null) JSON.parse(json);
  } catch {
    json = null;
  }
  try {
    const c = await deps.pool.connect();
    try {
      // Only a still-running row is finished; a row already marked `timeout` keeps that status.
      await c.query(
        `UPDATE job_runs SET status = CASE WHEN status = 'running' THEN $2 ELSE status END,
                finished_at = COALESCE(finished_at, now()), duration_ms = $3, error = COALESCE($4, error), details = $5::jsonb
          WHERE id = $1`,
        [id, status, ms, error ? error.slice(0, 4000) : null, json],
      );
    } finally {
      c.release();
    }
  } catch (err) {
    deps.logger.warn({ err, runId: id }, "jobs: could not finish job_runs row");
  }
}

/** Runs one job now (locks, history, timeout). Never throws; resolves with the final status. */
export function runJobNow(name: string, opts: { trigger?: JobTrigger; payload?: unknown } = {}): Promise<JobStatus> {
  const job = jobs.get(name);
  if (!job) return Promise.reject(new Error(`unknown job "${name}"`));
  const trigger = opts.trigger ?? "manual";
  const existing = inFlight.get(name);
  if (existing) {
    deps.logger.info({ job: name, trigger }, "jobs: already running in this process — skipped");
    return insertRun(name, trigger, "skipped", "already running in this process").then(() => "skipped" as const);
  }
  const p = execute(job, trigger, opts.payload).finally(() => inFlight.delete(name));
  inFlight.set(name, p);
  return p;
}

async function execute(job: Registered, trigger: JobTrigger, payload: unknown): Promise<JobStatus> {
  const { logger } = deps;
  let lockClient: Awaited<ReturnType<PgPoolLike["connect"]>> | null = null;
  try {
    lockClient = await deps.pool.connect();
    const { rows } = await lockClient.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [`job:${job.name}`]);
    if (!rows[0]?.ok) {
      lockClient.release();
      lockClient = null;
      logger.info({ job: job.name, trigger }, "jobs: locked by another process — skipped");
      await insertRun(job.name, trigger, "skipped", "locked by another process");
      return "skipped";
    }
  } catch (err) {
    lockClient?.release();
    logger.warn({ err, job: job.name }, "jobs: could not take the advisory lock — run skipped");
    return "skipped";
  }

  const runId = await insertRun(job.name, trigger, "running");
  const ac = new AbortController();
  const t0 = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort(new Error(`timeout after ${job.timeoutMs} ms`));
    logger.error({ job: job.name, timeoutMs: job.timeoutMs }, "jobs: run timed out");
    void finishRun(runId, "timeout", Date.now() - t0, `timeout after ${job.timeoutMs} ms`, undefined);
  }, job.timeoutMs);
  timer.unref?.();

  let status: JobStatus = "ok";
  let error: string | null = null;
  let details: unknown;
  try {
    details = await job.run({ signal: ac.signal, trigger, payload, logger, runId });
    if (timedOut) status = "timeout";
  } catch (err) {
    status = timedOut ? "timeout" : "error";
    error = err instanceof Error ? err.message : String(err);
    logger.error({ err, job: job.name, trigger }, "jobs: run failed");
  } finally {
    clearTimeout(timer);
  }
  await finishRun(runId, status, Date.now() - t0, error, details);
  try {
    await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`job:${job.name}`]);
  } catch {
    /* the session lock dies with the connection anyway */
  }
  lockClient.release();
  if (status === "ok") logger.info({ job: job.name, trigger, ms: Date.now() - t0 }, "jobs: run ok");
  return status;
}

/** Fire every enabled job listening to `event`. Never throws, never blocks the caller. */
export function emitJobEvent(event: string, payload?: unknown): void {
  if (stopping) return;
  for (const j of jobs.values()) {
    if (!j.on?.includes(event) || !isEnabled(j)) continue;
    void runJobNow(j.name, { trigger: "event", payload }).catch((err) => deps.logger.warn({ err, job: j.name, event }, "jobs: event run failed"));
  }
}

function tick(): void {
  if (stopping) return;
  const now = new Date();
  for (const j of jobs.values()) {
    if (!j.expr || !isEnabled(j)) continue;
    if (cronMatches(j.expr, now)) void runJobNow(j.name, { trigger: "schedule" }).catch(() => undefined);
  }
}

function scheduleNextTick(): void {
  if (stopping) return;
  const ms = 60_000 - (Date.now() % 60_000) + 250; // just after each minute boundary
  tickTimer = setTimeout(() => {
    tick();
    scheduleNextTick();
  }, ms);
  tickTimer.unref?.();
}

export function startJobScheduler(): void {
  if (started) return;
  started = true;
  stopping = false;
  for (const j of jobs.values()) {
    if (j.runOnStartMs == null || !isEnabled(j)) continue;
    const t = setTimeout(() => {
      startTimers.delete(t);
      void runJobNow(j.name, { trigger: "startup" }).catch(() => undefined);
    }, j.runOnStartMs);
    t.unref?.();
    startTimers.add(t);
  }
  scheduleNextTick();
  deps.logger.info(
    { jobs: [...jobs.values()].map((j) => `${j.name}${j.cron ? ` [${j.cron}]` : ""}${isEnabled(j) ? "" : " (disabled)"}`) },
    "jobs: scheduler started (cron in America/New_York)",
  );
}

/** Stops scheduling and waits up to `waitMs` for in-flight runs. */
export async function stopJobScheduler(waitMs = 10_000): Promise<void> {
  stopping = true;
  started = false;
  if (tickTimer) clearTimeout(tickTimer);
  tickTimer = null;
  for (const t of startTimers) clearTimeout(t);
  startTimers.clear();
  const running = [...inFlight.values()];
  if (running.length) {
    await Promise.race([Promise.allSettled(running), new Promise((r) => setTimeout(r, waitMs).unref?.())]);
  }
}

export type JobStatusRow = {
  name: string;
  cron: string | null;
  on: string[];
  enabled: boolean;
  running: boolean;
  timeoutMs: number;
  nextRunAt: string | null;
  last: { id: number; status: JobStatus; trigger: JobTrigger; startedAt: string; finishedAt: string | null; durationMs: number | null; error: string | null } | null;
  lastOk: string | null;
  failures24h: number;
};

/** Registry + latest job_runs per job (admin console). */
export async function jobsStatus(): Promise<JobStatusRow[]> {
  const c = await deps.pool.connect();
  let last: any[] = [];
  let stats: any[] = [];
  try {
    [{ rows: last }, { rows: stats }] = await Promise.all([
      c.query(`SELECT DISTINCT ON (job) id, job, status, trigger, started_at, finished_at, duration_ms, error
                 FROM job_runs WHERE status <> 'skipped' ORDER BY job, started_at DESC, id DESC`),
      c.query(`SELECT job, MAX(started_at) FILTER (WHERE status = 'ok') AS last_ok,
                      COUNT(*) FILTER (WHERE status IN ('error','timeout') AND started_at > now() - interval '24 hours')::int AS failures
                 FROM job_runs GROUP BY job`),
    ]);
  } catch (err) {
    deps.logger.warn({ err }, "jobs: status query failed (job_runs missing?)");
  } finally {
    c.release();
  }
  const lastBy = new Map(last.map((r) => [String(r.job), r]));
  const statBy = new Map(stats.map((r) => [String(r.job), r]));
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  const now = new Date();
  return [...jobs.values()].map((j) => {
    const l = lastBy.get(j.name);
    const s = statBy.get(j.name);
    const enabled = isEnabled(j);
    return {
      name: j.name,
      cron: j.cron ?? null,
      on: j.on ?? [],
      enabled,
      running: inFlight.has(j.name),
      timeoutMs: j.timeoutMs,
      nextRunAt: enabled && j.expr ? iso(nextCronRun(j.expr, now)) : null,
      last: l ? {
        id: Number(l.id), status: l.status, trigger: l.trigger, startedAt: iso(l.started_at)!, finishedAt: iso(l.finished_at),
        durationMs: l.duration_ms == null ? null : Number(l.duration_ms), error: l.error ?? null,
      } : null,
      lastOk: iso(s?.last_ok),
      failures24h: Number(s?.failures ?? 0),
    };
  });
}
