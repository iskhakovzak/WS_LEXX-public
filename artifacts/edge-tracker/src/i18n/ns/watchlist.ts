import { createNamespace } from "..";
import ru from "../locales/ru/watchlist";

/** /watchlist (pages/watchlist.tsx, components/watchlist/*) + the quick «add to watchlist» on Big 7 / Catalysts. */
export const watchlistI18n = createNamespace("watchlist", ru, {
  en: () => import("../locales/en/watchlist"),
  uz: () => import("../locales/uz/watchlist"),
});
