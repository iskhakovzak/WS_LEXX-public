/**
 * Personal prop-desk trading defaults (Settings → Торговля).
 *
 * Source of truth: the server — `users.settings.tradingDefaults` via GET/PUT /api/users/me/settings (audit P1-7),
 * so the defaults follow the trader across devices. localStorage (key `ws_lexx_trading_defaults:<traderName>`)
 * is the synchronous cache the position calculator, trade forms and risk widgets read without an API round-trip,
 * and the fallback when the API is unreachable. `syncTradingDefaults()` reconciles both by `updatedAt`
 * (newer wins: a never-synced local value is migrated to the server once; a newer server value refreshes the cache).
 *
 *   import { getTradingDefaults, riskPerTradeUsd } from "@/components/settings/trading-defaults";
 *   const d = getTradingDefaults();
 *   const shares = sharesForRisk(d, entry, stop);
 *
 * Desk-enforced limits (account size, max risk per trade…) live in `/api/risk/*` and always win —
 * these are the trader's own preferences inside those limits.
 */
import { useEffect, useState } from "react";
import { http } from "@/lib/api/http";

export type Horizon = "intraday" | "overnight" | "swing";
export type RiskMode = "pct" | "usd";

export interface TradingDefaults {
  /** Buying-power base, USD. */
  accountSize: number;
  /** How risk per trade is defined. */
  riskMode: RiskMode;
  /** Risk per trade as % of account (used when riskMode = "pct"). */
  riskPct: number;
  /** Risk per trade in USD (used when riskMode = "usd"). */
  riskUsd: number;
  /** Commission per share, USD (e.g. 0.005). */
  commissionPerShare: number;
  /** Minimum commission per order, USD. */
  commissionMin: number;
  /** Intraday leverage multiplier (e.g. 4 → 4:1 buying power). */
  leverageIntraday: number;
  /** Overnight leverage multiplier (e.g. 2). */
  leverageOvernight: number;
  /** Horizon pre-selected for new trades. */
  defaultHorizon: Horizon;
  /** ISO timestamp of the last save (null = never saved, built-in defaults). */
  updatedAt: string | null;
}

export const DEFAULT_TRADING_DEFAULTS: TradingDefaults = {
  accountSize: 25_000,
  riskMode: "pct",
  riskPct: 0.5,
  riskUsd: 100,
  commissionPerShare: 0.005,
  commissionMin: 1,
  leverageIntraday: 4,
  leverageOvernight: 2,
  defaultHorizon: "intraday",
  updatedAt: null,
};

/** Validation bounds, shared with the settings form. */
export const TRADING_DEFAULT_LIMITS = {
  accountSize: { min: 0, max: 100_000_000 },
  riskPct: { min: 0, max: 10 },
  riskUsd: { min: 0, max: 1_000_000 },
  commissionPerShare: { min: 0, max: 1 },
  commissionMin: { min: 0, max: 100 },
  leverageIntraday: { min: 1, max: 20 },
  leverageOvernight: { min: 1, max: 20 },
} as const;

const KEY_PREFIX = "ws_lexx_trading_defaults";
const SESSION_KEY = "ws_lexx_session";
/** Same-tab change notification (the native `storage` event only fires in other tabs). */
export const TRADING_DEFAULTS_EVENT = "ws-trading-defaults";

function currentTrader(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as { traderName?: string | null };
    return s.traderName || null;
  } catch {
    return null;
  }
}

export function tradingDefaultsKey(trader: string | null = currentTrader()): string {
  return trader ? `${KEY_PREFIX}:${trader}` : KEY_PREFIX;
}

function num(v: unknown, fallback: number, bounds?: { min: number; max: number }): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  if (bounds) return Math.min(bounds.max, Math.max(bounds.min, n));
  return n;
}

/** Coerces any stored/partial object into a valid TradingDefaults. */
export function normalizeTradingDefaults(raw: unknown): TradingDefaults {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const D = DEFAULT_TRADING_DEFAULTS;
  const L = TRADING_DEFAULT_LIMITS;
  const horizon = r.defaultHorizon;
  return {
    accountSize: num(r.accountSize, D.accountSize, L.accountSize),
    riskMode: r.riskMode === "usd" ? "usd" : "pct",
    riskPct: num(r.riskPct, D.riskPct, L.riskPct),
    riskUsd: num(r.riskUsd, D.riskUsd, L.riskUsd),
    commissionPerShare: num(r.commissionPerShare, D.commissionPerShare, L.commissionPerShare),
    commissionMin: num(r.commissionMin, D.commissionMin, L.commissionMin),
    leverageIntraday: num(r.leverageIntraday, D.leverageIntraday, L.leverageIntraday),
    leverageOvernight: num(r.leverageOvernight, D.leverageOvernight, L.leverageOvernight),
    defaultHorizon: horizon === "overnight" || horizon === "swing" ? horizon : "intraday",
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : null,
  };
}

/** Reads the current user's defaults (falls back to built-in defaults). Never throws. */
export function getTradingDefaults(trader?: string | null): TradingDefaults {
  try {
    const raw = localStorage.getItem(tradingDefaultsKey(trader ?? currentTrader()));
    if (!raw) return { ...DEFAULT_TRADING_DEFAULTS };
    return normalizeTradingDefaults(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_TRADING_DEFAULTS };
  }
}

/** Persists defaults for the current user. Returns the normalized saved value (or null if storage failed). */
export function setTradingDefaults(next: Partial<TradingDefaults>, trader?: string | null): TradingDefaults | null {
  const merged = normalizeTradingDefaults({ ...getTradingDefaults(trader), ...next, updatedAt: new Date().toISOString() });
  // Server write is fire-and-forget: the local cache answers immediately; a failed push is retried by the next
  // syncTradingDefaults() (the local value then has the newer updatedAt).
  void pushTradingDefaults(merged);
  try {
    localStorage.setItem(tradingDefaultsKey(trader ?? currentTrader()), JSON.stringify(merged));
    window.dispatchEvent(new CustomEvent(TRADING_DEFAULTS_EVENT));
    return merged;
  } catch {
    return null;
  }
}

/** Removes saved defaults for the current user. */
export function resetTradingDefaults(trader?: string | null): void {
  void pushTradingDefaults(null);
  try {
    localStorage.removeItem(tradingDefaultsKey(trader ?? currentTrader()));
    window.dispatchEvent(new CustomEvent(TRADING_DEFAULTS_EVENT));
  } catch {
    /* storage unavailable */
  }
}

// ─── Server sync (users.settings.tradingDefaults) ─────────────────────────────

const SETTINGS_API = "/api/users/me/settings";

/** PUT the defaults (or null = reset) to the server. false when the API is unreachable / refuses. */
export async function pushTradingDefaults(value: TradingDefaults | null): Promise<boolean> {
  try {
    await http.put(SETTINGS_API, { tradingDefaults: value });
    return true;
  } catch {
    return false;
  }
}

/** Server copy: TradingDefaults, null (none saved on the server) or undefined (API unavailable). */
async function fetchServerDefaults(): Promise<TradingDefaults | null | undefined> {
  try {
    const d = await http.get<{ settings?: { tradingDefaults?: unknown } } | null>(SETTINGS_API);
    const raw = d?.settings?.tradingDefaults;
    return raw && typeof raw === "object" ? normalizeTradingDefaults(raw) : null;
  } catch {
    return undefined;
  }
}

function writeCache(value: TradingDefaults, trader: string | null): void {
  try {
    localStorage.setItem(tradingDefaultsKey(trader), JSON.stringify(value));
    window.dispatchEvent(new CustomEvent(TRADING_DEFAULTS_EVENT));
  } catch {
    /* storage unavailable — the in-memory value is still returned */
  }
}

let inflight: { trader: string | null; promise: Promise<TradingDefaults | null> } | null = null;

/**
 * Reconcile server and local cache for the current user (newer `updatedAt` wins). Resolves to the effective
 * defaults, or null when the server is unavailable (keep using getTradingDefaults()). De-duplicated per trader.
 */
export function syncTradingDefaults(trader: string | null = currentTrader()): Promise<TradingDefaults | null> {
  if (!trader) return Promise.resolve(null);
  if (inflight && inflight.trader === trader) return inflight.promise;
  const promise = (async () => {
    const server = await fetchServerDefaults();
    if (server === undefined) return null;
    const local = getTradingDefaults(trader);
    const localTs = local.updatedAt ? Date.parse(local.updatedAt) : NaN;
    const serverTs = server?.updatedAt ? Date.parse(server.updatedAt) : NaN;
    if (server && (!Number.isFinite(localTs) || (Number.isFinite(serverTs) && serverTs >= localTs))) {
      // Server is newer (or the browser never saved anything) → refresh the cache.
      if (local.updatedAt !== server.updatedAt) writeCache(server, trader);
      return server;
    }
    if (local.updatedAt) {
      // Browser value is newer, or the server has none yet (one-time migration of the old localStorage-only data).
      await pushTradingDefaults(local);
      return local;
    }
    return local; // nothing saved anywhere → built-in defaults
  })().finally(() => {
    setTimeout(() => { if (inflight?.promise === promise) inflight = null; }, 30_000);
  });
  inflight = { trader, promise };
  return promise;
}

/** React hook: current defaults, live-updated when changed in Settings (same or other tab). */
export function useTradingDefaults(): TradingDefaults {
  const [value, setValue] = useState<TradingDefaults>(() => getTradingDefaults());
  useEffect(() => {
    const update = () => setValue(getTradingDefaults());
    // Pull the server copy once (cache refresh fires TRADING_DEFAULTS_EVENT → update).
    void syncTradingDefaults().then((d) => { if (d) setValue(d); });
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key.startsWith(KEY_PREFIX) || e.key === SESSION_KEY) update();
    };
    window.addEventListener(TRADING_DEFAULTS_EVENT, update);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(TRADING_DEFAULTS_EVENT, update);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return value;
}

// ─── Derived numbers (pure helpers for calculator / trade forms) ─────────────

/** Risk budget per trade in USD. */
export function riskPerTradeUsd(d: TradingDefaults): number {
  return d.riskMode === "usd" ? d.riskUsd : (d.accountSize * d.riskPct) / 100;
}

/** Risk per trade as % of account. */
export function riskPerTradePct(d: TradingDefaults): number {
  if (d.riskMode === "pct") return d.riskPct;
  return d.accountSize > 0 ? (d.riskUsd / d.accountSize) * 100 : 0;
}

/** Leverage multiplier for a horizon (swing uses the overnight multiplier). */
export function leverageFor(d: TradingDefaults, horizon: Horizon = d.defaultHorizon): number {
  return horizon === "intraday" ? d.leverageIntraday : d.leverageOvernight;
}

/** Buying power for a horizon, USD. */
export function buyingPower(d: TradingDefaults, horizon: Horizon = d.defaultHorizon): number {
  return d.accountSize * leverageFor(d, horizon);
}

/** Commission for one order (one side) of `shares`, USD. */
export function commissionFor(d: TradingDefaults, shares: number): number {
  if (!Number.isFinite(shares) || shares <= 0) return 0;
  return Math.max(d.commissionMin, shares * d.commissionPerShare);
}

/** Round-trip (entry + exit) commission, USD. */
export function roundTripCommission(d: TradingDefaults, shares: number): number {
  return commissionFor(d, shares) * 2;
}

/**
 * Shares to buy/short so a stop-out loses ≈ the risk budget, capped by buying power.
 * Returns 0 when entry/stop are invalid.
 */
export function sharesForRisk(
  d: TradingDefaults,
  entry: number,
  stop: number,
  horizon: Horizon = d.defaultHorizon,
): { shares: number; riskUsd: number; positionUsd: number; cappedByBuyingPower: boolean } {
  const perShare = Math.abs(entry - stop);
  if (!Number.isFinite(perShare) || perShare <= 0 || !Number.isFinite(entry) || entry <= 0) {
    return { shares: 0, riskUsd: 0, positionUsd: 0, cappedByBuyingPower: false };
  }
  const budget = riskPerTradeUsd(d);
  let shares = Math.floor(budget / perShare);
  const maxByBp = Math.floor(buyingPower(d, horizon) / entry);
  const capped = shares > maxByBp;
  if (capped) shares = Math.max(0, maxByBp);
  return { shares, riskUsd: shares * perShare, positionUsd: shares * entry, cappedByBuyingPower: capped };
}
