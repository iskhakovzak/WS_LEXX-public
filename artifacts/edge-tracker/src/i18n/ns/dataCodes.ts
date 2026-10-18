import { createNamespace } from "..";
import ru from "../locales/ru/dataCodes";

/** Display labels for codes stored in the database (playbook.setup_type 'other', …). */
export const dataCodesI18n = createNamespace("dataCodes", ru, {
  en: () => import("../locales/en/dataCodes"),
  uz: () => import("../locales/uz/dataCodes"),
});

/** Setup type as shown: the code "other" is translated, every other value is user content and shown as is. */
export function setupTypeLabel(type: string): string {
  return type === "other" ? dataCodesI18n.t("setupType.other") : type;
}
