import { createNamespace } from "..";
import ru from "../locales/ru/team";

export const teamI18n = createNamespace("team", ru, {
  en: () => import("../locales/en/team"),
  uz: () => import("../locales/uz/team"),
});
