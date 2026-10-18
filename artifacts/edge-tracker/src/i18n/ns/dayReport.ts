import { createNamespace } from "..";
import ru from "../locales/ru/dayReport";

/** Day review (/day-report): KPI header, intraday curve, timeline, breakdowns, leaks, strengths, plan, comparison. */
export const dayReportI18n = createNamespace("dayReport", ru, {
  en: () => import("../locales/en/dayReport"),
  uz: () => import("../locales/uz/dayReport"),
});
