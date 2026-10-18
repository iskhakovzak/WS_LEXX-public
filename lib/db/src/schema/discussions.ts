import { pgTable, text, serial, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const discussionsTable = pgTable("discussions", {
  id: serial("id").primaryKey(),
  topic: text("topic").notNull(),
  type: text("type"),
  trader: text("trader"),
  ticker: text("ticker"),
  notes: text("notes"),
  tags: text("tags"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  index("discussions_trader_idx").on(table.trader),
  index("discussions_ticker_idx").on(table.ticker),
  index("discussions_created_at_idx").on(table.createdAt),
]);

export const commentsTable = pgTable("comments", {
  id: serial("id").primaryKey(),
  discussionId: integer("discussion_id").notNull().references(() => discussionsTable.id),
  trader: text("trader"),
  text: text("text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("comments_discussion_id_idx").on(table.discussionId),
  index("comments_trader_idx").on(table.trader),
  index("comments_created_at_idx").on(table.createdAt),
]);

export const discussionVotesTable = pgTable("discussion_votes", {
  id: serial("id").primaryKey(),
  discussionId: integer("discussion_id").notNull().references(() => discussionsTable.id),
  trader: text("trader").notNull(),
  value: integer("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("discussion_votes_unique").on(table.discussionId, table.trader),
  index("discussion_votes_discussion_idx").on(table.discussionId),
]);

export const insertDiscussionSchema = createInsertSchema(discussionsTable).omit({
  id: true,
  createdAt: true,
});
export const insertCommentSchema = createInsertSchema(commentsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertDiscussion = z.infer<typeof insertDiscussionSchema>;
export type InsertComment = z.infer<typeof insertCommentSchema>;
export type Discussion = typeof discussionsTable.$inferSelect;
export type Comment = typeof commentsTable.$inferSelect;
export type DiscussionVote = typeof discussionVotesTable.$inferSelect;
