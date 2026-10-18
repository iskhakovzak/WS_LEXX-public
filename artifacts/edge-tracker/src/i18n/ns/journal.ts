import { createNamespace } from "..";
import ru from "../locales/ru/journal";

/** Journal (/journal): day summary, day journal editor, day trades, month calendar, week, team day. */
export const journalI18n = createNamespace("journal", ru, {
  en: () => import("../locales/en/journal"),
  uz: () => import("../locales/uz/journal"),
});
