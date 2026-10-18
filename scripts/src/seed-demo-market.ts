/**
 * Real market bars for the demo seed (Yahoo Finance chart API — the same endpoint / session handshake the API server
 * uses in artifacts/api-server/src/lib/marketDataService.ts + routes/candles.ts).
 *
 * Politeness: strictly sequential, ≥ 700 ms between requests, exponential back-off on 429/5xx, session refresh on 401/403.
 * Every raw response is cached on disk (SEED_DEMO_YAHOO_CACHE dir) so reseeds never refetch; `--offline` = cache only.
 *
 * Yahoo is the ONLY external host this module contacts (fc.yahoo.com for the cookie, query1/query2.finance.yahoo.com).
 */
import fs from "node:fs";
import path from "node:path";

export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
export type Interval = "1m" | "5m" | "60m" | "1d";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";
let session: { cookie: string; crumb: string } | null = null;
let lastReq = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function polite(): Promise<void> {
  const wait = lastReq + 700 - Date.now();
  if (wait > 0) await sleep(wait);
  lastReq = Date.now();
}

async function getSession(force = false): Promise<{ cookie: string; crumb: string }> {
  if (session && !force) return session;
  await polite();
  const r1 = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA }, redirect: "manual" });
  const raw = r1.headers.get("set-cookie") || "";
  const cookie = raw.split(/,(?=\s*\w+=)/).map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
  await polite();
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: cookie } });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.length > 40) throw new Error(`yahoo crumb failed (${r2.status})`);
  session = { cookie, crumb };
  return session;
}

export function cacheDir(): string {
  const d = process.env.SEED_DEMO_YAHOO_CACHE
    || "C:/Users/WS/AppData/Local/Temp/claude/C--Users-WS-Desktop-lexx-Web-Builder/45949afd-c136-4c28-a8ea-e3e35d0b241c/scratchpad/yahoo-cache";
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export let requestCount = 0;

/** Raw chart JSON for one request, from the disk cache or Yahoo. */
async function chart(ticker: string, interval: Interval, p1: number, p2: number, prePost: boolean, key: string, offline: boolean): Promise<any | null> {
  const file = path.join(cacheDir(), `${key}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  if (offline) return null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const s = await getSession(attempt > 0 && attempt % 2 === 0);
    const q = new URLSearchParams({ period1: String(p1), period2: String(p2), interval, includePrePost: prePost ? "true" : "false", events: "div,split", crumb: s.crumb });
    await polite();
    requestCount++;
    let resp: Response;
    try {
      resp = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?${q}`, { headers: { "User-Agent": UA, Accept: "application/json", Cookie: s.cookie } });
    } catch (e) {
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    if (resp.status === 401 || resp.status === 403) { session = null; await sleep(1500); continue; }
    if (resp.status === 429 || resp.status >= 500) { await sleep(3000 * 2 ** attempt); continue; }
    const body: any = await resp.json().catch(() => null);
    if (!resp.ok) {
      // 4xx with a body (e.g. "data not available for the requested range") is a stable answer — cache it
      fs.writeFileSync(file, JSON.stringify(body ?? { error: resp.status }));
      return body;
    }
    fs.writeFileSync(file, JSON.stringify(body));
    return body;
  }
  throw new Error(`yahoo: giving up on ${key}`);
}

function parse(json: any): Bar[] {
  const res = json?.chart?.result?.[0];
  if (!res) return [];
  const ts: number[] = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const out: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    if (!(h >= l) || !(o > 0)) continue;
    if (ts[i] % 60 !== 0) continue; // Yahoo appends a live "last quote" pseudo-bar (e.g. 19:59:55) — not a real bar
    out.push({ t: ts[i], o, h, l, c, v: q.volume?.[i] ?? 0 }); // raw Yahoo values, exactly what the API caches
  }
  return out;
}

export type TickerBars = { d1: Bar[]; h1: Bar[]; m5: Bar[]; m1: Bar[]; meta: { longName?: string; shortName?: string; instrumentType?: string } };

/**
 * daily 2024-12-02..now, 60m (pre/post) for the last 729 days, 5m (pre/post) for the last 59 days,
 * 1m (pre/post) for the last 28 days in 7-day chunks (Yahoo: 1m ≤ 30 days back, ≤ 8 days per request).
 * `nowSec` is pinned so the cache keys are stable across reseeds on the same day.
 */
export async function loadTicker(ticker: string, nowSec: number, offline: boolean): Promise<TickerBars> {
  const day = 86400;
  const end = Math.floor(nowSec / day) * day; // UTC midnight of "today" — stable for a day
  const tag = new Date(end * 1000).toISOString().slice(0, 10);
  const d1json = await chart(ticker, "1d", Math.floor(Date.UTC(2024, 11, 2) / 1000), end + day, false, `${ticker}_1d_${tag}`, offline);
  const d1 = parse(d1json);
  const meta = d1json?.chart?.result?.[0]?.meta ?? {};
  const h1 = parse(await chart(ticker, "60m", end - 729 * day, end + day, true, `${ticker}_60m_${tag}`, offline));
  const m5 = parse(await chart(ticker, "5m", end - 59 * day, end + day, true, `${ticker}_5m_${tag}`, offline));
  const m1: Bar[] = [];
  for (let k = 3; k >= 0; k--) {
    const a = end - (k + 1) * 7 * day + day, b = end - k * 7 * day + day;
    m1.push(...parse(await chart(ticker, "1m", a, b, true, `${ticker}_1m_${tag}_${k}`, offline)));
  }
  const dedup = (arr: Bar[]) => { const seen = new Set<number>(); return arr.filter((x) => (seen.has(x.t) ? false : (seen.add(x.t), true))).sort((x, y) => x.t - y.t); };
  return { d1: dedup(d1), h1: dedup(h1), m5: dedup(m5), m1: dedup(m1), meta: { longName: meta.longName, shortName: meta.shortName, instrumentType: meta.instrumentType } };
}

// standalone: tsx seed-demo-market.ts SPY QQQ … [--offline] [--verbose] → fetch (or read from cache) and summarise
if (process.argv[1] && process.argv[1].endsWith("seed-demo-market.ts")) {
  const tks = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const verbose = process.argv.includes("--verbose");
  (async () => {
    const et = (t: number) => new Date(t * 1000).toLocaleString("sv-SE", { timeZone: "America/New_York" });
    for (const tk of tks.length ? tks : ["SPY"]) {
      const t0 = Date.now();
      const b = await loadTicker(tk, Date.now() / 1000, process.argv.includes("--offline"));
      console.log(`${tk.padEnd(5)} d1 ${b.d1.length} (${b.d1[0] ? et(b.d1[0].t).slice(0, 10) : "-"}) h1 ${b.h1.length} m5 ${b.m5.length} m1 ${b.m1.length}  ${((Date.now() - t0) / 1000).toFixed(1)}s  req=${requestCount}`);
      if (verbose) for (const [k, arr] of Object.entries(b).filter(([k2]) => k2 !== "meta") as [string, Bar[]][]) console.log("  ", k, arr.slice(0, 3).map((x) => `${et(x.t)} o${x.o} h${x.h} l${x.l} c${x.c}`).join(" | "));
    }
  })().catch((e) => { console.error(e); process.exit(1); });
}
