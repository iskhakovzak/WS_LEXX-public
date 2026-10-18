/**
 * Header market clock pill: NY time, US equities session state with a coloured dot, and a live
 * countdown to the next transition (premarket 4:00 → regular 9:30 → after-hours 16:00 → closed 20:00).
 * Weekends and full-day US market holidays (from /api/holidays) count as closed.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCountdown, getSessionState, type NextKey, type SessionPhase } from "@/components/dashboard/market-session";
import { shellI18n } from "@/i18n/ns/shell";
import { fmtDate } from "@/i18n/format";

const PREMARKET_TO_OPEN_MS = 5.5 * 3600 * 1000;

type Holiday = { date: string; name: string };

function isoPlus(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Full-day market holidays for the next few weeks. Cheap, cached for hours, silent on failure. */
export function useMarketHolidays(): Holiday[] {
  const from = isoPlus(-1);
  const { data } = useQuery<Holiday[]>({
    queryKey: ["market-holidays", from],
    queryFn: async ({ signal }) => {
      const j = await http.get<{ events?: unknown } | null>("/api/holidays", { query: { from, to: isoPlus(30), types: "holiday" }, signal }).catch(() => null);
      const rows: any[] = Array.isArray(j?.events) ? j.events : [];
      return rows
        .filter((e) => String(e?.type ?? "").toLowerCase() === "holiday")
        .map((e) => ({ date: String(e.date).slice(0, 10), name: String(e.name ?? shellI18n.t("clock.holidayFallback")) }));
    },
    staleTime: STALE.day,
    gcTime: 12 * 3600_000,
    retry: false,
  });
  return data ?? [];
}

const PHASE: Record<SessionPhase, { dot: string; text: string }> = {
  pre: { dot: "bg-warn", text: "text-warn" },
  regular: { dot: "bg-up", text: "text-up" },
  after: { dot: "bg-purple", text: "text-purple" },
  closed: { dot: "bg-muted-foreground", text: "text-muted-foreground" },
};

/** What the countdown points to (language-neutral; `nextLabel` is the same in the UI language). */
export type { NextKey };

/** Ticking session state (1 s). Exported so pages can share the same clock logic. */
export function useMarketClock() {
  const holidays = useMarketHolidays();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return useMemo(() => {
    const s = getSessionState(now, holidays);
    // When closed, the next transition is the premarket start (always 5.5 h before the open).
    let msToNext = s.msToNext;
    let nextLabel = s.nextLabel;
    let nextKey: NextKey = s.nextKey;
    if (s.phase === "closed" && msToNext > PREMARKET_TO_OPEN_MS) {
      msToNext -= PREMARKET_TO_OPEN_MS;
      nextKey = "toPremarket";
      nextLabel = shellI18n.t("clock.next.toPremarket");
    }
    return { ...s, msToNext, nextLabel, nextKey };
  }, [now, holidays]);
}

/**
 * `fit="container"`: size the pill by the nearest `@container` (the app header) instead of the viewport, so it
 * never collides with the search and the bell when the sidebar eats half the screen (e.g. 800 px + open menu).
 */
export function MarketClock({ className, fit = "viewport" }: { className?: string; fit?: "viewport" | "container" }) {
  const c = fit === "container";
  const s = useMarketClock();
  const { t } = shellI18n.useT();
  const ph = { ...PHASE[s.phase], label: t(`clock.phase.${s.phase}`), short: t(`clock.phaseShort.${s.phase}`) };
  const next = t(`clock.next.${s.nextKey}`);
  const reason = s.phase === "closed" ? (s.holiday ? s.holiday : s.weekend ? t("clock.weekend") : null) : null;
  const hm = s.nyTime.slice(0, 5);
  const countdown = formatCountdown(s.msToNext);
  const local = fmtDate(new Date(), "time");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role="timer"
          aria-live="off"
          aria-label={reason
            ? t("clock.ariaWithReason", { time: hm, phase: ph.label, reason, next, countdown })
            : t("clock.aria", { time: hm, phase: ph.label, next, countdown })}
          tabIndex={0}
          className={cn(
            "glass-field inline-flex h-10 min-w-0 items-center gap-2 px-3 text-xs tabular-nums text-muted-foreground",
            className,
          )}
        >
          <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
            {s.phase === "regular" && (
              // A few pings when the session opens (or the app loads), then a steady dot: the clock is on every page.
              <span className={cn("absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping [animation-iteration-count:4]", ph.dot)} />
            )}
            <span className={cn("relative h-2 w-2 rounded-full", ph.dot)} />
          </span>
          <span className="font-semibold text-foreground">
            <span className={cn("hidden text-muted-foreground", c ? "@[600px]:inline" : "sm:inline")}>{t("clock.ny")} </span>
            {hm}
            <span className={cn("hidden text-muted-foreground", c ? "@[960px]:inline" : "lg:inline")}>{s.nyTime.slice(5)}</span>
          </span>
          <span className={cn("hidden font-medium", c ? "@[600px]:inline" : "md:inline", ph.text)}>{ph.label}</span>
          <span className={cn("font-medium", c ? "@[600px]:hidden" : "md:hidden", ph.text)}>{ph.short}</span>
          <span className={cn("hidden h-3.5 w-px bg-[var(--field-border)]", c ? "@[600px]:block" : "sm:block")} aria-hidden="true" />
          <span className={cn("hidden whitespace-nowrap", c ? "@[600px]:inline" : "sm:inline")}>
            <span className={cn("hidden", c ? "@[1180px]:inline" : "2xl:inline")}>{next} </span>
            <span className="text-foreground">{countdown}</span>
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs text-xs">
        <div className="font-medium">
          {ph.label}{reason ? ` · ${reason}` : ""}
        </div>
        <div className="text-muted-foreground">
          {next}: {countdown}
        </div>
        <div className="text-muted-foreground">
          {t("clock.tooltipTimes", { ny: s.nyTime, local })}
        </div>
        <div className="mt-1 text-muted-foreground">{t("clock.tooltipSchedule")}</div>
      </TooltipContent>
    </Tooltip>
  );
}
