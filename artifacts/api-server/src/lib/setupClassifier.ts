/**
 * Авто-классификатор сетапов — чистые функции без I/O. Детерминированные правила, никаких LLM.
 *
 * На вход: сделка (время/цена входа, сторона, удержание) + рыночный контекст дня (свечи через
 * routes/candles.ts — подаёт routes/setups-auto.ts; офлайн-проверка подаёт JSON из GET /api/candles).
 * На выход: предложенный сетап, уверенность 0…1, читаемое объяснение (какие признаки сработали),
 * альтернативы и набор признаков. Если свечей нет — классификация только по времени и удержанию с пометкой.
 *
 * Признаки: время суток (open drive 9:30–9:45, утро, полдень, power hour, пре/афтер), гэп дня к prevClose,
 * RVOL (объём дня / средний за ≤20 дней), позиция входа относительно VWAP / HOD / LOD / PMH / PML / ORB 5–15,
 * движение до входа (от открытия и за последние 30 минут), класс удержания (скальп < 2 мин, интрадей, овернайт, свинг).
 */

import { DEFAULT_LANG, type Lang, type Params } from "../i18n";
import { ruSetups, setupsT } from "./setupsI18n";

export const CLASSIFIER_VERSION = "1.0";

export type ClassifierCandle = { t: number; o: number; h: number; l: number; c: number; v: number };

export type ClassifierTrade = {
  id: number;
  ticker: string;
  date: string;
  side: "long" | "short" | null;
  entry: number | null;
  exit: number | null;
  qty: number | null;
  /** Минуты от полуночи NY для входа (9:30 → 570). */
  entryMin: number | null;
  holdMin: number | null;
  horizon: "intraday" | "overnight" | "swing";
  /** Для хэша входов (чтобы пересчитать при правке сделки). */
  entryAt: number | null;
  exitAt: number | null;
};

export type MarketInputs = {
  /** Внутридневные свечи торгового дня (желательно с премаркетом, extended=1). */
  candles: ClassifierCandle[] | null;
  /** Интервал свечей: "1m" | "5m" | "15m" | "30m" | "60m" | "1d". */
  interval: string | null;
  /** Закрытие предыдущего дня. */
  prevClose: number | null;
  /** Дневные свечи за ~20–35 дней до даты сделки включительно (для RVOL). */
  daily: ClassifierCandle[] | null;
};

export type TodBucket = "premarket" | "openDrive" | "morning" | "midday" | "afternoon" | "powerHour" | "close" | "after" | "unknown";
export type HoldClass = "scalp" | "intraday" | "overnight" | "swing" | "unknown";

export type SetupFeatures = {
  tod: TodBucket;
  holdClass: HoldClass;
  candlesAvailable: boolean;
  interval: string | null;
  barsBeforeEntry: number;
  open: number | null;
  prevClose: number | null;
  gapPct: number | null;
  rvol: number | null;
  vwap: number | null;
  hodBefore: number | null;
  lodBefore: number | null;
  pmHigh: number | null;
  pmLow: number | null;
  orb5High: number | null;
  orb5Low: number | null;
  orb15High: number | null;
  orb15Low: number | null;
  moveFromOpenPct: number | null;
  last30Pct: number | null;
  distVwapPct: number | null;
  distHodPct: number | null;
  distLodPct: number | null;
  distPmhPct: number | null;
  distPmlPct: number | null;
};

export type SetupSuggestion = {
  /** Canonical setup name (stored in trades.setup on accept; never translated). */
  setup: string;
  /** Display name of the setup in the requested language. */
  setupLabel: string;
  confidence: number;
  reasons: string[];
  alternatives: { setup: string; label: string; score: number }[];
  tags: string[];
  features: SetupFeatures;
  candlesAvailable: boolean;
  /** Пометка: без свечей (только время и удержание) или грубые бары (60m). */
  note: string | null;
  version: string;
};

/** Setup classes as codes; their canonical names (RU, `setups.classes`) are what gets stored. */
export const SETUP_CODES = [
  "orb", "openMomentum", "hod", "lod", "pmh", "pml",
  "gapFade", "gapGo", "vwapReversion", "vwapBounce", "shortHigh", "longLow",
  "powerHour", "close", "midday", "morning", "premarket", "after", "scalp", "overnight", "swing", "noTime",
] as const satisfies readonly (keyof typeof ruSetups.classes)[];
export type SetupCode = (typeof SETUP_CODES)[number];
const SETUP_NAME: Record<SetupCode, string> = Object.fromEntries(SETUP_CODES.map((c) => [c, ruSetups.classes[c]])) as Record<SetupCode, string>;
/** Canonical setup names (historical export; the values written to trades.setup). */
export const SETUP_CLASSES: readonly string[] = SETUP_CODES.map((c) => SETUP_NAME[c]);
export type SetupClass = string;
const CODE_BY_NAME = new Map<string, SetupCode>(SETUP_CODES.map((c) => [SETUP_NAME[c], c]));

/** Display label of a setup name in `lang`: a classifier class gets its translation, anything else (user setups) as is. */
export function setupLabelOf(name: string, lang: Lang = DEFAULT_LANG): string {
  const code = CODE_BY_NAME.get(name);
  return code ? setupsT.tryFor(lang, `classes.${code}`) ?? name : name;
}

/* ─── Время ET для свечей ─────────────────────────────────────────────────── */

const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});

function etParts(tSec: number): { date: string; min: number } {
  const parts = ET_FMT.formatToParts(new Date(tSec * 1000));
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, min: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
}

const INTERVAL_MIN: Record<string, number> = { "1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60, "1d": 1440 };

export function todBucket(entryMin: number | null): TodBucket {
  if (entryMin == null) return "unknown";
  if (entryMin < 570) return "premarket";
  if (entryMin < 585) return "openDrive";
  if (entryMin < 690) return "morning";
  if (entryMin < 840) return "midday";
  if (entryMin < 900) return "afternoon";
  if (entryMin < 945) return "powerHour";
  if (entryMin < 960) return "close";
  return "after";
}

export function holdClassOf(t: ClassifierTrade): HoldClass {
  if (t.horizon === "swing") return "swing";
  if (t.horizon === "overnight") return "overnight";
  if (t.holdMin == null) return "unknown";
  return t.holdMin < 2 ? "scalp" : "intraday";
}

const pct = (a: number | null, ref: number | null): number | null =>
  a == null || ref == null || ref === 0 ? null : ((a - ref) / ref) * 100;
const r2 = (v: number | null): number | null => (v == null ? null : Math.round(v * 100) / 100);
const r4 = (v: number | null): number | null => (v == null ? null : Math.round(v * 10000) / 10000);

/* ─── Признаки ─────────────────────────────────────────────────────────────── */

export function computeFeatures(trade: ClassifierTrade, market: MarketInputs): SetupFeatures {
  const f: SetupFeatures = {
    tod: todBucket(trade.entryMin), holdClass: holdClassOf(trade),
    candlesAvailable: false, interval: market.interval, barsBeforeEntry: 0,
    open: null, prevClose: market.prevClose ?? null, gapPct: null, rvol: null, vwap: null,
    hodBefore: null, lodBefore: null, pmHigh: null, pmLow: null,
    orb5High: null, orb5Low: null, orb15High: null, orb15Low: null,
    moveFromOpenPct: null, last30Pct: null,
    distVwapPct: null, distHodPct: null, distLodPct: null, distPmhPct: null, distPmlPct: null,
  };

  // RVOL и prevClose из дневных баров.
  if (market.daily && market.daily.length) {
    const days = market.daily.map((c) => ({ ...c, date: etParts(c.t).date })).sort((a, b) => a.t - b.t);
    const todayBar = days.find((d) => d.date === trade.date);
    const prior = days.filter((d) => d.date < trade.date).slice(-20);
    if (f.prevClose == null && prior.length) f.prevClose = prior[prior.length - 1].c;
    if (todayBar && prior.length >= 3) {
      const avg = prior.reduce((s, d) => s + d.v, 0) / prior.length;
      if (avg > 0) f.rvol = r2(todayBar.v / avg);
    }
  }

  const stepMin = market.interval ? INTERVAL_MIN[market.interval] ?? null : null;
  const intraday = market.candles && stepMin != null && stepMin < 1440 ? market.candles : null;
  if (intraday && intraday.length) {
    const bars = intraday
      .map((c) => ({ c, ...etParts(c.t) }))
      .filter((b) => b.date === trade.date)
      .sort((a, b) => a.c.t - b.c.t);
    if (bars.length) {
      f.candlesAvailable = true;
      const entryMin = trade.entryMin;
      let sumPV = 0, sumV = 0;
      for (const b of bars) {
        const m = b.min;
        if (m >= 240 && m < 570) {
          f.pmHigh = f.pmHigh == null ? b.c.h : Math.max(f.pmHigh, b.c.h);
          f.pmLow = f.pmLow == null ? b.c.l : Math.min(f.pmLow, b.c.l);
          continue;
        }
        if (m < 570 || m >= 960) continue;
        if (f.open == null) f.open = b.c.o;
        if (entryMin == null) continue;
        const completed = m + (stepMin ?? 1) <= entryMin;
        if (!completed && m >= entryMin) continue; // бар после входа
        // ORB: только достаточно мелкие бары.
        if (stepMin != null && stepMin <= 5 && m < 575 && completed) {
          f.orb5High = f.orb5High == null ? b.c.h : Math.max(f.orb5High, b.c.h);
          f.orb5Low = f.orb5Low == null ? b.c.l : Math.min(f.orb5Low, b.c.l);
        }
        if (stepMin != null && stepMin <= 15 && m < 585 && completed) {
          f.orb15High = f.orb15High == null ? b.c.h : Math.max(f.orb15High, b.c.h);
          f.orb15Low = f.orb15Low == null ? b.c.l : Math.min(f.orb15Low, b.c.l);
        }
        // VWAP включает частичный бар входа; HOD/LOD — только завершённые бары до входа.
        const typ = (b.c.h + b.c.l + b.c.c) / 3;
        sumPV += typ * b.c.v; sumV += b.c.v;
        if (completed) {
          f.barsBeforeEntry++;
          f.hodBefore = f.hodBefore == null ? b.c.h : Math.max(f.hodBefore, b.c.h);
          f.lodBefore = f.lodBefore == null ? b.c.l : Math.min(f.lodBefore, b.c.l);
        }
      }
      if (sumV > 0) f.vwap = r4(sumPV / sumV);
      // ORB не считается, если вход был раньше конца окна.
      if (entryMin == null || entryMin < 575) { f.orb5High = null; f.orb5Low = null; }
      if (entryMin == null || entryMin < 585) { f.orb15High = null; f.orb15Low = null; }
      // Движение за последние 30 минут до входа: закрытие бара ≈ −30 мин vs последнее закрытие до входа.
      if (entryMin != null) {
        const before = bars.filter((b) => b.min >= 570 && b.min < 960 && b.min + (stepMin ?? 1) <= entryMin);
        if (before.length >= 2) {
          const last = before[before.length - 1];
          const ref = [...before].reverse().find((b) => b.min <= entryMin - 30) ?? before[0];
          if (ref !== last) f.last30Pct = r2(pct(last.c.c, ref.c.c));
        }
      }
    }
  }

  // Для премаркет-входов открытия ещё нет — гэп считаем по цене входа к prevClose (без заглядывания вперёд).
  f.gapPct = trade.entryMin != null && trade.entryMin < 570 ? r2(pct(trade.entry, f.prevClose)) : r2(pct(f.open, f.prevClose));
  f.moveFromOpenPct = r2(pct(trade.entry, f.open));
  f.distVwapPct = r2(pct(trade.entry, f.vwap));
  f.distHodPct = r2(pct(trade.entry, f.hodBefore));
  f.distLodPct = r2(pct(trade.entry, f.lodBefore));
  f.distPmhPct = r2(pct(trade.entry, f.pmHigh));
  f.distPmlPct = r2(pct(trade.entry, f.pmLow));
  return f;
}

/* ─── Классификация ───────────────────────────────────────────────────────── */

type Reason = { key: string; params?: Params };
type Candidate = { setup: SetupCode; score: number; reasons: Reason[] };

const fmtPct = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const fmtMin = (m: number | null) => (m == null ? "—" : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`);

/** Classify from a trade and market data (computes features first). Texts in `lang`; `setup` is always canonical. */
export function classifySetup(trade: ClassifierTrade, market: MarketInputs, lang: Lang = DEFAULT_LANG): SetupSuggestion {
  return classifyFromFeatures(trade, computeFeatures(trade, market), lang);
}

/**
 * Classification from already computed features (pure, no market data): used on read to render the stored suggestion's
 * reasons in the reader's language. Deterministic for the same trade, features and CLASSIFIER_VERSION.
 */
export function classifyFromFeatures(trade: ClassifierTrade, f: SetupFeatures, lang: Lang = DEFAULT_LANG): SetupSuggestion {
  const t = setupsT.tFor(lang);
  const text = (r: Reason) => setupsT.tryFor(lang, `reason.${r.key}`, r.params) ?? r.key;
  const cands: Candidate[] = [];
  const tags: string[] = [];
  const side = trade.side;
  const em = trade.entryMin;
  const tol = 0.0015; // 0.15% допуск на «пробой» уровня

  const add = (setup: SetupCode, score: number, reasons: Reason[]) => cands.push({ setup, score, reasons });
  const timeReason: Reason = { key: "time", params: { time: fmtMin(em), tod: setupsT.tryFor(lang, `tod.${f.tod}`) ?? f.tod } };
  const sideWord = (long: boolean) => t(long ? "side.long" : "side.short");
  const dirWord = (below: boolean) => t(below ? "dir.below" : "dir.above");

  // Классы по удержанию/горизонту.
  if (f.holdClass === "swing") add("swing", 0.7, [{ key: "swing", params: { hold: trade.holdMin == null ? "—" : t("reason.swingDays", { n: Math.round(trade.holdMin / 1440) }) } }]);
  if (f.holdClass === "overnight") add("overnight", 0.7, [{ key: "overnight" }]);
  if (f.holdClass === "scalp") { tags.push(t("tags.scalp")); add("scalp", 0.45, [{ key: "scalpHold", params: { sec: Math.round((trade.holdMin ?? 0) * 60) } }]); }
  if (f.holdClass === "intraday") tags.push(t("tags.intraday"));

  // Классы по времени (слабые — уступают рыночным).
  if (f.tod === "unknown") add("noTime", 0.2, [{ key: "noTime" }]);
  if (f.tod === "premarket") add("premarket", 0.5, [timeReason]);
  if (f.tod === "after") add("after", 0.5, [timeReason]);
  if (f.tod === "powerHour") add("powerHour", 0.5, [timeReason]);
  if (f.tod === "close") add("close", 0.55, [timeReason, { key: "closeMoc" }]);
  if (f.tod === "midday" || f.tod === "afternoon") add("midday", 0.35, [timeReason]);
  if (f.tod === "morning") add("morning", 0.35, [timeReason]);
  if (f.tod === "openDrive") {
    const r: Reason[] = [timeReason];
    let s = 0.45;
    if (f.gapPct != null && side && Math.sign(f.gapPct) === (side === "long" ? 1 : -1) && Math.abs(f.gapPct) >= 1) { s += 0.15; r.push({ key: "withGap", params: { gap: fmtPct(f.gapPct) } }); }
    if (f.rvol != null && f.rvol >= 1.5) { s += 0.1; r.push({ key: "rvol", params: { rvol: f.rvol.toFixed(1) } }); }
    add("openMomentum", s, r);
  }

  if (f.candlesAvailable && side && trade.entry != null) {
    const e = trade.entry;
    const long = side === "long";
    const gap = f.gapPct;
    const rvolBoost = f.rvol != null && f.rvol >= 1.5 ? 0.1 : 0;
    const rvolReason: Reason[] = f.rvol != null && f.rvol >= 1.5 ? [{ key: "rvol", params: { rvol: f.rvol.toFixed(1) } }] : [];
    const pm = f.tod === "premarket" ? t("reason.gapPm") : "";

    // ORB пробой: вход в 9:35–10:30 над максимумом / под минимумом первых 15 (или 5) минут.
    if (em != null && em >= 575 && em <= 630) {
      const hi = f.orb15High ?? f.orb5High, lo = f.orb15Low ?? f.orb5Low;
      const win = f.orb15High != null ? 15 : 5;
      if (hi != null && lo != null) {
        if (long && e >= hi * (1 - tol)) add("orb", 0.8 + rvolBoost, [{ key: "orbLong", params: { win, level: hi.toFixed(2), entry: e.toFixed(2), time: fmtMin(em) } }, ...rvolReason]);
        if (!long && e <= lo * (1 + tol)) add("orb", 0.8 + rvolBoost, [{ key: "orbShort", params: { win, level: lo.toFixed(2), entry: e.toFixed(2), time: fmtMin(em) } }, ...rvolReason]);
      }
    }

    // Пробой PMH / PML (уровень ещё не пробит до входа).
    if (long && f.pmHigh != null && e >= f.pmHigh * (1 - tol) && (f.hodBefore == null || f.hodBefore < f.pmHigh * (1 + tol)))
      add("pmh", 0.75 + rvolBoost, [{ key: "pmh", params: { level: f.pmHigh.toFixed(2), dist: fmtPct(f.distPmhPct) } }, ...rvolReason]);
    if (!long && f.pmLow != null && e <= f.pmLow * (1 + tol) && (f.lodBefore == null || f.lodBefore > f.pmLow * (1 - tol)))
      add("pml", 0.75 + rvolBoost, [{ key: "pml", params: { level: f.pmLow.toFixed(2), dist: fmtPct(f.distPmlPct) } }, ...rvolReason]);

    // Пробой HOD / LOD (после open drive; в первые 15 минут это ORB/momentum).
    if (em != null && em >= 585 && f.barsBeforeEntry >= 2) {
      if (long && f.hodBefore != null && e >= f.hodBefore * (1 - tol))
        add("hod", 0.7 + rvolBoost, [{ key: "hod", params: { level: f.hodBefore.toFixed(2), dist: fmtPct(f.distHodPct) } }, ...rvolReason]);
      if (!long && f.lodBefore != null && e <= f.lodBefore * (1 + tol))
        add("lod", 0.7 + rvolBoost, [{ key: "lod", params: { level: f.lodBefore.toFixed(2), dist: fmtPct(f.distLodPct) } }, ...rvolReason]);
    }

    // Гэп: fade (против гэпа) / продолжение (по гэпу), до 11:00.
    if (gap != null && Math.abs(gap) >= 2 && em != null && em < 660) {
      const withGap = Math.sign(gap) === (long ? 1 : -1);
      if (!withGap) {
        const r: Reason[] = [{ key: "gapFade", params: { gap: fmtPct(gap), pm, side: sideWord(long) } }];
        let s = 0.65;
        if (f.distVwapPct != null && ((long && f.distVwapPct < -0.3) || (!long && f.distVwapPct > 0.3))) { s += 0.1; r.push({ key: "vwapSide", params: { dir: dirWord(long), pct: Math.abs(f.distVwapPct).toFixed(2) } }); }
        add("gapFade", s, r);
      } else if (f.tod !== "openDrive") {
        add("gapGo", 0.55 + rvolBoost, [{ key: "gapGo", params: { gap: fmtPct(gap), pm } }, ...rvolReason]);
      }
    }

    // VWAP: возврат (вход далеко от VWAP против растяжения) / отскок (вход у VWAP по тренду дня).
    if (f.distVwapPct != null) {
      const d = f.distVwapPct;
      if ((long && d <= -0.6) || (!long && d >= 0.6)) {
        const s = Math.abs(d) >= 1.2 ? 0.7 : 0.6;
        add("vwapReversion", s, [{ key: "vwapReversion", params: { dir: dirWord(long), pct: Math.abs(d).toFixed(2) } }]);
      }
      if (Math.abs(d) <= 0.25 && f.moveFromOpenPct != null && f.barsBeforeEntry >= 3) {
        if ((long && f.moveFromOpenPct >= 0.3) || (!long && f.moveFromOpenPct <= -0.3))
          add("vwapBounce", 0.65, [{ key: "vwapBounce", params: { dist: fmtPct(d), move: fmtPct(f.moveFromOpenPct) } }]);
      }
    }

    // Откат от экстремума: шорт около HOD после роста / лонг около LOD после падения.
    if (f.barsBeforeEntry >= 3 && f.moveFromOpenPct != null) {
      if (!long && f.distHodPct != null && f.distHodPct > -0.6 && f.distHodPct < tol * 100 && f.moveFromOpenPct >= 1)
        add("shortHigh", 0.6, [{ key: "shortHigh", params: { pct: Math.abs(f.distHodPct).toFixed(2), move: fmtPct(f.moveFromOpenPct) } }]);
      if (long && f.distLodPct != null && f.distLodPct < 0.6 && f.distLodPct > -tol * 100 && f.moveFromOpenPct <= -1)
        add("longLow", 0.6, [{ key: "longLow", params: { pct: Math.abs(f.distLodPct).toFixed(2), move: fmtPct(f.moveFromOpenPct) } }]);
    }

    if (f.last30Pct != null && Math.abs(f.last30Pct) >= 1) tags.push(t("tags.move30", { pct: fmtPct(f.last30Pct) }));
    if (gap != null && Math.abs(gap) >= 2) tags.push(t("tags.gap", { gap: fmtPct(gap) }));
    if (f.rvol != null && f.rvol >= 2) tags.push(`RVOL ${f.rvol.toFixed(1)}`);
  }

  // Слияние одинаковых классов (берём лучший), сортировка.
  const best = new Map<SetupCode, Candidate>();
  for (const c of cands) {
    const prev = best.get(c.setup);
    if (!prev || prev.score < c.score) best.set(c.setup, c);
  }
  const sorted = [...best.values()].sort((a, b) => b.score - a.score);
  const top: Candidate = sorted[0] ?? { setup: "noTime", score: 0.1, reasons: [{ key: "noData" }] };

  let confidence = Math.min(0.95, top.score);
  let note: string | null = null;
  if (!f.candlesAvailable) {
    confidence = Math.min(confidence, 0.4);
    note = t("note.noCandles");
  } else if (f.interval === "60m" || f.interval === "30m") {
    confidence = Math.round(confidence * 0.8 * 100) / 100;
    note = t("note.coarse", { interval: f.interval });
  }
  const reasons = [...top.reasons];
  // The entry time is always explained (the close play already carries it).
  if (!top.reasons.some((r) => r.key === "time" || r.key === "closeMoc")) reasons.push(timeReason);
  if (f.holdClass === "scalp" && top.setup !== "scalp") reasons.push({ key: "scalpTail" });

  return {
    setup: SETUP_NAME[top.setup],
    setupLabel: setupLabelOf(SETUP_NAME[top.setup], lang),
    confidence: Math.round(confidence * 100) / 100,
    reasons: reasons.map(text),
    alternatives: sorted.slice(1).filter((c) => c.score >= 0.3).slice(0, 3).map((c) => ({
      setup: SETUP_NAME[c.setup], label: setupLabelOf(SETUP_NAME[c.setup], lang), score: Math.round(c.score * 100) / 100,
    })),
    tags: [...new Set(tags)],
    features: f,
    candlesAvailable: f.candlesAvailable,
    note,
    version: CLASSIFIER_VERSION,
  };
}

/** Хэш входов (djb2) — ключ кэша в trade_setup_suggestions; меняется при правке сделки или версии правил. */
export function inputsHash(t: ClassifierTrade, version = CLASSIFIER_VERSION): string {
  const s = [t.ticker, t.date, t.side, t.entry, t.exit, t.qty, t.entryAt, t.exitAt, t.horizon, version].map((v) => String(v ?? "")).join("|");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0") + "-" + s.length.toString(16);
}
