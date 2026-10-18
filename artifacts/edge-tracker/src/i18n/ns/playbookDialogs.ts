import { createNamespace } from "..";
import ru from "../locales/ru/playbookDialogs";

/** «В плейбук» quick add + full add dialog (used across the app), playbook page dialogs, share, compare. */
export const playbookDialogsI18n = createNamespace("playbookDialogs", ru, {
  en: () => import("../locales/en/playbookDialogs"),
  uz: () => import("../locales/uz/playbookDialogs"),
});

export type QuickGroup = keyof typeof ru.quick.group;
