import { createNamespace } from "..";
import ru from "../locales/ru/chart";

/** Trade charts: full-day / trade-window zoom, bar-size notes (chart-engine, trade card chart). */
export const chartI18n = createNamespace("chart", ru, {
  en: () => import("../locales/en/chart"),
  uz: () => import("../locales/uz/chart"),
});
