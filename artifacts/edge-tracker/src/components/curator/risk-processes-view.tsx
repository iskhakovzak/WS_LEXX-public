import * as React from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Layers, Moon, Repeat, ShieldAlert, ShieldCheck } from "lucide-react";
import {
  BentoGrid, DataTable, EmptyState, Panel, Pill, QueryState, SortableTh, StatCard, StatGrid, toneOf, useTableSort,
} from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { curatorApi, curatorKeys, useRiskSummary, useRiskTemplates, type RiskSummary, type TemplatesPayload } from "./api";
import { BreachReviewPanel } from "./breach-review";
import { TemplateDialog } from "./template-dialog";
import { fmtDate, fmtUsd } from "@/lib/format";
import { curatorI18n } from "@/i18n/ns/curator";
import { personName } from "@/i18n";

/**
 * «Риск-процессы»: daily risk summary (GET /api/risk/summary), tier limit templates with bulk apply
 * (GET /api/risk/templates, POST /api/risk/templates/apply) and the desk-wide breach review list.
 */
export function RiskProcessesView({ onOpenTrader }: { onOpenTrader: (trader: string, tab?: string) => void }) {
  const summary = useRiskSummary();
  const templates = useRiskTemplates();
  const breaches = useQuery({ queryKey: curatorKeys.breaches(null), queryFn: () => curatorApi.breaches(null, 30), staleTime: 30_000, retry: false });
  const { t } = curatorI18n.useT();

  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      <QueryState query={summary} skeleton={<div className="h-28" aria-hidden="true" />} errorCompact>
        {(s) => <SummaryBlock s={s} onOpenTrader={onOpenTrader} />}
      </QueryState>

      <QueryState query={templates} skeleton={<div className="glass-panel h-64 rounded-2xl" aria-hidden="true" />} errorCompact>
        {(t) => <TemplatesBlock t={t} onOpenTrader={onOpenTrader} />}
      </QueryState>

      <QueryState query={breaches} skeleton={<div className="glass-panel h-40 rounded-2xl" aria-hidden="true" />} errorCompact>
        {(b) => (
          <BreachReviewPanel
            breaches={b.breaches}
            showTrader
            description={t("risk.breachesHint")}
            canReview={b.canReview}
            title={b.unreviewed ? t("risk.breaches30Unreviewed", { count: b.unreviewed }) : t("risk.breaches30")}
          />
        )}
      </QueryState>
    </div>
  );
}

function SummaryBlock({ s, onOpenTrader }: { s: RiskSummary; onOpenTrader: (trader: string, tab?: string) => void }) {
  const x = s.totals;
  const { t } = curatorI18n.useT();
  return (
    <>
      <StatGrid cols={6}>
        <StatCard label={t("risk.deskNet")} value={fmtUsd(x.pnlNetToday, { signed: true, decimals: 0 })} tone={toneOf(x.pnlNetToday)} hint={t("risk.tradingOf", { n: x.trading, total: x.traders })} term="net" />
        <StatCard label={t("risk.halted")} value={s.halted.length} tone={s.halted.length ? "down" : "neutral"} icon={ShieldAlert} hint={s.nearStop.length ? t("risk.nearStop", { count: s.nearStop.length }) : t("risk.nobodyNear")} />
        <StatCard label={t("risk.breaches")} value={s.breachesToday.length} tone={s.breachesToday.length ? "down" : "neutral"} icon={AlertTriangle} hint={s.unreviewedBreaches.length ? t("risk.todayUnreviewed", { count: s.unreviewedBreaches.length }) : t("risk.todayAllReviewed")} />
        <StatCard label={t("risk.repeat7")} value={s.repeatBreachers.length} tone={s.repeatBreachers.length ? "warn" : "neutral"} icon={Repeat} hint={t("risk.toHead")} />
        <StatCard label={t("risk.openRisk")} value={fmtUsd(x.openRiskUsd, { decimals: 0 })} icon={ShieldCheck} hint={t("risk.positions", { count: x.openPositions })} term="openRisk" />
        <StatCard label={t("risk.overnight")} value={x.carriedTonight} tone={s.overnight.some((o) => o.allowed === false) ? "down" : "neutral"} icon={Moon} hint={x.overnightExposureUsd ? fmtUsd(x.overnightExposureUsd, { decimals: 0 }) : t("risk.noExposure")} />
      </StatGrid>
      {(s.repeatBreachers.length > 0 || s.overnight.length > 0 || s.unreviewedBreaches.length > 0) && (
        <BentoGrid>
          <Panel className="lg:col-span-6" fill title={t("risk.needsDecision")} icon={AlertTriangle} description={t("risk.needsDecisionHint")}>
            <ul className="flex flex-col gap-1.5">
              {s.repeatBreachers.map((r) => (
                <li key={`rep-${r.trader}`} className="flex items-center gap-2 text-sm">
                  <Pill tone="warn">{t("risk.repeat")}</Pill>
                  <button type="button" className="font-medium text-foreground hover:text-primary" onClick={() => onOpenTrader(r.trader, "risk")}>{personName(r.trader)}</button>
                  <span className="min-w-0 flex-1 truncate text-xs tabular-nums text-muted-foreground">{t("risk.repeatDays", { count: r.days7, dates: r.dates.map((d) => fmtDate(d, "dayMonth")).join(", ") })}</span>
                </li>
              ))}
              {s.unreviewedBreaches.slice(0, 8).map((b) => (
                <li key={`b-${b.id}`} className="flex items-center gap-2 text-sm">
                  <Pill tone="down" dot>{b.kindLabel}</Pill>
                  <button type="button" className="font-medium text-foreground hover:text-primary" onClick={() => onOpenTrader(b.trader, "risk")}>{personName(b.trader)}</button>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{fmtDate(b.date, "dayMonth")} · {t("risk.needsReview")}</span>
                </li>
              ))}
              {s.repeatBreachers.length === 0 && s.unreviewedBreaches.length === 0 && <li className="text-sm text-muted-foreground">{t("risk.allReviewed")}</li>}
            </ul>
          </Panel>
          <Panel className="lg:col-span-6" fill title={t("risk.overnight")} icon={Moon} description={t("risk.overnightHint")}>
            {s.overnight.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("risk.nobodyOvernight")}</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {s.overnight.map((o) => (
                  <li key={o.trader} className="flex items-center gap-2 text-sm">
                    <button type="button" className="w-28 truncate text-left font-medium text-foreground hover:text-primary" onClick={() => onOpenTrader(o.trader, "risk")} title={personName(o.trader)}>{personName(o.trader)}</button>
                    <span className="text-xs tabular-nums text-muted-foreground">{t("risk.overnightPositions", { count: o.positions, amount: fmtUsd(o.exposureUsd, { decimals: 0 }) })}{o.limitUsd != null ? t("risk.ofLimit", { limit: fmtUsd(o.limitUsd, { decimals: 0 }) }) : ""}</span>
                    <span className="ml-auto">{o.allowed === false ? <Pill tone="down">{t("risk.notAllowed")}</Pill> : o.allowed ? <Pill tone="up">{t("risk.allowed")}</Pill> : <Pill tone="neutral">{t("risk.noLimits")}</Pill>}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </BentoGrid>
      )}
    </>
  );
}

type TemplateRow = TemplatesPayload["traders"][number];
const TIER_ORDER: Record<string, number> = { trainee: 0, junior: 1, trader: 2, senior: 3 };
/** Проблемные строки (нет лимитов → нет тира → расхождение) поднимаются наверх при сортировке по возрастанию. */
const TEMPLATE_ACCESSORS = {
  trader: (r: TemplateRow) => personName(r.trader),
  tier: (r: TemplateRow) => (r.tier ? TIER_ORDER[r.tier] ?? 9 : null),
  daily: (r: TemplateRow) => r.limits?.dailyLossLimit ?? null,
  weekly: (r: TemplateRow) => r.limits?.weeklyLossLimit ?? null,
  dd: (r: TemplateRow) => r.limits?.maxDrawdown ?? null,
  fit: (r: TemplateRow) => (!r.hasLimits ? 0 : !r.tier ? 1 : r.drift.length ? 2 : 3),
};

function TemplatesBlock({ t, onOpenTrader }: { t: TemplatesPayload; onOpenTrader: (trader: string, tab?: string) => void }) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [dialog, setDialog] = React.useState<{ traders: string[]; tier: string | null } | null>(null);
  const ladder = t.tiers.filter((x) => ["trainee", "junior", "trader", "senior"].includes(x.key));
  const needs = t.traders.filter((r) => !r.hasLimits || r.drift.length > 0 || !r.tier);
  const toggle = (name: string) => setSelected((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const allOn = t.traders.length > 0 && t.traders.every((r) => selected.has(r.trader));
  const { rows, thProps } = useTableSort(t.traders, TEMPLATE_ACCESSORS, "fit", "asc");
  const tr = curatorI18n.useT().t;

  return (
    <BentoGrid>
      <Panel
        className="lg:col-span-8"
        fill
        title={tr("risk.templatesTitle")}
        icon={Layers}
        description={tr("risk.templatesHint")}
        actions={t.canEdit ? (
          <div className="flex items-center gap-2">
            {needs.length > 0 && (
              <Button type="button" size="sm" variant="outline" onClick={() => setDialog({ traders: needs.map((r) => r.trader), tier: null })}>
                {tr("risk.fix", { count: needs.length })}
              </Button>
            )}
            <Button type="button" size="sm" disabled={!selected.size} onClick={() => setDialog({ traders: [...selected], tier: null })}>
              <Layers className="h-3.5 w-3.5" /> {selected.size ? tr("risk.applyTemplateN", { count: selected.size }) : tr("risk.applyTemplate")}
            </Button>
          </div>
        ) : <Pill tone="neutral">{tr("risk.viewOnly")}</Pill>}
      >
        {t.traders.length === 0 ? (
          <EmptyState compact icon={Layers} title={tr("risk.noTraders")} />
        ) : (
          <DataTable ariaLabel={tr("risk.tableAria")} maxHeight="65vh">
            <table>
              <thead>
                <tr>
                  {t.canEdit && (
                    <th className="w-8">
                      <Checkbox
                        checked={allOn}
                        onCheckedChange={(v) => setSelected(v ? new Set(t.traders.map((r) => r.trader)) : new Set())}
                        aria-label={tr("risk.selectAll")}
                      />
                    </th>
                  )}
                  <SortableTh {...thProps("trader")}>{tr("risk.col.trader")}</SortableTh>
                  <SortableTh {...thProps("tier")}>{tr("risk.col.tier")}</SortableTh>
                  <SortableTh {...thProps("daily")} align="right">{tr("risk.col.daily")}</SortableTh>
                  <SortableTh {...thProps("weekly")} align="right">{tr("risk.col.weekly")}</SortableTh>
                  <SortableTh {...thProps("dd")} align="right">{tr("risk.col.dd")}</SortableTh>
                  <SortableTh {...thProps("fit")}>{tr("risk.col.fit")}</SortableTh>
                  {t.canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.trader} className={cn(selected.has(r.trader) && "bg-primary/5")}>
                    {t.canEdit && (
                      <td><Checkbox checked={selected.has(r.trader)} onCheckedChange={() => toggle(r.trader)} aria-label={tr("risk.selectOne", { name: personName(r.trader) })} /></td>
                    )}
                    <td><button type="button" className="font-medium text-foreground hover:text-primary" onClick={() => onOpenTrader(r.trader, "risk")}>{personName(r.trader)}</button></td>
                    <td className="text-muted-foreground">{r.tierName ?? "—"}</td>
                    <td className="text-right">{fmtUsd(r.limits?.dailyLossLimit, { decimals: 0 })}</td>
                    <td className="text-right">{fmtUsd(r.limits?.weeklyLossLimit, { decimals: 0 })}</td>
                    <td className="text-right">{fmtUsd(r.limits?.maxDrawdown, { decimals: 0 })}</td>
                    <td className="min-w-[10rem] max-w-[20rem]">
                      {!r.hasLimits ? <Pill tone="warn">{tr("risk.noLimits")}</Pill>
                        : !r.tier ? <Pill tone="neutral">{tr("risk.noTier")}</Pill>
                        : r.drift.length ? <span className="block whitespace-normal break-words text-xs text-warn">{tr("risk.differs", { fields: r.drift.map((d) => d.label).join(", ") })}</span>
                        : <Pill tone="up">{tr("risk.matches")}</Pill>}
                    </td>
                    {t.canEdit && (
                      <td className="text-right">
                        <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setDialog({ traders: [r.trader], tier: r.tier })}>{tr("risk.template")}</Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTable>
        )}
      </Panel>
      <Panel className="lg:col-span-4" fill title={tr("risk.ladderTitle")} icon={ShieldCheck} description={tr("risk.ladder")} actions={<Button asChild size="sm" variant="ghost"><Link href="/scaling">{tr("risk.scaling")} <ArrowRight className="h-3.5 w-3.5" /></Link></Button>}>
        <ul className="flex flex-col gap-2">
          {ladder.map((x) => (
            <li key={x.key} className="tile flex flex-col gap-0.5 p-2.5">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium text-foreground">{x.stageLabel ?? x.name}</span>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">{tr("risk.people", { count: t.traders.filter((r) => r.tier === x.key).length })}</span>
              </div>
              <p className="text-xs tabular-nums text-muted-foreground">
                {tr("risk.tierLine", { daily: fmtUsd(x.dailyLossLimit, { decimals: 0 }), weekly: fmtUsd(x.weeklyLossLimit, { decimals: 0 }), dd: fmtUsd(x.maxDrawdown, { decimals: 0 }) })} · {x.allowOvernight ? tr("risk.overnightYes") : tr("risk.overnightNo")}
              </p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          {tr("risk.escalation")} <Link href="/risk" className="text-primary hover:underline">{tr("risk.riskDeskLink")}</Link>.
        </p>
      </Panel>
      <TemplateDialog
        open={!!dialog}
        onOpenChange={(v) => { if (!v) { setDialog(null); setSelected(new Set()); } }}
        traders={dialog?.traders ?? []}
        defaultTier={dialog?.tier ?? null}
      />
    </BentoGrid>
  );
}
