import { createNamespace } from "..";
import ru from "../locales/ru/playbookSetup";

/** The open setup card: setup-view, structured editor, setup form, variants (components/playbook/*). */
export const playbookSetupI18n = createNamespace("playbookSetup", ru, {
  en: () => import("../locales/en/playbookSetup"),
  uz: () => import("../locales/uz/playbookSetup"),
});

export type SetupTemplateId = keyof typeof ru.editor.templates;
