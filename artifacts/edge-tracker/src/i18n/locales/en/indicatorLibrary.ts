import type { Messages } from "../../core";
import type ru from "../ru/indicatorLibrary";

export default {
  vwap: {
    name: "Volume-weighted average price",
    timeframe: "1–5 min, current session only",
    summary: "The day's \"fair price\" line — algos and institutions grade their fills against it.",
    deskUse: "The main intraday reference: hold longs above VWAP, shorts below. The first pullback to VWAP after a strong open in an in-play stock is a classic A+ entry with a tight stop beyond the line. A VWAP flip on volume signals a change of control.",
    settings: {
      s1: { label: "Source", value: "HLC3" },
      s2: { label: "Anchor", value: "session, with and without premarket" },
      s3: { label: "Bands", value: "±1σ / ±2σ" },
    },
    signals: {
      long: "VWAP holds on the pullback + volume rises on the bounce",
      short: "Rejection from VWAP from below after a weak open",
      avoid: "Price saws back and forth through VWAP — chop: size down or stay out",
    },
    pitfalls: {
      p1: "Using VWAP on daily charts and for swings — it resets every session",
      p2: "Entering on the first touch without tape/volume confirmation",
      p3: "Placing the stop right on the line — noise will take you out",
    },
  },
  avwap: {
    name: "Anchored VWAP",
    timeframe: "5 min to daily, anchored to an event",
    summary: "VWAP from a chosen point — earnings, a gap, a high/low — shows the average price of that event's participants.",
    deskUse: "For holding positions: anchor to the earnings or gap day and hold while price stays above AVWAP. A good trailing stop for overnight and swing trades — a clear level where those who bought the news are \"flat on average\".",
    settings: {
      s1: { label: "Anchor", value: "earnings day / gap / swing low" },
      s2: { label: "Timeframe", value: "5 min intraday, daily for swings" },
    },
    signals: {
      long: "Pullback to the catalyst AVWAP and a hold",
      short: "Losing the AVWAP of a gap up — the gap is filling",
      avoid: "Too many anchors at once — a mess of lines",
    },
    pitfalls: {
      p1: "Anchoring to a random candle with no event",
      p2: "Ignoring that an AVWAP from a distant anchor is nearly flat and means nothing",
    },
  },
  rvol: {
    name: "Relative volume",
    timeframe: "Premarket and the first 30 minutes",
    summary: "Current volume vs the average for the same time of day — the filter for whether a stock is in play.",
    deskUse: "The first filter of the morning game plan: only stocks with RVOL ≥ 2 and a catalyst make the in-play list. Without relative volume even a perfect setup is a liquidity trap. Size up only at RVOL ≥ 3.",
    settings: {
      s1: { label: "Baseline", value: "10–20 day average" },
      s2: { label: "Comparison", value: "by time of day" },
      s3: { label: "In-play threshold", value: "≥ 2× (A+ — ≥ 3×)" },
    },
    signals: {
      long: "RVOL ≥ 3 + catalyst + premarket high holds",
      short: "RVOL is high but price can't make a new high — distribution",
      avoid: "RVOL < 1.5 — the stock is not in play, skip it",
    },
    pitfalls: {
      p1: "Computing RVOL from the daily average without a time-of-day adjustment",
      p2: "Mistaking high RVOL in an illiquid name for real interest",
    },
  },
  pm: {
    name: "Premarket high and low",
    timeframe: "1–5 min, first 60 minutes",
    summary: "The key morning levels: a PMH break on volume continues the gap, losing PML shows weakness.",
    deskUse: "The core of gap & go: mark PMH/PML in the game plan before the open. Long the PMH break and retest on volume, stop below the level. If a gapper loses PML in the first minutes — short the return to the level.",
    settings: {
      s1: { label: "Window", value: "04:00–09:30 ET" },
      s2: { label: "Confirmation", value: "a 1–2 min candle closes beyond the level" },
    },
    signals: {
      long: "PMH break + retest + RVOL > 3",
      short: "Rejection from PMH and VWAP lost",
      avoid: "Thin premarket (< 100k shares) — the levels are unreliable",
    },
    pitfalls: {
      p1: "Buying the first break without a retest in a wide-spread stock",
      p2: "Ignoring daily levels above PMH",
    },
  },
  orb: {
    name: "Opening range breakout",
    timeframe: "1/5/15-minute range",
    summary: "The high/low of the first N minutes — the break sets the day's direction in in-play stocks.",
    deskUse: "A mechanical entry for morning names: wait for the 5-minute range to form, enter the break in the gap's direction, stop beyond the midpoint or the opposite side. Risk in R is set by the range width, which makes sizing easy.",
    settings: {
      s1: { label: "Range", value: "5 min (aggressive — 1 min, conservative — 15)" },
      s2: { label: "Stop", value: "range midpoint" },
      s3: { label: "Target", value: "2R or the next level" },
    },
    signals: {
      long: "Break of the range high in the gap's direction + above VWAP",
      short: "Break of the range low against the gap (gap fade)",
      avoid: "Range wider than 0.5 × daily ATR — R is too expensive",
    },
    pitfalls: {
      p1: "Trading ORB in stocks without a catalyst",
      p2: "Ignoring that a wide range eats your R",
    },
  },
  rs: {
    name: "Relative strength vs SPY/QQQ",
    timeframe: "5 min intraday, daily for swings",
    summary: "A stock stronger or weaker than the market — long the leaders, short the laggards.",
    deskUse: "When the market pulls back, watch who holds up: a stock making highs while SPY makes lows is the first long when the index turns. For swings — compare with the sector (XLK, XLF…) over 1–3 months.",
    settings: {
      s1: { label: "Benchmark", value: "SPY / QQQ / sector ETF" },
      s2: { label: "Calculation", value: "stock % change − benchmark % change" },
      s3: { label: "Window", value: "since the open / 20 days" },
    },
    signals: {
      long: "Holds its high while SPY pulls back + above VWAP",
      short: "Weaker than the market on an index bounce",
      avoid: "The stock moves 1:1 with the index — no story of its own",
    },
    pitfalls: {
      p1: "Comparing with SPY a stock that follows its sector",
      p2: "Confusing the RS indicator with RSI",
    },
  },
  ema: {
    name: "Exponential moving average",
    timeframe: "1–15 min intraday, daily for swings",
    summary: "The fast average: the 9/20 EMA are the \"rails\" of a trend day.",
    deskUse: "On a trend day an in-play stock pulls back to the 9 EMA on 1–2 min charts — those are add points. A close below the 20 EMA on the 5 min is a signal to cut size. In swings the 10/21 EMA on the daily hold momentum leaders.",
    settings: {
      s1: { label: "Intraday", value: "9 and 20 EMA (1–5 min)" },
      s2: { label: "Swing", value: "10 and 21 EMA (daily)" },
      s3: { label: "Source", value: "Close" },
    },
    signals: {
      long: "9 > 20, both rising, pullback to the 9 EMA held",
      short: "9 < 20, bounce to the 20 EMA rejected",
      avoid: "Averages tangled and flat — a range",
    },
    pitfalls: {
      p1: "Entering on every cross in chop",
      p2: "Forgetting that a 1-min EMA is noise without context",
    },
  },
  ma: {
    name: "Simple moving average",
    timeframe: "Daily and 4H; 50/200 for swings",
    summary: "The 50/200 SMA on the daily — levels the whole market watches.",
    deskUse: "For swings and holds: stocks above a rising 50 SMA are long candidates, pullbacks to the 50/200 SMA give a clear stop. Intraday, a daily 200 SMA near price matters — a frequent magnet and reaction level.",
    settings: {
      s1: { label: "Periods", value: "20 / 50 / 200" },
      s2: { label: "Timeframe", value: "Daily" },
    },
    signals: {
      long: "Price above the 50 SMA, 50 > 200, pullback to the 20/50 held",
      short: "Price below the 200 SMA, bounce to it rejected",
      avoid: "Price weaves around a flat 50 SMA",
    },
    pitfalls: {
      p1: "Waiting for a golden cross as an entry — the signal lags",
      p2: "Using an SMA on minute charts instead of an EMA",
    },
  },
  rsi: {
    name: "Relative strength index",
    timeframe: "5–60 min intraday, daily for swings",
    summary: "An overbought/oversold and divergence oscillator.",
    deskUse: "On the desk RSI is not an entry signal but a stretch filter: in a stock with RSI(2) < 5 after 3+ down days, look for a mean-reversion bounce to a level. A 5-min divergence at the high of day is a reason to take partials.",
    settings: {
      s1: { label: "Period", value: "14 (swing), 2–5 (mean reversion)" },
      s2: { label: "Levels", value: "30 / 70, in a trend 40 / 80" },
    },
    signals: {
      long: "RSI < 30 and a turn up at support",
      short: "Bearish divergence at HOD + VWAP lost",
      avoid: "RSI 40–60 — no stretch, no edge",
    },
    pitfalls: {
      p1: "Shorting \"overbought\" in a strong trend — RSI can stay > 70 for days",
      p2: "Trading a divergence without structural confirmation",
    },
  },
  macd: {
    name: "Moving average convergence divergence",
    timeframe: "1H–4H for swings, 5–15 min intraday",
    summary: "Trend momentum: the histogram shows acceleration and fading.",
    deskUse: "We use it as confirmation, not a trigger: a fading 15-min histogram near the target is a reason to scale out. On the daily, a cross above zero after a base is a swing watchlist candidate.",
    settings: {
      s1: { label: "Parameters", value: "12 / 26 / 9" },
      s2: { label: "Mode", value: "histogram + lines" },
    },
    signals: {
      long: "Cross up above zero after consolidation",
      short: "Cross down below zero on a bounce",
      avoid: "Lines near zero and tangled",
    },
    pitfalls: {
      p1: "Entering on crosses on minute charts — heavy lag",
      p2: "Not looking at price structure",
    },
  },
  bollinger: {
    name: "Bollinger Bands",
    timeframe: "15 min to daily",
    summary: "A ±2σ channel: a squeeze warns that volatility is about to expand.",
    deskUse: "A squeeze on the daily (narrowest width in 6 months) puts the stock on the swing watchlist before earnings or a catalyst. Intraday: a push beyond the band on RVOL means continuation, not reversal.",
    settings: {
      s1: { label: "Period", value: "20" },
      s2: { label: "Deviation", value: "2σ" },
      s3: { label: "Squeeze", value: "BB inside Keltner 1.5 ATR" },
    },
    signals: {
      long: "Breakout up from the squeeze on volume",
      short: "Rejection from the upper band + RSI divergence",
      avoid: "Wide bands after an impulse — volatility has already expanded",
    },
    pitfalls: {
      p1: "Selling every touch of the upper band in a trend",
      p2: "Guessing the squeeze breakout direction in advance",
    },
  },
  atr: {
    name: "Average true range",
    timeframe: "Daily for size, 5 min for stops",
    summary: "How far a stock moves — the basis of position size, stops and gap risk.",
    deskUse: "Desk risk management: stop = 0.5–1 ATR (5 min) intraday, 1–2 ATR (daily) for swings. Size = $ risk / stop distance. Overnight: if daily ATR × position exceeds the overnight exposure limit — cut before holding.",
    settings: {
      s1: { label: "Period", value: "14" },
      s2: { label: "Daily", value: "swing size and gap risk" },
      s3: { label: "5 min", value: "intraday stops and targets" },
    },
    signals: {
      long: "ATR expands on a breakout — the trend gains strength",
      short: "ATR expands on selling",
      avoid: "The stock has already moved > 1.5 ATR today — little room left, too late to chase",
    },
    pitfalls: {
      p1: "The same position size in stocks with different ATR",
      p2: "Forgetting to recalculate the stop after earnings — ATR has grown",
    },
  },
  "volume-profile": {
    name: "Volume profile",
    timeframe: "Session intraday, week/month for swings",
    summary: "Where volume traded: POC, value area, \"air pockets\" for fast moves.",
    deskUse: "Targets and stops by volume: price moves fast through a low-volume node — put targets there, stops beyond a high-volume node. For holds, a position above the value area of previous days is safer.",
    settings: {
      s1: { label: "Type", value: "session / fixed range" },
      s2: { label: "Value area", value: "70%" },
      s3: { label: "Step", value: "auto by tick" },
    },
    signals: {
      long: "Acceptance above VAH + POC holds on the retest",
      short: "Rejection from VAH and a return into the value area",
      avoid: "Price inside the value area — rotation",
    },
    pitfalls: {
      p1: "Building the profile over too short a range",
      p2: "Ignoring premarket volume",
    },
  },
  stochastic: {
    name: "Stochastic",
    timeframe: "15 min to daily",
    summary: "Where the close sits within the range — timing pullbacks in a trend.",
    deskUse: "A secondary tool: in a steady daily trend, %K leaving the < 20 zone times an add to a swing position. The desk barely uses it on minute charts — too noisy.",
    settings: {
      s1: { label: "Parameters", value: "14 / 3 / 3" },
      s2: { label: "Levels", value: "20 / 80" },
    },
    signals: {
      long: "%K crosses %D up from the < 20 zone in an uptrend",
      short: "%K crosses %D down from the > 80 zone in a downtrend",
      avoid: "The 40–60 zone and a range",
    },
    pitfalls: {
      p1: "Trading against the trend on \"overbought\"",
      p2: "Using it on the 1 min",
    },
  },
  fibonacci: {
    name: "Fibonacci levels",
    timeframe: "4H–daily for swings, 5–15 min intraday",
    summary: "Pullback depth from an impulse: 38.2 / 50 / 61.8%.",
    deskUse: "Only together with other levels: a pullback to 50–61.8% of the morning impulse that lines up with VWAP or a daily level is an entry zone. On its own, Fib is not a reason for a trade on the desk.",
    settings: {
      s1: { label: "Levels", value: "38.2 / 50 / 61.8 / 78.6" },
      s2: { label: "Extensions", value: "127.2 / 161.8 for targets" },
    },
    signals: {
      long: "Bounce from 50–61.8% on volume, lined up with VWAP",
      short: "Rejection from 38.2–50% on a bounce in a downtrend",
      avoid: "A grid drawn on an unclear impulse",
    },
    pitfalls: {
      p1: "Fitting the impulse to the level you want",
      p2: "Placing the stop exactly on the level",
    },
  },
  "support-resistance": {
    name: "Support and resistance",
    timeframe: "All timeframes, higher ones carry more weight",
    summary: "Levels where price turned before: daily highs/lows, round numbers.",
    deskUse: "The skeleton of the game plan: 2–4 daily levels + PDH/PDL for every in-play stock. Entering at a level gives a tight stop and a clear R. For holds, put the stop beyond a daily level, not a minute one.",
    settings: {
      s1: { label: "Source", value: "PDH/PDL, 20–60 day highs/lows, round numbers" },
      s2: { label: "Zone", value: "±0.1–0.2 ATR around the level" },
    },
    signals: {
      long: "Retest of broken resistance as support",
      short: "False break of the high and a return below the level",
      avoid: "Price halfway between levels — poor R",
    },
    pitfalls: {
      p1: "Drawing too many levels",
      p2: "Treating a level as a line instead of a zone",
    },
  },
  volume: {
    name: "Volume",
    timeframe: "All timeframes",
    summary: "Confirms any move: a breakout without volume is suspect.",
    deskUse: "Breakout volume ≥ 2× the candle average is a condition of an A+ setup. Volume drying up on the pullback and rising on the resumption is classic continuation. Climactic volume at an extreme is a sign of exhaustion.",
    settings: {
      s1: { label: "Average", value: "20 candles" },
      s2: { label: "Highlight", value: "> 2× average" },
    },
    signals: {
      long: "Volume rises on the way up and dries up on the pullback",
      short: "Climactic volume at the high + long wick",
      avoid: "Below-average volume — no interest",
    },
    pitfalls: {
      p1: "Comparing morning candle volume with midday candles",
      p2: "Mistaking opening volume for real interest",
    },
  },
  obv: {
    name: "On-balance volume",
    timeframe: "Daily for swings, 1H intraday",
    summary: "Cumulative volume: a divergence with price is an early signal.",
    deskUse: "A swing filter: OBV making a new high before price signals accumulation — put the stock on the watchlist. Of little use intraday.",
    settings: {
      s1: { label: "Timeframe", value: "Daily" },
      s2: { label: "Smoothing", value: "20 EMA of OBV" },
    },
    signals: {
      long: "OBV makes a new high before price",
      short: "Price rises while OBV falls",
      avoid: "OBV is flat",
    },
    pitfalls: {
      p1: "Looking at the absolute OBV value",
      p2: "Using it on minute charts",
    },
  },
  gap: {
    name: "Gap",
    timeframe: "1–5 min at the open, daily for context",
    summary: "A price gap at the open: gap & go or gap fill — the main story of the morning.",
    deskUse: "The morning scanner: gap ≥ 4% + catalyst + RVOL. Gap & go — PMH and VWAP hold; gap fade — rejection at daily resistance. Overnight, a gap is a risk: cut the size you hold to the gap-risk limit.",
    settings: {
      s1: { label: "Threshold", value: "≥ 4% (large caps ≥ 2%)" },
      s2: { label: "Filter", value: "catalyst + RVOL ≥ 2" },
      s3: { label: "Gap risk", value: "≈ 1–2 daily ATR on earnings" },
    },
    signals: {
      long: "Gap up on news, PMH and VWAP hold",
      short: "Gap into daily resistance, VWAP lost — fade",
      avoid: "A gap with no news and no volume",
    },
    pitfalls: {
      p1: "Shorting a gap with a strong catalyst in the first minutes",
      p2: "Holding full size through earnings",
    },
  },
  "flag-pennant": {
    name: "Flag and pennant",
    timeframe: "1–5 min intraday, daily for swings",
    summary: "A pause after an impulse — continuation in the direction of the pole.",
    deskUse: "A 1–2 min bull flag after the morning impulse is the most common momentum entry: stop below the flag, target the length of the pole. In swings — a high tight flag in growth leaders.",
    settings: {
      s1: { label: "Pole", value: "≥ 2 ATR (5 min)" },
      s2: { label: "Pullback", value: "≤ 50% of the pole" },
      s3: { label: "Volume", value: "dries up in the flag" },
    },
    signals: {
      long: "Break of the flag's upper edge on volume above VWAP",
      short: "Bear flag below VWAP, break down",
      avoid: "Pullback deeper than 50% — the flag is broken",
    },
    pitfalls: {
      p1: "Calling any pause without an impulse a flag",
      p2: "Entering before the break",
    },
  },
  hammer: {
    name: "Hammer / shooting star",
    timeframe: "5–15 min intraday, daily for swings",
    summary: "A long lower wick at a level — sellers rejected.",
    deskUse: "A signal only at a level: a hammer at daily support or VWAP on volume — enter above the candle's high, stop below the wick. Without a level it's just a candle.",
    settings: {
      s1: { label: "Wick", value: "≥ 2× the body" },
      s2: { label: "Context", value: "after a decline, at a level" },
    },
    signals: {
      long: "Hammer at support + break of the candle high",
      short: "Shooting star at resistance + break of the low",
      avoid: "A candle in the middle of the range",
    },
    pitfalls: {
      p1: "Trading the candle without a level and volume",
      p2: "Stop inside the wick",
    },
  },
  engulfing: {
    name: "Engulfing",
    timeframe: "15 min to daily",
    summary: "The candle body covers the previous one — a change of control.",
    deskUse: "On the daily, a bullish engulfing at the 50 SMA after a pullback is a swing entry with a stop below the pattern. Intraday it's useful on the 15 min at HOD/LOD.",
    settings: {
      s1: { label: "Condition", value: "body covers the previous body" },
      s2: { label: "Volume", value: "above average" },
    },
    signals: {
      long: "Bullish engulfing at LOD/support",
      short: "Bearish engulfing at HOD/resistance",
      avoid: "Engulfing inside a range",
    },
    pitfalls: {
      p1: "Ignoring the candle's size relative to ATR",
      p2: "Entering before the candle closes",
    },
  },
  doji: {
    name: "Doji",
    timeframe: "5 min to daily",
    summary: "Indecision: open ≈ close.",
    deskUse: "On the desk it's a warning, not an entry: a doji at an extreme after a stretch is a reason to tighten the stop or take partial profit.",
    settings: {
      s1: { label: "Body", value: "≤ 10% of the range" },
    },
    signals: {
      long: "Doji at support + a bullish candle next",
      short: "Doji at resistance + a bearish candle next",
      avoid: "Doji in the middle of a move",
    },
    pitfalls: {
      p1: "Trading a doji as a standalone signal",
    },
  },
  "head-shoulders": {
    name: "Head and shoulders",
    timeframe: "1H to daily",
    summary: "A reversal after a trend: the neckline breaks.",
    deskUse: "A swing short after the neckline breaks and the retest fails. Intraday it shows up on the 5 min after a stretched day, but it's less reliable.",
    settings: {
      s1: { label: "Target", value: "head height from the neckline" },
      s2: { label: "Confirmation", value: "close below the neckline on volume" },
    },
    signals: {
      long: "Inverse H&S + neckline break",
      short: "H&S + neckline break down and retest",
      avoid: "The pattern isn't complete",
    },
    pitfalls: {
      p1: "Entering before the neckline breaks",
      p2: "Seeing the pattern everywhere",
    },
  },
  "double-top-bottom": {
    name: "Double top / bottom",
    timeframe: "15 min to daily",
    summary: "Two tests of an extreme — a failure to continue the trend.",
    deskUse: "Intraday: a second test of HOD on lower volume + VWAP lost — short. A double bottom on the daily at a level — swing long.",
    settings: {
      s1: { label: "Tolerance", value: "tops within 0.2 ATR" },
      s2: { label: "Confirmation", value: "break of the midpoint" },
    },
    signals: {
      long: "Double bottom + midpoint break",
      short: "Double top + VWAP lost",
      avoid: "Second test on higher volume — it may break through",
    },
    pitfalls: {
      p1: "Shorting the second test before confirmation",
    },
  },
} satisfies Messages<typeof ru>;
