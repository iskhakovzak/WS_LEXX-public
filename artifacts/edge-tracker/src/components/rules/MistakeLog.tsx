import { forwardRef, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { links } from "@/lib/links";
import { CheckCircle2, Circle, Download, NotebookPen, Pencil, Search, Trash2 } from "lucide-react";
import { EmptyState, FilterChip, Panel, Pill, Segmented, Toolbar } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { http } from "@/lib/api/http";
import { humanizeApiError } from "@/lib/api/errors";
import { mistakeLabel, severityMeta } from "./constants";
import { commonI18n } from "@/i18n/ns/common";
import { rulesI18n } from "@/i18n/ns/rules";
import { personName } from "@/i18n";
import { fmtDate, fmtR, fmtUsd } from "@/lib/format";
import { mistakeDate } from "./discipline";
import type { Mistake } from "./types";

type Status = "all" | "open" | "done";

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded bg-primary/25 px-0.5 text-foreground">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const MistakeLog = forwardRef<HTMLInputElement, {
  mistakes: Mistake[];
  trader: string;
  onNew: () => void;
  onEdit: (m: Mistake) => void;
  onChanged: () => void;
}>(function MistakeLog({ mistakes, trader, onNew, onEdit, onChanged }, searchRef) {
  const { t } = rulesI18n.useT();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [cats, setCats] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [lessonFor, setLessonFor] = useState<number | null>(null);
  const [lessonDraft, setLessonDraft] = useState("");

  const catCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of mistakes) m.set(x.errorType, (m.get(x.errorType) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [mistakes]);

  const openCount = mistakes.filter((m) => m.resolved !== "yes").length;
  const q = query.trim();
  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    return mistakes.filter((m) => {
      if (status === "open" && m.resolved === "yes") return false;
      if (status === "done" && m.resolved !== "yes") return false;
      if (cats.length && !cats.includes(m.errorType)) return false;
      if (ql) {
        const hay = `${m.errorType} ${mistakeLabel(m.errorType)} ${m.description} ${m.lesson ?? ""} ${m.ticker ?? ""}`.toLowerCase();
        if (!hay.includes(ql)) return false;
      }
      return true;
    });
  }, [mistakes, status, cats, q]);

  async function patch(m: Mistake, body: Record<string, unknown>, okMsg: string) {
    setBusyId(m.id);
    try {
      await http.patch(`/api/errors/${m.id}`, body);
      toast({ title: okMsg });
      onChanged();
      return true;
    } catch (e) {
      toast({ title: commonI18n.t("states.error"), description: humanizeApiError(e, commonI18n.t("states.saveFailed")), variant: "destructive" });
      return false;
    } finally {
      setBusyId(null);
    }
  }

  /** Removal is archived on the server (trading_errors_archive) — the toast offers an undo. */
  async function remove(m: Mistake) {
    setBusyId(m.id);
    try {
      await http.del(`/api/errors/${m.id}`);
      onChanged();
      toast({
        title: t("log.deleted"),
        description: mistakeLabel(m.errorType),
        action: (
          <ToastAction
            altText={t("log.restoreAlt")}
            onClick={async () => {
              try {
                await http.post(`/api/errors/${m.id}/restore`);
                onChanged();
              } catch (e) {
                toast({ title: commonI18n.t("states.error"), description: humanizeApiError(e, t("log.restoreFailed")), variant: "destructive" });
              }
            }}
          >
            {commonI18n.t("actions.restore")}
          </ToastAction>
        ),
      });
    } catch (e) {
      toast({ title: t("log.deleteError"), description: humanizeApiError(e, commonI18n.t("states.deleteFailed")), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  function exportCsv() {
    const head = [t("log.csv.date"), t("log.csv.category"), t("log.csv.severity"), t("log.csv.ticker"), t("log.csv.trade"), "R", t("log.csv.net"), t("log.csv.description"), t("log.csv.lesson"), t("log.csv.reviewed")];
    const rows = filtered.map((m) => [
      mistakeDate(m), mistakeLabel(m.errorType), severityMeta(m.severity).label, m.ticker ?? "", m.tradeId ?? "",
      m.tradeR ?? "", m.tradeNetPnl ?? m.tradePnl ?? "", m.description, m.lesson ?? "", m.resolved === "yes" ? commonI18n.t("yes") : commonI18n.t("no"),
    ]);
    const csv = "﻿" + [head, ...rows].map((r) => r.map(csvCell).join(";")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${t("log.csv.file")}-${personName(trader)}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (mistakes.length === 0) {
    return (
      <Panel>
        <EmptyState
          icon={NotebookPen}
          title={t("log.emptyTitle")}
          description={t("log.emptyDesc")}
          action={<Button onClick={onNew}>{t("log.first")}</Button>}
        />
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Toolbar>
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("log.searchPlaceholder")}
            aria-label={t("log.searchAria")}
            className="pl-9"
            onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); (e.target as HTMLInputElement).blur(); } }}
          />
        </div>
        <Segmented<Status>
          ariaLabel={t("log.statusAria")}
          size="sm"
          value={status}
          onChange={setStatus}
          options={[
            { value: "all", label: commonI18n.t("states.all"), count: mistakes.length },
            { value: "open", label: t("log.open"), count: openCount },
            { value: "done", label: t("log.done"), count: mistakes.length - openCount },
          ]}
        />
        <Button variant="outline" size="icon" aria-label={t("log.export")} title={t("log.export")} onClick={exportCsv}>
          <Download />
        </Button>
      </Toolbar>

      {catCounts.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("log.catsAria")}>
          {catCounts.slice(0, 12).map(([c, n]) => (
            <FilterChip
              key={c}
              active={cats.includes(c)}
              count={n}
              className="min-h-7 px-2.5 text-xs"
              onClick={() => setCats((xs) => (xs.includes(c) ? xs.filter((x) => x !== c) : [...xs, c]))}
            >
              {mistakeLabel(c)}
            </FilterChip>
          ))}
          {cats.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setCats([])}>{commonI18n.t("actions.reset")}</Button>
          )}
        </div>
      )}

      {filtered.length === 0 ? (
        <Panel><EmptyState icon={Search} title={commonI18n.t("states.nothingFound")} description={t("log.changeFilters")} /></Panel>
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((m) => {
            const sev = severityMeta(m.severity);
            const done = m.resolved === "yes";
            const busy = busyId === m.id;
            return (
              <li key={m.id} className={cn("glass-panel relative overflow-hidden rounded-2xl p-4 pl-5 transition-opacity", done && "opacity-75")}>
                <span className={cn("absolute inset-y-0 left-0 w-1", sev.bar)} aria-hidden="true" />
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => patch(m, { resolved: done ? "no" : "yes" }, done ? t("log.reopened") : t("log.markedDone"))}
                    aria-label={done ? t("log.markUndone") : t("log.markDone")}
                    title={done ? t("log.markUndone") : t("log.markDone")}
                    aria-pressed={done}
                    className="-ml-1 mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--glass-hover-bg)] hover:text-up focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    {done ? <CheckCircle2 className="h-5 w-5 text-up" /> : <Circle className="h-5 w-5" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn("font-semibold", done && "line-through decoration-muted-foreground/60")}>
                        <Highlight text={mistakeLabel(m.errorType)} q={q} />
                      </span>
                      <Pill tone={sev.tone}>{sev.label}</Pill>
                      {m.tradeId ? (
                        <button
                          type="button"
                          onClick={() => navigate(links.trade(m.tradeId!))}
                          className="chip inline-flex min-h-6 items-center gap-1 px-2 text-xs font-medium"
                          title={t("log.openTrade")}
                        >
                          {m.ticker ?? `#${m.tradeId}`}
                          {m.tradeNetPnl != null ? (
                            <span className={m.tradeNetPnl < 0 ? "text-down" : m.tradeNetPnl > 0 ? "text-up" : ""}>{fmtUsd(m.tradeNetPnl, { signed: true, decimals: "trim" })}</span>
                          ) : m.tradeR != null ? (
                            <span className={m.tradeR < 0 ? "text-down" : "text-up"}>{fmtR(m.tradeR, 1)}</span>
                          ) : null}
                        </button>
                      ) : m.ticker ? (
                        <Pill><Highlight text={m.ticker} q={q} /></Pill>
                      ) : null}
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">{fmtDate(mistakeDate(m), "dayMonth")}</span>
                    </div>
                    {m.description && m.description !== m.errorType && (
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground"><Highlight text={m.description} q={q} /></p>
                    )}
                    {lessonFor === m.id ? (
                      <div className="mt-2 flex flex-col gap-2">
                        <Textarea
                          autoFocus
                          rows={2}
                          value={lessonDraft}
                          maxLength={4000}
                          aria-label={t("log.lesson")}
                          placeholder={t("log.lessonPlaceholder")}
                          onChange={(e) => setLessonDraft(e.target.value)}
                          onKeyDown={async (e) => {
                            if (e.key === "Escape") { e.stopPropagation(); setLessonFor(null); }
                            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                              e.preventDefault();
                              if (await patch(m, { lesson: lessonDraft }, t("log.lessonSaved"))) setLessonFor(null);
                            }
                          }}
                        />
                        <div className="flex gap-2">
                          <Button size="sm" disabled={busy} onClick={async () => { if (await patch(m, { lesson: lessonDraft }, t("log.lessonSaved"))) setLessonFor(null); }}>{commonI18n.t("actions.save")}</Button>
                          <Button size="sm" variant="ghost" onClick={() => setLessonFor(null)}>{commonI18n.t("actions.cancel")}</Button>
                        </div>
                      </div>
                    ) : m.lesson ? (
                      <button
                        type="button"
                        onClick={() => { setLessonFor(m.id); setLessonDraft(m.lesson ?? ""); }}
                        className="mt-2 block w-full rounded-xl bg-primary/10 px-3 py-2 text-left text-sm text-foreground hover:bg-primary/15"
                        title={t("log.editLesson")}
                      >
                        <span className="micro-label mr-2 text-primary">{t("log.lesson")}</span>
                        <Highlight text={m.lesson} q={q} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setLessonFor(m.id); setLessonDraft(""); }}
                        className="mt-1.5 text-xs font-medium text-primary hover:underline"
                      >
                        {t("log.addLesson")}
                      </button>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-0.5">
                    <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("log.edit")} title={t("log.edit")} onClick={() => onEdit(m)}>
                      <Pencil className="!size-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-down" aria-label={commonI18n.t("actions.delete")} title={commonI18n.t("actions.delete")} disabled={busy} onClick={() => remove(m)}>
                      <Trash2 className="!size-3.5" />
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

    </div>
  );
});
