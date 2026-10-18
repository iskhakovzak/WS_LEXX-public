import { createNamespace } from "..";
import ru from "../locales/ru/analyticsPro";

/** The «Pro» tab of /analytics (components/analytics/*, lib/analytics-pro.ts). */
export const analyticsProI18n = createNamespace("analyticsPro", ru, {
  en: () => import("../locales/en/analyticsPro"),
  uz: () => import("../locales/uz/analyticsPro"),
});
