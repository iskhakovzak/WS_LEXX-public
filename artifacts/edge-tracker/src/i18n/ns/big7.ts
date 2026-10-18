import { createNamespace } from "..";
import ru from "../locales/ru/big7";

/** /big7 — mega-cap context screen (pages/big7.tsx, components/big7/*). */
export const big7I18n = createNamespace("big7", ru, {
  en: () => import("../locales/en/big7"),
  uz: () => import("../locales/uz/big7"),
});
