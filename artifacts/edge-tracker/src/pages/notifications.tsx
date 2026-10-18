/**
 * /notifications — full inbox: filters (tab, group/type, severity), bulk read/archive, keyboard
 * navigation (↑/↓ or J/K, Enter, R, E, X, Esc) and the preferences panel.
 * Reads ?tab=inbox|archive|prefs, ?unread=1, ?type=a,b, ?severity=warn,critical from the URL.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, Bell, CheckCheck, Inbox, Loader2, RefreshCw, Settings2, SquareCheckBig, SquareDashed, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState, FilterChip, Kbd, Page, PageHeader, Panel, Pill, Segmented, Toolbar } from "@/components/ds";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QueryError } from "@/components/query-error";
import { Skeleton } from "@/components/ui/skeleton";
import { NotificationItem } from "@/components/notifications/notification-item";
import { NotificationPrefsPanel } from "@/components/notifications/notification-prefs";
import {
  GROUP_LABELS, GROUP_ORDER, SEVERITY_LABEL, SEVERITY_ORDER, SEVERITY_TONE, TYPES, groupByDay,
  type ListFilters, type Notification, type NotificationGroup, type Severity,
} from "@/components/notifications/model";
import { useMe, useNotificationActions, useNotificationList, useOpenNotification, useUnreadCount } from "@/components/notifications/use-notifications";
import { UndoToast } from "@/components/undo-toast";
import { notificationsI18n } from "@/i18n/ns/notifications";
import { commonI18n } from "@/i18n/ns/common";

type Tab = "inbox" | "archive" | "prefs";
const ALL = "__all__";

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable || el.getAttribute("role") === "combobox";
}

function readUrl(): { tab: Tab; unread: boolean; types: string[]; severities: Severity[] } {
  const p = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const tab = p.get("tab");
  const sev = (p.get("severity") ?? "").split(",").filter((s): s is Severity => s === "info" || s === "warn" || s === "critical");
  return {
    tab: tab === "archive" || tab === "prefs" ? tab : "inbox",
    unread: p.get("unread") === "1",
    types: (p.get("type") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    severities: sev,
  };
}

export default function NotificationsPage() {
  const { t } = notificationsI18n.useT();
  const { t: tc } = commonI18n.useT();
  const me = useMe();
  const initial = useMemo(readUrl, []);
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [unreadOnly, setUnreadOnly] = useState(initial.unread);
  const [group, setGroup] = useState<NotificationGroup | typeof ALL>(ALL);
  const [types, setTypes] = useState<string[]>(initial.types);
  const [severities, setSeverities] = useState<Severity[]>(initial.severities);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [focusIdx, setFocusIdx] = useState<number>(-1);
  const lastClickRef = useRef<number | null>(null);
  // «Отменить» for anything sent to the archive from the inbox (E, bulk, «Архивировать прочитанные»).
  const [undo, setUndo] = useState<{ ids: number[]; label: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the URL in sync (shareable filters, back/forward friendly).
  useEffect(() => {
    const p = new URLSearchParams();
    if (tab !== "inbox") p.set("tab", tab);
    if (unreadOnly) p.set("unread", "1");
    if (types.length) p.set("type", types.join(","));
    if (severities.length) p.set("severity", severities.join(","));
    const qs = p.toString();
    const next = `/notifications${qs ? `?${qs}` : ""}`;
    if (`${window.location.pathname}${window.location.search}` !== next) window.history.replaceState(null, "", next);
  }, [tab, unreadOnly, types, severities]);

  const effectiveTypes = useMemo(() => {
    if (types.length) return types;
    if (group !== ALL) return TYPES.filter((t) => t.group === group).map((t) => t.type);
    return [];
  }, [types, group]);

  const filters: ListFilters = useMemo(
    () => ({ unread: tab === "inbox" && unreadOnly, types: effectiveTypes, severities, archived: tab === "archive" ? "1" : "0", limit: 40 }),
    [tab, unreadOnly, effectiveTypes, severities],
  );

  const list = useNotificationList(filters, tab !== "prefs");
  const { data: count } = useUnreadCount();
  const actions = useNotificationActions();
  const open = useOpenNotification();
  const items = list.items;
  const groups = useMemo(() => groupByDay(items), [items]);

  // Reset selection/focus when the result set changes shape.
  useEffect(() => { setSelected(new Set()); setFocusIdx(-1); }, [list.params]);
  useEffect(() => {
    if (focusIdx >= 0 && focusIdx >= items.length) setFocusIdx(items.length - 1);
  }, [items.length, focusIdx]);

  const selectedIds = useMemo(() => items.filter((n) => selected.has(n.id)).map((n) => n.id), [items, selected]);
  const unreadSelected = useMemo(() => items.filter((n) => selected.has(n.id) && !n.isRead).length, [items, selected]);

  const toggleSelect = useCallback((n: Notification, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const idx = items.findIndex((x) => x.id === n.id);
      if (shift && lastClickRef.current != null) {
        const from = items.findIndex((x) => x.id === lastClickRef.current);
        if (from >= 0 && idx >= 0) {
          const [a, b] = from < idx ? [from, idx] : [idx, from];
          const add = !prev.has(n.id);
          for (let i = a; i <= b; i++) { if (add) next.add(items[i].id); else next.delete(items[i].id); }
          lastClickRef.current = n.id;
          return next;
        }
      }
      if (next.has(n.id)) next.delete(n.id); else next.add(n.id);
      lastClickRef.current = n.id;
      return next;
    });
  }, [items]);

  const selectAll = () => setSelected(new Set(items.map((n) => n.id)));
  const clearSelection = () => setSelected(new Set());

  const onRead = useCallback((n: Notification, read: boolean) => (read ? actions.readMany.mutate([n.id]) : actions.unreadMany.mutate([n.id])), [actions.readMany, actions.unreadMany]);
  const onArchive = useCallback((n: Notification, archive: boolean) => {
    if (archive) {
      actions.archive.mutate([n.id]);
      setUndo({ ids: [n.id], label: notificationsI18n.t("page.one") });
    } else {
      actions.unarchive.mutate([n.id]);
    }
  }, [actions.archive, actions.unarchive]);
  const archiveSelected = () => {
    if (!selectedIds.length) return;
    actions.archive.mutate(selectedIds);
    setUndo({ ids: selectedIds, label: notificationsI18n.t("page.count", { count: selectedIds.length }) });
    clearSelection();
  };
  const archiveAllRead = () => {
    actions.archiveRead.mutate(undefined, {
      onSuccess: (r) => {
        const ids = (r as { ids?: number[] } | undefined)?.ids ?? [];
        if (ids.length) setUndo({ ids, label: notificationsI18n.t("page.count", { count: ids.length }) });
      },
    });
  };

  // Keyboard navigation.
  useEffect(() => {
    if (tab === "prefs") return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const move = (d: number) => {
        e.preventDefault();
        setFocusIdx((i) => {
          const next = Math.max(0, Math.min(items.length - 1, (i < 0 ? (d > 0 ? -1 : items.length) : i) + d));
          const el = listRef.current?.querySelector<HTMLElement>(`[data-notification-id="${items[next]?.id}"]`);
          el?.scrollIntoView({ block: "nearest" });
          return next;
        });
      };
      const cur = focusIdx >= 0 ? items[focusIdx] : null;
      switch (e.key) {
        case "ArrowDown": case "j": move(1); break;
        case "ArrowUp": case "k": move(-1); break;
        case "Home": e.preventDefault(); setFocusIdx(items.length ? 0 : -1); break;
        case "End": e.preventDefault(); setFocusIdx(items.length - 1); break;
        case "Enter": if (cur) { e.preventDefault(); open(cur); } break;
        case "r": if (cur) onRead(cur, !cur.isRead); break;
        case "e": if (cur) onArchive(cur, !cur.archivedAt); break;
        case "x": if (cur) { e.preventDefault(); toggleSelect(cur, e.shiftKey); } break;
        case "a": if (e.shiftKey) { e.preventDefault(); selectAll(); } break;
        case "Escape": if (selected.size) clearSelection(); else setFocusIdx(-1); break;
        default: return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, items, focusIdx, selected.size, open, onRead, onArchive, toggleSelect]);

  const unread = count?.unread ?? 0;
  const typeOptions = useMemo(() => (group === ALL ? TYPES : TYPES.filter((t) => t.group === group)), [group]);

  if (!me) {
    return (
      <Page>
        <PageHeader title={t("title")} icon={Bell} />
        <Panel><EmptyState icon={Bell} title={t("page.guestTitle")} description={t("page.guestDescription")} /></Panel>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title={t("title")}
        icon={Bell}
        description={unread > 0 ? `${t("page.unread", { count: unread })}${count?.critical ? ` · ${t("page.critical", { count: count.critical })}` : ""}` : t("page.allRead")}
        actions={
          <>
            <button type="button" onClick={() => list.refetch()} className="chip grid h-9 w-9 place-items-center" title={tc("actions.refresh")} aria-label={tc("actions.refresh")}>
              <RefreshCw className={cn("h-4 w-4", list.isFetching && "motion-safe:animate-spin")} aria-hidden="true" />
            </button>
            {tab === "inbox" && unread > 0 && (
              <button type="button" onClick={() => actions.readAll.mutate(undefined)} disabled={actions.readAll.isPending} className="chip inline-flex h-9 items-center gap-1.5 px-3 text-sm font-medium disabled:opacity-50">
                <CheckCheck className="h-4 w-4" aria-hidden="true" /> {t("bell.readAll")}
              </button>
            )}
            {tab === "inbox" && (
              <button type="button" onClick={archiveAllRead} disabled={actions.archiveRead.isPending} className="chip inline-flex h-9 items-center gap-1.5 px-3 text-sm font-medium disabled:opacity-50" title={t("page.archiveReadTitle")}>
                <Archive className="h-4 w-4" aria-hidden="true" /> {t("page.archiveRead")}
              </button>
            )}
          </>
        }
      >
        <Segmented
          ariaLabel={t("page.section")}
          value={tab}
          onChange={(v) => setTab(v)}
          options={[
            { value: "inbox", label: <span className="inline-flex items-center gap-1.5"><Inbox className="h-3.5 w-3.5" aria-hidden="true" />{t("page.inbox")}</span>, count: unread || undefined },
            { value: "archive", label: <span className="inline-flex items-center gap-1.5"><Archive className="h-3.5 w-3.5" aria-hidden="true" />{t("page.archive")}</span> },
            { value: "prefs", label: <span className="inline-flex items-center gap-1.5"><Settings2 className="h-3.5 w-3.5" aria-hidden="true" />{t("page.settings")}</span> },
          ]}
        />
      </PageHeader>

      {tab === "prefs" ? (
        <NotificationPrefsPanel />
      ) : (
        <>
          <Toolbar>
            {tab === "inbox" && (
              <FilterChip active={unreadOnly} onClick={() => setUnreadOnly((v) => !v)} count={unread || undefined}>{t("page.unreadFilter")}</FilterChip>
            )}
            <span className="mx-1 hidden h-5 w-px bg-[var(--glass-border)] sm:block" aria-hidden="true" />
            {SEVERITY_ORDER.map((s) => (
              <FilterChip
                key={s}
                active={severities.includes(s)}
                onClick={() => setSeverities((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))}
                className={cn(severities.includes(s) && s !== "info" && (s === "critical" ? "text-down" : "text-[hsl(var(--chart-3))]"))}
              >
                <Pill tone={SEVERITY_TONE[s]} dot className="px-0 py-0 text-xs bg-transparent">{SEVERITY_LABEL[s]}</Pill>
              </FilterChip>
            ))}
            <span className="mx-1 hidden h-5 w-px bg-[var(--glass-border)] sm:block" aria-hidden="true" />
            <Select value={group} onValueChange={(v) => { setGroup(v as NotificationGroup | typeof ALL); setTypes([]); }}>
              <SelectTrigger aria-label={t("page.group")} className="h-9 w-[190px] text-xs"><SelectValue placeholder={t("page.allGroups")} /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("page.allGroups")}</SelectItem>
                {GROUP_ORDER.map((g) => <SelectItem key={g} value={g}>{GROUP_LABELS[g]}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={types.length === 1 ? types[0] : ALL} onValueChange={(v) => setTypes(v === ALL ? [] : [v])}>
              <SelectTrigger aria-label={t("page.type")} className="h-9 w-[260px] text-xs"><SelectValue placeholder={t("page.allTypes")} /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("page.allTypes")}</SelectItem>
                {typeOptions.map((t) => <SelectItem key={t.type} value={t.type}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {(unreadOnly || severities.length || group !== ALL || types.length) ? (
              <button type="button" onClick={() => { setUnreadOnly(false); setSeverities([]); setGroup(ALL); setTypes([]); }} className="chip inline-flex h-8 items-center gap-1 px-2.5 text-xs">
                <X className="h-3 w-3" aria-hidden="true" /> {tc("actions.reset")}
              </button>
            ) : null}
            <div className="ml-auto hidden items-center gap-1 text-2xs text-muted-foreground lg:flex" aria-hidden="true">
              <Kbd keys={["↑", "↓"]} /> {t("page.keys.select")} · <Kbd keys={["Enter"]} /> {t("page.keys.open")} · <Kbd keys={["R"]} /> {t("page.keys.read")} · <Kbd keys={["E"]} /> {t("page.keys.archive")} · <Kbd keys={["X"]} /> {t("page.keys.mark")}
            </div>
          </Toolbar>

          {selected.size > 0 && (
            <div className="glass-panel sticky-top flex flex-wrap items-center gap-2 rounded-2xl px-3 py-2">
              <span className="text-sm font-medium text-foreground">{tc("states.selected", { count: selectedIds.length })}</span>
              {tab === "inbox" && unreadSelected > 0 && (
                <button type="button" onClick={() => actions.readMany.mutate(selectedIds)} className="chip inline-flex h-8 items-center gap-1.5 px-3 text-xs font-medium">
                  <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" /> {t("page.readSelected", { count: unreadSelected })}
                </button>
              )}
              {tab === "inbox" && unreadSelected < selectedIds.length && (
                <button type="button" onClick={() => actions.unreadMany.mutate(selectedIds)} className="chip inline-flex h-8 items-center gap-1.5 px-3 text-xs font-medium">
                  {t("page.markUnread")}
                </button>
              )}
              {tab === "inbox" ? (
                <button type="button" onClick={archiveSelected} className="chip inline-flex h-8 items-center gap-1.5 px-3 text-xs font-medium">
                  <Archive className="h-3.5 w-3.5" aria-hidden="true" /> {t("page.toArchive")}
                </button>
              ) : (
                <button type="button" onClick={() => { actions.unarchive.mutate(selectedIds); clearSelection(); }} className="chip inline-flex h-8 items-center gap-1.5 px-3 text-xs font-medium">
                  {t("page.toInbox")}
                </button>
              )}
              <span className="ml-auto flex items-center gap-1">
                <button type="button" onClick={selectAll} className="chip inline-flex h-8 items-center gap-1.5 px-2.5 text-xs" title={t("page.selectAllTitle")}>
                  <SquareCheckBig className="h-3.5 w-3.5" aria-hidden="true" /> {t("page.selectAll")}
                </button>
                <button type="button" onClick={clearSelection} className="chip inline-flex h-8 items-center gap-1.5 px-2.5 text-xs" title={t("page.clearTitle")}>
                  <SquareDashed className="h-3.5 w-3.5" aria-hidden="true" /> {t("page.clear")}
                </button>
              </span>
            </div>
          )}

          <Panel padded={false} bodyClassName="p-1.5 sm:p-2" className="min-h-[50vh]">
            {list.isLoading ? (
              <div className="space-y-2 p-2" aria-busy="true">
                {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
              </div>
            ) : list.isError ? (
              <QueryError error={list.error} onRetry={() => list.refetch()} />
            ) : items.length === 0 ? (
              <EmptyState
                icon={tab === "archive" ? Archive : Inbox}
                title={tab === "archive" ? t("page.archiveEmpty") : unreadOnly ? t("page.noUnread") : t("page.empty")}
                description={tab === "archive" ? t("page.archiveEmptyHint") : t("page.emptyHint")}
                action={(unreadOnly || severities.length || group !== ALL || types.length) ? (
                  <button type="button" onClick={() => { setUnreadOnly(false); setSeverities([]); setGroup(ALL); setTypes([]); }} className="chip h-8 px-3 text-xs font-medium">{tc("actions.resetFilters")}</button>
                ) : undefined}
              />
            ) : (
              <div ref={listRef} role="list" aria-label={t("page.listAria")}>
                {groups.map((g) => (
                  <section key={g.key} aria-label={g.label} className="pb-1">
                    <div className="flex items-center justify-between px-2.5 pb-1 pt-2">
                      <h3 className="micro-label">{g.label}</h3>
                      <span className="text-2xs tabular-nums text-muted-foreground">{g.items.length}</span>
                    </div>
                    <ul className="space-y-0.5">
                      {g.items.map((n) => {
                        const idx = items.indexOf(n);
                        return (
                          <li key={n.id} role="listitem">
                            <NotificationItem
                              n={n}
                              variant="full"
                              selected={selected.has(n.id)}
                              focused={idx === focusIdx}
                              onOpen={(x) => { setFocusIdx(idx); open(x); }}
                              onToggleSelect={toggleSelect}
                              onRead={onRead}
                              onArchive={onArchive}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
                {list.hasNextPage && (
                  <div className="flex justify-center py-3">
                    <button type="button" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage} className="chip inline-flex h-9 items-center gap-2 px-4 text-sm font-medium disabled:opacity-50">
                      {list.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                      {tc("actions.showMore")}
                    </button>
                  </div>
                )}
              </div>
            )}
          </Panel>
        </>
      )}
      {undo && (
        <UndoToast
          key={undo.ids.join(",")}
          label={undo.label}
          actionText={tc("undo.archived")}
          restoring={actions.unarchive.isPending}
          onUndo={() => actions.unarchive.mutate(undo.ids, { onSettled: () => setUndo(null) })}
          onDismiss={() => setUndo(null)}
        />
      )}
      <p className="sr-only" aria-live="polite">{unread > 0 ? t("page.srUnread", { count: unread }) : t("page.srNone")}</p>
    </Page>
  );
}
