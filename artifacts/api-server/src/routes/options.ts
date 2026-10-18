import { Router, type IRouter } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { logger } from "../lib/logger";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { handleAiNotConfigured } from "../lib/aiErrors";
import { AppError } from "../lib/http";
import { aiLanguageEn } from "../i18n/ai";
import { langOf } from "../i18n";

const router: IRouter = Router();
const cache = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL = 5 * 60_000;
const CACHE_MAX = 300;
/** Bounded cache: evict expired entries, then oldest, so arbitrary symbols can't grow memory forever. */
function cacheSet(key: string, data: unknown): void {
  const now = Date.now();
  if (cache.size >= CACHE_MAX) {
    for (const [k, v] of cache) if (now - v.ts >= CACHE_TTL) cache.delete(k);
    while (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  cache.delete(key);
  cache.set(key, { data, ts: now });
}

const AI_MODEL = "claude-sonnet-4-6";
const aiRateMap = new Map<string, number[]>();
const AI_RATE_WINDOW = 60 * 60 * 1000;
const AI_RATE_MAX = 20;

function checkAiRateLimit(ip: string): boolean {
  const now = Date.now();
  const hits = (aiRateMap.get(ip) ?? []).filter(t => now - t < AI_RATE_WINDOW);
  if (hits.length >= AI_RATE_MAX) return false;
  hits.push(now);
  aiRateMap.set(ip, hits);
  return true;
}

const NASDAQ_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.nasdaq.com/",
};

// ─── Types ───────────────────────────────────────────────────────────────────
type NasdaqRow = {
  expirygroup: string;
  expiryDate: string | null;
  strike: string | null;
  c_Last: string | null;
  c_Change: string | null;
  c_Bid: string | null;
  c_Ask: string | null;
  c_Volume: string | null;
  c_Openinterest: string | null;
  c_colour: boolean;
  p_Last: string | null;
  p_Change: string | null;
  p_Bid: string | null;
  p_Ask: string | null;
  p_Volume: string | null;
  p_Openinterest: string | null;
  p_colour: boolean;
  drillDownURL: string | null;
};

type NasdaqResponse = {
  data: {
    totalRecord: number;
    lastTrade: string;
    table: {
      rows: NasdaqRow[] | null;
    };
  };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function parseNum(s: string | null | undefined): number {
  if (!s || s === "--") return 0;
  const n = parseFloat(s.replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
}

function parseSpot(lastTrade: string): number {
  const m = lastTrade.match(/\$([0-9,]+\.?[0-9]*)/);
  return m ? parseFloat(m[1].replace(/,/g, "")) : 0;
}

/** Parse "May 26, 2026" → { label: "2026-05-26", ts: unix_seconds } */
function parseExpiryGroup(group: string): { label: string; ts: number } | null {
  const d = new Date(group + " 16:00:00 EST");
  if (isNaN(d.getTime())) return null;
  const label = d.toISOString().split("T")[0];
  return { label, ts: Math.floor(d.getTime() / 1000) };
}

/** Build all groups from rows: Map<expirygroup → NasdaqRow[]> */
function groupRows(rows: NasdaqRow[]): Map<string, NasdaqRow[]> {
  const map = new Map<string, NasdaqRow[]>();
  let current = "";
  for (const row of rows) {
    if (row.expirygroup) {
      current = row.expirygroup;
      if (!map.has(current)) map.set(current, []);
    } else if (current && row.strike) {
      map.get(current)!.push(row);
    }
  }
  return map;
}

function buildContract(
  row: NasdaqRow,
  side: "call" | "put",
  spot: number,
  expTs: number,
): {
  contractSymbol: string;
  strike: number;
  bid: number;
  ask: number;
  last: number;
  mid: number;
  iv: null;
  volume: number;
  openInterest: number;
  inTheMoney: boolean;
  change: number;
  changePct: number;
} {
  const strike = parseNum(row.strike);
  const isCall = side === "call";
  const bid = parseNum(isCall ? row.c_Bid : row.p_Bid);
  const ask = parseNum(isCall ? row.c_Ask : row.p_Ask);
  const last = parseNum(isCall ? row.c_Last : row.p_Last);
  const mid = bid > 0 && ask > 0 ? +((bid + ask) / 2).toFixed(3) : last;
  const change = parseNum(isCall ? row.c_Change : row.p_Change);
  const volume = parseNum(isCall ? row.c_Volume : row.p_Volume);
  const oi = parseNum(isCall ? row.c_Openinterest : row.p_Openinterest);
  const inTheMoney = isCall ? spot > strike : spot < strike;

  // Build a compact contract symbol from drillDownURL or synthetic
  const urlPart = row.drillDownURL ?? "";
  const symMatch = urlPart.match(/\/([^/]+)$/);
  const contractSymbol = symMatch
    ? symMatch[1].toUpperCase()
    : `${side.toUpperCase()[0]}${strike}@${expTs}`;

  return {
    contractSymbol,
    strike,
    bid,
    ask,
    last,
    mid,
    iv: null, // NASDAQ free API doesn't provide IV; calculated client-side if needed
    volume,
    openInterest: oi,
    inTheMoney,
    change,
    changePct: last > 0 && change !== 0 ? +((change / (last - change)) * 100).toFixed(2) : 0,
  };
}

// ─── Core fetch ──────────────────────────────────────────────────────────────
/** Asks all three asset classes in parallel (8 s each) and takes the first one that returns rows — worst case 8 s instead of 45 s. */
async function fetchNasdaqChain(symbol: string): Promise<NasdaqResponse> {
  const sym = symbol.toLowerCase();
  const attempts = (["stocks", "etf", "index"] as const).map(async (assetclass) => {
    const url = `https://api.nasdaq.com/api/quote/${sym}/option-chain?assetclass=${assetclass}&limit=600&type=all`;
    const resp = await fetch(url, { headers: NASDAQ_HEADERS, signal: AbortSignal.timeout(8_000) });
    if (!resp.ok) throw new Error(`nasdaq ${assetclass}: ${resp.status}`);
    const data = (await resp.json()) as NasdaqResponse;
    const rows = data?.data?.table?.rows;
    if (!rows || rows.length === 0) throw new Error(`nasdaq ${assetclass}: empty`);
    return data;
  });
  try {
    return await Promise.any(attempts);
  } catch {
    throw new Error("No options data found for this symbol across stocks/etf/index asset classes");
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────
router.get("/options/chain", asyncHandler(async (req, res): Promise<void> => {
  const symbol = String(req.query.symbol || "").toUpperCase().trim();
  if (!symbol || !/^[A-Z0-9.\-^=]{1,12}$/.test(symbol)) throw new AppError("INVALID_SYMBOL");

  const expiration = req.query.expiration ? String(req.query.expiration) : null; // "2026-05-30"
  if (expiration !== null && !/^\d{4}-\d{2}-\d{2}$/.test(expiration)) throw new AppError("INVALID_DATE");
  const cacheKey = expiration ? `chain_${symbol}_${expiration}` : `exp_${symbol}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    res.json(cached.data);
    return;
  }

  try {
    const raw = await fetchNasdaqChain(symbol);
    const rows = raw.data?.table?.rows;
    if (!rows || rows.length === 0) throw new AppError("NO_DATA");

    const spot = parseSpot(raw.data.lastTrade);
    const grouped = groupRows(rows);
    const nowSec = Date.now() / 1000;

    if (!expiration) {
      // Return list of available expirations
      const expirations = Array.from(grouped.keys())
        .map(group => {
          const parsed = parseExpiryGroup(group);
          if (!parsed) return null;
          const dte = Math.round((parsed.ts - nowSec) / 86400);
          return { timestamp: parsed.ts, label: parsed.label, dte, group };
        })
        .filter((e): e is NonNullable<typeof e> => e !== null && e.timestamp > nowSec - 86400);

      const payload = {
        symbol,
        spot,
        change: null,
        changePct: null,
        name: symbol,
        source: "NASDAQ (delayed)",
        expirations,
      };
      cacheSet(cacheKey, payload);
      res.json(payload);
      return;
    }

    // Find the matching group key by comparing labels
    let targetGroup: string | undefined;
    for (const group of grouped.keys()) {
      const parsed = parseExpiryGroup(group);
      if (parsed?.label === expiration) {
        targetGroup = group;
        break;
      }
    }

    if (!targetGroup) {
      // Return available expirations to help user pick a valid one
      const available = Array.from(grouped.keys())
        .map(g => parseExpiryGroup(g)?.label)
        .filter(Boolean);
      throw new AppError("EXPIRATION_NOT_FOUND", 404, { expiration }, { available });
    }

    const targetParsed = parseExpiryGroup(targetGroup)!;
    const expRows = grouped.get(targetGroup)!;
    const dte = Math.max(0, Math.round((targetParsed.ts - nowSec) / 86400));

    const strikes = expRows.map(r => parseNum(r.strike)).filter(s => s > 0).sort((a, b) => a - b);
    const calls = expRows.map(r => buildContract(r, "call", spot, targetParsed.ts));
    const puts  = expRows.map(r => buildContract(r, "put",  spot, targetParsed.ts));

    const payload = {
      symbol,
      spot,
      change: null,
      changePct: null,
      name: symbol,
      source: "NASDAQ (delayed)",
      expirationDate: targetParsed.ts,
      daysToExpiry: dte,
      calls,
      puts,
      strikes,
    };
    cacheSet(cacheKey, payload);
    res.json(payload);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof AppError) throw e;
    logger.warn({ symbol, error: msg }, "Options chain fetch error");
    throw new AppError("UPSTREAM_FAILED");
  }
}));

router.post("/options/ai-analyze", asyncHandler(async (req, res): Promise<void> => {
  type ContractRow = { strike: number; bid: number; ask: number; mid: number; volume: number; openInterest: number; inTheMoney: boolean };
  const { symbol, spot, daysToExpiry, calls, puts, strikes, userPrompt } = req.body as {
    symbol: string;
    spot: number;
    daysToExpiry: number;
    calls: ContractRow[];
    puts: ContractRow[];
    strikes: number[];
    userPrompt: string;
  };

  if (!symbol || typeof spot !== "number" || !userPrompt?.trim() || !Array.isArray(calls) || !Array.isArray(puts)) throw new AppError("VALIDATION");
  if (userPrompt.length > 600) throw new AppError("TEXT_TOO_LONG", undefined, { field: "userPrompt", max: 600 });
  // The prompt only ever uses ATM ±10 strikes — refuse oversized payloads instead of mapping them.
  if (calls.length > 400 || puts.length > 400 || (Array.isArray(strikes) && strikes.length > 400)) throw new AppError("TOO_MANY", undefined, { field: "calls / puts / strikes", max: 400 });

  const ip = (req.ip ?? "anon").slice(0, 64);
  if (!checkAiRateLimit(ip)) throw new AppError("RATE_LIMITED");

  // Build compact chain table (ATM ±10 strikes)
  const sortedStrikes: number[] = Array.isArray(strikes) ? [...strikes].sort((a, b) => a - b) : [];
  const atmIdx = Math.max(0, sortedStrikes.findIndex(s => s >= spot));
  const start = Math.max(0, atmIdx - 9);
  const end = Math.min(sortedStrikes.length, atmIdx + 10);
  const relevant = sortedStrikes.slice(start, end);

  const callMap = new Map(calls.map(c => [c.strike, c]));
  const putMap = new Map(puts.map(p => [p.strike, p]));

  const chainTable = relevant.map(k => {
    const c = callMap.get(k);
    const p = putMap.get(k);
    const atmTag = Math.abs(k - spot) <= (sortedStrikes[1] - sortedStrikes[0]) * 0.6 ? " ← ATM" : "";
    const fmt = (n: number) => n.toFixed(2);
    const cStr = c ? `bid=${fmt(c.bid)} ask=${fmt(c.ask)} mid=${fmt(c.mid)} vol=${c.volume} oi=${c.openInterest}${c.inTheMoney ? " ITM" : ""}` : "n/a";
    const pStr = p ? `bid=${fmt(p.bid)} ask=${fmt(p.ask)} mid=${fmt(p.mid)} vol=${p.volume} oi=${p.openInterest}${p.inTheMoney ? " ITM" : ""}` : "n/a";
    return `$${k.toFixed(1)}${atmTag} | C: ${cStr} | P: ${pStr}`;
  }).join("\n");

  const systemPrompt = `You are a professional options strategist at a prop trading desk. Respond ONLY with valid JSON — no markdown fences, no text outside the JSON object. Write every text field (strategy, reasoning, whyBest, keyRisk, altStrategies) in ${aiLanguageEn(langOf(req))}; keep tickers, numbers and option terms as is.`;

  const userMsg = `OPTIONS CHAIN — ${symbol} | Spot: $${spot.toFixed(2)} | DTE: ${daysToExpiry}d

${chainTable}

Trader's request: "${userPrompt.trim()}"

Recommend the single best strategy. Return ONLY this JSON (numbers, not strings for numeric fields):
{
  "strategy": "<name>",
  "reasoning": "<2-3 sentences>",
  "legs": [{"action":"buy"|"sell","type":"call"|"put","strike":<n>,"premium":<n>,"contracts":<n>}],
  "maxRisk": <number|null>,
  "maxProfit": <number|null for unlimited>,
  "breakevens": [<number>],
  "whyBest": "<1-2 sentences>",
  "keyRisk": "<1 sentence>",
  "altStrategies": ["<alt1>","<alt2>"]
}`;

  try {
    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMsg }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
    const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(clean);
    } catch {
      logger.warn({ symbol, raw: clean.slice(0, 200) }, "Options AI returned invalid JSON");
      throw new AppError("GENERATION_FAILED");
    }
    res.json(parsed);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (handleAiNotConfigured(e, res)) return; // 503 ai_not_configured (audit P2-3)
    if (e instanceof AppError) throw e;
    logger.warn({ symbol, error: msg }, "Options AI analyze error");
    throw new AppError("AI_UNAVAILABLE");
  }
}));

export default router;
