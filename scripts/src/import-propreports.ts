import { db, tradesTable, pool } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { parsePropReportsFile, type PropReportsTrade } from "./lib/parse-propreports.js";

const TRADER = "Закир";

function dedupKey(t: PropReportsTrade): string {
  return `${t.date}|${t.ticker}|${t.side}|${t.openedAt}|${t.entry}|${t.exit}|${t.qty}`;
}

async function main(): Promise<void> {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: tsx scripts/src/import-propreports.ts <path-to-xls> [--dry-run] [--trader=Name]");
    process.exit(2);
  }
  const dryRun = process.argv.includes("--dry-run");
  const traderArg = process.argv.find((a) => a.startsWith("--trader="));
  const trader = traderArg ? traderArg.slice("--trader=".length) : TRADER;

  console.log(`[propreports] parsing: ${filePath}`);
  const parsed = parsePropReportsFile(filePath);
  console.log(`[propreports] parsed trades: ${parsed.length}`);
  if (parsed.length === 0) {
    console.log("[propreports] nothing to import");
    process.exit(0);
  }

  const dates = [...new Set(parsed.map((t) => t.date))].sort();
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  console.log(`[propreports] date range: ${minDate} … ${maxDate}  (${dates.length} trading days)`);

  const existing = await db
    .select({
      id: tradesTable.id,
      ctx: tradesTable.contextSnapshot,
    })
    .from(tradesTable)
    .where(and(
      isNull(tradesTable.deletedAt),
      eq(tradesTable.trader, trader),
      sql`${tradesTable.date} >= ${minDate}`,
      sql`${tradesTable.date} <= ${maxDate}`,
      sql`${tradesTable.contextSnapshot} ->> 'source' = 'propreports'`,
    ));
  const existingKeys = new Set<string>();
  for (const e of existing) {
    const ctx = e.ctx as { dedupKey?: string } | null;
    if (ctx?.dedupKey) existingKeys.add(ctx.dedupKey);
  }
  console.log(`[propreports] existing PropReports trades in range for ${trader}: ${existing.length}`);

  const toInsert = parsed.filter((t) => !existingKeys.has(dedupKey(t)));
  const skipped = parsed.length - toInsert.length;
  console.log(`[propreports] new: ${toInsert.length}  duplicates skipped: ${skipped}`);

  let totalNet = 0;
  let wins = 0;
  for (const t of parsed) { totalNet += t.net; if (t.net >= 0) wins++; }
  console.log(`[propreports] file totals → net P&L: $${totalNet.toFixed(2)}  win rate: ${((wins / parsed.length) * 100).toFixed(1)}%`);

  if (dryRun) {
    console.log("[propreports] --dry-run set, not inserting");
    console.log("[propreports] sample of first 3 to insert:");
    for (const t of toInsert.slice(0, 3)) {
      console.log("  ", t.date, t.ticker, t.side, `entry=${t.entry} exit=${t.exit} qty=${t.qty} net=${t.net} (${t.session})`);
    }
    process.exit(0);
  }

  if (toInsert.length === 0) {
    console.log("[propreports] all trades already imported, nothing to do");
    process.exit(0);
  }

  const rows = toInsert.map((t) => ({
    ticker: t.ticker,
    date: t.date,
    side: t.side,
    entry: String(t.entry),
    exit: String(t.exit),
    pnl: String(t.net.toFixed(2)),
    holdTime: t.holdTime,
    result: t.result,
    session: t.session,
    trader,
    notes: `PropReports import • qty ${t.qty} • opened ${t.openedAt.replace("T", " ")} ET`,
    contextSnapshot: {
      source: "propreports",
      dedupKey: dedupKey(t),
      openedAt: t.openedAt,
      closedTime: t.closedTime,
      heldRaw: t.heldRaw,
      qty: t.qty,
      gross: t.gross,
      totalFees: t.totalFees,
      net: t.net,
    },
  }));

  console.log(`[propreports] inserting ${rows.length} trades…`);
  const CHUNK = 200;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const r = await db.insert(tradesTable).values(chunk).returning({ id: tradesTable.id });
    inserted += r.length;
    console.log(`[propreports]   inserted ${inserted}/${rows.length}`);
  }
  console.log(`[propreports] done: inserted ${inserted}, skipped duplicates ${skipped}`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(async () => { await pool.end(); });
