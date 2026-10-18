/**
 * «В плейбук» — quick add of one or several trades as examples of a setup.
 * Used by the trade sheet / trades list (row + bulk bar) / journal day / playbook inbox via AddToPlaybookButton
 * (components/add-to-playbook.tsx) and AddTradesToPlaybookDialog below.
 *
 *   setup  — searchable list: «Подходят по сделке» → «Недавние» → «Мой плейбук» → «Плейбук офиса» → «Общие»
 *   tier   — Tier 1 эталон (показательная) / Tier 2 хорошая / Tier 3 на разбор (учебная ошибка), hint under each
 *   note   — optional; screenshot — optional (paste Ctrl+V or pick a file; single trade only)
 * Saves instantly; the toast offers «Отменить» (deletes what was created, restores what was updated).
 * Keys: ↑/↓ setup, Enter / Ctrl+Enter save, Alt+1…3 tier. Data: GET /playbook-tools/for-trade/:id, POST /playbook/:id/examples.
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { BookOpen, ImagePlus, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Kbd } from "@/components/ui/kbd";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToastAction } from "@/components/ui/toast";
import { toneText } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { invalidateExamples, invalidateTradeLinks, notLiveMessage } from "./api";
import { http, ApiError } from "@/lib/api/http";
import { imageFilesFrom, uploadPlaybookImage } from "./media";
import { TIERS, moneyTone, tierMeta, type Tier } from "./model";
import { fmtDate, fmtR, fmtUsd } from "@/lib/format";
import { buildQuickRows, defaultTier, undoSteps, type AddResponse, type QuickSetup } from "./quick-add-logic";
import { commonI18n } from "@/i18n/ns/common";
import { playbookDialogsI18n } from "@/i18n/ns/playbookDialogs";

import { personName } from "@/i18n";
const dt = playbookDialogsI18n.t; // called at render / call time only

type ForTrade = {
  trade: {
    id: number; ticker: string; date: string | null; trader: string | null; setup: string | null; playbookId: number | null;
    netPnl: number | null; signedR?: number | null; result?: string | null; side?: string | null; autoSetup?: string | null; redacted?: boolean;
  } | null;
  setups: QuickSetup[];
  recent: number[];
  suggested: { id: number; reason: string }[];
  examples: { id: number; playbookId: number; tier: Tier; note: string | null }[];
};

export function spaceShort(s: Pick<QuickSetup, "space" | "mine" | "owner">) {
  if (s.space === "office") return dt("quick.spaceOffice");
  if (s.mine) return dt("quick.spaceMine");
  return s.owner ? personName(s.owner) : dt("quick.spaceShared");
}

/** Revert one save (see undoSteps). Errors surface as a toast by the caller. */
async function runUndo(setupId: number, r: AddResponse) {
  for (const st of undoSteps(r)) {
    if (st.kind === "delete") {
      await http.del(`/api/playbook/${setupId}/examples/${st.exampleId}${st.unlink ? "?unlink=1" : ""}`);
    } else {
      await http.patch(`/api/playbook/${setupId}/examples/${st.exampleId}`, { tier: st.tier, note: st.note });
    }
  }
}

export function TradeQuickAdd({
  tradeIds, onClose, onNewSetup, presetSetupId, className, inDialog,
}: {
  tradeIds: number[];
  onClose: () => void;
  /** «Новый сетап из сделки» (single trade). Also called when the API is too old for quick add. */
  onNewSetup?: () => void;
  /** Preselect this setup (e.g. the inbox suggestion). */
  presetSetupId?: number | null;
  className?: string;
  /** Leave room for the dialog's close button in the header. */
  inDialog?: boolean;
}) {
  const { t: tr } = playbookDialogsI18n.useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const fid = React.useId();
  const single = tradeIds.length === 1;
  const firstId = tradeIds[0];
  const q = useQuery<ForTrade>({
    queryKey: ["playbook-for-trade", firstId],
    queryFn: () => http.get<ForTrade>(`/api/playbook-tools/for-trade/${firstId}`),
    staleTime: 15_000,
    enabled: Number.isSafeInteger(firstId) && firstId > 0,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 1,
  });
  const notLive = q.isError && !!notLiveMessage(q.error);
  React.useEffect(() => { if (notLive && onNewSetup) onNewSetup(); }, [notLive]); // eslint-disable-line react-hooks/exhaustive-deps

  const [search, setSearch] = React.useState("");
  const [picked, setPicked] = React.useState<number | null>(presetSetupId ?? null);
  const [tier, setTier] = React.useState<Tier>(1);
  const [tierTouched, setTierTouched] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [shot, setShot] = React.useState<File | null>(null);
  const [shotUrl, setShotUrl] = React.useState<string | null>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { const t = window.setTimeout(() => searchRef.current?.focus(), 30); return () => window.clearTimeout(t); }, []);
  React.useEffect(() => {
    if (!shot) { setShotUrl(null); return; }
    const u = URL.createObjectURL(shot);
    setShotUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [shot]);

  const data = q.data;
  const byId = React.useMemo(() => new Map((data?.setups ?? []).map((s) => [s.id, s])), [data]);
  const existing = React.useMemo(() => (single ? new Map((data?.examples ?? []).map((e) => [e.playbookId, e])) : new Map<number, ForTrade["examples"][number]>()), [data, single]);
  const reasons = React.useMemo(() => new Map((single ? data?.suggested ?? [] : []).map((s) => [s.id, s.reason])), [data, single]);
  const rows = React.useMemo(
    () => (data ? buildQuickRows({ setups: data.setups, suggested: single ? data.suggested : [], recent: data.recent, search }) : []),
    [data, search, single],
  );
  const writableCount = React.useMemo(() => (data?.setups ?? []).filter((s) => s.canAddExamples).length, [data]);

  // Preselect the best guess so the common case is one click on «Добавить».
  React.useEffect(() => {
    if (!rows.length) return;
    if (picked == null || !rows.some((r) => r.s.id === picked)) {
      if (presetSetupId && byId.get(presetSetupId)?.canAddExamples && !search) setPicked(presetSetupId);
      else setPicked(rows[0].s.id);
    }
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tier / note follow an existing example in the picked setup; otherwise a hint from the outcome until touched.
  React.useEffect(() => {
    const ex = picked != null ? existing.get(picked) : undefined;
    if (ex) { setTier(ex.tier); setNote(ex.note ?? ""); return; }
    if (!tierTouched) setTier(single ? defaultTier(data?.trade ?? null) : 1);
  }, [picked, existing, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const target = picked != null ? byId.get(picked) ?? null : null;
  const already = picked != null ? existing.get(picked) : undefined;

  const add = useMutation({
    mutationFn: async (setupId: number) => {
      const r = await http.post<AddResponse & { examples: { id: number; tradeId: number }[] }>(`/api/playbook/${setupId}/examples`, { tradeIds, tier, note: note.trim() || null });
      let shotError: string | null = null;
      if (shot && r.examples?.length === 1) {
        try {
          const m = await uploadPlaybookImage(shot, setupId);
          await http.patch(`/api/playbook/${setupId}/examples/${r.examples[0].id}`, { mediaId: m.id });
        } catch (e) {
          shotError = (e as Error)?.message ?? dt("quick.error");
        }
      }
      return { r, shotError };
    },
    onSuccess: ({ r, shotError }, setupId) => {
      const n = r.examples?.length ?? 0;
      if (!n) {
        toast({ title: dt("quick.addFailed"), description: r.skipped?.[0]?.reason === "forbidden" ? dt("quick.noAccess") : undefined, variant: "destructive" });
        return;
      }
      const s = byId.get(setupId);
      const refresh = () => {
        invalidateExamples(qc, setupId);
        invalidateTradeLinks(qc);
        qc.invalidateQueries({ queryKey: ["playbook"] });
      };
      refresh();
      const canUndo = undoSteps(r).length > 0;
      const updatedOnly = (r.created?.length ?? 1) === 0;
      const tm = tierMeta(tier);
      const setupName = s?.name ?? dt("quick.setupFallback");
      toast({
        title: updatedOnly
          ? dt("quick.updatedIn", { name: setupName, tier: tm.label })
          : single
            ? dt("quick.addedOne", { name: setupName, tier: tm.short })
            : dt("quick.addedMany", { trades: commonI18n.t("units.trades", { count: n }), name: setupName, tier: tm.short }),
        description: (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{s?.space === "office" ? dt("quick.group.office") : s?.mine ? dt("quick.group.mine") : spaceShort(s ?? { space: "personal", mine: false, owner: null })}</span>
            {r.skipped?.length ? <span>{dt("quick.skipped", { count: r.skipped.length })}</span> : null}
            {shotError ? <span className="text-down">{dt("quick.shotNotSaved", { error: shotError })}</span> : null}
            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => navigate(`/playbook?id=${setupId}&tab=examples`)}>
              {dt("quick.openSetup")}
            </button>
          </span>
        ),
        action: canUndo ? (
          <ToastAction
            altText={dt("quick.undoAlt")}
            onClick={() => {
              runUndo(setupId, r)
                .then(() => { refresh(); toast({ title: dt("quick.undone") }); })
                .catch((e) => toast({ title: dt("quick.undoFailed"), description: (e as Error)?.message, variant: "destructive" }));
            }}
          >
            {commonI18n.t("actions.undo")}
          </ToastAction>
        ) : undefined,
      });
      onClose();
    },
    onError: (e) => toast({ title: dt("quick.addFailed"), description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });
  const canAdd = picked != null && !!target?.canAddExamples && !add.isPending;
  const submit = (id: number | null = picked) => { if (id != null && byId.get(id)?.canAddExamples && !add.isPending) add.mutate(id); };

  const move = (delta: 1 | -1) => {
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.s.id === picked);
    const next = rows[Math.max(0, Math.min(rows.length - 1, (i < 0 ? -1 : i) + delta))];
    setPicked(next.s.id);
    listRef.current?.querySelector(`[data-pick="${next.s.id}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (!single) return;
    const f = imageFilesFrom(e.clipboardData)[0];
    if (f) { e.preventDefault(); setShot(f); }
  };

  const t = data?.trade;
  const net = t && !t.redacted ? t.netPnl : null;

  if (q.isLoading || notLive) {
    return (
      <div className={cn("flex min-h-[420px] flex-col gap-2 p-[var(--panel-p)]", className)} aria-busy="true">
        <div className="h-5 w-2/3 animate-pulse rounded bg-[var(--glass-bg)] motion-reduce:animate-none" />
        <div className="h-9 animate-pulse rounded-xl bg-[var(--glass-bg)] motion-reduce:animate-none" />
        {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-11 animate-pulse rounded-xl bg-[var(--glass-bg)] motion-reduce:animate-none" />)}
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className={cn("flex flex-col gap-3 p-[var(--panel-p)]", className)}>
        <p className="text-sm text-down">{(q.error as Error)?.message ?? tr("quick.loadFailed")}</p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => q.refetch()}>{commonI18n.t("actions.retry")}</Button>
          {onNewSetup && <Button size="sm" variant="ghost" onClick={onNewSetup}>{tr("quick.newFromTrade")}</Button>}
        </div>
      </div>
    );
  }

  let lastGroup = "";
  const tierHint = tierMeta(tier).hint;
  return (
    <div
      className={cn("flex min-h-0 flex-col", className)}
      onPaste={onPaste}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
        if (e.altKey && ["1", "2", "3"].includes(e.key)) { e.preventDefault(); setTier(Number(e.key) as Tier); setTierTouched(true); }
      }}
    >
      <div className={cn("flex items-center gap-2 border-b border-border/60 px-[var(--panel-p)] py-3", inDialog && "pr-12")}>
        <BookOpen className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {single
            ? (t ? tr("quick.titleTrade", { trade: `${t.ticker}${t.date ? ` · ${fmtDate(t.date, "dayMonthNumeric")}` : ""}` }) : tr("quick.title"))
            : tr("quick.titleTrade", { trade: commonI18n.t("units.trades", { count: tradeIds.length }) })}
        </span>
        {single && t?.signedR != null && <span className={cn("shrink-0 text-xs font-medium tabular-nums", toneText(moneyTone(t.signedR)))}>{fmtR(t.signedR)}</span>}
        {single && net != null && <span className={cn("shrink-0 text-sm font-semibold tabular-nums", toneText(moneyTone(net)))}>{fmtUsd(net, { signed: true, decimals: 0 })}</span>}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-[var(--panel-p)]">
        {existing.size > 0 && (
          <p className="text-xs text-muted-foreground">
            {tr("quick.alreadyIn")}{" "}
            {[...existing.values()].map((ex, i) => (
              <span key={ex.id}>
                {i > 0 && ", "}
                <button type="button" className="text-foreground underline-offset-2 hover:underline" onClick={() => { onClose(); navigate(`/playbook?id=${ex.playbookId}&tab=examples`); }}>
                  {byId.get(ex.playbookId)?.name ?? `#${ex.playbookId}`}
                </button>{" "}
                <span className="tabular-nums">T{ex.tier}</span>
              </span>
            ))}
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${fid}-q`} className="text-xs font-medium text-muted-foreground">{tr("quick.setup")}</label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              id={`${fid}-q`}
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
                if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
                if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); submit(); }
              }}
              placeholder={tr("quick.searchPlaceholder")}
              aria-controls={`${fid}-list`}
              className="h-10 pl-9"
            />
          </div>
          <ul
            id={`${fid}-list`}
            ref={listRef}
            role="listbox"
            aria-label={tr("quick.setup")}
            className="-mx-1 max-h-[min(45dvh,420px)] min-h-[160px] overflow-y-auto overscroll-contain px-1"
          >
            {rows.length === 0 ? (
              <li className="px-2 py-8 text-center text-sm text-muted-foreground">
                {writableCount === 0 ? tr("quick.noWritable") : commonI18n.t("states.nothingFound")}
              </li>
            ) : rows.map(({ s, group }) => {
              const head = group !== lastGroup ? tr(`quick.group.${group}`) : null;
              lastGroup = group;
              const active = picked === s.id;
              const reason = reasons.get(s.id);
              const ex = existing.get(s.id);
              return (
                <React.Fragment key={s.id}>
                  {head && <li role="presentation" className="sticky top-0 z-raised bg-popover px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">{head}</li>}
                  <li
                    role="option"
                    aria-selected={active}
                    data-pick={s.id}
                    onClick={() => setPicked(s.id)}
                    onDoubleClick={() => { setPicked(s.id); submit(s.id); }}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5",
                      active ? "bg-primary/15 ring-1 ring-primary/40" : "hover:bg-[var(--glass-hover-bg)]",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-sm text-foreground", active ? "font-semibold" : "font-medium")}>{s.name}</span>
                      <span className="block truncate text-xs text-muted-foreground" title={reason ?? undefined}>{reason ?? s.folder ?? commonI18n.t("fields.noFolder")}</span>
                    </span>
                    {ex && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{tr("quick.alreadyTier", { tier: ex.tier })}</span>}
                    <span className="shrink-0 rounded-full bg-[var(--glass-bg)] px-2 py-0.5 text-xs text-muted-foreground">{spaceShort(s)}</span>
                  </li>
                </React.Fragment>
              );
            })}
          </ul>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{tr("quick.tier")}</span>
          <div role="radiogroup" aria-label={tr("quick.tier")} className="grid grid-cols-3 gap-1.5">
            {TIERS.map((x) => {
              const [, name] = x.label.split(" · ");
              const on = tier === x.tier;
              return (
                <button
                  key={x.tier}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  title={`${x.hint} (Alt+${x.tier})`}
                  onClick={() => { setTier(x.tier); setTierTouched(true); }}
                  className={cn(
                    "flex min-h-11 flex-col items-start justify-center rounded-xl border px-2.5 py-1.5 text-left text-xs transition-colors duration-[var(--dur-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    on ? "border-primary/60 bg-primary/10 text-foreground" : "border-border/60 text-muted-foreground hover:bg-[var(--glass-hover-bg)]",
                  )}
                >
                  <span className="flex items-center gap-1.5 font-semibold">
                    <span className={cn("h-2 w-2 rounded-full bg-current", toneText(x.tone))} aria-hidden="true" />
                    {x.short}
                  </span>
                  <span className={cn("leading-tight", on && "font-medium")}>{name}</span>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground" aria-live="polite">{tierHint}</p>
        </div>

        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); submit(); } }}
          rows={2}
          placeholder={tier === 3 ? tr("quick.noteLoss") : tr("quick.noteWin")}
          aria-label={tr("quick.noteAria")}
          maxLength={2000}
          className="min-h-[60px] resize-y text-sm"
        />

        {single && (
          <div className="flex items-center gap-2">
            {shotUrl ? (
              <div className="relative">
                <img src={shotUrl} alt={tr("quick.shotAlt")} className="h-16 w-28 rounded-lg border border-border/60 object-cover" />
                <button type="button" aria-label={tr("quick.removeShot")} title={tr("quick.removeShot")} onClick={() => setShot(null)} className="absolute -right-2 -top-2 grid h-6 w-6 place-items-center rounded-full bg-background shadow ring-1 ring-border">
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <Button type="button" variant="ghost" size="sm" className="h-9" onClick={() => fileRef.current?.click()}>
                <ImagePlus className="h-4 w-4" aria-hidden="true" /> {tr("quick.shot")}
              </Button>
            )}
            <span className="text-xs text-muted-foreground">{shotUrl ? tr("quick.shotSaved") : tr("quick.shotHint")}</span>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) setShot(f); e.target.value = ""; }}
            />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-[var(--panel-p)] py-3">
        {single && onNewSetup ? (
          <button type="button" onClick={onNewSetup} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            {tr("quick.newFromTrade")}
          </button>
        ) : <span className="text-xs text-muted-foreground">{target ? `→ ${target.name}` : ""}</span>}
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex"><Kbd>Enter</Kbd></span>
          <Button size="sm" className="h-9 bg-primary-solid" onClick={() => submit()} disabled={!canAdd} aria-busy={add.isPending}>
            {add.isPending && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {already ? tr("quick.update") : single ? tr("quick.add") : tr("quick.addN", { count: tradeIds.length })}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Dialog wrapper for bulk / inbox use (the trade sheet uses a popover via AddToPlaybookButton). */
export function AddTradesToPlaybookDialog({
  open, onOpenChange, tradeIds, presetSetupId, onDone, onNewSetup,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tradeIds: number[];
  presetSetupId?: number | null;
  onDone?: () => void;
  /** «Новый сетап из сделки» (single trade): the caller opens its setup form. */
  onNewSetup?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] w-[calc(100vw-1.5rem)] max-w-xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>{dt("quick.title")}</DialogTitle>
          <DialogDescription>{dt("quick.dialogDesc", { trades: commonI18n.t("units.trades", { count: tradeIds.length }) })}</DialogDescription>
        </DialogHeader>
        {open && tradeIds.length > 0 && (
          <TradeQuickAdd
            tradeIds={tradeIds}
            presetSetupId={presetSetupId}
            onClose={() => { onOpenChange(false); onDone?.(); }}
            onNewSetup={onNewSetup && tradeIds.length === 1 ? () => { onOpenChange(false); onNewSetup(); } : undefined}
            className="min-h-0 flex-1"
            inDialog
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
