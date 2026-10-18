import { createNamespace } from "..";
import ru from "../locales/ru/terms";

/** Desk glossary behind <TermTooltip>: label, full name, explanation, formula per term key. */
export const termsI18n = createNamespace("terms", ru, {
  en: () => import("../locales/en/terms"),
  uz: () => import("../locales/uz/terms"),
});

export type TermKey = keyof typeof ru;
