/**
 * «Академия → Обучение» (F1): чистая логика контента — без БД и Express, чтобы её можно было проверить
 * юнит-тестами (lib/__tests__/academyContent.test.ts) и офлайн-скриптом.
 *
 * Модель (таблицы создаёт routes/academy-content.ts, ensure-функция):
 *   academy_programs      программа (курс): title, slug, level, published, position, archived_at
 *   academy_modules       модуль программы: program_id, title, position
 *   academy_lessons       урок: module_id, body_md (markdown), video_url (allow-list), attachments [{title,url}],
 *                         playbook_ids int[] / setup_names text[] — привязка к сетапам плейбука
 *   academy_quizzes       тест: module_id, questions jsonb (single / multiple / numeric), pass_pct, max_attempts
 *   academy_quiz_attempts попытка: answers, score, pct, passed
 *   academy_assignments   задание: module_id, body_md, rubric [{key,label,maxPoints}], pass_pct, min_trades
 *   academy_submissions   сдача: text, url, trade_ids int[], status submitted|graded|returned, scores, mentor_comment
 *   academy_lesson_progress (user_name, lesson_id) → completed_at
 *
 * Элементы модуля (урок / тест / задание) делят одно пространство `position`, поэтому порядок внутри
 * модуля смешанный: «урок → урок → тест → задание».
 */
import { academyContentT, ruPath } from "./academyI18n";
import { DEFAULT_LANG, type Lang } from "../i18n";

/* ─── Общие типы ─────────────────────────────────────────────────────────── */

export type ItemKind = "lesson" | "quiz" | "assignment";
export const ITEM_KINDS: readonly ItemKind[] = ["lesson", "quiz", "assignment"];

/** Лестница деска (решение владельца): ровно 4 ступени. Программа может быть привязана к ступени. */
export type Stage = "trainee" | "junior" | "trader" | "senior";
export const STAGES: readonly Stage[] = ["trainee", "junior", "trader", "senior"];
export const STAGE_LABELS: Record<Stage, string> = { trainee: ruPath.stages.trainee.name, junior: ruPath.stages.junior.name, trader: ruPath.stages.trader.name, senior: ruPath.stages.senior.name };
export function normalizeStage(v: unknown): Stage | null {
  return typeof v === "string" && (STAGES as readonly string[]).includes(v) ? (v as Stage) : null;
}

export type ItemStatus = "not_started" | "in_progress" | "completed";

export type Attachment = { title: string; url: string };

/* ─── URL: вложения и видео ──────────────────────────────────────────────── */

/** http(s) URL или null (тот же контракт, что lib/safe-url.ts, но без зависимостей). */
export function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t || t.length > 2000) return null;
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export type VideoEmbed = { provider: "youtube" | "vimeo" | "loom"; id: string; embedUrl: string; watchUrl: string };

const YT_ID = /^[A-Za-z0-9_-]{6,20}$/;
const VIMEO_ID = /^\d{4,15}$/;
const LOOM_ID = /^[A-Za-z0-9]{10,64}$/;

/** Разбор `t=` / `start=` YouTube ("90", "1m30s", "1h2m3s") в секунды. */
export function parseStartSeconds(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s) || null;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const sec = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return sec > 0 ? sec : null;
}

/**
 * Allow-list видео: YouTube (watch / youtu.be / shorts / embed / live), Vimeo (vimeo.com/ID, player.vimeo.com/video/ID),
 * Loom (share / embed). Всё остальное → null (в уроке такая ссылка показывается как обычная внешняя ссылка не будет —
 * валидатор отклоняет её при сохранении). Встраивание только https, YouTube — через youtube-nocookie.com.
 */
export function videoEmbed(raw: unknown): VideoEmbed | null {
  const url = safeHttpUrl(raw);
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, "");
  const parts = u.pathname.split("/").filter(Boolean);

  if (host === "youtube.com" || host === "youtube-nocookie.com" || host === "youtu.be" || host === "music.youtube.com") {
    let id: string | null = null;
    if (host === "youtu.be") id = parts[0] ?? null;
    else if (parts[0] === "watch") id = u.searchParams.get("v");
    else if (parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live" || parts[0] === "v") id = parts[1] ?? null;
    if (!id || !YT_ID.test(id)) return null;
    const start = parseStartSeconds(u.searchParams.get("t") ?? u.searchParams.get("start"));
    const q = start ? `?start=${start}` : "";
    return { provider: "youtube", id, embedUrl: `https://www.youtube-nocookie.com/embed/${id}${q}`, watchUrl: `https://www.youtube.com/watch?v=${id}${start ? `&t=${start}s` : ""}` };
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = host === "player.vimeo.com" ? (parts[0] === "video" ? parts[1] : null) : parts.find((p) => VIMEO_ID.test(p)) ?? null;
    if (!id || !VIMEO_ID.test(id)) return null;
    return { provider: "vimeo", id, embedUrl: `https://player.vimeo.com/video/${id}`, watchUrl: `https://vimeo.com/${id}` };
  }
  if (host === "loom.com") {
    const id = parts[0] === "share" || parts[0] === "embed" ? parts[1] : null;
    if (!id || !LOOM_ID.test(id)) return null;
    return { provider: "loom", id, embedUrl: `https://www.loom.com/embed/${id}`, watchUrl: `https://www.loom.com/share/${id}` };
  }
  return null;
}

/** Вложения: до 20 штук, только http(s), заголовок по умолчанию — хост. Невалидные молча отбрасываются. */
export function normalizeAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const url = safeHttpUrl((a as { url?: unknown }).url);
    if (!url) continue;
    const t = typeof (a as { title?: unknown }).title === "string" ? (a as { title: string }).title.trim().slice(0, 200) : "";
    out.push({ title: t || new URL(url).hostname, url });
    if (out.length >= 20) break;
  }
  return out;
}

/* ─── Тесты (квизы) ──────────────────────────────────────────────────────── */

export type QuizOption = { id: string; text: string };

export type QuizQuestion =
  | { id: string; kind: "single"; prompt: string; options: QuizOption[]; correct: string[]; points: number; explanation?: string }
  | { id: string; kind: "multiple"; prompt: string; options: QuizOption[]; correct: string[]; points: number; partial: boolean; explanation?: string }
  | { id: string; kind: "numeric"; prompt: string; answer: number; tolerance: number; tolerancePct: boolean; unit?: string; points: number; explanation?: string };

export type QuizConfig = { passPct: number; maxAttempts: number | null };

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const finite = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Проверка и нормализация вопросов теста из админки. Ошибки — на языке `lang`, с номером вопроса. */
export function normalizeQuestions(raw: unknown, lang: Lang = DEFAULT_LANG): ValidationResult<QuizQuestion[]> {
  const tv = (key: string, params?: Record<string, string | number>) => academyContentT.tryFor(lang, `validation.${key}`, params) ?? key;
  if (!Array.isArray(raw)) return { ok: false, errors: [tv("questionsList")] };
  if (raw.length > 100) return { ok: false, errors: [tv("questionsMax")] };
  const errors: string[] = [];
  const out: QuizQuestion[] = [];
  const seen = new Set<string>();
  raw.forEach((q, i) => {
    const n = i + 1;
    if (!q || typeof q !== "object") { errors.push(tv("questionEmpty", { n })); return; }
    const o = q as Record<string, unknown>;
    let id = str(o.id, 40) || `q${n}`;
    while (seen.has(id)) id = `${id}_${n}`;
    seen.add(id);
    const prompt = str(o.prompt, 4000);
    if (!prompt) errors.push(tv("questionNoText", { n }));
    const pointsRaw = finite(o.points);
    const points = pointsRaw != null && pointsRaw > 0 ? Math.min(100, pointsRaw) : 1;
    const explanation = str(o.explanation, 4000) || undefined;
    const kind = o.kind;
    if (kind === "single" || kind === "multiple") {
      const optsRaw = Array.isArray(o.options) ? o.options : [];
      const options: QuizOption[] = [];
      const optIds = new Set<string>();
      optsRaw.forEach((op, j) => {
        const oo = (op ?? {}) as Record<string, unknown>;
        const text = str(oo.text, 1000);
        if (!text) return;
        let oid = str(oo.id, 40) || String.fromCharCode(97 + j);
        while (optIds.has(oid)) oid = `${oid}${j}`;
        optIds.add(oid);
        options.push({ id: oid, text });
      });
      if (options.length < 2) errors.push(tv("optionsMin", { n }));
      if (options.length > 12) errors.push(tv("optionsMax", { n }));
      const correct = (Array.isArray(o.correct) ? o.correct : []).map((c) => String(c)).filter((c, k, arr) => optIds.has(c) && arr.indexOf(c) === k);
      if (kind === "single" && correct.length !== 1) errors.push(tv("singleCorrect", { n }));
      if (kind === "multiple" && correct.length < 1) errors.push(tv("multipleCorrect", { n }));
      if (kind === "single") out.push({ id, kind, prompt, options, correct, points, explanation });
      else out.push({ id, kind, prompt, options, correct, points, partial: o.partial === true, explanation });
      return;
    }
    if (kind === "numeric") {
      const answer = finite(o.answer);
      if (answer == null) errors.push(tv("numericAnswer", { n }));
      const tolRaw = finite(o.tolerance);
      const tolerance = tolRaw != null && tolRaw >= 0 ? tolRaw : 0;
      const unit = str(o.unit, 20) || undefined;
      out.push({ id, kind, prompt, answer: answer ?? 0, tolerance, tolerancePct: o.tolerancePct === true, unit, points, explanation });
      return;
    }
    errors.push(tv("unknownKind", { n, kind: String(kind) }));
  });
  if (!errors.length && out.length === 0) errors.push(tv("questionsNone"));
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

/**
 * Числовой ответ ученика: «1,5», «1.5R», «$ 1 250», «-0.8», «12%» → число. Пробелы-разделители тысяч
 * (в том числе неразрывные) и валюта/единицы отбрасываются. Пустая строка / мусор → null.
 */
export function parseNumericAnswer(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  let s = raw.trim().replace(/[\s  ]/g, "").replace(/[−–—]/g, "-");
  s = s.replace(/^[$€₽]/, "").replace(/(?:r|R|р|Р|%|\$|usd|USD|шт|акций)+$/u, "");
  s = s.replace(/^\+/, "");
  if (/^-?\d+,\d+$/.test(s)) s = s.replace(",", ".");
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Попадает ли число в допуск: абсолютный (±tol) или в процентах от ответа. Маленький эпсилон против ошибок float. */
export function withinTolerance(given: number, answer: number, tolerance: number, pct: boolean): boolean {
  const tol = pct ? Math.abs(answer) * (tolerance / 100) : tolerance;
  return Math.abs(given - answer) <= tol + 1e-9;
}

export type AnswerMap = Record<string, unknown>;

export type QuestionResult = {
  id: string;
  points: number;
  earned: number;
  correct: boolean;
  /** Ответ ученика в нормализованном виде (ids вариантов или число). */
  given: string[] | number | null;
};

export type QuizGrade = { score: number; maxScore: number; pct: number; passed: boolean; results: QuestionResult[] };

const round2 = (n: number) => Math.round(n * 100) / 100;

function asIdList(v: unknown): string[] {
  if (Array.isArray(v)) return [...new Set(v.map((x) => String(x)))];
  if (typeof v === "string" && v) return [v];
  return [];
}

/**
 * Автопроверка. single — ровно верный вариант; multiple — точное совпадение множества, либо (partial=true)
 * частичный балл (верно отмеченные − лишние) / число верных, не ниже 0; numeric — попадание в допуск.
 * Неотвеченный вопрос = 0. Проценты считаются от суммы баллов; pass = pct ≥ passPct.
 */
export function gradeQuiz(questions: readonly QuizQuestion[], answers: AnswerMap | null | undefined, passPct: number): QuizGrade {
  const a = answers ?? {};
  const results: QuestionResult[] = questions.map((q) => {
    const raw = a[q.id];
    if (q.kind === "numeric") {
      const given = parseNumericAnswer(raw);
      const ok = given != null && withinTolerance(given, q.answer, q.tolerance, q.tolerancePct);
      return { id: q.id, points: q.points, earned: ok ? q.points : 0, correct: ok, given };
    }
    const valid = new Set(q.options.map((o) => o.id));
    const given = asIdList(raw).filter((x) => valid.has(x));
    const correctSet = new Set(q.correct);
    if (q.kind === "single") {
      const ok = given.length === 1 && correctSet.has(given[0]);
      return { id: q.id, points: q.points, earned: ok ? q.points : 0, correct: ok, given };
    }
    const right = given.filter((x) => correctSet.has(x)).length;
    const wrong = given.length - right;
    const exact = wrong === 0 && right === correctSet.size;
    let earned = exact ? q.points : 0;
    if (!exact && q.partial && correctSet.size > 0) earned = round2(Math.max(0, (right - wrong) / correctSet.size) * q.points);
    return { id: q.id, points: q.points, earned, correct: exact, given };
  });
  const maxScore = round2(results.reduce((s, r) => s + r.points, 0));
  const score = round2(results.reduce((s, r) => s + r.earned, 0));
  const pct = maxScore > 0 ? round2((score / maxScore) * 100) : 0;
  return { score, maxScore, pct, passed: pct >= clampPct(passPct), results };
}

export function clampPct(v: unknown, def = 80): number {
  const n = finite(v);
  if (n == null) return def;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export type AttemptLite = { pct: number; passed: boolean; submittedAt: string };

export type AttemptState = {
  attempts: number;
  attemptsLeft: number | null;
  canAttempt: boolean;
  bestPct: number | null;
  passed: boolean;
  /** Показывать ли верные ответы и пояснения: после сдачи или когда попытки кончились. */
  revealAnswers: boolean;
};

/** Состояние попыток: лучший результат засчитывается; после сдачи пересдавать можно (если есть попытки) — для практики. */
export function attemptState(attempts: readonly AttemptLite[], cfg: QuizConfig): AttemptState {
  const n = attempts.length;
  const max = cfg.maxAttempts != null && cfg.maxAttempts > 0 ? cfg.maxAttempts : null;
  const attemptsLeft = max == null ? null : Math.max(0, max - n);
  const passed = attempts.some((x) => x.passed);
  const bestPct = n ? Math.max(...attempts.map((x) => x.pct)) : null;
  return { attempts: n, attemptsLeft, canAttempt: attemptsLeft == null || attemptsLeft > 0, bestPct, passed, revealAnswers: passed || attemptsLeft === 0 };
}

/** Публичная версия вопроса — без правильных ответов и пояснений. */
export type PublicQuestion =
  | { id: string; kind: "single" | "multiple"; prompt: string; options: QuizOption[]; points: number; multiple: boolean }
  | { id: string; kind: "numeric"; prompt: string; unit?: string; points: number };

export function publicQuestions(questions: readonly QuizQuestion[]): PublicQuestion[] {
  return questions.map((q) =>
    q.kind === "numeric"
      ? { id: q.id, kind: q.kind, prompt: q.prompt, unit: q.unit, points: q.points }
      : { id: q.id, kind: q.kind, prompt: q.prompt, options: q.options, points: q.points, multiple: q.kind === "multiple" },
  );
}

/** Разбор по вопросам для ответа API: верный ответ и пояснение — только если reveal. */
export function feedbackFor(questions: readonly QuizQuestion[], grade: QuizGrade, reveal: boolean) {
  return grade.results.map((r) => {
    const q = questions.find((x) => x.id === r.id)!;
    const base = { id: r.id, correct: r.correct, earned: r.earned, points: r.points, given: r.given };
    if (!reveal) return base;
    return {
      ...base,
      explanation: q.explanation ?? null,
      expected: q.kind === "numeric"
        ? { answer: q.answer, tolerance: q.tolerance, tolerancePct: q.tolerancePct, unit: q.unit ?? null }
        : { options: q.correct },
    };
  });
}

/* ─── Задания и рубрика ──────────────────────────────────────────────────── */

export type RubricCriterion = { key: string; label: string; maxPoints: number; description?: string };

export function normalizeRubric(raw: unknown, lang: Lang = DEFAULT_LANG): ValidationResult<RubricCriterion[]> {
  const tv = (key: string, params?: Record<string, string | number>) => academyContentT.tryFor(lang, `validation.${key}`, params) ?? key;
  if (!Array.isArray(raw)) return { ok: false, errors: [tv("rubricList")] };
  const out: RubricCriterion[] = [];
  const errors: string[] = [];
  const keys = new Set<string>();
  raw.forEach((c, i) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const label = str(o.label, 200);
    if (!label) { errors.push(tv("criterionNoLabel", { n: i + 1 })); return; }
    const mp = finite(o.maxPoints);
    if (mp == null || mp <= 0 || mp > 100) { errors.push(tv("criterionPoints", { n: i + 1 })); return; }
    let key = str(o.key, 40).replace(/[^\w-]/g, "") || `c${i + 1}`;
    while (keys.has(key)) key = `${key}_${i + 1}`;
    keys.add(key);
    out.push({ key, label, maxPoints: mp, description: str(o.description, 1000) || undefined });
  });
  if (out.length > 20) errors.push(tv("rubricMax"));
  if (!errors.length && !out.length) errors.push(tv("rubricNone"));
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

export type RubricGrade = { scores: Record<string, number>; total: number; maxTotal: number; pct: number; passed: boolean; missing: string[] };

/**
 * Оценка по рубрике: баллы каждого критерия зажимаются в [0, max] (шаг 0.5), лишние ключи игнорируются,
 * отсутствующие — в `missing` (маршрут требует оценить все критерии).
 */
export function gradeRubric(rubric: readonly RubricCriterion[], rawScores: unknown, passPct: number): RubricGrade {
  const src = rawScores && typeof rawScores === "object" ? (rawScores as Record<string, unknown>) : {};
  const scores: Record<string, number> = {};
  const missing: string[] = [];
  for (const c of rubric) {
    const v = finite(src[c.key]);
    if (v == null) { missing.push(c.key); scores[c.key] = 0; continue; }
    scores[c.key] = Math.max(0, Math.min(c.maxPoints, Math.round(v * 2) / 2));
  }
  const maxTotal = round2(rubric.reduce((s, c) => s + c.maxPoints, 0));
  const total = round2(Object.values(scores).reduce((s, v) => s + v, 0));
  const pct = maxTotal > 0 ? round2((total / maxTotal) * 100) : 0;
  return { scores, total, maxTotal, pct, passed: pct >= clampPct(passPct), missing };
}

/** A failed check carries an API error code (errors namespace) and its params. */
export type SubmissionCheck = { ok: true } | { ok: false; code: "SUBMISSION_EMPTY" | "SUBMISSION_MIN_TRADES"; params?: { count: number } };

/** Сдача задания: нужен хотя бы текст, ссылка или сделки; если задание требует N сделок — их не меньше N. */
export function checkSubmission(p: { text: string; url: string | null; tradeIds: number[] }, minTrades: number): SubmissionCheck {
  if (!p.text.trim() && !p.url && p.tradeIds.length === 0) return { ok: false, code: "SUBMISSION_EMPTY" };
  if (minTrades > 0 && p.tradeIds.length < minTrades) return { ok: false, code: "SUBMISSION_MIN_TRADES", params: { count: minTrades } };
  return { ok: true };
}

/** id сделок из тела запроса: целые > 0, уникальные, не больше 50. */
export function parseTradeIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const v of raw) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
    if (out.length >= 50) break;
  }
  return out;
}

/* ─── Прогресс ───────────────────────────────────────────────────────────── */

export type ProgressItem = { kind: ItemKind; id: number; moduleId: number; position: number; title: string };

export type ProgressFacts = {
  /** id пройденных уроков. */
  lessonsDone: ReadonlySet<number>;
  /** id просмотренных/начатых уроков (необязательно). */
  lessonsStarted?: ReadonlySet<number>;
  /** quizId → есть ли зачтённая попытка (true) / только незачтённые (false). */
  quizzes: ReadonlyMap<number, { passed: boolean; bestPct: number | null }>;
  /** assignmentId → статус последней сдачи. */
  assignments: ReadonlyMap<number, { status: "submitted" | "graded" | "returned"; passed: boolean | null }>;
};

export function itemStatus(item: ProgressItem, f: ProgressFacts): ItemStatus {
  if (item.kind === "lesson") return f.lessonsDone.has(item.id) ? "completed" : f.lessonsStarted?.has(item.id) ? "in_progress" : "not_started";
  if (item.kind === "quiz") {
    const q = f.quizzes.get(item.id);
    return !q ? "not_started" : q.passed ? "completed" : "in_progress";
  }
  const s = f.assignments.get(item.id);
  if (!s) return "not_started";
  return s.status === "graded" && s.passed !== false ? "completed" : "in_progress";
}

export type ModuleProgress = { moduleId: number; total: number; done: number; pct: number };
export type ProgramProgress = {
  total: number;
  done: number;
  pct: number;
  byKind: Record<ItemKind, { total: number; done: number }>;
  modules: ModuleProgress[];
  /** Следующий элемент: первый незавершённый в порядке модулей/позиций. */
  next: { kind: ItemKind; id: number; title: string } | null;
  status: Map<string, ItemStatus>;
};

export const itemKey = (kind: ItemKind, id: number) => `${kind}:${id}`;

/**
 * Прогресс программы для одного ученика: каждый элемент весит одинаково; задание засчитано, когда
 * последняя сдача проверена и не провалена; тест — когда есть зачтённая попытка.
 * `moduleOrder` — порядок модулей (элементы чужих/архивных модулей игнорируются).
 */
export function computeProgress(items: readonly ProgressItem[], moduleOrder: readonly number[], f: ProgressFacts): ProgramProgress {
  const modIndex = new Map(moduleOrder.map((id, i) => [id, i]));
  const ordered = items
    .filter((it) => modIndex.has(it.moduleId))
    .slice()
    .sort((a, b) => modIndex.get(a.moduleId)! - modIndex.get(b.moduleId)! || a.position - b.position || ITEM_KINDS.indexOf(a.kind) - ITEM_KINDS.indexOf(b.kind) || a.id - b.id);
  const byKind: ProgramProgress["byKind"] = { lesson: { total: 0, done: 0 }, quiz: { total: 0, done: 0 }, assignment: { total: 0, done: 0 } };
  const modAgg = new Map<number, { total: number; done: number }>(moduleOrder.map((id) => [id, { total: 0, done: 0 }]));
  const status = new Map<string, ItemStatus>();
  let next: ProgramProgress["next"] = null;
  let done = 0;
  for (const it of ordered) {
    const st = itemStatus(it, f);
    status.set(itemKey(it.kind, it.id), st);
    const m = modAgg.get(it.moduleId)!;
    m.total += 1;
    byKind[it.kind].total += 1;
    if (st === "completed") { m.done += 1; byKind[it.kind].done += 1; done += 1; }
    else if (!next) next = { kind: it.kind, id: it.id, title: it.title };
  }
  const pct = (d: number, t: number) => (t > 0 ? Math.round((d / t) * 1000) / 10 : 0);
  return {
    total: ordered.length,
    done,
    pct: pct(done, ordered.length),
    byKind,
    modules: moduleOrder.map((id) => {
      const m = modAgg.get(id)!;
      return { moduleId: id, total: m.total, done: m.done, pct: pct(m.done, m.total) };
    }),
    next,
    status,
  };
}

export type CohortStudentRow = { userName: string; pct: number; done: number; total: number; lastActivity: string | null };

export type CohortSummary = {
  students: number;
  avgPct: number | null;
  medianPct: number | null;
  completed: number;
  notStarted: number;
  /** Ученики без активности дольше staleDays (или вовсе без неё). */
  stale: string[];
};

/** Сводка по когорте: средний/медианный прогресс, сколько закончили, кто «завис». */
export function cohortSummary(rows: readonly CohortStudentRow[], nowIso: string, staleDays = 7): CohortSummary {
  if (!rows.length) return { students: 0, avgPct: null, medianPct: null, completed: 0, notStarted: 0, stale: [] };
  const pcts = rows.map((r) => r.pct).sort((a, b) => a - b);
  const mid = Math.floor(pcts.length / 2);
  const median = pcts.length % 2 ? pcts[mid] : (pcts[mid - 1] + pcts[mid]) / 2;
  const now = Date.parse(nowIso);
  const stale = rows
    .filter((r) => r.pct < 100 && (!r.lastActivity || now - Date.parse(r.lastActivity) > staleDays * 86_400_000))
    .map((r) => r.userName);
  return {
    students: rows.length,
    avgPct: Math.round((pcts.reduce((s, v) => s + v, 0) / pcts.length) * 10) / 10,
    medianPct: Math.round(median * 10) / 10,
    completed: rows.filter((r) => r.total > 0 && r.done >= r.total).length,
    notStarted: rows.filter((r) => r.done === 0).length,
    stale,
  };
}

/* ─── Порядок ────────────────────────────────────────────────────────────── */

/**
 * Новый порядок элементов модуля: принимает желаемую последовательность {kind,id}, возвращает позиции
 * 10, 20, 30… Неизвестные элементы отбрасываются; элементы модуля, которых нет в списке, идут в конце
 * в прежнем порядке (так одновременное добавление не теряет элемент).
 */
export function applyOrder<T extends { kind: ItemKind; id: number; position: number }>(
  current: readonly T[],
  desired: readonly { kind: ItemKind; id: number }[],
): { kind: ItemKind; id: number; position: number }[] {
  const byKey = new Map(current.map((c) => [itemKey(c.kind, c.id), c]));
  const used = new Set<string>();
  const seq: { kind: ItemKind; id: number }[] = [];
  for (const d of desired) {
    const k = itemKey(d.kind, d.id);
    if (!byKey.has(k) || used.has(k)) continue;
    used.add(k);
    seq.push({ kind: d.kind, id: d.id });
  }
  const rest = current.filter((c) => !used.has(itemKey(c.kind, c.id))).slice().sort((a, b) => a.position - b.position);
  return [...seq, ...rest.map((c) => ({ kind: c.kind, id: c.id }))].map((x, i) => ({ ...x, position: (i + 1) * 10 }));
}

/** Порядок по id (модули в программе / программы): то же правило, позиции 10, 20, … */
export function applyIdOrder(currentIds: readonly number[], desired: readonly number[]): { id: number; position: number }[] {
  const set = new Set(currentIds);
  const seq: number[] = [];
  for (const id of desired) if (set.has(id) && !seq.includes(id)) seq.push(id);
  for (const id of currentIds) if (!seq.includes(id)) seq.push(id);
  return seq.map((id, i) => ({ id, position: (i + 1) * 10 }));
}

export function slugify(s: string): string {
  // Cyrillic → Latin transliteration of user input (not UI text).
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
    п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  const out = s.toLowerCase().split("").map((ch) => map[ch] ?? ch).join("").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out.slice(0, 60) || "program";
}

/* ─── Демо-курс «Основы проп-трейдинга WS» ───────────────────────────────── */

export const DEMO_PROGRAM_SLUG = "ws-prop-basics";

export type SeedLesson = { kind: "lesson"; key: string; title: string; summary: string; durationMin: number; body: string; setupNames?: string[]; attachments?: Attachment[] };
export type SeedQuiz = { kind: "quiz"; key: string; title: string; description: string; passPct: number; maxAttempts: number | null; questions: QuizQuestion[] };
export type SeedAssignment = { kind: "assignment"; key: string; title: string; body: string; rubric: RubricCriterion[]; passPct: number; minTrades: number };
export type SeedItem = SeedLesson | SeedQuiz | SeedAssignment;
export type SeedModule = { key: string; title: string; description: string; items: SeedItem[] };
export type SeedProgram = { slug: string; title: string; description: string; level: string; stage: Stage | null; modules: SeedModule[] };

/** The demo course content (seed data, user content once written) lives in lib/academySeedCourse.ts. */
export { DEMO_PROGRAM } from "./academySeedCourse";
