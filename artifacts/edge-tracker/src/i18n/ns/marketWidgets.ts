import { createNamespace } from "..";
import ru from "../locales/ru/marketWidgets";

/** Premarket widgets used on several pages: sector radar, open brief, news feed, market DNA, fundamentals bar, quote of the day, macro events. */
export const marketWidgetsI18n = createNamespace("marketWidgets", ru, {
  en: () => import("../locales/en/marketWidgets"),
  uz: () => import("../locales/uz/marketWidgets"),
});
