import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Ban, Check, ExternalLink, Flag, MessageCircle, MessagesSquare, MoreHorizontal, ShieldCheck, Trash2, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { QueryError } from "@/components/query-error";
import { EmptyState, Kbd, Panel, Pill, Segmented } from "@/components/ds";
import { cn } from "@/lib/utils";
import { ReasonDialog, type ReasonDialogState } from "./ReasonDialog";
import { banPresets } from "./useUserActions";
import { http } from "@/lib/api/http";
import { isNotFound } from "@/lib/api/errors";
import { adminUrl, isTypingTarget, roleLabel, timeAgo, useReports, type ContentReport } from "./api";
import { adminI18n } from "@/i18n/ns/admin";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

type Status = "open" | "resolved" | "dismissed" | "all";

/** Quick-pick lists in the UI language (the chosen text is stored as the resolution). */
const presets = (k: "resolvePresets" | "dismissPresets" | "removePresets") => adminI18n.t(`moderation.${k}`).split("|");

const EASE = [0.2, 0.8, 0.2, 1] as const;

export function ModerationQueue({ actor, openCount }: { actor: string; openCount?: number }) {
  const { toast } = useToast();
  const { t } = adminI18n.useT();
  const qc = useQueryClient();
  const reduce = useReducedMotion();
  const [status, setStatus] = useState<Status>("open");
  const [dialog, setDialog] = useState<ReasonDialogState>(null);
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const apiStatus = status === "all" ? "" : status;
  const { data: reports = [], isLoading, isError, error, refetch } = useReports(actor, apiStatus);
  // Per-row layout/enter animation only on short lists (the «Все» filter can hold hundreds).
  const animateRows = !reduce && reports.length <= 30;

  const invalidate = () => {
    for (const k of ["admin-reports", "admin-overview", "admin-audit", "admin-desk-pulse", "admin-users"]) qc.invalidateQueries({ queryKey: [k] });
  };
  const onError = (e: Error) => { toast({ title: commonI18n.t("states.error"), description: e.message, variant: "destructive" }); invalidate(); };

  /** Optimistically drop a report from the open queue. */
  const dropOptimistic = (ids: number[]) => {
    if (status !== "open") return;
    qc.setQueryData<ContentReport[]>(["admin-reports", actor, apiStatus], (old) => old?.filter((r) => !ids.includes(r.id)));
  };

  const resolveMut = useMutation({
    mutationFn: ({ id, kind, resolution }: { id: number; kind: "resolve" | "dismiss"; resolution: string }) =>
      http.post(adminUrl(`/admin/reports/${id}/${kind}`, actor), { actor, resolution }),
    onMutate: ({ id }) => { setDialog(null); dropOptimistic([id]); },
    onSuccess: (_d, v) => { invalidate(); toast({ title: v.kind === "resolve" ? t("moderation.resolvedToast") : t("moderation.dismissedToast"), description: v.resolution }); },
    onError,
  });

  const [checked, setChecked] = useState<Set<number>>(new Set());
  useEffect(() => { setChecked(new Set()); }, [status]);
  const toggleChecked = (id: number) => setChecked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const bulkMut = useMutation({
    mutationFn: ({ ids, kind, resolution }: { ids: number[]; kind: "resolve" | "dismiss"; resolution: string }) =>
      http.post<{ updated: number[]; skipped: number[] }>(adminUrl("/admin/reports/bulk", actor), { actor, ids, kind, resolution }),
    onMutate: ({ ids }) => { setDialog(null); dropOptimistic(ids); setChecked(new Set()); },
    onSuccess: (d, v) => {
      invalidate();
      toast({
        title: v.kind === "resolve" ? t("moderation.bulkResolved", { count: d.updated.length }) : t("moderation.bulkDismissed", { count: d.updated.length }),
        description: d.skipped.length ? t("moderation.bulkSkipped", { count: d.skipped.length }) : v.resolution,
      });
    },
    onError,
  });
  const openIds = reports.filter((r) => r.status === "open").map((r) => r.id);
  const bulk = (kind: "resolve" | "dismiss") => {
    const ids = [...checked];
    setDialog({
      title: kind === "resolve" ? t("moderation.bulkResolveTitle", { count: ids.length }) : t("moderation.bulkDismissTitle", { count: ids.length }),
      description: t("moderation.bulkText"),
      confirmLabel: kind === "resolve" ? t("moderation.resolveAll") : t("moderation.dismissAll"),
      input: { label: kind === "resolve" ? t("moderation.resolution") : t("moderation.dismissReason"), required: true, presets: presets(kind === "resolve" ? "resolvePresets" : "dismissPresets") },
      onConfirm: (resolution) => bulkMut.mutate({ ids, kind, resolution }),
    });
  };

  const banAuthorMut = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string; author: string }) =>
      http.post<{ closedReports: number[] }>(adminUrl(`/admin/reports/${id}/ban-author`, actor), { actor, reason, resolveSiblings: true }),
    onMutate: ({ id }) => { setDialog(null); dropOptimistic([id]); },
    onSuccess: (d, v) => {
      invalidate();
      toast({ title: t("moderation.authorBanned", { name: personName(v.author) }), description: t("moderation.reportsClosed", { count: d.closedReports?.length ?? 1 }) });
    },
    onError,
  });

  const deleteMut = useMutation({
    mutationFn: async ({ report, reason }: { report: ContentReport; reason: string }) => {
      const path = report.targetType === "discussion" ? "discussions" : "comments";
      await http.del(`/api/admin/${path}/${encodeURIComponent(report.targetId)}`, undefined, { query: { actor } }).catch((e) => {
        if (!isNotFound(e)) throw e;
      });
      await http.post(adminUrl(`/admin/reports/${report.id}/resolve`, actor), { actor, resolution: t("moderation.contentRemoved", { reason }) });
    },
    onMutate: ({ report }) => { setDialog(null); dropOptimistic([report.id]); },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/discussions"] }); invalidate(); toast({ title: t("moderation.contentRemovedToast") }); },
    onError,
  });

  const busy = resolveMut.isPending || banAuthorMut.isPending || deleteMut.isPending || bulkMut.isPending;

  const act = useMemo(() => ({
    resolve: (r: ContentReport) => setDialog({
      title: t("moderation.resolve.title", { id: r.id }),
      description: t("moderation.resolve.text"),
      confirmLabel: t("moderation.resolve.confirm"),
      input: { label: t("moderation.resolution"), required: true, presets: presets("resolvePresets"), placeholder: t("moderation.resolve.placeholder") },
      onConfirm: (resolution) => resolveMut.mutate({ id: r.id, kind: "resolve", resolution }),
    }),
    dismiss: (r: ContentReport) => setDialog({
      title: t("moderation.dismiss.title", { id: r.id }),
      confirmLabel: t("moderation.dismiss.confirm"),
      input: { label: t("moderation.dismissReason"), required: true, presets: presets("dismissPresets") },
      onConfirm: (resolution) => resolveMut.mutate({ id: r.id, kind: "dismiss", resolution }),
    }),
    ban: (r: ContentReport) => {
      const author = r.target?.author;
      if (!author) { toast({ title: t("moderation.noAuthor"), description: t("moderation.noAuthorHint"), variant: "destructive" }); return; }
      const more = (r.openReportsOnTarget ?? 1) - 1;
      setDialog({
        title: t("moderation.ban.title", { name: personName(author) }),
        description: more > 0 ? t("moderation.ban.textMore", { name: personName(author), count: more }) : t("moderation.ban.text", { name: personName(author) }),
        confirmLabel: t("moderation.ban.confirm"),
        destructive: true,
        input: { label: t("moderation.ban.reason"), kind: "textarea", required: true, presets: banPresets() },
        onConfirm: (reason) => banAuthorMut.mutate({ id: r.id, reason, author }),
      });
    },
    remove: (r: ContentReport) => setDialog({
      title: r.targetType === "discussion" ? t("moderation.removeDiscussion.title") : t("moderation.removeComment.title"),
      description: r.targetType === "discussion" ? t("moderation.removeDiscussion.text") : t("moderation.removeComment.text"),
      confirmLabel: t("moderation.removeConfirm"),
      destructive: true,
      input: { label: t("moderation.removeReason"), required: true, presets: presets("removePresets") },
      onConfirm: (reason) => deleteMut.mutate({ report: r, reason }),
    }),
  }), [resolveMut, banAuthorMut, deleteMut, toast, t]);

  // Keyboard triage: J/K move, R resolve, D dismiss, B ban author, X delete content.
  useEffect(() => { setSelected((s) => Math.min(s, Math.max(0, reports.length - 1))); }, [reports.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog || isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector("[role=dialog]")) return;
      const k = e.key.toLowerCase();
      if (k === "j" || (k === "arrowdown" && e.target === document.body)) { setSelected((s) => Math.min(reports.length - 1, s + 1)); e.preventDefault(); return; }
      if (k === "k" || (k === "arrowup" && e.target === document.body)) { setSelected((s) => Math.max(0, s - 1)); e.preventDefault(); return; }
      const r = reports[selected];
      if (!r || r.status !== "open" || busy) return;
      if (k === "s") { e.preventDefault(); toggleChecked(r.id); }
      else if (k === "r") { e.preventDefault(); act.resolve(r); }
      else if (k === "d") { e.preventDefault(); act.dismiss(r); }
      else if (k === "b") { e.preventDefault(); act.ban(r); }
      else if (k === "x") { e.preventDefault(); act.remove(r); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reports, selected, dialog, busy, act]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`)?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [selected, reduce]);

  return (
    <Panel
      title={t("moderation.title")}
      description={t("moderation.description")}
      icon={Flag}
      actions={
        <Segmented<Status>
          ariaLabel={t("moderation.statusAria")}
          size="sm"
          value={status}
          onChange={(s) => { setStatus(s); setSelected(0); }}
          options={[
            { value: "open", label: t("moderation.tab.open"), count: openCount },
            { value: "resolved", label: t("moderation.tab.resolved") },
            { value: "dismissed", label: t("moderation.tab.dismissed") },
            { value: "all", label: t("moderation.tab.all") },
          ]}
        />
      }
    >
      <div className="flex flex-col gap-3">
        {status === "open" && reports.length > 0 && (
          <p className="hidden flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground md:flex">
            <span><Kbd>J</Kbd> <Kbd>K</Kbd> {t("moderation.keys.nav")}</span>
            <span><Kbd>R</Kbd> {t("moderation.keys.resolve")}</span>
            <span><Kbd>D</Kbd> {t("moderation.keys.dismiss")}</span>
            <span><Kbd>B</Kbd> {t("moderation.keys.ban")}</span>
            <span><Kbd>X</Kbd> {t("moderation.keys.remove")}</span>
            <span><Kbd>S</Kbd> {t("moderation.keys.select")}</span>
          </p>
        )}

        {status === "open" && openIds.length > 1 && (
          <div
            className={cn(
              "flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 transition-colors",
              checked.size ? "bg-primary/10" : "bg-[var(--glass-bg)]",
            )}
            role="toolbar"
            aria-label={t("moderation.bulkAria")}
          >
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[hsl(var(--primary))]"
                checked={checked.size > 0 && openIds.every((id) => checked.has(id))}
                ref={(el) => { if (el) el.indeterminate = checked.size > 0 && !openIds.every((id) => checked.has(id)); }}
                onChange={(e) => setChecked(e.target.checked ? new Set(openIds) : new Set())}
                aria-label={t("moderation.selectAllOpen")}
              />
              {checked.size ? <span className="tabular-nums">{t("moderation.selected", { count: checked.size })}</span> : <span className="text-muted-foreground">{t("moderation.selectAll")}</span>}
            </label>
            {checked.size > 0 && (
              <div className="ml-auto flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => bulk("resolve")} disabled={busy}><Check className="text-up" /> {t("moderation.resolveSelected")}</Button>
                <Button size="sm" variant="outline" onClick={() => bulk("dismiss")} disabled={busy}><X /> {t("moderation.dismissSelected")}</Button>
                <Button size="sm" variant="ghost" onClick={() => setChecked(new Set())}>{t("moderation.clearSelection")}</Button>
              </div>
            )}
          </div>
        )}

        {isError ? (
          <QueryError error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label={commonI18n.t("states.loading")}>
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-32 w-full rounded-xl" />)}
          </div>
        ) : reports.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title={status === "open" ? t("moderation.emptyOpen") : t("moderation.emptyOther")}
            description={status === "open" ? t("moderation.emptyOpenHint") : undefined}
          />
        ) : (
          <ul ref={listRef} className="flex flex-col gap-2" aria-label={t("moderation.listAria")}>
            <AnimatePresence initial={false}>
              {reports.map((r, i) => (
                <motion.li
                  key={r.id}
                  data-idx={i}
                  layout={animateRows}
                  initial={animateRows ? { opacity: 0, y: 6 } : false}
                  animate={{ opacity: 1, y: 0 }}
                  exit={animateRows ? { opacity: 0, x: 24, transition: { duration: 0.18 } } : { opacity: 0 }}
                  transition={{ duration: 0.2, ease: EASE }}
                  onClick={() => setSelected(i)}
                  aria-current={i === selected ? "true" : undefined}
                  className={cn(
                    "glass-panel group flex flex-col gap-3 rounded-xl p-4 transition-shadow",
                    i === selected && status === "open" && "ring-2 ring-primary/50",
                  )}
                >
                  <ReportCard r={r} busy={busy} act={act} checked={checked.has(r.id)} onToggle={() => toggleChecked(r.id)} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
      <ReasonDialog state={dialog} onClose={() => setDialog(null)} busy={busy} />
    </Panel>
  );
}

function ReportCard({
  r,
  busy,
  act,
  checked,
  onToggle,
}: {
  r: ContentReport;
  busy: boolean;
  act: Record<"resolve" | "dismiss" | "ban" | "remove", (r: ContentReport) => void>;
  checked: boolean;
  onToggle: () => void;
}) {
  const { t: tr } = adminI18n.useT();
  const t = r.target;
  const isDiscussion = r.targetType === "discussion";
  const Icon = isDiscussion ? MessagesSquare : MessageCircle;
  const threadHref = t?.discussionId ? `/discussions?thread=${t.discussionId}` : null;
  const many = (r.openReportsOnTarget ?? 0) > 1;
  const canBan = !!t?.author && !t.authorBanned && t.authorRole !== "admin";
  const [fullText, setFullText] = useState(false);
  const longPreview = (t?.preview?.length ?? 0) > 240;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {r.status === "open" && (
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0 cursor-pointer accent-[hsl(var(--primary))]"
            checked={checked}
            onChange={onToggle}
            onClick={(e) => e.stopPropagation()}
            aria-label={tr("moderation.selectReport", { id: r.id })}
          />
        )}
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--glass-bg)] text-muted-foreground">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {isDiscussion ? tr("moderation.discussion") : tr("moderation.comment")}
            {t?.title ? <span className="text-muted-foreground"> · «{t.title}»</span> : <span className="text-muted-foreground"> #{r.targetId}</span>}
          </div>
          <div className="text-xs text-muted-foreground">{tr("moderation.reportMeta", { id: r.id, ago: timeAgo(r.createdAt) })}</div>
        </div>
        {many && <Pill tone="down">{tr("moderation.reportsCount", { count: r.openReportsOnTarget ?? 0 })}</Pill>}
        <Pill tone={r.status === "open" ? "warn" : r.status === "resolved" ? "up" : "neutral"} dot>{adminI18n.tryT(`moderation.status.${r.status}`) ?? r.status}</Pill>
      </div>

      {(t?.preview || t?.deleted) && (
        <blockquote className="rounded-xl border-l-2 border-[var(--glass-border)] bg-[var(--glass-bg)] px-3 py-2 text-sm">
          {t?.deleted
            ? <span className="italic text-muted-foreground">{tr("moderation.deleted")}</span>
            : (
              <>
                <span className={cn("whitespace-pre-line break-words text-foreground/90", !fullText && "line-clamp-3")}>{t?.preview}</span>
                {longPreview && (
                  <button type="button" onClick={(e) => { e.stopPropagation(); setFullText((v) => !v); }} className="mt-1 block text-xs text-primary hover:underline">
                    {fullText ? commonI18n.t("actions.collapse") : tr("moderation.showFull")}
                  </button>
                )}
              </>
            )}
          {t?.author && (
            <footer className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {tr("moderation.author")} <span className="font-medium text-foreground">{personName(t.author)}</span>
              {t.authorRole && t.authorRole !== "trader" && <Pill tone="accent">{roleLabel(t.authorRole)}</Pill>}
              {t.authorBanned && <Pill tone="down">{tr("moderation.banned")}</Pill>}
            </footer>
          )}
        </blockquote>
      )}

      <div className="text-sm">
        <span className="text-muted-foreground">{personName(r.reporter)}: </span>
        <span className="break-words">«{r.reason}»</span>
      </div>

      {r.resolution && (
        <div className="text-xs text-muted-foreground">
          {r.status === "dismissed" ? tr("moderation.dismissedBy") : tr("moderation.resolvedBy")}{r.resolvedBy ? ` · ${r.resolvedBy}` : ""}{r.resolvedAt ? ` · ${timeAgo(r.resolvedAt)}` : ""}: <span className="text-foreground/90">{r.resolution}</span>
        </div>
      )}

      {r.status === "open" && (
        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--glass-border)] pt-3">
          <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); act.resolve(r); }} disabled={busy}>
            <Check className="text-up" /> {tr("moderation.actionResolve")}
          </Button>
          <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); act.dismiss(r); }} disabled={busy}>
            <X /> {tr("moderation.actionDismiss")}
          </Button>
          <Button size="sm" variant="destructive" onClick={(e) => { e.stopPropagation(); act.ban(r); }} disabled={busy || !canBan} title={!canBan ? (t?.authorBanned ? tr("moderation.alreadyBanned") : tr("moderation.cantBan")) : undefined}>
            <Ban /> {tr("moderation.actionBan")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="ml-auto h-8 w-8" aria-label={tr("moderation.more", { id: r.id })} onClick={(e) => e.stopPropagation()}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {threadHref && (
                <DropdownMenuItem asChild>
                  <Link href={threadHref}><ExternalLink /> {tr("moderation.openThread")}</Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!!t?.deleted} onSelect={() => act.remove(r)} className="text-down focus:text-down">
                <Trash2 /> {tr("moderation.removeAndClose")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {r.status !== "open" && threadHref && (
        <Link href={threadHref} className="inline-flex w-fit items-center gap-1 text-xs text-primary hover:underline">
          <ExternalLink className="h-3 w-3" aria-hidden="true" /> {tr("moderation.openThread")}
        </Link>
      )}
    </>
  );
}
