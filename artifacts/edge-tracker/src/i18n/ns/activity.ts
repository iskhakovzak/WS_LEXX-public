import { createNamespace } from "..";
import ru from "../locales/ru/activity";

/** /activity — the team activity feed (components/team/activity-*, pages/activity.tsx). */
export const activityI18n = createNamespace("activity", ru, {
  en: () => import("../locales/en/activity"),
  uz: () => import("../locales/uz/activity"),
});
