/**
 * «Сверка с брокером» — journal vs PropReports (engine: lib/reconcile.ts, pure).
 *
 *   GET /reconcile?trader=&from=&to=&reportId=&format=csv
 *     → { scope, generatedAt, summary, days[], reports[], issues[], issuesTruncated }
 *       format=csv → text/csv of the discrepancies (issues with severity warn/error)
 *
 * Read-only: SELECTs on trades, trade_executions, propreports_performance_reports (each guarded with to_regclass,
 * nothing is created or written). Scope: lib/auth scopeTrader — a trader always gets their own book, staff may pick
 * a trader (omitting it reconciles the whole desk), guests get an empty result.
 * Days = NY close date COALESCE(exit_date, date) like /dashboard and /propreports/daily; money via lib/tradeMath.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { scopeTrader } from "../lib/auth";
import { num } from "../lib/tradeMath";
import {
  reconcile, snapshotFrom, reportFrom, issuesCsv,
  type RecTrade, type RecExecution, type RecReport,
} from "../lib/reconcile";
import { AppError, badRequest, unauthorized } from "../lib/http";
import { langOf } from "../i18n";

const router: IRouter = Router();

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const querySchema = z.object({
  trader: z.string().trim().max(120).optional(),
  from: z.string().regex(YMD).optional(),
  to: z.string().regex(YMD).optional(),
  reportId: z.coerce.number().int().positive().optional(),
  format: z.enum(["json", "csv"]).optional(),
});

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
  return !!rows[0]?.ok;
}

const PR_SOURCE = `(t.source = 'propreports' OR t.context_snapshot ->> 'source' = 'propreports')`;

async function loadTrades(scope: string | null): Promise<RecTrade[]> {
  const { rows } = await pool.query(
    `SELECT t.id, t.trader, t.ticker, substring(t.date from 1 for 10) AS date, NULLIF(substring(COALESCE(t.exit_date, '') from 1 for 10), '') AS exit_date,
            t.side, t.qty, t.entry, t.exit, t.pnl, t.fees, t.result,
            CASE WHEN ${PR_SOURCE} THEN 'propreports' ELSE 'manual' END AS source,
            COALESCE(t.external_id, t.context_snapshot ->> 'externalId') AS external_id,
            COALESCE(t.broker_account, t.context_snapshot ->> 'account') AS account,
            CASE WHEN ${PR_SOURCE} THEN t.context_snapshot END AS snap
       FROM trades t
      WHERE t.deleted_at IS NULL AND ($1::text IS NULL OR t.trader = $1)
      ORDER BY t.date, t.id`,
    [scope],
  );
  return rows.map((r: any): RecTrade => ({
    id: Number(r.id), trader: r.trader ?? null, ticker: String(r.ticker ?? "").trim(), date: String(r.date ?? ""), exitDate: r.exit_date ?? null,
    side: r.side ?? null, qty: num(r.qty), entry: num(r.entry), exit: num(r.exit), pnl: num(r.pnl), fees: num(r.fees), result: r.result ?? null,
    source: r.source === "propreports" ? "propreports" : "manual", externalId: r.external_id ?? null, account: r.account ?? null,
    broker: snapshotFrom(r.snap),
  }));
}

async function loadExecutions(scope: string | null): Promise<RecExecution[]> {
  if (!(await tableExists("trade_executions"))) return [];
  const { rows } = await pool.query(
    `SELECT e.id, e.trade_id, e.kind, e.price, e.qty, e.executed_at
       FROM trade_executions e JOIN trades t ON t.id = e.trade_id
      WHERE t.deleted_at IS NULL AND ($1::text IS NULL OR t.trader = $1)`,
    [scope],
  );
  return rows.map((r: any): RecExecution => ({
    id: Number(r.id), tradeId: Number(r.trade_id), kind: String(r.kind ?? ""), price: num(r.price), qty: num(r.qty),
    executedAt: r.executed_at ? new Date(r.executed_at).toISOString() : null,
  }));
}

/** Latest report per account (or the requested one) visible in this scope. */
async function loadReports(scope: string | null, reportId?: number): Promise<RecReport[]> {
  if (!(await tableExists("propreports_performance_reports"))) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (account) id, account, trader_name, period_from, period_to, data
       FROM propreports_performance_reports
      WHERE ($1::text IS NULL OR trader_name = $1) AND ($2::int IS NULL OR id = $2)
      ORDER BY account, period_to DESC, period_from DESC, uploaded_at DESC`,
    [scope, reportId ?? null],
  );
  return rows.map((r: any) => reportFrom({ ...r, data: typeof r.data === "string" ? JSON.parse(r.data) : r.data })).filter((r): r is RecReport => !!r);
}

router.get("/reconcile", asyncHandler(async (req, res): Promise<void> => {
  const q = querySchema.safeParse(req.query);
  if (!q.success) throw badRequest("BAD_REQUEST", q.error.flatten());
  const scope = await scopeTrader(req, q.data.trader);
  if (scope === undefined) throw unauthorized();
  if (q.data.from && q.data.to && q.data.from > q.data.to) throw new AppError("INVALID_RANGE", undefined, { max: 400 });

  const [trades, executions, reports] = await Promise.all([loadTrades(scope), loadExecutions(scope), loadReports(scope, q.data.reportId)]);
  const result = reconcile(trades, executions, reports, { from: q.data.from ?? null, to: q.data.to ?? null, lang: langOf(req) });

  if (q.data.format === "csv") {
    const name = `reconcile-${scope ?? "desk"}-${q.data.from ?? "all"}-${q.data.to ?? "all"}.csv`.replace(/[^\w.\-]+/g, "_");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.send("﻿" + issuesCsv(result.issues.filter((i) => i.severity !== "ok")));
    return;
  }
  res.json({ scope, generatedAt: new Date().toISOString(), ...result });
}));

export default router;
