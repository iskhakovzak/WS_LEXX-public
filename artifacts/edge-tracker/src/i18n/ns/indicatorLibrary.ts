import { createNamespace } from "..";
import ru from "../locales/ru/indicatorLibrary";

/** The desk's indicator encyclopedia text (components/indicators/library.ts), keyed by indicator id. */
export const indicatorLibraryI18n = createNamespace("indicatorLibrary", ru, {
  en: () => import("../locales/en/indicatorLibrary"),
  uz: () => import("../locales/uz/indicatorLibrary"),
});
