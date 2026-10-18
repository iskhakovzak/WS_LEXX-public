import { createNamespace } from "..";
import ru from "../locales/ru/adminAudit";

/** Admin console → «Аудит»: human-readable audit entries (components/admin/audit-text.ts) and the log screen. */
export const adminAuditI18n = createNamespace("adminAudit", ru, {
  en: () => import("../locales/en/adminAudit"),
  uz: () => import("../locales/uz/adminAudit"),
});
