import { pgTable, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";
import { tradesTable } from "./trades";

export const tradingErrorsTable = pgTable("trading_errors", {
  id: serial("id").primaryKey(),
  trader: text("trader").notNull(),
  errorType: text("error_type").notNull(),
  description: text("description").notNull(),
  ticker: text("ticker"),
  tradeId: integer("trade_id").references(() => tradesTable.id),
  severity: text("severity").notNull().default("medium"),
  lesson: text("lesson"),
  resolved: text("resolved").notNull().default("no"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("trading_errors_trader_idx").on(table.trader),
  index("trading_errors_trade_id_idx").on(table.tradeId),
  index("trading_errors_created_at_idx").on(table.createdAt),
]);

export type TradingError = typeof tradingErrorsTable.$inferSelect;
