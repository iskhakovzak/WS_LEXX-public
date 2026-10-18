import { createNamespace } from "..";
import ru from "../locales/ru/shell";

/** App frame: navigation (section names in `nav.*`), header, clock, palette, route titles, shell toasts. */
export const shellI18n = createNamespace("shell", ru, {
  en: () => import("../locales/en/shell"),
  uz: () => import("../locales/uz/shell"),
});

export type NavKey = keyof typeof ru.nav;
export type NavShortKey = keyof typeof ru.navShort;
export type NavGroupKey = keyof typeof ru.groups;
export type NavHubKey = keyof typeof ru.hubs;
