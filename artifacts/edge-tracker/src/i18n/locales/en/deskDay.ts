import type { Messages } from "../../core";
import type ru from "../ru/deskDay";

export default {
  title: "Desk on the ticker",
  desc: "The whole desk's trades of the day on one chart — learn from colleagues' entries and exits at the same market moment",
  descFor: "{ticker} · {date}: the whole desk's trades on one chart",
  form: {
    ticker: "Ticker",
    date: "Date",
    show: "Show",
    hint: "Pick a ticker and a trading day to see every desk trader's trades on one chart.",
  },
  prevDay: "Previous day",
  nextDay: "Next day",
  loading: "Loading the desk's trades…",
  noCandles: "No candles for this day — the chart is unavailable.",
  chartAria: "{ticker} chart for {date} with the desk's trades",
  tf: "Timeframe",
  empty: {
    title: "No desk trades on {ticker} that day",
    desc: "Try another day or ticker.",
  },
  guest: {
    title: "Desk members only",
    desc: "Sign in with your account to see colleagues' trades.",
  },
  legend: {
    title: "Traders",
    count: { one: "{count} trader", other: "{count} traders" },
    all: "All",
    me: "me",
    focus: "Highlight {name}’s trades",
    trades: { one: "{count} trade", other: "{count} trades" },
    window: "{from}–{to} ET",
    hold: "in position {time}",
    added: "added against the position",
    moneyHidden: "$ and sizes are visible only to the trade’s owner and curators.",
  },
  result: { win: "Win", loss: "Loss", be: "Break-even", open: "Open" },
  side: { both: "Long + Short" },
  key: "Legend",
  tip: {
    qty: "{qty} sh",
    pieces: { one: "{count} piece", other: "{count} pieces" },
    move: "{move} per share",
  },
  takeaway: {
    label: "Takeaway",
    best: "Best result — {name}: {r}, {side}, entered at {time} ET ({min} min after the open)",
    bestPre: "Best result — {name}: {r}, {side}, entered at {time} ET, before the open",
    bestOpen: "Best result — {name}: {r}, {side}, entered at the open ({time} ET)",
    averaging: "{averaged} of {losers} losing traders added against the position",
    timing: "Winners entered around {winners} ET, losers around {losers} ET",
    sides: "Short: {sw} of {st} in profit · Long: {lw} of {lt}",
  },
  link: {
    label: "Desk on this ticker: {traders}",
    aria: "Open the desk's trades on {ticker} for {date}",
    chips: "Desk on the same tickers",
    chip: "{ticker} · {traders}",
  },
} satisfies Messages<typeof ru>;
