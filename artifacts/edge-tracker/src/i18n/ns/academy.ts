import { createNamespace } from "..";
import ru from "../locales/ru/academy";

/** Academy learning: catalog, lessons / quizzes / assignments, review queue, progress matrix, course editor. */
export const academyI18n = createNamespace("academy", ru, {
  en: () => import("../locales/en/academy"),
  uz: () => import("../locales/uz/academy"),
});
