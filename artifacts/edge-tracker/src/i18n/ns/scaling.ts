import { createNamespace } from "..";
import ru from "../locales/ru/scaling";

/** /scaling — tier ladder, promotion/demotion rules, proposals (components/scaling/*, pages/scaling.tsx). */
export const scalingI18n = createNamespace("scaling", ru, {
  en: () => import("../locales/en/scaling"),
  uz: () => import("../locales/uz/scaling"),
});
