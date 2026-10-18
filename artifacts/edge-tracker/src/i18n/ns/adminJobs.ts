import { createNamespace } from "..";
import ru from "../locales/ru/adminJobs";

/** Admin console → «Данные»: background jobs and backups. */
export const adminJobsI18n = createNamespace("adminJobs", ru, {
  en: () => import("../locales/en/adminJobs"),
  uz: () => import("../locales/uz/adminJobs"),
});
