import { createNamespace } from "..";
import ru from "../locales/ru/appErrors";

/** Admin console → «Ошибки»: internal error tracker (server, browser, CSP). */
export const appErrorsI18n = createNamespace("appErrors", ru, {
  en: () => import("../locales/en/appErrors"),
  uz: () => import("../locales/uz/appErrors"),
});
