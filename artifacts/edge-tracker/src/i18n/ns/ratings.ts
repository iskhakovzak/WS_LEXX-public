import { createNamespace } from "..";
import ru from "../locales/ru/ratings";

/** Ratings, scorecards, idea calibration and /top-results (components/ratings/*, pages/ratings.tsx, pages/top-results.tsx). */
export const ratingsI18n = createNamespace("ratings", ru, {
  en: () => import("../locales/en/ratings"),
  uz: () => import("../locales/uz/ratings"),
});
