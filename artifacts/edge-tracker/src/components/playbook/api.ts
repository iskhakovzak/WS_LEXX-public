/** Data hooks for the playbook page (requests: lib/api/http). Query keys are shared with other pages — keep them stable. */
import { useMemo } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { http, ApiError } from "@/lib/api/http";
import { isNotFound, nullIfMissing } from "@/lib/api/errors";
import { STALE } from "@/lib/api/keys";
import { useAuth } from "@/contexts/auth-context";
import { playbookI18n } from "@/i18n/ns/playbook";
import type {
  ActivityItem, FolderSetting, PickerTrade, PlaybookEntry, SetupExample, SetupStats, SetupSummary, ViewerLike,
} from "./model";

export function usePlaybookEntries() {
  return useQuery<PlaybookEntry[]>({
    queryKey: ["playbook"],
    queryFn: ({ signal }) => http.get<PlaybookEntry[]>("/api/playbook", { signal }),
    // ~300 KB: don't refetch on every visit; every write invalidates this key anyway.
    staleTime: STALE.default,
  });
}

/** Trader sees their own trades' edge; curators see the whole team. */
export function useUserKey(): string | null {
  const { user } = useAuth();
  return user?.role === "trader" && user.traderName ? user.traderName : null;
}

/**
 * Per-setup aggregates. Optional: an older API build without /summary just yields an empty map,
 * so the page keeps working (no edge badges) instead of failing.
 */
export function usePlaybookSummary() {
  const userKey = useUserKey();
  const qs = userKey ? `?userKey=${encodeURIComponent(userKey)}` : "";
  const q = useQuery<SetupSummary[]>({
    queryKey: ["playbook-summary", userKey],
    // An error keeps isSuccess=false so the UI shows "—" instead of fake zeros.
    queryFn: ({ signal }) =>
      http.get<SetupSummary[]>(`/api/playbook/summary${qs}`, { signal }).then((j) => (Array.isArray(j) ? j : [])),
    staleTime: STALE.default,
    retry: 1,
  });
  const map = useMemo(() => new Map((q.data ?? []).map((s) => [s.id, s])), [q.data]);
  return { ...q, map };
}

export function useFolderSettings() {
  return useQuery<FolderSetting[]>({
    queryKey: ["playbook-folder-settings"],
    queryFn: ({ signal }) =>
      http
        .get<FolderSetting[]>("/api/playbook/folder-settings", { signal })
        .then((j) => (Array.isArray(j) ? j : []))
        .catch(() => []),
    staleTime: STALE.default,
  });
}

export function usePlaybookActivity(enabled: boolean) {
  return useQuery<ActivityItem[]>({
    queryKey: ["playbook-activity"],
    queryFn: async () => {
      const all = await http.get<any[]>("/api/activity");
      return (Array.isArray(all) ? all : []).filter((a: any) => a.section === "playbook").slice(0, 40);
    },
    staleTime: STALE.default,
    enabled,
  });
}

/** Everything that depends on playbook rows / their trade links. */
export function invalidatePlaybook(qc: QueryClient, id?: number) {
  qc.invalidateQueries({ queryKey: ["playbook"] });
  qc.invalidateQueries({ queryKey: ["playbook-children"] });
  qc.invalidateQueries({ queryKey: ["playbook-summary"] });
  qc.invalidateQueries({ queryKey: ["playbook-activity"] });
  qc.invalidateQueries({ queryKey: ["playbook-health"] });
  qc.invalidateQueries({ queryKey: ["playbook-tags"] });
  qc.invalidateQueries({ queryKey: ["playbook-folder-settings"] });
  if (id != null) {
    qc.invalidateQueries({ queryKey: ["playbook-revisions", id] });
    qc.invalidateQueries({ queryKey: ["playbook-trades", id] });
  }
}

export function invalidateTradeLinks(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["all-trades-for-link"] });
  qc.invalidateQueries({ queryKey: ["playbook-trade-picker"] });
  qc.invalidateQueries({ queryKey: ["all-playbook-trades-stats"] });
  qc.invalidateQueries({ queryKey: ["playbook-edge"] });
  qc.invalidateQueries({ queryKey: ["playbook-health"] });
  qc.invalidateQueries({ queryKey: ["playbook-trades"] });
  qc.invalidateQueries({ queryKey: ["playbook-summary"] });
}

/* ───────────────────────── spaces · examples · stats (routes/playbook-spaces.ts) ───────────────────────── */

export type PlaybookMe = {
  name: string | null; guest: boolean; mayShare: boolean; editOwn: boolean; editAny: boolean; review: boolean;
  stage: string | null; cohorts: number[]; teamWide: boolean;
};

/** GET /api/playbook/me — null on an older API (404), so callers fall back to role-based rules. */
export function usePlaybookMe() {
  return useQuery<PlaybookMe | null>({
    queryKey: ["playbook-me"],
    queryFn: ({ signal }) => http.get<PlaybookMe>("/api/playbook/me", { signal }).catch(() => null),
    staleTime: STALE.long,
    retry: false,
  });
}

/** Viewer for accessOf(): session role + server capabilities when the new API answers. */
export function usePlaybookViewer(): ViewerLike & { mayShare: boolean; live: boolean } {
  const { user, canEdit, isCurator } = useAuth();
  const me = usePlaybookMe().data ?? null;
  return useMemo(
    () => ({
      name: me?.name ?? (user?.role !== "guest" ? user?.traderName ?? null : null),
      canEdit: me ? me.editOwn || me.editAny : canEdit,
      isCurator: me ? me.editAny || me.review : isCurator,
      isSenior: me?.stage === "senior",
      mayShare: me?.mayShare ?? isCurator,
      live: !!me,
    }),
    [me, user, canEdit, isCurator],
  );
}

/** 404 from a route that only exists after the API restart → a readable message. */
export function notLiveMessage(e: unknown): string | null {
  return e instanceof ApiError && e.status === 404 && !e.field("error") ? playbookI18n.t("notLive") : null;
}

export function useSetupExamples(id: number | null, enabled = true) {
  return useQuery<SetupExample[]>({
    queryKey: ["playbook-examples", id],
    queryFn: ({ signal }) => http.get<SetupExample[]>(`/api/playbook/${id}/examples`, { signal }),
    enabled: !!id && enabled,
    staleTime: 15_000,
    retry: (n, e) => !isNotFound(e) && n < 1,
  });
}

export type GalleryFilter = {
  tier?: number; setupId?: number | null; trader?: string | null; space?: string | null; limit?: number;
  /** Close date range, YYYY-MM-DD (inclusive). */
  from?: string | null; to?: string | null;
};
export function useGallery(f: GalleryFilter, enabled = true) {
  const qs = new URLSearchParams();
  if (f.tier) qs.set("tier", String(f.tier));
  if (f.setupId) qs.set("setupId", String(f.setupId));
  if (f.trader) qs.set("trader", f.trader);
  if (f.space) qs.set("space", f.space);
  if (f.from) qs.set("from", f.from);
  if (f.to) qs.set("to", f.to);
  qs.set("limit", String(f.limit ?? 120));
  const s = qs.toString();
  return useQuery<SetupExample[]>({
    queryKey: ["playbook-gallery", s],
    queryFn: ({ signal }) => http.get<SetupExample[]>(`/api/playbook-tools/gallery?${s}`, { signal }),
    enabled,
    staleTime: STALE.default,
    retry: (n, e) => !isNotFound(e) && n < 1,
  });
}

export type PickerFilter = { setupId: number; trader?: string | null; q?: string; from?: string; to?: string; result?: "" | "win" | "loss"; match?: boolean };
export type PickerResponse = { trader: string | null; setup: { id: number; name: string } | null; trades: PickerTrade[]; truncated: boolean };
export function useTradePicker(f: PickerFilter, enabled: boolean) {
  const qs = new URLSearchParams({ setupId: String(f.setupId), limit: "300" });
  if (f.trader) qs.set("trader", f.trader);
  if (f.q?.trim()) qs.set("q", f.q.trim());
  if (f.from) qs.set("from", f.from);
  if (f.to) qs.set("to", f.to);
  if (f.result) qs.set("result", f.result);
  if (f.match) qs.set("match", "1");
  const s = qs.toString();
  return useQuery<PickerResponse>({
    queryKey: ["playbook-trade-picker", s],
    queryFn: ({ signal }) => http.get<PickerResponse>(`/api/playbook-tools/trade-picker?${s}`, { signal }),
    enabled,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
    retry: (n, e) => !isNotFound(e) && n < 1,
  });
}

export function useSetupStats(id: number | null, enabled = true) {
  const userKey = useUserKey();
  return useQuery<SetupStats>({
    queryKey: ["playbook-stats", id, userKey],
    queryFn: ({ signal }) => http.get<SetupStats>(`/api/playbook/${id}/stats`, { query: { userKey }, signal }),
    enabled: !!id && enabled,
    staleTime: STALE.default,
    retry: (n, e) => !isNotFound(e) && n < 1,
  });
}

export type ShareTargets = { users: { name: string; role: string }[]; cohorts: { id: number; name: string; members: number }[] };
export function useShareTargets(enabled: boolean) {
  return useQuery<ShareTargets>({
    queryKey: ["playbook-share-targets"],
    queryFn: ({ signal }) => http.get<ShareTargets>("/api/playbook-tools/share-targets", { signal }),
    enabled,
    staleTime: STALE.long,
    retry: false,
  });
}

/** After any example change. */
export function invalidateExamples(qc: QueryClient, ...ids: (number | null | undefined)[]) {
  for (const id of ids) if (id != null) qc.invalidateQueries({ queryKey: ["playbook-examples", id] });
  if (!ids.length) qc.invalidateQueries({ queryKey: ["playbook-examples"] });
  qc.invalidateQueries({ queryKey: ["playbook-gallery"] });
  qc.invalidateQueries({ queryKey: ["playbook-trade-picker"] });
  qc.invalidateQueries({ queryKey: ["playbook-summary"] });
  qc.invalidateQueries({ queryKey: ["playbook-health"] });
  qc.invalidateQueries({ queryKey: ["playbook-for-trade"] });
  qc.invalidateQueries({ queryKey: ["playbook-stats"] });
  qc.invalidateQueries({ queryKey: ["playbook-inbox"] });
}

/* ───────────────────────── inbox: own recent trades without an example ───────────────────────── */

export type InboxTrade = {
  id: number; ticker: string; date: string; closeDate: string | null; side: string | null; result: string | null;
  netPnl: number | null; signedR: number | null; horizon: string | null; trader: string | null; setup: string | null;
  playbookId: number | null; playbookName: string | null; autoSetup: string | null;
  suggestion: { id: number; name: string; reason: string; via: "linked" | "auto" | "text" } | null;
  suggestedTier: 1 | 2 | 3;
  redacted?: boolean;
};
export type InboxResponse = { trader: string | null; days: number; total: number; trades: InboxTrade[] };

/** GET /api/playbook-tools/inbox — null on an older API (404) so the home hides the block. */
export function usePlaybookInbox(days = 14, enabled = true) {
  return useQuery<InboxResponse | null>({
    queryKey: ["playbook-inbox", days],
    queryFn: ({ signal }) =>
      http.get<InboxResponse>("/api/playbook-tools/inbox", { query: { days, limit: 40 }, signal }).catch(nullIfMissing),
    enabled,
    staleTime: STALE.default,
    retry: 1,
  });
}
