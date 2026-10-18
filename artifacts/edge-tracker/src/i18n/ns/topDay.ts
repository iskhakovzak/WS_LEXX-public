import { createNamespace } from "..";
import ru from "../locales/ru/topDay";

/** «Топ дня» (/top-results day view, components/top-day/*) + the «Топ дня» link on the day report. */
export const topDayI18n = createNamespace("topDay", ru, {
  en: () => import("../locales/en/topDay"),
  uz: () => import("../locales/uz/topDay"),
});
