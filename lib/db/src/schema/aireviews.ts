import { pgTable, serial, text, timestamp, integer, numeric, index, jsonb } from "drizzle-orm/pg-core";

export const aiTradeReviewsTable = pgTable("ai_trade_reviews", {
  id: serial("id").primaryKey(),
  tradeId: integer("trade_id").notNull(),
  model: text("model").notNull(),
  promptHash: text("prompt_hash").notNull(),
  reviewText: text("review_text").notNull(),
  sections: jsonb("sections"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ai_trade_reviews_trade_idx").on(t.tradeId),
  index("ai_trade_reviews_generated_at_idx").on(t.generatedAt),
]);

export type AiTradeReview = typeof aiTradeReviewsTable.$inferSelect;

export const aiReviewRateLimitTable = pgTable("ai_review_rate_limit", {
  id: serial("id").primaryKey(),
  userKey: text("user_key").notNull(),
  tradeId: integer("trade_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ai_review_rate_user_idx").on(t.userKey),
  index("ai_review_rate_created_idx").on(t.createdAt),
]);
