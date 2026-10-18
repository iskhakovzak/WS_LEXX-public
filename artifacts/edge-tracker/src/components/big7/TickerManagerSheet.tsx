import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateBig7Ticker, useDeleteBig7Ticker, useBulkCreateBig7Tickers, useUpdateBig7Ticker, getListBig7TickersQueryKey,
} from "@workspace/api-client-react";
import type { Big7Ticker } from "@workspace/api-client-react";
import { ArrowDown, ArrowUp, ClipboardPaste, Flame, Loader2, Plus, Star, Trash2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, Pill, Segmented } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/auth-context";
import { canModifyOwned, createdByOf } from "@/lib/ownership";
import { DEFAULT_BIG7, big7Today, parseTickerSymbols } from "./lib";
import { fmtDate } from "@/lib/format";
import { big7I18n } from "@/i18n/ns/big7";
import { commonI18n } from "@/i18n/ns/common";

const bt = big7I18n.t;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const SYM_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/** Seeds the default Big 7 through POST /big7/tickers (idempotent: existing rows are returned as-is). */
export function useSeedBig7() {
  const qc = useQueryClient();
  const createM = useCreateBig7Ticker();
  const { toast } = useToast();
  const [seeding, setSeeding] = useState(false);
  const seed = async (existing: string[] = []) => {
    if (seeding) return;
    setSeeding(true);
    const todo = DEFAULT_BIG7.map((t, i) => ({ ...t, position: i })).filter((t) => !existing.includes(t.symbol));
    let ok = 0;
    const failed: string[] = [];
    for (const t of todo) {
      try {
        await createM.mutateAsync({ data: { symbol: t.symbol, name: t.name, exchange: t.exchange, groupName: "core", position: t.position } });
        ok++;
      } catch {
        failed.push(t.symbol);
      }
    }
    await qc.invalidateQueries({ queryKey: getListBig7TickersQueryKey() });
    setSeeding(false);
    if (failed.length) toast({ title: bt("manager.seedPartial", { ok, list: failed.join(", ") }), variant: "destructive" });
    else toast({ title: ok ? bt("manager.seeded", { count: ok }) : bt("manager.allPresent") });
  };
  return { seed, seeding };
}

export function TickerManagerSheet({
  open, onOpenChange, tickers, hotSymbols, onHotChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tickers: Big7Ticker[];
  hotSymbols: string[];
  onHotChange: (syms: string[]) => void;
}) {
  const { t } = big7I18n.useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const createM = useCreateBig7Ticker();
  const deleteM = useDeleteBig7Ticker();
  const { user, isCurator } = useAuth();
  const me = user && user.role !== "guest" ? user.traderName : null;
  // Reordering patches every row's position (other authors' rows too) → staff only; delete → author or staff.
  const bulkM = useBulkCreateBig7Tickers();
  const updateM = useUpdateBig7Ticker();
  const { seed, seeding } = useSeedBig7();
  const [group, setGroup] = useState<"core" | "hot">("core");
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [bulkDel, setBulkDel] = useState("");
  const [reordering, setReordering] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: getListBig7TickersQueryKey() });

  const core = useMemo(() => tickers.filter((t) => t.groupName === "core"), [tickers]);
  const coreSyms = core.map((t) => t.symbol);
  const missingDefaults = DEFAULT_BIG7.filter((d) => !coreSyms.includes(d.symbol));
  const preview = useMemo(() => parseTickerSymbols(bulkText), [bulkText]);
  const previewDel = useMemo(() => parseTickerSymbols(bulkDel), [bulkDel]);

  const addOne = async () => {
    const sym = symbol.trim().toUpperCase().replace(/^\$/, "");
    if (!sym) return;
    if (!SYM_RE.test(sym)) { toast({ title: t("manager.invalidTicker"), description: sym, variant: "destructive" }); return; }
    if (group === "hot") {
      if (!hotSymbols.includes(sym)) onHotChange([...hotSymbols, sym]);
      setSymbol("");
      return;
    }
    try {
      await createM.mutateAsync({ data: { symbol: sym, name: name.trim() || sym, groupName: "core", position: core.length } });
      await invalidate();
      setSymbol(""); setName("");
    } catch (e) {
      toast({ title: t("manager.addFailed"), description: errMsg(e), variant: "destructive" });
    }
  };

  const addBulk = async () => {
    if (!preview.length) { toast({ title: t("manager.noValid"), variant: "destructive" }); return; }
    if (group === "hot") {
      const add = preview.filter((s) => !hotSymbols.includes(s));
      onHotChange([...hotSymbols, ...add]);
      toast({ title: t("manager.added", { count: add.length }), description: preview.length > add.length ? t("manager.alreadyThere", { list: preview.filter((s) => hotSymbols.includes(s)).join(", ") }) : t("manager.toHot") });
      setBulkText("");
      return;
    }
    try {
      const r = await bulkM.mutateAsync({ data: { symbols: preview, groupName: "core" } });
      await invalidate();
      toast({ title: t("manager.added", { count: r.added.length }), description: r.skipped?.length ? t("manager.alreadyThere", { list: r.skipped.join(", ") }) : t("manager.toBig7") });
      setBulkText("");
    } catch (e) {
      toast({ title: t("manager.bulkFailed"), description: errMsg(e), variant: "destructive" });
    }
  };

  const removeCore = async (tk: Big7Ticker) => {
    if (!window.confirm(bt("manager.confirmRemove", { symbol: tk.symbol }))) return;
    try {
      await deleteM.mutateAsync({ id: tk.id });
      await invalidate();
    } catch (e) {
      toast({ title: commonI18n.t("states.deleteFailed"), description: errMsg(e), variant: "destructive" });
    }
  };

  const move = async (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= core.length || reordering) return;
    const order = [...core];
    [order[idx], order[j]] = [order[j], order[idx]];
    setReordering(true);
    try {
      await Promise.all(order.map((t, i) => (t.position !== i ? updateM.mutateAsync({ id: t.id, data: { position: i } }) : null)));
      await invalidate();
    } catch (e) {
      toast({ title: t("manager.reorderFailed"), description: errMsg(e), variant: "destructive" });
    } finally {
      setReordering(false);
    }
  };

  const bulkDelete = () => {
    const del = new Set(previewDel);
    const hit = hotSymbols.filter((s) => del.has(s));
    onHotChange(hotSymbols.filter((s) => !del.has(s)));
    toast({ title: t("manager.removed", { count: hit.length }), description: hit.length ? hit.join(", ") : t("manager.noMatches") });
    setBulkDel("");
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("manager.title")}</SheetTitle>
          <SheetDescription>{t("manager.description", { date: fmtDate(big7Today(), "dayMonthNumeric") })}</SheetDescription>
        </SheetHeader>

        <Segmented
          ariaLabel={t("manager.groupAria")}
          value={group}
          onChange={setGroup}
          options={[
            { value: "core", label: <span className="inline-flex items-center gap-1"><Star className="h-3.5 w-3.5" aria-hidden="true" />Big 7</span>, count: core.length },
            { value: "hot", label: <span className="inline-flex items-center gap-1"><Flame className="h-3.5 w-3.5" aria-hidden="true" />Hot</span>, count: hotSymbols.length },
          ]}
        />

        {group === "core" && missingDefaults.length > 0 && (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-primary/10 px-3 py-2 text-sm">
            <span className="min-w-0">{t("manager.missing", { list: missingDefaults.map((d) => d.symbol).join(", ") })}</span>
            <Button size="sm" variant="outline" disabled={seeding} onClick={() => seed(coreSyms)}>
              {seeding && <Loader2 className="animate-spin" />} {commonI18n.t("actions.add")}
            </Button>
          </div>
        )}

        <ul className="space-y-1">
          {group === "core" && core.length === 0 && <EmptyState icon={Star} title={t("manager.emptyTitle")} description={t("manager.emptyText")} className="py-6" />}
          {group === "hot" && hotSymbols.length === 0 && <EmptyState icon={Flame} title={t("manager.hotEmptyTitle")} description={t("manager.hotEmptyText")} className="py-6" />}
          {group === "core" && core.map((tk, i) => (
            <li key={tk.id} className="group flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-[var(--glass-hover-bg)]">
              <span className="w-14 text-sm font-semibold">{tk.symbol}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{tk.name !== tk.symbol ? tk.name : ""} <span className="opacity-80">{tk.exchange}</span></span>
              {isCurator && <button type="button" aria-label={t("manager.up", { symbol: tk.symbol })} disabled={i === 0 || reordering} onClick={() => move(i, -1)} className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" aria-hidden="true" /></button>}
              {isCurator && <button type="button" aria-label={t("manager.down", { symbol: tk.symbol })} disabled={i === core.length - 1 || reordering} onClick={() => move(i, 1)} className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" aria-hidden="true" /></button>}
              {canModifyOwned(createdByOf(tk), me, isCurator) && <button type="button" aria-label={t("manager.remove", { symbol: tk.symbol })} disabled={deleteM.isPending} onClick={() => removeCore(tk)} className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-down/15 hover:text-down disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></button>}
            </li>
          ))}
          {group === "hot" && hotSymbols.map((s) => (
            <li key={s} className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-[var(--glass-hover-bg)]">
              <span className="w-14 text-sm font-semibold">{s}</span>
              <span className="flex-1 text-xs text-muted-foreground">{t("manager.today")}</span>
              <button type="button" aria-label={t("manager.remove", { symbol: s })} onClick={() => onHotChange(hotSymbols.filter((x) => x !== s))} className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-down/15 hover:text-down"><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></button>
            </li>
          ))}
        </ul>

        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); addOne(); }}>
          <Input aria-label={t("manager.tickerAria")} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder={t("manager.tickerAria")} className="w-28 uppercase" />
          {group === "core" && <Input aria-label={t("manager.nameAria")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("manager.namePlaceholder")} className="min-w-0 flex-1" />}
          <Button type="submit" variant="outline" disabled={!symbol.trim() || createM.isPending} className="shrink-0"><Plus /> {commonI18n.t("actions.add")}</Button>
        </form>

        <Collapsible>
          <CollapsibleTrigger className="inline-flex min-h-8 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <ClipboardPaste className="h-4 w-4" aria-hidden="true" /> {t("manager.bulkAdd")}
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 pt-2">
            <Textarea aria-label={t("manager.bulkAddAria")} value={bulkText} onChange={(e) => setBulkText(e.target.value)} rows={3} placeholder={"AAPL MSFT NVDA\nTSLA, AMD\n$PLTR"} />
            {preview.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {preview.slice(0, 30).map((s) => <Pill key={s} tone="accent">{s}</Pill>)}
                {preview.length > 30 && <Pill>+{preview.length - 30}</Pill>}
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{preview.length ? t("manager.bulkCount", { count: preview.length }) : t("manager.bulkHint")}</span>
              <Button size="sm" onClick={addBulk} disabled={!preview.length || bulkM.isPending}>{bulkM.isPending ? t("manager.adding") : t("manager.addN", { count: preview.length })}</Button>
            </div>
          </CollapsibleContent>
        </Collapsible>

        {group === "hot" && hotSymbols.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger className="inline-flex min-h-8 items-center gap-1.5 text-sm text-muted-foreground hover:text-down">
              <Trash2 className="h-4 w-4" aria-hidden="true" /> {t("manager.bulkDelete")}
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 pt-2">
              <Textarea aria-label={t("manager.bulkDeleteAria")} value={bulkDel} onChange={(e) => setBulkDel(e.target.value)} rows={2} placeholder="AAPL MSFT" />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button size="sm" variant="ghost" className="text-down" onClick={() => { if (window.confirm(t("manager.confirmClear", { count: hotSymbols.length }))) { onHotChange([]); toast({ title: t("manager.cleared") }); } }}>{t("manager.clearAll")}</Button>
                <Button size="sm" variant="destructive" disabled={!previewDel.length} onClick={bulkDelete}>
                  {t("manager.deleteN", { count: previewDel.filter((s) => hotSymbols.includes(s)).length })}
                </Button>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </SheetContent>
    </Sheet>
  );
}
