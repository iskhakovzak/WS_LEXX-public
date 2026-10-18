import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Flame, ListFilter, Loader2, MoreHorizontal, Pencil, Plus, Trash2, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, Panel, Pill, Segmented } from "@/components/ds";
import { WriteOnly, useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { canModifyOwned } from "@/lib/ownership";
import { useBig7Today, useCatalystMutations } from "./use-big7";
import {
  CATALYST_TYPES, addDays, big7Today, catalystMeta, mondayOf, relDayLabel, weekdayShort,
  type MergedCatalyst,
} from "./lib";
import { fmtDate } from "@/lib/format";
import { big7I18n } from "@/i18n/ns/big7";
import { commonI18n } from "@/i18n/ns/common";

export type CatalystDraft = { id?: number; ticker: string; date: string; type: string; description: string; impact: string };
export const emptyDraft = (p: Partial<CatalystDraft> = {}): CatalystDraft => ({
  ticker: "", date: big7Today(), type: "earnings", description: "", impact: "medium", ...p,
});
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const selectCls = "glass-field h-9 w-full min-w-0 rounded-full px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Short add/edit dialog for a catalyst. */
export function CatalystDialog({
  draft, onClose, boardSymbols,
}: { draft: CatalystDraft | null; onClose: () => void; boardSymbols: string[] }) {
  const { t } = big7I18n.useT();
  const { toast } = useToast();
  const { create, update } = useCatalystMutations();
  const [form, setForm] = useState<CatalystDraft>(draft ?? emptyDraft());
  useEffect(() => { if (draft) setForm(draft); }, [draft]);
  const saving = create.isPending || update.isPending;
  const ticker = form.ticker.trim().toUpperCase().replace(/^\$/, "");
  const valid = /^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker) && /^\d{4}-\d{2}-\d{2}$/.test(form.date);

  const submit = async () => {
    if (!valid || saving) return;
    const body = { ticker, date: form.date, type: form.type, impact: form.impact, description: form.description.trim() || null };
    try {
      if (form.id != null) await update.mutateAsync({ id: form.id, ...body });
      else await create.mutateAsync(body);
      toast({ title: form.id != null ? t("catalyst.updated", { ticker }) : t("catalyst.added", { ticker }) });
      onClose();
    } catch (e) {
      toast({ title: t("catalyst.saveFailed"), description: errMsg(e), variant: "destructive" });
    }
  };

  return (
    <Dialog open={!!draft} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{form.id != null ? t("catalyst.editTitle") : t("catalyst.newTitle")}</DialogTitle>
          <DialogDescription>{t("catalyst.dialogDesc")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => { e.preventDefault(); submit(); }}
        >
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="big7-cat-ticker" className="text-xs text-muted-foreground">{t("catalyst.ticker")}</Label>
              <Input id="big7-cat-ticker" value={form.ticker} onChange={(e) => setForm((f) => ({ ...f, ticker: e.target.value.toUpperCase() }))} placeholder="AAPL" autoFocus={!form.ticker} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="big7-cat-date" className="text-xs text-muted-foreground">{t("catalyst.date")}</Label>
              <Input id="big7-cat-date" type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
          </div>
          {boardSymbols.length > 0 && (
            <div className="flex flex-wrap gap-1" role="group" aria-label={t("catalyst.boardTicker")}>
              {[...boardSymbols, "SPY"].map((s) => (
                <button key={s} type="button" aria-pressed={ticker === s} onClick={() => setForm((f) => ({ ...f, ticker: s }))} className="chip min-h-7 px-2.5 text-xs">{s}</button>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="big7-cat-type" className="text-xs text-muted-foreground">{t("catalyst.typeLabel")}</Label>
              <select id="big7-cat-type" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} className={selectCls}>
                {CATALYST_TYPES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("catalyst.impact")}</p>
              <Segmented
                ariaLabel={t("catalyst.impact")}
                size="sm"
                value={form.impact}
                onChange={(v) => setForm((f) => ({ ...f, impact: v }))}
                options={[{ value: "low", label: t("catalyst.impactLow") }, { value: "medium", label: t("catalyst.impactMid") }, { value: "high", label: t("catalyst.impactHigh") }]}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="big7-cat-desc" className="text-xs text-muted-foreground">{t("catalyst.description")}</Label>
            <Input id="big7-cat-desc" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder={t("catalyst.descPlaceholder")} maxLength={500} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>{commonI18n.t("actions.cancel")}</Button>
            <Button type="submit" disabled={!valid || saving}>
              {saving && <Loader2 className="animate-spin" />} {form.id != null ? commonI18n.t("actions.save") : commonI18n.t("actions.add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CatalystChip({ c, onClick, onBoard }: { c: MergedCatalyst; onClick?: () => void; onBoard: boolean }) {
  const m = catalystMeta(c.type);
  const Icon = m.icon;
  const inner = (
    <>
      <span className={cn("absolute inset-y-1.5 left-0 w-0.5 rounded-full", c.impact === "high" ? "bg-down" : c.impact === "low" ? "bg-border" : "bg-[hsl(var(--chart-3))]")} aria-hidden="true" />
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="text-xs font-semibold">{c.ticker}</span>
        <Pill tone={m.tone} className="px-1.5"><Icon className="h-3 w-3" aria-hidden="true" />{m.label}</Pill>
        {c.auto && <Sparkles className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={big7I18n.t("catalyst.fromCalendar")} />}
      </span>
      {c.description && <span className="mt-0.5 block truncate text-2xs text-muted-foreground">{c.description}</span>}
    </>
  );
  const cls = "relative block w-full min-w-0 rounded-lg bg-[var(--glass-bg)] py-1.5 pl-2.5 pr-2 text-left";
  if (onClick && onBoard) {
    return <button type="button" onClick={onClick} className={cn(cls, "transition-colors hover:bg-[var(--glass-hover-bg)]")} title={c.description ?? undefined}>{inner}</button>;
  }
  return <div className={cls} title={c.description ?? undefined}>{inner}</div>;
}

/** Compact Mon–Fri calendar of catalysts for the board. */
export function CatalystWeek({
  merged, boardSymbols, onSelectTicker, onAdd, onOpenAll, isError, onRetry,
}: {
  merged: MergedCatalyst[];
  boardSymbols: string[];
  onSelectTicker: (s: string) => void;
  onAdd: (date: string) => void;
  onOpenAll: () => void;
  isError: boolean;
  onRetry: () => void;
}) {
  const { t } = big7I18n.useT();
  const [week, setWeek] = useState<"this" | "next">("this");
  const TODAY = useBig7Today();
  // Saturday / Sunday: the week that matters is the one ahead, not the one that just closed.
  const dow = new Date(`${TODAY}T12:00:00Z`).getUTCDay();
  const weekend = dow === 0 || dow === 6;
  const anchor = weekend ? addDays(TODAY, dow === 6 ? 2 : 1) : TODAY;
  const monday = addDays(mondayOf(anchor), week === "next" ? 7 : 0);
  const days = [0, 1, 2, 3, 4].map((i) => addDays(monday, i));
  const board = useMemo(() => new Set(boardSymbols), [boardSymbols]);
  const relevant = merged.filter((c) => board.has(c.ticker) || c.marketWide);
  const byDay = (d: string) => relevant.filter((c) => c.date === d);
  const total = days.reduce((n, d) => n + byDay(d).length, 0);

  return (
    <Panel
      title={t("catalyst.weekTitle")}
      icon={CalendarDays}
      description={total > 0
        ? t("catalyst.weekEvents", { count: total, range: `${fmtDate(days[0], "dayMonthNumeric")}–${fmtDate(days[4], "dayMonthNumeric")}` })
        : `${fmtDate(days[0], "dayMonthNumeric")}–${fmtDate(days[4], "dayMonthNumeric")}`}
      actions={
        <>
          <Segmented ariaLabel={t("catalyst.weekAria")} size="sm" value={week} onChange={setWeek} options={[{ value: "this", label: weekend ? t("catalyst.weekNearest") : t("catalyst.weekThis") }, { value: "next", label: t("catalyst.weekNext") }]} />
          <Button variant="ghost" size="sm" onClick={onOpenAll}><ListFilter /> {t("catalyst.all")}</Button>
        </>
      }
    >
      {isError && (
        <div role="alert" className="mb-3 flex items-center justify-between gap-2 rounded-xl bg-down/15 px-3 py-2 text-sm text-down">
          {t("catalyst.loadFailed")}
          <Button size="sm" variant="ghost" onClick={onRetry}>{commonI18n.t("actions.retry")}</Button>
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-5">
        {days.map((d) => {
          const items = byDay(d);
          const isToday = d === TODAY;
          const past = d < TODAY;
          return (
            <div
              key={d}
              className={cn(
                "group flex min-w-0 flex-col gap-1.5 rounded-xl p-2",
                isToday ? "bg-primary/10 ring-1 ring-primary" : "bg-[var(--glass-bg)]",
                past && "opacity-70",
              )}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-xs font-medium">
                  {weekdayShort(d)} <span className="tabular-nums text-muted-foreground">{fmtDate(d, "dayMonthNumeric")}</span>
                </span>
                {isToday ? <Pill tone="accent" className="px-1.5">{t("catalyst.today")}</Pill> : (
                  <WriteOnly>
                    <button
                      type="button"
                      onClick={() => onAdd(d)}
                      aria-label={t("catalyst.addOn", { date: fmtDate(d, "dayMonthNumeric") })}
                      className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground transition-opacity hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </WriteOnly>
                )}
              </div>
              {items.length === 0 ? (
                <p className="py-1 text-2xs text-muted-foreground sm:py-3 sm:text-center">—</p>
              ) : (
                items.map((c) => (
                  <CatalystChip key={c.key} c={c} onBoard={board.has(c.ticker)} onClick={() => onSelectTicker(c.ticker)} />
                ))
              )}
              {isToday && (
                <WriteOnly>
                  <button type="button" onClick={() => onAdd(d)} className="chip inline-flex min-h-7 items-center justify-center gap-1 px-2 text-xs">
                    <Plus className="h-3 w-3" aria-hidden="true" /> {commonI18n.t("actions.add")}
                  </button>
                </WriteOnly>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 flex items-center gap-1 text-2xs text-muted-foreground">
        <Sparkles className="h-3 w-3" aria-hidden="true" /> {t("catalyst.legend")}
      </p>
    </Panel>
  );
}

function CatalystActions({ c, onEdit }: { c: MergedCatalyst; onEdit: (c: MergedCatalyst) => void }) {
  const { t } = big7I18n.useT();
  const { remove } = useCatalystMutations();
  const { toast } = useToast();
  const { user, isCurator } = useAuth();
  const me = user && user.role !== "guest" ? user.traderName : null;
  if (c.auto || c.id == null) return null;
  // Edit / delete: the catalyst's author or staff (server: 403 NOT_OWNER otherwise).
  if (!canModifyOwned(c.createdBy, me, isCurator)) return null;
  const del = async () => {
    if (!window.confirm(t("catalyst.confirmDelete", { ticker: c.ticker, date: fmtDate(c.date, "dayMonthNumeric") }))) return;
    try {
      await remove.mutateAsync(c.id!);
    } catch (e) {
      toast({ title: commonI18n.t("states.deleteFailed"), description: errMsg(e), variant: "destructive" });
    }
  };
  return (
    <WriteOnly>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("catalyst.actions", { ticker: c.ticker, date: fmtDate(c.date, "dayMonthNumeric") })}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-opacity hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onEdit(c)}><Pencil className="mr-2 h-4 w-4" />{commonI18n.t("actions.edit")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={del} className="text-down focus:text-down"><Trash2 className="mr-2 h-4 w-4" />{commonI18n.t("actions.delete")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </WriteOnly>
  );
}

function CatalystRow({ c, showTicker, onEdit }: { c: MergedCatalyst; showTicker: boolean; onEdit: (c: MergedCatalyst) => void }) {
  const { t } = big7I18n.useT();
  const m = catalystMeta(c.type);
  const Icon = m.icon;
  const TODAY = big7Today(); // re-rendered by the parent's useBig7Today()
  const past = c.date < TODAY;
  return (
    <li className={cn("group relative flex min-w-0 items-start gap-3 py-2 pl-5", past && "opacity-60")}>
      <span className={cn("absolute left-1 top-3 h-2 w-2 rounded-full", c.date === TODAY ? "bg-primary" : past ? "bg-border" : c.impact === "high" ? "bg-down" : "bg-[hsl(var(--chart-3))]")} aria-hidden="true" />
      <div className="w-[4.5rem] shrink-0 text-xs tabular-nums">
        <div className="font-medium">{fmtDate(c.date, "dayMonthNumeric")} {weekdayShort(c.date)}</div>
        <div className="text-2xs text-muted-foreground">{relDayLabel(c.date)}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {showTicker && <span className="text-sm font-semibold">{c.ticker}</span>}
          <Pill tone={m.tone}><Icon className="h-3 w-3" aria-hidden="true" />{m.label}</Pill>
          {c.impact === "high" && <Flame className="h-3.5 w-3.5 text-down" aria-label={t("catalyst.highImpact")} />}
          {c.marketWide && !showTicker && <Pill>{t("catalyst.market", { ticker: c.ticker })}</Pill>}
          {c.auto && <Pill className="gap-1"><Sparkles className="h-3 w-3" aria-hidden="true" />{t("catalyst.calendar")}</Pill>}
        </div>
        {c.description && <p className="mt-0.5 text-xs text-muted-foreground">{c.description}</p>}
      </div>
      <CatalystActions c={c} onEdit={onEdit} />
    </li>
  );
}

/** Per-ticker catalyst timeline (own + market-wide), upcoming first, plus last 2 weeks. */
export function CatalystTimeline({
  ticker, merged, onAdd, onEdit,
}: { ticker: string; merged: MergedCatalyst[]; onAdd: () => void; onEdit: (c: MergedCatalyst) => void }) {
  const { t } = big7I18n.useT();
  const TODAY = useBig7Today();
  const from = addDays(TODAY, -14);
  const list = merged.filter((c) => (c.ticker === ticker || c.marketWide) && c.date >= from);
  const upcoming = list.filter((c) => c.date >= TODAY);
  const past = list.filter((c) => c.date < TODAY).reverse();
  return (
    <Panel
      title={t("catalyst.timelineTitle")}
      icon={CalendarDays}
      description={upcoming.length ? t("catalyst.ahead", { count: upcoming.length }) : t("catalyst.nothingAhead")}
      actions={<WriteOnly><Button size="sm" variant="outline" onClick={onAdd}><Plus /> {t("page.catalyst")}</Button></WriteOnly>}
    >
      {list.length === 0 ? (
        <EmptyState icon={CalendarDays} title={t("catalyst.emptyTitle")} description={t("catalyst.emptyText", { ticker })} className="py-6" />
      ) : (
        <ol className="relative before:absolute before:bottom-2 before:left-[0.53rem] before:top-2 before:w-px before:bg-border">
          {upcoming.map((c) => <CatalystRow key={c.key} c={c} showTicker={false} onEdit={onEdit} />)}
          {past.length > 0 && <li className="micro-label py-1 pl-5">{t("catalyst.past")}</li>}
          {past.map((c) => <CatalystRow key={c.key} c={c} showTicker={false} onEdit={onEdit} />)}
        </ol>
      )}
    </Panel>
  );
}

/** Full list of catalysts (manager), filterable by scope. */
export function CatalystSheet({
  open, onOpenChange, merged, onAdd, onEdit,
}: { open: boolean; onOpenChange: (o: boolean) => void; merged: MergedCatalyst[]; onAdd: () => void; onEdit: (c: MergedCatalyst) => void }) {
  const { t } = big7I18n.useT();
  const [scope, setScope] = useState<"upcoming" | "past">("upcoming");
  const { canEdit } = useAuth();
  const TODAY = useBig7Today();
  const list = scope === "upcoming"
    ? merged.filter((c) => c.date >= TODAY)
    : merged.filter((c) => c.date < TODAY && c.date >= addDays(TODAY, -60)).reverse();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t("catalyst.sheetTitle")}</SheetTitle>
          <SheetDescription>{t("catalyst.sheetDesc")}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented ariaLabel={t("catalyst.periodAria")} size="sm" value={scope} onChange={setScope} options={[{ value: "upcoming", label: t("catalyst.upcoming") }, { value: "past", label: t("catalyst.past") }]} />
          {canEdit && <Button size="sm" onClick={onAdd}><Plus /> {commonI18n.t("actions.add")}</Button>}
        </div>
        {list.length === 0 ? (
          <EmptyState icon={CalendarDays} title={scope === "upcoming" ? t("catalyst.noUpcoming") : t("catalyst.empty60")} description={t("catalyst.emptySheetText")} />
        ) : (
          <ol className="relative before:absolute before:bottom-2 before:left-[0.53rem] before:top-2 before:w-px before:bg-border">
            {list.map((c) => <CatalystRow key={c.key} c={c} showTicker onEdit={onEdit} />)}
          </ol>
        )}
      </SheetContent>
    </Sheet>
  );
}
