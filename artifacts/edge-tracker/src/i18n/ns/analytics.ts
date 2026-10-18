import { createNamespace } from "..";
import ru from "../locales/ru/analytics";

/** /analytics — overview, edge, matrix, compact what-if, Monte Carlo, desk, psychology (components/analytics-page/*). */
export const analyticsI18n = createNamespace("analytics", ru, {
  en: () => import("../locales/en/analytics"),
  uz: () => import("../locales/uz/analytics"),
});
