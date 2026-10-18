import { pool } from "@workspace/db";
import { logger } from "./logger";
import { RULE_CATALOG } from "./rulesCatalog";
import { evalRule, NO_LIMITS, selfCheckReason, type RiskLimits, type RuleRow, type SelfMark, type TradeForRule } from "./rulesEval";
import { RULE_LIST_SEP, violationMsgParams, type ViolationMsg } from "./rulesI18n";
import { mapTradeRow, sortTrades, type ExecRow } from "./rulesTrades";
import { closeDateSql, horizonSql, netPnlSql, num, resultSql, signedRSql } from "./tradeMath";
import { addDays, nyDate } from "./tradingDate";
import { isNotifiableViolationDay, preview, uniqueRecipients, violationDedupKey, violationNotice, type ViolationItem } from "./notifyEventsCore";
import { planStaleViolations, STALE_PLAN_COLUMNS } from "./violationArchive";

/**
 * Discipline rules engine — DB layer.
 *
 * - Pure evaluation lives in lib/rulesEval (all rule kinds), the catalog in lib/rulesCatalog, the period report in lib/rulesReport.
 * - Money is NET (gross − |fees|) via the shared tradeMath SQL; days are New York trading days.
 * - Thresholds left empty fall back to the trader's risk desk limits (trader_risk_limits).
 * - Rules: personal/office rules of the trader (trading_rules.trader = trader) + desk-wide rules (trader = '*').
 *   Soft-deleted rules (deleted_at) are ignored everywhere.
 * - The scan is incremental: every violation has a stable key (rule, trade|day) and is UPSERTed, so acknowledgements
 *   and comments survive re-scans. Violations that no longer apply are deleted only when nobody wrote anything on
 *   them; otherwise they are archived as `stale` (lib/violationArchive). Scoped to the trader — desk rules share one
 *   rule_id across traders. A re-produced key un-archives its row (re-enabled rule, trade edited back).
 * - Disabling / deleting a rule archives its violations (routes/rules.ts) — they are never dropped with their comments.
 * - Newly found violations of today / yesterday notify the trader and their staff (rule_violation) through
 *   lib/notifyEvents: in the background, once per violation key.
 */

export { evalRule, evalSelfCheck, NO_LIMITS, notionalOf, riskOf, selfCheckReason } from "./rulesEval";
export { violationMessage } from "./rulesI18n";
export type { RuleKind, RuleThreshold, RuleRow, RiskLimits, TradeForRule, ViolationDraft, SelfMark, Severity } from "./rulesEval";

export interface RuleField {
  key: string;
  label: string;
  type: "number";
  default: number;
  /** Optional fields may be left empty: the trader's risk desk limit is used instead. */
  optional?: boolean;
  /** Which trader_risk_limits column backs this field when it is empty. */
  riskLimit?: "daily_loss_limit" | "max_position_usd" | "max_risk_per_trade";
}

/** Legacy list of the original 11 kinds (contract of GET /rules/kinds before the catalog; kept for compatibility). */
export const RULE_KINDS: { kind: string; label: string; hint: string; fields: RuleField[] }[] = RULE_CATALOG.filter((k) => k.legacy).map((k) => ({
  kind: k.kind,
  label: k.label,
  hint: k.hint,
  fields: k.fields.map((f) => ({
    key: f.key, label: f.label, type: "number" as const, default: Number(f.default),
    ...(f.optional ? { optional: true } : {}), ...(f.riskLimit ? { riskLimit: f.riskLimit } : {}),
  })),
}));

/** Desk-wide rule marker in trading_rules.trader. */
export const DESK_TRADER = "*";

export async function fetchRiskLimits(trader: string): Promise<RiskLimits> {
  try {
    const { rows } = await pool.query<any>(
      `SELECT account_size, daily_loss_limit, max_position_usd, max_risk_per_trade, allow_overnight, allow_swing
         FROM trader_risk_limits WHERE trader = $1`,
      [trader],
    );
    const r = rows[0];
    if (!r) return NO_LIMITS;
    return {
      accountSize: num(r.account_size),
      dailyLossLimit: num(r.daily_loss_limit),
      maxPositionUsd: num(r.max_position_usd),
      maxRiskPerTrade: num(r.max_risk_per_trade),
      allowOvernight: r.allow_overnight !== false,
      allowSwing: r.allow_swing !== false,
    };
  } catch {
    return NO_LIMITS;
  }
}

/** All non-deleted trades of a trader with the fields every rule kind needs, ordered by day and entry time. */
export async function fetchTrades(trader: string): Promise<TradeForRule[]> {
  const { rows } = await pool.query<any>(
    `SELECT t.id, t.trader, t.date, t.ticker, t.side, t.hold_time, t.context_snapshot,
            ${closeDateSql()} AS close_date,
            ${resultSql()} AS result,
            t.pnl, ${netPnlSql()} AS net_pnl, ${signedRSql()} AS signed_r,
            t.entry, t.stop, t.qty, t.risk_usd,
            ${horizonSql()} AS horizon,
            t.source, t.playbook_id, t.setup_score,
            x.max_notional,
            (SELECT COUNT(*) FROM playbook_checklist_runs r WHERE r.trade_id = t.id)::int AS checklist_runs
       FROM trades t
       LEFT JOIN (
         SELECT trade_id, MAX(ABS(pos) * price) AS max_notional FROM (
           SELECT trade_id, price,
                  SUM(CASE WHEN kind IN ('entry','add') THEN COALESCE(qty, 0)
                           WHEN kind IN ('trim','exit','stop') THEN -COALESCE(qty, 0) ELSE 0 END)
                    OVER (PARTITION BY trade_id ORDER BY sort_order, executed_at NULLS LAST, id ROWS UNBOUNDED PRECEDING) AS pos
             FROM trade_executions
            -- only this trader's fills: the running position is per trade, so the result is identical,
            -- without a window pass over the whole executions table
            WHERE trade_id IN (SELECT id FROM trades WHERE trader = $1 AND deleted_at IS NULL)
         ) e GROUP BY trade_id
       ) x ON x.trade_id = t.id
      WHERE t.trader = $1 AND t.deleted_at IS NULL
      ORDER BY t.date ASC, t.created_at ASC, t.id ASC`,
    [trader],
  );
  const execs = new Map<number, ExecRow[]>();
  try {
    const { rows: ex } = await pool.query<any>(
      `SELECT e.trade_id, e.kind, e.price, e.qty, e.executed_at
         FROM trade_executions e JOIN trades t ON t.id = e.trade_id
        WHERE t.trader = $1 AND t.deleted_at IS NULL
        ORDER BY e.trade_id, e.sort_order, e.executed_at NULLS LAST, e.id`,
      [trader],
    );
    for (const e of ex) {
      const id = Number(e.trade_id);
      if (!execs.has(id)) execs.set(id, []);
      const at = e.executed_at == null ? null : new Date(e.executed_at).getTime();
      execs.get(id)!.push({ kind: String(e.kind), price: Number(e.price), qty: num(e.qty), at: Number.isFinite(at as number) ? at : null });
    }
  } catch (err: any) {
    logger.warn({ error: err?.message }, "rules: executions fetch failed");
  }
  return sortTrades(rows.map((r: any) => mapTradeRow(r, execs.get(Number(r.id)) ?? [])));
}

export interface StoredRule extends RuleRow {
  origin: "personal" | "office";
  desk: boolean;
  note: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

export function mapRuleRow(r: any): StoredRule {
  return {
    id: Number(r.id),
    trader: String(r.trader),
    name: String(r.name),
    kind: String(r.kind),
    threshold: (r.threshold && typeof r.threshold === "object" ? r.threshold : {}) as Record<string, unknown>,
    enabled: r.enabled !== false,
    origin: r.trader === DESK_TRADER || r.origin === "office" ? "office" : "personal",
    desk: r.trader === DESK_TRADER,
    note: r.note ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

/** Rules that apply to a trader: own (personal + office) and desk-wide; soft-deleted excluded. */
export async function fetchRulesFor(trader: string, opts: { enabledOnly?: boolean } = {}): Promise<StoredRule[]> {
  await ensureRulesSchema();
  const { rows } = await pool.query<any>(
    `SELECT id, trader, name, kind, threshold, enabled, created_at, origin, created_by, note
       FROM trading_rules
      WHERE (trader = $1 OR trader = '${DESK_TRADER}') AND deleted_at IS NULL ${opts.enabledOnly ? "AND enabled = true" : ""}
      ORDER BY (trader = '${DESK_TRADER}') DESC, created_at ASC, id ASC`,
    [trader],
  );
  return rows.map(mapRuleRow);
}

export async function fetchSelfMarks(trader: string, from?: string, to?: string): Promise<SelfMark[]> {
  await ensureRulesSchema();
  const { rows } = await pool.query<any>(
    `SELECT rule_id, day, ok, note FROM rule_self_checks
      WHERE trader = $1 AND ok IS NOT NULL ${from ? "AND day >= $2" : ""} ${to ? `AND day <= $${from ? 3 : 2}` : ""}`,
    [trader, ...(from ? [from] : []), ...(to ? [to] : [])],
  );
  return rows.map((r: any) => ({ ruleId: Number(r.rule_id), day: String(r.day), ok: r.ok == null ? null : r.ok === true, note: r.note ?? null }));
}

// ─── Schema (additive; idempotent) ───────────────────────────────────────────
// rule_violations gains: a stable key for incremental scans, the trading day, net $ cost, the acknowledge (trader) /
// resolve (curator) workflow columns, and the archive marker (archived_at + archived_reason: rule_disabled | rule_deleted
// | stale — see lib/violationArchive). trading_rules gains: origin (personal|office), author, note, soft delete.
// rule_self_checks: daily «соблюдал / нарушил» marks for rules that can't be checked from trades (journal integration).
// trading_errors_archive: removed mistakes are archived here (restore via POST /errors/:id/restore) — never lost.

let ensured: Promise<void> | null = null;
export function ensureRulesSchema(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(
        `ALTER TABLE rule_violations
           ADD COLUMN IF NOT EXISTS dedup_key TEXT,
           ADD COLUMN IF NOT EXISTS day TEXT,
           ADD COLUMN IF NOT EXISTS cost_net NUMERIC(12,2),
           ADD COLUMN IF NOT EXISTS acknowledged_by TEXT,
           ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
           ADD COLUMN IF NOT EXISTS comment TEXT,
           ADD COLUMN IF NOT EXISTS resolution TEXT,
           ADD COLUMN IF NOT EXISTS consequence TEXT,
           ADD COLUMN IF NOT EXISTS resolved_by TEXT,
           ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
           ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
           ADD COLUMN IF NOT EXISTS archived_reason TEXT;
         CREATE INDEX IF NOT EXISTS rule_violations_active_trader_idx ON rule_violations (trader) WHERE archived_at IS NULL;
         CREATE UNIQUE INDEX IF NOT EXISTS rule_violations_rule_key_uidx ON rule_violations (rule_id, dedup_key);
         CREATE INDEX IF NOT EXISTS rule_violations_trade_idx ON rule_violations (trade_id);
         ALTER TABLE trading_rules
           ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'personal',
           ADD COLUMN IF NOT EXISTS created_by TEXT,
           ADD COLUMN IF NOT EXISTS note TEXT,
           ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
         CREATE TABLE IF NOT EXISTS rule_self_checks (
           id SERIAL PRIMARY KEY,
           rule_id INTEGER NOT NULL REFERENCES trading_rules(id) ON DELETE CASCADE,
           trader TEXT NOT NULL,
           day TEXT NOT NULL,
           ok BOOLEAN,
           note TEXT,
           updated_by TEXT,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
           UNIQUE (rule_id, trader, day)
         );
         CREATE INDEX IF NOT EXISTS rule_self_checks_trader_day_idx ON rule_self_checks (trader, day);
         CREATE TABLE IF NOT EXISTS trading_errors_archive (
           id SERIAL PRIMARY KEY,
           original_id INTEGER NOT NULL,
           trader TEXT NOT NULL,
           payload JSONB NOT NULL,
           archived_by TEXT,
           archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
           restored_at TIMESTAMPTZ
         );
         CREATE INDEX IF NOT EXISTS trading_errors_archive_trader_idx ON trading_errors_archive (trader);`,
      )
      .then(() => undefined)
      .catch((err) => {
        ensured = null;
        throw err;
      });
  }
  return ensured;
}
ensureRulesSchema().catch((err) => logger.warn({ err }, "rules: ensure schema failed at init"));

type FreshViolation = ViolationItem & { ruleId: number; key: string; msg?: ViolationMsg };

async function upsertDrafts(
  rule: RuleRow,
  trader: string,
  drafts: ReturnType<typeof evalRule>,
): Promise<{ written: number; removed: number; fresh: FreshViolation[] }> {
  let written = 0;
  const keys: string[] = [];
  const fresh: FreshViolation[] = [];
  const since = addDays(nyDate(), -1);
  for (const d of drafts) {
    keys.push(d.key);
    try {
      const { rows } = await pool.query<{ inserted: boolean }>(
        `INSERT INTO rule_violations (trader, rule_id, trade_id, severity, message, details, dedup_key, day, cost_net)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (rule_id, dedup_key) DO UPDATE
           SET trade_id = EXCLUDED.trade_id, severity = EXCLUDED.severity, message = EXCLUDED.message,
               details = EXCLUDED.details, day = EXCLUDED.day, cost_net = EXCLUDED.cost_net,
               archived_at = NULL, archived_reason = NULL
         RETURNING (xmax = 0) AS inserted`,
        [trader, rule.id, d.tradeId, d.severity, d.message, { ...d.details, msg: d.msg }, d.key, d.day, d.costNet],
      );
      written++;
      if (rows[0]?.inserted && isNotifiableViolationDay(d.day, since)) {
        fresh.push({ ruleId: rule.id, key: d.key, ruleName: rule.name, message: d.message, msg: d.msg, severity: d.severity });
      }
    } catch (e: any) {
      logger.warn({ error: e.message, ruleId: rule.id }, "rule_violations upsert failed");
    }
  }
  // This trader's violations of the rule that no longer apply (and legacy rows without a key): delete the purely derived
  // ones, archive (stale) the ones with a comment / acknowledgement / review.
  const { rows: gone } = await pool.query<any>(
    `SELECT ${STALE_PLAN_COLUMNS} FROM rule_violations
      WHERE rule_id = $1 AND trader = $2 AND (dedup_key IS NULL OR NOT (dedup_key = ANY($3::text[])))`,
    [rule.id, trader, keys],
  );
  const removed = await applyStalePlan(gone);
  return { written, removed, fresh };
}

/** Delete / archive (stale) violations the engine no longer produces. Returns how many left the active set. */
async function applyStalePlan(rows: readonly any[]): Promise<number> {
  if (!rows.length) return 0;
  const { deleteIds, archiveIds } = planStaleViolations(rows);
  let n = 0;
  if (deleteIds.length) {
    const del = await pool.query(`DELETE FROM rule_violations WHERE id = ANY($1::int[])`, [deleteIds]);
    n += del.rowCount ?? 0;
  }
  if (archiveIds.length) {
    const upd = await pool.query(
      `UPDATE rule_violations SET archived_at = NOW(), archived_reason = 'stale' WHERE id = ANY($1::int[]) AND archived_at IS NULL`,
      [archiveIds],
    );
    n += upd.rowCount ?? 0;
  }
  return n;
}

/**
 * Params of a rule_violation notification (rendered per reader by lib/notificationRenderers/rules.ts); the RU
 * title/message from violationNotice stay stored as the fallback. Same cut-offs as violationNotice.
 */
function violationNoticeParams(trader: string, items: readonly FreshViolation[], forStaff: boolean): Record<string, string | number> {
  if (items.length === 1) {
    const v = items[0];
    return { variant: forStaff ? "oneStaff" : "one", rule: preview(v.ruleName, 60), trader, message: v.message, ...violationMsgParams(v.msg) };
  }
  const rules = [...new Set(items.map((v) => v.ruleName))];
  return {
    variant: forStaff ? "manyStaff" : "many",
    count: items.length,
    ruleList: rules.slice(0, 3).map((r) => preview(r, 40)).join(RULE_LIST_SEP),
    more: Math.max(0, rules.length - 3),
    trader,
  };
}

/**
 * rule_violation to the trader and their assigned staff (fallback: curators/admins) for violations the scan just
 * created. Background + claimOnce per violation key, so re-scans and concurrent syncs never repeat a notification.
 */
function notifyNewViolations(trader: string, fresh: readonly FreshViolation[]): void {
  if (!fresh.length) return;
  void import("./notifyEvents").then(({ inBackground, claimOnce, staffOrFallback }) =>
    inBackground("rule_violation", async () => {
      const claimed: FreshViolation[] = [];
      for (const v of fresh) if (await claimOnce(violationDedupKey(v.ruleId, v.key))) claimed.push(v);
      if (!claimed.length) return;
      const { notifyUser } = await import("./notifyUtils");
      const link = `/rules?tab=violations&trader=${encodeURIComponent(trader)}`;
      const base = { type: "rule_violation", source: "rules", link, entityType: "rule_violation", entityId: trader } as const;
      const own = violationNotice(trader, claimed, false);
      if (own) await notifyUser({ ...base, userName: trader, title: own.title, message: own.message, severity: own.severity, params: violationNoticeParams(trader, claimed, false) });
      const staffNotice = violationNotice(trader, claimed, true);
      if (!staffNotice) return;
      const staffParams = violationNoticeParams(trader, claimed, true);
      for (const name of uniqueRecipients(await staffOrFallback(trader), trader)) {
        await notifyUser({ ...base, userName: name, title: staffNotice.title, message: staffNotice.message, severity: staffNotice.severity, params: staffParams });
      }
    }),
  );
}

export async function scanRulesForTrader(trader: string): Promise<{ violationsWritten: number; violationsRemoved: number }> {
  await ensureRulesSchema();
  const rules = (await fetchRulesFor(trader, { enabledOnly: true })).filter((r) => r.kind !== "self_check");
  if (rules.length === 0) return { violationsWritten: 0, violationsRemoved: 0 };
  const [trades, limits] = await Promise.all([fetchTrades(trader), fetchRiskLimits(trader)]);

  let written = 0;
  let removed = 0;
  const fresh: FreshViolation[] = [];
  for (const r of rules) {
    const scoped: RuleRow = { ...r, trader };
    const drafts = trades.length ? evalRule(scoped, trades, limits) : [];
    const res = await upsertDrafts(scoped, trader, drafts);
    written += res.written;
    removed += res.removed;
    fresh.push(...res.fresh);
  }
  notifyNewViolations(trader, fresh);
  return { violationsWritten: written, violationsRemoved: removed };
}

/** Persist one self-check mark as a violation row (ok = false) or remove it (ok = true / null; archived as stale when commented). */
export async function syncSelfCheckViolation(ruleId: number, trader: string, day: string, ok: boolean | null, note: string | null): Promise<void> {
  await ensureRulesSchema();
  const key = `d:${trader}:${day}`;
  if (ok === false) {
    const selfReason = selfCheckReason(note);
    await pool.query(
      `INSERT INTO rule_violations (trader, rule_id, trade_id, severity, message, details, dedup_key, day, cost_net)
       VALUES ($1, $2, NULL, 'medium', $3, $4, $5, $6, NULL)
       ON CONFLICT (rule_id, dedup_key) DO UPDATE SET message = EXCLUDED.message, details = EXCLUDED.details,
         archived_at = NULL, archived_reason = NULL`,
      [trader, ruleId, selfReason.message, { selfCheck: true, msg: selfReason.msg }, key, day],
    );
  } else {
    const { rows } = await pool.query<any>(`SELECT ${STALE_PLAN_COLUMNS} FROM rule_violations WHERE rule_id = $1 AND dedup_key = $2`, [ruleId, key]);
    await applyStalePlan(rows);
  }
}

export async function scanRulesAll(): Promise<{ tradersScanned: number; violationsWritten: number }> {
  await ensureRulesSchema();
  const { rows: desk } = await pool.query<any>(
    `SELECT 1 FROM trading_rules WHERE trader = '${DESK_TRADER}' AND enabled = true AND deleted_at IS NULL LIMIT 1`,
  );
  const { rows } = desk.length
    ? await pool.query<any>(`SELECT DISTINCT trader FROM trades WHERE trader IS NOT NULL AND deleted_at IS NULL`)
    : await pool.query<any>(`SELECT DISTINCT trader FROM trading_rules WHERE enabled = true AND deleted_at IS NULL AND trader IS NOT NULL AND trader <> '${DESK_TRADER}'`);
  let total = 0;
  for (const r of rows) {
    const res = await scanRulesForTrader(r.trader);
    total += res.violationsWritten;
  }
  return { tradersScanned: rows.length, violationsWritten: total };
}

export type { ExecRow };
