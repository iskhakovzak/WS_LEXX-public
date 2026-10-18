import { describe, expect, it } from "vitest";
import {
  DEMO_PROGRAM, STAGES, applyIdOrder, applyOrder, attemptState, checkSubmission, cohortSummary, computeProgress, feedbackFor, gradeQuiz,
  gradeRubric, normalizeAttachments, normalizeQuestions, normalizeRubric, normalizeStage, parseNumericAnswer, parseStartSeconds, parseTradeIds,
  publicQuestions, slugify, videoEmbed, withinTolerance,
  type ProgressFacts, type ProgressItem, type QuizQuestion,
} from "../academyContent";

const Q: QuizQuestion[] = [
  { id: "s", kind: "single", prompt: "?", options: [{ id: "a", text: "A" }, { id: "b", text: "B" }], correct: ["b"], points: 1 },
  { id: "m", kind: "multiple", prompt: "?", options: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }, { id: "d", text: "D" }], correct: ["a", "c", "d"], points: 2, partial: true },
  { id: "n", kind: "numeric", prompt: "R?", answer: 2.4, tolerance: 0.05, tolerancePct: false, points: 1 },
];

describe("parseNumericAnswer", () => {
  it.each<[unknown, number | null]>([
    ["2.4", 2.4], ["2,4", 2.4], ["2.4R", 2.4], [" 2,4 R ", 2.4], ["$1 250", 1250], ["1,250.50", 1250.5], ["−0.8", -0.8], ["+3", 3],
    ["12%", 12], ["500 акций", 500], [".5", 0.5], [7, 7], ["", null], ["abc", null], ["1.2.3", null], [NaN, null], [null, null],
  ])("%j → %j", (raw, exp) => expect(parseNumericAnswer(raw)).toBe(exp));
});

describe("withinTolerance", () => {
  it("absolute and percent tolerance", () => {
    expect(withinTolerance(2.45, 2.4, 0.05, false)).toBe(true); // float edge
    expect(withinTolerance(2.46, 2.4, 0.05, false)).toBe(false);
    expect(withinTolerance(105, 100, 5, true)).toBe(true);
    expect(withinTolerance(94.9, 100, 5, true)).toBe(false);
    expect(withinTolerance(500, 500, 0, false)).toBe(true);
  });
});

describe("gradeQuiz", () => {
  it("all correct → 100%, passed", () => {
    const g = gradeQuiz(Q, { s: "b", m: ["a", "c", "d"], n: "2,4" }, 80);
    expect(g).toMatchObject({ score: 4, maxScore: 4, pct: 100, passed: true });
    expect(g.results.every((r) => r.correct)).toBe(true);
  });
  it("partial credit on multiple: (right − wrong)/correct × points", () => {
    const g = gradeQuiz(Q, { s: "b", m: ["a", "c", "b"], n: 2.4 }, 80);
    const m = g.results.find((r) => r.id === "m")!;
    expect(m.correct).toBe(false);
    expect(m.earned).toBeCloseTo(((2 - 1) / 3) * 2, 2);
    expect(g.passed).toBe(false); // 2.67 / 4 = 66.75%
  });
  it("multiple without partial → 0 unless exact", () => {
    const q: QuizQuestion[] = [{ ...(Q[1] as Extract<QuizQuestion, { kind: "multiple" }>), partial: false }];
    expect(gradeQuiz(q, { m: ["a", "c"] }, 50).score).toBe(0);
    expect(gradeQuiz(q, { m: ["d", "c", "a"] }, 50).score).toBe(2);
  });
  it("partial never negative; unknown option ids ignored", () => {
    const g = gradeQuiz(Q, { m: ["b", "zzz"] }, 80);
    expect(g.results.find((r) => r.id === "m")!.earned).toBe(0);
  });
  it("single with two answers is wrong; missing answers = 0", () => {
    const g = gradeQuiz(Q, { s: ["a", "b"] }, 80);
    expect(g.score).toBe(0);
    expect(gradeQuiz(Q, null, 0)).toMatchObject({ score: 0, pct: 0, passed: true }); // passPct 0 → always pass
  });
  it("numeric outside tolerance / garbage", () => {
    expect(gradeQuiz(Q, { n: "2.5" }, 80).results[2].correct).toBe(false);
    expect(gradeQuiz(Q, { n: "две целых" }, 80).results[2].given).toBeNull();
  });
});

describe("attemptState", () => {
  const a = (pct: number, passed: boolean) => ({ pct, passed, submittedAt: "2026-10-01T10:00:00Z" });
  it("unlimited attempts", () => {
    expect(attemptState([], { passPct: 80, maxAttempts: null })).toMatchObject({ attempts: 0, attemptsLeft: null, canAttempt: true, bestPct: null, passed: false, revealAnswers: false });
  });
  it("limit reached → no attempts, answers revealed", () => {
    const s = attemptState([a(50, false), a(60, false), a(70, false)], { passPct: 80, maxAttempts: 3 });
    expect(s).toMatchObject({ attemptsLeft: 0, canAttempt: false, bestPct: 70, passed: false, revealAnswers: true });
  });
  it("passed once → revealed, best counts", () => {
    const s = attemptState([a(90, true), a(40, false)], { passPct: 80, maxAttempts: 3 });
    expect(s).toMatchObject({ attemptsLeft: 1, canAttempt: true, bestPct: 90, passed: true, revealAnswers: true });
  });
});

describe("public questions / feedback", () => {
  it("public view hides answers", () => {
    const p = publicQuestions(Q);
    expect(JSON.stringify(p)).not.toContain("correct");
    expect(JSON.stringify(p)).not.toContain("2.4");
  });
  it("feedback reveals only when allowed", () => {
    const g = gradeQuiz(Q, { s: "a" }, 80);
    expect(feedbackFor(Q, g, false)[0]).not.toHaveProperty("expected");
    expect(feedbackFor(Q, g, true)[0]).toMatchObject({ expected: { options: ["b"] } });
  });
});

describe("normalizeQuestions", () => {
  it("validates kinds and correct answers", () => {
    const r = normalizeQuestions([
      { kind: "single", prompt: "x", options: [{ text: "a" }, { text: "b" }], correct: ["a", "b"] },
      { kind: "multiple", prompt: "", options: [{ text: "a" }], correct: [] },
      { kind: "numeric", prompt: "y" },
      { kind: "essay", prompt: "z" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(5);
  });
  it("assigns ids and parses comma numbers", () => {
    const r = normalizeQuestions([{ kind: "numeric", prompt: "R?", answer: "2,4", tolerance: "0,05" }, { kind: "single", prompt: "?", options: [{ text: "a" }, { text: "b" }], correct: ["b"] }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0]).toMatchObject({ id: "q1", answer: 2.4, tolerance: 0.05, points: 1 });
      expect(r.value[1]).toMatchObject({ id: "q2", correct: ["b"] });
    }
  });
  it("empty list rejected", () => expect(normalizeQuestions([]).ok).toBe(false));
});

describe("rubric", () => {
  const rub = [{ key: "a", label: "A", maxPoints: 3 }, { key: "b", label: "B", maxPoints: 2 }];
  it("clamps, rounds to 0.5, flags missing", () => {
    const g = gradeRubric(rub, { a: 5, b: "1,26", x: 99 }, 70);
    expect(g.scores).toEqual({ a: 3, b: 1.5 });
    expect(g).toMatchObject({ total: 4.5, maxTotal: 5, pct: 90, passed: true, missing: [] });
    expect(gradeRubric(rub, { a: 1 }, 70).missing).toEqual(["b"]);
    expect(gradeRubric(rub, { a: -1, b: 0 }, 70)).toMatchObject({ total: 0, passed: false });
  });
  it("normalizeRubric rejects bad points, dedupes keys", () => {
    expect(normalizeRubric([{ label: "x", maxPoints: 0 }]).ok).toBe(false);
    const r = normalizeRubric([{ key: "k", label: "x", maxPoints: 2 }, { key: "k", label: "y", maxPoints: 3 }]);
    expect(r.ok && r.value.map((c) => c.key)).toEqual(["k", "k_2"]);
  });
});

describe("submissions", () => {
  it("checkSubmission", () => {
    expect(checkSubmission({ text: " ", url: null, tradeIds: [] }, 0).ok).toBe(false);
    expect(checkSubmission({ text: "план", url: null, tradeIds: [] }, 0).ok).toBe(true);
    expect(checkSubmission({ text: "разбор", url: null, tradeIds: [1, 2] }, 3)).toEqual({ ok: false, code: "SUBMISSION_MIN_TRADES", params: { count: 3 } });
    expect(checkSubmission({ text: "", url: null, tradeIds: [1, 2, 3] }, 3).ok).toBe(true);
  });
  it("parseTradeIds", () => expect(parseTradeIds([1, "2", 2, -1, 1.5, "x", 3])).toEqual([1, 2, 3]));
});

describe("video allow-list", () => {
  it.each<[string, string | null]>([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=1m30s", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90"],
    ["https://youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://vimeo.com/76979871", "https://player.vimeo.com/video/76979871"],
    ["https://player.vimeo.com/video/76979871", "https://player.vimeo.com/video/76979871"],
    ["https://www.loom.com/share/0281766fa2d04bb788eaf19e65135184", "https://www.loom.com/embed/0281766fa2d04bb788eaf19e65135184"],
    ["https://evil.com/watch?v=dQw4w9WgXcQ", null],
    ["https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ", null],
    ["javascript:alert(1)", null],
    ["https://www.youtube.com/watch?v=<script>", null],
  ])("%s", (raw, exp) => expect(videoEmbed(raw)?.embedUrl ?? null).toBe(exp));
  it("parseStartSeconds", () => {
    expect(parseStartSeconds("90")).toBe(90);
    expect(parseStartSeconds("1h2m3s")).toBe(3723);
    expect(parseStartSeconds("x")).toBeNull();
  });
});

describe("attachments", () => {
  it("drops non-http, defaults title to host", () => {
    expect(normalizeAttachments([{ url: "javascript:x" }, { url: "https://docs.example.com/a.pdf" }, { title: " План ", url: "http://x.io" }, null])).toEqual([
      { title: "docs.example.com", url: "https://docs.example.com/a.pdf" }, { title: "План", url: "http://x.io/" },
    ]);
  });
});

describe("computeProgress", () => {
  const items: ProgressItem[] = [
    { kind: "lesson", id: 1, moduleId: 10, position: 10, title: "L1" },
    { kind: "lesson", id: 2, moduleId: 10, position: 20, title: "L2" },
    { kind: "quiz", id: 1, moduleId: 10, position: 30, title: "Q1" },
    { kind: "assignment", id: 1, moduleId: 20, position: 10, title: "A1" },
    { kind: "lesson", id: 3, moduleId: 99, position: 10, title: "orphan" },
  ];
  const facts = (p: Partial<ProgressFacts> = {}): ProgressFacts => ({ lessonsDone: new Set(), quizzes: new Map(), assignments: new Map(), ...p });

  it("empty → 0%, next is first item, orphan module ignored", () => {
    const p = computeProgress(items, [10, 20], facts());
    expect(p).toMatchObject({ total: 4, done: 0, pct: 0, next: { kind: "lesson", id: 1 } });
  });
  it("counts lessons, passed quiz, graded+passed assignment", () => {
    const p = computeProgress(items, [10, 20], facts({
      lessonsDone: new Set([1, 2]),
      quizzes: new Map([[1, { passed: true, bestPct: 90 }]]),
      assignments: new Map([[1, { status: "graded", passed: true }]]),
    }));
    expect(p).toMatchObject({ done: 4, pct: 100, next: null });
    expect(p.modules).toEqual([{ moduleId: 10, total: 3, done: 3, pct: 100 }, { moduleId: 20, total: 1, done: 1, pct: 100 }]);
  });
  it("failed quiz / submitted or failed assignment are in progress, not done", () => {
    const p = computeProgress(items, [10, 20], facts({
      lessonsDone: new Set([1]),
      quizzes: new Map([[1, { passed: false, bestPct: 50 }]]),
      assignments: new Map([[1, { status: "graded", passed: false }]]),
    }));
    expect(p.done).toBe(1);
    expect(p.pct).toBe(25);
    expect(p.status.get("quiz:1")).toBe("in_progress");
    expect(p.status.get("assignment:1")).toBe("in_progress");
    expect(p.next).toMatchObject({ kind: "lesson", id: 2 });
  });
  it("module order drives next", () => {
    expect(computeProgress(items, [20, 10], facts()).next).toMatchObject({ kind: "assignment", id: 1 });
  });
});

describe("cohortSummary", () => {
  it("avg, median, completed, stale", () => {
    const s = cohortSummary([
      { userName: "a", pct: 100, done: 4, total: 4, lastActivity: "2026-10-01T00:00:00Z" },
      { userName: "b", pct: 50, done: 2, total: 4, lastActivity: "2026-10-16T00:00:00Z" },
      { userName: "c", pct: 0, done: 0, total: 4, lastActivity: null },
      { userName: "d", pct: 25, done: 1, total: 4, lastActivity: "2026-10-02T00:00:00Z" },
    ], "2026-10-17T12:00:00Z");
    expect(s).toMatchObject({ students: 4, avgPct: 43.8, medianPct: 37.5, completed: 1, notStarted: 1, stale: ["c", "d"] });
    expect(cohortSummary([], "2026-10-17T00:00:00Z").avgPct).toBeNull();
  });
});

describe("ordering", () => {
  it("applyOrder keeps unknown out and missing at the end", () => {
    const cur = [{ kind: "lesson" as const, id: 1, position: 10 }, { kind: "quiz" as const, id: 1, position: 20 }, { kind: "lesson" as const, id: 2, position: 30 }];
    expect(applyOrder(cur, [{ kind: "lesson", id: 2 }, { kind: "lesson", id: 99 }, { kind: "lesson", id: 1 }, { kind: "lesson", id: 2 }])).toEqual([
      { kind: "lesson", id: 2, position: 10 }, { kind: "lesson", id: 1, position: 20 }, { kind: "quiz", id: 1, position: 30 },
    ]);
  });
  it("applyIdOrder", () => expect(applyIdOrder([1, 2, 3], [3, 1, 7])).toEqual([{ id: 3, position: 10 }, { id: 1, position: 20 }, { id: 2, position: 30 }]));
});

describe("misc", () => {
  it("slugify", () => expect(slugify("Основы проп-трейдинга WS")).toBe("osnovy-prop-treydinga-ws"));
  it("stages: exactly 4", () => {
    expect(STAGES).toEqual(["trainee", "junior", "trader", "senior"]);
    expect(normalizeStage("student")).toBeNull();
  });
});

describe("demo course is internally consistent", () => {
  const items = DEMO_PROGRAM.modules.flatMap((m) => m.items);
  it("6–8 lessons, 2 quizzes, 2 assignments, stage trainee", () => {
    expect(items.filter((i) => i.kind === "lesson").length).toBeGreaterThanOrEqual(6);
    expect(items.filter((i) => i.kind === "lesson").length).toBeLessThanOrEqual(8);
    expect(items.filter((i) => i.kind === "quiz").length).toBe(2);
    expect(items.filter((i) => i.kind === "assignment").length).toBe(2);
    expect(DEMO_PROGRAM.stage).toBe("trainee");
  });
  it("quiz questions pass validation and the answer key scores 100%", () => {
    for (const q of items.filter((i) => i.kind === "quiz")) {
      if (q.kind !== "quiz") continue;
      const v = normalizeQuestions(q.questions);
      expect(v.ok).toBe(true);
      const key = Object.fromEntries(q.questions.map((x) => [x.id, x.kind === "numeric" ? String(x.answer) : x.correct]));
      expect(gradeQuiz(q.questions, key, q.passPct).pct).toBe(100);
    }
  });
  it("rubrics valid, seed keys unique", () => {
    for (const a of items) if (a.kind === "assignment") expect(normalizeRubric(a.rubric).ok).toBe(true);
    const keys = items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("numeric answers in the risk quiz are arithmetically right", () => {
    const q = items.find((i) => i.key === "q-risk");
    if (q?.kind !== "quiz") throw new Error("no quiz");
    const ans = (id: string) => (q.questions.find((x) => x.id === id) as Extract<QuizQuestion, { kind: "numeric" }>).answer;
    expect(ans("r1")).toBeCloseTo((25.6 - 25) / (25 - 24.75), 6);
    expect(ans("r2")).toBeCloseTo(150 / (8.4 - 8.1), 6);
    expect(ans("r3")).toBeCloseTo((6 / 1000) * 100, 6);
    expect(ans("r6")).toBeCloseTo(0.4 * 2 - 0.6 * 1, 6);
    // 93% claim in lesson 2: 867.94 / 932.68
    expect(Math.round((867.94 / 932.68) * 100)).toBe(93);
  });
});
