/**
 * «Мои триггеры» — личные пороги поведения, которые трейдер задаёт сам («3 убытка подряд», «сделка < 2 мин после
 * убытка»…). Чистые функции без I/O: описание видов, валидация параметров и проверка по истории сделок.
 *
 * Проверка ретроспективная (real-time push не нужен): для каждого триггера — сколько раз сработал, в какие дни,
 * какие сделки «под триггером» (их стоило пропустить) и их Σ нетто. Если Σ нетто отрицательна — соблюдение
 * триггера сэкономило бы эти деньги. Деньги — нетто, торговая дата — NY (как в behaviorEngine).
 */
import type { BehaviorTrade } from "./behaviorEngine";
import { behaviorT } from "./behaviorI18n";
import { DEFAULT_LANG, isLang, type Lang } from "../i18n";
import type { ErrorCode } from "./http";

export type TriggerKind =
  | "loss_streak" | "quick_after_loss" | "max_trades_day" | "daily_loss" | "size_up_after_loss"
  | "after_big_win" | "long_loser_hold" | "red_morning" | "custom";

export type TriggerField = { key: string; label: string; default: number; min: number; max: number; step?: number; unit?: string };

type TriggerKindDef = { kind: TriggerKind; label: string; hint: string; fields: TriggerField[] };
type RawField = Omit<TriggerField, "label" | "unit"> & { unit?: "$" | "×" | "min" };

/** Kinds without texts: labels, hints and field labels come from `behavior.triggers.kinds.*`. */
const RAW_KINDS: { kind: TriggerKind; fields: RawField[] }[] = [
  { kind: "loss_streak", fields: [{ key: "n", default: 3, min: 2, max: 10 }] },
  { kind: "quick_after_loss", fields: [{ key: "minutes", default: 2, min: 1, max: 120, unit: "min" }] },
  { kind: "max_trades_day", fields: [{ key: "n", default: 8, min: 1, max: 100 }] },
  { kind: "daily_loss", fields: [{ key: "usd", default: 300, min: 1, max: 1_000_000, unit: "$" }] },
  { kind: "size_up_after_loss", fields: [{ key: "ratio", default: 1.3, min: 1.05, max: 10, step: 0.05, unit: "×" }] },
  { kind: "after_big_win", fields: [{ key: "usd", default: 100, min: 1, max: 1_000_000, unit: "$" }, { key: "minutes", default: 15, min: 1, max: 240, unit: "min" }] },
  { kind: "long_loser_hold", fields: [{ key: "minutes", default: 20, min: 1, max: 1440, unit: "min" }] },
  { kind: "red_morning", fields: [{ key: "usd", default: 150, min: 1, max: 1_000_000, unit: "$" }] },
  { kind: "custom", fields: [] },
];

const kindsCache = new Map<Lang, TriggerKindDef[]>();
/** Trigger kinds with texts in `lang` (GET /behavior/triggers → kinds). */
export function triggerKindsFor(lang: Lang | null | undefined = DEFAULT_LANG): TriggerKindDef[] {
  const l: Lang = isLang(lang) ? lang : DEFAULT_LANG;
  const hit = kindsCache.get(l);
  if (hit) return hit;
  const tr = (key: string) => behaviorT.tryFor(l, key) ?? key;
  const out = RAW_KINDS.map((k) => ({
    kind: k.kind,
    label: tr(`triggers.kinds.${k.kind}.label`),
    hint: tr(`triggers.kinds.${k.kind}.hint`),
    fields: k.fields.map(({ unit, ...f }) => ({
      ...f,
      label: tr(`triggers.kinds.${k.kind}.fields.${f.key}`),
      ...(unit ? { unit: unit === "min" ? tr("triggers.unitMin") : unit } : {}),
    })),
  }));
  kindsCache.set(l, out);
  return out;
}

/** Russian kinds (historical export). */
export const TRIGGER_KINDS: TriggerKindDef[] = triggerKindsFor(DEFAULT_LANG);

export const TRIGGER_KIND_SET = new Set<string>(TRIGGER_KINDS.map((k) => k.kind));

/**
 * Параметры по описанию вида: недостающие — по умолчанию, вне диапазона — ошибка (код API + подпись поля в `lang`).
 */
export function validateTriggerParams(kind: string, raw: unknown, lang: Lang = DEFAULT_LANG):
  { ok: true; value: Record<string, number> } | { ok: false; code: ErrorCode; params?: { field: string; min: number; max: number } } {
  const def = triggerKindsFor(lang).find((k) => k.kind === kind);
  if (!def) return { ok: false, code: "TRIGGER_KIND_INVALID" };
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, number> = {};
  for (const f of def.fields) {
    const v = src[f.key];
    if (v === undefined || v === null || v === "") { out[f.key] = f.default; continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < f.min || n > f.max) return { ok: false, code: "TRIGGER_PARAM_RANGE", params: { field: f.label, min: f.min, max: f.max } };
    out[f.key] = Math.round(n * 100) / 100;
  }
  return { ok: true, value: out };
}

/** Человекочитаемое название триггера по параметрам («3 убытка подряд») на языке `lang`. */
export function describeTrigger(kind: string, p: Record<string, number>, lang: Lang = DEFAULT_LANG): string {
  const t = behaviorT.tFor(lang);
  switch (kind) {
    case "loss_streak": return t("triggers.names.loss_streak", { count: p.n });
    case "quick_after_loss": return t("triggers.names.quick_after_loss", { minutes: p.minutes });
    case "max_trades_day": return t("triggers.names.max_trades_day", { count: p.n });
    case "daily_loss": return t("triggers.names.daily_loss", { usd: p.usd });
    case "size_up_after_loss": return t("triggers.names.size_up_after_loss", { ratio: p.ratio });
    case "after_big_win": return t("triggers.names.after_big_win", { minutes: p.minutes, usd: p.usd });
    case "long_loser_hold": return t("triggers.names.long_loser_hold", { minutes: p.minutes });
    case "red_morning": return t("triggers.names.red_morning", { usd: p.usd });
    default: return t("triggers.names.custom");
  }
}

/** Was `name` generated by describeTrigger (in any language)? Then it follows the params when they change. */
export function isAutoTriggerName(kind: string, p: Record<string, number>, name: string): boolean {
  return (["ru", "en", "uz"] as const).some((l) => describeTrigger(kind, p, l) === name);
}

export type TriggerHit = { id: number; ticker: string; date: string; net: number | null; note: string };

export type TriggerEval = {
  /** Сколько раз сработал (по сделкам или по дням — зависит от вида). */
  fires: number;
  days: number;
  /** Сделки «под триггером». */
  trades: number;
  /** Σ нетто сделок под триггером (отрицательная = соблюдение сэкономило бы). */
  net: number | null;
  tradeIds: number[];
  firstDate: string | null;
  lastDate: string | null;
  /** Последние даты срабатывания (до 30) — для полоски на карточке. */
  recentDates: string[];
  examples: TriggerHit[];
  evaluable: boolean;
};

const fmtUsd = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}$${Math.abs(v).toFixed(0)}`);
const notional = (t: BehaviorTrade) => (t.qty == null ? null : t.entry != null && t.entry > 0 ? Math.abs(t.qty) * t.entry : Math.abs(t.qty));

/** Проверка одного триггера по сделкам, сгруппированным по дням в порядке входа (behaviorEngine.groupByDay). */
export function evaluateTrigger(kind: string, p: Record<string, number>, byDay: Map<string, BehaviorTrade[]>, lang: Lang = DEFAULT_LANG): TriggerEval {
  const tr = behaviorT.tFor(lang);
  const hits: { t: BehaviorTrade; note: string }[] = [];
  const fireDays = new Set<string>();
  let fires = 0;
  const evaluable = kind !== "custom" && TRIGGER_KIND_SET.has(kind);

  if (evaluable) {
    for (const [date, day] of byDay) {
      switch (kind) {
        case "loss_streak": {
          let streak = 0;
          for (let i = 0; i < day.length; i++) {
            const t = day[i];
            if (t.result === "loss") streak++; else if (t.result === "win" || t.result === "be") streak = 0;
            if (streak >= p.n) {
              fires++; fireDays.add(date);
              for (const a of day.slice(i + 1)) hits.push({ t: a, note: tr("triggers.notes.lossStreak", { n: p.n, ticker: t.ticker }) });
              break;
            }
          }
          break;
        }
        case "quick_after_loss": {
          for (let i = 1; i < day.length; i++) {
            const prev = day[i - 1], t = day[i];
            if (prev.result !== "loss" || prev.exitAt == null || t.entryAt == null) continue;
            const gap = (t.entryAt - prev.exitAt) / 60000;
            if (gap >= 0 && gap < p.minutes) {
              fires++; fireDays.add(date);
              hits.push({ t, note: tr("triggers.notes.quickAfterLoss", { gap: gap < 1 ? "<1" : Math.round(gap), ticker: prev.ticker, net: fmtUsd(prev.net) }) });
            }
          }
          break;
        }
        case "max_trades_day": {
          if (day.length > p.n) {
            fires++; fireDays.add(date);
            day.slice(p.n).forEach((t, i) => hits.push({ t, note: tr("triggers.notes.maxTrades", { no: p.n + i + 1, total: day.length }) }));
          }
          break;
        }
        case "daily_loss": {
          let cum = 0;
          for (let i = 0; i < day.length; i++) {
            cum += day[i].net ?? 0;
            if (cum <= -p.usd) {
              fires++; fireDays.add(date);
              for (const a of day.slice(i + 1)) hits.push({ t: a, note: tr("triggers.notes.dailyLoss", { net: fmtUsd(Math.round(cum)) }) });
              break;
            }
          }
          break;
        }
        case "size_up_after_loss": {
          for (let i = 1; i < day.length; i++) {
            const prev = day[i - 1], t = day[i];
            if (prev.result !== "loss") continue;
            const n0 = notional(prev), n1 = notional(t);
            if (n0 && n1 && n1 / n0 >= p.ratio) {
              fires++; fireDays.add(date);
              hits.push({ t, note: tr("triggers.notes.sizeUp", { ratio: (n1 / n0).toFixed(1), ticker: prev.ticker }) });
            }
          }
          break;
        }
        case "after_big_win": {
          let lastBig: BehaviorTrade | null = null;
          for (const t of day) {
            if (lastBig?.exitAt != null && t.entryAt != null) {
              const gap = (t.entryAt - lastBig.exitAt) / 60000;
              if (gap >= 0 && gap < p.minutes) {
                fires++; fireDays.add(date);
                hits.push({ t, note: tr("triggers.notes.afterBigWin", { gap: gap < 1 ? "<1" : Math.round(gap), ticker: lastBig.ticker, net: fmtUsd(lastBig.net) }) });
              }
            }
            if (t.result === "win" && (t.net ?? 0) >= p.usd) lastBig = t;
          }
          break;
        }
        case "long_loser_hold": {
          for (const t of day) {
            if (t.result === "loss" && t.holdMin != null && t.holdMin > p.minutes) {
              fires++; fireDays.add(date);
              hits.push({ t, note: tr("triggers.notes.longHold", { n: Math.round(t.holdMin) }) });
            }
          }
          break;
        }
        case "red_morning": {
          let morning = 0, any = false;
          for (const t of day) if (t.entryMin != null && t.entryMin < 660) { morning += t.net ?? 0; any = true; }
          if (any && morning <= -p.usd) {
            const later = day.filter((t) => t.entryMin != null && t.entryMin >= 660);
            fires++; fireDays.add(date);
            for (const t of later) hits.push({ t, note: tr("triggers.notes.redMorning", { net: fmtUsd(Math.round(morning)) }) });
          }
          break;
        }
      }
    }
  }

  let sum = 0, withPnl = 0;
  for (const h of hits) if (h.t.net != null) { sum += h.t.net; withPnl++; }
  const dates = [...fireDays].sort();
  return {
    fires,
    days: fireDays.size,
    trades: hits.length,
    net: withPnl ? Math.round(sum * 100) / 100 : null,
    tradeIds: hits.map((h) => h.t.id).slice(0, 300),
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    recentDates: dates.slice(-30),
    examples: [...hits].sort((a, b) => (a.t.net ?? 0) - (b.t.net ?? 0)).slice(0, 5)
      .map((h) => ({ id: h.t.id, ticker: h.t.ticker, date: h.t.date, net: h.t.net, note: h.note })),
    evaluable,
  };
}
