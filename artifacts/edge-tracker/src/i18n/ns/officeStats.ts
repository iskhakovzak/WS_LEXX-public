import { createNamespace } from "..";
import ru from "../locales/ru/officeStats";

/** «Статистика офиса» (pages/office-stats.tsx, components/office-stats/*). */
export const officeI18n = createNamespace("officeStats", ru, {
  en: () => import("../locales/en/officeStats"),
  uz: () => import("../locales/uz/officeStats"),
});
