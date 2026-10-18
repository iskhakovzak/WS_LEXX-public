import { createNamespace } from "..";
import ru from "../locales/ru/playbook";

/**
 * /playbook page shell (pages/playbook.tsx, home, folder tree, overview, gallery, quick find…) and the keys shared by
 * all playbook namespaces (structured card fields, tiers, time of day, sources, folder colours, bits).
 */
export const playbookI18n = createNamespace("playbook", ru, {
  en: () => import("../locales/en/playbook"),
  uz: () => import("../locales/uz/playbook"),
});

export type TimeOfDayKey = keyof typeof ru.timeOfDay;
export type SetupSourceKey = keyof typeof ru.source;
