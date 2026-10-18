import type { Trade } from "@workspace/api-client-react";
import {
  chrono, dailySeries, dayKey, feesOf, fmtValue, horizonOf, horizonLabel, sessionKey, sessionLabel, tx, valueOf,
  type FeeStats, type Kpis, type Metric,
} from "./metrics";
import { fmtDate, fmtRate, fmtRatio, localeTag } from "@/lib/format";
import { statsI18n } from "@/i18n/ns/stats";
import { personName } from "@/i18n";

export type ReportMeta = { title: string; periodLabel: string; scopeLabel: string; metric: Metric; generatedAt: Date; fees?: FeeStats };

const metricName = (m: Metric) => statsI18n.t(`csv.metric.${m}`);

function kpiRows(k: Kpis, prev: Kpis | null, metric: Metric): [string, string, string][] {
  const t = statsI18n.t;
  const p = prev && prev.total > 0 ? prev : null;
  const v = (x: number | null | undefined) => fmtValue(x ?? null, metric);
  return [
    [t("csv.trades"), String(k.total), p ? String(p.total) : ""],
    [t("csv.closedOpen"), `${k.closed} / ${k.open}`, p ? `${p.closed} / ${p.open}` : ""],
    ["Win / Loss / BE", `${k.wins} / ${k.losses} / ${k.breakeven}`, p ? `${p.wins} / ${p.losses} / ${p.breakeven}` : ""],
    ["Win rate", fmtRate(k.winRate), p ? fmtRate(p.winRate) : ""],
    [t("csv.result"), v(k.net), p ? v(p.net) : ""],
    [t("csv.expectancy"), v(k.expectancy), p ? v(p.expectancy) : ""],
    ["Profit factor", fmtRatio(k.profitFactor), p ? fmtRatio(p.profitFactor) : ""],
    ["Payoff", fmtRatio(k.payoff), p ? fmtRatio(p.payoff) : ""],
    [t("csv.avgWin"), v(k.avgWin), p ? v(p.avgWin) : ""],
    [t("csv.avgLoss"), v(k.avgLoss), p ? v(p.avgLoss) : ""],
    [t("csv.best"), v(k.bestTrade), p ? v(p.bestTrade) : ""],
    [t("csv.worst"), v(k.worstTrade), p ? v(p.worstTrade) : ""],
    [t("csv.maxDd"), v(k.maxDrawdown), p ? v(p.maxDrawdown) : ""],
    [t("csv.bestStreak"), String(k.longestWin), p ? String(p.longestWin) : ""],
    [t("csv.worstStreak"), String(k.longestLoss), p ? String(p.longestLoss) : ""],
    [t("csv.tradingDays"), `${k.tradingDays} (${k.greenDays}/${k.redDays})`, p ? `${p.tradingDays} (${p.greenDays}/${p.redDays})` : ""],
  ];
}

const csvCell = (x: unknown) => {
  const s = x == null ? "" : String(x);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV (semicolon-separated, UTF-8 BOM — opens correctly in Russian Excel). */
export function downloadReportCsv(trades: Trade[], k: Kpis, prev: Kpis | null, meta: ReportMeta) {
  const tr = statsI18n.t;
  const lines: string[] = [];
  const row = (...cells: unknown[]) => lines.push(cells.map(csvCell).join(";"));
  row(meta.title);
  row(tr("csv.period"), meta.periodLabel);
  row(tr("csv.trader"), meta.scopeLabel);
  row(tr("csv.metricLabel"), metricName(meta.metric));
  if (meta.fees) row(tr("csv.grossFeesNet"), meta.fees.gross?.toFixed(2) ?? "", meta.fees.fees.toFixed(2), meta.fees.net?.toFixed(2) ?? "");
  row(tr("csv.generated"), fmtDate(meta.generatedAt, "shortDateTime"));
  row();
  row(tr("csv.indicator"), tr("csv.current"), tr("csv.previous"));
  kpiRows(k, prev, meta.metric).forEach((r) => row(...r));
  row();
  row(tr("csv.date"), tr("csv.trades"), "Win", "Loss", meta.metric === "r" ? tr("csv.totalR") : meta.metric === "net" ? tr("csv.totalNet") : tr("csv.totalGross"));
  dailySeries(trades, meta.metric).forEach((d) => row(d.key, d.count, d.wins, d.losses, d.value == null ? "" : d.value.toFixed(2)));
  row();
  row("ID", tr("csv.date"), tr("csv.exitDate"), tr("csv.ticker"), tr("csv.trader"), tr("csv.horizon"), tr("csv.side"), tr("csv.setup"), tr("csv.session"), tr("csv.result"), "R", "P&L gross", tr("csv.fees"), "P&L net");
  chrono(trades).forEach((t) =>
    row(t.id, dayKey(t), tx(t).exitDate ? String(tx(t).exitDate).substring(0, 10) : "", t.ticker, personName(t.trader), horizonLabel(horizonOf(t)),
      t.side ?? "", t.setup || t.eventType || "", sessionLabel(sessionKey(t)), t.result,
      t.rMultiple ?? "", t.pnl ?? "", feesOf(t) || "", valueOf(t, "net") ?? ""),
  );
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ws-lexx-report-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Opens a clean, print-ready report in a new window (independent of the app shell/sidebar) and triggers print.
 * Returns false if the popup was blocked.
 */
export function openPrintReport(trades: Trade[], k: Kpis, prev: Kpis | null, meta: ReportMeta): boolean {
  const w = window.open("", "_blank", "width=900,height=1100");
  if (!w) return false;
  const kpis = kpiRows(k, prev, meta.metric)
    .map(([a, b, c]) => `<tr><td>${esc(a)}</td><td class="n">${esc(b)}</td><td class="n muted">${esc(c)}</td></tr>`)
    .join("");
  const list = chrono(trades)
    .map((t) => {
      const val = valueOf(t, meta.metric);
      return `<tr><td>${esc(dayKey(t))}</td><td><b>${esc(t.ticker)}</b></td><td>${esc(personName(t.trader))}</td><td>${esc(horizonLabel(horizonOf(t)))}</td>
<td>${esc(t.setup || t.eventType || "")}</td><td>${esc(t.result)}</td><td class="n">${esc(val == null ? "—" : fmtValue(val, meta.metric))}</td></tr>`;
    })
    .join("");
  const tr = statsI18n.t;
  w.document.write(`<!doctype html><html lang="${esc(localeTag())}"><head><meta charset="utf-8"><title>${esc(meta.title)}</title>
<style>
  body{font:13px/1.45 Inter,system-ui,-apple-system,Segoe UI,sans-serif;color:#111;margin:32px;}
  h1{font-size:20px;margin:0 0 4px} .sub{color:#555;margin:0 0 20px}
  h2{font-size:14px;margin:24px 0 8px}
  table{border-collapse:collapse;width:100%} td,th{padding:5px 8px;border-bottom:1px solid #ddd;text-align:left}
  th{font-weight:600;color:#555;font-size:12px} .n{text-align:right;font-variant-numeric:tabular-nums} .muted{color:#777}
  @media print{body{margin:12mm} tr{break-inside:avoid}}
</style></head><body>
<h1>${esc(meta.title)}</h1>
<p class="sub">${esc(meta.periodLabel)} · ${esc(meta.scopeLabel)} · ${esc(tr("printDoc.metric", { name: metricName(meta.metric) }))} · ${esc(fmtDate(meta.generatedAt, "shortDateTime"))}</p>
<h2>${esc(tr("printDoc.indicators"))}</h2>
<table><thead><tr><th>${esc(tr("csv.indicator"))}</th><th class="n">${esc(tr("printDoc.period"))}</th><th class="n">${esc(tr("printDoc.prevPeriod"))}</th></tr></thead><tbody>${kpis}</tbody></table>
${meta.fees && meta.fees.gross != null ? `<h2>${esc(tr("printDoc.grossFeesNet"))}</h2><table><tbody><tr><td>P&amp;L gross</td><td class="n">${esc(fmtValue(meta.fees.gross, "usd"))}</td></tr><tr><td>${esc(tr("printDoc.fees"))}</td><td class="n">${esc(fmtValue(-meta.fees.fees, "usd"))}</td></tr><tr><td><b>P&amp;L net</b></td><td class="n"><b>${esc(fmtValue(meta.fees.net, "usd"))}</b></td></tr></tbody></table>` : ""}
<h2>${esc(tr("printDoc.trades", { count: trades.length }))}</h2>
<table><thead><tr><th>${esc(tr("csv.date"))}</th><th>${esc(tr("csv.ticker"))}</th><th>${esc(tr("csv.trader"))}</th><th>${esc(tr("csv.horizon"))}</th><th>${esc(tr("csv.setup"))}</th><th>${esc(tr("printDoc.outcome"))}</th><th class="n">${meta.metric === "r" ? "R" : meta.metric === "net" ? "Net $" : "Gross $"}</th></tr></thead><tbody>${list}</tbody></table>
</body></html>`);
  w.document.close();
  // Printed from here, not by an inline <script> in the popup: the about:blank popup inherits the app's CSP,
  // which blocks inline scripts (scripts/csp-meta.mjs).
  const go = () => setTimeout(() => { w.focus(); w.print(); }, 200);
  if (w.document.readyState === "complete") go();
  else w.addEventListener("load", go, { once: true });
  return true;
}
