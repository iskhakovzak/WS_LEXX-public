import type { Messages } from "../../core";
import type ru from "../ru/terms";

export default {
  r: { label: "R", title: "R — unit of risk", text: "A trade’s result in units of risk: +2R means you made two planned risks, −1R means you lost one.", formula: "R = P&L / risk per trade" },
  avgR: { label: "Avg R", title: "Average R", text: "The average result of one closed trade, in R.", formula: "ΣR / number of trades" },
  expectancy: { label: "Expectancy", title: "Expectancy", text: "How many R one trade brings on average, given the win rate and the size of wins and losses. > 0 means the system makes money.", formula: "WR × avg win − (1 − WR) × avg loss" },
  pf: { label: "PF", title: "Profit factor", text: "How many times the sum of winning trades exceeds the sum of losing ones. > 1 is profitable, ≥ 2 is a strong result.", formula: "ΣR⁺ / |ΣR⁻|" },
  winrate: { label: "Win rate", title: "Win rate (WR)", text: "Share of winning trades among decided ones; breakeven trades are not counted.", formula: "W / (W + L)" },
  payoff: { label: "Payoff", title: "Payoff ratio", text: "The average winning trade relative to the average losing one. Shows whether your wins are big enough for the current win rate.", formula: "avg win / |avg loss|" },
  mfe: { label: "MFE", title: "MFE — maximum favorable excursion", text: "How far the price went in your favor during the trade. Shows how much profit was available.", formula: "in R or $ from entry" },
  mae: { label: "MAE", title: "MAE — maximum adverse excursion", text: "How deep the price went against the position before the exit. Helps check whether the stop is too wide or too tight.", formula: "in R or $ from entry" },
  drawdown: { label: "Drawdown", title: "Max drawdown", text: "The deepest fall of the equity curve from a previous peak to a low.", formula: "min(equity − peak)" },
  net: { label: "Net", title: "Net P&L", text: "The result after all broker commissions and fees (comm, ECN, SEC, TAF). All money KPIs are net by default.", formula: "gross − fees" },
  gross: { label: "Gross", title: "Gross P&L", text: "The result from entry and exit prices before commissions and fees." },
  fees: { label: "Fees", title: "Commissions and fees", text: "Everything the broker charged: commission, ECN, SEC, TAF and other fees." },
  openRisk: { label: "Open risk", title: "Open risk", text: "How much you could lose right now if every open position were stopped out." },
  bp: { label: "BP", title: "Buying power", text: "The maximum position size the firm lets you hold at the same time." },
  dailyLoss: { label: "Daily limit", title: "Daily loss limit", text: "The maximum loss for the day. When it is hit, trading stops until the next session (red day stop)." },
  gapRisk: { label: "Gap risk", title: "Gap risk", text: "The risk that the price opens beyond your stop after the night or a weekend and the loss exceeds the planned 1R." },
  inPlay: { label: "In play", title: "Stock in play", text: "A ticker with a catalyst and elevated volume today — a candidate to trade." },
  catalyst: { label: "Catalyst", title: "Catalyst", text: "An event that moves the stock: earnings, guidance, an upgrade, FDA news, an offering, a headline." },
  aPlus: { label: "A+", title: "A+ setup", text: "A setup where every item of the playbook checklist lines up. Full or increased size is allowed on it." },
  rvol: { label: "RVOL", title: "Relative volume", text: "Today’s volume relative to the average for the same time window. > 2 means the stock is noticeably more active than usual.", formula: "volume / average volume" },
  atr: { label: "ATR", title: "ATR — average true range", text: "The stock’s typical daily move. Helps set stops and targets in proportion to volatility." },
  vwap: { label: "VWAP", title: "VWAP", text: "The day’s average price weighted by volume. A reference for the “fair” price within the session." },
  float: { label: "Float", title: "Free float", text: "The number of shares available for trading. A small float means sharp moves and a wide spread." },
  si: { label: "SI", title: "Short interest", text: "The share of the float held in short positions. High SI raises the chance of a short squeeze." },
  premarket: { label: "Premarket", title: "Premarket", text: "Trading before the open: 4:00–9:30 ET. Lower liquidity, wider spreads." },
  horizon: { label: "Horizon", title: "Holding horizon", text: "Intraday — closed by the end of the day; overnight — held through the night; swing — several days or more." },
  streak: { label: "Streak", title: "Streak", text: "How many trades or days in a row were green or red." },
  sqn: { label: "SQN", title: "System Quality Number", text: "Van Tharp’s system quality: expectancy divided by the spread of results, adjusted for the number of trades. > 2 is good.", formula: "√N × avg R / σR" },
  rr: { label: "R:R", title: "Risk / reward", text: "How much you plan to make per unit of risk before entering the trade.", formula: "(target − entry) / (entry − stop)" },
  slippage: { label: "Slippage", title: "Slippage", text: "The difference between the planned and the actual fill price." },
  beta: { label: "Beta", title: "Beta", text: "How strongly the stock moves with the market on average: 1 — like the S&P 500, 2 — twice as strong, < 1 — calmer than the market." },

  // Market regime
  vix: { label: "VIX", title: "VIX — fear index", text: "Expected S&P 500 volatility for the next 30 days. Below 15 — a calm market and narrow ranges, 15–20 — normal, above 25 — a nervous tape and sharp reversals." },
  vixTerm: { label: "VIX / VIX3M", title: "VIX term structure", text: "The ratio of 30-day to 3-month volatility. Below 1 — fear is pushed into the future, the market is calm. Above 1 — fear is “here and now”: sell-offs and panic.", formula: "VIX / VIX3M" },
  breadth: { label: "Breadth", title: "Market breadth", text: "How broadly the market participates: whether most stocks rise or the rally rests on a few megacaps. A narrow market is worse for small and mid caps.", formula: "RSP vs SPY over 20 d, or advancers / decliners" },

  // Dilution / offerings
  dilutionScore: { label: "Dilution score", title: "Dilution score", text: "A 0–100 estimate of how hard an offering may press on the price: size versus market cap and float, discount, warrants, cash position and offering history." },
  dilution: { label: "Dilution", title: "Dilution", text: "Issuing new shares: each shareholder’s stake shrinks, and the extra supply usually presses on the price." },
  atm: { label: "ATM", title: "ATM program (at-the-market)", text: "The company sells shares in small pieces straight into the market at the current price. No discount, but it creates a constant supply overhang on rallies." },
  shelf: { label: "Shelf", title: "Shelf (S-3 / F-3)", text: "A pre-registered right to issue shares within 3 years. Not a sale by itself, but an overhang: a shelf deal can come out any day." },
  offerDiscount: { label: "Discount", title: "Offering discount", text: "How far the offer price is below the close before the deal. A deep discount (−15% or more) often pulls the price toward the offer.", formula: "offer / close − 1" },
  warrants: { label: "Warrants", title: "Warrants", text: "Rights to buy shares at a fixed price in the future. They add hidden dilution and often become a price ceiling." },
  runway: { label: "Runway", title: "Cash runway", text: "How many months the company’s cash lasts at the current burn. Under 6 months means a high chance of a new offering.", formula: "cash / monthly burn" },

  // Analyst actions
  pt: { label: "PT", title: "Price target", text: "The price the analyst expects the stock to reach in 12 months. A big target change can be a catalyst by itself.", formula: "Δ PT = new / old − 1" },
  firmWeight: { label: "Weight", title: "Firm weight", text: "How many times bigger, on average, the move on the reaction day is than the stock’s usual day after this firm changes a rating. ×1 — the market ignores it, ×2 and up — the firm moves stocks. Shown from 5 events.", formula: "mean |day move| / median |move| over the 20 sessions before" },
  reaction: { label: "Reaction", title: "Historical reaction", text: "How the stock moved on average on the reaction day to the same analyst actions over 2 years: the gap at the open and the day’s close versus the previous close.", formula: "day = close / prevClose − 1" },
  reactionDay: { label: "Reaction day", title: "Reaction day", text: "The first session in which the market can price the publication: before 16:00 ET — the same day, after the close — the next trading day." },
  ratingHit: { label: "With the rating", title: "In the rating’s direction", text: "Share of cases when the day closed in the direction of the action: up after an upgrade, down after a downgrade.", formula: "sign(day move) = direction" },
  topFirm: { label: "Top firm", title: "Top firm", text: "A major bank or research house (Goldman, Morgan Stanley, JPM, BofA and others) or a firm with weight ×1.8+ over 8+ events." },
  analystScore: { label: "Importance", title: "Importance for the session", text: "A rating change matters more than new coverage, coverage more than a target. Raised by: a team position, your watchlist and tickers you traded, a top firm, high weight, a big PT shift, an already visible gap." },
} satisfies Messages<typeof ru>;
