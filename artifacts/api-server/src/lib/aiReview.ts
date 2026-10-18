import crypto from "node:crypto";
import { db, tradesTable, aiTradeReviewsTable, aiReviewRateLimitTable, playbookTable, emotionalStateLogTable } from "@workspace/db";
import { eq, and, desc, gte, isNull, sql } from "drizzle-orm";
import { anthropic, AnthropicNotConfiguredError, isAnthropicConfigured } from "@workspace/integrations-anthropic-ai";
import { isAiNotConfigured } from "./aiErrors";
import { logger } from "./logger";
import { config } from "../config";
import { nyDate } from "./tradingDate";
import type { ContextSnapshot } from "./marketContext";
import { localeOfUser, type Lang } from "../i18n";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4096;

const COST_PER_M_INPUT = 3.0;
const COST_PER_M_OUTPUT = 15.0;

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_PER_USER = 30;

const AI_TIMEOUT_MS = 60_000;
const AI_MAX_RETRIES = 2;
const AI_RETRY_BASE_MS = 3_000;

const DAILY_COST_BUDGET_USD = config.ai.dailyCostBudgetUsd;

interface DailyBudget {
  date: string;
  costUsd: number;
  disabled: boolean;
}
let dailyBudget: DailyBudget = { date: "", costUsd: 0, disabled: false };

// Daily AI budget resets on the New York trading date (audit P1-12).
function getTodayStr(): string {
  return nyDate();
}

function getBudget(): DailyBudget {
  const today = getTodayStr();
  if (dailyBudget.date !== today) {
    dailyBudget = { date: today, costUsd: 0, disabled: false };
  }
  return dailyBudget;
}

function recordCost(costUsd: number): void {
  const budget = getBudget();
  budget.costUsd += costUsd;
  if (budget.costUsd >= DAILY_COST_BUDGET_USD) {
    if (!budget.disabled) {
      budget.disabled = true;
      logger.warn({ dailyCostUsd: budget.costUsd, limitUsd: DAILY_COST_BUDGET_USD }, "AI daily cost budget exceeded — auto-review disabled for today");
    }
  }
}

function isBudgetExceeded(): boolean {
  return getBudget().disabled;
}

export class RateLimitedError extends Error {
  retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super(`AI review rate limit reached. Try again in ${retryAfterSec}s.`);
    this.name = "RateLimitedError";
    this.retryAfterSec = retryAfterSec;
  }
}

export async function checkRateLimit(userKey: string): Promise<void> {
  const cutoff = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const rows = await db
    .select({ id: aiReviewRateLimitTable.id, createdAt: aiReviewRateLimitTable.createdAt })
    .from(aiReviewRateLimitTable)
    .where(and(eq(aiReviewRateLimitTable.userKey, userKey), gte(aiReviewRateLimitTable.createdAt, cutoff)))
    .orderBy(desc(aiReviewRateLimitTable.createdAt));
  if (rows.length >= RATE_LIMIT_PER_USER) {
    const oldest = rows[rows.length - 1];
    const retryMs = RATE_LIMIT_WINDOW_MS - (Date.now() - oldest.createdAt.getTime());
    throw new RateLimitedError(Math.max(1, Math.ceil(retryMs / 1000)));
  }
}

async function recordRateLimitHit(userKey: string, tradeId: number) {
  await db.insert(aiReviewRateLimitTable).values({ userKey, tradeId }).catch(() => {});
}

function hashPrompt(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function num(x: unknown): number | null {
  if (x == null) return null;
  const n = Number(x);
  return isNaN(n) ? null : n;
}

function tradeSnapshotForPrompt(t: Record<string, unknown>) {
  return {
    id: t["id"],
    ticker: t["ticker"],
    date: t["date"],
    setup: t["setup"] ?? null,
    side: t["side"] ?? null,
    eventType: t["eventType"] ?? null,
    entry: num(t["entry"]),
    exit: num(t["exit"]),
    stop: num(t["stop"]),
    result: t["result"],
    pnl: num(t["pnl"]),
    rMultiple: num(t["rMultiple"]),
    holdTime: t["holdTime"] ?? null,
    session: t["session"] ?? null,
    relativeVolume: num(t["relativeVolume"]),
    atr: num(t["atr"]),
    sector: t["sector"] ?? null,
    notes: t["notes"] ?? null,
    whatWorked: t["whatWorked"] ?? null,
    whatFailed: t["whatFailed"] ?? null,
  };
}

async function loadSimilarTrades(trade: typeof tradesTable.$inferSelect, limit = 20) {
  const { setup, ticker, eventType, trader, id } = trade;
  if (!setup && !ticker && !eventType) return [];
  const orCondition = sql`(${tradesTable.setup} = ${setup} OR ${tradesTable.ticker} = ${ticker} OR ${tradesTable.eventType} = ${eventType})`;
  const filters = [isNull(tradesTable.deletedAt), sql`${tradesTable.id} <> ${id}`, orCondition];
  if (trader) filters.push(eq(tradesTable.trader, trader));
  const rows = await db
    .select()
    .from(tradesTable)
    .where(and(...(filters as Parameters<typeof and>)))
    .orderBy(desc(tradesTable.createdAt))
    .limit(limit);
  return rows.map((r) => tradeSnapshotForPrompt(r as unknown as Record<string, unknown>));
}

async function loadEmotionalState(trader: string | null, date: string | null) {
  if (!trader || !date) return null;
  const [row] = await db
    .select()
    .from(emotionalStateLogTable)
    .where(and(eq(emotionalStateLogTable.userId, trader), eq(emotionalStateLogTable.date, date)))
    .limit(1);
  if (!row) return null;
  return {
    sleepWell: row.sleepWell,
    stressed: row.stressed,
    tilted: row.tilted,
    focused: row.focused,
    anxious: row.anxious,
    revenge: row.revenge,
    freeText: row.freeText ?? null,
  };
}

async function loadPlaybook(setup: string | null) {
  if (!setup) return null;
  const rows = await db
    .select()
    .from(playbookTable)
    .where(and(isNull(playbookTable.deletedAt), sql`(${playbookTable.name} = ${setup} OR ${playbookTable.setupType} = ${setup})`))
    .limit(1);
  if (!rows[0]) return null;
  const p = rows[0];
  return {
    name: p.name,
    setupType: p.setupType ?? null,
    conditions: p.conditions ?? null,
    checklist: p.checklist ?? null,
    notes: p.notes ?? null,
  };
}

/** Answer-language line of the system prompt (RU text unchanged → existing cached reviews keep their prompt hash). */
const REPLY_IN: Record<Lang, string> = {
  ru: "Reply in Russian (the trader is Russian-speaking).",
  en: "Reply in English (the trader reads the app in English). Keep tickers, numbers and trading terms as is.",
  uz: "Reply in Uzbek, Latin script (the trader reads the app in Uzbek). Keep tickers, numbers and trading terms as is.",
};

function buildPrompt(args: {
  lang?: Lang;
  trade: typeof tradesTable.$inferSelect;
  context: ContextSnapshot | null;
  similar: ReturnType<typeof tradeSnapshotForPrompt>[];
  playbook: Awaited<ReturnType<typeof loadPlaybook>>;
  emotionalState: Awaited<ReturnType<typeof loadEmotionalState>>;
}): { system: string; user: string } {
  const { trade, context, similar, playbook, emotionalState } = args;
  const t = tradeSnapshotForPrompt(trade as unknown as Record<string, unknown>);
  const stats = (() => {
    if (!similar.length) return null;
    const wins = similar.filter((s) => s.result === "win" || s.result === "прибыль").length; // i18n-ignore (legacy stored result value)
    const validR = similar.filter((s) => s.rMultiple != null);
    const avgR = validR.length ? validR.reduce((a, s) => a + (s.rMultiple || 0), 0) / validR.length : null;
    const totalPnl = similar.reduce((a, s) => a + (s.pnl || 0), 0);
    return {
      sample: similar.length,
      winRate: wins / similar.length,
      avgRMultiple: avgR,
      avgPnl: totalPnl / similar.length,
    };
  })();

  const system = [
    "You are an experienced prop-trading coach reviewing a single trade for a junior trader.",
    "Be specific, evidence-driven, and concise. Reference the data provided.",
    "Your job is to find what went well, what went wrong, and concrete improvements grounded in this trader's own historical statistics and the market context.",
    "Do NOT invent facts. Only use what is in the data. If something is missing, say so.",
    REPLY_IN[args.lang ?? "ru"],
    "Return STRICT JSON matching the requested schema. No prose outside the JSON.",
  ].join(" ");

  const psychologyContext = {
    conviction: trade.conviction ?? null,
    confidenceGrade: trade.confidenceGrade ?? null,
    emotionalState: emotionalState ?? null,
  };

  const schema = {
    summary: "string — короткое (1-2 предложения) общее резюме", // i18n-ignore (AI schema — model input)
    entryTiming: "string — анализ тайминга входа: рано/поздно/норм + почему (по данным)", // i18n-ignore (AI schema — model input)
    statisticalComparison: "string — сравнение со статистикой похожих трейдов трейдера (использовать stats)", // i18n-ignore (AI schema — model input)
    playbookDeviation: "string — соответствие/отклонение от playbook условий (если playbook есть)", // i18n-ignore (AI schema — model input)
    riskErrors: "string — ошибки риск-менеджмента (R, стоп, размер, slippage, missed confirmation)", // i18n-ignore (AI schema — model input)
    alternativeExecution: "string — лучшая альтернатива исполнения", // i18n-ignore (AI schema — model input)
    psychologyImpact: "string — как убеждённость, грейд уверенности и эмоциональное состояние повлияли на трейд (если данные есть, иначе null)", // i18n-ignore (AI schema — model input)
    grade: "string — общая оценка: A/B/C/D/F", // i18n-ignore (AI schema — model input)
    confidence: "number — уверенность в анализе 0..1", // i18n-ignore (AI schema — model input)
    strengths: "string[] — 1-4 конкретные сильные стороны сделки (что сделано правильно), каждая — одно короткое предложение; [] если нет", // i18n-ignore (AI schema — model input)
    mistakes: "string[] — 1-4 конкретные ошибки (вход, риск, плейбук, психология), каждая — одно короткое предложение; [] если нет", // i18n-ignore (AI schema — model input)
    nextTime: "string[] — 1-3 конкретных действия на следующий раз (что делать иначе), в повелительном наклонении", // i18n-ignore (AI schema — model input)
  };

  const user = [
    "TRADE:",
    JSON.stringify(t, null, 2),
    "",
    "TRADER_PSYCHOLOGY (conviction 1-5, confidence grade A+/A/B/C, emotional state on trade date):",
    JSON.stringify(psychologyContext, null, 2),
    "",
    "MARKET_CONTEXT:",
    JSON.stringify(context ?? null, null, 2),
    "",
    "SIMILAR_TRADES_BY_TRADER (same setup/ticker/event):",
    JSON.stringify(similar, null, 2),
    "",
    "TRADER_STATS_FROM_SIMILAR:",
    JSON.stringify(stats, null, 2),
    "",
    "PLAYBOOK_REFERENCE:",
    JSON.stringify(playbook, null, 2),
    "",
    "Return ONLY a JSON object with these fields:",
    JSON.stringify(schema, null, 2),
  ].join("\n");

  return { system, user };
}

const LIST_FIELDS = ["strengths", "mistakes", "nextTime"] as const;
const LIST_MAX_ITEMS = 6;
const LIST_MAX_LEN = 500;

/** Coerce a model value into a clean string[] (accepts arrays or bulleted strings). */
function toStringList(v: unknown): string[] {
  const raw: unknown[] = Array.isArray(v)
    ? v
    : typeof v === "string"
      ? v.split(/\r?\n+/).map((l) => l.replace(/^\s*([-•*]|\d+[.)])\s+/, ""))
      : [];
  return raw
    .map((x) => (typeof x === "string" ? x : x && typeof x === "object" && "text" in x ? String((x as { text: unknown }).text) : ""))
    .map((s) => s.trim().slice(0, LIST_MAX_LEN))
    .filter((s) => s.length > 0 && !/^(null|none|n\/a|нет|нет данных|—|-)$/i.test(s))
    .slice(0, LIST_MAX_ITEMS);
}

/**
 * Additive normalisation: only touches strengths/mistakes/nextTime when the
 * model returned them, so older reviews (without these keys) keep their shape
 * and the client falls back to riskErrors/alternativeExecution/etc.
 */
function normalizeSections(obj: unknown): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = { ...(obj as Record<string, unknown>) };
  for (const key of LIST_FIELDS) {
    if (key in out) out[key] = toStringList(out[key]);
  }
  return out;
}

function parseSections(text: string) {
  return normalizeSections(parseSectionsRaw(text));
}

function parseSectionsRaw(text: string) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/i, "").replace(/```\s*$/, "");
  }
  try {
    const obj = JSON.parse(cleaned);
    return obj;
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch {}
    }
    return { summary: cleaned };
  }
}

type AnthropicMessage = { content: Array<{ type: string; text?: string }>; usage: { input_tokens: number; output_tokens: number } };

async function callAnthropicWithRetry(args: { system: string; user: string }): Promise<AnthropicMessage> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = AI_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    try {
      const result = await anthropic.messages.create(
        { model: MODEL, max_tokens: MAX_TOKENS, system: args.system, messages: [{ role: "user", content: args.user }] },
        { signal: controller.signal as RequestInit["signal"] },
      );
      clearTimeout(timer);
      return result as unknown as AnthropicMessage;
    } catch (e: unknown) {
      clearTimeout(timer);
      const err = e as Error;
      lastError = err;
      const isRetryable = err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ECONNRESET" || String(err.message).includes("529") || String(err.message).includes("overloaded");
      if (!isRetryable || attempt === AI_MAX_RETRIES) break;
      logger.warn({ attempt, error: err.message }, "Anthropic call failed, retrying");
    }
  }
  throw lastError ?? new Error("AI review generation failed");
}

export type ReviewResult = {
  reviewId: number;
  tradeId: number;
  model: string;
  reviewText: string;
  sections: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  generatedAt: string;
};

export async function generateReview(args: { tradeId: number; userKey: string; force?: boolean; lang?: Lang }): Promise<ReviewResult> {
  const { tradeId, force } = args;

  const [trade] = await db.select().from(tradesTable).where(eq(tradesTable.id, tradeId));
  if (!trade) throw new Error(`Trade ${tradeId} not found`);

  const trustedUserKey = (trade.trader && String(trade.trader).trim()) || `trade:${tradeId}`;
  await checkRateLimit(trustedUserKey);
  const userKey = trustedUserKey;

  const context = (trade.contextSnapshot as ContextSnapshot | null) ?? null;

  const [similar, playbook, emotionalState] = await Promise.all([
    loadSimilarTrades(trade, 20),
    loadPlaybook(trade.setup ?? null),
    loadEmotionalState(trade.trader ?? null, trade.date ?? null),
  ]);

  // Answer language: the requester's (route) or, for auto-reviews, the trader's own locale. It is part of the prompt → of promptHash.
  const lang = args.lang ?? (await localeOfUser(trade.trader ?? null));
  const { system, user } = buildPrompt({ trade, context, similar, playbook, emotionalState, lang });
  const promptHash = hashPrompt(system + "\n" + user + MODEL);

  if (!force) {
    const [existing] = await db
      .select()
      .from(aiTradeReviewsTable)
      .where(and(eq(aiTradeReviewsTable.tradeId, tradeId), eq(aiTradeReviewsTable.promptHash, promptHash)))
      .orderBy(desc(aiTradeReviewsTable.generatedAt))
      .limit(1);
    if (existing) {
      return {
        reviewId: existing.id,
        tradeId: existing.tradeId,
        model: existing.model,
        reviewText: existing.reviewText,
        sections: existing.sections ?? null,
        inputTokens: existing.inputTokens,
        outputTokens: existing.outputTokens,
        costUsd: existing.costUsd != null ? Number(existing.costUsd) : null,
        generatedAt: existing.generatedAt.toISOString(),
      };
    }
  }

  // No AI env: fail before spending a rate-limit slot; routes map this to 503 ai_not_configured (audit P2-3).
  if (!isAnthropicConfigured()) throw new AnthropicNotConfiguredError("AI_INTEGRATIONS_ANTHROPIC_API_KEY");

  await recordRateLimitHit(userKey, tradeId);

  let message: AnthropicMessage;
  try {
    message = await callAnthropicWithRetry({ system, user });
  } catch (e: unknown) {
    if (isAiNotConfigured(e)) throw e;
    const err = e as Error;
    logger.error({ error: err.message, tradeId }, "Anthropic call failed");
    throw new Error(`AI review generation failed: ${err.message}`);
  }

  const block = (message.content as Array<{ type: string; text?: string }>)?.[0];
  const reviewText: string = block && block.type === "text" ? (block.text ?? "") : "";
  const sections = parseSections(reviewText);
  const inputTokens = message.usage?.input_tokens ?? null;
  const outputTokens = message.usage?.output_tokens ?? null;
  const costUsd = inputTokens != null && outputTokens != null
    ? +((inputTokens / 1_000_000) * COST_PER_M_INPUT + (outputTokens / 1_000_000) * COST_PER_M_OUTPUT).toFixed(6)
    : null;

  if (costUsd != null) recordCost(costUsd);

  const [inserted] = await db
    .insert(aiTradeReviewsTable)
    .values({
      tradeId,
      model: MODEL,
      promptHash,
      reviewText,
      sections,
      inputTokens,
      outputTokens,
      costUsd: costUsd != null ? String(costUsd) : null,
    })
    .returning();

  logger.info({ tradeId, model: MODEL, inputTokens, outputTokens, costUsd, userKey }, "AI review generated");

  return {
    reviewId: inserted.id,
    tradeId,
    model: MODEL,
    reviewText,
    sections,
    inputTokens,
    outputTokens,
    costUsd,
    generatedAt: inserted.generatedAt.toISOString(),
  };
}

function isClosedResult(result: string | null | undefined): boolean {
  if (!result) return false;
  const s = String(result).toLowerCase();
  return s === "win" || s === "loss" || s === "be" || s === "прибыль" || s === "убыток"; // i18n-ignore (legacy stored result values)
}

const AUTO_REVIEW_DELAY_MS = 8_000;
const recentlyAutoQueued = new Map<number, number>();
const AUTO_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

export function maybeAutoGenerateReview(args: {
  tradeId: number;
  result: string | null | undefined;
  trader: string | null | undefined;
}): void {
  if (!isClosedResult(args.result)) return;
  if (isBudgetExceeded()) {
    logger.info({ tradeId: args.tradeId }, "auto AI review skipped (daily cost budget exceeded)");
    return;
  }
  const userKey = (args.trader && String(args.trader).trim()) || "system";
  const now = Date.now();
  const last = recentlyAutoQueued.get(args.tradeId);
  if (last && now - last < AUTO_DEDUPE_WINDOW_MS) return;
  recentlyAutoQueued.set(args.tradeId, now);

  setTimeout(() => {
    if (isBudgetExceeded()) {
      logger.info({ tradeId: args.tradeId }, "auto AI review skipped at execution (daily cost budget exceeded)");
      return;
    }
    generateReview({ tradeId: args.tradeId, userKey })
      .then((r) => logger.info({ tradeId: args.tradeId, costUsd: r.costUsd, userKey }, "auto AI review generated"))
      .catch((e: unknown) => {
        const err = e as Error;
        if (err?.name === "RateLimitedError") {
          logger.info({ tradeId: args.tradeId, userKey, retryAfterSec: (err as RateLimitedError).retryAfterSec }, "auto AI review skipped (rate-limited)");
        } else {
          logger.warn({ tradeId: args.tradeId, userKey, error: err?.message }, "auto AI review failed");
        }
      });
  }, AUTO_REVIEW_DELAY_MS);
}

export async function getLatestReview(tradeId: number): Promise<ReviewResult | null> {
  const [row] = await db
    .select()
    .from(aiTradeReviewsTable)
    .where(eq(aiTradeReviewsTable.tradeId, tradeId))
    .orderBy(desc(aiTradeReviewsTable.generatedAt))
    .limit(1);
  if (!row) return null;
  return {
    reviewId: row.id,
    tradeId: row.tradeId,
    model: row.model,
    reviewText: row.reviewText,
    sections: row.sections ?? null,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd != null ? Number(row.costUsd) : null,
    generatedAt: row.generatedAt.toISOString(),
  };
}
