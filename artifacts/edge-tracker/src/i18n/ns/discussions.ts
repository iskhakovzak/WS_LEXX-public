import { createNamespace } from "..";
import ru from "../locales/ru/discussions";

export const discussionsI18n = createNamespace("discussions", ru, {
  en: () => import("../locales/en/discussions"),
  uz: () => import("../locales/uz/discussions"),
});
