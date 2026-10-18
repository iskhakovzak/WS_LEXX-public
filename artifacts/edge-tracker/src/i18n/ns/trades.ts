import { createNamespace } from "..";
import ru from "../locales/ru/trades";

/** Trades: the list (/trades), filters, review presets, bulk actions, trade card, executions, discussion, AI review. */
export const tradesI18n = createNamespace("trades", ru, {
  en: () => import("../locales/en/trades"),
  uz: () => import("../locales/uz/trades"),
});
