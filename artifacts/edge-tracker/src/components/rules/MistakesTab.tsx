import { forwardRef, useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, Check, NotebookPen, Plus, Tags } from "lucide-react";
import { BentoGrid, EmptyState, Panel, Pill } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { links } from "@/lib/links";
import { useBehaviorPatterns, useMistakesSummary } from "./api";
import { http } from "@/lib/api/http";
import { humanizeApiError } from "@/lib/api/errors";
import { MISTAKE_CATEGORIES, mistakeLabel } from "./constants";
import { commonI18n } from "@/i18n/ns/common";
import { rulesI18n } from "@/i18n/ns/rules";
import { rich } from "./rich";

const sideLabel = (side: string) => {
  const s = side.toLowerCase();
  return s === "long" ? commonI18n.t("trading.long") : s === "short" ? commonI18n.t("trading.short") : side;
};
import { fmtDate, fmtUsd } from "@/lib/format";
import { MistakeLog } from "./MistakeLog";
import { ruleFromPattern, type RuleDraft } from "./templates";
import type { Mistake, RulesReportResponse } from "./types";

/**
 * «Ошибки»: what mistakes cost (top by $), behaviour patterns found in the trades (with «создать правило»),
 * losing trades nobody has looked at yet (one-click tagging), then the full log.
 */
export const MistakesTab = forwardRef<HTMLInputElement, {
  trader: string;
  days: number;
  report: RulesReportResponse | undefined;
  mistakes: Mistake[];
  onNewMistake: () => void;
  onEditMistake: (m: Mistake) => void;
  onCreateRule: (d: RuleDraft) => void;
  onChanged: () => void;
}>(function MistakesTab({ trader, days, report, mistakes, onNewMistake, onEditMistake, onCreateRule, onChanged }, searchRef) {
  const { t } = rulesI18n.useT();
  const summaryQ = useMistakesSummary(trader, days);
  const s = summaryQ.data;
  const behQ = useBehaviorPatterns(trader, s?.from, s?.to);
  const [showAllTypes, setShowAllTypes] = useState(false);

  const patterns = useMemo(
    () => (behQ.data?.patterns ?? []).filter((p) => p.severity && p.severity !== "none" && (p.cost ?? 0) < 0).sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0)),
    [behQ.data],
  );
  const existing = report?.rules ?? [];
  const hasRuleFor = (d: RuleDraft) =>
    existing.some((r) => r.status !== "disabled" && r.kind === d.kind && (d.kind !== "self_check" || r.name === d.name));

  const maxLoss = Math.max(1, ...(s?.byType ?? []).map((t) => Math.abs(Math.min(0, t.net))));

  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      <BentoGrid>
        <Panel
          className={patterns.length ? "lg:col-span-7" : "lg:col-span-12"}
          fill
          title={t("mistakesTab.costlyTitle")}
          description={s && s.totals.mistakes > 0 ? t("mistakesTab.costlyDesc", { count: s.totals.mistakes, days, net: fmtUsd(s.totals.net, { signed: true, decimals: "trim" }) }) : t("mistakesTab.costlyDescEmpty", { days })}
          actions={<Button variant="ghost" size="sm" onClick={onNewMistake}><NotebookPen /> {t("mistakesTab.log")}</Button>}
        >
          {summaryQ.isLoading ? (
            <div className="flex flex-col gap-2" aria-hidden="true">{[0, 1, 2].map((i) => <span key={i} className="skeleton block h-9 w-full" />)}</div>
          ) : summaryQ.error ? (
            <p className="text-sm text-muted-foreground">{humanizeApiError(summaryQ.error, t("mistakesTab.summaryFailed"))}</p>
          ) : !s || s.byType.length === 0 ? (
            <EmptyState compact icon={Tags} title={t("mistakesTab.noneTitle")} description={t("mistakesTab.noneDesc")} />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {(showAllTypes ? s.byType : s.byType.slice(0, 8)).map((row) => (
                <li key={row.type} className="grid grid-cols-[minmax(0,1fr)_minmax(64px,30%)_84px] items-center gap-3 rounded-lg px-1 py-1.5">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground" title={mistakeLabel(row.type)}>{mistakeLabel(row.type)}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[
                        t("mistakesTab.times", { count: row.count }),
                        row.trades ? commonI18n.t("units.tradesShort", { count: row.trades }) : null,
                        row.lastDay ? t("mistakesTab.lastOn", { date: fmtDate(row.lastDay, "dayMonth") }) : null,
                        row.open ? t("mistakesTab.openCount", { count: row.open }) : null,
                      ].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="h-2 rounded-full bg-[var(--glass-bg)]" aria-hidden="true">
                    <span className="block h-2 rounded-full bg-down" style={{ width: `${(Math.abs(Math.min(0, row.net)) / maxLoss) * 100}%` }} />
                  </span>
                  <span className={cn("text-right text-sm font-semibold tabular-nums", row.net < 0 ? "text-down" : row.net > 0 ? "text-up" : "text-muted-foreground")}>
                    {row.trades ? fmtUsd(row.net, { signed: true, decimals: "trim" }) : "—"}
                  </span>
                </li>
              ))}
              {s.byType.length > 8 && (
                <li>
                  <Button variant="ghost" size="sm" className="rounded-full" onClick={() => setShowAllTypes((v) => !v)}>
                    {showAllTypes ? commonI18n.t("actions.collapse") : commonI18n.t("actions.showAllCount", { count: s.byType.length })}
                  </Button>
                </li>
              )}
            </ul>
          )}
        </Panel>

        {patterns.length > 0 && (
          <Panel
            className="lg:col-span-5"
            fill
            title={t("mistakesTab.patternsTitle")}
            description={t("mistakesTab.patternsDesc")}
            footer={<Link href={links.behavior({ trader })} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">{t("mistakesTab.allPatterns")} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>}
          >
            <ul className="flex flex-col gap-2">
              {patterns.slice(0, 5).map((p) => {
                const draft = ruleFromPattern(p, behQ.data, report?.stats);
                const has = draft ? hasRuleFor(draft) : false;
                return (
                  <li key={p.key} className="tile flex items-center gap-3 p-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">{p.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {commonI18n.t("units.tradesShort", { count: p.n })} · {rich(t("mistakesTab.patternCost", { amount: "{amount}" }), { amount: <span className="font-medium text-down tabular-nums">{fmtUsd(p.cost, { signed: true, decimals: "trim" })}</span> })}
                      </span>
                    </span>
                    {draft && (has ? (
                      <Pill tone="accent"><Check className="h-3 w-3" aria-hidden="true" />{t("mistakesTab.hasRule")}</Pill>
                    ) : (
                      <Button variant="outline" size="sm" onClick={() => onCreateRule(draft)} title={draft.name}><Plus /> {t("mistakesTab.rule")}</Button>
                    ))}
                  </li>
                );
              })}
            </ul>
          </Panel>
        )}
      </BentoGrid>

      {s && s.untagged.length > 0 && <UntaggedTrades trader={trader} trades={s.untagged} losing={s.totals.losingTrades} onChanged={onChanged} />}

      <MistakeLog ref={searchRef} mistakes={mistakes} trader={trader} onNew={onNewMistake} onEdit={onEditMistake} onChanged={onChanged} />
    </div>
  );
});

function UntaggedTrades({ trader, trades, losing, onChanged }: { trader: string; trades: NonNullable<ReturnType<typeof useMistakesSummary>["data"]>["untagged"]; losing: number; onChanged: () => void }) {
  const { t } = rulesI18n.useT();
  const { toast } = useToast();
  const [sel, setSel] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const toggle = (id: number) => setSel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOn = sel.size === trades.length;

  async function tag(value: string, severity: string) {
    if (!sel.size) return;
    setBusy(true);
    try {
      const r = await http.post<{ created: unknown[]; skipped: number[] }>(`/api/errors/bulk`, { trader, errorType: value, severity, tradeIds: [...sel] });
      toast({ title: t("mistakesTab.tagged", { label: mistakeLabel(value), count: r.created.length }) });
      setSel(new Set());
      onChanged();
    } catch (e) {
      toast({ title: commonI18n.t("states.error"), description: humanizeApiError(e, t("mistakesTab.tagFailed")), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title={t("mistakesTab.untaggedTitle")}
      description={t("mistakesTab.untaggedDesc", { count: losing })}
      actions={
        <Button variant="ghost" size="sm" onClick={() => setSel(allOn ? new Set() : new Set(trades.map((x) => x.id)))}>
          {allOn ? t("mistakesTab.deselect") : commonI18n.t("actions.selectAll")}
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {trades.map((tr) => {
          const on = sel.has(tr.id);
          return (
            <div key={tr.id} className={cn("tile flex items-center gap-2 p-2.5 transition-shadow duration-[var(--dur-1)]", on && "ring-2 ring-primary")}>
              <button type="button" aria-pressed={on} onClick={() => toggle(tr.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none">
                <span className={cn("grid h-4 w-4 shrink-0 place-items-center rounded border", on ? "border-transparent bg-primary-solid text-primary-foreground" : "border-[var(--field-border)]")} aria-hidden="true">
                  {on && <Check className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{tr.ticker}{tr.side ? <span className="font-normal text-muted-foreground"> · {sideLabel(tr.side)}</span> : null}</span>
                  <span className="block text-xs text-muted-foreground tabular-nums">{fmtDate(tr.day, "dayMonth")}{tr.time ? ` · ${tr.time}` : ""}</span>
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-down">{fmtUsd(tr.net, { signed: true, decimals: "trim" })}</span>
              </button>
              <Link href={links.trade(tr.id)} className="shrink-0 text-xs font-medium text-primary hover:underline" aria-label={t("mistakesTab.openTrade", { ticker: tr.ticker })} title={t("mistakesTab.openTrade", { ticker: tr.ticker })}>
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>
          );
        })}
      </div>
      <div className={cn("mt-3 flex flex-wrap items-center gap-1.5", !sel.size && "opacity-60")} role="group" aria-label={t("mistakesTab.tagAria")}>
        <span className="mr-1 text-xs text-muted-foreground">{sel.size ? t("mistakesTab.selectedIs", { count: sel.size }) : t("mistakesTab.pickFirst")}</span>
        {MISTAKE_CATEGORIES.map((c) => (
          <button
            key={c.code}
            type="button"
            disabled={!sel.size || busy}
            onClick={() => tag(c.value, c.severity)}
            title={c.hint}
            className="chip inline-flex min-h-7 items-center px-2.5 text-xs font-medium disabled:cursor-not-allowed"
          >
            {c.label}
          </button>
        ))}
      </div>
    </Panel>
  );
}
