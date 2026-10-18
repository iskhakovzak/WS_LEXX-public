import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Plus, Trash2 } from "lucide-react";
import { Pill, toneOf, toneText, type Tone } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { invalidateTradeDependents } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { ET_SESSION_LABEL, etWallToIso, fmtDuration, fmtEtTimeSec, sessionOfEt } from "@/components/trade-chart-parts/chart-utils";
import { ROLE_LABEL, roleOf } from "@/components/chart-engine/lib/structure";
import type { StructureLeg, TradeRole, TradeStructureDto } from "@/components/chart-engine/types";
import { fmtCount, fmtPrice, fmtR, fmtUsd } from "@/lib/format";
import { tradesI18n } from "@/i18n/ns/trades";
import { commonI18n } from "@/i18n/ns/common";

type Execution = {
  id: number; tradeId: number; kind: Kind; price: string; qty: string | null; executedAt: string | null; note: string | null; sortOrder: number;
  /** Recognised role in the trade's structure (Вход / Добор / Частичный фикс / Перезаход / Переворот / Выход / Стоп). */
  role?: TradeRole | null; roleInferred?: boolean; legIndex?: number | null;
};
type Kind = "entry" | "add" | "trim" | "exit" | "stop";

const kind = (value: Kind, tone: Tone) => ({ value, tone, get label() { return tradesI18n.t(`exec.kind.${value}`); } });
/** Labels are read in the current language on access. */
const KINDS: { value: Kind; label: string; tone: Tone }[] = [
  kind("entry", "accent"),
  kind("add", "accent"),
  kind("trim", "warn"),
  kind("exit", "up"),
  kind("stop", "down"),
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.value, k])) as Record<Kind, (typeof KINDS)[number]>;
const isOpening = (k: Kind) => k === "entry" || k === "add";

const ROLE_TONE: Record<TradeRole, Tone> = { entry: "accent", reentry: "accent", flip: "warn", add: "accent", partial_exit: "warn", exit: "up", stop: "down" };


/** PropReports fills carry their commissions in the note («PropReports S · fees 0.84»); there is no fees column yet. */
export function feesFromNote(note: string | null | undefined): number | null {
  if (!note) return null;
  const m = /\bfees?\s*[:=]?\s*\$?(-?\d+(?:[.,]\d+)?)/i.exec(note);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) ? Math.abs(n) : null;
}

const epoch = (iso: string | null): number | null => {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

type Props = {
  tradeId: number;
  tradeDate: string;
  side?: string | null;
  canEdit: boolean;
  /** Trade-level totals (PropReports): used when the fills themselves carry no fees / quantity. */
  fees?: number | null;
  qty?: number | null;
  pnl?: number | null;
  /** Open another trade of the session (re-entry chain links). */
  onOpenTradeId?: (id: number) => void;
};

/**
 * Fills/partials for a trade. Shares the ["trade-executions", id] query key with TradeChart,
 * so markers on the chart update as soon as an execution is added or removed.
 */
export function ExecutionsPanel({ tradeId, tradeDate, side, canEdit, fees, qty: tradeQty, pnl: tradePnl, onOpenTradeId }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = tradesI18n.useT();
  const key = ["trade-executions", tradeId];
  const q = useQuery<{ tradeId: number; executions: Execution[]; structure?: TradeStructureDto | null }>({
    queryKey: key,
    queryFn: ({ signal }) => http.get<{ tradeId: number; executions: Execution[]; structure?: TradeStructureDto | null }>(`/api/trades/${tradeId}/executions`, { signal }),
    staleTime: STALE.short,
  });
  const [kind, setKind] = React.useState<Kind>("entry");
  const [price, setPrice] = React.useState("");
  const [qty, setQty] = React.useState("");
  const [time, setTime] = React.useState("");
  const [note, setNote] = React.useState("");

  const add = useMutation({
    mutationFn: () => {
      // Time is typed in New York wall clock (the trading day), never the browser's zone.
      const executedAt = time ? etWallToIso(tradeDate.substring(0, 10), time) : null;
      return http.post(`/api/trades/${tradeId}/executions`, { kind, price: Number(price), qty: qty ? Number(qty) : null, executedAt, note: note.trim() || null, sortOrder: (q.data?.executions.length ?? 0) + 1 });
    },
    onSuccess: () => {
      // Executions feed the replay markers and the execution-quality cache → invalidate dependents too.
      void invalidateTradeDependents(qc, { tradeId });
      setPrice(""); setQty(""); setNote("");
      setKind((k) => (k === "entry" ? "exit" : k));
    },
    onError: (e: Error) => toast({ title: tradesI18n.t("exec.addFailed"), description: e.message, variant: "destructive" }),
  });
  const del = useMutation({
    mutationFn: (id: number) => http.del(`/api/trades/${tradeId}/executions/${id}`),
    onSuccess: () => { void invalidateTradeDependents(qc, { tradeId }); },
    onError: (e: Error) => toast({ title: tradesI18n.t("exec.deleteFailed"), description: e.message, variant: "destructive" }),
  });

  const list = React.useMemo(() => {
    const rows = q.data?.executions ?? [];
    // Chronological when every fill is timed (sortOrder can lag a late-logged stop), else the logged order.
    const allTimed = rows.length > 0 && rows.every((e) => epoch(e.executedAt) != null);
    return allTimed ? [...rows].sort((a, b) => (epoch(a.executedAt) as number) - (epoch(b.executedAt) as number) || a.sortOrder - b.sortOrder) : rows;
  }, [q.data]);
  const dir = (side ?? "").trim().toLowerCase().startsWith("s") ? -1 : 1;
  const structure = q.data?.structure ?? null;
  const legByIndex = React.useMemo(() => new Map<number, StructureLeg>((structure?.legs ?? []).map((l) => [l.index, l])), [structure]);
  // A leg spans the pieces of one order: its numbers are shown once, on its last piece.
  const lastOfLeg = React.useMemo(() => {
    const m = new Map<number, number>();
    for (const e of list) if (e.legIndex != null) m.set(e.legIndex, e.id);
    return m;
  }, [list]);

  // Average entry / exit, realised P&L, fees and hold time from the fills.
  const summary = React.useMemo(() => {
    let inQty = 0, inVal = 0, outQty = 0, outVal = 0, feesFromFills = 0, feeRows = 0;
    let firstIn: number | null = null, lastOut: number | null = null;
    for (const e of list) {
      const p = Number(e.price), n = e.qty ? Number(e.qty) : 0;
      const f = feesFromNote(e.note);
      if (f != null) { feesFromFills += f; feeRows++; }
      const at = epoch(e.executedAt);
      if (isOpening(e.kind)) { if (at != null) firstIn = firstIn == null ? at : Math.min(firstIn, at); }
      else if (at != null) lastOut = lastOut == null ? at : Math.max(lastOut, at);
      if (!n) continue;
      if (isOpening(e.kind)) { inQty += n; inVal += p * n; }
      else { outQty += n; outVal += p * n; }
    }
    const avgIn = inQty ? inVal / inQty : null;
    const avgOut = outQty ? outVal / outQty : null;
    const closedQty = Math.min(inQty, outQty);
    const perShare = avgIn != null && avgOut != null ? (avgOut - avgIn) * dir : null;
    const realised = perShare != null && closedQty ? perShare * closedQty : null;
    const totalFees = feeRows ? feesFromFills : fees != null ? Math.abs(fees) : null;
    const net = realised != null && totalFees != null ? realised - totalFees : null;
    const sharesForFees = closedQty || tradeQty || null;
    const feesPerShare = totalFees != null && sharesForFees ? totalFees / sharesForFees : null;
    const holdSeconds = firstIn != null && lastOut != null && lastOut >= firstIn ? lastOut - firstIn : null;
    return { inQty, outQty, avgIn, avgOut, perShare, realised, totalFees, feesSource: feeRows ? "fills" as const : fees != null ? "trade" as const : null, net, feesPerShare, holdSeconds, firstIn, lastOut };
  }, [list, dir, fees, tradeQty]);

  const priceOk = Number(price) > 0;

  return (
    <div className="space-y-3">
      {q.isLoading ? (
        <div className="space-y-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-10 rounded-xl" />)}</div>
      ) : q.isError ? (
        <p className="text-sm text-down">{t("exec.loadFailed")}</p>
      ) : list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
          {t("exec.empty")}
        </p>
      ) : (
        <>
          {structure && <StructureHeader structure={structure} tradeId={tradeId} onOpenTradeId={onOpenTradeId} />}
          <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
            {list.map((e) => {
              const at = epoch(e.executedAt);
              const session = at != null ? sessionOfEt(at) : null;
              const fee = feesFromNote(e.note);
              const n = e.qty ? Number(e.qty) : null;
              const p = Number(e.price);
              // Per-share result of a closing fill against the average entry known so far.
              const role = roleOf(e);
              const leg = e.legIndex != null ? legByIndex.get(e.legIndex) ?? null : null;
              const legEnd = leg != null && lastOfLeg.get(leg.index) === e.id;
              // Per-share result of a closing fill: the leg's (vs the average at that moment), else vs the overall average entry.
              const closePs = leg ? (legEnd && !leg.opening ? leg.perShare : null) : !isOpening(e.kind) && summary.avgIn != null ? (p - summary.avgIn) * dir : null;
              return (
                <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                  <span title={leg?.reason ?? (e.roleInferred ? t("exec.inferred") : undefined)}>
                    <Pill tone={ROLE_TONE[role] ?? KIND[e.kind]?.tone ?? "neutral"} className="w-[128px] justify-center">
                      {ROLE_LABEL[role] ?? KIND[e.kind]?.label ?? e.kind}{e.roleInferred ? "?" : ""}
                    </Pill>
                  </span>
                  <span className="font-medium tabular-nums">{fmtPrice(p)}</span>
                  <span className="tabular-nums text-muted-foreground">{n ? `× ${n}` : ""}</span>
                  <span className="tabular-nums text-muted-foreground" title={at != null ? `${new Date(at * 1000).toISOString()} · ${session ? ET_SESSION_LABEL[session] : ""}` : t("exec.noTimeTitle")}>
                    {at != null ? `${fmtEtTimeSec(at)} ET` : t("exec.noTime")}
                  </span>
                  {session && session !== "regular" && <Pill tone={session === "premarket" ? "accent" : "warn"} className="px-1.5 text-2xs">{ET_SESSION_LABEL[session]}</Pill>}
                  {closePs != null && (
                    <span className={cn("tabular-nums text-xs", toneText(toneOf(closePs)))} title={t("exec.perShareTitle")}>
                      {t("exec.perShare", { amount: fmtUsd(closePs, { signed: true }) })}{leg ? (leg.realized != null ? ` · ${fmtUsd(leg.realized, { signed: true, decimals: "auto" })}` : "") : n ? ` · ${fmtUsd(closePs * n, { signed: true, decimals: "auto" })}` : ""}
                    </span>
                  )}
                  {legEnd && leg?.r != null && !leg.opening && <span className={cn("tabular-nums text-xs font-medium", toneText(toneOf(leg.r)))}>{fmtR(leg.r)}</span>}
                  {legEnd && leg && leg.pieces > 1 && <span className="text-xs text-muted-foreground" title={t("exec.piecesTitle")}>{t("exec.pieces", { count: leg.pieces })}</span>}
                  {legEnd && leg?.positionAfter != null && (
                    <span className="tabular-nums text-xs text-muted-foreground" title={t("exec.positionAfterTitle")}>
                      {leg.positionAfter > 0
                        ? leg.opening && leg.avgAfter != null
                          ? t("exec.positionAfterAvg", { qty: fmtCount(leg.positionAfter), avg: fmtPrice(leg.avgAfter) })
                          : t("exec.positionAfter", { qty: fmtCount(leg.positionAfter) })
                        : t("exec.positionClosed")}
                    </span>
                  )}
                  {fee != null && <span className="tabular-nums text-xs text-muted-foreground" title={t("exec.feeTitle")}>{t("exec.fee", { amount: fmtUsd(-fee, { signed: true, decimals: "auto" }) })}</span>}
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={e.note ?? undefined}>{e.note}</span>
                  {canEdit && (
                    <button
                      type="button"
                      aria-label={t("exec.delete")}
                      title={t("exec.delete")}
                      disabled={del.isPending}
                      onClick={() => del.mutate(e.id)}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-down"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {(summary.avgIn != null || summary.avgOut != null) && (
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div className="rounded-xl bg-[var(--glass-bg)] p-2.5"><p className="text-xs text-muted-foreground">{t("exec.avgEntry")}</p><p className="font-semibold tabular-nums">{fmtPrice(summary.avgIn)} <span className="text-xs font-normal text-muted-foreground">× {summary.inQty}</span></p></div>
              <div className="rounded-xl bg-[var(--glass-bg)] p-2.5"><p className="text-xs text-muted-foreground">{t("exec.avgExit")}</p><p className="font-semibold tabular-nums">{fmtPrice(summary.avgOut)} <span className="text-xs font-normal text-muted-foreground">× {summary.outQty}</span></p></div>
              <div className="rounded-xl bg-[var(--glass-bg)] p-2.5" title={tradePnl != null && summary.realised != null && Math.abs(tradePnl - summary.realised) >= 0.01 ? t("exec.tradeCardPnl", { amount: fmtUsd(tradePnl, { signed: true, decimals: "auto" }) }) : undefined}>
                <p className="text-xs text-muted-foreground">{t("exec.realised")}</p>
                <p className={cn("font-semibold tabular-nums", toneText(toneOf(summary.realised)))}>{fmtUsd(summary.realised, { signed: true, decimals: "auto" })}</p>
                {summary.perShare != null && <p className="text-2xs tabular-nums text-muted-foreground">{t("exec.perShareLine", { amount: fmtUsd(summary.perShare, { signed: true }) })}</p>}
              </div>
              <div className="rounded-xl bg-[var(--glass-bg)] p-2.5" title={summary.feesSource === "fills" ? t("exec.feesFromFills") : summary.feesSource === "trade" ? t("exec.feesFromTrade") : undefined}>
                <p className="text-xs text-muted-foreground">{summary.totalFees != null ? t("exec.netAfterFees") : commonI18n.t("trading.holdTime")}</p>
                {summary.totalFees != null ? (
                  <>
                    <p className={cn("font-semibold tabular-nums", toneText(toneOf(summary.net)))}>{fmtUsd(summary.net, { signed: true, decimals: "auto" })}</p>
                    <p className="text-2xs tabular-nums text-muted-foreground">{t("exec.feesLine", { amount: fmtUsd(-summary.totalFees, { signed: true, decimals: "auto" }) })}{summary.feesPerShare != null ? ` · ${t("exec.feesPerShare", { amount: fmtUsd(summary.feesPerShare, { decimals: 3 }) })}` : ""}</p>
                  </>
                ) : (
                  <p className="font-semibold tabular-nums">{fmtDuration(summary.holdSeconds)}</p>
                )}
              </div>
            </div>
          )}
          {summary.firstIn != null && (
            <p className="text-xs text-muted-foreground">
              {fmtEtTimeSec(summary.firstIn)}{summary.lastOut != null ? ` → ${fmtEtTimeSec(summary.lastOut)}` : ""} ET
              {` · ${summary.holdSeconds != null ? t("exec.inPositionFor", { duration: fmtDuration(summary.holdSeconds) }) : t("exec.positionOpen")}`}
              {(() => { const a = sessionOfEt(summary.firstIn), b = summary.lastOut != null ? sessionOfEt(summary.lastOut) : null; if (!a) return null; return b && b !== a ? ` · ${ET_SESSION_LABEL[a]} → ${ET_SESSION_LABEL[b]}` : a !== "regular" ? ` · ${ET_SESSION_LABEL[a]}` : null; })()}
            </p>
          )}
        </>
      )}

      {canEdit && (
        <form
          className="grid grid-cols-2 gap-2 rounded-xl border border-border/70 p-3 sm:grid-cols-[150px_1fr_1fr_130px]"
          onSubmit={(e) => { e.preventDefault(); if (priceOk && !add.isPending) add.mutate(); }}
        >
          <div className="space-y-1">
            <Label htmlFor={`ex-kind-${tradeId}`} className="text-xs text-muted-foreground">{t("exec.form.type")}</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
              <SelectTrigger id={`ex-kind-${tradeId}`} className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{KINDS.map((k) => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`ex-price-${tradeId}`} className="text-xs text-muted-foreground">{t("exec.form.price")}</Label>
            <Input id={`ex-price-${tradeId}`} type="number" step="any" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} className="h-9 tabular-nums" />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`ex-qty-${tradeId}`} className="text-xs text-muted-foreground">{t("exec.form.qty")}</Label>
            <Input id={`ex-qty-${tradeId}`} type="number" step="any" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} className="h-9 tabular-nums" />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`ex-time-${tradeId}`} className="text-xs text-muted-foreground">{t("exec.form.time")}</Label>
            <Input id={`ex-time-${tradeId}`} type="time" step={1} value={time} onChange={(e) => setTime(e.target.value)} className="h-9 px-3" />
          </div>
          <div className="col-span-2 space-y-1 sm:col-span-3">
            <Label htmlFor={`ex-note-${tradeId}`} className="text-xs text-muted-foreground">{t("exec.form.note")}</Label>
            <Input id={`ex-note-${tradeId}`} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("exec.form.notePlaceholder")} className="h-9" />
          </div>
          <div className="col-span-2 flex items-end sm:col-span-1">
            <Button type="submit" variant="outline" disabled={!priceOk || add.isPending} className="h-9 w-full gap-1.5">
              <Plus className="h-3.5 w-3.5" /> {commonI18n.t("actions.add")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/** «Вход частями · перезаход №1» chips, notes about the data, and links to the other trades of the session on this ticker. */
function StructureHeader({ structure, tradeId, onOpenTradeId }: { structure: TradeStructureDto; tradeId: number; onOpenTradeId?: (id: number) => void }) {
  const { t } = tradesI18n.useT();
  const { t: tc } = commonI18n.useT();
  const st = structure.stats;
  const sibs = structure.siblings ?? [];
  const idx = sibs.findIndex((x) => x.id === tradeId);
  const chips: { text: string; tone: Tone; title?: string }[] = [];
  if (st.flipIn) chips.push({ text: t("exec.structure.flip"), tone: "warn", title: t("exec.structure.flipTitle") });
  else if (st.reentryIndex > 0) chips.push({ text: t("exec.structure.reentry", { n: st.reentryIndex }), tone: "accent" });
  if (st.adds > 0) chips.push({ text: t("exec.structure.adds", { count: st.adds }), tone: "accent" });
  if (st.partials > 0) chips.push({ text: t("exec.structure.partials", { count: st.partials }), tone: "warn" });
  if (st.stopHit) chips.push({ text: st.stopInferred ? t("exec.structure.stopInferred") : tc("trading.stop"), tone: "down", title: st.stopReason ?? undefined });
  if (st.scaledEntryLikely) chips.push({ text: t("exec.structure.scaledEntry"), tone: "neutral", title: t("exec.structure.scaledEntryTitle") });
  if (st.scaledExitLikely) chips.push({ text: t("exec.structure.scaledExit"), tone: "neutral", title: t("exec.structure.scaledExitTitle") });
  if (st.flipOut) chips.push({ text: t("exec.structure.flipOut"), tone: "warn" });
  if (st.carriedIn) chips.push({ text: t("exec.structure.carriedIn"), tone: "neutral" });
  const chain = sibs.length > 1 && idx >= 0;
  if (!chips.length && !chain && !st.notes?.length) return null;
  return (
    <div className="space-y-2 rounded-xl border border-border/70 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="micro-label mr-1">{t("exec.structure.title")}</span>
        {chips.map((c) => <span key={c.text} title={c.title}><Pill tone={c.tone}>{c.text}</Pill></span>)}
        {!chips.length && <span className="text-xs text-muted-foreground">{t("exec.structure.plain")}</span>}
        {st.rTotal != null && <span className={cn("ml-auto text-sm font-semibold tabular-nums", toneText(toneOf(st.rTotal)))}>{fmtR(st.rTotal)}</span>}
      </div>
      {chain && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="mr-0.5">{t("exec.structure.siblings")}</span>
          {sibs.map((x, i) => (
            <button
              key={x.id}
              type="button"
              disabled={x.id === tradeId || !onOpenTradeId}
              onClick={() => onOpenTradeId?.(x.id)}
              title={x.summary || undefined}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 tabular-nums",
                x.id === tradeId ? "border-primary/60 bg-primary/10 text-foreground" : "border-border/70 hover:bg-[var(--glass-hover-bg)] disabled:hover:bg-transparent",
              )}
            >
              {i < idx && <ArrowLeft className="h-3 w-3" aria-hidden />}
              {t("exec.structure.sibling", { n: i + 1, side: tc(x.side === "short" ? "trading.short" : "trading.long").toLowerCase() })}{x.legs[0] ? ` ${fmtPrice(x.legs[0].price)}` : ""}
              {i > idx && <ArrowRight className="h-3 w-3" aria-hidden />}
            </button>
          ))}
        </div>
      )}
      {st.notes?.length ? <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">{st.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
    </div>
  );
}
