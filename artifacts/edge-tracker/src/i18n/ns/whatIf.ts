import { createNamespace } from "..";
import ru from "../locales/ru/whatIf";

/** /what-if — the «Что если» simulator (pages/what-if.tsx, components/what-if/*). */
export const whatIfI18n = createNamespace("whatIf", ru, {
  en: () => import("../locales/en/whatIf"),
  uz: () => import("../locales/uz/whatIf"),
});
