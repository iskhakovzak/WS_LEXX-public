import type { BehaviorPattern, BehaviorResponse, RulesReportResponse } from "./types";
import { rulesI18n } from "@/i18n/ns/rules";
import { fmtUsd } from "@/lib/format";

const t = rulesI18n.t;
const usd = (v: number) => fmtUsd(v, { decimals: "trim" });

/** Draft for the rule dialog (create mode). */
export type RuleDraft = {
  name: string;
  kind: string;
  threshold: Record<string, unknown>;
  enabled?: boolean;
  note?: string | null;
};

type Stats = RulesReportResponse["stats"] | null | undefined;

const roundTo = (v: number, step: number) => Math.max(step, Math.round(v / step) * step);

/**
 * Recommended starter rules with parameters taken from the trader's own history
 * (p90 trades/day, p90 loss per trade…), so the first preview is realistic, not generic.
 */
export function starterTemplates(stats: Stats): (RuleDraft & { why: string })[] {
  const p90Loss = stats?.p90Loss ?? null;
  const perTrade = p90Loss ? roundTo(p90Loss, 5) : 100;
  const dayLoss = p90Loss ? roundTo(p90Loss * 2.5, 25) : 300;
  const tradesDay = stats?.p90TradesPerDay ? Math.max(3, Math.round(stats.p90TradesPerDay)) : 8;
  return [
    { name: t("names.dailyLoss", { amount: usd(dayLoss) }), kind: "max_daily_loss_usd", threshold: { usd: dayLoss }, why: t("templates.why.dayLoss") },
    { name: t("names.stopAfterLosses", { count: 3 }), kind: "no_trade_after_n_losses", threshold: { n: 3 }, why: t("templates.why.tilt") },
    { name: t("names.maxTradesPerDay", { count: tradesDay }), kind: "max_trades_per_day", threshold: { n: tradesDay }, why: t("templates.why.tradesDay") },
    { name: t("names.pauseAfterLoss", { count: 10 }), kind: "min_pause_after_loss", threshold: { min: 10 }, why: t("templates.why.pause") },
    { name: t("names.perTradeLoss", { amount: usd(perTrade) }), kind: "max_loss_per_trade_usd", threshold: { usd: perTrade }, why: t("templates.why.perTrade") },
    { name: t("names.noFirstMinutes", { count: 5 }), kind: "no_trade_first_minutes", threshold: { n: 5 }, why: t("templates.why.firstMinutes") },
  ];
}

/** Rule suggested for a behavior pattern (section «Поведение»). null — nothing sensible to suggest. */
export function ruleFromPattern(p: BehaviorPattern, beh: BehaviorResponse | null | undefined, stats: Stats): RuleDraft | null {
  const note = t("templates.fromPattern", { title: p.title });
  const norm = beh?.summary?.tradesPerDayNorm ?? null;
  const median = beh?.summary?.medianTradesPerDay ?? null;
  switch (p.key) {
    case "overtrading": {
      const n = Math.max(2, Math.round(norm ?? stats?.p90TradesPerDay ?? 10));
      return { name: t("names.maxTradesPerDay", { count: n }), kind: "max_trades_per_day", threshold: { n }, note };
    }
    case "fatigue": {
      const n = Math.max(2, Math.ceil(median ?? stats?.medianTradesPerDay ?? 5) + 2);
      return { name: t("names.maxTradesPerDay", { count: n }), kind: "max_trades_per_day", threshold: { n }, note };
    }
    case "revenge": {
      const min = Math.max(10, Math.round(beh?.options?.revengeMin ?? 10));
      return { name: t("names.pauseAfterLoss", { count: min }), kind: "min_pause_after_loss", threshold: { min }, note };
    }
    case "martingale": {
      const factor = Math.max(1.1, Number(beh?.options?.martingaleRatio ?? 1.3));
      return { name: t("names.noSizeUp"), kind: "no_size_up_after_loss", threshold: { factor }, note };
    }
    case "tilt":
      return { name: t("names.stopAfterLosses", { count: 3 }), kind: "no_trade_after_n_losses", threshold: { n: 3 }, note };
    case "disposition": {
      const usd = stats?.p90Loss ? roundTo(stats.p90Loss, 5) : 100;
      return { name: t("names.perTradeLoss", { amount: fmtUsd(usd, { decimals: "trim" }) }), kind: "max_loss_per_trade_usd", threshold: { usd }, note };
    }
    case "firstTrade":
      return { name: t("names.firstTradeAPlus"), kind: "self_check", threshold: {}, note };
    case "euphoria":
      return { name: t("names.pauseAfterBigWin"), kind: "self_check", threshold: {}, note };
    case "chase":
      return { name: t("names.noRevengeRedMorning"), kind: "self_check", threshold: {}, note };
    default:
      return null;
  }
}

/** Auto name for a kind + threshold (used until the user types their own). */
export function autoName(label: string, kind: string, th: Record<string, unknown>): string {
  const n = (k: string) => (th[k] == null || th[k] === "" ? null : Number(th[k]));
  const hhmm = (v: unknown) => {
    const x = Number(v);
    if (!Number.isFinite(x)) return String(v ?? "");
    return `${Math.floor(x / 100)}:${String(x % 100).padStart(2, "0")}`;
  };
  switch (kind) {
    case "max_trades_per_day": return n("n") ? t("names.maxTradesPerDay", { count: n("n")! }) : label;
    case "no_trade_after_n_losses": return n("n") ? t("names.stopAfterLosses", { count: n("n")! }) : label;
    case "max_daily_loss_usd": return n("usd") ? t("names.dailyLoss", { amount: usd(n("usd")!) }) : t("names.dailyLossDesk");
    case "max_loss_per_trade_usd": return n("usd") ? t("names.perTradeLoss", { amount: usd(n("usd")!) }) : label;
    case "min_pause_after_loss": return n("min") ? t("names.pauseAfterLoss", { count: n("min")! }) : label;
    case "no_trade_first_minutes": return n("n") ? t("names.noFirstMinutes", { count: n("n")! }) : label;
    case "trading_window": return th.start != null && th.end != null ? t("names.tradingWindow", { start: hhmm(th.start), end: hhmm(th.end) }) : label;
    case "min_hold_seconds": return n("sec") ? t("names.minHold", { sec: n("sec")! }) : label;
    case "max_position_shares": return n("qty") ? t("names.maxShares", { count: n("qty")! }) : label;
    case "max_trades_per_ticker_day": return n("n") ? t("names.maxTickerEntries", { count: n("n")! }) : label;
    case "max_consecutive_losses": return n("n") ? t("names.maxConsecutiveLosses", { count: n("n")! }) : label;
    case "no_size_up_after_loss": return t("names.noSizeUp");
    default: return label;
  }
}
