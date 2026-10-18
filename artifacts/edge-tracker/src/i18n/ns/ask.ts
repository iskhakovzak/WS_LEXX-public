import { createNamespace } from "..";
import ru from "../locales/ru/ask";

/** /ask — «Спроси журнал» (pages/ask.tsx, components/ask/*, lib/ask/*: chips, answer sentences, examples). */
export const askI18n = createNamespace("ask", ru, {
  en: () => import("../locales/en/ask"),
  uz: () => import("../locales/uz/ask"),
});
