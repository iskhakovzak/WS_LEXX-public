import { Router, type IRouter, type Request } from "express";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import {
  scanRulesForTrader, scanRulesAll, ensureRulesSchema, fetchRulesFor, fetchTrades, fetchRiskLimits, fetchSelfMarks,
  syncSelfCheckViolation, mapRuleRow, DESK_TRADER, type StoredRule,
} from "../lib/rulesEngine";
import { RULE_CATALOG, catalogFor, ruleGroupsFor, kindMeta, validateThreshold, describeThreshold, type ThresholdError } from "../lib/rulesCatalog";
import { rulesT, violationMessage, violationMsgParams, type ViolationMsg } from "../lib/rulesI18n";
import { langOf, type Lang } from "../i18n";
import { buildRulesReport, previewRule, type PersistedViolation } from "../lib/rulesReport";
import { GUEST_SCOPE, isGuest } from "../lib/auth";
import { can, readScope } from "../lib/permissions";
import { closeDateSql, horizonSql, netPnlSql, resultSql, signedRSql } from "../lib/tradeMath";
import { nyDate, addDays } from "../lib/tradingDate";
import { logActivity } from "../lib/activity";
import { inBackground } from "../lib/notifyEvents";
import { preview as textPreview } from "../lib/notifyEventsCore";
import { notifyUser } from "../lib/notifyUtils";
import { activeViolationSql, archiveWhereSql, isArchiveReason, parseArchiveMode } from "../lib/violationArchive";
import { AppError, badRequest, forbidden, notFound, unauthorized, type ErrorCode } from "../lib/http";

const router: IRouter = Router();

// ─── Ownership ────────────────────────────────────────────────────────────────
// Rules and violations belong to a trader. Traders may only see/change their own personal rules;
// curators/admins (rules.manage.team, scope-aware) may act on behalf of any trader they manage.
// Rule origin:
//   personal — the trader's own rule (created by the trader, or by staff for themselves);
//   office   — set by staff for a specific trader (trader can see it, can't edit/disable/delete it);
//   desk     — trading_rules.trader = '*': applies to every trader (staff with unrestricted scope only).
// The client-supplied `trader` is never trusted for a trader-role user.

type Scope =
  | { ok: true; trader: string | null; staff: boolean; actor: string }
  | { ok: false; error: AppError };

async function resolveScope(req: Request, claimed: unknown, opts: { allowAll?: boolean } = {}): Promise<Scope> {
  const auth = req.authUser;
  if (!auth) return { ok: false, error: unauthorized() };
  const claimedName = typeof claimed === "string" && claimed.trim() ? claimed.trim() : null;
  // Guests: read-only sentinel scope (matches no trader) — never anyone's rules or violations.
  if (isGuest(req)) return { ok: true, trader: GUEST_SCOPE, staff: false, actor: auth.name };
  const staff = await can(req, "rules.manage.team", { trader: claimedName });
  if (staff) {
    return { ok: true, trader: claimedName ?? (opts.allowAll ? null : auth.name), staff, actor: auth.name };
  }
  if (claimedName && claimedName !== auth.name) {
    return { ok: false, error: new AppError("RULES_OWN_ONLY", 403) };
  }
  return { ok: true, trader: auth.name, staff, actor: auth.name };
}

/** Staff with an unrestricted team scope may manage desk-wide rules. */
async function canManageDesk(req: Request): Promise<boolean> {
  if (!req.authUser || isGuest(req)) return false;
  if (!(await can(req, "rules.manage.team"))) return false;
  return (await readScope(req, "rules.manage.team")) === null;
}

/** May the caller edit/disable/delete this rule? */
async function canTouchRule(req: Request, rule: { trader: string; origin?: string | null }): Promise<{ ok: true } | { ok: false; code: ErrorCode }> {
  const auth = req.authUser;
  if (!auth || isGuest(req)) return { ok: false, code: "FORBIDDEN" };
  if (rule.trader === DESK_TRADER) {
    return (await canManageDesk(req)) ? { ok: true } : { ok: false, code: "RULE_DESK_STAFF_ONLY" };
  }
  const staff = await can(req, "rules.manage.team", { trader: rule.trader });
  if (staff) return { ok: true };
  if (rule.trader !== auth.name) return { ok: false, code: "RULE_EDIT_OWN_ONLY" };
  if (rule.origin === "office") return { ok: false, code: "RULE_OFFICE_LOCKED" };
  return { ok: true };
}

/** A failed validateThreshold as an API error (field label already in the request language). */
const thresholdError = (th: ThresholdError) => new AppError(th.code, 400, th.params);

const MAX_NAME = 120;
const MAX_NOTE = 500;
const MAX_COMMENT = 2000;

const RULE_COLS = `id, trader, name, kind, threshold, enabled, created_at, origin, created_by, note`;

/** Public rule shape. Keeps the original fields (id, trader, name, kind, threshold, enabled, createdAt) — additive only. */
function shapeRule(r: any, lang: Lang) {
  const s = mapRuleRow(r);
  const meta = kindMeta(s.kind, lang);
  return {
    id: s.id, trader: s.trader, name: s.name, kind: s.kind, threshold: s.threshold, enabled: s.enabled, createdAt: s.createdAt,
    origin: s.origin, desk: s.desk, createdBy: s.createdBy, note: s.note,
    auto: meta ? meta.auto : true, kindLabel: meta?.label ?? s.kind, summary: describeThreshold(s.kind, s.threshold, undefined, lang),
  };
}

function parseWindow(q: Record<string, unknown>): { from: string; to: string; days: number } {
  const today = nyDate();
  const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const to = isDay(q.to) && q.to <= today ? q.to : today;
  if (isDay(q.from) && q.from <= to) {
    const days = Math.round((Date.parse(to) - Date.parse(q.from)) / 86400000);
    return { from: q.from, to, days };
  }
  const raw = Number(q.days);
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 730) : 90;
  return { from: addDays(to, -days), to, days };
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

/** Full catalog of rule kinds (the original 11 first, same fields) + groups. Each item: kind, label, hint, group, auto, needs, fields. */
router.get("/rules/kinds", asyncHandler(async (req, res): Promise<void> => {
  const lang = langOf(req);
  const groups = ruleGroupsFor(lang);
  res.json(catalogFor(lang).map((k) => ({ ...k, groupLabel: groups[k.group] })));
}));

// ─── Rules CRUD ───────────────────────────────────────────────────────────────

router.get("/rules", asyncHandler(async (req, res): Promise<void> => {
  await ensureRulesSchema();
  const scope = await resolveScope(req, req.query.trader, { allowAll: true });
  if (!scope.ok) throw scope.error;
  const params: unknown[] = [];
  let sql = `SELECT ${RULE_COLS} FROM trading_rules WHERE deleted_at IS NULL`;
  if (scope.trader) { sql += ` AND (trader = $1 OR trader = '${DESK_TRADER}')`; params.push(scope.trader); }
  sql += ` ORDER BY created_at DESC`;
  const { rows } = await pool.query<any>(sql, params);
  const lang = langOf(req);
  res.json(rows.map((r) => shapeRule(r, lang)));
}));

/**
 * Create a rule. Contract (backward compatible; used by «Сделать правилом» on /behavior):
 *   POST /api/rules { name, kind, threshold?, enabled?, trader?, note?, desk? }
 *   → 201 { id, trader, name, kind, threshold, enabled, createdAt, origin, desk, createdBy, note, auto, kindLabel, summary }
 * - trader: whose rule (staff only for others; default — the caller). desk: true → applies to every trader (staff).
 * - origin is derived: staff creating for another trader → "office", otherwise "personal".
 * - threshold is validated against the kind's fields (GET /rules/kinds); empty optional fields fall back to the risk desk.
 */
router.post("/rules", asyncHandler(async (req, res): Promise<void> => {
  await ensureRulesSchema();
  const { trader, name, kind, threshold, enabled, note, desk } = req.body as Record<string, unknown>;
  if (isGuest(req)) throw new AppError("GUEST_READ_ONLY");
  const deskWide = desk === true;
  let owner: string;
  let origin: "personal" | "office";
  const actor = req.authUser?.name ?? null;
  if (deskWide) {
    if (!(await canManageDesk(req))) throw new AppError("RULE_DESK_STAFF_ONLY", 403);
    owner = DESK_TRADER;
    origin = "office";
  } else {
    const scope = await resolveScope(req, trader);
    if (!scope.ok) throw scope.error;
    owner = scope.trader!;
    origin = scope.staff && owner !== scope.actor ? "office" : "personal";
  }
  const cleanName = typeof name === "string" ? name.trim() : "";
  const lang = langOf(req);
  if (!cleanName) throw badRequest("NAME_REQUIRED");
  if (!kind || !kindMeta(String(kind))) throw badRequest("RULE_KIND_INVALID", { kinds: RULE_CATALOG.map((k) => k.kind) });
  if (cleanName.length > MAX_NAME) throw badRequest("NAME_TOO_LONG", undefined, { max: MAX_NAME });
  const th = validateThreshold(String(kind), threshold, lang);
  if (!th.ok) throw thresholdError(th);
  const cleanNote = typeof note === "string" && note.trim() ? note.trim().slice(0, MAX_NOTE) : null;
  const { rows } = await pool.query<any>(
    `INSERT INTO trading_rules (trader, name, kind, threshold, enabled, origin, created_by, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${RULE_COLS}`,
    [owner, cleanName, String(kind), JSON.stringify(th.value), enabled === false ? false : true, origin, actor, cleanNote],
  );
  if (owner === DESK_TRADER) scanRulesAll().catch((e) => req.log.warn({ err: e.message }, "rule scan failed"));
  else scanRulesForTrader(owner).catch((e) => req.log.warn({ err: e.message }, "rule scan failed"));
  if (origin === "office") {
    const ru = rulesT.tFor("ru");
    logActivity({
      action: "created", section: "rules", entityId: String(rows[0].id), entityTitle: cleanName, trader: actor ?? "",
      details: owner === DESK_TRADER ? ru("activity.deskRule") : ru("activity.officeRule", { trader: owner }),
      params: owner === DESK_TRADER ? { detailsKey: "rules.activity.deskRule" } : { detailsKey: "rules.activity.officeRule", trader: owner },
    }).catch(() => {});
  }
  res.status(201).json(shapeRule(rows[0], lang));
}));

router.patch("/rules/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureRulesSchema();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const { rows: existing } = await pool.query<any>(`SELECT trader, kind, origin FROM trading_rules WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!existing[0]) throw notFound("RULE_NOT_FOUND");
  const access = await canTouchRule(req, existing[0]);
  if (!access.ok) throw new AppError(access.code, 403);

  const { name, kind, threshold, enabled, note } = req.body as Record<string, unknown>;
  const lang = langOf(req);
  const sets: string[] = [];
  const params: unknown[] = [];
  if (name !== undefined) {
    const n = String(name).trim();
    if (!n) throw badRequest("NAME_REQUIRED");
    if (n.length > MAX_NAME) throw badRequest("NAME_TOO_LONG", undefined, { max: MAX_NAME });
    sets.push(`name = $${params.length + 1}`); params.push(n);
  }
  let effectiveKind = existing[0].kind as string;
  if (kind !== undefined) {
    if (!kindMeta(String(kind))) throw badRequest("RULE_KIND_INVALID");
    effectiveKind = String(kind);
    sets.push(`kind = $${params.length + 1}`); params.push(effectiveKind);
  }
  if (threshold !== undefined || kind !== undefined) {
    const th = validateThreshold(effectiveKind, threshold ?? {}, lang);
    if (!th.ok) throw thresholdError(th);
    sets.push(`threshold = $${params.length + 1}`); params.push(JSON.stringify(th.value));
  }
  if (note !== undefined) {
    const n = note == null ? null : String(note).trim().slice(0, MAX_NOTE) || null;
    sets.push(`note = $${params.length + 1}`); params.push(n);
  }
  if (enabled !== undefined) { sets.push(`enabled = $${params.length + 1}`); params.push(Boolean(enabled)); }
  if (sets.length === 0) throw badRequest("NO_FIELDS");
  params.push(id);
  const { rows } = await pool.query<any>(
    `UPDATE trading_rules SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING ${RULE_COLS}`,
    params,
  );
  if (rows.length === 0) throw notFound("RULE_NOT_FOUND");
  // Disabled rules are skipped by the scanner: their violations (with comments and reviews) are archived, not deleted —
  // out of counts and default lists, shown in rule history with «правило выключено». Re-enabling brings them back;
  // the rescan below then dedups by dedup_key (upsert) and archives/deletes the ones that no longer apply.
  if (rows[0].enabled === false) {
    await pool.query(
      `UPDATE rule_violations SET archived_at = NOW(), archived_reason = 'rule_disabled' WHERE rule_id = $1 AND archived_at IS NULL`,
      [id],
    );
  } else {
    await pool.query(
      `UPDATE rule_violations SET archived_at = NULL, archived_reason = NULL WHERE rule_id = $1 AND archived_reason = 'rule_disabled'`,
      [id],
    );
  }
  if (rows[0].trader === DESK_TRADER) scanRulesAll().catch((e) => req.log.warn({ err: e.message }, "rule scan failed"));
  else scanRulesForTrader(rows[0].trader).catch((e) => req.log.warn({ err: e.message }, "rule scan failed"));
  res.json(shapeRule(rows[0], lang));
}));

/**
 * Soft delete: the rule is hidden and disabled (deleted_at); its violations are archived (rule_deleted) with their
 * comments — hidden from default lists, kept for the archive filter and past-period reports. Restore via POST /rules/:id/restore.
 */
router.delete("/rules/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureRulesSchema();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const { rows: existing } = await pool.query<any>(`SELECT trader, origin, name FROM trading_rules WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!existing[0]) throw notFound("RULE_NOT_FOUND");
  const access = await canTouchRule(req, existing[0]);
  if (!access.ok) throw new AppError(access.code, 403);
  await pool.query(`UPDATE trading_rules SET deleted_at = NOW(), enabled = false WHERE id = $1`, [id]);
  const arch = await pool.query(
    `UPDATE rule_violations SET archived_at = COALESCE(archived_at, NOW()), archived_reason = 'rule_deleted'
      WHERE rule_id = $1 AND (archived_at IS NULL OR archived_reason = 'rule_disabled')`,
    [id],
  );
  res.json({ success: true, softDeleted: true, violationsArchived: arch.rowCount ?? 0 });
}));

router.post("/rules/:id/restore", asyncHandler(async (req, res): Promise<void> => {
  await ensureRulesSchema();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const { rows: existing } = await pool.query<any>(`SELECT trader, origin FROM trading_rules WHERE id = $1 AND deleted_at IS NOT NULL`, [id]);
  if (!existing[0]) throw notFound("RULE_NOT_FOUND");
  const access = await canTouchRule(req, existing[0]);
  if (!access.ok) throw new AppError(access.code, 403);
  const { rows } = await pool.query<any>(`UPDATE trading_rules SET deleted_at = NULL, enabled = true WHERE id = $1 RETURNING ${RULE_COLS}`, [id]);
  // The restored rule is enabled again: its archived violations come back; the rescan dedups by dedup_key.
  await pool.query(
    `UPDATE rule_violations SET archived_at = NULL, archived_reason = NULL WHERE rule_id = $1 AND archived_reason IN ('rule_deleted', 'rule_disabled')`,
    [id],
  );
  if (rows[0].trader === DESK_TRADER) scanRulesAll().catch(() => {});
  else scanRulesForTrader(rows[0].trader).catch(() => {});
  res.json(shapeRule(rows[0], langOf(req)));
}));

router.post("/rules/scan", asyncHandler(async (req, res): Promise<void> => {
  const scope = await resolveScope(req, req.query.trader, { allowAll: true });
  if (!scope.ok) throw scope.error;
  if (scope.trader) {
    const result = await scanRulesForTrader(scope.trader);
    res.json({ trader: scope.trader, ...result });
  } else {
    const result = await scanRulesAll();
    res.json(result);
  }
}));

// ─── Report (live, on fresh trades) ───────────────────────────────────────────

// Persisting violations (for the «Нарушения» list, journal and other pages) is caught up in the background when the
// report is opened — at most once per 10 minutes per trader. The report itself is always computed live.
const lastScan = new Map<string, number>();
function maybeBackgroundScan(trader: string, log: Request["log"]) {
  const now = Date.now();
  if ((lastScan.get(trader) ?? 0) > now - 10 * 60_000) return;
  lastScan.set(trader, now);
  scanRulesForTrader(trader).catch((e) => log.warn({ err: e.message }, "rule scan failed"));
}

async function persistedMap(trader: string): Promise<Map<string, PersistedViolation>> {
  const { rows } = await pool.query<any>(
    `SELECT id, rule_id, dedup_key, acknowledged_at, resolved_at, resolution FROM rule_violations
      WHERE trader = $1 AND dedup_key IS NOT NULL AND ${activeViolationSql()}`,
    [trader],
  );
  const m = new Map<string, PersistedViolation>();
  for (const r of rows) {
    m.set(`${r.rule_id}:${r.dedup_key}`, {
      id: Number(r.id),
      status: r.resolved_at ? "resolved" : r.acknowledged_at ? "acknowledged" : "open",
      resolution: r.resolution ?? null,
    });
  }
  return m;
}

/** Per rule: this trader's violations archived because the rule is disabled (they come back when it is re-enabled). */
async function archivedCounts(trader: string): Promise<Map<number, number>> {
  const { rows } = await pool.query<any>(
    `SELECT rule_id, COUNT(*)::int AS n FROM rule_violations WHERE trader = $1 AND archived_reason = 'rule_disabled' GROUP BY rule_id`,
    [trader],
  );
  return new Map(rows.map((r: any) => [Number(r.rule_id), Number(r.n)] as [number, number]));
}

/**
 * GET /rules/report?trader&days=90 | from&to
 * Per rule: compliance % (days / trades), weekly trend, $ impact of violations, violating vs clean trades, examples;
 * plus totals, discipline calendar and history-based defaults for templates (stats). See lib/rulesReport.
 */
router.get("/rules/report", asyncHandler(async (req, res): Promise<void> => {
  await ensureRulesSchema();
  const scope = await resolveScope(req, req.query.trader);
  if (!scope.ok) throw scope.error;
  const trader = scope.trader!;
  const { from, to, days } = parseWindow(req.query as Record<string, unknown>);
  const [rules, trades, limits, marks, persisted, archivedByRule] = await Promise.all([
    fetchRulesFor(trader), fetchTrades(trader), fetchRiskLimits(trader), fetchSelfMarks(trader), persistedMap(trader), archivedCounts(trader),
  ]);
  const lang = langOf(req);
  const report = buildRulesReport({ trader, rules, trades, limits, from, to, marks, persisted, lang });
  const auth = req.authUser!;
  const staffFor = await can(req, "rules.manage.team", { trader });
  const desk = await canManageDesk(req);
  const rulesOut = report.rules.map((r) => ({
    ...r,
    canEdit: r.desk ? desk : staffFor || (r.trader === auth.name && r.origin !== "office"),
    // Violations kept while the rule is off (with comments) — rule history shows them with «правило выключено».
    archivedViolations: archivedByRule.get(r.id) ?? 0,
  }));
  if (rules.some((r) => r.enabled && r.kind !== "self_check")) maybeBackgroundScan(trader, req.log);
  res.json({ ...report, rules: rulesOut, days, canManageTeam: staffFor && trader !== auth.name, canManageDesk: desk });
}));

/** GET /rules/preview?trader&days&kind&threshold=<json> — what-if for a rule that doesn't exist yet. */
router.get("/rules/preview", asyncHandler(async (req, res): Promise<void> => {
  const scope = await resolveScope(req, req.query.trader);
  if (!scope.ok) throw scope.error;
  const trader = scope.trader!;
  const kind = String(req.query.kind ?? "");
  if (!kindMeta(kind)) throw badRequest("RULE_KIND_INVALID");
  let rawTh: unknown = {};
  if (typeof req.query.threshold === "string" && req.query.threshold) {
    try { rawTh = JSON.parse(req.query.threshold); } catch { throw badRequest("RULE_THRESHOLD_INVALID"); }
  }
  const lang = langOf(req);
  const th = validateThreshold(kind, rawTh, lang);
  if (!th.ok) throw thresholdError(th);
  const { from, to } = parseWindow(req.query as Record<string, unknown>);
  const [trades, limits] = await Promise.all([fetchTrades(trader), fetchRiskLimits(trader)]);
  const rule: StoredRule = { id: 0, trader, name: "preview", kind, threshold: th.value, enabled: true, origin: "personal", desk: false, note: null, createdBy: null, createdAt: null };
  res.json(previewRule(rule, { trader, trades, limits, from, to, marks: [], lang }));
}));

// ─── Self-checks (journal integration) ───────────────────────────────────────

/**
 * GET /rules/self-checks?trader&day=YYYY-MM-DD (or from&to)
 * → { trader, rules: [{ id, name, note, origin, desk }], marks: [{ ruleId, day, ok, note }] }
 * Rules of kind self_check that apply to the trader; the journal shows them as a daily checklist.
 */
router.get("/rules/self-checks", asyncHandler(async (req, res): Promise<void> => {
  await ensureRulesSchema();
  const scope = await resolveScope(req, req.query.trader);
  if (!scope.ok) throw scope.error;
  const trader = scope.trader!;
  const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const from = isDay(req.query.day) ? req.query.day : isDay(req.query.from) ? req.query.from : addDays(nyDate(), -30);
  const to = isDay(req.query.day) ? req.query.day : isDay(req.query.to) ? req.query.to : nyDate();
  const rules = (await fetchRulesFor(trader, { enabledOnly: true })).filter((r) => r.kind === "self_check");
  const marks = rules.length ? await fetchSelfMarks(trader, from, to) : [];
  res.json({
    trader,
    rules: rules.map((r) => ({ id: r.id, name: r.name, note: r.note, origin: r.origin, desk: r.desk })),
    marks: marks.filter((m) => rules.some((r) => r.id === m.ruleId)),
  });
}));

/**
 * PUT /rules/self-checks { trader?, day, ruleId, ok: true | false | null, note? }
 * ok = true «соблюдал», false «нарушил» (becomes a violation), null — clear the mark. Owner or staff only.
 */
router.put("/rules/self-checks", asyncHandler(async (req, res): Promise<void> => {
  await ensureRulesSchema();
  const body = req.body as Record<string, unknown>;
  if (isGuest(req)) throw new AppError("GUEST_READ_ONLY");
  const scope = await resolveScope(req, body.trader);
  if (!scope.ok) throw scope.error;
  const trader = scope.trader!;
  const day = typeof body.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? body.day : null;
  if (!day) throw badRequest("INVALID_DATE");
  if (day > nyDate()) throw badRequest("DAY_IN_FUTURE");
  const ruleId = Number(body.ruleId);
  const ok = body.ok === true ? true : body.ok === false ? false : null;
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, MAX_NOTE) : null;
  const rule = (await fetchRulesFor(trader, { enabledOnly: true })).find((r) => r.id === ruleId && r.kind === "self_check");
  if (!rule) throw notFound("RULE_NOT_FOUND");
  if (ok === null) {
    // Clearing keeps the row (ok = NULL, «не отмечено») — nothing the trader entered is hard-deleted.
    await pool.query(`UPDATE rule_self_checks SET ok = NULL, note = NULL, updated_by = $4, updated_at = NOW() WHERE rule_id = $1 AND trader = $2 AND day = $3`, [ruleId, trader, day, scope.actor]);
  } else {
    await pool.query(
      `INSERT INTO rule_self_checks (rule_id, trader, day, ok, note, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (rule_id, trader, day) DO UPDATE SET ok = EXCLUDED.ok, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [ruleId, trader, day, ok, note, scope.actor],
    );
  }
  await syncSelfCheckViolation(ruleId, trader, day, ok, note);
  res.json({ ruleId, trader, day, ok, note });
}));

/**
 * Legacy discipline aggregate for one trader (kept for compatibility): trades in the window with per-trade counts
 * of persisted rule violations and logged mistakes, shared signed R and NET P&L.
 */
router.get("/rules/discipline", asyncHandler(async (req, res): Promise<void> => {
  const scope = await resolveScope(req, req.query.trader);
  if (!scope.ok) throw scope.error;
  const trader = scope.trader!;
  const rawDays = Number(req.query.days);
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(Math.floor(rawDays), 366) : 90;
  const today = nyDate();
  const fromDate = addDays(today, -days);

  const { rows } = await pool.query<any>(
    `SELECT t.id, t.ticker, t.date, ${closeDateSql()} AS "closeDate", t.side, t.setup, t.playbook_id AS "playbookId",
            ${resultSql()} AS result, ${signedRSql()} AS "signedR",
            t.pnl, t.fees, ${netPnlSql()} AS "netPnl", ${horizonSql()} AS horizon, t.source,
            COALESCE(v.cnt, 0)::int AS violations,
            COALESCE(v.cost, 0)::float AS "violationCost",
            COALESCE(e.cnt, 0)::int AS mistakes
       FROM trades t
       LEFT JOIN (SELECT trade_id, COUNT(*) AS cnt, SUM(cost_net) AS cost FROM rule_violations WHERE trader = $1 AND trade_id IS NOT NULL AND ${activeViolationSql()} GROUP BY trade_id) v
              ON v.trade_id = t.id
       LEFT JOIN (SELECT trade_id, COUNT(*) AS cnt FROM trading_errors WHERE trader = $1 AND trade_id IS NOT NULL GROUP BY trade_id) e
              ON e.trade_id = t.id
      WHERE t.trader = $1 AND t.deleted_at IS NULL AND ${closeDateSql()} >= $2
      ORDER BY ${closeDateSql()} DESC, t.id DESC
      LIMIT 2000`,
    [trader, fromDate],
  );
  res.json({
    trader,
    from: fromDate,
    to: today,
    days,
    trades: rows.map((r: any) => ({
      id: r.id,
      ticker: r.ticker,
      date: r.date,
      closeDate: r.closeDate ?? r.date,
      side: r.side ?? null,
      setup: r.setup ?? null,
      playbookId: r.playbookId ?? null,
      result: r.result,
      rMultiple: r.signedR == null ? null : Number(r.signedR),
      pnl: r.pnl == null ? null : Number(r.pnl),
      fees: r.fees == null ? null : Number(r.fees),
      netPnl: r.netPnl == null ? null : Number(r.netPnl),
      horizon: r.horizon,
      source: r.source ?? null,
      violations: r.violations,
      violationCost: Number(r.violationCost ?? 0),
      mistakes: r.mistakes,
    })),
  });
}));

// ─── Violations ───────────────────────────────────────────────────────────────

const VIOLATION_SELECT = `
  SELECT v.id, v.trader, v.rule_id AS "ruleId", v.trade_id AS "tradeId",
         v.occurred_at AS "occurredAt", v.severity, v.message, v.details,
         v.day, v.cost_net::float AS "costNet",
         v.acknowledged_by AS "acknowledgedBy", v.acknowledged_at AS "acknowledgedAt", v.comment,
         v.resolution, v.consequence, v.resolved_by AS "resolvedBy", v.resolved_at AS "resolvedAt",
         v.archived_at AS "archivedAt", v.archived_reason AS "archivedReason",
         r.enabled AS "ruleEnabled", (r.deleted_at IS NOT NULL) AS "ruleDeleted",
         r.name AS "ruleName", r.kind AS "ruleKind", r.origin AS "ruleOrigin", (r.trader = '${DESK_TRADER}') AS "ruleDesk",
         t.ticker, t.date AS "tradeDate", ${closeDateSql()} AS "tradeCloseDate", ${resultSql()} AS "tradeResult",
         ${signedRSql()} AS "tradeR", t.pnl::float AS "tradePnl", ${netPnlSql()}::float AS "tradeNetPnl",
         t.setup AS "tradeSetup", t.playbook_id AS "playbookId", p.name AS "playbookName", t.source AS "tradeSource"
    FROM rule_violations v
    LEFT JOIN trading_rules r ON v.rule_id = r.id
    LEFT JOIN trades t ON v.trade_id = t.id
    LEFT JOIN playbook p ON p.id = t.playbook_id
`;

function shapeViolation(r: any, lang: Lang) {
  return {
    ...r,
    // Stored reason (Russian) → the reader's language when the row carries it as data (details.msg).
    message: violationMessage(r.message, r.details, lang),
    costNet: r.costNet == null ? null : Number(r.costNet),
    tradeR: r.tradeR == null ? null : Number(r.tradeR),
    tradePnl: r.tradePnl == null ? null : Number(r.tradePnl),
    tradeNetPnl: r.tradeNetPnl == null ? null : Number(r.tradeNetPnl),
    ruleOrigin: r.ruleDesk ? "office" : r.ruleOrigin ?? "personal",
    ruleDesk: !!r.ruleDesk,
    status: r.resolvedAt ? "resolved" : r.acknowledgedAt ? "acknowledged" : "open",
    archived: r.archivedAt != null,
    archivedReason: isArchiveReason(r.archivedReason) ? r.archivedReason : r.archivedAt != null ? "stale" : null,
    ruleEnabled: r.ruleEnabled !== false,
    ruleDeleted: !!r.ruleDeleted,
  };
}

/**
 * GET /rule-violations?trader&status&from&to&tradeId&tradeIds&ruleId&limit&offset&paged
 *   tradeIds  comma-separated ids (≤ 500) — only the violations of these trades (e.g. the trades of one journal day).
 *   offset    skip N rows of the same order (day desc, id desc) — pagination instead of one big limit=500.
 *   paged=1   respond `{ items, nextOffset }` (nextOffset null on the last page); without it the response stays
 *             the plain array (old behaviour).
 * Archive (lib/violationArchive): active rows only by default; `include=archived` adds archived rows (disabled /
 * deleted rules, stale), `archived=only` returns only them. A ruleId filter (rule history) also shows the rows of a
 * disabled rule. Each row carries archived / archivedReason for the badge.
 */
router.get("/rule-violations", asyncHandler(async (req, res): Promise<void> => {
  await ensureRulesSchema();
  const scope = await resolveScope(req, req.query.trader, { allowAll: true });
  if (!scope.ok) throw scope.error;
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 200;
  const params: unknown[] = [];
  const archiveMode = parseArchiveMode(req.query as Record<string, unknown>);
  const ruleHistory = typeof req.query.ruleId === "string" && /^\d+$/.test(req.query.ruleId);
  const where: string[] = [archiveWhereSql(archiveMode, { ruleHistory })];
  if (scope.trader) { params.push(scope.trader); where.push(`v.trader = $${params.length}`); }
  const status = typeof req.query.status === "string" ? req.query.status : "";
  if (status === "open") where.push(`v.acknowledged_at IS NULL AND v.resolved_at IS NULL`);
  else if (status === "acknowledged") where.push(`v.acknowledged_at IS NOT NULL AND v.resolved_at IS NULL`);
  else if (status === "resolved") where.push(`v.resolved_at IS NOT NULL`);
  const dayExpr = `COALESCE(v.day, ${closeDateSql()}, to_char(v.occurred_at, 'YYYY-MM-DD'))`;
  if (typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)) { params.push(req.query.from); where.push(`${dayExpr} >= $${params.length}`); }
  if (typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) { params.push(req.query.to); where.push(`${dayExpr} <= $${params.length}`); }
  if (typeof req.query.tradeId === "string" && /^\d+$/.test(req.query.tradeId)) { params.push(Number(req.query.tradeId)); where.push(`v.trade_id = $${params.length}`); }
  if (typeof req.query.tradeIds === "string") {
    const ids = [...new Set(req.query.tradeIds.split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500);
    params.push(ids);
    where.push(`v.trade_id = ANY($${params.length}::int[])`);
  }
  if (typeof req.query.ruleId === "string" && /^\d+$/.test(req.query.ruleId)) { params.push(Number(req.query.ruleId)); where.push(`v.rule_id = $${params.length}`); }
  let sql = VIOLATION_SELECT;
  sql += ` WHERE ${where.join(" AND ")}`;
  const rawOffset = Number(req.query.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.min(Math.floor(rawOffset), 1_000_000) : 0;
  const paged = req.query.paged === "1" || req.query.paged === "true";
  params.push(paged ? limit + 1 : limit); // one extra row tells whether another page exists
  sql += ` ORDER BY ${dayExpr} DESC, v.id DESC LIMIT $${params.length}`;
  if (offset) { params.push(offset); sql += ` OFFSET $${params.length}`; }
  const { rows } = await pool.query<any>(sql, params);
  const lang = langOf(req);
  if (!paged) { res.json(rows.map((r) => shapeViolation(r, lang))); return; }
  const more = rows.length > limit;
  res.json({ items: rows.slice(0, limit).map((r) => shapeViolation(r, lang)), nextOffset: more ? offset + limit : null });
}));

/**
 * Acknowledge / resolve workflow.
 *   trader (owner):  { acknowledged: true, comment? }           — "я видел, вот почему"
 *   curator/admin:   { resolution: 'upheld'|'dismissed'|null, consequence?, comment? }
 * Violations are never deleted by traders; the scanner keeps these fields across re-scans.
 */
router.patch("/rule-violations/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureRulesSchema();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const auth = req.authUser;
  if (!auth) throw unauthorized();
  const { rows: existing } = await pool.query<any>(`SELECT trader, message, details FROM rule_violations WHERE id = $1`, [id]);
  if (!existing[0]) throw notFound();
  const owner = existing[0].trader === auth.name;
  const staff = await can(req, "rules.manage.team", { trader: existing[0].trader });
  if (!owner && !staff) throw forbidden();

  const body = req.body as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };

  if (body.comment !== undefined) {
    const c = body.comment == null ? null : String(body.comment).trim().slice(0, MAX_COMMENT);
    push("comment", c || null);
  }
  if (body.acknowledged !== undefined) {
    if (body.acknowledged === true) {
      push("acknowledged_by", auth.name);
      sets.push(`acknowledged_at = COALESCE(rule_violations.acknowledged_at, NOW())`);
    } else if (staff) {
      push("acknowledged_by", null);
      push("acknowledged_at", null);
    } else {
      throw new AppError("VIOLATION_UNACK_STAFF_ONLY", 403);
    }
  }
  if (body.resolution !== undefined || body.consequence !== undefined) {
    if (!staff) throw new AppError("VIOLATION_DECISION_STAFF_ONLY", 403);
    if (body.resolution !== undefined) {
      const r = body.resolution == null || body.resolution === "" ? null : String(body.resolution);
      if (r != null && r !== "upheld" && r !== "dismissed") throw badRequest("INVALID_FIELD", { field: "resolution", allowed: ["upheld", "dismissed"] }, { field: "resolution" });
      push("resolution", r);
      push("resolved_by", r ? auth.name : null);
      sets.push(r ? `resolved_at = NOW()` : `resolved_at = NULL`);
    }
    if (body.consequence !== undefined) {
      const c = body.consequence == null ? null : String(body.consequence).trim().slice(0, MAX_COMMENT);
      push("consequence", c || null);
    }
  }
  if (!sets.length) throw badRequest("NO_FIELDS");
  params.push(id);
  await pool.query(`UPDATE rule_violations SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
  const { rows } = await pool.query<any>(`${VIOLATION_SELECT} WHERE v.id = $1`, [id]);
  const v = shapeViolation(rows[0], langOf(req));
  const whatKey = body.resolution !== undefined ? (v.resolution === "dismissed" ? "dismissed" : v.resolution === "upheld" ? "upheld" : "decisionCleared")
    : body.acknowledged === true ? "acknowledged" : "commented";
  logActivity({
    action: "updated", section: "rules", entityId: String(id), entityTitle: v.ruleName ?? existing[0].message, trader: auth.name,
    details: rulesT.tFor("ru")(`activity.${whatKey}`), params: { detailsKey: `rules.activity.${whatKey}` },
  }).catch(() => {});
  // A curator's decision reaches the trader (never the curator about their own trades).
  const trader = String(existing[0].trader);
  if (body.resolution !== undefined && v.resolution && trader !== auth.name) {
    const storedMsg = (existing[0].details as { msg?: ViolationMsg } | null)?.msg;
    inBackground("rule_violation_decision", () => notifyUser({
      userName: trader, type: "rule_violation", source: "rules", actor: auth.name, severity: "info",
      // Rendered per reader (lib/notificationRenderers/rules.ts); the RU title/body are filled from the same params.
      params: {
        variant: "decision", decision: v.resolution, rule: v.ruleName ? textPreview(v.ruleName, 60) : null,
        consequence: v.consequence ?? null, comment: v.comment ?? null, message: String(existing[0].message ?? ""), ...violationMsgParams(storedMsg),
      },
      link: `/rules?tab=violations&trader=${encodeURIComponent(trader)}`, entityType: "rule_violation", entityId: id,
    }));
  }
  res.json(v);
}));

/**
 * Violations are derived from trades (a re-scan would recreate a deleted row), so DELETE is a soft «снять»:
 * resolution = dismissed. Curator only (rules.violations.delete).
 */
router.delete("/rule-violations/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureRulesSchema();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  if (!req.authUser) throw unauthorized();
  if (isGuest(req)) throw new AppError("GUEST_READ_ONLY");
  if (!(await can(req, "rules.violations.delete"))) throw new AppError("VIOLATION_DISMISS_STAFF_ONLY", 403, undefined, { capability: "rules.violations.delete" });
  const { rows } = await pool.query<any>(`SELECT trader FROM rule_violations WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound();
  await pool.query(
    `UPDATE rule_violations SET resolution = 'dismissed', resolved_by = $2, resolved_at = COALESCE(resolved_at, NOW()) WHERE id = $1`,
    [id, req.authUser.name],
  );
  res.json({ success: true, dismissed: true });
}));

export default router;
