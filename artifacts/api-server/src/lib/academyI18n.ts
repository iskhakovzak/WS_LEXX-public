/**
 * Academy namespaces: `academyPath` (src/i18n/{ru,en,uz}/academyPath.ts — trader path, exams),
 * `academyCohorts` (cohorts, sessions, attendance, IDP goals, mentor dashboard) and `academyContent`
 * (courses, quizzes, assignments). Seeded defaults stored in the DB are user data: helpers below translate a stored
 * text only while it still equals the Russian seed.
 */
import { defineNamespace, isLang, DEFAULT_LANG, type Lang } from "../i18n";
import ruPath from "../i18n/ru/academyPath";
import enPath from "../i18n/en/academyPath";
import uzPath from "../i18n/uz/academyPath";
import ruCohorts from "../i18n/ru/academyCohorts";
import enCohorts from "../i18n/en/academyCohorts";
import uzCohorts from "../i18n/uz/academyCohorts";
import ruContent from "../i18n/ru/academyContent";
import enContent from "../i18n/en/academyContent";
import uzContent from "../i18n/uz/academyContent";

export const academyPathT = defineNamespace(ruPath, { en: enPath, uz: uzPath });
export const academyCohortsT = defineNamespace(ruCohorts, { en: enCohorts, uz: uzCohorts });
export { ruCohorts };
export const academyContentT = defineNamespace(ruContent, { en: enContent, uz: uzContent });
export { ruContent };
export { ruPath };

type StageKey = "trainee" | "junior" | "trader" | "senior";
const STAGE_KEYS: readonly StageKey[] = ["trainee", "junior", "trader", "senior"];
const isStage = (v: unknown): v is StageKey => typeof v === "string" && (STAGE_KEYS as readonly string[]).includes(v);

/** Stage name for display: the seeded Russian name (or empty) → translated; a name staff typed stays as is. */
export function stageNameFor(key: string | null | undefined, stored: string | null | undefined, lang: Lang | null | undefined): string {
  const l: Lang = isLang(lang) ? lang : DEFAULT_LANG;
  if (!isStage(key)) return stored ?? "";
  if (!stored || stored === ruPath.stages[key].name) return academyPathT.tFor(l)(`stages.${key}.name`);
  return stored;
}

/** Stage description for display (seeded text, current or legacy → translated). */
export function stageDescriptionFor(key: string | null | undefined, stored: string | null | undefined, lang: Lang | null | undefined): string | null {
  const l: Lang = isLang(lang) ? lang : DEFAULT_LANG;
  if (!isStage(key)) return stored ?? null;
  if (stored == null || stored === ruPath.stages[key].description) return academyPathT.tFor(l)(`stages.${key}.description`);
  if (key === "trainee" && stored === ruPath.stages.legacyTraineeDescription) return academyPathT.tFor(l)("stages.trainee.description");
  return stored;
}

/** Criterion label: empty → metric label; the seeded Russian label → its translation; staff text → as is. */
export function criterionLabelFor(stage: string, metric: string, stored: string | null | undefined, lang: Lang | null | undefined): string {
  const l: Lang = isLang(lang) ? lang : DEFAULT_LANG;
  const label = stored?.trim();
  if (!label) return academyPathT.tryFor(l, `metrics.${metric}.label`) ?? metric;
  const seed = (ruPath.seedCriteria as Record<string, Record<string, string> | undefined>)[stage]?.[metric];
  if (seed && seed === label) return academyPathT.tryFor(l, `seedCriteria.${stage}.${metric}`) ?? label;
  return label;
}
