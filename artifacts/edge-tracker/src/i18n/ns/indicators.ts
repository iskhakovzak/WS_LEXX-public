import { createNamespace } from "..";
import ru from "../locales/ru/indicators";

/** /indicators — market regime & edge (components/indicators/market/*) and the library UI (components/indicators/*). */
export const indicatorsI18n = createNamespace("indicators", ru, {
  en: () => import("../locales/en/indicators"),
  uz: () => import("../locales/uz/indicators"),
});
