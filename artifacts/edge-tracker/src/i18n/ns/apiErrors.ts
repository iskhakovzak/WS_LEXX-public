import { createNamespace } from "..";
import ru from "../locales/ru/apiErrors";

/** API error messages by server `code` / HTTP status (used by lib/api/errors.ts only). */
export const apiErrorsI18n = createNamespace("apiErrors", ru, {
  en: () => import("../locales/en/apiErrors"),
  uz: () => import("../locales/uz/apiErrors"),
});
