import { createNamespace } from "..";
import ru from "../locales/ru/playbookExamples";

/** A setup's example trades and numbers: examples board / card, trade picker, linked trades, stats tab, cases. */
export const playbookExamplesI18n = createNamespace("playbookExamples", ru, {
  en: () => import("../locales/en/playbookExamples"),
  uz: () => import("../locales/uz/playbookExamples"),
});

export type CaseStatus = keyof typeof ru.cases.status;
