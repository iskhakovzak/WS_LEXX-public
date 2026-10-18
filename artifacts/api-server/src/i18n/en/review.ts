import type { Messages } from "../core";
import type ru from "../ru/review";

export default {
  quote: "“{text}”",
  eod: {
    closedTitle: "Day closed: {trader}, {date}",
    closedBody: "{parts} — awaiting review",
    trades: { one: "{count} trade", other: "{count} trades" },
    net: "net {net}",
    discipline: "discipline {value}/5",
    overdueTitle: "Review overdue: {trader}, {date}",
    overdueBody: "The day has waited {hours} h for review (SLA {sla} h)",
    reviewedTitle: "Day review {date}: {score}/5",
    reviewedBy: "Score from {reviewer}",
    reviewedComment: "{reviewer}: “{comment}”",
  },
  rating: {
    newTitle: "Weekly rating {week}: {overall}/10",
    updatedTitle: "Rating updated {week}: {overall}/10",
    focus: " · focus: “{focus}”",
    comment: " · “{comment}”",
    ackTitle: "Rating acknowledged: {trader}",
    ackBody: "Week {week}: {overall}/10",
    ackBy: " (marked by {acker})",
  },
  weekly: {
    submittedTitle: "Weekly report {week}: {trader}",
    mood: "Mood {mood}/5. ",
    focus: "Focus: “{focus}”",
    awaiting: "Self-review awaiting review",
    readyTitle: "Weekly review ready {week}",
    updatedTitle: "Weekly review updated {week}",
    score: ": {score}/10",
    goals: { one: " · {count} goal for the week", other: " · {count} goals for the week" },
    comment: " · “{comment}”",
  },
  rubric: {
    discipline: {
      label: "Discipline",
      hint: "Game plan, stop respected, no tilt",
    },
    riskManagement: {
      label: "Risk management",
      hint: "Risk per trade, daily limit, size",
    },
    execution: {
      label: "Execution",
      hint: "Entry by plan, R profile, slippage",
    },
    journaling: {
      label: "Journal",
      hint: "Days with entries, ideas, mistake reviews",
    },
    improvement: {
      label: "Progress",
      hint: "Change vs last week, work on the focus",
    },
  },
  formula: {
    winRate: "W / (W + L), breakeven excluded",
    avgRRubric: "ΣR / number of closed trades (signed R, ±20 clamp)",
    profitFactorRubric: "ΣR⁺ / |ΣR⁻| (null when there are no losses)",
    netRubric: "Net P&L = gross − |fees|; date = exit_date ?? date (NY)",
    avgR: "ΣR / closed (win+loss+be)",
    profitFactor: "ΣR⁺ / |ΣR⁻|",
    net: "net = gross − |fees|; week by close date (NY)",
  },
  breach: {
    avgRisk: "Average risk per trade above the limit",
    dailyLimit: "Daily loss limit exceeded",
    bigLoss: "Loss of {r}R — stop not respected",
  },
  archive: {
    rule_disabled: "rule disabled",
    rule_deleted: "rule deleted",
    stale: "no longer relevant",
  },
  hours: {
    pre: "Before 9:30",
    post: "After 16",
  },
  ideas: {
    noTrader: "(not set)",
    formulaWinRate: "W/(W+L), breakeven excluded",
    formulaNet: "net = gross − fees",
  },
} satisfies Messages<typeof ru>;
