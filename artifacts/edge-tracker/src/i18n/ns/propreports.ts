import { createNamespace } from "..";
import ru from "../locales/ru/propreports";

/** Integrations (/integrations) and the PropReports widgets: import, accounts, reconciliation, broker statistics. */
export const propreportsI18n = createNamespace("propreports", ru, {
  en: () => import("../locales/en/propreports"),
  uz: () => import("../locales/uz/propreports"),
});
