import { createNamespace } from "..";
import ru from "../locales/ru/academyCohorts";

/** «Академия» → когорты, наставник, «Моё обучение» (components/academy/cohorts/*, pages/academy/{cohorts,mentor,my}.tsx). */
export const academyCohortsI18n = createNamespace("academyCohorts", ru, {
  en: () => import("../locales/en/academyCohorts"),
  uz: () => import("../locales/uz/academyCohorts"),
});
