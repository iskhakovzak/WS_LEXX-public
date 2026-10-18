import { createNamespace } from "..";
import ru from "../locales/ru/behavior";

/** /behavior — behaviour patterns, discipline, triggers, setup classifier (pages/behavior.tsx, components/behavior/*). */
export const behaviorI18n = createNamespace("behavior", ru, {
  en: () => import("../locales/en/behavior"),
  uz: () => import("../locales/uz/behavior"),
});
