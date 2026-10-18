import { createNamespace } from "..";
import ru from "../locales/ru/events";

/** /events — «Катализаторы» (components/events/*, pages/events.tsx). */
export const eventsI18n = createNamespace("events", ru, {
  en: () => import("../locales/en/events"),
  uz: () => import("../locales/uz/events"),
});
