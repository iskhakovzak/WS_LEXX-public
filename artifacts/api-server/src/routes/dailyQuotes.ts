import { Router, type IRouter } from "express";
import { eq, desc, sql } from "drizzle-orm";
import { db, dailyQuotesTable } from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { handleAiNotConfigured } from "../lib/aiErrors";
import { asyncHandler } from "../lib/asyncHandler";
import { logAudit } from "../lib/audit";
import { AppError, sendError } from "../lib/http";

const router: IRouter = Router();

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2048;
const AI_TIMEOUT_MS = 45_000;

function todayKey(): string {
  const tz = "Europe/Moscow";
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date());
}

// i18n-ignore-next (AI prompt — model input; quotes come back in every language)
const SYSTEM_PROMPT = `Ты — мудрый тренер по трейдингу и психологии для команды профессиональных дей-трейдеров (prop desk). Твоя задача — создать ДВЕ глубокие, неизбитые цитаты на ЧЕТЫРЁХ языках. Каждая цитата — короткая (1-2 предложения), запоминающаяся, развивающая мышление. Избегай банальностей. Допускаются цитаты реальных трейдеров/мыслителей с указанием автора, или твои оригинальные афоризмы (тогда author = null).

Категории:
1. trading — про мастерство трейдинга, риск, рынок, сетапы, дисциплину исполнения, edge, statistical thinking
2. psychology — про эмоции трейдера, страх/жадность, FOMO, tilt, фокус, терпение, контроль, идентичность

Языки:
- ru — русский (грамотный, без англицизмов где можно)
- uz — узбекский (latin script, современный литературный)
- uk — украинский (грамотный)
- en — английский (естественный, как у нативного автора, без кальки с русского)

ВАЖНО: цитата должна нести ОДНУ И ТУ ЖЕ мысль на всех четырёх языках, но звучать естественно для каждого языка (не дословный перевод).

Верни СТРОГО JSON без markdown без объяснений:
{
  "trading": {
    "ru": "...",
    "uz": "...",
    "uk": "...",
    "en": "...",
    "author": "Имя автора или null"
  },
  "psychology": {
    "ru": "...",
    "uz": "...",
    "uk": "...",
    "en": "...",
    "author": "Имя автора или null"
  }
}`;

interface QuoteBundle {
  trading: { ru: string; uz: string; uk: string; en: string; author: string | null };
  psychology: { ru: string; uz: string; uk: string; en: string; author: string | null };
}

const inFlight = new Map<string, Promise<QuoteBundle>>();

function singleflightGenerate(date: string): Promise<QuoteBundle> {
  const existing = inFlight.get(date);
  if (existing) return existing;
  const p = generateBundle(date).finally(() => {
    inFlight.delete(date);
  });
  inFlight.set(date, p);
  return p;
}

export async function generateBundleAndUpsert(date: string): Promise<void> {
  const bundle = await singleflightGenerate(date);
  await db.insert(dailyQuotesTable).values({
    date,
    tradingRu: bundle.trading.ru,
    tradingUz: bundle.trading.uz,
    tradingUk: bundle.trading.uk,
    tradingEn: bundle.trading.en ?? null,
    tradingAuthor: bundle.trading.author ?? null,
    psychologyRu: bundle.psychology.ru,
    psychologyUz: bundle.psychology.uz,
    psychologyUk: bundle.psychology.uk,
    psychologyEn: bundle.psychology.en ?? null,
    psychologyAuthor: bundle.psychology.author ?? null,
    source: "ai",
  }).onConflictDoUpdate({
    target: dailyQuotesTable.date,
    set: {
      tradingRu: bundle.trading.ru,
      tradingUz: bundle.trading.uz,
      tradingUk: bundle.trading.uk,
      tradingEn: bundle.trading.en ?? null,
      tradingAuthor: bundle.trading.author ?? null,
      psychologyRu: bundle.psychology.ru,
      psychologyUz: bundle.psychology.uz,
      psychologyUk: bundle.psychology.uk,
      psychologyEn: bundle.psychology.en ?? null,
      psychologyAuthor: bundle.psychology.author ?? null,
      source: "ai",
      createdAt: sql`NOW()`,
    },
  });
}

async function generateBundle(date: string): Promise<QuoteBundle> {
  // i18n-ignore-next (AI prompt — model input)
  const userMsg = `Сгенерируй пару цитат на сегодня (${date}). Тема трейдинговой цитаты: на твоё усмотрение из набора {risk, edge, patience, position sizing, discipline, statistical edge, market structure, execution}. Тема психологической цитаты: на твоё усмотрение из набора {tilt control, FOMO, fear vs analysis, focus, identity, emotional detachment, post-loss recovery, win mindset}.`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const result = await anthropic.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMsg }],
      },
      { signal: controller.signal as RequestInit["signal"] },
    );
    const block = result.content[0];
    const text = block && block.type === "text" ? block.text : "";
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd < 0) throw new Error("AI returned no JSON");
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as QuoteBundle;
    if (!parsed?.trading?.ru || !parsed?.psychology?.ru) throw new Error("AI response missing fields");
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

const FALLBACK_BUNDLE: QuoteBundle = {
  trading: {
    ru: "Edge — это не предсказание движения, а статистика твоих решений на дистанции.", // i18n-ignore (fallback quote — data in every language)
    uz: "Edge — bu narx harakatini bashorat qilish emas, masofada qabul qilingan qarorlar statistikasidir.",
    uk: "Edge — це не передбачення руху, а статистика твоїх рішень на дистанції.", // i18n-ignore (fallback quote — data in every language)
    en: "Edge isn't predicting the move; it's the statistics of your decisions over time.",
    author: null,
  },
  psychology: {
    ru: "Лучший трейд дня — тот, который ты не сделал, потому что не было сетапа.", // i18n-ignore (fallback quote — data in every language)
    uz: "Kunning eng yaxshi savdosi — sen qilmagan savdo, chunki to‘g‘ri setup yo‘q edi.",
    uk: "Найкращий трейд дня — той, який ти не зробив, бо не було сетапу.", // i18n-ignore (fallback quote — data in every language)
    en: "The best trade of the day is the one you didn't take because there was no setup.",
    author: null,
  },
};

router.get("/daily-quote/today", asyncHandler(async (req, res): Promise<void> => {
  const date = todayKey();
  const existing = await db.select().from(dailyQuotesTable).where(eq(dailyQuotesTable.date, date)).limit(1);
  if (existing.length > 0) {
    res.json(existing[0]);
    return;
  }
  let bundle: QuoteBundle;
  let source = "ai";
  try {
    bundle = await singleflightGenerate(date);
  } catch (e: any) {
    req.log.warn({ error: e.message }, "daily-quote: AI generation failed, using fallback");
    bundle = FALLBACK_BUNDLE;
    source = "fallback";
  }
  try {
    const [row] = await db.insert(dailyQuotesTable).values({
      date,
      tradingRu: bundle.trading.ru,
      tradingUz: bundle.trading.uz,
      tradingUk: bundle.trading.uk,
      tradingEn: bundle.trading.en ?? null,
      tradingAuthor: bundle.trading.author ?? null,
      psychologyRu: bundle.psychology.ru,
      psychologyUz: bundle.psychology.uz,
      psychologyUk: bundle.psychology.uk,
      psychologyEn: bundle.psychology.en ?? null,
      psychologyAuthor: bundle.psychology.author ?? null,
      source,
    }).returning();
    res.json(row);
  } catch (e: any) {
    const again = await db.select().from(dailyQuotesTable).where(eq(dailyQuotesTable.date, date)).limit(1);
    if (again.length > 0) {
      res.json(again[0]);
      return;
    }
    throw e;
  }
}));

router.post("/daily-quote/regenerate", asyncHandler(async (req, res): Promise<void> => {
  const date = todayKey();
  const actor = typeof (req.body as any)?.actor === "string" ? (req.body as any).actor : "unknown";
  let bundle: QuoteBundle;
  try {
    bundle = await singleflightGenerate(date);
  } catch (e: any) {
    if (handleAiNotConfigured(e, res)) return; // 503 ai_not_configured (audit P2-3)
    req.log.warn({ error: e.message }, "daily-quote regenerate: AI failed");
    sendError(res, new AppError("AI_UNAVAILABLE", 503));
    return;
  }
  await db.delete(dailyQuotesTable).where(eq(dailyQuotesTable.date, date));
  const [row] = await db.insert(dailyQuotesTable).values({
    date,
    tradingRu: bundle.trading.ru,
    tradingUz: bundle.trading.uz,
    tradingUk: bundle.trading.uk,
    tradingEn: bundle.trading.en ?? null,
    tradingAuthor: bundle.trading.author ?? null,
    psychologyRu: bundle.psychology.ru,
    psychologyUz: bundle.psychology.uz,
    psychologyUk: bundle.psychology.uk,
    psychologyEn: bundle.psychology.en ?? null,
    psychologyAuthor: bundle.psychology.author ?? null,
    source: "ai",
  }).returning();
  await logAudit({ actor, action: "daily_quote.regenerate", targetType: "daily_quote", targetId: date });
  res.json(row);
}));

router.get("/daily-quote/recent", asyncHandler(async (_req, res): Promise<void> => {
  const rows = await db.select().from(dailyQuotesTable).orderBy(desc(dailyQuotesTable.date)).limit(14);
  res.json(rows);
}));

export default router;
