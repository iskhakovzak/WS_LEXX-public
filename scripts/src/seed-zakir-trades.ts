import { db, tradesTable, pool } from "@workspace/db";
import { and, isNull, sql } from "drizzle-orm";

const ZAKIR = "Закир";

const TICKERS = [
  "AAPL", "TSLA", "NVDA", "AMD", "META", "GOOGL", "MSFT", "AMZN",
  "ADBE", "NFLX", "COIN", "SHOP", "PLTR", "RIVN", "SOFI", "MARA",
  "RIOT", "AFRM", "SNAP", "UBER", "PYPL", "ROKU", "SQ", "ZS",
];
const SETUPS = ["breakout", "vwap", "opg", "reversal", "pullback", "gap-and-go"];
const SIDES = ["Long", "Short"];
const SESSIONS = ["pre-market", "morning", "midday", "afternoon"];
const TAGS = [
  "Earnings", "Gap Up", "Gap Down", "Breakout", "All Time High",
  "Pricing", "Offering", "Catalyst", "Squeeze", "FOMC",
];
const SECTORS = ["Tech", "Energy", "Healthcare", "Financials", "Consumer", "Communications"];

function rand<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min: number, max: number): number { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFloat(min: number, max: number, dp = 2): number {
  const v = Math.random() * (max - min) + min;
  return Number(v.toFixed(dp));
}

function isWeekday(d: Date): boolean {
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  if (process.env.SEED_ZAKIR_CONFIRM !== "yes") {
    console.error(
      "[seed] DESTRUCTIVE: this script soft-deletes all non-Zakir trades and replaces existing Zakir trades.\n" +
      "       Re-run with SEED_ZAKIR_CONFIRM=yes to proceed."
    );
    process.exit(2);
  }
  console.log("[seed] cleanup: soft-deleting all non-Zakir trades…");
  const cleanup = await db
    .update(tradesTable)
    .set({ deletedAt: new Date() })
    .where(and(
      isNull(tradesTable.deletedAt),
      sql`(${tradesTable.trader} IS NULL OR ${tradesTable.trader} <> ${ZAKIR})`,
    ))
    .returning({ id: tradesTable.id });
  console.log(`[seed]   soft-deleted ${cleanup.length} non-Zakir trades`);

  console.log("[seed] cleanup: soft-deleting existing Zakir trades for clean test set…");
  const wipeZ = await db
    .update(tradesTable)
    .set({ deletedAt: new Date() })
    .where(and(isNull(tradesTable.deletedAt), sql`${tradesTable.trader} = ${ZAKIR}`))
    .returning({ id: tradesTable.id });
  console.log(`[seed]   soft-deleted ${wipeZ.length} existing Zakir trades`);

  console.log("[seed] inserting 50 Zakir trades over the last 90 days…");

  const now = new Date();
  const dates: string[] = [];
  for (let i = 0; i < 90 && dates.length < 50; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    if (isWeekday(d)) dates.push(dateStr(d));
  }
  while (dates.length < 50) dates.push(dates[dates.length - 1]);

  let winCount = 0;
  let lossCount = 0;

  for (let i = 0; i < 50; i++) {
    const ticker = rand(TICKERS);
    const date = dates[i];
    const side = rand(SIDES);
    const setup = rand(SETUPS);
    const session = rand(SESSIONS);
    const sector = rand(SECTORS);

    const isWin = Math.random() < 0.6;
    const result = isWin ? "win" : "loss";
    if (isWin) winCount++; else lossCount++;

    const entry = randFloat(20, 400);
    const stopDelta = randFloat(0.2, 2.5);
    const stop = side === "Long" ? entry - stopDelta : entry + stopDelta;
    const r = isWin ? randFloat(0.5, 4.0) : -randFloat(0.3, 1.2);
    const exit = side === "Long" ? entry + r * stopDelta : entry - r * stopDelta;
    const shares = randInt(50, 500);
    const pnl = Number(((side === "Long" ? exit - entry : entry - exit) * shares).toFixed(2));

    const tagPool: string[] = [];
    const tagN = randInt(1, 3);
    for (let k = 0; k < tagN; k++) tagPool.push(rand(TAGS));
    const tags = Array.from(new Set(tagPool)).join(", ");

    await db.insert(tradesTable).values({
      ticker,
      date,
      setup,
      side,
      result,
      pnl: String(pnl),
      rMultiple: String(r),
      entry: String(entry),
      exit: String(exit.toFixed(2)),
      stop: String(stop.toFixed(2)),
      session,
      sector,
      trader: ZAKIR,
      tags,
      holdTime: `${randInt(1, 240)}m`,
      notes: `Auto-seeded ${setup} ${side} on ${ticker}.`,
    });
  }

  console.log(`[seed] done — inserted 50 trades for ${ZAKIR} (wins=${winCount}, losses=${lossCount}).`);
  await pool.end();
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
