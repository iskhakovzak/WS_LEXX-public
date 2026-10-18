import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListBig7Levels, useCreateBig7Level, useUpdateBig7Level, useDeleteBig7Level, getListBig7LevelsQueryKey,
} from "@workspace/api-client-react";
import type { Big7Level } from "@workspace/api-client-react";
import { Check, Layers, Loader2, MoreHorizontal, Pencil, Plus, Trash2, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Panel, Pill, EmptyState } from "@/components/ds";
import { WriteOnly, useAuth } from "@/contexts/auth-context";
import { canModifyOwned, createdByOf } from "@/lib/ownership";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  ACTION_OPTIONS, LEVEL_LABELS, actionLabel, actionTone, levelLabel, num, splitLevelNotes,
  type GapStats, type StockQuote,
} from "./lib";
import { fmtPct, fmtPrice } from "@/lib/format";
import { big7I18n } from "@/i18n/ns/big7";
import { commonI18n } from "@/i18n/ns/common";

type Form = { label: string; price: string; notes: string; action: string };
const EMPTY: Form = { label: "support", price: "", notes: "", action: "" };
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const selectCls = "glass-field h-9 min-w-0 rounded-full px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function LevelForm({
  form, setForm, onSave, onCancel, saving, autoFocus = true,
}: { form: Form; setForm: (f: (p: Form) => Form) => void; onSave: () => void; onCancel: () => void; saving: boolean; autoFocus?: boolean }) {
  const { t } = big7I18n.useT();
  const price = num(form.price);
  const valid = price !== null && price > 0;
  return (
    <div
      className="space-y-2 rounded-xl bg-[var(--glass-bg)] p-2"
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_6rem_1fr]">
        <select aria-label={t("levels.typeAria")} value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} className={selectCls}>
          {LEVEL_LABELS.map((l) => <option key={l} value={l}>{levelLabel(l)}</option>)}
          {!LEVEL_LABELS.includes(form.label) && <option value={form.label}>{levelLabel(form.label)}</option>}
        </select>
        <Input
          aria-label={t("levels.priceAria")}
          aria-invalid={!!form.price && !valid}
          inputMode="decimal"
          autoFocus={autoFocus}
          value={form.price}
          onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
          onKeyDown={(e) => { if (e.key === "Enter") onSave(); }}
          placeholder={t("levels.pricePlaceholder")}
          className="h-9 tabular-nums"
        />
        <select aria-label={t("levels.actionAria")} value={form.action} onChange={(e) => setForm((f) => ({ ...f, action: e.target.value }))} className={cn(selectCls, "col-span-2 sm:col-span-1")}>
          <option value="">{t("levels.actionPlaceholder")}</option>
          {ACTION_OPTIONS.map((a) => <option key={a} value={a}>{actionLabel(a)}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <Input
          aria-label={t("levels.noteAria")}
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          onKeyDown={(e) => { if (e.key === "Enter") onSave(); }}
          placeholder={t("levels.notePlaceholder")}
          className="h-9 min-w-0 flex-1"
        />
        <Button size="icon" className="h-9 w-9 shrink-0" aria-label={t("levels.save")} onClick={onSave} disabled={!valid || saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Check />}
        </Button>
        <Button size="icon" variant="ghost" className="h-9 w-9 shrink-0" aria-label={commonI18n.t("actions.cancel")} onClick={onCancel}>
          <X />
        </Button>
      </div>
    </div>
  );
}

/** Support/resistance ladder around the live price, with distance in % and ATR. */
export function LevelsLadder({ ticker, quote, stats, atr }: { ticker: string; quote?: StockQuote; stats?: GapStats; atr: number | null }) {
  const { t } = big7I18n.useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user, isCurator } = useAuth();
  const me = user && user.role !== "guest" ? user.traderName : null;
  const { data: allLevels = [], isLoading, isError, refetch } = useListBig7Levels();
  const createM = useCreateBig7Level();
  const updateM = useUpdateBig7Level();
  const deleteM = useDeleteBig7Level();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setFormState] = useState<Form>(EMPTY);
  const setForm = (f: (p: Form) => Form) => setFormState(f);
  const invalidate = () => qc.invalidateQueries({ queryKey: getListBig7LevelsQueryKey() });
  const saving = createM.isPending || updateM.isPending;

  const price = quote?.price ?? stats?.lastClose ?? null;
  const levels = useMemo(
    () => (allLevels as Big7Level[])
      .filter((l) => l.ticker === ticker && Number.isFinite(Number(l.price)))
      .sort((a, b) => Number(b.price) - Number(a.price)),
    [allLevels, ticker],
  );
  const above = price != null ? levels.filter((l) => Number(l.price) > price) : [];
  const below = price != null ? levels.filter((l) => Number(l.price) <= price) : levels;
  const nearestR = above.length ? above[above.length - 1] : null;
  const nearestS = below.length ? below[0] : null;

  const reset = () => { setAdding(false); setEditingId(null); setFormState(EMPTY); };

  const save = async () => {
    const p = num(form.price);
    if (p === null || p <= 0 || saving) return;
    const notes = form.action ? `[${form.action}] ${form.notes}`.trim() : form.notes;
    try {
      if (editingId != null) {
        await updateM.mutateAsync({ id: editingId, data: { label: form.label, price: p, notes: notes || null } });
      } else {
        await createM.mutateAsync({ data: { ticker, label: form.label, price: p, notes: notes || null } });
      }
      await invalidate();
      reset();
    } catch (e) {
      toast({ title: t("levels.saveFailed"), description: errMsg(e), variant: "destructive" });
    }
  };

  const quickAdd = async (label: string, p: number | null | undefined) => {
    if (p == null || !(p > 0)) return;
    if (levels.some((l) => Math.abs(Number(l.price) - p) < 0.005)) {
      toast({ title: t("levels.exists", { label: levelLabel(label), price: fmtPrice(p) }) });
      return;
    }
    try {
      await createM.mutateAsync({ data: { ticker, label, price: +p.toFixed(2), notes: null } });
      await invalidate();
    } catch (e) {
      toast({ title: t("levels.addFailed"), description: errMsg(e), variant: "destructive" });
    }
  };

  const remove = async (l: Big7Level) => {
    if (!window.confirm(t("levels.confirmDelete", { label: levelLabel(l.label), price: fmtPrice(Number(l.price)), ticker }))) return;
    try {
      await deleteM.mutateAsync({ id: l.id });
      await invalidate();
    } catch (e) {
      toast({ title: t("levels.deleteFailed"), description: errMsg(e), variant: "destructive" });
    }
  };

  const startEdit = (l: Big7Level) => {
    const { action, note } = splitLevelNotes(l.notes);
    setAdding(false);
    setEditingId(l.id);
    setFormState({ label: l.label, price: String(Number(l.price)), notes: note, action });
  };

  const quick: Array<{ label: string; text: string; price: number | null | undefined }> = [
    { label: "yesterday close", text: "PDC", price: quote?.prevClose },
    { label: "open", text: levelLabel("open"), price: quote?.open },
    { label: "resistance", text: "HOD", price: quote?.high },
    { label: "support", text: "LOD", price: quote?.low },
    { label: "pivot", text: "SMA20", price: stats?.sma20 },
    { label: "pivot", text: "SMA50", price: stats?.sma50 },
    { label: "52w high", text: "52w high", price: quote?.high52w },
  ].filter((q) => q.price != null && q.price > 0);

  const row = (l: Big7Level) => {
    if (editingId === l.id) {
      return <li key={l.id}><LevelForm form={form} setForm={setForm} onSave={save} onCancel={reset} saving={saving} /></li>;
    }
    const lp = Number(l.price);
    const isAbove = price != null && lp > price;
    const dist = price != null && price > 0 ? ((lp - price) / price) * 100 : null;
    const distAtr = price != null && atr ? (lp - price) / atr : null;
    const { action, note } = splitLevelNotes(l.notes);
    const nearest = l.id === nearestR?.id || l.id === nearestS?.id;
    return (
      <li
        key={l.id}
        className={cn(
          "group relative flex min-w-0 items-center gap-2 rounded-xl py-1.5 pl-3 pr-1 text-sm transition-colors hover:bg-[var(--glass-hover-bg)]",
          nearest && "bg-[var(--glass-bg)]",
        )}
      >
        <span className={cn("absolute inset-y-1.5 left-0 w-0.5 rounded-full", price == null ? "bg-border" : isAbove ? "bg-down" : "bg-up")} aria-hidden="true" />
        <span className="w-[5.5rem] shrink-0 truncate text-xs text-muted-foreground" title={l.label}>{levelLabel(l.label)}</span>
        <span className="w-16 shrink-0 font-semibold tabular-nums text-foreground">{fmtPrice(lp)}</span>
        <span className="hidden w-[4.5rem] shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:inline" title={distAtr != null ? `${distAtr.toFixed(2)} ATR` : undefined}>
          {dist != null ? fmtPct(dist, 1) : ""}
          {distAtr != null && <span className="block text-2xs">{Math.abs(distAtr).toFixed(1)} ATR</span>}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {action && <Pill tone={actionTone(action)} className="shrink-0">{actionLabel(action)}</Pill>}
          {note && <span className="truncate text-xs text-muted-foreground" title={note}>{note}</span>}
        </span>
        {canModifyOwned(createdByOf(l), me, isCurator) && <WriteOnly>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("levels.rowActions", { label: levelLabel(l.label), price: fmtPrice(lp) })}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-opacity hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => startEdit(l)}><Pencil className="mr-2 h-4 w-4" />{commonI18n.t("actions.edit")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => remove(l)} className="text-down focus:text-down"><Trash2 className="mr-2 h-4 w-4" />{commonI18n.t("actions.delete")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </WriteOnly>}
      </li>
    );
  };

  return (
    <Panel
      title={t("levels.title")}
      icon={Layers}
      description={
        nearestR || nearestS
          ? t("levels.nearest", { r: nearestR ? `R ${fmtPrice(Number(nearestR.price))}` : "R —", s: nearestS ? `S ${fmtPrice(Number(nearestS.price))}` : "S —" })
          : t("levels.hint")
      }
      actions={
        <WriteOnly>
          <Button size="sm" variant="outline" onClick={() => { setEditingId(null); setFormState(EMPTY); setAdding(true); }}>
            <Plus /> {t("levels.add")}
          </Button>
        </WriteOnly>
      }
      className="flex h-full flex-col"
      bodyClassName="flex-1"
    >
      {isLoading && (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-7 animate-pulse rounded-xl bg-[var(--glass-bg)]" />)}
        </div>
      )}
      {isError && !isLoading && (
        <div role="alert" className="flex items-center justify-between gap-2 rounded-xl bg-down/15 px-3 py-2 text-sm text-down">
          {t("levels.loadFailed")}
          <Button size="sm" variant="ghost" onClick={() => refetch()}>{commonI18n.t("actions.retry")}</Button>
        </div>
      )}
      {!isLoading && !isError && (
        <>
          {adding && <div className="mb-2"><LevelForm form={form} setForm={setForm} onSave={save} onCancel={reset} saving={saving} /></div>}
          {levels.length === 0 && !adding ? (
            <EmptyState
              icon={Layers}
              title={t("levels.emptyTitle")}
              description={t("levels.emptyText")}
              className="py-6"
            />
          ) : (
            <ul className="space-y-0.5" aria-label={t("levels.listAria", { ticker })}>
              {above.map(row)}
              {price != null && (
                <li className="flex items-center gap-2 py-1" aria-label={t("levels.currentPrice", { price: fmtPrice(price) })}>
                  <span className="h-px flex-1 bg-primary/50" aria-hidden="true" />
                  <Pill tone="accent" className="shrink-0">{t("levels.price", { price: fmtPrice(price) })}</Pill>
                  <span className="h-px flex-1 bg-primary/50" aria-hidden="true" />
                </li>
              )}
              {below.map(row)}
            </ul>
          )}
          {quick.length > 0 && (
            <WriteOnly>
              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
                <span className="text-xs text-muted-foreground">{t("levels.quick")}</span>
                {quick.map((q) => (
                  <button
                    key={q.text}
                    type="button"
                    disabled={createM.isPending}
                    onClick={() => quickAdd(q.label, q.price)}
                    className="chip inline-flex min-h-7 items-center gap-1 px-2.5 text-xs tabular-nums disabled:opacity-50"
                    title={t("levels.quickTitle", { label: q.text, price: fmtPrice(q.price!) })}
                  >
                    <Plus className="h-3 w-3" aria-hidden="true" />{q.text} <span className="text-muted-foreground">{fmtPrice(q.price!)}</span>
                  </button>
                ))}
              </div>
            </WriteOnly>
          )}
        </>
      )}
    </Panel>
  );
}
