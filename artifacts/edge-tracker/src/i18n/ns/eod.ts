import { createNamespace } from "..";
import ru from "../locales/ru/eod";

/** Day close (EOD): trade-by-trade review, curator queue and review sheet, status badge; morning check-in. */
export const eodI18n = createNamespace("eod", ru, {
  en: () => import("../locales/en/eod"),
  uz: () => import("../locales/uz/eod"),
});
