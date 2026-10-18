/**
 * AI prompts stay in Russian (they are model input, not UI); the language of the model's answer follows the reader.
 * Append `aiAnswerLanguage(lang)` to a prompt / system message, and key any cache of generated text on `lang`.
 */
import type { Lang } from "./core";

const ANSWER_IN: Record<Lang, string> = {
  ru: "Отвечай на русском языке.", // i18n-ignore (AI instruction — model input)
  en: "Отвечай на английском языке (answer in English). Тикеры, цифры и торговые термины (P&L, R, VWAP…) оставляй как есть.", // i18n-ignore (AI instruction)
  uz: "Отвечай на узбекском языке латиницей (oʻzbek tilida, lotin yozuvida, «siz» shaklida). Тикеры, цифры и торговые термины (P&L, R, VWAP…) оставляй как есть.", // i18n-ignore (AI instruction)
};

/** One-line instruction for the model: answer in `lang`. */
export function aiAnswerLanguage(lang: Lang): string {
  return ANSWER_IN[lang] ?? ANSWER_IN.ru;
}

/** Name of the language inside a Russian prompt («на русском» / «на английском» / «на узбекском (латиница)»). */
export function aiLanguageName(lang: Lang): string {
  return lang === "en" ? "на английском" : lang === "uz" ? "на узбекском (латиница)" : "на русском"; // i18n-ignore (AI instruction)
}

/** Language name for English system prompts ("Reply in …"). */
export function aiLanguageEn(lang: Lang): string {
  return lang === "en" ? "English" : lang === "uz" ? "Uzbek (Latin script)" : "Russian";
}
