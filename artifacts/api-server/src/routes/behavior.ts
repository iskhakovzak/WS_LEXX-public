/**
 * «Поведение» — поведенческие паттерны трейдера (реванш, мартингейл, овертрейдинг, усталость, отыгрыш,
 * тильт, пересиживание убытков, первая сделка, эйфория) и дневной индекс дисциплины.
 *
 *   GET    /api/behavior?trader=&from=&to=&revengeMin=10   — полный отчёт (lib/behaviorEngine.analyzeBehavior):
 *          паттерны со стоимостью, трендом 30д и рекомендацией, профиль трейдера, индекс дисциплины, кривые
 *   GET    /api/behavior/day?trader=&date=&from=&to=        — лента дня: сделки по времени, накопленный нетто,
 *          маркеры тильта/реванша/эйфории, момент срыва (нормы — по периоду from..to, если день в нём)
 *   GET    /api/behavior/triggers?trader=&from=&to=         — «мои триггеры» + ретроспективная проверка за период
 *   POST   /api/behavior/triggers {trader?, kind, params, name?, note?, sourcePattern?}
 *   PATCH  /api/behavior/triggers/:id {name?, params?, note?, enabled?}
 *   DELETE /api/behavior/triggers/:id                        — мягкое удаление (deleted_at)
 *
 * Таблица behavior_triggers создаётся идемпотентно (лениво) при первом обращении к триггерам. Scope по трейдеру
 * через lib/auth.scopeTrader (гость — пусто); запись — владелец или rules.manage.team (куратор), гость — никогда.
 * Деньги — нетто (lib/tradeMath.netPnlSql); время входа/выхода — из trade_executions, иначе из снапшота
 * PropReports (openedAt/closedAt — настенное время ET), иначе только дата + текст hold_time.
 */
import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { logActivity } from "../lib/activity";
import { scopeTrader, isGuestUser, GUEST_SCOPE } from "../lib/auth";
import { can, readScope } from "../lib/permissions";
import { resultSql, netPnlSql, horizonSql, num } from "../lib/tradeMath";
import { execSpanJoin } from "../lib/execSpan";
import { nyMinutes, nyDate } from "../lib/tradingDate";
import { etWallToUtcSeconds, parseDateStrict } from "../lib/candles/market";
import { analyzeBehavior, dayTimeline, groupByDay, parseHoldText, shiftDate, type BehaviorTrade } from "../lib/behaviorEngine";
import { TRIGGER_KIND_SET, describeTrigger, evaluateTrigger, isAutoTriggerName, triggerKindsFor, validateTriggerParams } from "../lib/behaviorTriggers";
import { behaviorT } from "../lib/behaviorI18n";
import { setupLabelOf } from "../lib/setupClassifier";
import { langOf } from "../i18n";
import { contractDeltas } from "../lib/daily/discipline";
import { AppError, badRequest, notFound, sendError, unauthorized } from "../lib/http";

const router: IRouter = Router();

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z.object({
  trader: z.string().trim().max(120).optional(),
  from: z.string().regex(YMD_RE).optional(),
  to: z.string().regex(YMD_RE).optional(),
  revengeMin: z.coerce.number().int().min(1).max(120).optional(),
  euphoriaMin: z.coerce.number().int().min(1).max(240).optional(),
});

function normQuery(q: Request["query"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === "string" && s.trim() !== "") out[k] = s;
  }
  return out;
}

/* ─── Загрузка сделок ─────────────────────────────────────────────────────── */

export type BehaviorRow = {
  id: number;
  ticker: string | null;
  date: string;
  side: string | null;
  setup: string | null;
  result: string | null;
  net: unknown;
  gross: unknown;
  qty: unknown;
  entry: unknown;
  exit: unknown;
  hold_time: string | null;
  horizon: string;
  exit_date: string | null;
  opened_at: string | null;
  closed_at: string | null;
  first_entry: Date | string | null;
  last_exit: Date | string | null;
  trader: string | null;
};


/** Настенное время ET без зоны ("2026-10-15T15:59:16") → epoch ms (DST-aware). */
export function etWallIsoToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(iso);
  if (!m) return null;
  // Строка уже с зоной (Z / ±hh:mm) — это обычный ISO.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)) {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  }
  const parsed = parseDateStrict(`${m[1]}-${m[2]}-${m[3]}`);
  if (!parsed) return null;
  return etWallToUtcSeconds(parsed, Number(m[4]), Number(m[5])) * 1000 + Number(m[6] ?? 0) * 1000;
}

function toMs(v: Date | string | null): number | null {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Строка БД → BehaviorTrade (время входа: исполнения → снапшот PropReports → null). */
export function rowToBehaviorTrade(r: BehaviorRow): BehaviorTrade {
  const date = String(r.date ?? "").slice(0, 10);
  const entryAt = toMs(r.first_entry) ?? etWallIsoToMs(r.opened_at);
  let exitAt = toMs(r.last_exit) ?? etWallIsoToMs(r.closed_at);
  let holdMin: number | null = entryAt != null && exitAt != null && exitAt >= entryAt ? (exitAt - entryAt) / 60000 : null;
  if (holdMin == null) {
    holdMin = parseHoldText(r.hold_time);
    if (holdMin != null && entryAt != null && exitAt == null) exitAt = entryAt + holdMin * 60000;
  }
  const sideRaw = (r.side ?? "").trim().toLowerCase();
  const side = sideRaw.startsWith("s") || sideRaw.startsWith("ш") ? "short" : sideRaw ? "long" : null; // i18n-ignore (stored side values)
  const res = r.result;
  const horizonRaw = r.horizon;
  return {
    id: Number(r.id),
    ticker: String(r.ticker ?? "").toUpperCase(),
    date,
    side,
    result: res === "win" || res === "loss" || res === "be" || res === "open" ? res : null,
    net: num(r.net),
    gross: num(r.gross),
    qty: num(r.qty),
    entry: num(r.entry),
    entryAt,
    exitAt,
    entryMin: entryAt != null ? nyMinutes(new Date(entryAt)) : null,
    holdMin,
    horizon: horizonRaw === "overnight" || horizonRaw === "swing" ? horizonRaw : "intraday",
    setup: r.setup && r.setup.trim() ? r.setup.trim() : null,
  };
}

/**
 * Сделки трейдера за период (без удалённых). `scope` = имя трейдера, null = все (staff), GUEST_SCOPE — пусто.
 * Переиспользуется классификатором сетапов (routes/setups-auto.ts).
 */
export async function loadBehaviorRows(scope: string | null, from?: string, to?: string, ids?: number[], traders?: string[]): Promise<BehaviorRow[]> {
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const cond = ["t.deleted_at IS NULL"];
  if (scope != null) cond.push(`t.trader = ${p(scope)}`);
  if (from) cond.push(`substring(t.date, 1, 10) >= ${p(from)}`);
  if (to) cond.push(`substring(t.date, 1, 10) <= ${p(to)}`);
  if (ids && ids.length) cond.push(`t.id = ANY(${p(ids)}::int[])`);
  if (traders) cond.push(`t.trader = ANY(${p(traders)}::text[])`);
  // One trader / explicit ids → per-trade index probe; desk-wide scans → one hash aggregate (cheaper above ~10k trades).
  const execJoin = execSpanJoin(scope != null || (ids && ids.length) || (traders && traders.length <= 12) ? "lateral" : "global");
  const sql = `
    SELECT t.id, t.ticker, t.date, t.side, t.setup, t.trader,
           ${resultSql("t")} AS result,
           ${netPnlSql("t")}::float8 AS net,
           t.pnl::float8 AS gross,
           t.qty::float8 AS qty,
           t.entry::float8 AS entry,
           t.exit::float8 AS exit,
           t.hold_time,
           ${horizonSql("t")} AS horizon,
           t.exit_date,
           t.context_snapshot->>'openedAt' AS opened_at,
           t.context_snapshot->>'closedAt' AS closed_at,
           e.first_entry, e.last_exit
    FROM trades t
    ${execJoin}
    WHERE ${cond.join(" AND ")}
    ORDER BY substring(t.date, 1, 10), e.first_entry NULLS LAST, t.id`;
  const { rows } = await pool.query<BehaviorRow>(sql, params);
  return rows;
}

/* ─── Сетап для профиля: сделка → иначе авто-классификатор ───────────────── */

/**
 * Сделкам без сетапа подставляем последнее не отклонённое предложение авто-классификатора (trade_setup_suggestions,
 * таблица routes/setups-auto.ts) с пометкой setupAuto — только для блока «лучший/худший сетап» профиля.
 * Таблицы ещё нет — без подстановки (её создаёт setups-auto, здесь не трогаем).
 */
async function withAutoSetups(trades: BehaviorTrade[]): Promise<BehaviorTrade[]> {
  const ids = trades.filter((t) => !t.setup).map((t) => t.id);
  if (!ids.length) return trades;
  try {
    const { rows } = await pool.query<{ trade_id: number; setup: string }>(
      `SELECT DISTINCT ON (trade_id) trade_id, setup FROM trade_setup_suggestions
        WHERE trade_id = ANY($1::int[]) AND status <> 'rejected'
        ORDER BY trade_id, updated_at DESC, id DESC`,
      [ids],
    );
    const map = new Map(rows.map((r) => [Number(r.trade_id), r.setup]));
    return trades.map((t) => (!t.setup && map.has(t.id) ? { ...t, setup: map.get(t.id)!, setupAuto: true } : t));
  } catch {
    return trades;
  }
}

/* ─── Маршруты: отчёт и лента дня ─────────────────────────────────────────── */

router.get("/behavior", asyncHandler(async (req, res) => {
  const parsed = querySchema.safeParse(normQuery(req.query));
  if (!parsed.success) throw badRequest("BAD_REQUEST", parsed.error.flatten());
  const q = parsed.data;
  if (q.from && q.to && q.from > q.to) throw badRequest("DATE_RANGE_INVALID");
  const scope = await scopeTrader(req, q.trader);
  if (scope === undefined) throw unauthorized();

  const rows = await loadBehaviorRows(scope, q.from, q.to);
  const trades = await withAutoSetups(rows.map(rowToBehaviorTrade));
  const lang = langOf(req);
  // Own contract verdicts (lib/daily) move the day's discipline score: kept +, broken −.
  const days = trades.map((t) => t.date).sort();
  const contract = scope && scope !== GUEST_SCOPE && days.length ? await contractDeltas(scope, trades, days[0]!, days[days.length - 1]!) : undefined;
  const report = analyzeBehavior(trades, { revengeMin: q.revengeMin, euphoriaMin: q.euphoriaMin }, lang, contract);
  // Auto-classifier setups carry their canonical (RU) name; show the class label in the reader's language.
  const relabel = <T extends { label: string } | null>(b: T): T => (b ? { ...b, label: setupLabelOf(b.label, lang) } : b);
  report.profile.setups = { ...report.profile.setups, best: relabel(report.profile.setups.best), worst: relabel(report.profile.setups.worst), rows: report.profile.setups.rows.map(relabel) };
  res.json({
    scope,
    from: q.from ?? null,
    to: q.to ?? null,
    ...report,
    generatedAt: new Date().toISOString(),
  });
}));

/**
 * GET /behavior/top-patterns?traders=A,B&from=&to=&limit=2 — the costliest behaviour patterns per trader in ONE request
 * (the curator group view used to fire one full /behavior report per trader card). Only traders the caller may read
 * (team.read scope) are returned: { from, to, traders: { [name]: [{ key, title, n, cost, severity }] } }.
 */
const topSchema = z.object({
  traders: z.string().max(8000),
  from: z.string().regex(YMD_RE),
  to: z.string().regex(YMD_RE),
  limit: z.coerce.number().int().min(1).max(10).optional(),
});
router.get("/behavior/top-patterns", asyncHandler(async (req, res) => {
  const parsed = topSchema.safeParse(normQuery(req.query));
  if (!parsed.success) throw badRequest("BAD_REQUEST", parsed.error.flatten());
  const q = parsed.data;
  if (q.from > q.to) throw badRequest("DATE_RANGE_INVALID");
  if (!req.authUser) throw unauthorized();
  if (isGuestUser(req.authUser)) { res.json({ from: q.from, to: q.to, traders: {} }); return; }
  const wanted = [...new Set(q.traders.split(",").map((t) => t.trim()).filter((t) => t && t.length <= 120))].slice(0, 300);
  const allowed = await readScope(req, "team.read");
  const list = allowed === null ? wanted : wanted.filter((t) => allowed.includes(t));
  const out: Record<string, { key: string; title: string; n: number; cost: number | null; severity: string | null }[]> = {};
  if (list.length) {
    const rows = await loadBehaviorRows(null, q.from, q.to, undefined, list);
    const trades = await withAutoSetups(rows.map(rowToBehaviorTrade));
    const by = new Map<string, BehaviorTrade[]>();
    rows.forEach((r, i) => { const k = String(r.trader); const arr = by.get(k); if (arr) arr.push(trades[i]!); else by.set(k, [trades[i]!]); });
    for (const name of list) {
      const report = analyzeBehavior(by.get(name) ?? [], {}, langOf(req));
      out[name] = ((report as { patterns?: any[] }).patterns ?? [])
        .filter((p) => p.n > 0 && p.severity && p.severity !== "none")
        .sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0))
        .slice(0, q.limit ?? 2)
        .map((p) => ({ key: String(p.key), title: String(p.title), n: Number(p.n), cost: p.cost ?? null, severity: p.severity ?? null }));
    }
  }
  res.json({ from: q.from, to: q.to, traders: out });
}));

const daySchema = querySchema.extend({ date: z.string().regex(YMD_RE) });

router.get("/behavior/day", asyncHandler(async (req, res) => {
  const parsed = daySchema.safeParse(normQuery(req.query));
  if (!parsed.success) throw badRequest("BAD_REQUEST", parsed.error.flatten());
  const q = parsed.data;
  const scope = await scopeTrader(req, q.trader);
  if (scope === undefined) throw unauthorized();
  // Нормы (медиана сделок/день, паузы) — по периоду отчёта, если день в нём; иначе 90 дней до дня включительно.
  const inPeriod = (!q.from || q.date >= q.from) && (!q.to || q.date <= q.to);
  const from = inPeriod ? q.from : shiftDate(q.date, -89);
  const to = inPeriod ? q.to : q.date;
  const rows = await loadBehaviorRows(scope, from, to);
  const tl = dayTimeline(rows.map(rowToBehaviorTrade), q.date, { revengeMin: q.revengeMin, euphoriaMin: q.euphoriaMin }, langOf(req));
  res.json({ scope, normsFrom: from ?? null, normsTo: to ?? null, ...tl, generatedAt: new Date().toISOString() });
}));

/* ─── «Мои триггеры» ──────────────────────────────────────────────────────── */

let triggersEnsured: Promise<void> | null = null;
/** Идемпотентно; вызывается лениво из маршрутов триггеров. */
function ensureTriggersTable(): Promise<void> {
  if (!triggersEnsured) {
    triggersEnsured = pool
      .query(
        `CREATE TABLE IF NOT EXISTS behavior_triggers (
           id SERIAL PRIMARY KEY,
           trader TEXT NOT NULL,
           kind TEXT NOT NULL,
           name TEXT NOT NULL,
           params JSONB NOT NULL DEFAULT '{}'::jsonb,
           note TEXT,
           source_pattern TEXT,
           enabled BOOLEAN NOT NULL DEFAULT TRUE,
           created_by TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           deleted_at TIMESTAMPTZ
         );
         CREATE INDEX IF NOT EXISTS behavior_triggers_trader_idx ON behavior_triggers (trader) WHERE deleted_at IS NULL;`,
      )
      .then(() => undefined)
      .catch((err) => { triggersEnsured = null; throw err; });
  }
  return triggersEnsured;
}

type TriggerRow = {
  id: number; trader: string; kind: string; name: string; params: Record<string, number> | null; note: string | null;
  source_pattern: string | null; enabled: boolean; created_by: string | null; created_at: Date; updated_at: Date;
};

function shapeTrigger(r: TriggerRow) {
  return {
    id: Number(r.id), trader: r.trader, kind: r.kind, name: r.name, params: r.params ?? {}, note: r.note,
    sourcePattern: r.source_pattern, enabled: r.enabled, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Владелец или куратор (rules.manage.team — как у правил деска). Гость — никогда. */
async function canWriteTriggers(req: Request, trader: string): Promise<boolean> {
  const me = req.authUser;
  if (!me || isGuestUser(me)) return false;
  if (trader === me.name) return true;
  return can(req, "rules.manage.team", { trader });
}

const MAX_NAME = 120;
const MAX_NOTE = 1000;

const triggersQuery = z.object({
  trader: z.string().trim().max(120).optional(),
  from: z.string().regex(YMD_RE).optional(),
  to: z.string().regex(YMD_RE).optional(),
});

router.get("/behavior/triggers", asyncHandler(async (req, res) => {
  const parsed = triggersQuery.safeParse(normQuery(req.query));
  if (!parsed.success) throw badRequest("BAD_REQUEST", parsed.error.flatten());
  const q = parsed.data;
  const scoped = await scopeTrader(req, q.trader);
  if (scoped === undefined) throw unauthorized();
  const lang = langOf(req);
  const base = { kinds: triggerKindsFor(lang), today: nyDate(), from: q.from ?? null, to: q.to ?? null };
  if (scoped === GUEST_SCOPE || (scoped == null && !req.authUser?.name)) {
    res.json({ ...base, trader: null, canEdit: false, lastTradingDate: null, tradingDays: 0, items: [] });
    return;
  }
  const trader = scoped ?? req.authUser!.name;
  await ensureTriggersTable();
  const { rows } = await pool.query<TriggerRow>(
    `SELECT * FROM behavior_triggers WHERE trader = $1 AND deleted_at IS NULL ORDER BY enabled DESC, created_at DESC, id DESC`,
    [trader],
  );
  const trades = (await loadBehaviorRows(trader, q.from, q.to)).map(rowToBehaviorTrade).filter((t) => t.result !== "open");
  const byDay = groupByDay(trades);
  const dates = [...byDay.keys()].sort();
  res.json({
    ...base,
    trader,
    canEdit: await canWriteTriggers(req, trader),
    lastTradingDate: dates[dates.length - 1] ?? null,
    tradingDays: dates.length,
    items: rows.map((r) => ({ ...shapeTrigger(r), eval: evaluateTrigger(r.kind, r.params ?? {}, byDay, lang) })),
    generatedAt: new Date().toISOString(),
  });
}));

const createSchema = z.object({
  trader: z.string().trim().min(1).max(120).optional(),
  kind: z.string().refine((k) => TRIGGER_KIND_SET.has(k), "TRIGGER_KIND_INVALID"),
  params: z.record(z.string(), z.unknown()).optional(),
  name: z.string().trim().max(MAX_NAME).optional(),
  note: z.string().trim().max(MAX_NOTE).optional(),
  sourcePattern: z.string().trim().max(40).optional(),
});

router.post("/behavior/triggers", asyncHandler(async (req, res) => {
  const body = createSchema.safeParse(req.body ?? {});
  if (!body.success) {
    if (body.error.issues.some((i) => i.message === "TRIGGER_KIND_INVALID")) throw badRequest("TRIGGER_KIND_INVALID");
    throw badRequest("VALIDATION", body.error.issues.map((i) => ({ path: `body.${i.path.join(".")}`, message: i.message })));
  }
  const b = body.data;
  const lang = langOf(req);
  const me = req.authUser;
  if (!me || isGuestUser(me)) throw new AppError("GUEST_READ_ONLY");
  const trader = b.trader ?? me.name;
  if (!(await canWriteTriggers(req, trader))) throw new AppError("TRIGGERS_OWN_ONLY", 403);
  const params = validateTriggerParams(b.kind, b.params ?? {}, lang);
  if (!params.ok) throw new AppError(params.code, 400, params.params);
  if (b.kind === "custom" && !b.name && !b.note) throw badRequest("TRIGGER_TEXT_REQUIRED");
  // Default name in the author's language; once saved it is user content.
  const name = b.name || describeTrigger(b.kind, params.value, lang);
  await ensureTriggersTable();
  // Повторное «Сделать правилом» не плодит дубли: тот же вид + параметры (+ название для напоминаний).
  const dup = await pool.query<TriggerRow>(
    `SELECT * FROM behavior_triggers
      WHERE trader = $1 AND kind = $2 AND params = $3::jsonb AND deleted_at IS NULL AND ($2 <> 'custom' OR name = $4)
      LIMIT 1`,
    [trader, b.kind, JSON.stringify(params.value), name],
  );
  if (dup.rows[0]) {
    if (!dup.rows[0].enabled) await pool.query(`UPDATE behavior_triggers SET enabled = TRUE, updated_at = NOW() WHERE id = $1`, [dup.rows[0].id]);
    res.json({ ...shapeTrigger({ ...dup.rows[0], enabled: true }), existing: true });
    return;
  }
  const { rows } = await pool.query<TriggerRow>(
    `INSERT INTO behavior_triggers (trader, kind, name, params, note, source_pattern, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING *`,
    [trader, b.kind, name, JSON.stringify(params.value), b.note || null, b.sourcePattern ?? null, me.name],
  );
  logActivity({
    action: "created", section: "behavior", entityId: String(rows[0].id), entityTitle: name, trader: me.name,
    details: behaviorT.tFor("ru")("activity.triggerCreated", { trader }), params: { detailsKey: "behavior.activity.triggerCreated", trader },
  });
  res.status(201).json(shapeTrigger(rows[0]));
}));

const patchSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  note: z.string().trim().max(MAX_NOTE).nullable().optional(),
  enabled: z.boolean().optional(),
});
const idParam = z.coerce.number().int().positive();

async function loadWritableTrigger(req: Request, res: import("express").Response): Promise<TriggerRow | null> {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) { sendError(res, badRequest("INVALID_ID")); return null; }
  if (!req.authUser || isGuestUser(req.authUser)) { sendError(res, new AppError("GUEST_READ_ONLY")); return null; }
  await ensureTriggersTable();
  const { rows } = await pool.query<TriggerRow>(`SELECT * FROM behavior_triggers WHERE id = $1 AND deleted_at IS NULL`, [id.data]);
  if (!rows[0]) { sendError(res, notFound("TRIGGER_NOT_FOUND")); return null; }
  if (!(await canWriteTriggers(req, rows[0].trader))) { sendError(res, new AppError("TRIGGERS_OWN_ONLY", 403)); return null; }
  return rows[0];
}

router.patch("/behavior/triggers/:id", asyncHandler(async (req, res) => {
  const body = patchSchema.safeParse(req.body ?? {});
  if (!body.success) throw badRequest("VALIDATION", body.error.issues.map((i) => ({ path: `body.${i.path.join(".")}`, message: i.message })));
  const row = await loadWritableTrigger(req, res);
  if (!row) return;
  const b = body.data;
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, v: unknown, cast = "") => { params.push(v); sets.push(`${col} = $${params.length}${cast}`); };
  if (b.params !== undefined) {
    const lang = langOf(req);
    const v = validateTriggerParams(row.kind, b.params, lang);
    if (!v.ok) throw new AppError(v.code, 400, v.params);
    push("params", JSON.stringify(v.value), "::jsonb");
    // Автоназвание следует за параметрами, если его не переименовывали вручную (сгенерировано на любом языке).
    if (b.name === undefined && row.kind !== "custom" && isAutoTriggerName(row.kind, row.params ?? {}, row.name)) {
      push("name", describeTrigger(row.kind, v.value, lang));
    }
  }
  if (b.name !== undefined) push("name", b.name);
  if (b.note !== undefined) push("note", b.note || null);
  if (b.enabled !== undefined) push("enabled", b.enabled);
  if (!sets.length) throw badRequest("NO_FIELDS");
  params.push(row.id);
  const { rows } = await pool.query<TriggerRow>(
    `UPDATE behavior_triggers SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
    params,
  );
  res.json(shapeTrigger(rows[0]));
}));

/** Мягкое удаление: строка остаётся с deleted_at. */
router.delete("/behavior/triggers/:id", asyncHandler(async (req, res) => {
  const row = await loadWritableTrigger(req, res);
  if (!row) return;
  await pool.query(`UPDATE behavior_triggers SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`, [row.id]);
  logActivity({
    action: "deleted", section: "behavior", entityId: String(row.id), entityTitle: row.name, trader: req.authUser?.name,
    details: behaviorT.tFor("ru")("activity.triggerDeleted", { trader: row.trader }), params: { detailsKey: "behavior.activity.triggerDeleted", trader: row.trader },
  });
  res.json({ ok: true, id: Number(row.id) });
}));

export default router;
