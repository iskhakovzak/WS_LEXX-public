import { createNamespace } from "..";
import ru from "../locales/ru/notifications";

/** Notification center: bell, inbox page, preferences, type registry labels. */
export const notificationsI18n = createNamespace("notifications", ru, {
  en: () => import("../locales/en/notifications"),
  uz: () => import("../locales/uz/notifications"),
});

export type NotificationTypeKey = keyof typeof ru.types;
