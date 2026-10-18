import { createNamespace } from "..";
import ru from "../locales/ru/weeklyReview";

/** «Отчёт недели» (pages/weekly-review.tsx, components/weekly-review/*, lib/weeklyInsights.ts) + «Психология недели» widget. */
export const weeklyI18n = createNamespace("weeklyReview", ru, {
  en: () => import("../locales/en/weeklyReview"),
  uz: () => import("../locales/uz/weeklyReview"),
});
