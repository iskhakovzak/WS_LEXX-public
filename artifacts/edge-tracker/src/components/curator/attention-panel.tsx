import * as React from "react";
import { Link } from "wouter";
import { ArrowRight, Check, Layers, NotebookPen, Sparkles } from "lucide-react";
import { EmptyState, Panel, Pill, StatusDot, type Tone } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { links } from "@/lib/links";
import { fmtDate, fmtUsd } from "@/lib/format";
import { mistakeLabel } from "@/components/shared/mistake-labels";
import { curatorI18n } from "@/i18n/ns/curator";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";
import { curatorApi, useCuratorMutation, type CostQueueRow, type CostReasonKind, type TodayPayload } from "./api";
import { MONEY_PARAMS, attentionRows, primaryAction, type AttentionRow } from "./cost-queue-model";
import { actionTone, curatorLinks } from "./curator-math";

type Reason = CostQueueRow["reasons"][number];

const REASON_TONE: Record<CostReasonKind, Tone> = {
  stop_breach: "down", loss_streak: "down", focus_broken: "warn", fees: "warn", giveback: "warn", disputed: "purple", rule: "neutral",
};
const VISIBLE = 10;

/** Short chip label of a reason. */
const reasonLabel = (k: CostReasonKind) => curatorI18n.tryT(`costQueue.reason.${k}`) ?? k;

/** The reason's line (tooltip / note prefill): params from the server, $ and dates formatted, mistake ids as labels. */
function reasonDetail(r: Reason): string {
  const raw = r.text.params ?? {};
  const p: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) p[k] = "—";
    else if (MONEY_PARAMS.has(k) && typeof v === "number") p[k] = fmtUsd(v, { decimals: 0 });
    else if (k === "mistake") p[k] = mistakeLabel(String(v));
    else if (k === "rule") p[k] = mistakeLabel(`rule:${v}`);
    else if (k === "from") p[k] = fmtDate(String(v), "dayMonth");
    else if (k === "scope") p[k] = curatorI18n.tryT(`costQueue.scope.${v}`) ?? String(v);
    else p[k] = v;
  }
  if ((r.kind === "focus_broken" || r.kind === "disputed") && !Number(raw.count)) return curatorI18n.t(`costQueue.detail.${r.kind}Day`, { mistake: p.mistake ?? "—" });
  if (r.kind === "rule" && Number(raw.rules) > 1) return curatorI18n.t("costQueue.detail.ruleMany", { count: p.count ?? 0, rule: p.rule ?? "—", more: Number(raw.rules) - 1 });
  return curatorI18n.tryT(r.text.key, p) ?? reasonLabel(r.kind);
}

/** «Следующие шаги» merged with the queue by money: the most expensive problems first, then the usual next steps. */
export function AttentionPanel({ data, onOpenTrader, onTemplate }: {
  data: TodayPayload;
  onOpenTrader: (trader: string, tab?: string) => void;
  onTemplate: (traders: string[]) => void;
}) {
  const { t } = curatorI18n.useT();
  const [all, setAll] = React.useState(false);
  const rows = React.useMemo(() => attentionRows(data), [data]);
  const shown = all ? rows : rows.slice(0, VISIBLE);
  const open = rows.filter((r) => r.type === "next" || !r.item.resolved).length;
  return (
    <Panel
      className="lg:col-span-7"
      fill
      title={t("today.nextTitle")}
      icon={Sparkles}
      description={t("today.nextHint")}
      actions={open ? <Pill tone="neutral">{open}</Pill> : undefined}
    >
      {rows.length === 0 ? (
        <EmptyState compact icon={Sparkles} title={t("today.allClear")} description={t("today.allClearHint")} />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shown.map((r) => (r.type === "cost"
            ? <CostRow key={r.key} row={r} onOpenTrader={onOpenTrader} />
            : <NextRow key={r.key} row={r} onOpenTrader={onOpenTrader} onTemplate={onTemplate} />))}
          {rows.length > VISIBLE && (
            <li>
              <button type="button" onClick={() => setAll((v) => !v)} className="px-1 text-xs text-primary hover:underline">
                {all ? commonI18n.t("actions.collapse") : t("showMore", { count: rows.length - VISIBLE })}
              </button>
            </li>
          )}
        </ul>
      )}
    </Panel>
  );
}

function CostRow({ row, onOpenTrader }: { row: Extract<AttentionRow, { type: "cost" }>; onOpenTrader: (trader: string, tab?: string) => void }) {
  const { t } = curatorI18n.useT();
  const { item } = row;
  const action = primaryAction(row);
  const day = fmtDate(item.date, "dayMonth");
  return (
    <li className={cn("tile flex min-w-0 flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:gap-3", item.resolved && "opacity-70")}>
      <div className="flex min-w-0 items-baseline gap-2 sm:w-32 sm:shrink-0 sm:flex-col sm:gap-0">
        <button type="button" onClick={() => onOpenTrader(item.trader)} className="max-w-full truncate text-left text-sm font-medium text-foreground hover:text-primary" title={personName(item.trader)}>
          {personName(item.trader)}
        </button>
        <Link href={curatorLinks.journalDay(item.trader, item.date)} className="text-xs tabular-nums text-muted-foreground hover:text-primary" title={t("costQueue.dayTitle", { date: day })}>
          {day}
        </Link>
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {item.reasons.map((r, i) => <ReasonChip key={`${r.kind}:${i}`} r={r} />)}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1.5">
        <span className={cn("w-20 text-right text-sm font-medium tabular-nums", item.costNet < 0 ? "text-down" : "text-muted-foreground")} title={t("costQueue.totalTitle")}>
          {item.costNet < 0 ? fmtUsd(item.costNet, { signed: true, decimals: 0 }) : "—"}
        </span>
        {item.resolved ? (
          <Pill tone="up" title={t("costQueue.resolvedTitle")}><Check className="h-3 w-3" aria-hidden="true" /> {t("costQueue.resolved")}</Pill>
        ) : action.kind === "breach" ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => onOpenTrader(item.trader, "risk")}>{t("costQueue.breach")}</Button>
        ) : action.kind === "focus" ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => onOpenTrader(item.trader)}>{t("costQueue.focus")}</Button>
        ) : (
          <Button asChild size="sm" variant="ghost">
            <Link href={action.kind === "next" ? action.href : curatorLinks.journalDay(item.trader, item.date)}>{t("open")} <ArrowRight className="h-3.5 w-3.5" /></Link>
          </Button>
        )}
        <QuickNote trader={item.trader} prefill={`${day}: ${item.reasons.map(reasonDetail).join("; ")}`} />
      </div>
    </li>
  );
}

function ReasonChip({ r }: { r: Reason }) {
  const body = (
    <Pill tone={REASON_TONE[r.kind]} title={reasonDetail(r)}>
      {reasonLabel(r.kind)}
      {r.costNet != null && r.costNet < 0 && <span className="tabular-nums opacity-80">{fmtUsd(r.costNet, { decimals: 0 })}</span>}
    </Pill>
  );
  if (r.tradeId == null) return body;
  return <Link href={links.trade(r.tradeId)} className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${reasonLabel(r.kind)} · ${curatorI18n.t("costQueue.tradeTitle")}`}>{body}</Link>;
}

function NextRow({ row, onOpenTrader, onTemplate }: {
  row: Extract<AttentionRow, { type: "next" }>;
  onOpenTrader: (trader: string, tab?: string) => void;
  onTemplate: (traders: string[]) => void;
}) {
  const { t } = curatorI18n.useT();
  const a = row.next;
  return (
    <li className="tile flex min-w-0 items-center gap-3 px-3 py-2">
      <button type="button" onClick={() => onOpenTrader(a.trader)} className="w-28 shrink-0 truncate text-left text-sm font-medium text-foreground hover:text-primary sm:w-32">
        {personName(a.trader)}
      </button>
      <StatusDot tone={actionTone(a.kind)} className="min-w-0 flex-1"><span className="text-sm text-foreground">{a.label}</span></StatusDot>
      {a.kind === "no_limits" ? (
        <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={() => onTemplate([a.trader])}>
          <Layers className="h-3.5 w-3.5" /> {t("today.template")}
        </Button>
      ) : (
        <Button asChild size="sm" variant="ghost" className="shrink-0">
          <Link href={a.href}>{t("open")} <ArrowRight className="h-3.5 w-3.5" /></Link>
        </Button>
      )}
    </li>
  );
}

/** One-line private note right from the row (prefilled with the day's reasons); saving marks the row reviewed. */
function QuickNote({ trader, prefill }: { trader: string; prefill: string }) {
  const { t } = curatorI18n.useT();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [body, setBody] = React.useState(prefill);
  const add = useCuratorMutation((text: string) => curatorApi.addNote({ trader, body: text, kind: "note" }));
  const save = () => {
    const text = body.trim();
    if (!text || add.isPending) return;
    add.mutate(text, {
      onSuccess: () => { setOpen(false); toast({ title: t("costQueue.noteSaved") }); },
      onError: (e) => toast({ title: t("costQueue.noteFailed"), description: (e as Error).message, variant: "destructive" }),
    });
  };
  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v) setBody(prefill); }}>
      <PopoverTrigger asChild>
        <Button type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0" title={t("costQueue.note")} aria-label={t("costQueue.noteTitle", { name: personName(trader) })}>
          <NotebookPen className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-2">
        <span className="text-sm font-medium text-foreground">{t("costQueue.noteTitle", { name: personName(trader) })}</span>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          maxLength={4000}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } }}
        />
        <p className="text-xs text-muted-foreground">{t("costQueue.noteHint")}</p>
        <Button type="button" size="sm" className="self-end" onClick={save} disabled={!body.trim() || add.isPending}>
          {add.isPending ? t("saving") : t("costQueue.noteSave")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
