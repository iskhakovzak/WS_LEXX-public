import { createNamespace } from "..";
import ru from "../locales/ru/simulator";

/** /simulator — the chart game (components/sim/*, pages/simulator.tsx). */
export const simI18n = createNamespace("simulator", ru, {
  en: () => import("../locales/en/simulator"),
  uz: () => import("../locales/uz/simulator"),
});
