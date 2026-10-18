import { createNamespace } from "..";
import ru from "../locales/ru/stats";

/** /stats — the period report card (pages/stats.tsx, components/stats/*). */
export const statsI18n = createNamespace("stats", ru, {
  en: () => import("../locales/en/stats"),
  uz: () => import("../locales/uz/stats"),
});
