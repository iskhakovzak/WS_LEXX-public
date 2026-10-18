// /research — archive of the former «Исследования» notes. The section was merged away (Wave I):
// earnings and price reactions live in «Катализаторы» (/events), repeatable patterns in the Playbook.
// Old notes stay readable and can be moved to the Playbook with «В плейбук»; nothing new is written here.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListResearch, useUpdateResearch, useDeleteResearch, getListResearchQueryKey,
  type Research, type UpdateResearchBody,
} from "@workspace/api-client-react";
import { AlertTriangle, Archive, ArrowRight, BookMarked, CalendarClock, Download, RefreshCw, Search, X } from "lucide-react";
import { EmptyState, Page, PageHeader, Panel } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { useUndoDelete } from "@/hooks/use-undo-delete";
import { UndoToast } from "@/components/undo-toast";
import { http } from "@/lib/api/http";
import { cn } from "@/lib/utils";
import { ResearchFormDialog, formToResearchBody, type ResearchFormData } from "@/components/research/research-form-dialog";
import { ResearchPreview, type UpcomingByTicker } from "@/components/research/research-preview";
import { ResearchRow } from "@/components/research/research-row";
import {
  exportResearchCsv, highlightTerms, isEmptyQuery, matchResearch, parseQuery, splitTags, splitTickers, type ResearchNote, type SearchHit,
} from "@/components/research/research-utils";
import { humanizeApiError } from "@/lib/api/errors";
import { commonI18n } from "@/i18n/ns/common";
import { researchI18n } from "@/i18n/ns/research";

const NO_UPCOMING: UpcomingByTicker = new Map();

function readUrlParams() {
  try {
    const p = new URLSearchParams(window.location.search);
    const id = Number(p.get("id"));
    const ticker = (p.get("ticker") ?? "").trim().toUpperCase();
    const q = (p.get("q") ?? "").trim();
    const tag = (p.get("tag") ?? "").trim();
    return {
      id: Number.isInteger(id) && id > 0 ? id : null,
      q: q || (/^[A-Z][A-Z0-9.\-]{0,10}$/.test(ticker) ? `$${ticker}` : tag ? `#${tag}` : ""),
    };
  } catch {
    return { id: null, q: "" };
  }
}

function useIsDesktop() {
  const q = "(min-width: 1024px)";
  const [is, setIs] = useState(() => (typeof window !== "undefined" ? window.matchMedia(q).matches : true));
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setIs(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return is;
}

export default function ResearchArchivePage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { canEdit } = useAuth();
  const { t } = researchI18n.useT();
  const isDesktop = useIsDesktop();

  const { data: raw = [], isLoading, isError, error, refetch, isFetching } = useListResearch();
  const items = raw as ResearchNote[];

  const [query, setQuery] = useState(() => readUrlParams().q);
  const [selectedId, setSelectedId] = useState<number | null>(() => readUrlParams().id);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [editing, setEditing] = useState<Research | null>(null);

  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: getListResearchQueryKey() }), [qc]);
  const undo = useUndoDelete(invalidate);
  const itemsRef = useRef<ResearchNote[]>([]);
  itemsRef.current = items;
  const onMutErr = (e: unknown) =>
    toast({ title: commonI18n.t("states.error"), description: humanizeApiError(e), variant: "destructive" });

  const updateMut = useUpdateResearch({
    mutation: { onSuccess: () => { invalidate(); setEditing(null); toast({ title: researchI18n.t("toast.updated") }); }, onError: onMutErr },
  });
  const deleteMut = useDeleteResearch({
    mutation: {
      onSuccess: (_d, vars) => {
        const r = itemsRef.current.find((x) => x.id === vars.id);
        invalidate();
        setSelectedId((cur) => (cur === vars.id ? null : cur));
        setMobileOpen(false);
        undo.scheduleUndo(vars.id, "research", r?.patternName ? `«${r.patternName}»` : researchI18n.t("page.noteNumber", { id: vars.id }));
      },
      onError: onMutErr,
    },
  });

  const togglePin = useCallback(async (id: number) => {
    if (!canEdit) return;
    const next = !itemsRef.current.find((x) => x.id === id)?.pinned;
    qc.setQueriesData<ResearchNote[]>({ queryKey: getListResearchQueryKey() }, (old) => old?.map((x) => (x.id === id ? { ...x, pinned: next } : x)));
    try {
      await http.post(`/api/research/${id}/pin`, { pinned: next });
    } catch (e) {
      invalidate();
      toast({ title: researchI18n.t("toast.pinFailed"), description: humanizeApiError(e), variant: "destructive" });
    }
  }, [canEdit, qc, invalidate, toast]);

  async function saveScreenshotNotes(r: Research, notes: string) {
    try {
      await http.patch(`/api/research/${r.id}`, { screenshotNotes: notes });
      invalidate();
    } catch (err) {
      toast({ title: researchI18n.t("toast.saveFailed"), description: humanizeApiError(err), variant: "destructive" });
    }
  }

  const parsed = useMemo(() => parseQuery(query), [query]);
  const searching = !isEmptyQuery(parsed);
  const terms = useMemo(() => highlightTerms(parsed), [parsed]);

  const { list, hits } = useMemo(() => {
    const hits = new Map<number, SearchHit>();
    let list = [...items].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.createdAt.localeCompare(a.createdAt));
    if (searching) {
      list = list.filter((r) => { const h = matchResearch(r, parsed); if (h) hits.set(r.id, h); return !!h; });
      list.sort((a, b) => (hits.get(b.id)?.score ?? 0) - (hits.get(a.id)?.score ?? 0));
    }
    return { list, hits };
  }, [items, searching, parsed]);

  const selected = useMemo(() => items.find((r) => r.id === selectedId) ?? null, [items, selectedId]);
  useEffect(() => {
    if (!isDesktop || isLoading) return;
    if (selectedId != null && list.some((r) => r.id === selectedId)) return;
    setSelectedId(list[0]?.id ?? null);
  }, [isDesktop, isLoading, list, selectedId]);

  const related = useMemo(() => {
    if (!selected) return [];
    const ts = splitTickers(selected.ticker);
    const tags = splitTags(selected.tags);
    return items
      .filter((r) => r.id !== selected.id)
      .map((r) => ({ r, s: splitTickers(r.ticker).filter((t) => ts.includes(t)).length * 3 + splitTags(r.tags).filter((t) => tags.includes(t)).length }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.r);
  }, [selected, items]);

  const select = useCallback((id: number) => {
    setSelectedId(id);
    if (!window.matchMedia("(min-width: 1024px)").matches) setMobileOpen(true);
  }, []);

  // The open note is part of the URL (?id=), so a link to it can be shared or reopened.
  useEffect(() => {
    if (isLoading) return;
    try {
      const p = new URLSearchParams(window.location.search);
      if (selectedId != null) p.set("id", String(selectedId)); else p.delete("id");
      const qs = p.toString();
      const next = window.location.pathname + (qs ? `?${qs}` : "");
      if (next !== window.location.pathname + window.location.search) window.history.replaceState(window.history.state, "", next);
    } catch { /* ignore */ }
  }, [selectedId, isLoading]);

  // Keyboard: / — search, J/K or ↓/↑ — next/previous note (the selected row scrolls into view).
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (document.querySelector("[role=dialog], [role=alertdialog]")) return;
      const k = e.key.toLowerCase();
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); return; }
      // J/K also on the Russian layout (О/Л are the same physical keys).
      const dir = k === "j" || k === "о" || e.key === "ArrowDown" ? 1 : k === "k" || k === "л" || e.key === "ArrowUp" ? -1 : 0; // i18n-ignore
      if (!dir || !list.length || !isDesktop) return;
      e.preventDefault();
      const idx = list.findIndex((r) => r.id === selectedId);
      const next = list[Math.min(list.length - 1, Math.max(0, idx < 0 ? 0 : idx + dir))];
      if (!next) return;
      setSelectedId(next.id);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-research-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list, selectedId, isDesktop]);

  function handleSubmit(f: ResearchFormData) {
    const body = formToResearchBody(f);
    if (!body.patternName || !editing) return;
    updateMut.mutate({ id: editing.id, data: body as UpdateResearchBody });
  }

  const previewProps = selected
    ? {
        r: selected,
        terms,
        pinned: !!selected.pinned,
        related,
        upcoming: NO_UPCOMING,
        onTogglePin: () => togglePin(selected.id),
        onEdit: () => (canEdit ? setEditing(selected) : undefined),
        onDelete: () => deleteMut.mutate({ id: selected.id }),
        onSelect: select,
        onSaveScreenshotNotes: (n: string) => saveScreenshotNotes(selected, n),
      }
    : null;

  return (
    <Page>
      <PageHeader
        icon={Archive}
        title={t("page.title")}
        description={t("page.description")}
      />

      <Panel>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <p className="min-w-0 flex-1 text-sm text-foreground">
            {t("page.merged")} <span className="text-muted-foreground">{t("page.mergedHint")}</span>
          </p>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/events"><CalendarClock className="h-4 w-4" /> {t("page.catalysts")} <ArrowRight className="h-3.5 w-3.5" /></Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/playbook"><BookMarked className="h-4 w-4" /> {t("page.playbook")} <ArrowRight className="h-3.5 w-3.5" /></Link>
            </Button>
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 items-start gap-[var(--grid-gap)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Panel
          padded={false}
          title={t("page.notes")}
          description={isLoading ? commonI18n.t("states.loading") : searching ? t("page.found", { count: list.length, total: items.length }) : t("page.inArchive", { count: items.length })}
          actions={list.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => exportResearchCsv(list)} title={searching ? t("page.csvFound") : t("page.csvAll")}>
              <Download className="h-4 w-4" aria-hidden="true" /> CSV
            </Button>
          ) : undefined}
        >
          {items.length > 3 && (
            <div className="relative px-[var(--panel-p)] pt-3">
              <Search className="pointer-events-none absolute left-[calc(var(--panel-p)+0.875rem)] top-1/2 mt-1.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("page.searchPlaceholder")} aria-label={t("page.searchAria")} className="pl-10 pr-10" />
              {query && (
                <button type="button" onClick={() => setQuery("")} aria-label={commonI18n.t("actions.clearSearch")} className="absolute right-[calc(var(--panel-p)+0.375rem)] top-1/2 mt-1.5 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:text-foreground">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
          <div className="flex min-h-[200px] flex-col gap-0.5 px-2 pb-3 pt-3 lg:max-h-[calc(100vh-16rem)] lg:overflow-y-auto">
            {isLoading && Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-2 px-2 py-2">
                <Skeleton className="h-4 w-2/3 rounded-full" />
                <Skeleton className="h-3 w-full rounded-full" />
              </div>
            ))}
            {isError && !isLoading && (
              <EmptyState
                icon={AlertTriangle}
                title={t("page.loadFailed")}
                description={humanizeApiError(error)}
                action={<Button variant="outline" onClick={() => refetch()} disabled={isFetching}><RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} /> {commonI18n.t("actions.retry")}</Button>}
              />
            )}
            {!isLoading && !isError && list.length === 0 && (
              items.length ? (
                <EmptyState compact icon={Search} title={commonI18n.t("states.nothingFound")} description={t("page.tryOtherWords")} />
              ) : (
                <EmptyState icon={Archive} title={t("page.emptyTitle")} description={t("page.emptyText")} />
              )
            )}
            {list.map((r) => (
              <ResearchRow
                key={r.id}
                r={r}
                selected={isDesktop && r.id === selectedId}
                pinned={!!r.pinned}
                terms={terms}
                hit={hits.get(r.id)}
                upcoming={NO_UPCOMING}
                showDate
                onSelect={select}
                onTogglePin={togglePin}
              />
            ))}
          </div>
        </Panel>

        {isDesktop && (
          <Panel className="sticky-top hidden lg:block" bodyClassName="lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto">
            {previewProps ? (
              <ResearchPreview key={previewProps.r.id} {...previewProps} />
            ) : isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-7 w-2/3 rounded-full" />
                <Skeleton className="h-24 w-full rounded-xl" />
              </div>
            ) : (
              <EmptyState icon={Archive} title={t("page.selectTitle")} description={t("page.selectText")} />
            )}
          </Panel>
        )}
      </div>

      {!isDesktop && (
        <Sheet open={mobileOpen && !!previewProps} onOpenChange={setMobileOpen}>
          <SheetContent side="bottom" className="max-h-[88vh] overflow-y-auto rounded-t-3xl px-4 pb-8 pt-10">
            <SheetHeader className="sr-only">
              <SheetTitle>{selected?.patternName ?? t("page.note")}</SheetTitle>
              <SheetDescription>{t("page.noteView")}</SheetDescription>
            </SheetHeader>
            {previewProps && <ResearchPreview key={previewProps.r.id} {...previewProps} />}
          </SheetContent>
        </Sheet>
      )}

      <ResearchFormDialog
        open={!!editing}
        editing={editing}
        initial={null}
        saving={updateMut.isPending}
        onOpenChange={(v) => { if (!v) setEditing(null); }}
        onSubmit={handleSubmit}
      />

      {undo.pending && (
        <UndoToast key={undo.pending.id} label={undo.pending.label} onUndo={undo.restore} onDismiss={undo.dismiss} restoring={undo.restoring} actionText={t("page.deleted")} />
      )}
    </Page>
  );
}
