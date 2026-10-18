/**
 * Плейбук — setups in three spaces:
 *   «Офис»  — the office playbook (curators edit, everyone reads);
 *   «Мой»   — the viewer's personal setups (private by default);
 *   «Общие» — personal setups other people (seniors) shared with the viewer; «Команда» — all other personal setups (staff only).
 * The space is picked in a page-level bar under the header (every view), with counts and a one-line hint.
 * Library view: left column (search, one filter row, folder tree) + setup card with tabs
 * «Описание / Эталоны / Статистика / История». Nothing open → home: «Разобрать сделки» (own trades without an
 * example), Tier 1 showcase, edge / recent lists. Other views: «Эталоны» gallery (+ «Все» scope) and a card grid.
 * URL: ?id= (setup), ?tab= (setup tab), ?space= (office default), ?view= (library default), ?f= (quick filter),
 * ?tags= (comma list); gallery filters gt/gp/gs/gtr live in gallery.tsx. ?q= and ?highlight= are one-shot.
 * Example trades can be dragged from the «Эталоны» board onto a setup row in the tree to move them.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import {
  Activity, BookOpen, Building2, ChevronsDownUp, ChevronsUpDown, Columns2, Download, FileArchive, HelpCircle, LayoutGrid,
  Library, MoreHorizontal, Plus, Search, Send, Share2, Tag, Trophy, User, Users, X, ZoomIn, ZoomOut, type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToastAction } from "@/components/ui/toast";
import { EmptyState, Kbd, Page, PageHeader, Segmented, Toolbar } from "@/components/ds";
import { IconAction, lsGet, lsSet } from "@/components/playbook-sub/bits";
import { useToast } from "@/hooks/use-toast";
import { localDateString } from "@/lib/local-date";
import { cn } from "@/lib/utils";
import { generatePlaybookMarkdown, downloadMarkdown, generateNotionZip, downloadBlob, type ExportEntry } from "@/components/playbook/export";
import {
  invalidateExamples, invalidatePlaybook, notLiveMessage, useFolderSettings, usePlaybookEntries, usePlaybookSummary, usePlaybookViewer,
  type InboxTrade,
} from "@/components/playbook/api";
import { http } from "@/lib/api/http";
import {
  LS, accessOf, matchesQuickFilter, searchHaystack, sortEntries, spaceTabOf, splitTags,
  type PlaybookEntry, type QuickFilter, type SortKey, type SpaceTab,
} from "@/components/playbook/model";
import { FolderTree, type FolderGroup } from "@/components/playbook/folder-tree";
import { SetupView, SETUP_TABS, type SetupTab } from "@/components/playbook/setup-view";
import { Overview, SetupCard } from "@/components/playbook/overview";
import { Gallery, type GalleryScope } from "@/components/playbook/gallery";
import { PlaybookInbox, Tier1Strip } from "@/components/playbook/home";
import { patchSearch } from "@/components/playbook/url-state";
import { SetupFormDialog, type FormMode } from "@/components/playbook/setup-form-dialog";
import { CompareDialog } from "@/components/playbook/compare-dialog";
import { QuickFind } from "@/components/playbook/quick-find";
import { TradePickerDialog } from "@/components/playbook/trade-picker-dialog";
import { ShareDialog } from "@/components/playbook/share-dialog";
import { hasExampleDrag, patchExample, readExampleDrag } from "@/components/playbook/examples-board";
import { ActivitySheet, DeleteFolderDialog, DeleteSetupDialog, RenameFolderDialog } from "@/components/playbook/page-dialogs";
import { useMoveToFolder } from "@/components/playbook/move-to-folder";
import { commonI18n } from "@/i18n/ns/common";
import { playbookI18n } from "@/i18n/ns/playbook";

import { personName } from "@/i18n";
type View = "library" | "gallery" | "grid";
const VIEWS: View[] = ["library", "gallery", "grid"];
const UNFILED = "__unfiled";
const LS_SPACE = "playbook-space";

/** Labels are getters (current UI language): `short` is what the closed select shows (the sidebar is 320px); `label` is the menu item. */
const pt = playbookI18n.t;
const SORT_KEYS: SortKey[] = ["folder", "edge", "used", "new", "name"];
const SORT_OPTIONS = SORT_KEYS.map((value) => ({
  value,
  get label() { return pt(`page.sort.${value}.label`); },
  get short() { return pt(`page.sort.${value}.short`); },
}));
const FILTER_KEYS: QuickFilter[] = ["all", "today", "edge", "untested", "noExamples", "unreviewed"];
const FILTERS = FILTER_KEYS.map((value) => ({
  value,
  get label() { return pt(`page.filter.${value}.label`); },
  get short() { return pt(`page.filter.${value}.short`); },
}));
/** `label` — short (menus, export), `long` — the scope bar. */
const spaceRow = (value: SpaceTab | "all", icon: LucideIcon) => ({
  value, icon,
  get label() { return pt(`page.space.${value}.label`); },
  get long() { return pt(`page.space.${value}.long`); },
  get hint() { return pt(`page.space.${value}.hint`); },
});
const SPACES = [spaceRow("office", Building2), spaceRow("mine", User), spaceRow("shared", Share2), spaceRow("team", Users)] as { value: SpaceTab; label: string; long: string; icon: LucideIcon; hint: string }[];
const ALL_SCOPE = spaceRow("all", Library);
/** Page scope: a space, or «Все» (gallery only). */
type Scope = SpaceTab | "all";
const isScope = (v: unknown): v is Scope => v === "all" || SPACES.some((s) => s.value === v);
const urlParam = (k: string) => new URLSearchParams(window.location.search).get(k);
type HotkeyKey = keyof typeof import("@/i18n/locales/ru/playbook").default.page.hotkeys;
const HOTKEYS: [string[], HotkeyKey][] = [
  [["Ctrl", "K"], "quickFindSetup"],
  [["/"], "quickFind"],
  [["J", "K"], "nextPrev"],
  [["N"], "newSetup"],
  [["Ctrl", "S"], "saveForm"],
  [["E"], "edit"],
  [["A"], "addExamples"],
  [["C"], "compare"],
  [["Esc"], "close"],
  [["1", "2", "3"], "tier"],
  [["Alt", "↑↓"], "reorder"],
  [["M"], "moveExample"],
  [["Ctrl", "V"], "paste"],
];

function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
function overlayOpen() {
  return !!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]');
}
const isView = (v: unknown): v is View => VIEWS.includes(v as View);
const isSetupTab = (v: unknown): v is SetupTab => SETUP_TABS.includes(v as SetupTab);

export default function Playbook() {
  const { t } = playbookI18n.useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const viewer = usePlaybookViewer();
  const trader = user?.traderName ?? "system";
  const [, navigate] = useLocation();
  const searchStr = useSearch();

  /* ---------- data ---------- */
  const { data: entries = [], isLoading, isError, error, refetch, isFetching } = usePlaybookEntries();
  const summaryQ = usePlaybookSummary();
  const summary = summaryQ.map;
  const { data: folderSettings } = useFolderSettings();
  /** New API is running (spaces / examples / stats). Older API: client-side fallbacks and friendly «после обновления сервера» states. */
  const live = viewer.live || entries.some((e) => !!e.access);

  /* ---------- persisted UI state ---------- */
  // The URL wins (shared links, back / forward), then the remembered choice.
  const [view, setViewState] = useState<View>(() => {
    const u = urlParam("view"); if (isView(u)) return u;
    // A link to one setup (?id= / ?highlight=, e.g. from the feed) must show it — not a remembered grid / gallery.
    if (urlParam("id") || urlParam("highlight")) return "library";
    const v = lsGet<string>(LS.view, "library"); return isView(v) ? v : "library";
  });
  const [space, setSpaceState] = useState<Scope>(() => {
    const u = urlParam("space"); if (isScope(u)) return u;
    const v = lsGet<string>(LS_SPACE, "office"); return isScope(v) ? v : "office";
  });
  const [sort, setSortState] = useState<SortKey>(() => lsGet<SortKey>(LS.sort, "folder"));
  const [quick, setQuickState] = useState<QuickFilter>(() => {
    const u = urlParam("f"); if (FILTERS.some((f) => f.value === u)) return u as QuickFilter;
    const v = lsGet<string>(LS.filter, "all"); return FILTERS.some((f) => f.value === v) ? (v as QuickFilter) : "all";
  });
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set(lsGet<string[]>(LS.openFolders, [])));
  const [folderOrder, setFolderOrder] = useState<string[]>(() => lsGet<string[]>(LS.folderOrder, []));
  const [folderColors, setFolderColors] = useState<Record<string, number>>(() => lsGet<Record<string, number>>(LS.folderColors, {}));
  const [zoom, setZoom] = useState<number>(() => {
    const z = Number(lsGet<number | string>(LS.zoom, 1));
    return Number.isFinite(z) && z > 0 ? z : 1;
  });
  const [recentIds, setRecentIds] = useState<number[]>(() => lsGet<number[]>(LS.recent, []));
  const setView = (v: View) => { setViewState(v); lsSet(LS.view, v); };
  const setSpace = (v: Scope) => { setSpaceState(v); lsSet(LS_SPACE, v); };
  const setSort = (v: SortKey) => { setSortState(v); lsSet(LS.sort, v); };
  const setQuick = (v: QuickFilter) => { setQuickState(v); lsSet(LS.filter, v); };

  /* ---------- transient UI state ---------- */
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string[]>(() => (urlParam("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean));
  const [formMode, setFormMode] = useState<FormMode | null>(null);
  const [deleting, setDeleting] = useState<PlaybookEntry | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [renameFolder, setRenameFolder] = useState<string | null>(null);
  const [deleteFolder, setDeleteFolder] = useState<string | null>(null);
  const [deleteFolderPending, setDeleteFolderPending] = useState(false);
  const [compareFor, setCompareFor] = useState<PlaybookEntry | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [notionBusy, setNotionBusy] = useState(false);
  const [pickerFor, setPickerFor] = useState<PlaybookEntry | null>(null);
  const [shareFor, setShareFor] = useState<PlaybookEntry | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);

  /* ---------- server folder settings → local (colors + order) ---------- */
  useEffect(() => {
    if (!folderSettings?.length) return;
    const colors: Record<string, number> = {};
    for (const s of folderSettings) if (s.colorIndex != null) colors[s.folderName] = s.colorIndex;
    if (Object.keys(colors).length) { setFolderColors(colors); lsSet(LS.folderColors, colors); }
    const fromServer = [...folderSettings].sort((a, b) => a.sortOrder - b.sortOrder).map((s) => s.folderName);
    setFolderOrder((prev) => {
      const merged = [...fromServer, ...prev.filter((n) => !fromServer.includes(n))];
      lsSet(LS.folderOrder, merged);
      return merged;
    });
  }, [folderSettings]);

  /* ---------- spaces ---------- */
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const tabOf = useMemo(() => new Map(entries.map((e) => [e.id, spaceTabOf(e, viewer)])), [entries, viewer]);
  const spaceCounts = useMemo(() => {
    const c: Record<SpaceTab, number> = { office: 0, mine: 0, shared: 0, team: 0 };
    for (const e of entries) if (!e.parentId || !byId.has(e.parentId)) c[tabOf.get(e.id) ?? "office"]++;
    return c;
  }, [entries, byId, tabOf]);
  const visibleSpaces = SPACES.filter((s) => s.value !== "team" || (viewer.isCurator && spaceCounts.team > 0));
  // A remembered «Команда» tab that is no longer available falls back to «Офис»; «Все» exists only in the gallery.
  const activeSpace: SpaceTab = visibleSpaces.some((s) => s.value === space) ? (space as SpaceTab) : "office";
  const galleryScope: GalleryScope = space === "all" ? "all" : activeSpace;
  const shownScope: Scope = view === "gallery" ? galleryScope : activeSpace;
  const proposed = useMemo(
    () => (viewer.isCurator ? entries.filter((e) => e.officeProposedAt && tabOf.get(e.id) !== "office") : []),
    [entries, tabOf, viewer.isCurator],
  );

  /** Setups of the active space (variants follow their parent). */
  const spaceEntries = useMemo(
    () => entries.filter((e) => {
      const root = e.parentId ? byId.get(e.parentId) ?? e : e;
      return (tabOf.get(root.id) ?? "office") === activeSpace;
    }),
    [entries, byId, tabOf, activeSpace],
  );

  /* ---------- derived (within the active space) ---------- */
  // Children whose parent was deleted are treated as top-level.
  const topLevel = useMemo(() => spaceEntries.filter((e) => !e.parentId || !byId.has(e.parentId)), [spaceEntries, byId]);

  const allFolders = useMemo(() => {
    const present = new Set(topLevel.map((e) => e.folder).filter(Boolean) as string[]);
    return [...folderOrder.filter((f) => present.has(f)), ...[...present].filter((f) => !folderOrder.includes(f)).sort((a, b) => a.localeCompare(b, "ru"))];
  }, [topLevel, folderOrder]);
  /** Every folder name (all spaces) — for the setup form's folder picker. */
  const everyFolder = useMemo(() => [...new Set(entries.map((e) => e.folder).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, "ru")), [entries]);

  const folderTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of topLevel) { const k = e.folder ?? UNFILED; m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  }, [topLevel]);

  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of spaceEntries) for (const t of splitTags(e.tags)) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"));
  }, [spaceEntries]);

  // The box updates at once; filtering the tree / grid follows at a lower priority (no lag while typing).
  const deferredQuery = useDeferredValue(query);
  const q = deferredQuery.trim().toLowerCase();
  const passes = useCallback(
    (e: PlaybookEntry) => {
      if (!matchesQuickFilter(e, quick, summary)) return false;
      if (tagFilter.length) {
        const t = splitTags(e.tags);
        if (!tagFilter.every((x) => t.includes(x))) return false;
      }
      if (q && !q.split(/\s+/).every((term) => searchHaystack(e).includes(term))) return false;
      return true;
    },
    [quick, summary, tagFilter, q],
  );

  const quickCounts = useMemo(() => {
    const c = {} as Record<QuickFilter, number>;
    for (const f of FILTERS) c[f.value] = 0;
    for (const e of topLevel) for (const f of FILTERS) if (matchesQuickFilter(e, f.value, summary)) c[f.value]++;
    return c;
  }, [topLevel, summary]);

  const filtering = !!q || quick !== "all" || tagFilter.length > 0;

  const childrenOf = useMemo(() => {
    const m = new Map<number, PlaybookEntry[]>();
    for (const e of spaceEntries) {
      if (!e.parentId || !byId.has(e.parentId)) continue;
      if (filtering && !passes(e)) continue;
      const arr = m.get(e.parentId) ?? [];
      arr.push(e);
      m.set(e.parentId, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    return m;
  }, [spaceEntries, byId, filtering, passes]);

  const flat = useMemo(() => {
    if (!q && sort === "folder") return null;
    return sortEntries(spaceEntries.filter(passes), sort === "folder" ? "name" : sort, summary);
  }, [q, sort, spaceEntries, passes, summary]);

  const groups: FolderGroup[] = useMemo(() => {
    if (flat) return [];
    const keys = [...allFolders, UNFILED];
    const out: FolderGroup[] = [];
    for (const k of keys) {
      const inFolder = topLevel.filter((e) => (e.folder ?? UNFILED) === k);
      const shown = inFolder
        .filter((e) => !filtering || passes(e) || (childrenOf.get(e.id)?.length ?? 0) > 0)
        .sort((a, b) => a.name.localeCompare(b.name, "ru"));
      if (filtering && shown.length === 0) continue;
      if (inFolder.length === 0) continue;
      out.push({ folder: k === UNFILED ? null : k, entries: shown, total: folderTotals.get(k) ?? 0 });
    }
    return out;
  }, [flat, allFolders, topLevel, filtering, passes, childrenOf, folderTotals]);

  /** Visible order for J/K navigation. */
  const navOrder = useMemo(() => {
    if (flat) return flat.map((e) => e.id);
    const ids: number[] = [];
    for (const g of groups) for (const e of g.entries) { ids.push(e.id); for (const c of childrenOf.get(e.id) ?? []) ids.push(c.id); }
    return ids;
  }, [flat, groups, childrenOf]);

  /* ---------- selection via URL (?id=, ?tab=, ?q=) ---------- */
  const params = useMemo(() => new URLSearchParams(searchStr), [searchStr]);
  const selectedId = Number(params.get("id")) || null;
  const tabParam = params.get("tab");
  const setupTab: SetupTab = isSetupTab(tabParam) ? tabParam : "about";
  const urlQuery = params.get("q") ?? "";
  useEffect(() => {
    if (!urlQuery) return;
    setQuery(urlQuery);
    setViewState("library");
    // Consume the param so clearing the box doesn't re-apply it on the next render.
    const next = new URLSearchParams(params);
    next.delete("q");
    const s = next.toString();
    navigate(`/playbook${s ? `?${s}` : ""}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQuery]);
  const selected = selectedId ? byId.get(selectedId) ?? null : null;

  // URL → state (back / forward, pasted links).
  const urlSpace = params.get("space");
  const urlView = params.get("view");
  const urlF = params.get("f");
  const urlSynced = useRef(false);
  useEffect(() => {
    // On mount the state already came from the URL / localStorage; later a missing param means the default.
    if (!urlSynced.current) { urlSynced.current = true; return; }
    const s: Scope = isScope(urlSpace) ? urlSpace : "office";
    const v: View = isView(urlView) ? urlView : "library";
    const f: QuickFilter = FILTERS.some((x) => x.value === urlF) ? (urlF as QuickFilter) : "all";
    if (s !== space) setSpaceState(s);
    if (v !== view) setViewState(v);
    if (f !== quick) setQuickState(f);
  }, [urlSpace, urlView, urlF]); // eslint-disable-line react-hooks/exhaustive-deps
  // State → URL (replace; defaults stay out so plain links remain clean).
  useEffect(() => {
    const cur = window.location.search.replace(/^\?/, "");
    const next = patchSearch(cur, {
      space: space === "office" ? null : space,
      view: view === "library" ? null : view,
      f: quick === "all" ? null : quick,
      tags: tagFilter.length ? tagFilter.join(",") : null,
    });
    if (next !== cur) navigate(`/playbook${next ? `?${next}` : ""}`, { replace: true });
  }, [space, view, quick, tagFilter, searchStr]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opening a setup from another space (link, search, «В Офис» result) switches the sidebar to its space.
  useEffect(() => {
    if (!selected) return;
    const root = selected.parentId ? byId.get(selected.parentId) ?? selected : selected;
    const t = tabOf.get(root.id);
    if (t && t !== activeSpace && (t !== "team" || viewer.isCurator)) setSpace(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, tabOf]);

  const rememberRecent = useCallback((id: number) => {
    setRecentIds((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, 12);
      lsSet(LS.recent, next);
      return next;
    });
  }, []);

  const openSetup = useCallback(
    (id: number | null, opts?: { replace?: boolean; tab?: SetupTab }) => {
      if (id == null) {
        const next = patchSearch(window.location.search, { id: null, tab: null, highlight: null, q: null });
        navigate(`/playbook${next ? `?${next}` : ""}`, { replace: opts?.replace });
        return;
      }
      const e = byId.get(id);
      if (e) {
        const root = e.parentId ? byId.get(e.parentId) ?? e : e;
        const key = root.folder ?? UNFILED;
        setOpenFolders((prev) => {
          if (prev.has(key)) return prev;
          const next = new Set(prev); next.add(key); lsSet(LS.openFolders, [...next]); return next;
        });
      }
      rememberRecent(id);
      // Keep the page state (space / view / filters) in the link; one-shot params are dropped.
      const tab = opts?.tab && opts.tab !== "about" ? opts.tab : null;
      const next = patchSearch(window.location.search, { id: String(id), tab, highlight: null, q: null });
      navigate(`/playbook?${next}`, { replace: opts?.replace });
    },
    [navigate, byId, rememberRecent],
  );
  const openFromElsewhere = useCallback((id: number, tab?: SetupTab) => { setView("library"); openSetup(id, { tab }); }, [openSetup]); // eslint-disable-line react-hooks/exhaustive-deps

  // ?highlight= (global search, other sections) → ?id=
  useEffect(() => {
    const h = Number(params.get("highlight"));
    if (!h || !entries.length) return;
    if (byId.has(h)) { setView("library"); openSetup(h, { replace: true }); }
    else { const next = patchSearch(window.location.search, { highlight: null }); navigate(`/playbook${next ? `?${next}` : ""}`, { replace: true }); toast({ title: t("page.notFoundTitle"), description: t("page.toast.highlightMissing") }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, entries.length]);

  // ?folder=Name — a link to a folder: library view, folder order, that folder open and scrolled into view (one-shot).
  const urlFolder = params.get("folder");
  useEffect(() => {
    if (!urlFolder || !entries.length) return;
    const inFolder = entries.filter((e) => !e.parentId && e.folder === urlFolder);
    const next = patchSearch(window.location.search, { folder: null });
    if (!inFolder.length) {
      navigate(`/playbook${next ? `?${next}` : ""}`, { replace: true });
      toast({ title: t("page.toast.folderMissing"), description: t("page.toast.folderMissingDesc", { folder: urlFolder }) });
      return;
    }
    const tabs = new Set(inFolder.map((e) => tabOf.get(e.id) ?? "office"));
    if (!tabs.has(activeSpace)) {
      const t = (["mine", "office", "shared", "team"] as SpaceTab[]).find((x) => tabs.has(x) && (x !== "team" || viewer.isCurator));
      if (t) setSpace(t);
    }
    setView("library");
    if (sort !== "folder") setSort("folder");
    if (quick !== "all") setQuick("all");
    setQuery("");
    setOpenFolders((prev) => { if (prev.has(urlFolder)) return prev; const n = new Set(prev); n.add(urlFolder); lsSet(LS.openFolders, [...n]); return n; });
    navigate(`/playbook${next ? `?${next}` : ""}`, { replace: true });
    window.setTimeout(() => {
      document.querySelector(`[data-folder-key="${CSS.escape(urlFolder)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 120);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlFolder, entries.length]);
  function copyFolderLink(folder: string) {
    const qs = new URLSearchParams({ folder });
    if (activeSpace !== "office") qs.set("space", activeSpace);
    const url = `${window.location.origin}/playbook?${qs.toString()}`;
    navigator.clipboard?.writeText(url).then(
      () => toast({ title: t("page.toast.folderLinkCopied"), description: folder }),
      () => toast({ title: t("page.toast.linkCopyFailed"), variant: "destructive" }),
    );
  }

  // Same-page navigation from the global search.
  useEffect(() => {
    function onNav(e: Event) {
      const d = (e as CustomEvent<{ path?: string; highlightId?: number }>).detail ?? {};
      if (!d.highlightId || (d.path && d.path !== "/playbook")) return;
      if (byId.has(Number(d.highlightId))) { setView("library"); openSetup(Number(d.highlightId), { replace: true }); }
    }
    window.addEventListener("ws-search-navigate", onNav);
    return () => window.removeEventListener("ws-search-navigate", onNav);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byId, openSetup]);

  // Keep the selected row visible in the tree.
  useEffect(() => {
    if (!selectedId) return;
    const t = window.setTimeout(() => {
      document.querySelector(`[data-setup-row="${selectedId}"]`)?.scrollIntoView({ block: "nearest" });
    }, 50);
    return () => window.clearTimeout(t);
  }, [selectedId, view, activeSpace]);

  /* ---------- folder ops ---------- */
  const toggleFolder = (key: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      lsSet(LS.openFolders, [...next]);
      return next;
    });
  };
  const allOpen = groups.length > 0 && groups.every((g) => openFolders.has(g.folder ?? UNFILED));
  const toggleAll = () => {
    const next = allOpen ? new Set<string>() : new Set(groups.map((g) => g.folder ?? UNFILED));
    setOpenFolders(next);
    lsSet(LS.openFolders, [...next]);
  };
  /** Folder actions: office folders — curators; «Мой» — the owner. Shared / team folders are read-only here. */
  const canManageFolders = activeSpace === "office" ? viewer.isCurator : activeSpace === "mine" ? viewer.canEdit : false;
  const moveToFolder = useMoveToFolder();
  const canDragSetup = useCallback((e: PlaybookEntry) => accessOf(e, viewer).canEdit, [viewer]);
  async function moveSetupToFolder(id: number, folder: string | null) {
    const e = byId.get(id);
    if (!e || (e.folder ?? null) === folder || !accessOf(e, viewer).canEdit) return;
    // Optimistic: the row jumps to its new folder right away; the hook toasts with «Вернуть».
    qc.setQueryData<PlaybookEntry[]>(["playbook"], (old) => old?.map((x) => (x.id === id ? { ...x, folder } : x)));
    const key = folder ?? UNFILED;
    setOpenFolders((prev) => { if (prev.has(key)) return prev; const next = new Set(prev); next.add(key); lsSet(LS.openFolders, [...next]); return next; });
    const ok = await moveToFolder(e, folder);
    if (!ok) invalidatePlaybook(qc, id);
  }
  const selectInTree = useCallback((id: number) => openSetup(id, { tab: setupTab }), [openSetup, setupTab]);

  /** Folder colour / order are desk-wide settings: only staff may write them (the API answers 403 to traders). */
  const canFolderSettings = viewer.isCurator;
  async function saveFolderSettings(body: { folderName: string; colorIndex?: number; sortOrder?: number }[], errTitle: string) {
    if (!canFolderSettings) return;
    try {
      await http.patch("/api/playbook/folder-settings", body);
      qc.invalidateQueries({ queryKey: ["playbook-folder-settings"] });
    } catch {
      toast({ title: errTitle, variant: "destructive" });
    }
  }
  function setFolderColor(folder: string, idx: number) {
    setFolderColors((prev) => { const next = { ...prev, [folder]: idx }; lsSet(LS.folderColors, next); return next; });
    // The API writes sort_order = 0 when it is omitted — send the current position so a colour change doesn't move the folder.
    const pos = allFolders.indexOf(folder);
    saveFolderSettings([{ folderName: folder, colorIndex: idx, ...(pos >= 0 ? { sortOrder: pos } : {}) }], t("page.toast.folderColorFailed"));
  }
  function moveFolder(folder: string, delta: -1 | 1) {
    const order = [...allFolders];
    const from = order.indexOf(folder);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    applyFolderOrder(order);
  }
  /** Drag & drop: the dragged folder takes the target's place. */
  function reorderFolder(folder: string, target: string | null) {
    const order = allFolders.filter((f) => f !== folder);
    const to = target ? allFolders.indexOf(target) : order.length;
    if (to < 0 || allFolders.indexOf(folder) < 0 || folder === target) return;
    order.splice(Math.min(to, order.length), 0, folder);
    applyFolderOrder(order);
  }
  function applyFolderOrder(order: string[]) {
    const rest = folderOrder.filter((f) => !order.includes(f));
    const merged = [...order, ...rest];
    setFolderOrder(merged);
    lsSet(LS.folderOrder, merged);
    // Only this space's folders: their relative order is what the tree shows (another space keeps its own numbers).
    saveFolderSettings(order.map((f, i) => ({ folderName: f, sortOrder: i })), t("page.toast.folderOrderFailed"));
  }
  function onFolderRenamed(from: string, to: string, merged: boolean) {
    setFolderOrder((prev) => {
      const next = merged ? prev.filter((f) => f !== from) : prev.map((f) => (f === from ? to : f));
      lsSet(LS.folderOrder, next);
      return next;
    });
    setFolderColors((prev) => {
      if (prev[from] === undefined) return prev;
      const next = { ...prev };
      if (!merged || next[to] === undefined) next[to] = prev[from];
      delete next[from];
      lsSet(LS.folderColors, next);
      return next;
    });
    setOpenFolders((prev) => {
      if (!prev.has(from)) return prev;
      const next = new Set(prev); next.delete(from); next.add(to); lsSet(LS.openFolders, [...next]); return next;
    });
    invalidatePlaybook(qc);
    toast({ title: merged ? t("page.toast.foldersMerged", { folder: to }) : t("page.toast.folderRenamed", { folder: to }) });
  }
  async function confirmDeleteFolder(password: string) {
    if (!deleteFolder) return;
    setDeleteFolderPending(true);
    try {
      const r = await http.del<{ deleted?: number }>("/api/playbook/delete-folder", { folder: deleteFolder, password, trader });
      invalidatePlaybook(qc);
      if (selected && selected.folder === deleteFolder) openSetup(null, { replace: true });
      toast({ title: t("page.toast.folderDeleted", { folder: deleteFolder }), description: r?.deleted != null ? t("page.toast.setupsInTrash", { count: r.deleted }) : undefined });
      setDeleteFolder(null);
    } catch (e: any) {
      toast({ title: t("page.toast.folderDeleteFailed"), description: e?.message, variant: "destructive" });
    } finally {
      setDeleteFolderPending(false);
    }
  }

  /* ---------- setup ops ---------- */
  async function restore(id: number) {
    try {
      await http.post(`/api/playbook/${id}/restore`, { trader });
      invalidatePlaybook(qc, id);
      toast({ title: t("page.toast.restored") });
    } catch (e: any) {
      toast({ title: t("page.toast.restoreFailed"), description: e?.message, variant: "destructive" });
    }
  }
  async function confirmDelete() {
    if (!deleting) return;
    const { id, name } = deleting;
    setDeletePending(true);
    try {
      await http.del(`/api/playbook/${id}`, { trader });
      invalidatePlaybook(qc, id);
      if (selectedId === id) openSetup(null, { replace: true });
      setDeleting(null);
      toast({ title: t("page.toast.deleted", { name }), action: <ToastAction altText={t("page.toast.undoDelete")} onClick={() => restore(id)}>{commonI18n.t("actions.undo")}</ToastAction> });
    } catch (e: any) {
      toast({ title: commonI18n.t("states.deleteFailed"), description: e?.message, variant: "destructive" });
    } finally {
      setDeletePending(false);
    }
  }

  /* ---------- drag an example onto a setup row → move it there ---------- */
  const rowFromEvent = (e: DragEvent): number | null => {
    const el = (e.target as HTMLElement | null)?.closest?.("[data-setup-row]") as HTMLElement | null;
    const id = el ? Number(el.dataset.setupRow) : NaN;
    return Number.isInteger(id) ? id : null;
  };
  const canDropOn = (id: number | null) => {
    const t = id != null ? byId.get(id) : null;
    return !!t && accessOf(t, viewer).canAddExamples;
  };
  function onTreeDragOver(e: DragEvent) {
    if (!hasExampleDrag(e.dataTransfer)) return;
    const id = rowFromEvent(e);
    if (!canDropOn(id)) { if (dropTarget != null) setDropTarget(null); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropTarget !== id) setDropTarget(id);
  }
  function onTreeDragLeave(e: DragEvent) {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDropTarget(null);
  }
  async function onTreeDrop(e: DragEvent) {
    const target = rowFromEvent(e);
    setDropTarget(null);
    const p = readExampleDrag(e.dataTransfer);
    if (!p || target == null || target === p.fromSetupId || !canDropOn(target)) return;
    e.preventDefault();
    const name = byId.get(target)?.name ?? `#${target}`;
    try {
      const r = await patchExample(p.fromSetupId, p.exampleId, { playbookId: target });
      invalidateExamples(qc, p.fromSetupId, target);
      toast({
        title: r?.merged ? t("page.toast.mergedInto", { name }) : t("page.toast.exampleMoved", { name }),
        action: r?.merged ? undefined : (
          <ToastAction
            altText={t("page.toast.moveBack")}
            onClick={async () => {
              try { await patchExample(target, p.exampleId, { playbookId: p.fromSetupId }); invalidateExamples(qc, p.fromSetupId, target); }
              catch (err) { toast({ title: t("page.toast.moveBackFailed"), description: (err as Error)?.message, variant: "destructive" }); }
            }}
          >
            {t("page.toast.moveBack")}
          </ToastAction>
        ),
      });
    } catch (err) {
      toast({ title: t("page.toast.moveFailed"), description: notLiveMessage(err) ?? (err as Error)?.message, variant: "destructive" });
    }
  }

  /* ---------- export / zoom ---------- */
  function exportMd() {
    if (!spaceEntries.length) return;
    try {
      downloadMarkdown(generatePlaybookMarkdown(spaceEntries as unknown as ExportEntry[], allFolders), `playbook-${localDateString()}.md`);
      toast({ title: t("page.toast.exported"), description: t("page.toast.exportedDesc", { count: topLevel.length }) });
    } catch (e: any) {
      toast({ title: t("page.toast.exportFailed"), description: e?.message, variant: "destructive" });
    }
  }
  async function exportNotion() {
    if (!spaceEntries.length || notionBusy) return;
    setNotionBusy(true);
    try {
      downloadBlob(await generateNotionZip(spaceEntries as unknown as ExportEntry[], allFolders), `playbook-notion-${localDateString()}.zip`);
      toast({ title: t("page.toast.notionReady"), description: "Notion → Import → Markdown & CSV" });
    } catch (e: any) {
      toast({ title: t("page.toast.notionFailed"), description: e?.message, variant: "destructive" });
    } finally {
      setNotionBusy(false);
    }
  }
  const changeZoom = (delta: number) => {
    setZoom((prev) => {
      const next = delta === 0 ? 1 : Math.min(1.5, Math.max(0.65, Math.round((prev + delta) * 20) / 20));
      lsSet(LS.zoom, next);
      return next;
    });
  };

  /** New setups go to «Офис» only from the office tab and only for curators; otherwise to «Мой». */
  const newSpace = activeSpace === "office" && viewer.isCurator ? "office" : "personal";
  const canCreate = viewer.canEdit;
  const newSetup = useCallback(
    (folder?: string | null) => { if (canCreate) setFormMode({ kind: "create", folder: folder ?? null, space: newSpace }); },
    [canCreate, newSpace],
  );
  const newLabel = newSpace === "office" ? t("page.newInOffice") : t("page.newInMine");
  /** Inbox «Новый сетап из сделки»: a personal setup (office for curators on the office tab) with the trade as its first example. */
  const newSetupFromTrade = useCallback(
    (t: InboxTrade) => { if (canCreate) setFormMode({ kind: "create", space: newSpace, fromTrade: { id: t.id, ticker: t.ticker, date: t.closeDate ?? t.date, tier: t.suggestedTier } }); },
    [canCreate, newSpace],
  );

  /* ---------- keyboard ---------- */
  // Ctrl/⌘+K inside the section opens the playbook's own quick find (capture phase, before the global palette).
  useEffect(() => {
    function onCapture(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key !== "k" && e.key !== "K" && e.key !== "л" && e.key !== "Л") return; // i18n-ignore (RU keyboard layout keys)
      if (overlayOpen()) return;
      e.preventDefault();
      e.stopImmediatePropagation(); // the global palette listens on window (bubble) — the section's own search wins here
      setFindOpen(true);
    }
    window.addEventListener("keydown", onCapture, true);
    return () => window.removeEventListener("keydown", onCapture, true);
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) || overlayOpen()) return;
      const k = e.key;
      if (k === "/") { e.preventDefault(); setFindOpen(true); return; }
      if (k === "?") { e.preventDefault(); setHelpOpen((v) => !v); return; }
      // Cyrillic letters below are the same physical keys on a RU keyboard layout.
      // i18n-ignore
      if (k === "n" || k === "т") { if (canCreate) { e.preventDefault(); newSetup(selected?.folder ?? null); } return; }
      if (k === "Escape" && selected) { e.preventDefault(); openSetup(null); return; }
      // i18n-ignore
      if ((k === "e" || k === "у") && selected && accessOf(selected, viewer).canEdit) { e.preventDefault(); setFormMode({ kind: "edit", entry: selected }); return; }
      // i18n-ignore
      if ((k === "c" || k === "с") && selected) { e.preventDefault(); setCompareFor(selected); return; }
      // i18n-ignore
      if ((k === "a" || k === "ф") && selected && live && accessOf(selected, viewer).canAddExamples) { e.preventDefault(); setPickerFor(selected); return; }
      if (k === "j" || k === "k" || k === "о" || k === "л") { // i18n-ignore (RU layout)
        if (!navOrder.length) return;
        e.preventDefault();
        const down = k === "j" || k === "о"; // i18n-ignore (RU layout)
        const i = selectedId ? navOrder.indexOf(selectedId) : -1;
        const next = i < 0 ? (down ? 0 : navOrder.length - 1) : Math.min(navOrder.length - 1, Math.max(0, i + (down ? 1 : -1)));
        if (view !== "library") setView("library");
        openSetup(navOrder[next], { replace: true, tab: setupTab });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCreate, selected, selectedId, navOrder, openSetup, newSetup, view, viewer, setupTab, live]);

  /* ---------- render pieces ---------- */
  const helpPopover = (
    <Popover open={helpOpen} onOpenChange={setHelpOpen}>
      <PopoverTrigger asChild>
        <IconAction aria-label={t("page.hotkeysTitle")} title={t("page.hotkeysTitle")} aria-keyshortcuts="?" className="h-9 w-9"><HelpCircle /></IconAction>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <p className="mb-2 text-sm font-semibold text-foreground">{t("page.hotkeysTitle")}</p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-sm">
          {HOTKEYS.map(([keys, key]) => (
            <div key={key} className="contents">
              <dt><Kbd keys={keys} className="[&_kbd]:text-xs" /></dt>
              <dd className="text-muted-foreground">{t(`page.hotkeys.${key}`)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">{t("page.mouseHint")}</p>
      </PopoverContent>
    </Popover>
  );

  const header = (
    <PageHeader
      title={t("page.title")}
      icon={BookOpen}
      description={t("page.description")}
      actions={
        <>
          <Button variant="outline" onClick={() => setFindOpen(true)} className="gap-2" aria-keyshortcuts="Control+K /" title={t("page.findTitle")}>
            <Search className="h-4 w-4" aria-hidden="true" />
            <span>{t("page.find")}</span>
          </Button>
          <Segmented<View>
            ariaLabel={t("page.viewAria")}
            value={view}
            onChange={setView}
            options={[
              { value: "library", label: <><Library className="h-4 w-4" aria-hidden="true" />{t("page.view.library")}</> },
              { value: "gallery", label: <><Trophy className="h-4 w-4" aria-hidden="true" />{t("page.view.gallery")}</> },
              { value: "grid", label: <><LayoutGrid className="h-4 w-4" aria-hidden="true" />{t("page.view.grid")}</> },
            ]}
          />
          {helpPopover}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconAction aria-label={commonI18n.t("actions.more")} title={commonI18n.t("actions.more")} className="h-9 w-9"><MoreHorizontal /></IconAction>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem onSelect={() => setCompareFor(selected ?? topLevel[0] ?? entries[0] ?? null)} disabled={!entries.length}>
                <Columns2 className="h-4 w-4" aria-hidden="true" /> {t("page.compare")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setActivityOpen(true)}><Activity className="h-4 w-4" aria-hidden="true" /> {t("page.activity")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t("page.exportLabel", { space: SPACES.find((s) => s.value === activeSpace)?.label ?? "" })}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={exportMd} disabled={!spaceEntries.length}><Download className="h-4 w-4" aria-hidden="true" /> {t("page.exportMd")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={exportNotion} disabled={!spaceEntries.length || notionBusy}>
                <FileArchive className="h-4 w-4" aria-hidden="true" /> {notionBusy ? t("page.notionBusy") : t("page.notion")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t("page.zoomLabel", { pct: Math.round(zoom * 100) })}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={(e) => { e.preventDefault(); changeZoom(0.05); }} disabled={zoom >= 1.5}><ZoomIn className="h-4 w-4" aria-hidden="true" /> {t("page.zoomIn")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={(e) => { e.preventDefault(); changeZoom(-0.05); }} disabled={zoom <= 0.65}><ZoomOut className="h-4 w-4" aria-hidden="true" /> {t("page.zoomOut")}</DropdownMenuItem>
              {zoom !== 1 && <DropdownMenuItem onSelect={(e) => { e.preventDefault(); changeZoom(0); }}>{t("page.zoomReset")}</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
          {canCreate && (
            <Button className="bg-primary-solid" onClick={() => newSetup(selected?.folder ?? null)} aria-keyshortcuts="n" title={newSpace === "office" ? t("page.newOfficeTitle") : t("page.newPersonalTitle")}>
              <Plus className="h-4 w-4" aria-hidden="true" /> {newLabel}
            </Button>
          )}
        </>
      }
    />
  );

  /** Page-level scope bar: full names + counts, the active space's rule underneath. «Все» only in the gallery. */
  const scopeOptions: { value: Scope; short: string; long: string; icon: LucideIcon; hint: string; count: number | null }[] = [
    ...(view === "gallery" ? [{ value: "all" as Scope, short: ALL_SCOPE.label, long: ALL_SCOPE.long, icon: ALL_SCOPE.icon, hint: ALL_SCOPE.hint, count: null }] : []),
    ...visibleSpaces.map((s) => ({ value: s.value as Scope, short: s.label, long: s.long, icon: s.icon, hint: s.hint, count: spaceCounts[s.value] })),
  ];
  const activeScope = scopeOptions.find((s) => s.value === shownScope) ?? scopeOptions[0];
  const pickScope = (v: Scope) => {
    setSpace(v);
    if (v !== "all" && selected) {
      const root = selected.parentId ? byId.get(selected.parentId) ?? selected : selected;
      if (tabOf.get(root.id) !== v) openSetup(null, { replace: true });
    }
  };
  const scopeBar = (
    <div className="flex flex-col gap-1.5">
      <div role="tablist" aria-label={t("page.spaceAria")} className="flex flex-wrap gap-1.5">
        {scopeOptions.map((s) => {
          const active = activeScope?.value === s.value;
          const Icon = s.icon;
          return (
            <button
              key={s.value}
              type="button"
              role="tab"
              aria-selected={active}
              title={s.hint}
              onClick={() => pickScope(s.value)}
              className={cn(
                "flex min-h-10 items-center gap-1.5 rounded-xl border px-2.5 text-sm sm:gap-2 sm:px-3 transition-colors duration-[var(--dur-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "border-primary/50 bg-primary/10 font-semibold text-foreground"
                  : "border-[var(--glass-border)] bg-[var(--glass-bg)] text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground",
              )}
            >
              <Icon className={cn("hidden h-4 w-4 shrink-0 sm:block", active ? "text-primary" : "")} aria-hidden="true" />
              <span className="whitespace-nowrap sm:hidden">{s.short}</span>
              <span className="hidden whitespace-nowrap sm:inline">{s.long}</span>
              {s.count != null && (
                <span className={cn("rounded-full px-1.5 text-xs tabular-nums", active ? "bg-primary/15 text-foreground" : "bg-[var(--glass-bg)] text-muted-foreground")}>{s.count}</span>
              )}
            </button>
          );
        })}
      </div>
      {activeScope && <p className="px-1 text-xs text-muted-foreground">{activeScope.hint}.</p>}
    </div>
  );

  const tagPopover = (
    <Popover>
      <PopoverTrigger asChild>
        <IconAction aria-label={tagFilter.length ? t("page.tagsSelected", { count: tagFilter.length }) : t("page.tagFilter")} title={tagFilter.length ? t("page.tagsSelected", { count: tagFilter.length }) : t("page.tagFilter")} aria-pressed={tagFilter.length > 0} disabled={!allTags.length} className={cn("relative h-9 w-9", tagFilter.length > 0 && "text-primary")}>
          <Tag />
          {tagFilter.length > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-xs leading-none text-primary-foreground tabular-nums">{tagFilter.length}</span>}
        </IconAction>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold">{t("page.tagFilter")}</span>
          {tagFilter.length > 0 && <button type="button" onClick={() => setTagFilter([])} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">{commonI18n.t("actions.reset")}</button>}
        </div>
        <p className="mb-2 text-xs text-muted-foreground">{t("page.tagFilterHint")}</p>
        <div className="flex max-h-[min(55dvh,420px)] flex-wrap gap-1.5 overflow-y-auto">
          {allTags.map(([t, n]) => (
            <button
              key={t}
              type="button"
              aria-pressed={tagFilter.includes(t)}
              onClick={() => setTagFilter((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))}
              className="chip min-h-7 px-2.5 text-xs"
            >
              {t} <span className="tabular-nums text-muted-foreground">{n}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );

  /** One filter row: «Вид» (sort) + filter. Tags and «collapse all» sit next to the search box. */
  const filterRow = (
    <div className="grid min-w-0 grid-cols-2 items-center gap-1.5">
      <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
        <SelectTrigger className="h-9 min-w-0" aria-label={t("page.listView")} title={`${t("page.listView")}: ${SORT_OPTIONS.find((o) => o.value === sort)?.label ?? ""}`}><SelectValue>{SORT_OPTIONS.find((o) => o.value === sort)?.short}</SelectValue></SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={quick} onValueChange={(v) => setQuick(v as QuickFilter)}>
        <SelectTrigger className={cn("h-9 min-w-0", quick !== "all" && "border-primary/60")} aria-label={t("page.filterAria")} title={`${t("page.filterAria")}: ${FILTERS.find((f) => f.value === quick)?.label ?? ""}`}><SelectValue>{FILTERS.find((f) => f.value === quick)?.short}</SelectValue></SelectTrigger>
        <SelectContent>
          {FILTERS.filter((f) => f.value !== "unreviewed" || activeSpace === "office" || quick === "unreviewed").map((f) => (
            <SelectItem key={f.value} value={f.value}>
              {f.value === "all" ? f.label : t("page.filterCount", { label: f.label, count: quickCounts[f.value] })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
  const searchRow = (withCollapse: boolean) => (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="min-w-0 flex-1">{searchBox}</div>
      {tagPopover}
      {withCollapse && !flat && (
        <IconAction aria-label={allOpen ? t("page.collapseAll") : t("page.expandAll")} title={allOpen ? t("page.collapseAll") : t("page.expandAll")} onClick={toggleAll} className="h-9 w-9">
          {allOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
        </IconAction>
      )}
    </div>
  );

  const searchBox = (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); setQuery(""); (e.target as HTMLInputElement).blur(); }
          if (e.key === "Enter" && flat?.[0]) { setView("library"); openSetup(flat[0].id); }
        }}
        placeholder={t("page.searchPlaceholder")}
        aria-label={t("page.searchPlaceholder")}
        className="h-9 pl-9 pr-9"
      />
      {query && (
        <button type="button" aria-label={commonI18n.t("actions.clearSearch")} onClick={() => setQuery("")} className="absolute right-1 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );

  const activeFilterNote = filtering && (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {tagFilter.map((t) => (
        <button key={t} type="button" onClick={() => setTagFilter((p) => p.filter((x) => x !== t))} className="chip min-h-6 px-2 text-xs" aria-label={playbookI18n.t("page.removeTag", { tag: t })}>
          #{t} <X className="h-3 w-3" aria-hidden="true" />
        </button>
      ))}
      <button type="button" onClick={() => { setQuery(""); setQuick("all"); setTagFilter([]); }} className="underline underline-offset-2 hover:text-foreground">
        {commonI18n.t("actions.resetFilters")}
      </button>
    </div>
  );

  const proposedBlock = activeSpace === "office" && proposed.length > 0 && (
    <section aria-label={t("page.proposed")} className="rounded-xl border border-primary/30 bg-primary/5 p-2">
      <h3 className="flex items-center gap-1.5 px-1 pb-1 text-xs font-semibold text-foreground">
        <Send className="h-3.5 w-3.5 text-primary" aria-hidden="true" /> {t("page.proposed")} <span className="tabular-nums text-muted-foreground">{proposed.length}</span>
      </h3>
      <ul className="space-y-0.5">
        {proposed.slice(0, 6).map((e) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => openSetup(e.id)}
              className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left text-sm hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={e.officeProposedNote ?? undefined}
            >
              <span className="min-w-0 flex-1 truncate">{e.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{personName(e.officeProposedBy ?? e.trader)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );

  const spaceEmpty = (
    <div className="glass-panel rounded-2xl">
      {activeSpace === "office" ? (
        <EmptyState
          icon={Building2}
          title={t("page.empty.officeTitle")}
          description={viewer.isCurator ? t("page.empty.officeCurator") : t("page.empty.officeTrader")}
          action={viewer.isCurator ? <Button className="bg-primary-solid" onClick={() => newSetup()}><Plus className="h-4 w-4" aria-hidden="true" /> {t("page.empty.officeAction")}</Button> : undefined}
        />
      ) : activeSpace === "mine" ? (
        <EmptyState
          icon={User}
          title={t("page.empty.mineTitle")}
          description={t("page.empty.mineDesc")}
          action={canCreate ? <Button className="bg-primary-solid" onClick={() => newSetup()}><Plus className="h-4 w-4" aria-hidden="true" /> {t("page.empty.mineAction")}</Button> : undefined}
        />
      ) : activeSpace === "shared" ? (
        <EmptyState
          icon={Share2}
          title={t("page.empty.sharedTitle")}
          description={t("page.empty.sharedDesc")}
        />
      ) : (
        <EmptyState icon={Users} title={t("page.empty.teamTitle")} />
      )}
    </div>
  );

  const showOwner = activeSpace === "shared" || activeSpace === "team";

  let body: ReactNode;
  if (isLoading) {
    body = (
      <div className="grid min-h-[640px] gap-[var(--grid-gap)] lg:grid-cols-[320px_minmax(0,1fr)]" aria-busy="true">
        <div className="glass-panel space-y-2 rounded-2xl p-3">{Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-9 rounded-xl" />)}</div>
        <div className="space-y-[var(--grid-gap)]"><Skeleton className="h-9 w-2/3 rounded-xl" /><div className="grid grid-cols-2 gap-[var(--grid-gap)]"><Skeleton className="h-64 rounded-2xl" /><Skeleton className="h-64 rounded-2xl" /></div></div>
      </div>
    );
  } else if (isError) {
    body = (
      <div className="glass-panel rounded-2xl">
        <EmptyState
          icon={BookOpen}
          title={t("page.loadFailed")}
          description={(error as Error)?.message}
          action={<Button variant="outline" onClick={() => refetch()}>{commonI18n.t("actions.retry")}</Button>}
        />
      </div>
    );
  } else if (view === "gallery") {
    body = <Gallery entries={entries} scope={galleryScope} viewerName={viewer.name} onOpenSetup={(id) => openFromElsewhere(id, "examples")} />;
  } else if (view === "grid") {
    const list = flat ?? sortEntries(topLevel.filter(passes), "name", summary);
    const sections: { title: string | null; items: PlaybookEntry[] }[] = flat
      ? [{ title: null, items: list }]
      : [...allFolders, null].map((f) => ({ title: f ?? commonI18n.t("fields.noFolder"), items: list.filter((e) => (e.folder ?? null) === f) })).filter((s) => s.items.length);
    body = (
      <div className="flex flex-col gap-[var(--grid-gap)]">
        {topLevel.length > 0 && (
          <Toolbar className="gap-3">
            <div className="w-full sm:w-72">{searchRow(false)}</div>
            <div className="w-full sm:w-[300px]">{filterRow}</div>
          </Toolbar>
        )}
        {activeFilterNote}
        {topLevel.length === 0 ? spaceEmpty : list.length === 0 ? (
          <div className="glass-panel rounded-2xl"><EmptyState icon={Search} title={commonI18n.t("states.nothingFound")} description={t("page.changeFilters")} /></div>
        ) : (
          sections.map((sec) => (
            <section key={sec.title ?? "all"} aria-label={sec.title ?? commonI18n.t("trading.setups")}>
              {sec.title && <h2 className="mb-2 px-1 text-sm font-semibold text-foreground">{sec.title} <span className="font-normal text-muted-foreground">{sec.items.length}</span></h2>}
              <div className="grid grid-cols-2 gap-[var(--grid-gap)] xl:grid-cols-3 2xl:grid-cols-4">
                {sec.items.map((e) => (
                  <SetupCard key={e.id} e={e} s={summary.get(e.id)} folderColors={folderColors} selected={selectedId === e.id} onOpen={(id) => openFromElsewhere(id)} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    );
  } else {
    // An empty space with nothing proposed: no sidebar — the empty state takes the full width.
    const showAside = topLevel.length > 0 || !!proposedBlock || !!selected;
    body = (
      <div className={cn("grid grid-cols-1 items-start gap-[var(--grid-gap)]", showAside && "lg:grid-cols-[320px_minmax(0,1fr)]")}>
        {showAside && <aside
          aria-label={commonI18n.t("trading.setups")}
          className={cn("glass-panel flex min-w-0 flex-col gap-3 rounded-2xl p-3 lg:sticky lg:top-[var(--sticky-top)] lg:z-sticky lg:max-h-[calc(100dvh-7rem)]", selected ? "hidden lg:flex" : "max-h-[60dvh]")}
          onDragOver={onTreeDragOver}
          onDragLeave={onTreeDragLeave}
          onDrop={onTreeDrop}
        >
          {topLevel.length > 0 ? (
            <>
              {searchRow(true)}
              {filterRow}
              {activeFilterNote}
              {proposedBlock}
              <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-1">
                <FolderTree
                  groups={groups}
                  flat={flat}
                  selectedId={selectedId}
                  onSelect={selectInTree}
                  openFolders={filtering ? new Set(groups.map((g) => g.folder ?? UNFILED)) : openFolders}
                  onToggleFolder={toggleFolder}
                  summary={summary}
                  folderColors={folderColors}
                  childrenOf={childrenOf}
                  query={deferredQuery}
                  canEdit={canManageFolders}
                  folderOrder={allFolders}
                  showOwner={showOwner}
                  dropTargetId={dropTarget}
                  canDragSetup={canManageFolders ? canDragSetup : undefined}
                  actions={{
                    onNewIn: (f) => newSetup(f),
                    onRename: setRenameFolder,
                    onColor: canFolderSettings ? setFolderColor : undefined,
                    onMove: canFolderSettings ? moveFolder : undefined,
                    onReorder: canFolderSettings ? reorderFolder : undefined,
                    onMoveSetup: moveSetupToFolder,
                    onCopyLink: copyFolderLink,
                    onDelete: activeSpace === "office" ? setDeleteFolder : undefined,
                  }}
                />
              </div>
            </>
          ) : (
            <>
              {proposedBlock}
              <p className="px-1 py-2 text-sm text-muted-foreground">{t("page.empty.inSpace")}</p>
            </>
          )}
        </aside>}

        <div className="min-w-0">
          {selected ? (
            <SetupView
              key={selected.id}
              entry={selected}
              allEntries={entries}
              summary={summary}
              folders={everyFolder}
              folderColors={folderColors}
              viewer={viewer}
              live={live}
              tab={setupTab}
              onTab={(t) => openSetup(selected.id, { replace: true, tab: t })}
              onOpen={(id) => openSetup(id)}
              onClose={() => openSetup(null)}
              onEdit={(e) => setFormMode({ kind: "edit", entry: e })}
              onDuplicate={(e) => setFormMode({ kind: "duplicate", source: e, space: accessOf(e, viewer).canEdit && accessOf(e, viewer).space === "office" ? "office" : "personal" })}
              onCreateChild={(p) => setFormMode({ kind: "child", parent: p })}
              onDelete={setDeleting}
              onCompare={setCompareFor}
              onFolderClick={(f) => {
                const key = f ?? UNFILED;
                setOpenFolders((prev) => { const next = new Set(prev); next.add(key); lsSet(LS.openFolders, [...next]); return next; });
                if (sort !== "folder") setSort("folder");
                openSetup(null);
              }}
              onAddExamples={setPickerFor}
              onShare={setShareFor}
            />
          ) : selectedId && isFetching ? (
            // Just created / opened from a link before the list refetched: wait instead of flashing «не найден».
            <div className="flex flex-col gap-[var(--grid-gap)]" aria-busy="true">
              <Skeleton className="h-44 rounded-2xl" />
              <Skeleton className="h-9 w-2/3 rounded-xl" />
              <Skeleton className="h-72 rounded-2xl" />
            </div>
          ) : selectedId ? (
            <div className="glass-panel rounded-2xl">
              <EmptyState icon={BookOpen} title={t("page.notFoundTitle")} description={t("page.notFoundDesc")} action={<Button variant="outline" onClick={() => openSetup(null)}>{t("page.toOverview")}</Button>} />
            </div>
          ) : topLevel.length === 0 ? (
            // An empty «Мой» is where a trader starts: the inbox of own trades is the quickest way in.
            <div className="flex flex-col gap-[var(--grid-gap)]">
              {spaceEmpty}
              {activeSpace === "mine" && <PlaybookInbox onNewSetup={newSetupFromTrade} />}
            </div>
          ) : (
            <Overview
              entries={topLevel}
              summary={summary}
              summaryLoaded={summaryQ.isSuccess}
              onOpen={(id) => openSetup(id)}
              onQuickFilter={(f) => { setQuick(f); if (sort === "folder" && f !== "all") setSort("name"); }}
              showHealth={activeSpace === "office" && viewer.isCurator}
              showReview={activeSpace === "office"}
              before={
                <>
                  <PlaybookInbox onNewSetup={newSetupFromTrade} />
                  <Tier1Strip
                    scope={activeSpace}
                    entries={entries}
                    viewerName={viewer.name}
                    onOpenSetup={(id) => openSetup(id, { tab: "examples" })}
                    onOpenGallery={() => setView("gallery")}
                  />
                </>
              }
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <Page className={cn(zoom !== 1 && "origin-top-left")}>
      <div className="flex flex-col gap-[var(--page-gap)]" style={zoom !== 1 ? { zoom } : undefined}>
        {header}
        {!isLoading && !isError && scopeBar}
        {body}
      </div>

      <SetupFormDialog
        mode={formMode}
        onClose={() => setFormMode(null)}
        folders={everyFolder}
        entries={entries}
        live={live}
        onOpenExisting={(id) => openFromElsewhere(id)}
        onSaved={(id) => { if (id && formMode?.kind !== "edit") openSetup(id); }}
      />
      <DeleteSetupDialog name={deleting?.name ?? null} open={!!deleting} onClose={() => setDeleting(null)} onConfirm={confirmDelete} pending={deletePending} />
      <RenameFolderDialog
        folder={renameFolder}
        onClose={() => setRenameFolder(null)}
        trader={trader}
        space={activeSpace === "mine" ? "personal" : activeSpace === "office" ? "office" : undefined}
        onRenamed={onFolderRenamed}
      />
      <DeleteFolderDialog
        folder={deleteFolder}
        count={deleteFolder ? folderTotals.get(deleteFolder) ?? 0 : 0}
        onClose={() => setDeleteFolder(null)}
        onConfirm={confirmDeleteFolder}
        pending={deleteFolderPending}
      />
      <CompareDialog
        open={!!compareFor}
        onOpenChange={(v) => { if (!v) setCompareFor(null); }}
        initial={compareFor}
        entries={entries}
        summary={summary}
        onOpen={(id) => openFromElsewhere(id)}
      />
      <QuickFind
        open={findOpen}
        onOpenChange={setFindOpen}
        entries={entries}
        summary={summary}
        folderColors={folderColors}
        recentIds={recentIds}
        onPick={(id) => openFromElsewhere(id)}
        actions={[
          ...(canCreate ? [{ id: "new", label: newLabel, icon: Plus, hint: "N", run: () => newSetup(selected?.folder ?? null) }] : []),
          { id: "gallery", label: t("page.action.gallery"), icon: Trophy, run: () => setView("gallery") },
          { id: "compare", label: t("page.compare"), icon: Columns2, hint: "C", run: () => setCompareFor(selected ?? topLevel[0] ?? entries[0] ?? null) },
          ...visibleSpaces.map((s) => ({ id: `space-${s.value}`, label: t("page.action.space", { name: s.label }), icon: s.icon, run: () => { setView("library"); setSpace(s.value); openSetup(null); } })),
          { id: "grid", label: view === "grid" ? t("page.action.viewLibrary") : t("page.action.viewGrid"), icon: view === "grid" ? Library : LayoutGrid, run: () => setView(view === "grid" ? "library" : "grid") },
          { id: "activity", label: t("page.activity"), icon: Activity, run: () => setActivityOpen(true) },
          { id: "export", label: t("page.action.exportMd"), icon: Download, run: exportMd },
        ]}
      />
      <ActivitySheet open={activityOpen} onOpenChange={setActivityOpen} />
      {pickerFor && <TradePickerDialog open={!!pickerFor} onOpenChange={(v) => { if (!v) setPickerFor(null); }} entry={pickerFor} />}
      {shareFor && <ShareDialog open={!!shareFor} onOpenChange={(v) => { if (!v) setShareFor(null); }} entry={shareFor} />}
    </Page>
  );
}
