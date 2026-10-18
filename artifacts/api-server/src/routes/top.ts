// «Топ дня» — the desk's best and worst trader-days (lib/topDay.ts, lib/topDayStore.ts).
//
//   GET /top/calendar?month=YYYY-MM          per trading date: desk net, trades, traders, best / worst trader-day net
//                                            (no names), the viewer's own net; market holidays of the month.
//   GET /top/day/:date                       top 10 trader-days by net profit and by net loss + the viewer's own day.
//   GET /top/day/:date/trader/:alias         one trader-day by its day alias: tickers, $ per ticker, side, fill times.
//
// Signed-in members (trades.read.own). Names: staff always; traders only when privacy.hideNamesFromTraders is off (then
// other traders' $ is hidden — lib/playbookPrivacy). The alias is resolved here; a trader never receives a real name
// in the anonymous mode. Aliases: lib/deskDayStore.loadDayAliases — one source with the desk-day chart.
import { Router, type IRouter } from "express";
import { z } from "zod";
import { parseDateStrict } from "../lib/candleDay";
import { loadMoneyViewer } from "../lib/playbookAccess";
import { setting } from "../lib/settings/registry";
import { buildCalendar, buildTopDay, buildTraderDay, topMode } from "../lib/topDay";
import { loadCalendarRows, loadDayRows, loadDaySideRows } from "../lib/topDayStore";
import { loadDayAliases } from "../lib/deskDayStore";
import { notFound, route } from "../lib/http";

const router: IRouter = Router();

const CAP = "trades.read.own" as const;
const daySchema = z.string().refine((s) => parseDateStrict(s) != null, "YYYY-MM-DD");
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM");

router.get("/top/calendar", route({
  cap: CAP,
  query: z.object({ month: monthSchema }),
}, async ({ query, req, res }) => {
  res.setHeader("Cache-Control", "private, no-cache");
  const viewer = await loadMoneyViewer(req);
  const { rows, holidays } = await loadCalendarRows(query.month, viewer.name);
  return buildCalendar(query.month, rows, holidays, topMode(viewer, setting("privacy.hideNamesFromTraders")));
}));

router.get("/top/day/:date", route({
  cap: CAP,
  params: z.object({ date: daySchema }),
}, async ({ params, req, res }) => {
  res.setHeader("Cache-Control", "private, no-cache");
  const viewer = await loadMoneyViewer(req);
  const [rows, aliases] = await Promise.all([loadDayRows(params.date), loadDayAliases(params.date)]);
  return buildTopDay(params.date, rows, viewer, topMode(viewer, setting("privacy.hideNamesFromTraders")), undefined, aliases);
}));

router.get("/top/day/:date/trader/:alias", route({
  cap: CAP,
  params: z.object({ date: daySchema, alias: z.coerce.number().int().min(1).max(1000) }),
}, async ({ params, req, res }) => {
  res.setHeader("Cache-Control", "private, no-cache");
  const viewer = await loadMoneyViewer(req);
  const [rows, aliases] = await Promise.all([loadDaySideRows(params.date), loadDayAliases(params.date)]);
  const day = buildTraderDay(params.date, params.alias, rows, viewer, topMode(viewer, setting("privacy.hideNamesFromTraders")), aliases);
  if (!day) throw notFound();
  return day;
}));

export default router;
