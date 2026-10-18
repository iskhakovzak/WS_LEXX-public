// Offerings → price reaction and trader stats (pure, no DB / network). Used by routes/offerings.ts.
//
// Timing. SEC `acceptanceDateTime` is New York wall time even though it carries a "Z" suffix
// ("2026-10-15T16:31:12.000Z" = 16:31 ET). A 424B accepted at/after 16:00 ET is traded the next
// session; one accepted before 16:00 (overnight pricing filed premarket, or intraday) is traded the
// same day. Weekends roll to Monday; holidays have no bar, so the first bar on/after the day is used.
//
// Reaction (daily bars, prev = bar before the reaction bar):
//   gap   = open / prevClose − 1        — what the trader sees in premarket
//   o2c   = close / open − 1            — the day after the open (the intraday short)
//   day   = close / prevClose − 1       — full move of the day
//   low   = low / open − 1              — best short excursion from the open
//   high  = high / open − 1             — squeeze against the short from the open
//   next  = next close / close − 1      — follow-through on day 2
//   rvol  = volume / avg volume of the 20 bars before

export type Bar = { d: string; o: number; h: number; l: number; c: number; v: number };

export type Session = "pre" | "rth" | "post";

export type Reaction = {
  day: string;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  close: number;
  gapPct: number;
  o2cPct: number;
  dayPct: number;
  lowFromOpenPct: number;
  highFromOpenPct: number;
  nextDayPct: number | null;
  relVol: number | null;
};

export type ReactionSummary = {
  n: number;
  avgGap: number | null;
  medianGap: number | null;
  avgO2c: number | null;
  avgDay: number | null;
  /** Share of events where the stock closed below its open (the short worked after the open). */
  redShare: number | null;
  avgLowFromOpen: number | null;
  avgHighFromOpen: number | null;
  avgNextDay: number | null;
};

const r2 = (x: number) => Math.round(x * 100) / 100;

function addDays(date: string, days: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}
function weekday(date: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}
/** Same day when it is a weekday, else the following Monday. */
export function rollToWeekday(date: string): string {
  let x = date;
  for (let i = 0; i < 3 && (weekday(x) === 0 || weekday(x) === 6); i++) x = addDays(x, 1);
  return x;
}
export function nextWeekday(date: string): string {
  return rollToWeekday(addDays(date, 1));
}

/** Parse SEC acceptanceDateTime (ET wall time) → { day, minutes, hhmm }. */
export function parseAcceptance(raw: string | null | undefined): { day: string; minutes: number; hhmm: string } | null {
  const m = String(raw ?? "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return { day: m[1], minutes, hhmm: `${m[2]}:${m[3]}` };
}

export function sessionOf(minutes: number): Session {
  if (minutes >= 16 * 60) return "post";
  if (minutes >= 9 * 60 + 30) return "rth";
  return "pre";
}

/** First session that can trade a filing. Without an acceptance stamp the filing date itself is used. */
export function reactionDayFor(filingDate: string, acceptance?: string | null): { day: string; session: Session | null; acceptedAt: string | null } {
  const a = parseAcceptance(acceptance);
  if (!a) return { day: rollToWeekday(filingDate), session: null, acceptedAt: null };
  const session = sessionOf(a.minutes);
  const day = session === "post" ? nextWeekday(a.day) : rollToWeekday(a.day);
  return { day, session, acceptedAt: `${a.day} ${a.hhmm}` };
}

/** Daily candles (unix seconds) → bars keyed by New York date. */
export function barsFromCandles(candles: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>): Bar[] {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  const out: Bar[] = [];
  for (const c of candles) {
    if (![c.o, c.h, c.l, c.c].every((x) => typeof x === "number" && Number.isFinite(x) && x > 0)) continue;
    const d = fmt.format(new Date(c.t * 1000));
    if (out.length && out[out.length - 1].d === d) continue;
    out.push({ d, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v ?? 0 });
  }
  return out;
}

/** Index of the first bar on/after `day`, at most 4 calendar days later (holidays); −1 otherwise. */
export function barIndexOnOrAfter(bars: Bar[], day: string): number {
  const limit = addDays(day, 4);
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].d < day) lo = mid + 1; else hi = mid;
  }
  return lo < bars.length && bars[lo].d <= limit ? lo : -1;
}

export function reactionOn(bars: Bar[], day: string): Reaction | null {
  const i = barIndexOnOrAfter(bars, day);
  if (i <= 0) return null;
  const b = bars[i];
  const prev = bars[i - 1];
  if (!(prev.c > 0) || !(b.o > 0)) return null;
  const next = bars[i + 1];
  const look = bars.slice(Math.max(0, i - 20), i).map((x) => x.v).filter((v) => v > 0);
  const avgV = look.length >= 5 ? look.reduce((s, v) => s + v, 0) / look.length : null;
  return {
    day: b.d,
    prevClose: prev.c,
    open: b.o, high: b.h, low: b.l, close: b.c,
    gapPct: r2((b.o / prev.c - 1) * 100),
    o2cPct: r2((b.c / b.o - 1) * 100),
    dayPct: r2((b.c / prev.c - 1) * 100),
    lowFromOpenPct: r2((b.l / b.o - 1) * 100),
    highFromOpenPct: r2((b.h / b.o - 1) * 100),
    nextDayPct: next ? r2((next.c / b.c - 1) * 100) : null,
    relVol: avgV && b.v > 0 ? r2(b.v / avgV) : null,
  };
}

function mean(xs: number[]): number | null {
  return xs.length ? r2(xs.reduce((s, x) => s + x, 0) / xs.length) : null;
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return r2(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

export function summarize(list: Reaction[]): ReactionSummary {
  const n = list.length;
  const nexts = list.map((r) => r.nextDayPct).filter((x): x is number => x != null);
  return {
    n,
    avgGap: mean(list.map((r) => r.gapPct)),
    medianGap: median(list.map((r) => r.gapPct)),
    avgO2c: mean(list.map((r) => r.o2cPct)),
    avgDay: mean(list.map((r) => r.dayPct)),
    redShare: n ? r2(list.filter((r) => r.o2cPct < 0).length / n) : null,
    avgLowFromOpen: mean(list.map((r) => r.lowFromOpenPct)),
    avgHighFromOpen: mean(list.map((r) => r.highFromOpenPct)),
    avgNextDay: mean(nexts),
  };
}

// ── Filings → events ─────────────────────────────────────────────────────────

/** Priced equity takedowns. 424B2 (bank structured notes) and 424B3 (resale prospectus) are not offering days. */
export const PRICED_FORM_RE = /^424B[1457]$/i;
/** Forms shown on the company timeline. */
export const TIMELINE_FORM_RE = /^(S-1|F-1|S-3|F-3|S-3ASR|F-3ASR|424B[1457]|EFFECT)(\/A)?$/i;

export type TimelineKind = "priced" | "atm" | "shelf" | "s1" | "effect";

export function timelineKind(form: string, description?: string | null, doc?: string | null): TimelineKind {
  const f = form.toUpperCase();
  if (f.startsWith("424B")) {
    if (description && /at[- ]the[- ]market|sales agreement|\batm\b/i.test(description)) return "atm";
    if (doc && /(^|[^a-z])atm([^a-z]|$)|salesagreement|equitydistribution/i.test(doc)) return "atm";
    return "priced";
  }
  if (/^(S-3|F-3)/.test(f)) return "shelf";
  if (/^(S-1|F-1)/.test(f)) return "s1";
  return "effect";
}

export type SubmissionsRecent = {
  accessionNumber?: string[];
  filingDate?: string[];
  form?: string[];
  primaryDocument?: string[];
  primaryDocDescription?: string[];
  acceptanceDateTime?: string[];
};

export type FilingEvent = {
  form: string;
  kind: TimelineKind;
  filingDate: string;
  acceptedAt: string | null;
  session: Session | null;
  /** First session that could trade it (null for shelves / registrations / EFFECT). */
  reactionDay: string | null;
  adsh: string | null;
  doc: string | null;
  description: string | null;
};

/** Timeline events newest-first, since `sinceDate`. Priced takedowns on the same reaction day collapse into one. */
export function filingEvents(recent: SubmissionsRecent | null | undefined, sinceDate: string): FilingEvent[] {
  const forms = recent?.form ?? [];
  const out: FilingEvent[] = [];
  const pricedDays = new Set<string>();
  for (let i = 0; i < forms.length; i++) {
    const form = String(forms[i] ?? "");
    const filingDate = recent?.filingDate?.[i] ?? "";
    if (!filingDate) continue;
    if (filingDate < sinceDate) break; // recent[] is newest-first
    if (!TIMELINE_FORM_RE.test(form)) continue;
    const description = recent?.primaryDocDescription?.[i] ?? null;
    const kind = timelineKind(form, description, recent?.primaryDocument?.[i]);
    const priced = PRICED_FORM_RE.test(form);
    const t = reactionDayFor(filingDate, recent?.acceptanceDateTime?.[i]);
    if (priced) {
      if (pricedDays.has(t.day)) continue;
      pricedDays.add(t.day);
    }
    out.push({
      form, kind, filingDate,
      acceptedAt: t.acceptedAt,
      session: t.session,
      reactionDay: priced ? t.day : null,
      adsh: recent?.accessionNumber?.[i] ?? null,
      doc: recent?.primaryDocument?.[i] ?? null,
      description,
    });
  }
  return out;
}

/** Automatic shelf (S-3ASR / F-3ASR) since `sinceDate` ⇒ well-known seasoned issuer: its 424B5s are mostly notes, not dilution. */
export function isWksi(recent: SubmissionsRecent | null | undefined, sinceDate: string): boolean {
  const forms = recent?.form ?? [];
  for (let i = 0; i < forms.length; i++) {
    if ((recent?.filingDate?.[i] ?? "") < sinceDate) break;
    if (/^(S|F)-3ASR$/i.test(String(forms[i] ?? ""))) return true;
  }
  return false;
}

/** Reaction days of priced takedowns (ascending, unique). */
export function offeringDays(events: FilingEvent[]): string[] {
  return Array.from(new Set(events.map((e) => e.reactionDay).filter((d): d is string => !!d))).sort();
}

// ── Trader stats: offering days vs normal days ──────────────────────────────

export type TradeLite = { id: number; ticker: string; date: string; pnl: number | null; fees: number | null; result: "win" | "loss" | "be" | "open" | null };

export type DayBucket = {
  trades: number;
  decided: number;
  wins: number;
  losses: number;
  winRate: number | null;
  net: number;
  avgNet: number | null;
  best: number | null;
  worst: number | null;
  tickers: number;
};

function bucket(list: TradeLite[]): DayBucket {
  let wins = 0, losses = 0, net = 0, withNet = 0;
  let best: number | null = null, worst: number | null = null;
  const tickers = new Set<string>();
  for (const t of list) {
    tickers.add(t.ticker);
    if (t.result === "win") wins++;
    else if (t.result === "loss") losses++;
    if (t.pnl == null || t.result === "open") continue;
    const n = t.pnl - Math.abs(t.fees ?? 0);
    net += n; withNet++;
    best = best == null ? n : Math.max(best, n);
    worst = worst == null ? n : Math.min(worst, n);
  }
  const decided = wins + losses;
  return {
    trades: list.length,
    decided, wins, losses,
    winRate: decided ? r2((wins / decided) * 100) : null,
    net: r2(net),
    avgNet: withNet ? r2(net / withNet) : null,
    best: best == null ? null : r2(best),
    worst: worst == null ? null : r2(worst),
    tickers: tickers.size,
  };
}

/**
 * Split trades by «offering day» = the reaction day of a priced takedown for that ticker
 * (`window` = 1 also counts the next session as an offering day).
 */
export function splitByOfferingDays(trades: TradeLite[], daysByTicker: Map<string, string[]>, window: 0 | 1 = 0): {
  offering: DayBucket;
  normal: DayBucket;
  offeringTrades: TradeLite[];
  matched: Map<string, string>;
} {
  const sets = new Map<string, Set<string>>();
  const origin = new Map<string, string>();
  for (const [ticker, days] of daysByTicker) {
    const s = new Set<string>();
    for (const d of days) {
      s.add(d); origin.set(`${ticker}|${d}`, d);
      if (window === 1) { const n = nextWeekday(d); s.add(n); origin.set(`${ticker}|${n}`, d); }
    }
    sets.set(ticker, s);
  }
  const offeringTrades: TradeLite[] = [];
  const normal: TradeLite[] = [];
  const matched = new Map<string, string>();
  for (const t of trades) {
    const day = t.date.slice(0, 10);
    if (sets.get(t.ticker)?.has(day)) {
      offeringTrades.push(t);
      matched.set(String(t.id), origin.get(`${t.ticker}|${day}`) ?? day);
    } else normal.push(t);
  }
  return { offering: bucket(offeringTrades), normal: bucket(normal), offeringTrades, matched };
}
