import { createNamespace } from "..";
import ru from "../locales/ru/academyPath";

/** «Академия → Путь трейдера / Экзамены» (components/academy/path/*, pages/academy/path.tsx, pages/academy/challenges.tsx). */
export const academyPathI18n = createNamespace("academyPath", ru, {
  en: () => import("../locales/en/academyPath"),
  uz: () => import("../locales/uz/academyPath"),
});
