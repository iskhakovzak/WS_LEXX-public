import type { Grade, Horizon, Impact, MarketBias, MediaRef, PlanDoc, RiskMode, TickerBias } from "./types";
import { gpI18n } from "@/i18n/ns/gamePlan";

/**
 * Editor model for a plan (desk or personal). Levels and numbers stay strings while typing; `draftToDoc` parses
 * and validates them. Every list row has a stable `key` for React and for paste routing.
 */
export type TickerDraft = {
  key: string;
  ticker: string;
  catalyst: string;
  bias: TickerBias;
  grade: "none" | Grade;
  horizon: Horizon;
  support: string;
  resistance: string;
  scenarioA: string;
  scenarioB: string;
  trigger: string;
  invalidation: string;
  plan: string;
  risk_note: string;
  tvLink: string;
  media: MediaRef[];
};
export type MacroDraft = { key: string; time: string; title: string; impact: Impact };
export type PlanDraft = {
  marketView: string;
  bias: MarketBias;
  riskMode: RiskMode;
  spyS: string;
  spyR: string;
  spyNote: string;
  qqqS: string;
  qqqR: string;
  qqqNote: string;
  macro: MacroDraft[];
  inPlay: TickerDraft[];
  riskNotes: string;
  maxLoss: string;
  maxTrades: string;
  /** Rule of the day (MistakeId); undefined = never chosen, null = «no rule». Personal plans only. */
  ownRule?: string | null;
  focus: string;
  media: MediaRef[];
  tvLinks: string[];
};

export const MAX_TICKERS = 30;
export const MAX_PLAN_MEDIA = 12;
export const MAX_TICKER_MEDIA = 8;
export const MAX_PLAN_TV = 8;

let seq = 0;
export const newKey = () => `k${Date.now().toString(36)}${(seq++).toString(36)}`;

const join = (a?: number[] | null) => (a ?? []).join(" ");
const s = (v: unknown) => (typeof v === "string" ? v : "");
const refs = (v: unknown): MediaRef[] =>
  Array.isArray(v)
    ? v
        .filter((m) => m && Number.isInteger((m as MediaRef).id))
        .map((m) => ({ id: (m as MediaRef).id, caption: s((m as MediaRef).caption) }))
    : [];

export function emptyTicker(partial: Partial<TickerDraft> = {}): TickerDraft {
  return {
    key: newKey(),
    ticker: "",
    catalyst: "",
    bias: "neutral",
    grade: "none",
    horizon: "intraday",
    support: "",
    resistance: "",
    scenarioA: "",
    scenarioB: "",
    trigger: "",
    invalidation: "",
    plan: "",
    risk_note: "",
    tvLink: "",
    media: [],
    ...partial,
  };
}

export function docToDraft(doc: Partial<PlanDoc> | null | undefined): PlanDraft {
  const d = doc ?? {};
  return {
    marketView: s(d.marketView),
    bias: d.bias ?? "neutral",
    riskMode: d.riskMode ?? "normal",
    spyS: join(d.keyLevels?.SPY?.support),
    spyR: join(d.keyLevels?.SPY?.resistance),
    spyNote: s(d.keyLevels?.SPY?.note),
    qqqS: join(d.keyLevels?.QQQ?.support),
    qqqR: join(d.keyLevels?.QQQ?.resistance),
    qqqNote: s(d.keyLevels?.QQQ?.note),
    macro: (d.macro ?? []).map((m) => ({ key: newKey(), time: s(m.time), title: s(m.title), impact: m.impact ?? "medium" })),
    inPlay: (d.inPlay ?? []).map((i) =>
      emptyTicker({
        ticker: s(i.ticker),
        catalyst: s(i.catalyst),
        bias: i.bias ?? "neutral",
        grade: i.grade ?? "none",
        horizon: i.horizon ?? "intraday",
        support: join(i.levels?.support),
        resistance: join(i.levels?.resistance),
        scenarioA: s(i.scenarioA),
        scenarioB: s(i.scenarioB),
        trigger: s(i.trigger),
        invalidation: s(i.invalidation),
        plan: s(i.plan),
        risk_note: s(i.risk_note),
        tvLink: s(i.tvLink),
        media: refs(i.media),
      }),
    ),
    riskNotes: s(d.riskNotes),
    maxLoss: d.maxLossUsd != null ? String(d.maxLossUsd) : "",
    maxTrades: d.maxTrades != null ? String(d.maxTrades) : "",
    ownRule: typeof d.ownRule === "string" && d.ownRule ? d.ownRule : d.ownRule === null ? null : undefined,
    focus: s(d.focus),
    media: refs(d.media),
    tvLinks: Array.isArray(d.tvLinks) ? d.tvLinks.filter((u): u is string => typeof u === "string") : [],
  };
}

export function parseLevels(str: string): number[] {
  return str
    .replace(/,\s+/g, " ")
    .split(/[\s;/|]+/)
    .filter(Boolean)
    .map((t) => Number(t.replace(",", ".")));
}
function levelError(str: string): string | null {
  const l = parseLevels(str);
  if (l.some((n) => !Number.isFinite(n) || n < 0 || n >= 1e7)) return gpI18n.t("validation.levels");
  if (l.length > 12) return gpI18n.t("validation.levelsMax");
  return null;
}
function num(str: string): number | null {
  const t = str.trim().replace(/\s/g, "").replace(",", ".").replace(/^\$/, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

const TICKER_RE = /^[A-Za-z0-9.\-^=/]+$/;
const TIME_RE = /^$|^([01]\d|2[0-3]):[0-5]\d$/;

/** Field errors keyed by path: "maxLoss", "spyS", "inPlay.<key>.ticker", "macro.<key>.title", … */
export type DraftErrors = Record<string, string>;

export function validateDraft(d: PlanDraft): DraftErrors {
  const e: DraftErrors = {};
  for (const k of ["spyS", "spyR", "qqqS", "qqqR"] as const) {
    const err = levelError(d[k]);
    if (err) e[k] = err;
  }
  const ml = num(d.maxLoss);
  if (ml !== null && (Number.isNaN(ml) || ml < 0 || ml >= 1e7)) e.maxLoss = gpI18n.t("validation.maxLoss");
  const mt = num(d.maxTrades);
  if (mt !== null && (Number.isNaN(mt) || !Number.isInteger(mt) || mt < 0 || mt > 500)) e.maxTrades = gpI18n.t("validation.maxTrades");
  const seen = new Set<string>();
  for (const t of d.inPlay) {
    const tk = t.ticker.trim().toUpperCase();
    if (!tk) e[`inPlay.${t.key}.ticker`] = gpI18n.t("validation.tickerRequired");
    else if (tk.length > 12 || !TICKER_RE.test(tk)) e[`inPlay.${t.key}.ticker`] = gpI18n.t("validation.tickerFormat");
    else if (seen.has(tk)) e[`inPlay.${t.key}.ticker`] = gpI18n.t("validation.tickerDup");
    seen.add(tk);
    for (const k of ["support", "resistance"] as const) {
      const err = levelError(t[k]);
      if (err) e[`inPlay.${t.key}.${k}`] = err;
    }
  }
  for (const m of d.macro) {
    if (!m.title.trim()) e[`macro.${m.key}.title`] = gpI18n.t("validation.titleRequired");
    if (!TIME_RE.test(m.time.trim())) e[`macro.${m.key}.time`] = gpI18n.t("validation.time");
  }
  return e;
}

/** Draft → API document. Call only when `validateDraft` is empty (numbers are coerced defensively anyway). */
export function draftToDoc(d: PlanDraft): PlanDoc {
  const ml = num(d.maxLoss);
  const mt = num(d.maxTrades);
  const lv = (str: string) => parseLevels(str).filter((n) => Number.isFinite(n) && n >= 0);
  return {
    marketView: d.marketView.trim(),
    bias: d.bias,
    riskMode: d.riskMode,
    keyLevels: {
      SPY: { support: lv(d.spyS), resistance: lv(d.spyR), note: d.spyNote.trim() },
      QQQ: { support: lv(d.qqqS), resistance: lv(d.qqqR), note: d.qqqNote.trim() },
    },
    inPlay: d.inPlay.map((i) => ({
      ticker: i.ticker.trim().toUpperCase(),
      catalyst: i.catalyst.trim(),
      bias: i.bias,
      grade: i.grade === "none" ? null : i.grade,
      horizon: i.horizon,
      levels: { support: lv(i.support), resistance: lv(i.resistance) },
      plan: i.plan.trim(),
      risk_note: i.risk_note.trim(),
      scenarioA: i.scenarioA.trim(),
      scenarioB: i.scenarioB.trim(),
      trigger: i.trigger.trim(),
      invalidation: i.invalidation.trim(),
      tvLink: i.tvLink.trim(),
      media: i.media,
    })),
    macro: d.macro.filter((m) => m.title.trim()).map((m) => ({ time: m.time.trim(), title: m.title.trim(), impact: m.impact })),
    riskNotes: d.riskNotes.trim(),
    focus: d.focus.trim(),
    maxLossUsd: ml === null || Number.isNaN(ml) ? null : ml,
    maxTrades: mt === null || Number.isNaN(mt) ? null : Math.trunc(mt),
    media: d.media,
    tvLinks: d.tvLinks,
    ...(d.ownRule !== undefined ? { ownRule: d.ownRule } : {}),
  };
}

/** Same content? (used to skip autosaves and to detect unsaved changes) */
export function sameDoc(a: PlanDraft, b: PlanDraft): boolean {
  return JSON.stringify(draftToDoc(a)) === JSON.stringify(draftToDoc(b));
}

/** The rule of the day alone (usually the focus prefill) does not make a plan worth a row. */
export function isDraftEmpty(d: PlanDraft): boolean {
  const doc = draftToDoc(d);
  return (
    !doc.marketView &&
    !doc.focus &&
    !doc.riskNotes &&
    doc.inPlay.length === 0 &&
    doc.macro.length === 0 &&
    doc.media.length === 0 &&
    doc.tvLinks.length === 0 &&
    doc.maxLossUsd == null &&
    doc.maxTrades == null &&
    !d.spyS && !d.spyR && !d.qqqS && !d.qqqR
  );
}

/** Completion of the four quick blocks (for the block nav dots). */
export function blockDone(d: PlanDraft) {
  return {
    market: !!(d.marketView.trim() || d.macro.length || d.media.length || d.tvLinks.length || d.spyS || d.spyR || d.qqqS || d.qqqR),
    tickers: d.inPlay.some((t) => t.ticker.trim() && (t.scenarioA.trim() || t.trigger.trim() || t.plan.trim() || t.support || t.resistance)),
    risk: !!(d.riskNotes.trim() || d.maxLoss.trim() || d.maxTrades.trim() || d.ownRule),
    focus: !!d.focus.trim(),
  };
}

/**
 * Apply a template: fills text blocks that are still empty and adds template tickers that aren't in the plan.
 * Never removes what the user already wrote or attached.
 */
export function applyTemplate(cur: PlanDraft, tpl: Partial<PlanDoc>): PlanDraft {
  const t = docToDraft(tpl);
  const pick = (a: string, b: string) => (a.trim() ? a : b);
  const have = new Set(cur.inPlay.map((i) => i.ticker.trim().toUpperCase()));
  return {
    ...cur,
    marketView: pick(cur.marketView, t.marketView),
    bias: tpl.bias ?? cur.bias,
    riskMode: tpl.riskMode ?? cur.riskMode,
    riskNotes: pick(cur.riskNotes, t.riskNotes),
    focus: pick(cur.focus, t.focus),
    maxLoss: pick(cur.maxLoss, t.maxLoss),
    maxTrades: pick(cur.maxTrades, t.maxTrades),
    macro: cur.macro.length ? cur.macro : t.macro,
    inPlay: [...cur.inPlay, ...t.inPlay.filter((i) => !i.ticker || !have.has(i.ticker.toUpperCase())).map((i) => ({ ...i, media: [] }))].slice(0, MAX_TICKERS),
  };
}

export type BuiltinTemplate = { id: string; name: string; hint: string; doc: Partial<PlanDoc> };

type BuiltinId = "standard" | "earnings" | "macro" | "chop";
/** A built-in template whose texts follow the UI language (read when the template is shown / applied). */
function builtin(id: BuiltinId, extra: Partial<PlanDoc> = {}): BuiltinTemplate {
  return {
    id,
    get name() { return gpI18n.t(`templates.${id}.name`); },
    get hint() { return gpI18n.t(`templates.${id}.hint`); },
    get doc() {
      return {
        ...extra,
        marketView: gpI18n.t(`templates.${id}.marketView`),
        riskNotes: gpI18n.t(`templates.${id}.riskNotes`),
        focus: gpI18n.t(`templates.${id}.focus`),
      };
    },
  };
}

/** Ready-made skeletons — the prompts are what a desk head asks in the morning meeting. */
export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  builtin("standard"),
  builtin("earnings"),
  builtin("macro", { riskMode: "reduced" }),
  builtin("chop", { riskMode: "reduced", bias: "neutral" }),
];
