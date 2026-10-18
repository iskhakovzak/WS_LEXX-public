import { useQuery } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { POLL } from "@/lib/api/keys";
import { nyDate } from "@/lib/trading-date";
import { fmtDate, fmtRelative } from "@/lib/format";
import { adminI18n } from "@/i18n/ns/admin";
import RU_ADMIN from "@/i18n/locales/ru/admin";

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: string | null;
  createdAt: string;
}

export interface ReportTarget {
  author: string | null;
  authorId: number | null;
  authorRole: string | null;
  authorBanned: boolean;
  preview: string | null;
  title: string | null;
  discussionId: number | null;
  deleted: boolean;
  createdAt: string | null;
}

export interface ContentReport {
  id: number;
  reporter: string;
  targetType: string;
  targetId: string;
  reason: string;
  status: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  createdAt: string;
  /** Added by the API (may be absent on an older server). */
  target?: ReportTarget | null;
  openReportsOnTarget?: number;
}

export interface Overview {
  openReports: number;
  bannedUsers: number;
  auditLast7d: number;
  roleCounts: Record<string, number>;
  recent: AuditEntry[];
}

export interface PulseUser {
  id: number;
  name: string;
  role: string;
  active: boolean;
  banned: boolean;
  bannedReason: string | null;
  createdAt: string | null;
  lastSeen: string | null;
  activeToday: boolean;
  tradesToday: number;
  tradesWeek: number;
  lastTradeDate: string | null;
  journalToday: boolean;
  notesStreak: number;
  journal30: number;
  violationsToday: number;
  violationsWeek: number;
  violationsHighWeek: number;
  violationsTotal: number;
  tradeStrip: number[];
  journalStrip: boolean[];
}

export interface DeskPulse {
  date: string;
  tz: string;
  days: string[];
  journalAvailable: boolean;
  violationsAvailable: boolean;
  summary: {
    deskTraders: number;
    activeToday: number;
    activeNames: string[];
    tradesToday: number;
    tradesWeek: number;
    noJournalToday: string[];
    violationsToday: number;
    violationsWeek: number;
    openReports: number;
    stale: string[];
    banned: number;
    deskTradeStrip: number[];
  };
  users: PulseUser[];
}

/** Subset of GET /api/risk/desk (owned by the Risk desk section) that the admin console reads. */
export interface RiskDeskLite {
  date: string;
  summary: { traders: number; breach: number; warn: number; noLimits: number; openPositions: number; carriedPositions: number };
  traders: { trader: string; status: "breach" | "warn" | "ok" | "no_limits" }[];
}

/* ── Fetch helpers ───────────────────────────────────────────────────────── */

export function adminUrl(path: string, actor: string, params?: Record<string, string | number | undefined | null>) {
  const qs = new URLSearchParams({ actor });
  for (const [k, v] of Object.entries(params ?? {})) if (v != null && v !== "") qs.set(k, String(v));
  return `/api${path}?${qs.toString()}`;
}

/** Desk "today" = the America/New_York trading date, whatever the curator's browser timezone is. */
export function localYmd(d = new Date()): string {
  return nyDate(d);
}

/** The desk trades US equities: day boundaries for desk-pulse are New York, not the browser's zone. */
const DESK_TZ = "America/New_York";

/* ── Queries ─────────────────────────────────────────────────────────────── */

export function useDeskPulse(actor: string) {
  return useQuery<DeskPulse>({
    queryKey: ["admin-desk-pulse", actor],
    queryFn: ({ signal }) => http.get<DeskPulse>(adminUrl("/admin/desk-pulse", actor, { date: nyDate(), tz: DESK_TZ }), { signal }),
    refetchInterval: POLL.minute,
    staleTime: 20_000,
  });
}

export function useAdminOverview(actor: string) {
  return useQuery<Overview>({
    queryKey: ["admin-overview", actor],
    queryFn: ({ signal }) => http.get<Overview>(adminUrl("/admin/overview", actor), { signal }),
    refetchInterval: POLL.minute,
  });
}

/**
 * Risk desk summary. Resolves to null when the endpoint doesn't exist yet (404) or isn't
 * reachable, so the KPI can simply hide instead of showing an error.
 */
export function useRiskDesk() {
  return useQuery<RiskDeskLite | null>({
    queryKey: ["admin-risk-desk-lite"],
    queryFn: async ({ signal }) => {
      const j = await http.get<RiskDeskLite | null>("/api/risk/desk", { query: { date: nyDate() }, signal }).catch(() => null);
      return j && typeof j === "object" && j.summary ? j : null;
    },
    retry: false,
    refetchInterval: POLL.minute,
  });
}

export function useReports(actor: string, status: string) {
  return useQuery<ContentReport[]>({
    queryKey: ["admin-reports", actor, status],
    queryFn: ({ signal }) => http.get<ContentReport[]>(adminUrl("/admin/reports", actor, { status }), { signal }),
    refetchInterval: POLL.minute,
  });
}

/* ── Formatting ──────────────────────────────────────────────────────────── */

/** Role name in the UI language («Админ» / «Admin»); unknown codes show as is. Call at render time. */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return "";
  return adminI18n.tryT(`role.${role}`) ?? role;
}

/** Built-in tier name for a key («trainee» → «Стажёр»); a tier renamed in «Масштабирование» comes from /tiers. */
export function tierFallbackLabel(key: string): string {
  return adminI18n.tryT(`tier.${key}`) ?? key;
}

/**
 * Name of a configured tier for display: a tier still carrying its seeded Russian default name («Стажёр» for
 * `trainee`) shows the built-in translation; a name a curator changed is shown as written (user content).
 */
export function tierDisplayName(key: string, name: string | null | undefined): string {
  const seeded = (RU_ADMIN.tier as Record<string, string>)[key];
  if (!name || (seeded && name === seeded)) return tierFallbackLabel(key);
  return name;
}

export function parseDetails(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** «5 мин назад» / «5 min ago» (short relative time in the UI language); «никогда» when there is no date. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return adminI18n.t("never");
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  // Older than a month: a date reads better than «2 months ago».
  if (now - t >= 30 * 86_400_000) return fmtDate(t, "dayMonth");
  return fmtRelative(Math.min(t, now), { now, style: "short" });
}

/* ── CSV / download ──────────────────────────────────────────────────────── */

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

export function downloadBlob(content: BlobPart, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** CSV with a UTF-8 BOM so Excel opens Cyrillic correctly. */
export function downloadCsv(header: string[], rows: unknown[][], filename: string) {
  downloadBlob("﻿" + toCsv(header, rows), filename, "text/csv;charset=utf-8");
}

/** True when the keyboard event comes from a text field / editable element. */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
