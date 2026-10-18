import { createNamespace } from "..";
import ru from "../locales/ru/rules";

/** /rules (/error-tracker): rules, violations, mistake log, discipline calendar. */
export const rulesI18n = createNamespace("rules", ru, {
  en: () => import("../locales/en/rules"),
  uz: () => import("../locales/uz/rules"),
});
