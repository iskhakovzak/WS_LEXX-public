import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { getTickerNews } from "../lib/marketDataService";
import { logger } from "../lib/logger";
import { AppError, badRequest } from "../lib/http";

const router: IRouter = Router();

const SYMBOL_RE = /^[A-Z0-9.\-^=]{1,12}$/;

/**
 * GET /api/news/summary?tickers=A,B — cache-only per-ticker news digest (no upstream calls).
 * Used by list views (watchlist) to show "fresh news" badges without hammering providers.
 * Response: { tickers: { [T]: { count24h, count7d, categories24h: string[], latest: { title, category, publishedAt, url, source } | null } } }
 */
router.get("/news/summary", asyncHandler(async (req, res): Promise<void> => {
  const tickers = Array.from(new Set(
    String(req.query.tickers || "").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean),
  ));
  if (!tickers.length) throw new AppError("FIELD_REQUIRED", undefined, { field: "tickers" });
  if (tickers.length > 100) throw new AppError("TOO_MANY", undefined, { field: "tickers", max: 100 });
  const bad = tickers.find((t) => !SYMBOL_RE.test(t));
  if (bad) throw new AppError("INVALID_TICKER", 400, undefined, { ticker: bad });

  const out: Record<string, {
    count24h: number; count7d: number; categories24h: string[];
    latest: { title: string; category: string; publishedAt: string | null; url: string | null; source: string | null } | null;
  }> = {};
  for (const t of tickers) out[t] = { count24h: 0, count7d: 0, categories24h: [], latest: null };

  try {
    const { rows: counts } = await pool.query<{ ticker: string; c24: string; c7: string; cats: string[] | null }>(
      `SELECT ticker,
              COUNT(*) FILTER (WHERE published_at >= NOW() - INTERVAL '24 hours') AS c24,
              COUNT(*) AS c7,
              ARRAY_AGG(DISTINCT category) FILTER (WHERE published_at >= NOW() - INTERVAL '24 hours') AS cats
         FROM news_cache
        WHERE ticker = ANY($1::text[])
          AND is_ticker_specific = TRUE
          AND published_at IS NOT NULL
          AND published_at >= NOW() - INTERVAL '7 days'
          AND published_at <= NOW() + INTERVAL '1 hour'
        GROUP BY ticker`,
      [tickers],
    );
    for (const r of counts) {
      const o = out[r.ticker];
      if (!o) continue;
      o.count24h = Number(r.c24) || 0;
      o.count7d = Number(r.c7) || 0;
      o.categories24h = (r.cats ?? []).filter(Boolean);
    }
    const { rows: latest } = await pool.query<{ ticker: string; title: string; category: string; published_at: Date | null; url: string | null; source: string | null }>(
      `SELECT DISTINCT ON (ticker) ticker, title, category, published_at, url, source
         FROM news_cache
        WHERE ticker = ANY($1::text[])
          AND is_ticker_specific = TRUE
          AND published_at IS NOT NULL
          AND published_at <= NOW() + INTERVAL '1 hour'
        ORDER BY ticker, published_at DESC`,
      [tickers],
    );
    for (const r of latest) {
      const o = out[r.ticker];
      if (!o) continue;
      o.latest = {
        title: r.title,
        category: r.category,
        publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
        url: r.url,
        source: r.source,
      };
    }
  } catch (err) {
    // news_cache may not exist yet on a fresh install — return empty digests.
    logger.warn({ err }, "news summary: cache query failed");
  }
  res.json({ tickers: out });
}));

router.get("/news", asyncHandler(async (req, res): Promise<void> => {
  const ticker = String(req.query.ticker || "").toUpperCase().trim();
  if (!ticker) throw badRequest("TICKER_REQUIRED");
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 15));
  const force = req.query.force === "1" || req.query.force === "true";
  let before: Date | null = null;
  if (req.query.before) {
    const d = new Date(String(req.query.before));
    if (!isNaN(d.getTime())) before = d;
  }
  const items = await getTickerNews(ticker, { limit, force, before });
  res.json({ ticker, items, before: before ? before.toISOString() : null });
}));

export default router;
