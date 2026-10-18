import { pgTable, text, serial, timestamp, integer, jsonb, boolean, index } from "drizzle-orm/pg-core";

export const tradingRulesTable = pgTable("trading_rules", {
  id: serial("id").primaryKey(),
  trader: text("trader").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  threshold: jsonb("threshold").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("trading_rules_trader_idx").on(table.trader),
]);

export const ruleViolationsTable = pgTable("rule_violations", {
  id: serial("id").primaryKey(),
  trader: text("trader").notNull(),
  ruleId: integer("rule_id").notNull().references(() => tradingRulesTable.id, { onDelete: "cascade" }),
  tradeId: integer("trade_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  severity: text("severity").notNull().default("medium"),
  message: text("message").notNull(),
  details: jsonb("details"),
}, (table) => [
  index("rule_violations_trader_idx").on(table.trader),
  index("rule_violations_rule_idx").on(table.ruleId),
  index("rule_violations_occurred_idx").on(table.occurredAt),
]);

export type TradingRule = typeof tradingRulesTable.$inferSelect;
export type RuleViolation = typeof ruleViolationsTable.$inferSelect;
