import { createNamespace } from "..";
import ru from "../locales/ru/admin";

/** Admin console (/admin): overview, people, activity, moderation, roles, data. */
export const adminI18n = createNamespace("admin", ru, {
  en: () => import("../locales/en/admin"),
  uz: () => import("../locales/uz/admin"),
});
