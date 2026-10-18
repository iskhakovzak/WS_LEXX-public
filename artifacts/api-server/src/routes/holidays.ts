import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { AppError } from "../lib/http";
import { localizeCalendarRow } from "../lib/calendarText";
import { langOf } from "../i18n";

const router: IRouter = Router();

function nyToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

router.get("/holidays", asyncHandler(async (req, res): Promise<void> => {
  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const to = typeof req.query.to === "string" ? req.query.to.trim() : "";
  // Validate before hitting SQL: a malformed date used to surface as a 500 from Postgres.
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) throw new AppError("INVALID_RANGE", undefined, { max: 400 });
  if (from && to && from > to) throw new AppError("INVALID_RANGE", undefined, { max: 400 });
  // Optional comma-separated type filter, e.g. ?types=fomc,cpi
  const types = typeof req.query.types === "string"
    ? req.query.types.split(",").map((t) => t.trim().toLowerCase()).filter((t) => /^[a-z0-9_]{1,32}$/.test(t)).slice(0, 20)
    : [];
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (from) { params.push(from); conditions.push(`date >= $${params.length}`); }
  if (to) { params.push(to); conditions.push(`date <= $${params.length}`); }
  if (types.length) { params.push(types); conditions.push(`lower(type) = ANY($${params.length}::text[])`); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT id, date, type, name, description, importance FROM holiday_calendar ${where} ORDER BY date ASC, CASE importance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END ASC`,
    params
  );
  const lang = langOf(req);
  res.json({ events: rows.map((r) => localizeCalendarRow(r, lang)) });
}));

router.get("/holidays/today", asyncHandler(async (req, res): Promise<void> => {
  const today = nyToday();
  const { rows } = await pool.query(
    `SELECT id, date, type, name, description, importance FROM holiday_calendar WHERE date = $1 ORDER BY CASE importance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END ASC`,
    [today]
  );
  const upcoming = await pool.query(
    `SELECT id, date, type, name, description, importance FROM holiday_calendar WHERE date > $1 AND date <= $2 ORDER BY date ASC, CASE importance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END ASC LIMIT 10`,
    [today, new Date(new Date(today + "T12:00:00Z").getTime() + 14 * 86400_000).toISOString().slice(0, 10)]
  );
  const lang = langOf(req);
  res.json({ today: rows.map((r) => localizeCalendarRow(r, lang)), upcoming: upcoming.rows.map((r) => localizeCalendarRow(r, lang)) });
}));

export default router;
