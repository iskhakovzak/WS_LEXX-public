import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  boolean,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const emotionalStateLogTable = pgTable("emotional_state_log", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  date: text("date").notNull(),
  sleepWell: boolean("sleep_well").notNull().default(false),
  stressed: boolean("stressed").notNull().default(false),
  tilted: boolean("tilted").notNull().default(false),
  focused: boolean("focused").notNull().default(false),
  anxious: boolean("anxious").notNull().default(false),
  revenge: boolean("revenge").notNull().default(false),
  freeText: text("free_text"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("emotional_state_log_user_id_idx").on(table.userId),
  index("emotional_state_log_date_idx").on(table.date),
  index("emotional_state_log_user_date_idx").on(table.userId, table.date),
]);

export const insertEmotionalStateLogSchema = createInsertSchema(emotionalStateLogTable).omit({
  id: true,
  createdAt: true,
});
export type EmotionalStateLog = typeof emotionalStateLogTable.$inferSelect;
export type InsertEmotionalStateLog = z.infer<typeof insertEmotionalStateLogSchema>;

export const voiceNotesTable = pgTable("voice_notes", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  tradeId: integer("trade_id"),
  dailyFeedId: integer("daily_feed_id"),
  audioUrl: text("audio_url").notNull(),
  transcript: text("transcript"),
  durationSec: integer("duration_sec"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("voice_notes_user_id_idx").on(table.userId),
  index("voice_notes_trade_id_idx").on(table.tradeId),
  index("voice_notes_daily_feed_id_idx").on(table.dailyFeedId),
]);

export const insertVoiceNoteSchema = createInsertSchema(voiceNotesTable).omit({
  id: true,
  createdAt: true,
});
export type VoiceNote = typeof voiceNotesTable.$inferSelect;
export type InsertVoiceNote = z.infer<typeof insertVoiceNoteSchema>;

export const weeklyPsychologyReportsTable = pgTable("weekly_psychology_reports", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  weekStart: text("week_start").notNull(),
  weekEnd: text("week_end").notNull(),
  totalTrades: integer("total_trades").notNull().default(0),
  totalCheckins: integer("total_checkins").notNull().default(0),
  emotionalBreakdown: jsonb("emotional_breakdown"),
  bestState: text("best_state"),
  worstState: text("worst_state"),
  totalPnl: text("total_pnl").notNull().default("0"),
  avgPnlPerTrade: text("avg_pnl_per_trade").notNull().default("0"),
  winRate: text("win_rate").notNull().default("0"),
  keyInsights: jsonb("key_insights"),
  rawStats: jsonb("raw_stats"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("weekly_psych_reports_user_idx").on(t.userId),
  index("weekly_psych_reports_week_start_idx").on(t.weekStart),
  index("weekly_psych_reports_user_week_idx").on(t.userId, t.weekStart),
]);

export type WeeklyPsychologyReport = typeof weeklyPsychologyReportsTable.$inferSelect;
