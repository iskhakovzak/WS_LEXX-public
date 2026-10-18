/**
 * Client for GET /api/reconcile («Сверка с брокером»). Types mirror artifacts/api-server/src/lib/reconcile.ts.
 * Raw fetch (no codegen); auth header is added by the global fetch hook (lib/install-fetch-auth).
 */
import { useQuery } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { propreportsI18n } from "@/i18n/ns/propreports";

export type Severity = "ok" | "warn" | "error";
export type CompareStatus = Severity | "na";
export type DiscrepancyCause = "fee_rounding";

/** «расхождение из-за округления комиссий» in the UI language. */
export const feeRoundingLabel = () => propreportsI18n.t("reconcile.feeRounding");

export type Money = { trades: number; gross: number; fees: number; net: number };
export type MoneyWL = Money & { wins: number; losses: number };

export type Compare = {
  key: string; label: string; journal: number | null; broker: number | null; diff: number | null;
  tolerance: number; status: CompareStatus; note?: string; cause?: DiscrepancyCause;
};

export type Issue = {
  id: string; severity: Severity; kind: string; date: string | null; ticker: string | null; trader: string | null;
  tradeIds: number[]; message: string; expected?: number | null; actual?: number | null; diff?: number | null;
  hint?: string; cause?: DiscrepancyCause;
};

export type DayRow = {
  date: string; status: Severity; journal: MoneyWL; manual: Money; broker: Money | null;
  brokerSource: "snapshot" | "report-days" | null; compares: Compare[]; issueIds: string[]; tradeIds: number[];
  fills: { withFills: number; withoutFills: number };
};

export type GroupCheck = {
  scope: "side" | "weekday" | "symbol"; key: string; label: string; status: Severity;
  journal: MoneyWL; broker: MoneyWL; diffNet: number; cause?: DiscrepancyCause;
};

export type ReportCheck = {
  reportId: number; account: string | null; trader: string | null; periodFrom: string; periodTo: string; status: Severity;
  compares: Compare[]; feeTypes: Compare[]; groups: GroupCheck[];
  symbolsMissingInJournal: string[]; symbolsMissingInReport: string[]; manualInPeriod: Money;
};

export type ReconcileResponse = {
  scope: string | null;
  generatedAt: string;
  summary: {
    status: Severity; label: string; discrepancies: number; counts: Record<Severity, number>;
    period: { from: string | null; to: string | null }; tolerance: number; warnBelow: number;
    journal: MoneyWL & { feesByType: Record<string, number> }; manual: Money;
    days: number; daysWithIssues: number; tradesChecked: number;
    fills: { withFills: number; withoutFills: number; brokerWithoutFills: number };
    hasReport: boolean; hasBrokerDays: boolean; roundingIssues: number;
  };
  days: DayRow[];
  reports: ReportCheck[];
  issues: Issue[];
  issuesTruncated: boolean;
};

export type ReconcileParams = { trader?: string | null; from?: string | null; to?: string | null };

export function reconcilePath(p: ReconcileParams, format?: "csv"): string {
  const q = new URLSearchParams();
  if (p.trader) q.set("trader", p.trader);
  if (p.from) q.set("from", p.from);
  if (p.to) q.set("to", p.to);
  if (format) q.set("format", format);
  const s = q.toString();
  return `/api/reconcile${s ? `?${s}` : ""}`;
}

export function fetchReconcile(p: ReconcileParams, signal?: AbortSignal): Promise<ReconcileResponse> {
  return http.get<ReconcileResponse>(reconcilePath(p), { signal });
}

export const reconcileKeys = {
  all: ["reconcile"] as const,
  run: (p: ReconcileParams) => ["reconcile", p.trader ?? "*", p.from ?? "", p.to ?? ""] as const,
};

export function useReconcile(p: ReconcileParams, enabled = true) {
  return useQuery({
    queryKey: reconcileKeys.run(p),
    queryFn: ({ signal }) => fetchReconcile(p, signal),
    enabled,
    staleTime: STALE.short,
  });
}

/** CSV of the discrepancies (warn/error), built client-side from the loaded result. */
export function discrepanciesCsv(issues: Issue[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const t = propreportsI18n.t;
  const head = (["status", "kind", "cause", "date", "trader", "ticker", "ids", "broker", "journal", "diff", "message", "hint"] as const).map((k) => t(`reconcile.csv.${k}`));
  const rows = issues
    .filter((i) => i.severity !== "ok")
    .map((i) => [
      i.severity === "error" ? t("reconcile.csv.serious") : t("reconcile.csv.discrepancy"), i.kind, i.cause === "fee_rounding" ? feeRoundingLabel() : "",
      i.date, i.trader, i.ticker, i.tradeIds.join(" "), i.expected, i.actual, i.diff, i.message, i.hint,
    ].map(esc).join(","));
  return "﻿" + [head.join(","), ...rows].join("\n");
}

export function downloadText(name: string, text: string, type = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
