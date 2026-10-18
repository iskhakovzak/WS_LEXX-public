import { createNamespace } from "..";
import ru from "../locales/ru/ideas";

/** Trade ideas, the idea form and idea stats (components/ideas/*, components/trade-idea-form.tsx, pages/trade-ideas.tsx, pages/trade-idea-stats.tsx). */
export const ideasI18n = createNamespace("ideas", ru, {
  en: () => import("../locales/en/ideas"),
  uz: () => import("../locales/uz/ideas"),
});
