/**
 * Client for /api/propreports/* (types mirror artifacts/api-server/src/routes/propreports.ts).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { fmtDate, fmtPrice as fmtPriceBase, fmtRelative } from "@/lib/format";
import { propreportsI18n } from "@/i18n/ns/propreports";

export type Horizon = "intraday" | "overnight" | "swing";
export type Session = "premarket" | "regular" | "postmarket";
export type TripResult = "win" | "loss" | "breakeven" | "open";
export type PlanAction = "insert" | "update" | "unchanged" | "adopt" | "conflict" | "skip";

export const FEE_KEYS = ["comm", "ecn", "sec", "orf", "taf", "nfa", "cat", "nscc", "acc", "clr", "misc"] as const;
export type FeeKey = (typeof FEE_KEYS)[number];
/** Broker fee codes shown as is in every language; word labels (comm, clr, misc) come from propreportsI18n `fee.*`. */
const FEE_CODE_LABEL: Record<string, string> = {
  ecn: "ECN", sec: "SEC", orf: "ORF", taf: "TAF", nfa: "NFA", cat: "CAT", nscc: "NSCC", acc: "Access",
  exfee: "ExFee", finra: "FINRA", route: "Route", locate: "Locate", borrow: "Borrow", nasdaq: "Nasdaq", pass: "Pass-thru",
};
/** Label for any fee key (unknown columns keep their broker name). */
export function feeLabel(key: string): string {
  return propreportsI18n.tryT(`fee.${key}`) ?? FEE_CODE_LABEL[key] ?? key.replace(/_/g, " ").replace(/^w/, (c) => c.toUpperCase());
}
/** Known keys first (in FEE_KEYS order), then the rest alphabetically. */
export function orderedFeeKeys(fees: Record<string, number>): string[] {
  const known = FEE_KEYS.filter((k) => k in fees) as string[];
  const rest = Object.keys(fees).filter((k) => !(FEE_KEYS as readonly string[]).includes(k)).sort();
  return [...known, ...rest];
}

export type Execution = { kind: "entry" | "add" | "trim" | "exit"; side: "B" | "S" | "T" | "C"; qty: number; price: number; at: string; fees: number; fillId: string | null };

export type TripView = {
  symbol: string; side: "Long" | "Short"; date: string; exitDate: string | null; openedAt: string; closedAt: string | null;
  horizon: Horizon; session: Session; qty: number; openQty: number; avgEntry: number; avgExit: number | null;
  grossPnl: number; fees: Record<string, number>; totalFees: number; netPnl: number; result: TripResult; holdTime: string | null;
  fillCount: number; open: boolean; fromReport: boolean; executions: Execution[];
};

export type ManualCandidate = {
  id: number; trader: string; ticker: string; date: string; side: string | null; setup: string | null;
  entry: number | null; exit: number | null; qty: number | null; pnl: number | null; fees: number | null;
  result: string; notes: string | null; tags: string | null; playbookId: number | null; createdAt: string;
};

export type FieldChange = { field: string; from: unknown; to: unknown };

export type PlanItemView = {
  externalId: string; action: PlanAction; reason: string | null; trader: string | null; account: string;
  tradeId: number | null; pendingId: number | null; changes: FieldChange[]; candidates: ManualCandidate[]; trip: TripView;
};

export type Summary = {
  trips: number; closed: number; open: number; wins: number; losses: number; breakeven: number;
  gross: number; fees: number; net: number; byHorizon: Record<Horizon, number>; accounts: string[]; symbols: number;
  minDate: string | null; maxDate: string | null; tradingDays: number;
};

export type Preview = {
  dryRun: true; kind: "fills" | "trades"; fileName?: string; source?: "api"; from?: string; to?: string;
  counts: Record<PlanAction, number>; unmappedAccounts: string[]; inactiveAccounts: string[];
  dateFrom: string | null; dateTo: string | null; summary: Summary; items: PlanItemView[]; truncated: boolean;
  feeColumns?: string[]; resolvedAccounts?: Record<string, { account: string; how: "alias" | "ci" | "fuzzy" }>;
  fills?: number; skippedRows?: number; issues?: Array<{ line: number; message: string }>; issueCount?: number; columns?: string[];
  orphanFills?: Array<{ account: string; symbol: string; side: string; qty: number; price: number; dateTime: string; line: number }>; orphanCount?: number;
  reportRows?: number;
};

export type ApplyResult = {
  runId: number; inserted: number; updated: number; unchanged: number; skipped: number; conflicts: number; errors: number; errorText: string | null;
  counts: Record<PlanAction, number>; unmappedAccounts: string[];
};

export type AccountMapping = {
  id: number; account: string; accountId: string | null; accountName: string | null; trader: string | null;
  active: boolean; notes: string | null; aliases: string[]; lastSyncedAt: string | null; lastFillAt: string | null;
};

export type SyncRun = {
  id: number; startedAt: string; finishedAt: string | null; source: "api" | "file"; status: "running" | "ok" | "partial" | "error";
  fileName: string | null; dateFrom: string | null; dateTo: string | null; inserted: number; updated: number; unchanged: number;
  skipped: number; conflicts: number; errors: number; errorText: string | null; actor: string | null; details: Record<string, unknown> | null;
};

export type PendingTrade = {
  id: number; externalId: string; account: string | null; trader: string; ticker: string; date: string; side: string | null;
  trip: TripView; candidates: ManualCandidate[]; createdAt: string; updatedAt: string;
};

export type ConnectionState = { checkedAt: string | null; ok: boolean | null; mode: "v2" | "v1" | null; version: string | null; error: string | null };
export type CheckResult = ConnectionState & { apiVersionHeader: string | null; host: string };
export type FeeColumnView = { key: string; header: string | null; label: string; known: boolean; heuristic: boolean; include: boolean; lastSeenAt: string | null; customLabel: string | null };
export type GroupEffective = { groupId: string; source: "env" | "settings" | "default" };
export type SettingsView = { groupId: string | null; effective: GroupEffective; feeColumns: FeeColumnView[]; feesConfirmedAt: string | null; unmatched: string[]; connection: ConnectionState };
export type GroupsResponse = { groups: Array<{ groupId: string | null; name: string }>; source: "api" | "accounts"; effective: GroupEffective; warning?: string };
export type WizardStep = { ok: boolean; detail: string };
export type Wizard = { env: WizardStep; connection: WizardStep; accounts: WizardStep; fees: WizardStep; firstSync: WizardStep };

export type Status = {
  viewer: { name: string; staff: boolean };
  connection: ConnectionState;
  settings: { groupId: string | null; effectiveGroupId: string; groupSource: "env" | "settings" | "default"; feesConfirmedAt: string | null; feeColumns: FeeColumnView[]; unmatched: string[] };
  wizard: Wizard;
  config: { configured: boolean; domain: string | null; authMode: "token" | "login" | null; groupId: string | null; accountIds: string[]; syncMinutes: number | null; envVars: string[]; missing: string[] };
  scheduler: { enabled: boolean; minutes: number | null; nextRunAt: string | null; running: boolean; lastError: string | null };
  accounts: { total: number; mapped: number; unmapped: string[]; lastSyncedAt: string | null };
  trades: { imported: number; lastSyncedAt: string | null; legacyWithoutId: number };
  pendingCount: number;
  lastRun: SyncRun | null;
};

export type UserRow = { id: number; name: string; role: string; active: boolean };

// ─── Trade Performance (aggregate broker statistics) ───
export type PerfSideStats = { count: number; gross: number; avgGross: number; fees: number; net: number; avgNet: number; avgHoldSeconds: number | null; avgHold: string | null };
export type PerfTotals = { gross: number; fees: number; net: number; winRate: number | null; wlRatio: number | null; avgHoldSeconds: number | null; avgHold: string | null };
export type PerfRow = { label: string; wins: PerfSideStats; losses: PerfSideStats; totals: PerfTotals; trades: number };
export type PerfSummary = {
  trades: number; wins: number; losses: number; winRate: number | null; gross: number; fees: number; net: number; feesPctOfGross: number | null;
  wlRatio: number | null; avgHoldSeconds: number | null; avgHold: string | null; symbols: number; avgWin: number; avgLoss: number;
};
export type PerTradeAverage = { group: string; qty: number | null; fees: Record<string, number>; feeHeaders: Record<string, string>; heldSeconds: number | null; held: string | null };
export type PerformanceReport = {
  format: "trade-performance"; perTradeAverages: PerTradeAverage[]; totals: PerfRow | null; bySide: { long: PerfRow | null; short: PerfRow | null };
  byTime: PerfRow[]; byWeekday: PerfRow[]; bySymbol: PerfRow[]; other: PerfRow[]; summary: PerfSummary; issues: string[];
};
export type PerformanceReportRow = {
  id: number; account: string; traderName: string | null; periodFrom: string; periodTo: string; fileName: string | null;
  uploadedBy: string | null; uploadedAt: string; summary: PerfSummary; data?: PerformanceReport;
};
export type PerformanceResponse = { trader: string | null; reports: PerformanceReportRow[]; latest: (PerformanceReportRow & { data: PerformanceReport }) | null };
/** POST /import response for a Trade Performance file (dry run and apply share the shape). */
export type PerformancePreview = {
  dryRun: boolean; kind: "performance"; fileName: string; account: string; trader: string | null; traderSource: string | null;
  periodFrom: string; periodTo: string; summary: PerfSummary; issues: string[]; bySide: PerformanceReport["bySide"]; byTime: PerfRow[]; byWeekday: PerfRow[];
  perTradeAverages: PerTradeAverage[]; symbols: number; note: string; reportId?: number; replaced?: boolean; uploadedAt?: string;
};
/** /integrations sections (`?tab=`). */
export type IntegrationsTab = "setup" | "import" | "performance" | "accounts" | "reconcile" | "history";
export type ImportKind = "auto" | "fills" | "trades" | "performance";
export type ImportResponse = Preview | ApplyResult | PerformancePreview;
export function isPerformanceResponse(r: ImportResponse): r is PerformancePreview {
  return (r as PerformancePreview).kind === "performance";
}

function sendFile<T>(path: string, file: File, fields: Record<string, string>): Promise<T> {
  const fd = new FormData();
  fd.append("file", file);
  for (const [k, v] of Object.entries(fields)) if (v) fd.append(k, v);
  return http.post<T>(path, fd);
}

export const prKeys = {
  all: ["propreports"] as const,
  status: ["propreports", "status"] as const,
  accounts: ["propreports", "accounts"] as const,
  runs: ["propreports", "runs"] as const,
  reconcile: ["propreports", "reconcile"] as const,
  users: ["propreports", "users"] as const,
  performance: ["propreports", "performance"] as const,
  settings: ["propreports", "settings"] as const,
  groups: ["propreports", "groups"] as const,
};

const retry = (count: number, err: unknown) => !(err instanceof ApiError && [401, 403, 404, 503].includes(err.status)) && count < 2;

export function useStatus() {
  return useQuery({ queryKey: prKeys.status, queryFn: () => http.get<Status>("/api/propreports/status"), refetchInterval: 60_000, retry });
}
export function useAccounts() {
  return useQuery({ queryKey: prKeys.accounts, queryFn: () => http.get<AccountMapping[]>("/api/propreports/accounts"), retry });
}
export function useRuns(limit = 50) {
  return useQuery({ queryKey: [...prKeys.runs, limit], queryFn: () => http.get<SyncRun[]>(`/api/propreports/runs?limit=${limit}`), retry });
}
export function usePending() {
  return useQuery({ queryKey: prKeys.reconcile, queryFn: () => http.get<PendingTrade[]>("/api/propreports/reconcile"), retry });
}
export function useSettings(enabled = true) {
  return useQuery({ queryKey: prKeys.settings, queryFn: () => http.get<SettingsView>("/api/propreports/settings"), enabled, retry });
}
export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { groupId?: string | null; fees?: { columns?: Record<string, { include: boolean; label?: string | null }>; confirm?: boolean }; unmatched?: string[] }) =>
      http.put<SettingsView>("/api/propreports/settings", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: prKeys.settings }); qc.invalidateQueries({ queryKey: prKeys.status }); },
  });
}
/** Read-only probe (action=version) — never writes to the broker; records the detected auth mode. */
export function useCheckConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => http.get<CheckResult>("/api/propreports/check"),
    onSettled: () => { qc.invalidateQueries({ queryKey: prKeys.status }); qc.invalidateQueries({ queryKey: prKeys.settings }); },
  });
}
export function useGroups(enabled: boolean) {
  return useQuery({ queryKey: prKeys.groups, queryFn: () => http.get<GroupsResponse>("/api/propreports/groups"), enabled, staleTime: STALE.long, retry });
}
export function usePerformance(trader?: string | null, id?: number | null) {
  const qs = new URLSearchParams();
  if (trader) qs.set("trader", trader);
  if (id) qs.set("id", String(id));
  const q = qs.toString();
  return useQuery({ queryKey: [...prKeys.performance, trader ?? "", id ?? 0], queryFn: () => http.get<PerformanceResponse>(`/api/propreports/performance${q ? `?${q}` : ""}`), retry });
}
export function useDeletePerformance() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => http.del<{ ok: true }>(`/api/propreports/performance/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: prKeys.performance }) });
}
export function useUsers(enabled: boolean) {
  return useQuery({ queryKey: prKeys.users, queryFn: () => http.get<UserRow[]>("/api/users"), enabled, staleTime: STALE.long, retry });
}

/** Invalidate everything that a write to the journal can change. */
export function useInvalidateAll() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: prKeys.all });
    qc.invalidateQueries({ queryKey: ["/api/trades"] });
    qc.invalidateQueries({ queryKey: ["risk"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };
}

export function useSaveAccounts() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (accounts: Array<Partial<AccountMapping> & { account: string }>) =>
      http.put<AccountMapping[]>("/api/propreports/accounts", { accounts: accounts.map((a) => ({ account: a.account, trader: a.trader ?? null, active: a.active, notes: a.notes ?? null, aliases: a.aliases })) }),
    onSuccess: invalidate,
  });
}

export function useRefreshAccounts() {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: () => http.post<{ fetched: number; accounts: AccountMapping[] }>("/api/propreports/accounts/refresh", {}), onSuccess: invalidate });
}

export function useDeleteAccount() {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: (id: number) => http.del<{ ok: true }>(`/api/propreports/accounts/${id}`), onSuccess: invalidate });
}

export function useImportFile() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: ({ file, dryRun, kind, account, trader }: { file: File; dryRun: boolean; kind: ImportKind; account?: string; trader?: string }) =>
      sendFile<ImportResponse>(`/api/propreports/import${dryRun ? "?dryRun=1" : ""}`, file, { kind, account: account ?? "", trader: trader ?? "" }),
    onSuccess: (_d, v) => { if (!v.dryRun) invalidate(); },
  });
}

export function useApiSync() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (body: { from: string; to: string; dryRun: boolean }) => http.post<Preview | ApplyResult>("/api/propreports/sync", body),
    onSuccess: (_d, v) => { if (!v.dryRun) invalidate(); },
  });
}

export function useMerge() {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: ({ pendingId, tradeId }: { pendingId: number; tradeId: number }) => http.post<{ ok: true; tradeId: number }>(`/api/propreports/reconcile/${tradeId}/merge`, { pendingId }), onSuccess: invalidate });
}
export function useKeepSeparate() {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: (pendingId: number) => http.post<{ ok: true; tradeId: number }>(`/api/propreports/reconcile/pending/${pendingId}/keep`, {}), onSuccess: invalidate });
}
export function useDismissPending() {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: (pendingId: number) => http.del<{ ok: true }>(`/api/propreports/reconcile/pending/${pendingId}`), onSuccess: invalidate });
}

// ─── formatting helpers ───
// Money and dates: @/lib/format (fmtUsd, fmtUsd(v, { signed: true }), fmtDate(iso, "numericDateTime")).
/** Broker precision with trailing zeros trimmed: 2 decimals from $100, else 4 ("12.3456", "12.5"). */
/** Broker precision: 4 decimals under $100, 2 from $100, trailing zeros dropped ("12.5", "12.3456", "150"). */
export function fmtPrice(v: number | null | undefined): string {
  return fmtPriceBase(v, { decimals: v != null && Math.abs(v) >= 100 ? 2 : 4, trim: true });
}
/** «5 min ago» in the UI language; «ещё не было» when there is no date. Call at render time. */
export function agoText(iso: string | null | undefined): string {
  if (!iso) return propreportsI18n.t("never");
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  // Older than a month: the date reads better than «2 months ago».
  if (Date.now() - t >= 30 * 86_400_000) return fmtDate(t, "dayMonth");
  return fmtRelative(Math.min(t, Date.now()), { style: "short" });
}
/** «in 15 min» in the UI language («now» once the moment has passed). */
export function untilText(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return fmtRelative(Math.max(t, Date.now()), { style: "short" });
}

// Display labels for codes (call at render time; unknown codes show as is).
export const horizonLabel = (h: string) => propreportsI18n.tryT(`horizon.${h}`) ?? h;
export const sessionLabel = (s: string) => propreportsI18n.tryT(`session.${s}`) ?? s;
export const actionLabel = (a: string) => propreportsI18n.tryT(`action.${a}`) ?? a;
export const reasonLabel = (r: string) => propreportsI18n.tryT(`reason.${r}`) ?? r;
export const fieldLabel = (f: string) => propreportsI18n.tryT(`field.${f}`) ?? f;
export const resultLabel = (r: string) => propreportsI18n.tryT(`result.${r}`) ?? r;
export const runStatusLabel = (s: string) => propreportsI18n.tryT(`runStatus.${s}`) ?? s;
