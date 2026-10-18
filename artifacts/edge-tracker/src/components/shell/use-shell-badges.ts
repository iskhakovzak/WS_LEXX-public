/**
 * Attention signals for the shell. Only things someone should act on:
 * - curator: days waiting for review (Кабинет куратора), open content reports (Админка);
 * - everyone: new discussions addressed to them, their own risk status (the sidebar «Сегодня» footer shows the
 *   numbers; the badge stays for the phone tab bar).
 * Each query is light, polls slowly, never in a background tab, and hides itself when the endpoint is missing.
 */
import { useQuery } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { POLL, STALE } from "@/lib/api/keys";
import { riskMeQuery } from "@/lib/api/queries";
import { useAuth } from "@/contexts/auth-context";
import { shellI18n } from "@/i18n/ns/shell";
import { curatorApi, curatorKeys, type TodayPayload } from "@/components/curator/api";

export type RiskStatus = "ok" | "warn" | "breach" | "no_limits";

export type NavBadge = { count?: number; tone: "down" | "warn" | "up"; label: string };

/** The signed-in person's day from GET /api/risk/me (P&L net, trades, daily stop usage). */
export type RiskToday = {
  status: RiskStatus;
  alerts: number;
  halted: boolean;
  pnlNet: number | null;
  trades: number;
  /** 0…100+, null without a daily limit. */
  dailyUsedPct: number | null;
  dailyRemainingUsd: number | null;
  hasLimits: boolean;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** GET /api/risk/me answer → the few fields the shell shows; null when it has no status. */
function toRiskToday(raw: unknown): RiskToday | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = raw as any;
  const status = d?.status as RiskStatus | undefined;
  if (!status) return null;
  const limit = num(d?.limits?.dailyLossLimit ?? d?.dailyLossLimit);
  return {
    status,
    alerts: Array.isArray(d?.alerts) ? d.alerts.length : 0,
    halted: !!d?.halted,
    pnlNet: num(d?.today?.pnlNet),
    trades: num(d?.today?.trades) ?? 0,
    dailyUsedPct: limit ? num(d?.today?.dailyLimitUsedPct) : null,
    dailyRemainingUsd: limit ? num(d?.today?.dailyRemainingUsd) : null,
    hasLimits: !!limit,
  };
}

/**
 * Shared by the badges and the sidebar footer — and with the dashboard / risk page: the same /api/risk/me cache entry
 * (lib/api/queries riskMeQuery, today's NY date). On an older server without the route the query errors and `data`
 * stays undefined, which hides the signal.
 */
export function useRiskToday() {
  const { user } = useAuth();
  const name = user && user.role !== "guest" ? user.traderName : null;
  return useQuery({
    ...riskMeQuery(),
    select: toRiskToday,
    enabled: !!name,
    staleTime: STALE.short,
    refetchInterval: POLL.twoMinutes,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export function useShellBadges(): Record<string, NavBadge | undefined> {
  const { user, isCurator } = useAuth();
  const { t } = shellI18n.useT();
  const name = user && user.role !== "guest" ? user.traderName : null;

  const { data: reports } = useQuery<number>({
    queryKey: ["shell", "open-reports", name],
    queryFn: async ({ signal }) => {
      const d = await http.get<{ open?: unknown } | null>("/api/admin/reports/count", { query: { actor: name! }, signal }).catch(() => null);
      return typeof d?.open === "number" ? d.open : 0;
    },
    enabled: isCurator && !!name,
    refetchInterval: POLL.minute,
    refetchIntervalInBackground: false,
    retry: false,
  });

  // Curator review queue: same request (and cache entry) as the cabinet's «Сегодня» view, so opening the cabinet
  // after the badge costs nothing. Only counts are read here.
  const { data: queue } = useQuery<TodayPayload | null, Error, { queue: number; overdue: number } | null>({
    queryKey: curatorKeys.today("auto"),
    queryFn: () => curatorApi.today("auto"),
    select: (d: TodayPayload | null) => (d?.counts ? { queue: d.counts.queue || 0, overdue: d.counts.queueOverdue || 0 } : null),
    enabled: isCurator && !!name,
    staleTime: 60_000,
    refetchInterval: 180_000,
    refetchIntervalInBackground: false,
    retry: false,
  });

  const { data: risk } = useRiskToday();

  // Discussions: topics addressed to the viewer they have not opened yet (new in 7 days) + unread threads that mention them.
  // The server only counts threads the viewer is allowed to read (audience-filtered).
  const { data: disc } = useQuery<{ attention: number; mentions: number } | null>({
    queryKey: ["shell", "discussions-unread", name],
    queryFn: async ({ signal }) => {
      const d = await http.get<{ attention?: unknown; mentions?: unknown } | null>("/api/discussions/unread-count", { signal }).catch(() => null);
      if (typeof d?.attention !== "number") return null;
      return { attention: d.attention, mentions: typeof d.mentions === "number" ? d.mentions : 0 };
    },
    enabled: !!name,
    staleTime: STALE.default,
    refetchInterval: POLL.minute,
    refetchIntervalInBackground: false,
    retry: false,
  });

  return {
    "/curator":
      queue && queue.queue > 0
        ? {
            count: queue.queue,
            tone: queue.overdue > 0 ? "warn" : "up",
            label: queue.overdue > 0 ? t("badges.curatorOverdue", { count: queue.queue }) : t("badges.curatorQueue", { count: queue.queue }),
          }
        : undefined,
    "/discussions":
      disc && disc.attention > 0
        ? {
            count: disc.attention,
            tone: disc.mentions > 0 ? "warn" : "up",
            label: disc.mentions > 0
              ? t("badges.discussionsMentions", { count: disc.attention })
              : t("badges.discussionsNew", { count: disc.attention }),
          }
        : undefined,
    "/admin": reports && reports > 0 ? { count: reports, tone: "down", label: t("badges.openReports", { count: reports }) } : undefined,
    "/risk":
      risk?.status === "breach"
        ? { tone: "down", label: t("badges.riskBreach"), count: risk.alerts || undefined }
        : risk?.status === "warn"
          ? { tone: "warn", label: t("badges.riskWarn") }
          : undefined,
  };
}
