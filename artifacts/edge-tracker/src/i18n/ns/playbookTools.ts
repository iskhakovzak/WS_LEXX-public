import { createNamespace } from "..";
import ru from "../locales/ru/playbookTools";

/** Setup tools: AI critique / checklist, checklist marks, edge block, health, revisions, Markdown / Notion export. */
export const playbookToolsI18n = createNamespace("playbookTools", ru, {
  en: () => import("../locales/en/playbookTools"),
  uz: () => import("../locales/uz/playbookTools"),
});

export type HealthIssueKey = keyof typeof ru.health.issue;
export type RevisionFieldKey = keyof typeof ru.revisions.field;
