import type { Messages } from "../core";
import type ru from "../ru/benchmark";

export default {
  metric: {
    net: {
      label: "Net",
      hint: "Σ (pnl − |fees|)",
    },
    expectancy: {
      label: "Expectancy $",
      hint: "Net / trades with $",
    },
    winRate: {
      label: "Win rate",
      hint: "W / (W + L), breakeven excluded",
    },
    profitFactor: {
      label: "PF",
      hint: "Σ net⁺ / |Σ net⁻|; no losses → —",
    },
    payoff: {
      label: "Win / loss",
      hint: "Average win / |average loss|",
    },
    sharpe: {
      label: "Sharpe",
      hint: "Mean / σ of daily net × √252 (≥ 5 days)",
    },
    sortino: {
      label: "Sortino",
      hint: "Mean / downside σ × √252 (≥ 5 days)",
    },
    dailyVol: {
      label: "Daily volatility",
      hint: "σ of daily net",
    },
    maxDd: {
      label: "Max drawdown",
      hint: "Peak → trough of the daily net curve",
    },
    recoveryDays: {
      label: "Recovery",
      hint: "Trading days from the trough back to the previous peak",
    },
    greenShare: {
      label: "Green days",
      hint: "Share of days with net > 0",
    },
    bestDayShare: {
      label: "Best day / profit",
      hint: "Consistency rule: > 30% — watch, > 40% — breach",
    },
    feeShare: {
      label: "Fees / gross",
      hint: "Share of gross profit that went to fees",
    },
    tradesPerDay: {
      label: "Trades per day",
      hint: "Trades / trading days (neutral: activity)",
    },
    maxLossStreak: {
      label: "Losing streak",
      hint: "Longest run of losing trades",
    },
    avgHoldMin: {
      label: "Hold time",
      hint: "Average time in position (neutral)",
    },
    first15Share: {
      label: "First 15 min",
      hint: "Share of entries 9:30–9:45 ET (neutral)",
    },
    expectancyR: {
      label: "Expectancy R",
      hint: "Only trades with a stop / risk",
    },
  },
  badge: {
    consistencyBreach: "One day makes the period",
    consistencyBreachDetail: "Best day {day} = {share} of profit (> 40%)",
    consistencyWarn: "Consistency on the edge",
    consistencyWarnDetail: "Best day = {share} of profit (> 30%)",
    consistencyOk: "Steady profit",
    consistencyOkDetail: "Best day = {share} of profit",
    fees: "Fees eat the result",
    feesDetail: "{share} of gross goes to fees",
    pfHigh: "High PF",
    pfLow: "PF < 1",
    pfLowDetail: "PF {pf} — the system loses",
    payoff: "Cuts winners, holds losers",
    payoffDetail: "Average win / average loss {value}",
    streak: "Long losing streaks",
    streakDetail: "{n} losses in a row",
    open: "Losing at the open",
    openDetail: "{n} entries 9:30–9:45, net {net} $",
    dd: "Still in drawdown",
    ddDetail: "Peak {value} $ not recovered",
    hold: "Sits on losers",
    holdDetail: "Holds losers {loss} min vs winners {win} min",
    top: "{metric}: desk top",
    bottom: "{metric}: desk bottom",
    percentile: "Percentile {p}",
  },
} satisfies Messages<typeof ru>;
