import { createNamespace } from "..";
import ru from "../locales/ru/notes";

/** «Сводка автора» and «Сводка джунов» (components/notes/*, pages/author-notes.tsx, pages/junior-notes.tsx). */
export const notesI18n = createNamespace("notes", ru, {
  en: () => import("../locales/en/notes"),
  uz: () => import("../locales/uz/notes"),
});
