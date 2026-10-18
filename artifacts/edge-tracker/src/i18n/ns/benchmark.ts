import { createNamespace } from "..";
import ru from "../locales/ru/benchmark";

/** /benchmark — desk benchmark (pages/benchmark.tsx, components/benchmark/*). */
export const benchmarkI18n = createNamespace("benchmark", ru, {
  en: () => import("../locales/en/benchmark"),
  uz: () => import("../locales/uz/benchmark"),
});
