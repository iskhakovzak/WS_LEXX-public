// Fixtures of GET /api/daily/me for the day-line tests (shapes from lib/daily/types — the contract).
import type { ContractVerdict, DailyFocus, DailyMe, EveningCard, TierProgress } from "@/lib/daily/types";

export const TRADER = "Кирилл Б."; // seeded trader name (data, the stored id)

export const focusAuto: DailyFocus = {
  trader: TRADER,
  date: "2026-10-19",
  mistake: "structure:averaging",
  window: { from: "2026-10-05", to: "2026-10-16" },
  costNet: -412,
  count: 6,
  source: "auto",
  text: { key: "focus.structure:averaging", params: { cost: -412, count: 6 } },
};

export const focusNone: DailyFocus = { ...focusAuto, mistake: null, costNet: null, count: 0, source: "none", text: { key: "focus.none" } };

export const contractBroken: ContractVerdict = {
  date: "2026-10-16",
  maxLoss: { limit: 300, actual: -120, status: "kept" },
  maxTrades: { limit: 10, actual: 12, status: "broken" },
  rule: { mistake: "structure:averaging", status: "broken" },
  disciplineDelta: -2,
};

export const eveningBroken: EveningCard = {
  trader: TRADER,
  date: "2026-10-16",
  trades: 12,
  netPnl: -120.5,
  focus: {
    date: "2026-10-16",
    mistake: "structure:averaging",
    status: "broken",
    hits: [
      { tradeId: 101, date: "2026-10-16", ticker: "AMD", net: -64 },
      { tradeId: 102, date: "2026-10-16", ticker: "META", net: -21 },
    ],
    costNet: -85,
    disputed: false,
  },
  tradeToReview: { tradeId: 101, date: "2026-10-16", ticker: "AMD", net: -64, reason: "biggest_loss" },
  deskSameTicker: { ticker: "AMD", traders: 6 },
  contract: contractBroken,
  reviewed: false,
  reviewNote: null,
};

export const progress: TierProgress = {
  tier: "trainee",
  nextTier: "junior",
  met: 3,
  total: 5,
  items: [
    { metric: "trades", label: { key: "metric.trades.label" }, actual: 52, target: 40, ok: true },
    { metric: "net_pnl", label: { key: "metric.net_pnl.label" }, actual: 820, target: 1500, ok: false },
    { metric: "profit_factor", label: { key: "metric.profit_factor.label" }, actual: 1.42, target: 1.3, ok: true },
    { metric: "discipline", label: { key: "metric.discipline.label" }, actual: 7.5, target: 7, ok: true },
    { metric: "limit_breaches", label: { key: "metric.limit_breaches.label" }, actual: 1, target: 0, ok: false },
  ],
};

export function me(over: Partial<DailyMe> = {}): DailyMe {
  return { today: "2026-10-19", phase: "premarket", focus: focusAuto, evening: eveningBroken, progress, intraday: false, ...over };
}
