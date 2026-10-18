import { createNamespace } from "..";
import ru from "../locales/ru/calculator";

/** /calculator — options chain + advisor, Black-Scholes, strategy builder (components/calculator/*, pages/calculator.tsx). */
export const calculatorI18n = createNamespace("calculator", ru, {
  en: () => import("../locales/en/calculator"),
  uz: () => import("../locales/uz/calculator"),
});
