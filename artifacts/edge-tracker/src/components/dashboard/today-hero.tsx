import { useEffect, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LimitBar, Segmented, StatusDot, limitTone, limitToneToTone, toneOf, toneText, type Tone } from "@/components/ds";
import { KPI_FORMULAS } from "@/lib/trade-math";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { PHASE_LABEL, formatCountdown, getSessionState, type SessionPhase } from "./market-session";
import { shortDate } from "./fmt";
import { fmtDate, fmtR, fmtRate, fmtUsd } from "@/lib/format";
import type { DashboardToday, RiskDesk, RiskMe, Scope } from "./use-dashboard";
import { commonI18n } from "@/i18n/ns/common";
import { dashboardI18n } from "@/i18n/ns/dashboard";
import { personName } from "@/i18n";

function greeting(d: Date) {
  const h = d.getHours();
  const t = dashboardI18n.t;
  if (h < 5) return t("hero.greeting.night");
  if (h < 12) return t("hero.greeting.morning");
  if (h < 18) return t("hero.greeting.day");
  return t("hero.greeting.evening");
}

const PHASE_TONE: Record<SessionPhase, Tone> = { pre: "warn", regular: "up", after: "purple", closed: "neutral" };

/** One cell of the header state line: label · value · hint. */
function Cell({
  label,
  value,
  hint,
  tone = "neutral",
  loading,
  title,
  href,
  extra,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  loading?: boolean;
  title?: string;
  href?: string;
  extra?: ReactNode;
}) {
  const body = (
    <>
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      {loading ? (
        <Skeleton className="my-0.5 h-6 w-24 rounded-md" />
      ) : (
        <span className={cn("truncate text-xl font-semibold leading-7 tabular-nums tracking-tight", toneText(tone))}>{value}</span>
      )}
      {loading ? <Skeleton className="h-3.5 w-28 rounded" /> : hint != null && <span className="truncate text-xs text-muted-foreground tabular-nums">{hint}</span>}
      {!loading && extra}
    </>
  );
  const cls = "flex min-w-0 flex-col gap-0.5 lg:border-l lg:border-[var(--glass-border)] lg:pl-4";
  // Narrow cells truncate the hint: keep the full text reachable on hover.
  const tip = title ?? (typeof hint === "string" ? hint : undefined);
  if (href) {
    return (
      <Link
        href={href}
        title={tip}
        className={cn(cls, "rounded-lg transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
      >
        {body}
      </Link>
    );
  }
  return (
    <div className={cls} title={tip}>
      {body}
    </div>
  );
}

/** NY clock + phase + countdown. Ticks itself only, so the rest of the header does not re-render every second. */
function MarketCell({ holidays }: { holidays: { date: string; name: string }[] }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const s = getSessionState(now, holidays);
  const reason = s.phase === "closed" ? (s.holiday ?? (s.weekend ? dashboardI18n.t("hero.weekend") : null)) : null;
  return (
    <Cell
      label={
        <StatusDot tone={PHASE_TONE[s.phase]} pulse={s.phase === "regular"} className="text-xs text-muted-foreground">
          {PHASE_LABEL[s.phase]}
          {reason ? ` · ${reason}` : ""}
        </StatusDot>
      }
      title={dashboardI18n.t("hero.nyTime")}
      value={
        <>
          <time dateTime={`${s.nyDate}T${s.nyTime}`}>{s.nyTime.slice(0, 5)}</time>
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">NY</span>
        </>
      }
      hint={`${s.nextLabel} ${formatCountdown(s.msToNext)}`}
    />
  );
}

function RiskCell({ risk, desk, team, loading }: { risk: RiskMe | null | undefined; desk: RiskDesk | null | undefined; team: boolean; loading: boolean }) {
  const { t } = dashboardI18n.useT();
  if (team) {
    if (desk === undefined && loading) return <Cell label={t("hero.deskLimits")} value="" loading />;
    if (!desk) return <Cell label={t("hero.deskLimits")} value="—" hint={t("hero.riskUnavailable")} href={links.risk()} />;
    const s = desk.summary;
    const bad = s.halted + s.breach;
    const value = bad > 0 ? t("hero.stops", { count: bad }) : s.warn > 0 ? t("hero.nearLimit", { count: s.warn }) : t("hero.allWithin");
    const tone: Tone = bad > 0 ? "down" : s.warn > 0 ? "warn" : "up";
    return (
      <Cell
        label={t("hero.deskLimits")}
        value={value}
        tone={tone}
        hint={s.noLimits > 0 ? t("hero.noLimits", { traders: commonI18n.t("units.traders", { count: s.noLimits }) }) : commonI18n.t("units.traders", { count: s.traders })}
        href={links.risk()}
      />
    );
  }
  if (risk === undefined && loading) return <Cell label={t("hero.dailyLimit")} value="" loading />;
  if (!risk) return <Cell label={t("hero.dailyLimit")} value="—" hint={t("hero.riskUnavailable")} />;
  if (risk.halted) {
    return <Cell label={t("hero.dailyLimit")} value={risk.stop.label} tone="down" hint={risk.stop.message} href={links.risk(risk.trader)} title={risk.stop.message} />;
  }
  const limit = risk.limits?.dailyLossLimit ?? null;
  if (!risk.limits || limit == null || limit <= 0) {
    return <Cell label={t("hero.dailyLimit")} value={t("hero.notSet")} hint={t("hero.setByCurator")} href={links.risk(risk.trader)} />;
  }
  const loss = Math.max(0, -(risk.today.pnlNet ?? 0));
  const remaining = risk.today.dailyRemainingUsd ?? Math.max(0, limit - loss);
  const lt = limitTone(loss, limit, 0.6);
  return (
    <Cell
      label={t("hero.remaining")}
      value={fmtUsd(remaining, { decimals: 0 })}
      tone={lt === "ok" ? "neutral" : limitToneToTone(lt)}
      hint={t("hero.usedOf", { limit: fmtUsd(limit, { decimals: 0 }), pct: fmtRate(Math.min(1, loss / limit)) })}
      href={links.risk(risk.trader)}
      extra={<LimitBar used={loss} limit={limit} warnAt={0.6} size="sm" showValues={false} className="mt-1" />}
    />
  );
}

/**
 * Dashboard header: who / when, and one line of state — NY session, today and week net P&L, risk limit.
 * No entry CTAs: trades arrive automatically; manual writing lives in the playbook, plans and the journal.
 */
export function DashboardHeader({
  data,
  risk,
  desk,
  isLoading,
  isError,
  onRetry,
  guest,
  scope,
  onScopeChange,
  canChooseScope,
  userName,
  customize,
  dayLine,
}: {
  data: DashboardToday | undefined;
  risk: RiskMe | null | undefined;
  desk: RiskDesk | null | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  guest: boolean;
  scope: Scope;
  onScopeChange: (s: Scope) => void;
  canChooseScope: boolean;
  userName: string | null;
  customize: ReactNode;
  /** The trader's day line (focus · contract · evening card · tier progress), rendered under the state line. */
  dayLine?: ReactNode;
}) {
  const { t: tr } = dashboardI18n.useT();
  const now = new Date();
  const rawDate = fmtDate(now, "weekdayDayMonthLong");
  // «Суббота, 17 октября»: only the first letter is capital (CSS `capitalize` would also give «Октября»).
  const dateLabel = rawDate.charAt(0).toUpperCase() + rawDate.slice(1);
  const t = data?.today;
  const w = data?.week;
  const loading = isLoading && !data;
  const team = scope === "team";
  const quietDay = !!data && (data.market.weekend || !!data.market.holidayToday);

  const todayValue = t?.pnlNet != null ? fmtUsd(t.pnlNet, { signed: true }) : t && t.rCount > 0 ? fmtR(t.r) : "—";
  const todayHint = t
    ? t.closed > 0
      ? [
          commonI18n.t("units.trades", { count: t.closed }),
          `${t.wins}W / ${t.losses}L`,
          t.pnlNet != null && t.rCount > 0 ? fmtR(t.r) : null,
          t.fees ? tr("hero.fees", { amount: fmtUsd(-Math.abs(t.fees), { signed: true }) }) : null,
        ].filter(Boolean).join(" · ")
      : quietDay
        ? tr("hero.marketClosed")
        : tr("hero.noClosed")
    : undefined;

  const weekValue = w?.pnlNet != null ? fmtUsd(w.pnlNet, { signed: true }) : w && w.rCount > 0 ? fmtR(w.r) : "—";
  const weekHint = w
    ? w.closed > 0
      ? tr("hero.weekHint", { trades: commonI18n.t("units.trades", { count: w.closed }), green: w.greenDays, days: w.tradingDays })
      : tr("hero.noWeekTrades")
    : undefined;

  return (
    <section aria-labelledby="dash-hero-title" className="glass-panel rounded-2xl p-[var(--panel-p)]">
      <div className="grid items-center gap-x-4 gap-y-4 sm:grid-cols-2 lg:grid-cols-[minmax(270px,1.35fr)_repeat(4,minmax(0,1fr))]">
        <div className="flex min-w-0 items-start justify-between gap-2 sm:col-span-2 lg:col-span-1">
          <div className="min-w-0">
            <p className="truncate text-xs text-muted-foreground">
              {dateLabel}
              {data && data.market.nyDate !== data.date ? ` · ${tr("hero.tradingDay", { date: shortDate(data.date) })}` : ""}
            </p>
            <h1 id="dash-hero-title" className="line-clamp-2 text-xl font-semibold leading-7 tracking-tight [overflow-wrap:anywhere]">
              {greeting(now)}
              {userName ? `, ${personName(userName)}` : ""}
            </h1>
            {canChooseScope && !guest && (
              <Segmented<Scope>
                ariaLabel={tr("hero.scopeAria")}
                size="sm"
                className="mt-1.5"
                value={scope}
                onChange={onScopeChange}
                options={[
                  { value: "me", label: tr("hero.mine") },
                  { value: "team", label: tr("hero.team") },
                ]}
              />
            )}
          </div>
          <div className="shrink-0">{customize}</div>
        </div>

        <MarketCell holidays={data?.market.holidays ?? []} />

        {guest ? (
          <div className="flex min-w-0 flex-col gap-0.5 sm:col-span-2 lg:col-span-3 lg:border-l lg:border-[var(--glass-border)] lg:pl-4">
            <span className="text-sm font-medium">{tr("hero.guest")}</span>
            <span className="text-xs text-muted-foreground">{tr("hero.guestHint")}</span>
          </div>
        ) : isError && !data ? (
          <div className="flex min-w-0 items-center gap-3 sm:col-span-2 lg:col-span-3 lg:border-l lg:border-[var(--glass-border)] lg:pl-4">
            <span className="text-sm">{tr("hero.loadFailed")}</span>
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw aria-hidden="true" />
              {commonI18n.t("actions.retry")}
            </Button>
          </div>
        ) : (
          <>
            <Cell
              label={team ? tr("hero.deskToday") : tr("hero.today")}
              title={KPI_FORMULAS.netPnl}
              loading={loading}
              value={todayValue}
              tone={toneOf(t?.pnlNet ?? (t && t.rCount > 0 ? t.r : null))}
              hint={todayHint}
            />
            <Cell
              label={w ? tr("hero.weekFrom", { date: shortDate(w.from) }) : tr("hero.week")}
              title={tr("hero.weekTitle")}
              loading={loading}
              value={weekValue}
              tone={toneOf(w?.pnlNet ?? (w && w.rCount > 0 ? w.r : null))}
              hint={weekHint}
            />
            <RiskCell risk={risk} desk={desk} team={team} loading={loading} />
          </>
        )}
      </div>
      {!guest && dayLine}
    </section>
  );
}
