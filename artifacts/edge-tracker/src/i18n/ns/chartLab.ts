import { createNamespace } from "..";
import ru from "../locales/ru/chartLab";

/** /chart-lab: trade picker, random training tasks and their settings (the chart itself is `chart`). */
export const chartLabI18n = createNamespace("chartLab", ru, {
  en: () => import("../locales/en/chartLab"),
  uz: () => import("../locales/uz/chartLab"),
});
