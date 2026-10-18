/**
 * Таблица сделок с предложенным сетапом: уверенность, объяснение (какие признаки сработали),
 * кнопки «Принять» / «Отклонить» и «Принять всё с уверенностью ≥ X» (одним запросом, с подтверждением).
 * Недостающие предложения считает «Посчитать всё» (setups-compute.tsx) над таблицей.
 */
import * as React from "react";
import { Link } from "wouter";
import { Check, CheckCheck, ChevronDown, ChevronRight, RefreshCw, Sparkles, X } from "lucide-react";
import { DataTable, EmptyState, Pill, SortableTh, toneOf, toneText, useTableSort } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "@/hooks/use-toast";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import {
  fmtClock, fmtMinutes, useAcceptBulk, useAcceptSetup, useRecomputeSetup, useRejectSetup,
  type SetupItem, type SuggestionStatus,
} from "./api";
import { fmtDate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { behaviorI18n } from "@/i18n/ns/behavior";

const tb = behaviorI18n.t;

const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9] as const;
const BULK_CHUNK = 500;

/** «Принять всё с уверенностью ≥ X». */
function BulkAccept({ items }: { items: SetupItem[] }) {
  const [min, setMin] = React.useState<number>(0.7);
  const [confirm, setConfirm] = React.useState(false);
  const bulk = useAcceptBulk();
  const eligible = React.useMemo(
    () => items.filter((i) => i.suggestion?.status === "suggested" && i.suggestion.confidence >= min),
    [items, min],
  );
  const bySetup = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const i of eligible) m.set(i.suggestion!.setup, (m.get(i.suggestion!.setup) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [eligible]);

  const run = async () => {
    const ids = eligible.map((i) => i.tradeId);
    let accepted = 0;
    let skipped = 0;
    try {
      for (let i = 0; i < ids.length; i += BULK_CHUNK) {
        const r = await bulk.mutateAsync({ tradeIds: ids.slice(i, i + BULK_CHUNK), minConfidence: min });
        accepted += r.accepted;
        skipped += Object.values(r.skipped).reduce((s, v) => s + v, 0);
      }
      toast({ title: tb("table.accepted", { trades: commonI18n.t("units.trades", { count: accepted }) }), description: skipped ? tb("table.skipped", { count: skipped }) : tb("table.written") });
    } catch (e) {
      toast({ title: tb("table.bulkFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    }
  };

  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground">{tb("table.minConfidence")}</span>
      <Select value={String(min)} onValueChange={(v) => setMin(Number(v))}>
        <SelectTrigger className="h-8 w-20" aria-label={tb("table.minAria")}><SelectValue /></SelectTrigger>
        <SelectContent>
          {THRESHOLDS.map((t) => <SelectItem key={t} value={String(t)}>{Math.round(t * 100)}%</SelectItem>)}
        </SelectContent>
      </Select>
      <Button size="sm" variant="outline" disabled={!eligible.length || bulk.isPending} aria-busy={bulk.isPending} onClick={() => setConfirm(true)}>
        <CheckCheck className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
        {bulk.isPending ? tb("table.accepting") : tb("table.acceptN", { count: eligible.length })}
      </Button>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tb("table.confirmTitle", { trades: commonI18n.t("units.trades", { count: eligible.length }) })}</AlertDialogTitle>
            <AlertDialogDescription>
              {tb("table.confirmText", { pct: Math.round(min * 100), list: `${bySetup.slice(0, 6).map(([s, n]) => `${s} — ${n}`).join(", ")}${bySetup.length > 6 ? "…" : ""}` })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tb("table.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void run()}>{tb("table.accept")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const STATUS_LABEL = {
  get suggested() { return tb("table.status.suggested"); },
  get accepted() { return tb("table.status.accepted"); },
  get rejected() { return tb("table.status.rejected"); },
  get stale() { return tb("table.status.stale"); },
} as Record<SuggestionStatus, string>;
const STATUS_TONE: Record<SuggestionStatus, "neutral" | "up" | "down" | "warn" | "accent"> = { suggested: "accent", accepted: "up", rejected: "neutral", stale: "warn" };

const ACCESSORS = {
  date: (r: SetupItem) => `${r.date}#${String(r.tradeId).padStart(8, "0")}`,
  ticker: (r: SetupItem) => r.ticker,
  time: (r: SetupItem) => r.entryMin,
  hold: (r: SetupItem) => r.holdMin,
  net: (r: SetupItem) => r.net,
  setup: (r: SetupItem) => r.suggestion?.setup ?? null,
  confidence: (r: SetupItem) => r.suggestion?.confidence ?? null,
  status: (r: SetupItem) => r.suggestion?.status ?? null,
} as const;

function ConfidenceBar({ v }: { v: number }) {
  const tone = v >= 0.7 ? "hsl(var(--primary))" : v >= 0.45 ? "hsl(var(--primary) / 0.55)" : "hsl(var(--muted-foreground))";
  return (
    <span className="inline-flex items-center gap-2" title={tb("table.confidenceTitle", { pct: Math.round(v * 100) })}>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted/40" aria-hidden="true">
        <span className="block h-full rounded-full" style={{ width: `${Math.round(v * 100)}%`, background: tone }} />
      </span>
      <span className="tabular-nums text-xs">{Math.round(v * 100)}%</span>
    </span>
  );
}

export function SetupsTable({ items, canEdit }: { items: SetupItem[]; canEdit: boolean }) {
  const [filter, setFilter] = React.useState<"all" | "suggested" | "accepted" | "rejected" | "pending">("all");
  const [open, setOpen] = React.useState<Set<number>>(() => new Set());
  const accept = useAcceptSetup();
  const reject = useRejectSetup();
  const recompute = useRecomputeSetup();

  const filtered = React.useMemo(() => {
    if (filter === "all") return items;
    if (filter === "pending") return items.filter((i) => !i.suggestion || i.suggestion.status === "stale");
    return items.filter((i) => i.suggestion?.status === filter);
  }, [items, filter]);
  const { rows, thProps } = useTableSort(filtered, ACCESSORS, "date");

  const counts = React.useMemo(() => ({
    all: items.length,
    suggested: items.filter((i) => i.suggestion?.status === "suggested").length,
    accepted: items.filter((i) => i.suggestion?.status === "accepted").length,
    rejected: items.filter((i) => i.suggestion?.status === "rejected").length,
    pending: items.filter((i) => !i.suggestion || i.suggestion.status === "stale").length,
  }), [items]);

  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const doAccept = (r: SetupItem) => {
    if (!r.suggestion) return;
    accept.mutate({ tradeId: r.tradeId }, {
      onSuccess: () => toast({ title: tb("table.setupWritten", { setup: r.suggestion?.setup ?? "" }), description: `${r.ticker} · ${fmtDate(r.date, "dayMonthNumeric")}` }),
      onError: (e) => toast({ title: tb("table.writeFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" }),
    });
  };
  const doReject = (r: SetupItem) => {
    reject.mutate({ tradeId: r.tradeId }, {
      onError: (e) => toast({ title: tb("table.rejectFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" }),
    });
  };

  if (!items.length) {
    return <EmptyState icon={Sparkles} title={tb("table.empty")} description={tb("table.emptyHint")} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div className="flex flex-wrap gap-1" role="group" aria-label={tb("table.statusAria")}>
          {(["all", "suggested", "accepted", "rejected", "pending"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={filter === k}
              onClick={() => setFilter(k)}
              className={cn("rounded-full px-2.5 py-1 tabular-nums transition-colors", filter === k ? "bg-primary-solid text-primary-foreground" : "bg-muted/40 text-muted-foreground hover:text-foreground")}
            >
              {k === "all" ? tb("table.all") : k === "pending" ? tb("table.pending") : STATUS_LABEL[k]} · {counts[k]}
            </button>
          ))}
        </div>
        {canEdit && counts.suggested > 0 && (
          <div className="ml-auto">
            <BulkAccept items={items} />
          </div>
        )}
      </div>

      <DataTable maxHeight="64vh" ariaLabel={tb("table.aria")}>
        <table>
          <thead>
            <tr>
              <SortableTh {...thProps("date")}>{tb("table.col.date")}</SortableTh>
              <SortableTh {...thProps("ticker")}>{tb("table.col.ticker")}</SortableTh>
              <SortableTh {...thProps("time")}>{tb("table.col.entry")}</SortableTh>
              <SortableTh {...thProps("hold")}>{tb("table.col.hold")}</SortableTh>
              <SortableTh {...thProps("net")} align="right">{tb("table.col.net")}</SortableTh>
              <SortableTh {...thProps("setup")}>{tb("table.col.setup")}</SortableTh>
              <SortableTh {...thProps("confidence")}>{tb("table.col.confidence")}</SortableTh>
              <SortableTh {...thProps("status")}>{tb("table.col.status")}</SortableTh>
              <th scope="col" className="text-right">{tb("table.col.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = r.suggestion;
              const isOpen = open.has(r.tradeId);
              const busy = (accept.isPending && accept.variables?.tradeId === r.tradeId) || (reject.isPending && reject.variables?.tradeId === r.tradeId) || (recompute.isPending && recompute.variables?.tradeId === r.tradeId);
              return (
                <React.Fragment key={r.tradeId}>
                  <tr>
                    <td className="whitespace-nowrap">
                      <Link href={links.trade(r.tradeId)} className="underline-offset-2 hover:underline" aria-label={tb("table.openTrade", { ticker: r.ticker, date: fmtDate(r.date, "medium") })}>{fmtDate(r.date, "dayMonthNumeric")}</Link>
                    </td>
                    <td className="whitespace-nowrap font-medium">
                      {r.ticker} <span className="text-xs text-muted-foreground">{r.side === "short" ? "S" : r.side === "long" ? "L" : ""}</span>
                    </td>
                    <td className="tabular-nums">{fmtClock(r.entryMin)}</td>
                    <td className="whitespace-nowrap tabular-nums">{fmtMinutes(r.holdMin)}</td>
                    <td className={cn("text-right tabular-nums", toneText(toneOf(r.net)))}>{fmtUsd(r.net, { signed: true, compact: true })}</td>
                    <td>
                      {s ? (
                        <button type="button" onClick={() => toggle(r.tradeId)} aria-expanded={isOpen} className="inline-flex items-center gap-1 text-left hover:text-foreground">
                          {isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                          <span className="font-medium">{s.setup}</span>
                          {!s.candlesAvailable && <Pill tone="warn" title={tb("table.noCandlesTitle")}>{tb("table.noCandles")}</Pill>}
                        </button>
                      ) : (
                        <span className="text-muted-foreground">{tb("table.notComputed")}</span>
                      )}
                      {r.currentSetup && <div className="text-xs text-muted-foreground">{tb("table.inTrade", { setup: r.currentSetup })}</div>}
                    </td>
                    <td>{s ? <ConfidenceBar v={s.confidence} /> : "—"}</td>
                    <td>{s ? <Pill tone={STATUS_TONE[s.status]} dot>{STATUS_LABEL[s.status]}</Pill> : <Pill tone="neutral">{tb("table.queue")}</Pill>}</td>
                    <td className="whitespace-nowrap text-right">
                      {canEdit && s && s.status !== "accepted" && s.status !== "stale" && (
                        <div className="inline-flex gap-1">
                          <Button size="sm" variant="default" className="h-7 px-2" disabled={busy} onClick={() => doAccept(r)} aria-label={tb("table.acceptAria", { setup: s.setup, ticker: r.ticker })}>
                            <Check className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> {tb("table.accept")}
                          </Button>
                          {s.status !== "rejected" && (
                            <Button size="sm" variant="ghost" className="h-7 px-2" disabled={busy} onClick={() => doReject(r)} aria-label={tb("table.rejectAria", { ticker: r.ticker })}>
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                            </Button>
                          )}
                        </div>
                      )}
                      {canEdit && s && s.status === "stale" && (
                        <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy} onClick={() => recompute.mutate({ tradeId: r.tradeId })} aria-label={tb("table.recomputeAria", { ticker: r.ticker })}>
                          <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> {tb("table.recompute")}
                        </Button>
                      )}
                    </td>
                  </tr>
                  {s && isOpen && (
                    <tr>
                      <td colSpan={9} className="bg-muted/10 text-xs">
                        <div className="flex flex-col gap-1.5 py-1">
                          <ul className="list-disc pl-5 text-muted-foreground" aria-label={tb("table.featuresAria")}>
                            {s.reasons.map((x, i) => <li key={i}>{x}</li>)}
                          </ul>
                          {s.note && <p className="text-down">{s.note}</p>}
                          <div className="flex flex-wrap items-center gap-1.5">
                            {s.alternatives.length > 0 && <span className="text-muted-foreground">{tb("table.alternatives")}</span>}
                            {s.alternatives.map((a) => (
                              canEdit && s.status !== "accepted"
                                ? <Button key={a.setup} size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={busy} onClick={() => accept.mutate({ tradeId: r.tradeId, setup: a.setup })} aria-label={tb("table.acceptAltAria", { setup: a.setup })}>{a.setup} · {Math.round(a.score * 100)}%</Button>
                                : <Pill key={a.setup} tone="neutral">{a.setup} · {Math.round(a.score * 100)}%</Pill>
                            ))}
                            {s.tags.map((t) => <Pill key={t} tone="accent">{t}</Pill>)}
                            <span className="ml-auto text-muted-foreground">
                              {tb("table.bars", { interval: s.interval ?? "—", version: s.version })}
                              {s.decidedBy && ` · ${STATUS_LABEL[s.status]} ${s.decidedBy}`}
                            </span>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </DataTable>
      <p className="text-xs text-muted-foreground">
        {tb("table.footnote", { trades: commonI18n.t("units.trades", { count: filtered.length }) })}

      </p>
    </div>
  );
}
