import { createNamespace } from "..";
import ru from "../locales/ru/daily";

/** Daily loop: dashboard day line (focus, contract, evening card, tier progress), own rule in the plan, mistake labels. */
export const dailyI18n = createNamespace("daily", ru, {
  en: () => import("../locales/en/daily"),
  uz: () => import("../locales/uz/daily"),
});
