import { createNamespace } from "..";
import ru from "../locales/ru/deskSettings";

/** Admin console → «Настройки деска»: the desk settings form built from the server registry. */
export const deskSettingsI18n = createNamespace("deskSettings", ru, {
  en: () => import("../locales/en/deskSettings"),
  uz: () => import("../locales/uz/deskSettings"),
});
