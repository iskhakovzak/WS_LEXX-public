import { createNamespace } from "..";
import ru from "../locales/ru/risk";

/** /risk: risk desk, overnight & swing book, «Мой риск», trader card, limits form. */
export const riskI18n = createNamespace("risk", ru, {
  en: () => import("../locales/en/risk"),
  uz: () => import("../locales/uz/risk"),
});
