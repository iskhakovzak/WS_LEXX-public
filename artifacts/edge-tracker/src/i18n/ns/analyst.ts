import { createNamespace } from "..";
import ru from "../locales/ru/analyst";

/** /analyst-actions — «Рейтинги аналитиков» (components/analyst/*, pages/analyst-actions.tsx). */
export const analystI18n = createNamespace("analyst", ru, {
  en: () => import("../locales/en/analyst"),
  uz: () => import("../locales/uz/analyst"),
});
