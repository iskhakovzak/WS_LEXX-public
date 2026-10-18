import { pgTable, serial, text, timestamp, numeric, jsonb, index, uniqueIndex, boolean } from "drizzle-orm/pg-core";

export const candlesCacheTable = pgTable("candles_cache", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  date: text("date").notNull(),
  interval: text("interval").notNull(),
  extended: boolean("extended").notNull().default(false),
  ohlcv: jsonb("ohlcv").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tickerIdx: index("candles_cache_ticker_idx").on(t.ticker),
  uniq: uniqueIndex("candles_cache_unique").on(t.ticker, t.date, t.interval, t.extended),
}));

export const tickerDataCacheTable = pgTable("ticker_data_cache", {
  ticker: text("ticker").primaryKey(),
  marketCap: text("market_cap"),
  float: text("float"),
  sharesOutstanding: text("shares_outstanding"),
  shortInterest: numeric("short_interest", { precision: 8, scale: 2 }),
  atr: numeric("atr", { precision: 12, scale: 4 }),
  relativeVolume: numeric("relative_volume", { precision: 8, scale: 2 }),
  beta: numeric("beta", { precision: 8, scale: 4 }),
  averageDailyVolume: text("average_daily_volume"),
  sector: text("sector"),
  industry: text("industry"),
  longName: text("long_name"),
  raw: jsonb("raw"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

export const newsCacheTable = pgTable("news_cache", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  guid: text("guid"),
  title: text("title").notNull(),
  source: text("source"),
  url: text("url"),
  category: text("category"),
  summary: text("summary"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  isTickerSpecific: boolean("is_ticker_specific").default(false),
}, (t) => ({
  tickerIdx: index("news_cache_ticker_idx").on(t.ticker),
  guidUnique: uniqueIndex("news_cache_ticker_guid_uniq").on(t.ticker, t.guid),
}));

export const sectorStrengthCacheTable = pgTable("sector_strength_cache", {
  symbol: text("symbol").primaryKey(),
  name: text("name"),
  price: numeric("price", { precision: 12, scale: 4 }),
  changePct: numeric("change_pct", { precision: 8, scale: 4 }),
  prevClose: numeric("prev_close", { precision: 12, scale: 4 }),
  trend5d: numeric("trend_5d", { precision: 8, scale: 4 }),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

export const holidayCalendarTable = pgTable("holiday_calendar", {
  id: serial("id").primaryKey(),
  date: text("date").notNull(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  importance: text("importance").notNull().default("medium"),
}, (t) => ({
  dateIdx: index("holiday_calendar_date_idx").on(t.date),
  typeDateUnique: uniqueIndex("holiday_calendar_unique").on(t.date, t.type, t.name),
}));

export const analystActionsCacheTable = pgTable("analyst_actions_cache", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  gradedAt: timestamp("graded_at", { withTimezone: true }).notNull(),
  firm: text("firm").notNull(),
  action: text("action").notNull(), // 'up' | 'down' | 'init' | 'main' | 'reit'
  toGrade: text("to_grade"),
  fromGrade: text("from_grade"),
  source: text("source").notNull().default("yahoo"),
  // Optional URL: news article URL (source='news') or Yahoo analysis page (source='yahoo')
  sourceUrl: text("source_url"),
  priceTarget: text("price_target"),
  priceTargetFrom: text("price_target_from"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tickerIdx: index("analyst_actions_ticker_idx").on(t.ticker),
  gradedAtIdx: index("analyst_actions_graded_at_idx").on(t.gradedAt),
  uniq: uniqueIndex("analyst_actions_unique").on(t.ticker, t.gradedAt, t.firm, t.action),
}));

export const marketBriefCacheTable = pgTable("market_open_brief_cache", {
  id: serial("id").primaryKey(),
  date: text("date").notNull().unique(),
  data: jsonb("data").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});
