import { createNamespace } from "..";
import ru from "../locales/ru/deskDay";

/** «Деск на тикере» (/desk-day, components/desk-day/*) + the tiny entry links (components/shared/desk-day-link.tsx). */
export const deskDayI18n = createNamespace("deskDay", ru, {
  en: () => import("../locales/en/deskDay"),
  uz: () => import("../locales/uz/deskDay"),
});
