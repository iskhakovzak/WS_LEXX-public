import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowUpRight, Camera, CircleDashed, CircleCheck, NotebookPen, Users } from "lucide-react";
import { EmptyState, Panel, Pill } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { gpApi, gpKeys, type PlanDoc, type TraderPlan } from "./types";
import { fmtDate } from "@/lib/format";
import { PlanDocView } from "./plan-doc-view";
import { shortDay } from "./plan-briefing";
import { gpI18n } from "@/i18n/ns/gamePlan";
import { comparePersonNames, personInitials, personName } from "@/i18n";
import { ApiError } from "@/lib/api/http";

function collectMediaCount(doc: Partial<PlanDoc>): number {
  return (doc.media?.length ?? 0) + (doc.inPlay ?? []).reduce((n, t) => n + (t.media?.length ?? 0), 0);
}

/** Curator view: who wrote a plan for the day, and the selected trader's plan read-only. */
export function TraderPlans({ date }: { date: string }) {
  const { t } = gpI18n.useT();
  const q = useQuery({
    queryKey: gpKeys.traders(date),
    queryFn: () => gpApi.traders(date),
    refetchInterval: 60_000,
    retry: false,
  });
  const plans = useMemo(() => q.data?.plans ?? [], [q.data]);
  const missing = useMemo(() => [...(q.data?.missing ?? [])].sort(comparePersonNames), [q.data]);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    if (!plans.length) setSel(null);
    else if (!sel || !plans.some((p) => p.trader === sel)) setSel(plans[0]!.trader);
  }, [plans, sel]);
  const current = plans.find((p) => p.trader === sel) ?? null;

  if (q.isLoading)
    return (
      <div className="grid gap-[var(--grid-gap)] lg:grid-cols-[280px_minmax(0,1fr)]" aria-busy="true" aria-label={t("traders.loading")}>
        <Skeleton className="h-80 rounded-2xl" />
        <Skeleton className="h-96 rounded-2xl" />
      </div>
    );
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} message={serverMsg(q.error)} />;

  if (!plans.length)
    return (
      <Panel>
        <EmptyState
          icon={Users}
          title={t("traders.emptyTitle", { date: shortDay(date) })}
          description={missing.length ? t("traders.emptyMissing", { names: missing.map(personName).join(", ") }) : t("traders.emptyHint")}
        />
      </Panel>
    );

  const ready = plans.filter((p) => p.status === "ready").length;

  return (
    <div className="grid gap-[var(--grid-gap)] lg:grid-cols-[280px_minmax(0,1fr)]">
      <Panel
        title={t("traders.title")}
        icon={Users}
        description={
          <span className="tabular-nums">
            {missing.length
              ? t("traders.summaryMissing", { ready, working: plans.length - ready, missing: missing.length })
              : t("traders.summary", { ready, working: plans.length - ready })}
          </span>
        }
        bodyClassName="px-2 sm:px-2"
      >
        <ul className="flex flex-col gap-0.5" role="listbox" aria-label={t("traders.listAria")}>
          {plans.map((p) => (
            <li key={p.trader}>
              <TraderRow plan={p} active={p.trader === sel} onSelect={() => setSel(p.trader)} />
            </li>
          ))}
        </ul>
        {missing.length > 0 && (
          <div className="mt-3 border-t border-[var(--field-border)] px-2 pt-3">
            <p className="text-xs text-muted-foreground">{t("traders.noPlan")}</p>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {missing.map((n) => (
                <li key={n}>
                  <Pill tone="neutral">{personName(n)}</Pill>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

      {current && (
        <Panel
          title={
            <span className="flex items-center gap-2">
              {personName(current.trader)}
              <Pill tone={current.status === "ready" ? "accent" : "neutral"} dot>
                {current.status === "ready" ? t("traders.ready") : t("traders.draft")}
              </Pill>
            </span>
          }
          icon={NotebookPen}
          description={t("traders.updatedAt", { time: fmtDate(current.updatedAt, "time") })}
          actions={
            <Link
              href={links.journalDay(date, current.trader)}
              className="chip inline-flex min-h-8 items-center gap-1.5 px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("traders.journalDay")}
              <ArrowUpRight className="h-3 w-3 opacity-70" aria-hidden="true" />
            </Link>
          }
        >
          <PlanDocView key={current.trader} doc={current.doc} compactTickers />
        </Panel>
      )}
    </div>
  );
}

function TraderRow({ plan, active, onSelect }: { plan: TraderPlan; active: boolean; onSelect: () => void }) {
  const { t } = gpI18n.useT();
  const tickers = (plan.doc.inPlay ?? []).map((i) => i.ticker).filter(Boolean);
  const shots = collectMediaCount(plan.doc);
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-primary/12" : "hover:bg-[var(--glass-hover-bg)]",
      )}
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--glass-bg)] text-xs font-semibold">{personInitials(plan.trader)}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium" title={personName(plan.trader)}>{personName(plan.trader)}</span>
          {plan.status === "ready" ? (
            <CircleCheck className="h-3.5 w-3.5 shrink-0 text-primary" aria-label={t("traders.ready")} />
          ) : (
            <CircleDashed className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t("traders.draft")} />
          )}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {tickers.length ? tickers.slice(0, 5).join(" · ") : t("traders.noTickers")}
          {tickers.length > 5 ? ` +${tickers.length - 5}` : ""}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs tabular-nums text-muted-foreground">
        {fmtDate(plan.updatedAt, "time")}
        {shots > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <Camera className="h-3 w-3" aria-hidden="true" />
            {shots}
          </span>
        )}
      </span>
    </button>
  );
}

function serverMsg(e: unknown): string | undefined {
  if (!(e instanceof Error)) return undefined;
  return e instanceof ApiError && e.status === 404 ? gpI18n.t("traders.notDeployed") : e.message;
}
