/**
 * Sync engine: round trips → journal trades (idempotent, trader-notes-safe).
 *
 *   planSync(trips)      read-only diff: insert / update / unchanged / adopt / conflict / skip
 *   applySync(plan)      writes inside one transaction + a propreports_sync_runs row
 *   mergePending(...)    reconcile inbox: broker numbers into a manual trade
 *   keepPending(...)     reconcile inbox: insert the broker trip as its own trade
 *
 * Ownership of trade columns:
 *   broker-owned (overwritten on every sync): ticker, date, side, entry, exit, qty, fees, pnl (gross),
 *     result, session, horizon, exit_date, hold_time, broker_account, synced_at, context_snapshot.propreports
 *   trader-owned (never touched): setup, playbook_id, tags, notes, what_worked/what_failed/conclusion,
 *     screenshots, conviction, confidence_grade, event_id, pattern_id, stop, risk_usd, r_multiple, slippage…
 *
 * Identity: (source='propreports', external_id). Trades imported by the legacy admin XLS endpoint
 * (context_snapshot.source='propreports', no external_id) are adopted by matching trader+ticker+side+openedAt
 * (or the legacy dedupKey) and receive an external_id instead of being duplicated.
 * A manual trade with the same trader+ticker+date+side and no external_id is a reconcile candidate:
 * the broker trip is parked in propreports_pending_trades until a curator merges or keeps it separate.
 * Dry runs call planSync only — no statement in planSync writes.
 */
import { pool } from "@workspace/db";
type PoolClient = { query: (typeof pool)["query"]; release: (err?: Error | boolean) => void };
import { logger } from "../logger";
import { logAudit } from "../audit";
import { invalidateDashboardCache } from "../hotCache";
import { refreshTradeStructures } from "../tradeStructureStore";
import { round2 } from "./csv";
import { applyFeeSettings, type DetectedFeeColumn } from "./fees";
import { getSettings, setSetting } from "./settings";
import type { RoundTrip } from "./types";
import { normResult } from "../tradeMath";
import { emitJobEvent } from "../../jobs/registry";

export type PlanAction = "insert" | "update" | "unchanged" | "adopt" | "conflict" | "skip";

export interface FieldChange { field: string; from: unknown; to: unknown }

export interface ManualCandidate {
  id: number;
  trader: string;
  ticker: string;
  date: string;
  side: string | null;
  setup: string | null;
  entry: number | null;
  exit: number | null;
  qty: number | null;
  pnl: number | null;
  fees: number | null;
  result: string;
  notes: string | null;
  tags: string | null;
  playbookId: number | null;
  createdAt: string;
}

export interface PlanItem {
  externalId: string;
  action: PlanAction;
  reason?: string;
  trader: string | null;
  account: string;
  tradeId: number | null;
  pendingId: number | null;
  changes: FieldChange[];
  candidates: ManualCandidate[];
  trip: RoundTrip;
}

export interface SyncPlan {
  items: PlanItem[];
  counts: Record<PlanAction, number>;
  unmappedAccounts: string[];
  inactiveAccounts: string[];
  dateFrom: string | null;
  dateTo: string | null;
  /** Fee column keys present in the trips (after settings were applied). */
  feeColumns: string[];
  /** raw account name → canonical mapping account, for names that matched only via alias / fuzzy rules. */
  resolvedAccounts: Record<string, { account: string; how: "alias" | "ci" | "fuzzy" }>;
}

export interface AccountMapping {
  id: number;
  account: string;
  accountId: string | null;
  accountName: string | null;
  trader: string | null;
  active: boolean;
  notes: string | null;
  aliases: string[];
  lastSyncedAt: string | null;
  lastFillAt: string | null;
}

export async function loadAccountMappings(client: Pick<PoolClient, "query"> = pool): Promise<AccountMapping[]> {
  const { rows } = await client.query(`SELECT * FROM propreports_accounts ORDER BY account ASC`);
  return rows.map((r: any) => ({
    id: Number(r.id),
    account: String(r.account),
    accountId: r.account_id ?? null,
    accountName: r.account_name ?? null,
    trader: r.trader ?? null,
    active: r.active !== false,
    notes: r.notes ?? null,
    aliases: Array.isArray(r.aliases) ? r.aliases.map(String) : [],
    lastSyncedAt: r.last_synced_at ? new Date(r.last_synced_at).toISOString() : null,
    lastFillAt: r.last_fill_at ?? null,
  }));
}

// ─── account matching ───────────────────────────────────────────────────────

/** Lower-case, strip separators, drop leading zeros and common prefixes/suffixes ("acct-", "_main", "-1"). */
export function normalizeAccountKey(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^(acct|account|acc)[\s:_-]*/, "");
  s = s.replace(/[\s_\-./]+/g, "");
  s = s.replace(/^0+(?=[a-z0-9])/, "");
  s = s.replace(/(main|master|live|demo|sim|prod)$/, "");
  s = s.replace(/^([a-z]+)0+(\d)/, "$1$2"); // WSL007 → wsl7
  return s;
}

export type AccountResolution = { mapping: AccountMapping; how: "exact" | "alias" | "ci" | "fuzzy" } | null;

/**
 * Fills `Account` → mapping: exact account / accountName / accountId → explicit alias → case-insensitive →
 * normalized (prefix/suffix/leading zeros stripped). Fuzzy matches are reported in SyncPlan.resolvedAccounts
 * so the owner can confirm them as aliases in the UI.
 */
export function resolveAccount(raw: string, mappings: AccountMapping[]): AccountResolution {
  const name = raw.trim();
  if (!name) return null;
  for (const m of mappings) if (m.account === name || m.accountName === name || m.accountId === name) return { mapping: m, how: "exact" };
  for (const m of mappings) if (m.aliases.some((a) => a === name)) return { mapping: m, how: "alias" };
  const lower = name.toLowerCase();
  for (const m of mappings) {
    if ([m.account, m.accountName ?? "", m.accountId ?? "", ...m.aliases].some((x) => x && x.toLowerCase() === lower)) return { mapping: m, how: "ci" };
  }
  const key = normalizeAccountKey(name);
  if (key.length >= 2) {
    for (const m of mappings) {
      if ([m.account, m.accountName ?? "", ...m.aliases].some((x) => x && normalizeAccountKey(x) === key)) return { mapping: m, how: "fuzzy" };
    }
  }
  return null;
}

const num = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
// money is stored at 4 decimals (NUMERIC(14,4), audit P0-1): a $0.0012 fee correction must count as a change
const near = (a: number | null, b: number | null, eps = 0.00005) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < eps);

/** Broker-owned columns as they should be after sync. */
function brokerFields(t: RoundTrip) {
  return {
    ticker: t.symbol,
    date: t.date,
    side: t.side,
    entry: t.avgEntry,
    exit: t.avgExit,
    qty: t.qty,
    fees: t.totalFees,
    pnl: t.grossPnl,
    // canonical code on write (win / loss / be / open): the parsers say "breakeven", the DB stores "be"
    result: normResult(t.result) ?? t.result,
    session: t.session,
    horizon: t.horizon,
    exitDate: t.exitDate,
    holdTime: t.holdTime,
    brokerAccount: t.account,
    /** Not a column (lives in context_snapshot) but drives the exit execution time, so a change must re-sync. */
    closedAt: t.closedAt ?? null,
  };
}

function diffBroker(existing: any, t: RoundTrip): FieldChange[] {
  const want = brokerFields(t);
  const have = {
    ticker: existing.ticker, date: String(existing.date ?? "").slice(0, 10), side: existing.side,
    entry: num(existing.entry), exit: num(existing.exit), qty: num(existing.qty), fees: num(existing.fees), pnl: num(existing.pnl),
    result: existing.result, session: existing.session, horizon: existing.horizon ?? null, exitDate: existing.exit_date ?? null,
    holdTime: existing.hold_time ?? null, brokerAccount: existing.broker_account ?? null,
    closedAt: existing.context_snapshot?.closedAt ?? null,
  };
  const changes: FieldChange[] = [];
  for (const k of Object.keys(want) as (keyof typeof want)[]) {
    const a = have[k], b = want[k];
    const same = typeof b === "number" || typeof a === "number" ? near(num(a), num(b)) : (a ?? null) === (b ?? null);
    if (!same) changes.push({ field: k, from: a ?? null, to: b ?? null });
  }
  return changes;
}

function contextPatch(t: RoundTrip) {
  return {
    source: "propreports",
    externalId: t.externalId,
    account: t.account,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    qty: t.qty,
    openQty: t.openQty,
    gross: t.grossPnl,
    totalFees: t.totalFees,
    net: t.netPnl,
    feesByType: t.fees,
    fillCount: t.fillCount,
    avgEntry: t.avgEntry,
    avgExit: t.avgExit,
    fromReport: !!t.fromReport,
  };
}

// ─── plan (read-only) ───────────────────────────────────────────────────────

export interface PlanOptions {
  /** Restrict to one trader's accounts (everything else → skip/forbidden). */
  onlyTrader?: string | null;
  /** Mappings that do not exist in the DB yet (admin XLS import dry run) — never persisted here. */
  virtualMappings?: Array<{ account: string; trader: string }>;
}

export async function planSync(tripsIn: RoundTrip[], opts: PlanOptions = {}): Promise<SyncPlan> {
  const [mappings, settings] = await Promise.all([loadAccountMappings(), getSettings()]);
  for (const v of opts.virtualMappings ?? []) {
    if (!mappings.some((m) => m.account === v.account)) {
      mappings.push({ id: 0, account: v.account, accountId: null, accountName: null, trader: v.trader, active: true, notes: null, aliases: [], lastSyncedAt: null, lastFillAt: null });
    }
  }
  // owner's fee include/exclude settings decide how totalFees / net / result are computed
  const trips = applyFeeSettings(tripsIn, settings.fees);
  const feeColumns = new Set<string>();
  for (const t of trips) for (const k of Object.keys(t.fees)) feeColumns.add(k);

  const resolvedAccounts: SyncPlan["resolvedAccounts"] = {};
  const resolveCache = new Map<string, AccountResolution>();
  const resolve = (raw: string): AccountResolution => {
    if (!resolveCache.has(raw)) {
      const r = resolveAccount(raw, mappings);
      resolveCache.set(raw, r);
      if (r && r.how !== "exact") resolvedAccounts[raw] = { account: r.mapping.account, how: r.how };
    }
    return resolveCache.get(raw)!;
  };

  const items: PlanItem[] = [];
  const unmapped = new Set<string>();
  const inactive = new Set<string>();
  const mapped: Array<{ trip: RoundTrip; trader: string; canonical: string }> = [];
  for (const trip of trips) {
    const m = resolve(trip.account)?.mapping;
    if (!m || !m.trader) {
      unmapped.add(trip.account);
      items.push({ externalId: trip.externalId, action: "skip", reason: "unmapped", trader: null, account: trip.account, tradeId: null, pendingId: null, changes: [], candidates: [], trip });
      continue;
    }
    if (!m.active) {
      inactive.add(trip.account);
      items.push({ externalId: trip.externalId, action: "skip", reason: "inactive", trader: m.trader, account: trip.account, tradeId: null, pendingId: null, changes: [], candidates: [], trip });
      continue;
    }
    if (opts.onlyTrader && m.trader !== opts.onlyTrader) {
      items.push({ externalId: trip.externalId, action: "skip", reason: "forbidden", trader: m.trader, account: trip.account, tradeId: null, pendingId: null, changes: [], candidates: [], trip });
      continue;
    }
    mapped.push({ trip, trader: m.trader, canonical: m.account });
  }

  const dates = trips.map((t) => t.date).sort();
  const dateFrom = dates[0] ?? null;
  const dateTo = trips.reduce<string | null>((m, t) => {
    const d = t.exitDate ?? t.date;
    return m == null || d > m ? d : m;
  }, null);

  if (mapped.length) {
    const ids = mapped.map((x) => x.trip.externalId);
    const traders = [...new Set(mapped.map((x) => x.trader))];
    const [existingRes, legacyRes, manualRes, pendingRes] = await Promise.all([
      pool.query(
        `SELECT id, external_id, deleted_at, ticker, date, side, entry, exit, qty, fees, pnl, result, session, horizon, exit_date, hold_time, broker_account, context_snapshot
           FROM trades WHERE source = 'propreports' AND external_id = ANY($1::text[])`,
        [ids],
      ),
      pool.query(
        `SELECT id, trader, ticker, date, side, entry, exit, qty, fees, pnl, result, session, horizon, exit_date, hold_time, broker_account, context_snapshot
           FROM trades
          WHERE external_id IS NULL AND deleted_at IS NULL
            AND context_snapshot ->> 'source' = 'propreports'
            AND trader = ANY($1::text[]) AND LEFT(date, 10) >= $2 AND LEFT(date, 10) <= $3`,
        [traders, dateFrom, dateTo],
      ),
      pool.query(
        `SELECT id, trader, ticker, date, side, setup, entry, exit, qty, pnl, fees, result, notes, tags, playbook_id, created_at
           FROM trades
          WHERE external_id IS NULL AND deleted_at IS NULL
            AND (source IS NULL OR source = 'manual')
            AND COALESCE(context_snapshot ->> 'source', '') <> 'propreports'
            AND trader = ANY($1::text[]) AND LEFT(date, 10) >= $2 AND LEFT(date, 10) <= $3`,
        [traders, dateFrom, dateTo],
      ),
      pool.query(`SELECT id, external_id FROM propreports_pending_trades WHERE external_id = ANY($1::text[])`, [ids]),
    ]);

    const existing = new Map<string, any>(existingRes.rows.map((r: any) => [String(r.external_id), r]));
    const legacy = new Map<string, any>();
    for (const r of legacyRes.rows) {
      const ctx = (r.context_snapshot ?? {}) as Record<string, unknown>;
      const openedAt = typeof ctx.openedAt === "string" ? ctx.openedAt.slice(0, 19).replace(" ", "T") : null;
      if (openedAt) legacy.set(`${r.trader}|${r.ticker}|${r.side}|${openedAt}`, r);
      if (typeof ctx.dedupKey === "string") legacy.set(`dedup:${r.trader}|${ctx.dedupKey}`, r);
    }
    const manual = new Map<string, ManualCandidate[]>();
    for (const r of manualRes.rows) {
      const key = `${r.trader}|${r.ticker}|${String(r.date).slice(0, 10)}|${r.side ?? ""}`;
      const c: ManualCandidate = {
        id: Number(r.id), trader: String(r.trader), ticker: String(r.ticker), date: String(r.date).slice(0, 10), side: r.side ?? null,
        setup: r.setup ?? null, entry: num(r.entry), exit: num(r.exit), qty: num(r.qty), pnl: num(r.pnl), fees: num(r.fees),
        result: String(r.result), notes: r.notes ?? null, tags: r.tags ?? null, playbookId: r.playbook_id ?? null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : "",
      };
      const arr = manual.get(key);
      if (arr) arr.push(c); else manual.set(key, [c]);
    }
    const pending = new Map<string, number>(pendingRes.rows.map((r: any) => [String(r.external_id), Number(r.id)]));

    for (const { trip, trader, canonical } of mapped) {
      const base = { externalId: trip.externalId, trader, account: canonical, candidates: [] as ManualCandidate[], trip };
      const ex = existing.get(trip.externalId);
      if (ex) {
        if (ex.deleted_at) {
          items.push({ ...base, action: "skip", reason: "deleted", tradeId: Number(ex.id), pendingId: null, changes: [] });
          continue;
        }
        const changes = diffBroker(ex, trip);
        items.push({ ...base, action: changes.length ? "update" : "unchanged", tradeId: Number(ex.id), pendingId: null, changes });
        continue;
      }
      const legacyRow =
        legacy.get(`${trader}|${trip.symbol}|${trip.side}|${trip.openedAt}`) ??
        legacy.get(`dedup:${trader}|${trip.date}|${trip.symbol}|${trip.side}|${trip.openedAt}|${trip.avgEntry}|${trip.avgExit}|${trip.qty}`);
      if (legacyRow) {
        items.push({ ...base, action: "adopt", tradeId: Number(legacyRow.id), pendingId: null, changes: diffBroker(legacyRow, trip) });
        continue;
      }
      const pendingId = pending.get(trip.externalId) ?? null;
      const cands = manual.get(`${trader}|${trip.symbol}|${trip.date}|${trip.side}`) ?? [];
      if (cands.length) {
        items.push({ ...base, action: "conflict", tradeId: null, pendingId, changes: [], candidates: cands });
        continue;
      }
      items.push({ ...base, action: "insert", tradeId: null, pendingId, changes: [] });
    }
  }

  const counts: Record<PlanAction, number> = { insert: 0, update: 0, unchanged: 0, adopt: 0, conflict: 0, skip: 0 };
  for (const it of items) counts[it.action]++;
  return { items, counts, unmappedAccounts: [...unmapped].sort(), inactiveAccounts: [...inactive].sort(), dateFrom, dateTo, feeColumns: [...feeColumns].sort(), resolvedAccounts };
}

// ─── apply ──────────────────────────────────────────────────────────────────

export interface ApplyOptions {
  actor: string;
  source: "api" | "file";
  fileName?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  details?: Record<string, unknown>;
  /** Fee columns detected in the parsed file (recorded in settings so the UI can list them). */
  feeColumns?: DetectedFeeColumn[];
}

export interface SyncRunResult {
  runId: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  conflicts: number;
  errors: number;
  errorText: string | null;
}

const TRADE_UPDATE_SQL = `
  UPDATE trades SET
    ticker = $2, date = $3, side = $4, entry = $5, exit = $6, qty = $7, fees = $8, pnl = $9, result = $10,
    session = $11, horizon = $12, exit_date = $13, hold_time = $14,
    source = 'propreports', external_id = $15, broker_account = $16, synced_at = NOW(),
    context_snapshot = COALESCE(context_snapshot, '{}'::jsonb) || $17::jsonb
  WHERE id = $1`;

function updateParams(id: number, t: RoundTrip): unknown[] {
  const b = brokerFields(t);
  return [id, b.ticker, b.date, b.side, b.entry, b.exit, b.qty, b.fees, b.pnl, b.result, b.session, b.horizon, b.exitDate, b.holdTime, t.externalId, b.brokerAccount, JSON.stringify(contextPatch(t))];
}

async function insertTrade(client: PoolClient, t: RoundTrip, trader: string): Promise<number> {
  const b = brokerFields(t);
  const { rows } = await client.query(
    `INSERT INTO trades (ticker, date, side, entry, exit, qty, fees, pnl, result, session, horizon, exit_date, hold_time,
                         trader, source, external_id, broker_account, synced_at, notes, context_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'propreports',$15,$16,NOW(),NULL,$17::jsonb)
     RETURNING id`,
    [b.ticker, b.date, b.side, b.entry, b.exit, b.qty, b.fees, b.pnl, b.result, b.session, b.horizon, b.exitDate, b.holdTime, trader, t.externalId, b.brokerAccount, JSON.stringify(contextPatch(t))],
  );
  return Number(rows[0].id);
}

/** Roles of the fills (Вход / Добор / Частичный фикс / …) and re-entry links; a failure never fails the sync. */
/**
 * Recompute the structure (roles, re-entry links) of the written trades in the background: the sync never waits for
 * it and never fails because of it (the trade sheet computes the structure live anyway). Chunked, one chunk at a time,
 * so a big first import of the whole desk does not hold many pool connections at once.
 */
function refreshStructures(tradeIds: number[]): void {
  if (!tradeIds.length) return;
  const ids = [...new Set(tradeIds)];
  void (async () => {
    for (let i = 0; i < ids.length; i += STRUCTURE_CHUNK) {
      try {
        await refreshTradeStructures(ids.slice(i, i + STRUCTURE_CHUNK));
      } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, "propreports: trade structure refresh failed");
      }
    }
  })();
}
const STRUCTURE_CHUNK = 300;

/** Replace the broker-sourced executions of a trade (manual ones — note not starting with "PropReports" — are kept). */
async function writeExecutions(client: PoolClient, tradeId: number, t: RoundTrip): Promise<void> {
  await client.query(`DELETE FROM trade_executions WHERE trade_id = $1 AND note LIKE 'PropReports%'`, [tradeId]);
  let i = 0;
  for (const e of t.executions) {
    await client.query(
      `INSERT INTO trade_executions (trade_id, kind, price, qty, executed_at, note, sort_order, order_id)
       VALUES ($1, $2, $3, $4, ($5::text || ' America/New_York')::timestamptz, $6, $7, $8)`,
      [tradeId, e.kind, e.price, e.qty, e.at.replace("T", " "), `PropReports ${e.side}${e.fillId ? ` #${e.fillId}` : ""}${e.fees ? ` · fees ${round2(e.fees)}` : ""}`, i++, e.orderId ?? null],
    );
  }
}

export async function applySync(plan: SyncPlan, opts: ApplyOptions): Promise<SyncRunResult> {
  const client = await pool.connect();
  let runId = 0;
  const res: SyncRunResult = { runId: 0, inserted: 0, updated: 0, unchanged: plan.counts.unchanged, skipped: plan.counts.skip, conflicts: 0, errors: 0, errorText: null };
  const errors: string[] = [];
  try {
    const run = await client.query(
      `INSERT INTO propreports_sync_runs (source, status, file_name, date_from, date_to, actor, details)
       VALUES ($1, 'running', $2, $3, $4, $5, $6::jsonb) RETURNING id`,
      [opts.source, opts.fileName ?? null, opts.dateFrom ?? plan.dateFrom, opts.dateTo ?? plan.dateTo, opts.actor, JSON.stringify({ ...opts.details, unmappedAccounts: plan.unmappedAccounts })],
    );
    runId = Number(run.rows[0].id);
    res.runId = runId;

    await client.query("BEGIN");
    const touchedAccounts = new Map<string, string>(); // account → max fill datetime
    const writtenTrades: number[] = [];
    for (const it of plan.items) {
      try {
        switch (it.action) {
          case "insert": {
            const id = await insertTrade(client, it.trip, it.trader!);
            await writeExecutions(client, id, it.trip);
            writtenTrades.push(id);
            if (it.pendingId) await client.query(`DELETE FROM propreports_pending_trades WHERE id = $1`, [it.pendingId]);
            res.inserted++;
            break;
          }
          case "update":
          case "adopt": {
            await client.query(TRADE_UPDATE_SQL, updateParams(it.tradeId!, it.trip));
            await writeExecutions(client, it.tradeId!, it.trip);
            writtenTrades.push(it.tradeId!);
            res.updated++;
            break;
          }
          case "conflict": {
            await client.query(
              `INSERT INTO propreports_pending_trades (external_id, account, trader, ticker, date, side, payload, candidate_ids)
               VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::int[])
               ON CONFLICT (external_id) DO UPDATE SET payload = EXCLUDED.payload, candidate_ids = EXCLUDED.candidate_ids, updated_at = NOW()`,
              [it.externalId, it.account, it.trader, it.trip.symbol, it.trip.date, it.trip.side, JSON.stringify(it.trip), it.candidates.map((c) => c.id)],
            );
            res.conflicts++;
            break;
          }
          default:
            break;
        }
        if (it.trader) {
          const last = it.trip.closedAt ?? it.trip.openedAt;
          const prev = touchedAccounts.get(it.account);
          if (!prev || last > prev) touchedAccounts.set(it.account, last);
        }
      } catch (e) {
        res.errors++;
        errors.push(`${it.externalId}: ${e instanceof Error ? e.message : String(e)}`);
        if (errors.length > 50) throw new Error("Too many errors (> 50), import cancelled");
      }
    }
    for (const [account, last] of touchedAccounts) {
      await client.query(
        `UPDATE propreports_accounts SET last_synced_at = NOW(), last_fill_at = GREATEST(COALESCE(last_fill_at, ''), $2), updated_at = NOW() WHERE account = $1`,
        [account, last],
      );
    }
    await client.query("COMMIT");
    refreshStructures(writtenTrades);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    res.errors++;
    res.inserted = 0; res.updated = 0; res.conflicts = 0;
    errors.push(e instanceof Error ? e.message : String(e));
    logger.error({ err: e instanceof Error ? e.message : String(e) }, "propreports sync failed");
  } finally {
    client.release();
  }
  res.errorText = errors.length ? errors.slice(0, 20).join("\n") : null;
  if (runId) {
    await pool.query(
      `UPDATE propreports_sync_runs SET finished_at = NOW(), status = $2, inserted = $3, updated = $4, unchanged = $5, skipped = $6, conflicts = $7, errors = $8, error_text = $9 WHERE id = $1`,
      [runId, res.errors ? (res.inserted + res.updated ? "partial" : "error") : "ok", res.inserted, res.updated, res.unchanged, res.skipped, res.conflicts, res.errors, res.errorText],
    ).catch(() => {});
  }
  // remember what was seen, for the «Комиссии» / «Несопоставленные счета» settings blocks (never during dry runs)
  try {
    const s = await getSettings();
    if (opts.feeColumns?.length) {
      const now = new Date().toISOString();
      const detected = new Map(s.fees.detected.map((d) => [d.key, d]));
      for (const c of opts.feeColumns) detected.set(c.key, c);
      const columns = { ...s.fees.columns };
      for (const c of opts.feeColumns) columns[c.key] = { ...columns[c.key], include: columns[c.key]?.include ?? true, header: c.header, known: c.known, heuristic: c.heuristic, lastSeenAt: now };
      await setSetting("fees", { ...s.fees, detected: [...detected.values()], columns });
    }
    const unmatched = new Set(s.unmatched);
    for (const a of plan.unmappedAccounts) unmatched.add(a);
    const known = new Set((await loadAccountMappings()).flatMap((m) => [m.account, ...m.aliases]));
    const next = [...unmatched].filter((a) => !known.has(a)).sort();
    if (next.join("|") !== s.unmatched.join("|")) await setSetting("unmatched", next);
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "propreports: settings bookkeeping failed");
  }
  await logAudit({ actor: opts.actor, action: "propreports.sync", targetType: "propreports_sync_runs", targetId: String(runId), details: { ...res, source: opts.source, fileName: opts.fileName ?? null } });
  if (res.inserted || res.updated) {
    invalidateDashboardCache();
    // Re-check trading rules for every trader whose book changed, so violations exist right after the sync.
    const traders = new Set(plan.items.filter((it) => (it.action === "insert" || it.action === "update" || it.action === "adopt") && it.trader).map((it) => it.trader as string));
    if (traders.size) {
      void import("../rulesEngine").then(async ({ scanRulesForTrader }) => {
        for (const t of traders) await scanRulesForTrader(t).catch((e) => logger.warn({ err: e instanceof Error ? e.message : String(e), trader: t }, "propreports: rule scan failed"));
      });
      // Ideas of these traders: link them to the new broker trades (ticker + side + entry in the idea window).
      void import("../ideaTradeMatch").then(({ relinkIdeasForTraders }) => relinkIdeasForTraders([...traders]))
        .catch((e) => logger.warn({ err: e instanceof Error ? e.message : String(e) }, "propreports: idea relink failed"));
      // Academy challenges of these traders: status + pass/fail notices move here (write path), not on GET.
      void import("../../routes/academy-path").then(({ refreshChallenges }) => refreshChallenges([...traders]))
        .catch((e) => logger.warn({ err: e instanceof Error ? e.message : String(e) }, "propreports: challenge refresh failed"));
    }
  }
  // Jobs listening to "propreports.synced" (src/jobs/registry.ts) run after every recorded sync that did not fail outright.
  if (runId && (!res.errors || res.inserted + res.updated > 0)) {
    const changedTraders = [...new Set(plan.items.filter((it) => (it.action === "insert" || it.action === "update" || it.action === "adopt") && it.trader).map((it) => it.trader as string))];
    emitJobEvent("propreports.synced", {
      runId, source: opts.source, dateFrom: opts.dateFrom ?? plan.dateFrom ?? null, dateTo: opts.dateTo ?? plan.dateTo ?? null,
      traders: changedTraders, inserted: res.inserted, updated: res.updated, changed: res.inserted + res.updated > 0,
    });
  }
  return res;
}

// ─── reconcile inbox ────────────────────────────────────────────────────────

export interface PendingTrade {
  id: number;
  externalId: string;
  account: string | null;
  trader: string;
  ticker: string;
  date: string;
  side: string | null;
  trip: RoundTrip;
  candidates: ManualCandidate[];
  createdAt: string;
  updatedAt: string;
}

export async function listPending(trader: string | null): Promise<PendingTrade[]> {
  const { rows } = await pool.query(
    `SELECT * FROM propreports_pending_trades WHERE ($1::text IS NULL OR trader = $1) ORDER BY date DESC, id DESC LIMIT 500`,
    [trader],
  );
  if (!rows.length) return [];
  const ids = [...new Set(rows.flatMap((r: any) => (r.candidate_ids ?? []) as number[]))];
  const cands = new Map<number, ManualCandidate>();
  if (ids.length) {
    const c = await pool.query(
      `SELECT id, trader, ticker, date, side, setup, entry, exit, qty, pnl, fees, result, notes, tags, playbook_id, created_at
         FROM trades WHERE id = ANY($1::int[]) AND deleted_at IS NULL AND external_id IS NULL`,
      [ids],
    );
    for (const r of c.rows) {
      cands.set(Number(r.id), {
        id: Number(r.id), trader: String(r.trader), ticker: String(r.ticker), date: String(r.date).slice(0, 10), side: r.side ?? null,
        setup: r.setup ?? null, entry: num(r.entry), exit: num(r.exit), qty: num(r.qty), pnl: num(r.pnl), fees: num(r.fees),
        result: String(r.result), notes: r.notes ?? null, tags: r.tags ?? null, playbookId: r.playbook_id ?? null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : "",
      });
    }
  }
  return rows.map((r: any) => ({
    id: Number(r.id),
    externalId: String(r.external_id),
    account: r.account ?? null,
    trader: String(r.trader),
    ticker: String(r.ticker),
    date: String(r.date),
    side: r.side ?? null,
    trip: r.payload as RoundTrip,
    candidates: ((r.candidate_ids ?? []) as number[]).map((id) => cands.get(Number(id))).filter((c): c is ManualCandidate => !!c),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

/** Failure: `code` = API error code (route throws AppError(code, status)); `error` = RU text for logs. */
export type MergeOutcome = { ok: true; tradeId: number } | { ok: false; status: number; error: string; code: "PENDING_NOT_FOUND" | "TRADE_NOT_FOUND" | "TRADE_ALREADY_LINKED" | "TRADE_OTHER_TRADER" | "BROKER_TRADE_EXISTS" | "INTERNAL" };

/** Broker numbers + executions into the manual trade; trader fields untouched; pending row removed. */
export async function mergePending(pendingId: number, tradeId: number, actor: string): Promise<MergeOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const p = await client.query(`SELECT * FROM propreports_pending_trades WHERE id = $1 FOR UPDATE`, [pendingId]);
    if (!p.rows[0]) { await client.query("ROLLBACK"); return { ok: false, status: 404, error: "pending row not found", code: "PENDING_NOT_FOUND" }; }
    const pending = p.rows[0];
    const t = await client.query(`SELECT id, trader, external_id, deleted_at FROM trades WHERE id = $1 FOR UPDATE`, [tradeId]);
    const trade = t.rows[0];
    if (!trade || trade.deleted_at) { await client.query("ROLLBACK"); return { ok: false, status: 404, error: "trade not found", code: "TRADE_NOT_FOUND" }; }
    if (trade.external_id) { await client.query("ROLLBACK"); return { ok: false, status: 409, error: "trade already linked", code: "TRADE_ALREADY_LINKED" }; }
    if (trade.trader !== pending.trader) { await client.query("ROLLBACK"); return { ok: false, status: 409, error: "trade of another trader", code: "TRADE_OTHER_TRADER" }; }
    const trip = pending.payload as RoundTrip;
    await client.query(TRADE_UPDATE_SQL, updateParams(tradeId, trip));
    await writeExecutions(client, tradeId, trip);
    await client.query(`DELETE FROM propreports_pending_trades WHERE id = $1`, [pendingId]);
    await client.query("COMMIT");
    refreshStructures([tradeId]);
    await logAudit({ actor, action: "propreports.merge", targetType: "trades", targetId: String(tradeId), details: { externalId: trip.externalId } });
    invalidateDashboardCache();
    return { ok: true, tradeId };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
  } finally {
    client.release();
  }
}

/** Insert the parked broker trip as its own trade (the manual one stays as is). */
export async function keepPendingSeparate(pendingId: number, actor: string): Promise<MergeOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const p = await client.query(`SELECT * FROM propreports_pending_trades WHERE id = $1 FOR UPDATE`, [pendingId]);
    if (!p.rows[0]) { await client.query("ROLLBACK"); return { ok: false, status: 404, error: "pending row not found", code: "PENDING_NOT_FOUND" }; }
    const pending = p.rows[0];
    const trip = pending.payload as RoundTrip;
    const dup = await client.query(`SELECT id FROM trades WHERE source = 'propreports' AND external_id = $1`, [trip.externalId]);
    if (dup.rows[0]) { await client.query("ROLLBACK"); return { ok: false, status: 409, error: "broker trade exists", code: "BROKER_TRADE_EXISTS" }; }
    const id = await insertTrade(client, trip, String(pending.trader));
    await writeExecutions(client, id, trip);
    await client.query(`DELETE FROM propreports_pending_trades WHERE id = $1`, [pendingId]);
    await client.query("COMMIT");
    refreshStructures([id]);
    await logAudit({ actor, action: "propreports.keep_separate", targetType: "trades", targetId: String(id), details: { externalId: trip.externalId } });
    invalidateDashboardCache();
    return { ok: true, tradeId: id };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
  } finally {
    client.release();
  }
}

export async function dismissPending(pendingId: number, actor: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM propreports_pending_trades WHERE id = $1`, [pendingId]);
  if (rowCount) await logAudit({ actor, action: "propreports.dismiss", targetType: "propreports_pending_trades", targetId: String(pendingId) });
  return !!rowCount;
}
