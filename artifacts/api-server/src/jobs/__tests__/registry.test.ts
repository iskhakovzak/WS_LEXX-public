import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cronMatches, nextCronRun, nyParts, parseCron } from "../cron";
import { clearJobs, emitJobEvent, jobsStatus, registerJob, runJobNow, setJobDeps } from "../registry";
import { runMigrationFiles } from "../../db/runner";
import { createScratchDb, pgAvailable } from "../../db/__tests__/scratchDb";
import { intervalCron } from "../../lib/propreports/scheduler";

const available = await pgAvailable();
const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("cron (America/New_York)", () => {
  it("parses fields, steps, ranges and lists", () => {
    const e = parseCron("*/15 9-16 * * 1-5");
    expect([...e.minute.set]).toEqual([0, 15, 30, 45]);
    expect(e.hour.set.has(16)).toBe(true);
    expect(e.dow.set.has(0)).toBe(false);
    expect(parseCron("0 0 * * 7").dow.set.has(0)).toBe(true);
    expect(() => parseCron("61 * * * *")).toThrow();
    expect(() => parseCron("* * *")).toThrow();
  });

  it("matches New York wall-clock time across DST", () => {
    const e = parseCron("15 3 * * *");
    expect(cronMatches(e, new Date("2026-07-01T07:15:00Z"))).toBe(true); // EDT: 03:15
    expect(cronMatches(e, new Date("2026-12-01T08:15:00Z"))).toBe(true); // EST: 03:15
    expect(cronMatches(e, new Date("2026-12-01T07:15:00Z"))).toBe(false);
    expect(nyParts(new Date("2026-10-16T20:00:00Z"))).toMatchObject({ year: 2026, month: 10, day: 16, hour: 16, minute: 0, weekday: 5 });
  });

  it("day-of-month OR day-of-week when both are restricted; next run", () => {
    const e = parseCron("0 12 1 * 5");
    expect(cronMatches(e, new Date("2026-10-16T16:00:00Z"))).toBe(true); // a Friday
    expect(cronMatches(e, new Date("2026-10-01T16:00:00Z"))).toBe(true); // the 1st (Thursday)
    expect(nextCronRun(parseCron("0 17 * * 5"), new Date("2026-10-17T12:00:00Z"))?.toISOString()).toBe("2026-10-23T21:00:00.000Z");
  });

  it("PropReports interval → cron", () => {
    expect(intervalCron(15)).toBe("*/15 * * * *");
    expect(intervalCron(7)).toBe("*/6 * * * *");
    expect(intervalCron(120)).toBe("0 */2 * * *");
    expect(intervalCron(60)).toBe("0 * * * *");
  });
});

describe.skipIf(!available)("job registry (scratch database)", () => {
  let db: Awaited<ReturnType<typeof createScratchDb>>;
  beforeAll(async () => {
    db = await createScratchDb("jobs");
    await runMigrationFiles({ pool: db.pool, logger: silent });
    setJobDeps({ pool: db.pool, logger: silent });
  });
  afterAll(async () => { await db?.drop(); });
  beforeEach(async () => {
    clearJobs();
    await db.pool.query(`TRUNCATE job_runs`);
  });

  const runs = async (job: string) => (await db.pool.query(`SELECT status, trigger, error, details FROM job_runs WHERE job = $1 ORDER BY id`, [job])).rows;

  it("writes a job_runs row with status and details", async () => {
    registerJob({ name: "t.ok", timeoutMs: 5000, run: async () => ({ done: 3 }) });
    expect(await runJobNow("t.ok")).toBe("ok");
    expect(await runs("t.ok")).toEqual([{ status: "ok", trigger: "manual", error: null, details: { done: 3 } }]);
  });

  it("records errors and timeouts", async () => {
    registerJob({ name: "t.err", timeoutMs: 5000, run: async () => { throw new Error("boom"); } });
    registerJob({ name: "t.slow", timeoutMs: 50, run: ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 20))) });
    expect(await runJobNow("t.err")).toBe("error");
    expect((await runs("t.err"))[0]).toMatchObject({ status: "error", error: "boom" });
    expect(await runJobNow("t.slow")).toBe("timeout");
    expect((await runs("t.slow"))[0]).toMatchObject({ status: "timeout" });
  });

  it("the advisory lock prevents a second process from running the same job", async () => {
    const run = vi.fn(async () => ({}));
    registerJob({ name: "t.locked", timeoutMs: 5000, run });
    const other = await db.pool.connect(); // "another process" holding the job lock
    try {
      await other.query(`SELECT pg_advisory_lock(hashtext('job:t.locked'))`);
      expect(await runJobNow("t.locked", { trigger: "schedule" })).toBe("skipped");
      expect(run).not.toHaveBeenCalled();
      expect((await runs("t.locked"))[0]).toMatchObject({ status: "skipped", trigger: "schedule", error: "locked by another process" });
    } finally {
      await other.query(`SELECT pg_advisory_unlock(hashtext('job:t.locked'))`);
      other.release();
    }
    expect(await runJobNow("t.locked")).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("no overlap inside one process", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = vi.fn(async () => { await gate; return {}; });
    registerJob({ name: "t.overlap", timeoutMs: 5000, run });
    const first = runJobNow("t.overlap");
    await new Promise((r) => setTimeout(r, 50));
    expect(await runJobNow("t.overlap")).toBe("skipped");
    release();
    expect(await first).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("events trigger listening jobs with the payload; status lists the registry", async () => {
    const seen: unknown[] = [];
    registerJob({ name: "t.event", on: ["propreports.synced"], timeoutMs: 5000, run: async ({ payload, trigger }) => { seen.push({ payload, trigger }); return {}; } });
    registerJob({ name: "t.cron", cron: "0 3 * * *", timeoutMs: 5000, enabled: () => false, run: async () => ({}) });
    emitJobEvent("propreports.synced", { traders: ["A"] });
    await vi.waitFor(() => expect(seen).toEqual([{ payload: { traders: ["A"] }, trigger: "event" }]));
    await vi.waitFor(async () => expect((await runs("t.event"))[0]?.status).toBe("ok"));
    const status = await jobsStatus();
    expect(status.map((s) => s.name)).toEqual(["t.event", "t.cron"]);
    expect(status[0].last).toMatchObject({ status: "ok", trigger: "event" });
    expect(status[1]).toMatchObject({ enabled: false, cron: "0 3 * * *", nextRunAt: null, last: null });
  });
});
