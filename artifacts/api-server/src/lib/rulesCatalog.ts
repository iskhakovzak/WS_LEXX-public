/**
 * Каталог видов правил дисциплины (чистый модуль, без БД).
 *
 * - `auto: true`  — правило проверяется само по сделкам из бэк-офиса (время входа/выхода, размер, нетто P&L, исполнения).
 * - `auto: false` — самооценка: трейдер отмечает «соблюдал / нарушил» раз в день (чекбокс в журнале, таблица rule_self_checks).
 * - `needs`       — какие данные сделки нужны для проверки; если их нет ни у одной сделки периода, правило «не проверяемо»,
 *                   а не «100% соблюдено».
 * - Поля порога: number (положительное число), time (HHMM как число: 935 = 9:35 ET), tickers (список тикеров).
 *   Пустое необязательное поле с `riskLimit` берёт значение из лимитов риск-деска (trader_risk_limits).
 *
 * Первые 11 видов — исторический контракт (RULE_KINDS в lib/rulesEngine, тесты на порядок/типы); новые идут после.
 */

import { DEFAULT_LANG, formatCountFor, isLang, type Lang } from "../i18n";
import type { ErrorCode } from "./http";
import { rulesT } from "./rulesI18n";

export type RuleFieldType = "number" | "time" | "tickers";
export type RiskLimitKey = "daily_loss_limit" | "max_position_usd" | "max_risk_per_trade";
export type RuleNeed = "pnl" | "time" | "hold" | "size" | "qty" | "executions" | "stop" | "checklist";
export type RuleGroup = "volume" | "loss" | "time" | "size" | "process" | "self";

export interface CatalogField {
  key: string;
  label: string;
  type: RuleFieldType;
  /** number/time → число; tickers → [] */
  default: number | string[];
  optional?: boolean;
  riskLimit?: RiskLimitKey;
  unit?: string;
}

export interface RuleKindMeta {
  kind: string;
  label: string;
  hint: string;
  group: RuleGroup;
  auto: boolean;
  needs: RuleNeed[];
  fields: CatalogField[];
  /** Исторический вид (входит в RULE_KINDS). */
  legacy?: boolean;
}

/** Unit of a field: shown as is ("$", "%", "×") or translated ("min", "sec" → `units.*`). */
type UnitCode = "$" | "%" | "×" | "min" | "sec";
type RawField = Omit<CatalogField, "label" | "unit"> & { unit?: UnitCode };
type RawKind = Omit<RuleKindMeta, "label" | "hint" | "fields"> & { fields: RawField[] };

const n = (key: string, def: number, extra: Partial<RawField> = {}): RawField => ({ key, type: "number", default: def, ...extra });

/** Kinds without texts: labels, hints, field labels and units come from the `rules` namespace (kinds.<kind>.*). */
const RAW_CATALOG: RawKind[] = [
  // ── Исторические виды (порядок и типы полей зафиксированы тестами) ──────────────────────────────
  { kind: "max_trades_per_day", group: "volume", auto: true, needs: [], legacy: true, fields: [n("n", 5)] },
  { kind: "no_trade_after_n_losses", group: "loss", auto: true, needs: ["pnl"], legacy: true, fields: [n("n", 3)] },
  { kind: "max_daily_loss_usd", group: "loss", auto: true, needs: ["pnl"], legacy: true,
    fields: [n("usd", 500, { optional: true, riskLimit: "daily_loss_limit", unit: "$" })] },
  { kind: "max_loss_per_day_pct", group: "loss", auto: true, needs: ["pnl"], legacy: true,
    fields: [n("pct", 2, { unit: "%" }), n("capital", 50000, { unit: "$" })] },
  { kind: "max_position_usd", group: "size", auto: true, needs: ["size"], legacy: true,
    fields: [n("usd", 20000, { optional: true, riskLimit: "max_position_usd", unit: "$" })] },
  { kind: "position_size_pct", group: "size", auto: true, needs: ["size"], legacy: true,
    fields: [n("pct", 10, { unit: "%" }), n("capital", 50000, { unit: "$" })] },
  { kind: "max_risk_per_trade_usd", group: "loss", auto: true, needs: ["stop"], legacy: true,
    fields: [n("usd", 200, { optional: true, riskLimit: "max_risk_per_trade", unit: "$" })] },
  { kind: "max_consecutive_losses", group: "loss", auto: true, needs: ["pnl"], legacy: true, fields: [n("n", 4)] },
  { kind: "no_overnight", group: "process", auto: true, needs: [], legacy: true, fields: [] },
  { kind: "no_swing", group: "process", auto: true, needs: [], legacy: true, fields: [] },
  { kind: "trade_without_checklist", group: "process", auto: true, needs: ["checklist"], legacy: true, fields: [] },

  // ── Новые виды ────────────────────────────────────────────────────────────────────────────────────
  { kind: "max_trades_per_ticker_day", group: "volume", auto: true, needs: [], fields: [n("n", 2)] },
  { kind: "max_loss_per_trade_usd", group: "loss", auto: true, needs: ["pnl"],
    fields: [n("usd", 100, { optional: true, riskLimit: "max_risk_per_trade", unit: "$" })] },
  { kind: "min_pause_after_loss", group: "loss", auto: true, needs: ["pnl", "time"], fields: [n("min", 10, { unit: "min" })] },
  { kind: "no_size_up_after_loss", group: "loss", auto: true, needs: ["pnl", "size"], fields: [n("factor", 1.3, { unit: "×" })] },
  { kind: "no_trade_first_minutes", group: "time", auto: true, needs: ["time"], fields: [n("n", 5, { unit: "min" })] },
  { kind: "trading_window", group: "time", auto: true, needs: ["time"],
    fields: [{ key: "start", type: "time", default: 930 }, { key: "end", type: "time", default: 1555 }] },
  { kind: "min_hold_seconds", group: "time", auto: true, needs: ["hold"], fields: [n("sec", 30, { unit: "sec" })] },
  { kind: "max_position_shares", group: "size", auto: true, needs: ["qty"], fields: [n("qty", 500)] },
  { kind: "no_averaging_down", group: "size", auto: true, needs: ["executions"], fields: [] },
  { kind: "banned_tickers", group: "process", auto: true, needs: [], fields: [{ key: "tickers", type: "tickers", default: [] }] },
  { kind: "self_check", group: "self", auto: false, needs: [], fields: [] },
];

const RULE_GROUP_KEYS: readonly RuleGroup[] = ["volume", "loss", "time", "size", "process", "self"];

function buildCatalog(lang: Lang): RuleKindMeta[] {
  const tr = (key: string) => rulesT.tryFor(lang, key) ?? key;
  return RAW_CATALOG.map((k) => ({
    kind: k.kind,
    label: tr(`kinds.${k.kind}.label`),
    hint: tr(`kinds.${k.kind}.hint`),
    group: k.group,
    auto: k.auto,
    needs: k.needs,
    fields: k.fields.map(({ unit, ...f }) => ({
      key: f.key,
      label: tr(`kinds.${k.kind}.fields.${f.key}`),
      type: f.type,
      default: f.default,
      ...(f.optional ? { optional: true } : {}),
      ...(f.riskLimit ? { riskLimit: f.riskLimit } : {}),
      ...(unit ? { unit: unit === "min" || unit === "sec" ? tr(`units.${unit}`) : unit } : {}),
    })),
    ...(k.legacy ? { legacy: true } : {}),
  }));
}

const catalogs = new Map<Lang, RuleKindMeta[]>();
/** The catalog with texts in `lang` (cached per language). */
export function catalogFor(lang: Lang | null | undefined = DEFAULT_LANG): RuleKindMeta[] {
  const l: Lang = isLang(lang) ? lang : DEFAULT_LANG;
  let c = catalogs.get(l);
  if (!c) {
    c = buildCatalog(l);
    catalogs.set(l, c);
  }
  return c;
}

/** Group titles in `lang`. */
export function ruleGroupsFor(lang: Lang | null | undefined = DEFAULT_LANG): Record<RuleGroup, string> {
  const out = {} as Record<RuleGroup, string>;
  for (const g of RULE_GROUP_KEYS) out[g] = rulesT.tryFor(lang, `groups.${g}`) ?? g;
  return out;
}

/** Russian catalog (historical export; texts per language: catalogFor). */
export const RULE_CATALOG: RuleKindMeta[] = catalogFor(DEFAULT_LANG);
export const RULE_GROUPS: Record<RuleGroup, string> = ruleGroupsFor(DEFAULT_LANG);

export const CATALOG_BY_KIND = new Map(RULE_CATALOG.map((k) => [k.kind, k]));

/** Kind metadata; texts in `lang` (Russian by default). */
export function kindMeta(kind: string, lang?: Lang | null): RuleKindMeta | undefined {
  if (!lang || lang === DEFAULT_LANG) return CATALOG_BY_KIND.get(kind);
  return catalogFor(lang).find((k) => k.kind === kind);
}

/** HHMM-число → минуты от полуночи (935 → 575); null, если некорректно. */
export function hhmmToMinutes(v: unknown): number | null {
  const x = typeof v === "string" ? Number(v.replace(":", "")) : Number(v);
  if (!Number.isInteger(x) || x < 0 || x > 2359) return null;
  const h = Math.floor(x / 100);
  const m = x % 100;
  if (m > 59 || h > 23) return null;
  return h * 60 + m;
}

export function fmtHHMM(v: unknown): string {
  const m = hhmmToMinutes(v);
  if (m == null) return "—";
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/** Нормализует список тикеров (массив или строка через запятую/пробел): верхний регистр, уникальные, ≤ 50. */
export function normTickers(v: unknown): string[] | null {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,;]+/) : null;
  if (!raw) return null;
  const out: string[] = [];
  for (const x of raw) {
    const t = String(x ?? "").trim().toUpperCase().replace(/^\$/, "");
    if (!t) continue;
    if (!TICKER_RE.test(t)) return null;
    if (!out.includes(t)) out.push(t);
  }
  return out.length > 50 ? null : out;
}

export type ThresholdValue = number | string[];

export type ThresholdError = { ok: false; code: ErrorCode; params?: { field: string } };

/**
 * Проверка порога по полям вида. Обязательные пустые поля получают значение по умолчанию; необязательные пустые
 * пропускаются (действует лимит риск-деска). Ошибка — код API (errors namespace) и подпись поля на языке `lang`.
 */
export function validateThreshold(kind: string, threshold: unknown, lang: Lang = DEFAULT_LANG): { ok: true; value: Record<string, ThresholdValue> } | ThresholdError {
  const def = kindMeta(kind, lang);
  if (!def) return { ok: false, code: "RULE_KIND_INVALID" };
  if (threshold != null && (typeof threshold !== "object" || Array.isArray(threshold))) return { ok: false, code: "RULE_THRESHOLD_INVALID" };
  const src = (threshold ?? {}) as Record<string, unknown>;
  const out: Record<string, ThresholdValue> = {};
  for (const f of def.fields) {
    const raw = src[f.key];
    const empty = raw === undefined || raw === null || raw === "" || (typeof raw === "number" && Number.isNaN(raw)) || (Array.isArray(raw) && raw.length === 0);
    const field = { field: f.label };
    if (f.type === "tickers") {
      if (empty) return { ok: false, code: "RULE_TICKERS_REQUIRED", params: field };
      const list = normTickers(raw);
      if (!list || !list.length) return { ok: false, code: "RULE_TICKERS_INVALID", params: field };
      out[f.key] = list;
      continue;
    }
    if (empty) {
      if (f.optional) continue;
      out[f.key] = f.default as number;
      continue;
    }
    if (f.type === "time") {
      const m = hhmmToMinutes(raw);
      if (m == null) return { ok: false, code: "RULE_TIME_INVALID", params: field };
      out[f.key] = Math.floor(m / 60) * 100 + (m % 60);
      continue;
    }
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) return { ok: false, code: "RULE_NUMBER_INVALID", params: field };
    out[f.key] = v;
  }
  if (kind === "trading_window") {
    const s = hhmmToMinutes(out.start);
    const e = hhmmToMinutes(out.end);
    if (s != null && e != null && e <= s) return { ok: false, code: "RULE_WINDOW_ORDER" };
  }
  if (kind === "no_size_up_after_loss" && typeof out.factor === "number" && out.factor < 1) {
    return { ok: false, code: "RULE_FACTOR_MIN" };
  }
  return { ok: true, value: out };
}

const usdText = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

/** Короткое описание порога для списков: «≤ 5 сделок/день», «9:35–15:55 ET», «AAPL, TSLA» (на языке `lang`). */
export function describeThreshold(
  kind: string,
  threshold: Record<string, unknown> | null | undefined,
  limits?: { dailyLossLimit?: number | null; maxPositionUsd?: number | null; maxRiskPerTrade?: number | null },
  lang: Lang = DEFAULT_LANG,
): string {
  const t = threshold ?? {};
  const tr = rulesT.tFor(lang);
  const num = (k: string) => {
    const v = Number(t[k]);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const desk = (v: number | null | undefined) => (v != null ? tr("summary.deskValue", { usd: usdText(v) }) : tr("summary.deskUnset"));
  const money = (k: string, deskLimit: number | null | undefined) => (num(k) != null ? usdText(num(k)!) : desk(deskLimit));
  switch (kind) {
    case "max_trades_per_day": return tr("summary.max_trades_per_day", { n: num("n") ?? 5 });
    case "max_trades_per_ticker_day": return tr("summary.max_trades_per_ticker_day", { n: num("n") ?? 2 });
    case "no_trade_after_n_losses": return tr("summary.no_trade_after_n_losses", { n: num("n") ?? 3 });
    case "max_consecutive_losses": return tr("summary.max_consecutive_losses", { n: num("n") ?? 4 });
    case "max_daily_loss_usd": return tr("summary.dailyLoss", { value: money("usd", limits?.dailyLossLimit) });
    case "max_loss_per_day_pct": return tr("summary.dailyLossPct", { pct: num("pct") ?? 2, capital: usdText(num("capital") ?? 50000) });
    case "max_loss_per_trade_usd": return tr("summary.tradeLoss", { value: money("usd", limits?.maxRiskPerTrade) });
    case "max_risk_per_trade_usd": return tr("summary.risk", { value: money("usd", limits?.maxRiskPerTrade) });
    case "max_position_usd": return tr("summary.position", { value: money("usd", limits?.maxPositionUsd) });
    case "position_size_pct": return tr("summary.positionPct", { pct: num("pct") ?? 10, capital: usdText(num("capital") ?? 50000) });
    case "max_position_shares": return tr("summary.shares", { qty: formatCountFor(lang, num("qty") ?? 500) });
    case "min_pause_after_loss": return tr("summary.pause", { min: num("min") ?? 10 });
    case "no_size_up_after_loss": return tr("summary.sizeUp", { factor: num("factor") ?? 1.3 });
    case "no_trade_first_minutes": {
      const end = 570 + (num("n") ?? 5);
      return tr("summary.firstMinutes", { end: `${Math.floor(end / 60)}:${String(Math.round(end % 60)).padStart(2, "0")}` });
    }
    case "trading_window": return tr("summary.window", { start: fmtHHMM(t.start ?? 930), end: fmtHHMM(t.end ?? 1555) });
    case "min_hold_seconds": return tr("summary.hold", { sec: num("sec") ?? 30 });
    case "banned_tickers": {
      const list = Array.isArray(t.tickers) ? (t.tickers as unknown[]).map(String) : [];
      return list.length ? tr("summary.banned", { list: `${list.slice(0, 6).join(", ")}${list.length > 6 ? ` +${list.length - 6}` : ""}` }) : tr("summary.bannedEmpty");
    }
    case "no_overnight": return tr("summary.no_overnight");
    case "no_swing": return tr("summary.no_swing");
    case "no_averaging_down": return tr("summary.no_averaging_down");
    case "trade_without_checklist": return tr("summary.trade_without_checklist");
    case "self_check": return tr("summary.self_check");
    default: return "";
  }
}
