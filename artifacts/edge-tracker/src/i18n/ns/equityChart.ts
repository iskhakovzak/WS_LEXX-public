import { createNamespace } from "..";
import ru from "../locales/ru/equityChart";

/** Equity curve (components/equity-chart): toolbar, hover card, canvas labels, axis words. */
export const equityChartI18n = createNamespace("equityChart", ru, {
  en: () => import("../locales/en/equityChart"),
  uz: () => import("../locales/uz/equityChart"),
});
