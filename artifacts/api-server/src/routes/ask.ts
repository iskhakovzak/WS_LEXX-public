/**
 * «Спроси журнал» — the compact trade book the client-side question engine runs on (no AI, GET only).
 *
 *   GET /ask/book           ?mine=1 | ?trader=<name> [&enc=2]
 *        { cols, rows (tuples in `cols` order), truncated, scope (trader name | null = whole desk), redacted }
 *        enc=2 → compact rows (dictionary-encoded strings, clock stamps as seconds) — lib/askBook askBookCompact.
 *        Gzipped when the client accepts it (the desk book is ~45k rows); X-Raw-Length = uncompressed bytes, so the
 *        page can show load progress against the body it actually reads.
 *
 * Scope via lib/auth scopeTrader — the same rule as /trades and /trades/page: a trader always gets their own book
 * (any ?trader= is ignored), staff get the whole desk or the trader they ask for, a guest gets nothing, anonymous → 401.
 * `mine=1` asks for the viewer's own book (the page's default — small and fast; staff widen to the desk explicitly).
 * $ (pnl / fees / qty / riskUsd) of trades the viewer may not see are nulled (lib/playbookPrivacy) — lib/askBook.
 */
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { GUEST_SCOPE, scopeTrader } from "../lib/auth";
import { loadMoneyViewer } from "../lib/playbookAccess";
import { askBookCompact, askBookQuery, askBookResponse, type AskBookDbRow, type AskBookResponse } from "../lib/askBook";
import { unauthorized } from "../lib/http";

const router: IRouter = Router();
const gzipAsync = promisify(gzip);

/** Below this a plain res.json is cheaper than compressing. */
const GZIP_MIN_BYTES = 8 * 1024;

async function sendBook(req: Request, res: Response, book: AskBookResponse): Promise<void> {
  const enc = req.query.enc === "2";
  const body = JSON.stringify(enc ? askBookCompact(book) : book);
  const raw = Buffer.byteLength(body);
  const accepts = /\bgzip\b/i.test(String(req.headers["accept-encoding"] ?? ""));
  res.setHeader("Vary", "Accept-Encoding");
  if (!accepts || raw < GZIP_MIN_BYTES) { res.type("application/json").send(body); return; }
  const zipped = await gzipAsync(body, { level: 6 });
  res.setHeader("Content-Encoding", "gzip");
  res.setHeader("X-Raw-Length", String(raw));
  res.type("application/json").send(zipped);
}

router.get("/ask/book", asyncHandler(async (req, res) => {
  const mine = req.query.mine === "1" || req.query.mine === "true";
  const traderParam = typeof req.query.trader === "string" ? req.query.trader.slice(0, 120) : undefined;
  const mv = await loadMoneyViewer(req);
  const scope = await scopeTrader(req, mine ? (mv.name ?? undefined) : traderParam);
  if (scope === undefined) throw unauthorized();
  res.setHeader("Cache-Control", "private, no-store");
  // Guests read no trades; staff without a trader name asking for «mine» own none.
  if (scope === GUEST_SCOPE || (mine && !mv.name)) {
    await sendBook(req, res, askBookResponse([], mv, mine ? mv.name : null));
    return;
  }
  const q = askBookQuery(scope);
  const { rows } = await pool.query<AskBookDbRow>(q.sql, q.params);
  await sendBook(req, res, askBookResponse(rows, mv, scope));
}));

export default router;
