import { createNamespace } from "..";
import ru from "../locales/ru/gamePlan";

/** «План дня» (pages/game-plan.tsx, components/game-plan/*). */
export const gpI18n = createNamespace("gamePlan", ru, {
  en: () => import("../locales/en/gamePlan"),
  uz: () => import("../locales/uz/gamePlan"),
});
