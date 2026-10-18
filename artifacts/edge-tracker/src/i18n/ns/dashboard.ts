import { createNamespace } from "..";
import ru from "../locales/ru/dashboard";

/** Dashboard (/): header, «what matters now», equity, recent trades, desk today, streaks, positions, customize. */
export const dashboardI18n = createNamespace("dashboard", ru, {
  en: () => import("../locales/en/dashboard"),
  uz: () => import("../locales/uz/dashboard"),
});
