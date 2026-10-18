import {
  pgTable,
  text,
  serial,
  timestamp,
  numeric,
  integer,
  index,
  jsonb,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { eventsTable } from "./events";
import { researchTable } from "./research";

export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  date: text("date").notNull(),
  setup: text("setup"),
  side: text("side"),
  eventType: text("event_type"),
  entry: numeric("entry", { precision: 12, scale: 4 }),
  exit: numeric("exit", { precision: 12, scale: 4 }),
  stop: numeric("stop", { precision: 12, scale: 4 }),
  result: text("result").notNull(),
  pnl: numeric("pnl", { precision: 14, scale: 4 }), // 4 dp: broker fees go to $0.0001 (audit P0-1)
  rMultiple: numeric("r_multiple", { precision: 8, scale: 2 }),
  holdTime: text("hold_time"),
  slippage: numeric("slippage", { precision: 8, scale: 2 }),
  marketCap: text("market_cap"),
  float: text("float"),
  relativeVolume: numeric("relative_volume", { precision: 8, scale: 2 }),
  atr: numeric("atr", { precision: 12, scale: 4 }),
  sector: text("sector"),
  session: text("session"),
  screenshotUrl: text("screenshot_url"),
  screenshotNotes: text("screenshot_notes"),
  notes: text("notes"),
  whatWorked: text("what_worked"),
  whatFailed: text("what_failed"),
  conclusion: text("conclusion"),
  trader: text("trader"),
  tags: text("tags"),
  eventId: integer("event_id").references(() => eventsTable.id),
  patternId: integer("pattern_id").references(() => researchTable.id),
  playbookId: integer("playbook_id"),
  beta: numeric("beta", { precision: 8, scale: 4 }),
  shortInterest: numeric("short_interest", { precision: 8, scale: 4 }),
  adv: text("adv"),
  longName: text("long_name"),
  contextSnapshot: jsonb("context_snapshot"),
  setupScore: numeric("setup_score", { precision: 5, scale: 2 }),
  conviction: integer("conviction"),
  confidenceGrade: text("confidence_grade"),
  // Prop-desk: 'intraday' | 'overnight' | 'swing'; exitDate set for multi-day holds.
  horizon: text("horizon"),
  exitDate: text("exit_date"),
  qty: numeric("qty", { precision: 14, scale: 2 }),
  fees: numeric("fees", { precision: 14, scale: 4 }),
  riskUsd: numeric("risk_usd", { precision: 12, scale: 2 }),
  // Broker integration (PropReports): 'manual' | 'propreports' (null ⇒ manual); stable round-trip key;
  // broker account display name; last sync timestamp. Unique partial index on (source, external_id).
  source: text("source"),
  externalId: text("external_id"),
  brokerAccount: text("broker_account"),
  syncedAt: timestamp("synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  index("trades_ticker_idx").on(table.ticker),
  index("trades_date_idx").on(table.date),
  index("trades_trader_idx").on(table.trader),
  index("trades_created_at_idx").on(table.createdAt),
  index("trades_event_id_idx").on(table.eventId),
  index("trades_pattern_id_idx").on(table.patternId),
  index("trades_playbook_id_idx").on(table.playbookId),
  check("trades_conviction_range", sql`${table.conviction} IS NULL OR (${table.conviction} >= 1 AND ${table.conviction} <= 5)`),
  check("trades_confidence_grade_enum", sql`${table.confidenceGrade} IS NULL OR ${table.confidenceGrade} IN ('A+', 'A', 'B', 'C')`),
]);

export const insertTradeSchema = createInsertSchema(tradesTable).omit({
  id: true,
  createdAt: true,
  deletedAt: true,
});
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;

// Multi-fill executions: 1 trade can have many fills (initial entry, scale-ins,
// partial exits, final exit, stop-out). Renders as separate markers on the chart.
export const tradeExecutionsTable = pgTable("trade_executions", {
  id: serial("id").primaryKey(),
  tradeId: integer("trade_id").notNull().references(() => tradesTable.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // 'entry' | 'add' | 'trim' | 'exit' | 'stop'
  price: numeric("price", { precision: 12, scale: 4 }).notNull(),
  qty: numeric("qty", { precision: 12, scale: 2 }),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  note: text("note"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("trade_executions_trade_idx").on(table.tradeId),
  check("trade_executions_kind_enum", sql`${table.kind} IN ('entry', 'add', 'trim', 'exit', 'stop')`),
]);

export type TradeExecution = typeof tradeExecutionsTable.$inferSelect;
