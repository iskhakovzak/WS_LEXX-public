import { createNamespace } from "..";
import ru from "../locales/ru/screenshots";

/** Shared screenshot editor / viewer (components/screenshot-fields.tsx) — used across many areas. */
export const screenshotsI18n = createNamespace("screenshots", ru, {
  en: () => import("../locales/en/screenshots"),
  uz: () => import("../locales/uz/screenshots"),
});
