import { createNamespace } from "..";
import ru from "../locales/ru/common";

/** Shared words (buttons, states, units with plurals, roles, tiers, trading basics). Read-only for area agents. */
export const commonI18n = createNamespace("common", ru, {
  en: () => import("../locales/en/common"),
  uz: () => import("../locales/uz/common"),
});
