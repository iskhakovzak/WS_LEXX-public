import { createNamespace } from "..";
import ru from "../locales/ru/offerings";

/** /offerings — «Размещения» (components/offerings/*, pages/offerings.tsx). */
export const offeringsI18n = createNamespace("offerings", ru, {
  en: () => import("../locales/en/offerings"),
  uz: () => import("../locales/uz/offerings"),
});
