import { pgTable, text, serial, timestamp, jsonb, integer, numeric, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const warRoomSessionsTable = pgTable("war_room_sessions", {
  id: serial("id").primaryKey(),
  trader: text("trader"),
  eventName: text("event_name").notNull(),
  eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
  notes: text("notes"),
  checklist: jsonb("checklist").$type<{ text: string; done: boolean }[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, (table) => [
  index("war_room_sessions_trader_idx").on(table.trader),
  index("war_room_sessions_created_at_idx").on(table.createdAt),
]);

export const warRoomLevelsTable = pgTable("war_room_levels", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => warRoomSessionsTable.id, { onDelete: "cascade" }),
  ticker: text("ticker").notNull(),
  price: numeric("price", { precision: 12, scale: 4 }).notNull(),
  label: text("label").notNull(),
  type: text("type").notNull(),
}, (table) => [
  index("war_room_levels_session_idx").on(table.sessionId),
]);

export const insertWarRoomSessionSchema = createInsertSchema(warRoomSessionsTable).omit({ id: true, createdAt: true, endedAt: true });
export type InsertWarRoomSession = z.infer<typeof insertWarRoomSessionSchema>;
export type WarRoomSession = typeof warRoomSessionsTable.$inferSelect;

export const insertWarRoomLevelSchema = createInsertSchema(warRoomLevelsTable).omit({ id: true });
export type InsertWarRoomLevel = z.infer<typeof insertWarRoomLevelSchema>;
export type WarRoomLevel = typeof warRoomLevelsTable.$inferSelect;
