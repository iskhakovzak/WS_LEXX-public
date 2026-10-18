import type { Messages } from "../core";
import type ru from "../ru/scaling";

export default {
  metric: {
    trades: {
      label: "Closed trades",
      hint: "Number of closed trades in the window",
    },
    net_pnl: {
      label: "Net P&L",
      hint: "Σ (pnl − fees) over closed trades; broker data when available",
    },
    net_r: {
      label: "Total R",
      hint: "Σ signed R over closed trades",
    },
    profit_factor: {
      label: "Profit factor",
      hint: "Σ profit / |Σ loss| ($ when available, else R); no losses ⇒ no data",
    },
    win_rate: {
      label: "Win rate",
      hint: "Winners / (winners + losers), breakeven excluded",
    },
    expectancy_r: {
      label: "Expectancy, R",
      hint: "Average signed R per closed trade",
    },
    green_weeks: {
      label: "Green weeks in a row",
      hint: "Consecutive weeks with a positive net (the current partial week counts only when it's green)",
    },
    green_days_pct: {
      label: "Green days share",
      hint: "Green days / days with closed trades",
    },
    max_dd_usd: {
      label: "Max drawdown, $",
      hint: "Peak-to-trough of the cumulative net P&L in the window (daily)",
    },
    max_dd_pct: {
      label: "Drawdown, % of limit",
      hint: "Window max drawdown / max drawdown limit (trader's or tier's limits)",
    },
    limit_breaches: {
      label: "Limit breaches",
      hint: "Days with a loss above the daily limit + weeks above the weekly one",
    },
    red_streak: {
      label: "Red days in a row",
      hint: "Current streak of losing days",
    },
    discipline: {
      label: "Discipline (score)",
      hint: "Curator's average discipline score over the window's weeks (1–10)",
    },
    rating_overall: {
      label: "Overall score",
      hint: "Curator's average overall score over the window's weeks (1–10)",
    },
    violations: {
      label: "Rule violations and mistakes",
      hint: "rule_violations + trading_errors records in the window",
    },
  },
  unit: {
    abs: "absolute value",
    x_daily_limit: "× daily loss limit",
    pct_account: "% of account size",
  },
  note: {
    noLimits: "no limits set",
    broker: "broker data",
    journal: "from the journal",
    noMoney: "no $ data",
    noLosses: "no losing trades",
    noTrades: "no trades",
    byR: "by R",
    byUsd: "by $",
    noDdLimit: "no drawdown limit set",
    noRatings: "no curator scores",
    ratings: { one: "{count} score", other: "{count} scores" },
    noData: "no data",
  },
  rule: {
    na: "{label}: threshold not defined ({why})",
    noDailyLimit: "no daily limit",
    noAccount: "no account size",
    noValue: "{label}: {note}",
    value: "{label}: {actual} (need {op} {threshold})",
  },
  reason: {
    tierMissing: "Tier “{tier}” isn't in the ladder",
    noTier: "No tier assigned — start from the first step",
    noLowerTier: "Demotion rules fired, but there is no lower tier — review with the curator",
    allMet: "All {count} promotion conditions are met",
    topTier: "All conditions are met — this is the top tier",
    noPromoteRules: "No active promotion rules for this tier",
    missing: "{missing} of {total} promotion conditions not met",
    manual: "Curator's manual proposal",
    manualWith: "Curator's manual proposal: {comment}",
  },
  action: {
    promote: "Promotion",
    demote: "Demotion",
    assign: "Assignment",
  },
  noTier: "no tier",
  assignDecision: "Tier assigned manually",
  notify: {
    proposalTitle: "{trader}: {action} {from} → {to}",
    proposalAuto: "Automatic proposal by the rules",
    proposalBy: "Proposed by {actor}",
    withReasons: "{text}: {reasons}",
    change: "{action} to “{tier}”",
    approvedBody: "{change} approved ({actor})",
    rejectedBody: "{change} rejected ({actor})",
    newLimits: ". New limits: {limits}",
    quoteAfterApproved: ". “{comment}”",
    quoteAfterRejected: ": “{comment}”",
    approvedTitle: "Scaling approved",
    rejectedTitle: "Scaling rejected",
    staffApproved: "{trader}: approved",
    staffRejected: "{trader}: rejected",
    assignTitle: "Tier changed: {from} → {to}",
    assignBody: "{actor}: tier “{tier}” assigned",
    limits: ". Limits: {limits}",
  },
  templateResync: "Limits aligned with the tier template",
  templateDecision: "Tier assigned from the template",
} satisfies Messages<typeof ru>;
