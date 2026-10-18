import { createNamespace } from "..";
import ru from "../locales/ru/research";

/** /research archive + the shared earnings-history sheet (components/research/*, pages/research.tsx). */
export const researchI18n = createNamespace("research", ru, {
  en: () => import("../locales/en/research"),
  uz: () => import("../locales/uz/research"),
});
