import { createNamespace } from "..";
import ru from "../locales/ru/checklist";

/** Pre-trade checklist (trade form) and its template editor (Settings → Trading). */
export const checklistI18n = createNamespace("checklist", ru, {
  en: () => import("../locales/en/checklist"),
  uz: () => import("../locales/uz/checklist"),
});
