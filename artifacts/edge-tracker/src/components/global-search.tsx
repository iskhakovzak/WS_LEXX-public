/**
 * Command palette (Ctrl/⌘K): search trades, tickers, setups, ideas, feed, research, events and pages;
 * run actions (new trade, new idea, theme, language…); jump anywhere ("Go to…", or G then a letter); recent items.
 * Texts: shell namespace `palette.*` (i18n/locales/<lang>/shell.ts).
 * Built on cmdk with our own filtering (corpora can be large), loaded lazily on first open.
 */
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Command as CommandPrimitive } from "cmdk";
import { useLocation } from "wouter";
import {
  useListEvents, useListResearch, useListDailyFeed,
  getListEventsQueryKey, getListResearchQueryKey, getListDailyFeedQueryKey,
} from "@workspace/api-client-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchTradesPage, TRADES_PAGE_KEY } from "@/hooks/use-trades-page";
import {
  Search, X, CandlestickChart, CalendarClock, BookOpen, Newspaper, BookMarked, Lightbulb, StickyNote,
  CornerDownLeft, History, Hash, Eye, MessageSquare, SunMoon, ArrowRight, Loader2,
  UserRound, UsersRound, ClipboardList, NotebookPen, BookText, Languages,
} from "lucide-react";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { tradeIdeasQuery } from "@/lib/api/queries";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/ds";
import { useAuth } from "@/contexts/auth-context";
import { useTheme } from "@/contexts/theme-context";
import { ALL_NAV_ITEMS, GO_KEYS, GO_KEYS_RU_LAYOUT, GO_MODE_EVENT, groupOf, parentOf, rowChildren, rowLabel, type NavItem } from "@/components/shell/nav";
import { useVisibleNav } from "@/components/shell/sidebar-nav";
import { rankPeople, usePeopleDirectory, type DirectoryPerson } from "@/components/people/search";
import { Highlight } from "@/components/people/highlight";
import { shellI18n } from "@/i18n/ns/shell";
import { commonI18n } from "@/i18n/ns/common";
import { fmtUsd } from "@/lib/format";
import { LANGS, LANG_META, personName, setLang, useLang } from "@/i18n";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl";
const HOTKEY_LABEL = IS_MAC ? "⌘K" : "Ctrl+K";
const OPEN_EVENT = "ws-open-palette";
const RECENT_KEY = "ws_lexx_palette_recent";
/** Extra match terms for the «Language: …» actions (hidden, not translated). i18n-ignore */
const LANG_SEARCH = { ru: "russian русский ruscha", en: "english английский inglizcha", uz: "uzbek узбекский ozbek" } as const;

/** Open the command palette from anywhere (e.g. a mobile button or an empty state). */
export function openCommandPalette(query?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { query } }));
}

type Section = "trades" | "ideas" | "playbook" | "feed" | "research" | "events";
/** Kinds stored in recents: a result section, a page, a ticker or a person (older entries stored Russian labels). */
type Kind = Section | "page" | "ticker" | "people";
const LEGACY_KIND: Record<string, Kind> = {
  "Сделки": "trades", "Идеи": "ideas", "Плейбук": "playbook", "Лента": "feed", "Исследования": "research", // i18n-ignore
  "События": "events", "Раздел": "page", "Тикер": "ticker", "Люди": "people", // i18n-ignore
};
function kindLabel(kind: string): string {
  const k = LEGACY_KIND[kind] ?? kind;
  if (k === "people") return shellI18n.t("palette.people.heading");
  return shellI18n.tryT(`palette.sections.${k}`) ?? kind;
}

/** People results (cross-script: «zokir», «Rakhmatullo», «Pfrbh» on the EN layout). */
// Getters: read during render, so they follow the UI language (shell `palette.people.*`).
const PEOPLE = {
  get heading() { return shellI18n.t("palette.people.heading"); },
  actionsFor: (name: string) => shellI18n.t("palette.people.actionsFor", { name }),
  get profile() { return shellI18n.t("palette.people.profile"); },
  get trades() { return shellI18n.t("palette.people.trades"); },
  get day() { return shellI18n.t("palette.people.day"); },
  get journal() { return shellI18n.t("palette.people.journal"); },
  get notes() { return shellI18n.t("palette.people.notes"); },
  get group() { return shellI18n.t("palette.people.group"); },
  get role(): Record<string, string> {
    const t = shellI18n.t;
    return { trader: t("palette.people.role.trader"), curator: t("palette.people.role.curator"), admin: t("palette.people.role.admin") };
  },
  curatorOf: (c: string) => shellI18n.t("palette.people.curatorOf", { name: c }),
  get noCurator() { return shellI18n.t("palette.people.noCurator"); },
  latin: (n: string) => shellI18n.t("palette.people.latin", { name: n }),
};

type ResultItem = {
  id: string;
  section: Section;
  title: string;
  subtitle?: string;
  badge?: string;
  badgeTone?: "up" | "down" | "warn" | "neutral" | "accent";
  meta?: string;
  path: string;
  /** Fires the in-page `ws-search-navigate` event for pages already mounted. */
  highlight?: number;
};

/** `person`: the stored name of a person result (shown through personName, so it follows the UI language). */
type RecentItem = { id: string; title: string; subtitle?: string; path: string; kind: string; highlight?: number; person?: string };

const SECTION_ICON: Record<Section, React.ElementType> = {
  trades: CandlestickChart,
  ideas: Lightbulb,
  playbook: BookMarked,
  feed: Newspaper,
  research: BookOpen,
  events: CalendarClock,
};

const BADGE_TONE: Record<NonNullable<ResultItem["badgeTone"]>, string> = {
  up: "bg-up/15 text-up",
  down: "bg-down/15 text-down",
  warn: "bg-[hsl(var(--chart-3)/0.15)] text-[hsl(var(--chart-3))]",
  accent: "bg-primary/15 text-primary",
  neutral: "bg-[var(--glass-bg)] text-muted-foreground",
};

async function fetchList(path: string, signal?: AbortSignal): Promise<any[]> {
  const data = await http.get<unknown>(path, { signal });
  return Array.isArray(data) ? data : [];
}

const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const has = (v: unknown, q: string) => typeof v === "string" && v.toLowerCase().includes(q);
const clip = (v: unknown, n = 80) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);

function loadRecent(): RecentItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.path === "string" && typeof r.title === "string").slice(0, 7) : [];
  } catch {
    return [];
  }
}
function saveRecent(item: RecentItem) {
  try {
    const next = [item, ...loadRecent().filter((r) => r.id !== item.id)].slice(0, 7);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
}

/** A recent page shows its name in the current language (the stored title is from the language at save time). */
function recentTitle(r: RecentItem): string {
  if (r.person) return personName(r.person);
  return r.id.startsWith("page-") ? (ALL_NAV_ITEMS.find((i) => `page-${i.href}` === r.id)?.name ?? r.title) : r.title;
}

function isTypingTarget(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

function tradeResult(t: any): Pick<ResultItem, "badge" | "badgeTone"> {
  const pnl = typeof t.pnl === "number" ? t.pnl - (typeof t.fees === "number" ? t.fees : 0) : null;
  if (pnl != null && Number.isFinite(pnl) && pnl !== 0) {
    // Money keeps the trading format in every language ($1,234).
    const s = fmtUsd(pnl, { signed: true, decimals: 0 });
    return { badge: s, badgeTone: pnl > 0 ? "up" : "down" };
  }
  if (t.result === "win") return { badge: commonI18n.t("trading.win"), badgeTone: "up" };
  if (t.result === "loss") return { badge: commonI18n.t("trading.loss"), badgeTone: "down" };
  if (t.result) return { badge: commonI18n.t("trading.breakeven"), badgeTone: "neutral" };
  return {};
}

const IDEA_STATUS_TONE: Record<string, ResultItem["badgeTone"]> = { approved: "up", published: "warn", draft: "neutral", rejected: "down" };
const ideaStatusLabel = (status: string) => shellI18n.tryT(`palette.ideaStatus.${status}`) ?? status;

function Item({
  value,
  onSelect,
  icon: Icon,
  title,
  subtitle,
  right,
  className,
}: {
  value: string;
  onSelect: () => void;
  icon?: React.ElementType;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <CommandPrimitive.Item
      value={value}
      onSelect={onSelect}
      className={cn(
        "group flex min-h-10 cursor-pointer select-none items-center gap-3 rounded-xl px-2.5 py-2 text-sm outline-none",
        "data-[selected=true]:bg-primary/12 data-[selected=true]:text-foreground",
        className,
      )}
    >
      {Icon && (
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg)] text-muted-foreground group-data-[selected=true]:text-primary">
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{title}</span>
        {subtitle && <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>}
      </span>
      {right}
      <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-data-[selected=true]:opacity-100" aria-hidden="true" />
    </CommandPrimitive.Item>
  );
}

const groupCls =
  "px-1.5 pb-1 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground";

/** Value that settles `ms` after the last change (server-side search inputs). */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [notesOnly, setNotesOnly] = useState(false);
  const [recent, setRecent] = useState<RecentItem[]>(() => loadRecent());
  const [, navigate] = useLocation();
  const { canEdit, isCurator, user } = useAuth();
  const me = user?.traderName ?? null;
  const { people: directory } = usePeopleDirectory(open);
  const { cycleTheme, themeLabel } = useTheme();
  const { t: ts } = shellI18n.useT();
  const { t: tc } = commonI18n.useT();
  const lang = useLang();
  const inputRef = useRef<HTMLInputElement>(null);

  // Trades are searched server-side (P1-5): GET /api/trades/page?q=&limit=20 per (deferred) query instead of
  // loading the whole book into the palette. Other corpora load after the first open (then stay cached).
  // Debounced (200 ms): typing «NVDA» used to fire 4 server searches; now one after the pause.
  const tradeQ = useDebounced(query, 200).trim().replace(/^\$/, "").slice(0, 120);
  const { data: tradesRaw, isLoading: l1 } = useQuery<any[]>({
    queryKey: [TRADES_PAGE_KEY, "search", tradeQ.toLowerCase()],
    queryFn: async ({ signal }) => (await fetchTradesPage(new URLSearchParams({ q: tradeQ, limit: "20" }), signal)).items ?? [],
    enabled: open && tradeQ.length > 0,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  const { data: eventsRaw, isLoading: l2 } = useListEvents(undefined, { query: { queryKey: getListEventsQueryKey(), enabled: open } });
  const { data: researchRaw, isLoading: l3 } = useListResearch({ query: { queryKey: getListResearchQueryKey(), enabled: open } });
  const { data: feedsRaw, isLoading: l4 } = useListDailyFeed({ query: { queryKey: getListDailyFeedQueryKey(), enabled: open } });
  const { data: playbookRaw, isLoading: l5 } = useQuery<any[]>({
    queryKey: ["playbook"],
    queryFn: ({ signal }) => fetchList("/api/playbook", signal),
    enabled: open,
    staleTime: STALE.default,
  });
  // Same cache entry as the ideas board / stats / ratings (one request).
  const { data: tradeIdeasRaw, isLoading: l6 } = useQuery({ ...tradeIdeasQuery<any>(), enabled: open });
  const trades = asArray<any>(tradesRaw);
  const events = asArray<any>(eventsRaw);
  const research = asArray<any>(researchRaw);
  const feeds = asArray<any>(feedsRaw);
  const playbook = asArray<any>(playbookRaw);
  const tradeIdeas = asArray<any>(tradeIdeasRaw);
  const tradePending = query.trim().replace(/^\$/, "").slice(0, 120) !== tradeQ;
  const loading = open && ((tradeQ.length > 0 && (l1 || tradePending)) || l2 || l3 || l4 || l5 || l6);

  // ── Global keys: Ctrl/⌘K toggles; "G then letter" jumps to a section (outside text fields). ──
  useEffect(() => {
    let gAt = 0;
    function onKey(e: KeyboardEvent) {
      // «л» = K on the Russian keyboard layout (key codes, not text). i18n-ignore
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K" || e.key === "л" || e.key === "Л")) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || isTypingTarget(e.target)) return;
      if (document.querySelector("[role='dialog'][data-state='open'], [role='alertdialog']")) return;
      const k = e.key.toLowerCase();
      if (k === "g" || k === "п") { // i18n-ignore (RU layout key)
        gAt = Date.now();
        // The sidebar shows every letter while it waits for the second key.
        window.dispatchEvent(new CustomEvent(GO_MODE_EVENT, { detail: true }));
        return;
      }
      if (gAt && Date.now() - gAt < 1200) {
        gAt = 0;
        window.dispatchEvent(new CustomEvent(GO_MODE_EVENT, { detail: false }));
        const href = GO_KEYS[k] ?? GO_KEYS[GO_KEYS_RU_LAYOUT[k] ?? ""];
        if (href) { e.preventDefault(); navigate(href); }
      }
    }
    function onOpen(e: Event) {
      const q = (e as CustomEvent<{ query?: string }>).detail?.query;
      if (typeof q === "string") setQuery(q);
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, [navigate]);

  useEffect(() => {
    if (open) setRecent(loadRecent());
    else { setQuery(""); setNotesOnly(false); }
  }, [open]);

  const deferredQuery = useDeferredValue(query);
  const raw = deferredQuery.trim();
  const q = raw.toLowerCase().replace(/^\$/, "");
  const isStale = query !== deferredQuery;

  // ── Data results ──
  const results: ResultItem[] = useMemo(() => {
    if (!q) return [];
    const items: ResultItem[] = [];
    const tradeItem = (t: any): ResultItem => ({
      id: `trade-${t.id}`,
      section: "trades",
      title: t.ticker ?? "—",
      subtitle: notesOnly ? clip(t.notes) : [
        t.setup,
        t.side === "short" ? ts("palette.side.short") : t.side === "long" ? ts("palette.side.long") : null,
        t.horizon && t.horizon !== "intraday" ? (t.horizon === "swing" ? ts("palette.horizon.swing") : ts("palette.horizon.overnight")) : null,
      ].filter(Boolean).join(" · ") || undefined,
      ...tradeResult(t),
      meta: t.date?.substring(0, 10),
      path: "/trades",
      highlight: t.id,
    });
    const ideaItem = (i: any): ResultItem => ({
      id: `idea-${i.id}`,
      section: "ideas",
      title: i.ticker ?? "—",
      subtitle: notesOnly ? clip(i.notes || i.description) : [i.setup, personName(i.trader)].filter(Boolean).join(" · ") || undefined,
      badge: ideaStatusLabel(i.status),
      badgeTone: IDEA_STATUS_TONE[i.status] ?? "neutral",
      meta: i.createdAt?.substring?.(0, 10),
      path: `/trade-ideas?idea=${i.id}`,
    });
    const pbItem = (e: any): ResultItem => ({
      id: `playbook-${e.id}`,
      section: "playbook",
      title: e.name ?? ts("palette.fallback.setup"),
      subtitle: notesOnly ? clip(e.notes || e.conditions) : (e.parentId ? ts("palette.setupVariation") : e.folder || clip(e.conditions, 60)),
      badge: e.confidenceLevel != null ? `${e.confidenceLevel}%` : undefined,
      badgeTone: e.confidenceLevel >= 85 ? "up" : e.confidenceLevel >= 70 ? "accent" : "warn",
      // Deep link (the page opens ?id= in the library view on its own); an event fired right after navigate()
      // arrived before the lazy page mounted, so the setup never opened from another page.
      path: `/playbook?id=${e.id}`,
    });
    const feedItem = (f: any): ResultItem => ({
      id: `feed-${f.id}`,
      section: "feed",
      title: f.date?.substring(0, 10) ?? ts("palette.fallback.feedEntry"),
      subtitle: clip(notesOnly ? f.notes || f.whatWorksNow : f.marketTheme || f.notes, 70),
      path: "/dailyfeed",
      highlight: f.id,
    });
    const resItem = (r: any): ResultItem => ({
      id: `research-${r.id}`,
      section: "research",
      title: r.patternName ?? ts("palette.fallback.research"),
      subtitle: notesOnly ? clip(r.description || r.context) : r.ticker || clip(r.description, 60),
      badge: r.confidenceLevel != null ? `${r.confidenceLevel}%` : undefined,
      badgeTone: r.confidenceLevel >= 70 ? "up" : "neutral",
      path: "/research",
    });
    const evItem = (e: any): ResultItem => ({
      id: `event-${e.id}`,
      section: "events",
      title: e.ticker ?? ts("palette.fallback.event"),
      subtitle: clip(notesOnly ? e.summary : e.headline || e.summary),
      meta: e.date?.substring(0, 10),
      path: `/events?id=${e.id}`,
    });

    if (notesOnly) {
      tradeIdeas.filter((i) => has(i.notes, q) || has(i.description, q)).slice(0, 4).forEach((i) => items.push(ideaItem(i)));
      trades.filter((t) => has(t.notes, q)).slice(0, 6).forEach((t) => items.push(tradeItem(t)));
      playbook.filter((e) => has(e.notes, q) || has(e.conditions, q) || has(e.checklist, q)).slice(0, 5).forEach((e) => items.push(pbItem(e)));
      feeds.filter((f) => has(f.notes, q) || has(f.whatWorksNow, q) || has(f.whatDoesntWork, q)).slice(0, 4).forEach((f) => items.push(feedItem(f)));
      research.filter((r) => has(r.description, q) || has(r.context, q) || has(r.whatWorked, q)).slice(0, 3).forEach((r) => items.push(resItem(r)));
      events.filter((e) => has(e.summary, q)).slice(0, 3).forEach((e) => items.push(evItem(e)));
      return items;
    }
    // Exact ticker hits first, then partial matches.
    const tickerFirst = <T,>(arr: T[], get: (x: T) => unknown) =>
      [...arr].sort((a, b) => Number(String(get(b) ?? "").toLowerCase() === q) - Number(String(get(a) ?? "").toLowerCase() === q));
    tickerFirst(trades.filter((t) => has(t.ticker, q) || has(t.setup, q) || has(t.notes, q) || has(t.tags, q) || has(t.trader, q)), (t: any) => t.ticker)
      .slice(0, 5).forEach((t) => items.push(tradeItem(t)));
    tickerFirst(tradeIdeas.filter((i) => has(i.ticker, q) || has(i.setup, q) || has(i.trader, q) || has(i.tags, q) || has(i.notes, q) || has(i.description, q)), (i: any) => i.ticker)
      .slice(0, 5).forEach((i) => items.push(ideaItem(i)));
    playbook.filter((e) => has(e.name, q) || has(e.conditions, q) || has(e.notes, q) || has(e.tags, q) || has(e.folder, q) || has(e.checklist, q))
      .slice(0, 4).forEach((e) => items.push(pbItem(e)));
    feeds.filter((f) => has(f.marketTheme, q) || has(f.notes, q) || has(f.tags, q) || has(f.bestTickers, q) || has(f.whatWorksNow, q) || has(f.whatDoesntWork, q) || (typeof f.date === "string" && f.date.includes(q)))
      .slice(0, 4).forEach((f) => items.push(feedItem(f)));
    research.filter((r) => has(r.patternName, q) || has(r.description, q) || has(r.ticker, q) || has(r.context, q) || has(r.whatWorked, q))
      .slice(0, 3).forEach((r) => items.push(resItem(r)));
    events.filter((e) => has(e.ticker, q) || has(e.headline, q) || has(e.summary, q))
      .slice(0, 3).forEach((e) => items.push(evItem(e)));
    return items;
  }, [q, notesOnly, trades, playbook, feeds, research, events, tradeIdeas]);

  const sections = useMemo(() => {
    const map = new Map<Section, ResultItem[]>();
    for (const item of results) {
      const arr = map.get(item.section);
      if (arr) arr.push(item); else map.set(item.section, [item]);
    }
    return map;
  }, [results]);

  // ── People ──
  const peopleHits = useMemo(() => {
    if (!q || notesOnly) return [];
    // Field 0 is the name as shown (Latin in EN/UZ when set), field 1 the other spelling, field 2 the curator.
    const other = new Map<string, string>();
    for (const p of directory) {
      const shown = personName(p.name);
      const alt = shown !== p.name ? p.name : p.nameLatin;
      if (alt && alt !== shown) other.set(shown, alt);
    }
    return rankPeople(directory, raw, (p) => personName(p.name), other, (p) => [p.curator], 6)
      // a curator match (secondary field) only when it is a strong one
      .filter((h) => h.field !== 2 || h.tier === "exact" || h.tier === "prefix");
  }, [q, raw, notesOnly, directory]);
  const groupSize = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of directory) if (p.role === "trader" && p.curator) m.set(p.curator, (m.get(p.curator) ?? 0) + 1);
    return m;
  }, [directory]);
  const enc = encodeURIComponent;
  const personActions = (p: DirectoryPerson) => {
    const isTrader = p.role === "trader";
    const self = p.name === me;
    const out: { id: string; label: string; icon: React.ElementType; path: string }[] = [];
    if (isCurator && isTrader) out.push({ id: "profile", label: PEOPLE.profile, icon: UserRound, path: `/curator?trader=${enc(p.name)}` });
    if (isTrader && (isCurator || self)) {
      out.push({ id: "trades", label: PEOPLE.trades, icon: CandlestickChart, path: `/trades?trader=${enc(p.name)}` });
      out.push({ id: "day", label: PEOPLE.day, icon: ClipboardList, path: `/day-report?trader=${enc(p.name)}` });
      out.push({ id: "journal", label: PEOPLE.journal, icon: BookText, path: `/journal?trader=${enc(p.name)}` });
    }
    if (isCurator && isTrader) out.push({ id: "notes", label: PEOPLE.notes, icon: NotebookPen, path: `/curator?trader=${enc(p.name)}&tab=notes` });
    if (isCurator && !isTrader && (groupSize.get(p.name) ?? 0) > 0) out.push({ id: "group", label: ts("palette.people.groupCount", { count: groupSize.get(p.name) ?? 0 }), icon: UsersRound, path: `/curator?view=traders&group=${enc(p.name)}` });
    return out;
  };
  const personSubtitle = (p: DirectoryPerson) => [
    PEOPLE.role[p.role] ?? p.role,
    p.role === "trader" ? (p.curator ? PEOPLE.curatorOf(personName(p.curator)) : PEOPLE.noCurator) : null,
    // The Latin alias only when it is not already the name shown (RU, or a Latin name that differs).
    p.nameLatin && p.nameLatin !== personName(p.name) ? PEOPLE.latin(p.nameLatin) : null,
  ].filter(Boolean).join(" · ");
  const topPerson = peopleHits[0]?.item ?? null;
  const topActions = topPerson ? personActions(topPerson).slice(1) : [];

  // ── Tickers known to the desk (trades + ideas), with counts ──
  const tickerIndex = useMemo(() => {
    const m = new Map<string, { trades: number; ideas: number }>();
    for (const t of trades) {
      const k = String(t.ticker ?? "").toUpperCase();
      if (!k) continue;
      const e = m.get(k) ?? { trades: 0, ideas: 0 };
      e.trades++; m.set(k, e);
    }
    for (const i of tradeIdeas) {
      const k = String(i.ticker ?? "").toUpperCase();
      if (!k) continue;
      const e = m.get(k) ?? { trades: 0, ideas: 0 };
      e.ideas++; m.set(k, e);
    }
    return m;
  }, [trades, tradeIdeas]);

  const looksLikeTicker = !notesOnly && /^\$?[a-zA-Z][a-zA-Z.]{0,5}$/.test(raw);
  const ticker = looksLikeTicker ? raw.replace(/^\$/, "").toUpperCase() : "";
  const otherTickers = useMemo(() => {
    if (!q || notesOnly || q.length > 6) return [];
    const up = q.toUpperCase();
    return [...tickerIndex.entries()]
      .filter(([k]) => k.startsWith(up) && k !== up)
      .sort((a, b) => b[1].trades + b[1].ideas - (a[1].trades + a[1].ideas))
      .slice(0, 5);
  }, [q, notesOnly, tickerIndex]);

  // ── Pages ──
  // Empty query: the sidebar rows under the sidebar's own group headings (same IA, ~15 rows). With a query: every page,
  // second-level ones included, each with where it lives in the sidebar («Разбор и рост · Аналитика»).
  const navGroups = useVisibleNav();
  const pages = useMemo(() => {
    if (!q) return [];
    const visible = ALL_NAV_ITEMS.filter((i) => !i.staff || isCurator);
    // Current-language name, the Russian name and the RU/EN keywords: a section is found whatever language you type in.
    const hit = (s?: string) => !!s && s.toLowerCase().includes(q);
    return visible.filter((i) => hit(i.name) || hit(i.ruName) || hit(i.hubLabel) || hit(i.ruHubLabel) || hit(i.keywords)).slice(0, 8);
  }, [q, isCurator]);
  const pagePath = (p: NavItem) => {
    const owner = parentOf(p) ?? (p.hubLabel ? p : undefined);
    return [groupOf(p)?.label, owner ? rowLabel(owner) : null].filter(Boolean).join(" · ") || undefined;
  };
  const goKeyHint = (p: NavItem) => (p.goKey ? <Kbd keys={["G", p.goKey.toUpperCase()]} className="hidden sm:inline-flex" /> : undefined);

  const go = useCallback(
    (path: string, rec?: Omit<RecentItem, "path">, highlight?: number) => {
      setOpen(false);
      if (rec) saveRecent({ ...rec, path, highlight });
      navigate(path);
      if (highlight != null) {
        const base = path.split("?")[0];
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent("ws-search-navigate", { detail: { path: base, highlightId: highlight } }));
        }, 0);
      }
    },
    [navigate],
  );

  const goResult = (item: ResultItem) => {
    const path = item.highlight != null && !item.path.includes("?") ? `${item.path}?highlight=${item.highlight}` : item.path;
    go(path, { id: item.id, title: item.title, subtitle: item.subtitle, kind: item.section }, item.highlight);
  };
  const goPage = (p: NavItem) => go(p.href, { id: `page-${p.href}`, title: p.name, kind: "page" });

  type Action = { id: string; label: string; hint?: string; icon: React.ElementType; run: () => void; keywords: string; when?: boolean };
  const actions: Action[] = [
    { id: "new-idea", label: ts("palette.action.newIdea"), icon: Lightbulb, run: () => go("/trade-ideas?new=1"), keywords: "new idea добавить идею yangi goya", when: canEdit },
    { id: "new-event", label: ts("palette.action.newEvent"), icon: CalendarClock, run: () => go("/events?new=1"), keywords: "new event катализатор отчёт yangi voqea", when: canEdit },
    { id: "theme", label: ts("palette.action.theme"), hint: tc("theme.currentHint", { name: themeLabel }), icon: SunMoon, run: () => cycleTheme(), keywords: "theme тема dark light тёмная светлая mavzu" },
    // «Язык: English» / «Language: Oʻzbekcha»… for each other language; «язык», «language», «til» match in any UI language.
    ...LANGS.filter((l) => l !== lang).map((l): Action => ({
      id: `lang-${l}`,
      label: ts("palette.action.language", { name: LANG_META[l].native }),
      icon: Languages,
      run: () => { setOpen(false); void setLang(l, { source: "user", focus: "#main-content" }); },
      keywords: `language язык til lang ${LANG_META[l].native} ${LANG_META[l].code} ${LANG_SEARCH[l]}`,
    })),
  ].filter((a) => a.when !== false);
  const visibleActions = q ? actions.filter((a) => a.label.toLowerCase().includes(q) || a.keywords.toLowerCase().includes(q)) : actions;

  const tickerActions = ticker
    ? [
        { id: "t-ideas", label: ts("palette.tickerAction.ideas", { ticker }), icon: Lightbulb, path: `/trade-ideas?ticker=${encodeURIComponent(ticker)}` },
        { id: "t-watch", label: ts("palette.tickerAction.watch", { ticker }), icon: Eye, path: `/watchlist?ticker=${encodeURIComponent(ticker)}` },
        { id: "t-events", label: ts("palette.tickerAction.events", { ticker }), icon: CalendarClock, path: `/events?ticker=${encodeURIComponent(ticker)}` },
        { id: "t-disc", label: ts("palette.tickerAction.discussions", { ticker }), icon: MessageSquare, path: `/discussions?ticker=${encodeURIComponent(ticker)}` },
      ]
    : [];
  const tickerStats = ticker ? tickerIndex.get(ticker) : undefined;

  const nothing =
    !!q && !loading && !isStale && results.length === 0 && pages.length === 0 && visibleActions.length === 0 && !ticker && otherTickers.length === 0 && peopleHits.length === 0;

  const trigger = (
    <DialogPrimitive.Trigger asChild>
      <button
        type="button"
        // Fixed width + short label: never clipped to «Поиск или к…» next to the logo and the market clock.
        // Sized by the header (`@container` in layout.tsx): icon-only until the header has room for the label.
        className="glass-field flex h-10 min-w-10 shrink-0 items-center justify-center gap-2 px-3 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring @[720px]:w-44 @[720px]:min-w-0 @[720px]:shrink @[720px]:justify-start @[720px]:pl-3.5 @[720px]:pr-1.5 @[1180px]:w-56"
        title={ts("palette.triggerTitle", { hotkey: HOTKEY_LABEL })}
        aria-label={ts("palette.triggerTitle", { hotkey: HOTKEY_LABEL })}
      >
        <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="hidden min-w-0 flex-1 truncate text-left @[720px]:inline">{ts("palette.triggerLabel")}</span>
        <Kbd keys={[MOD, "K"]} className="hidden @[1180px]:inline-flex" />
      </button>
    </DialogPrimitive.Trigger>
  );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      {trigger}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-modal bg-[var(--overlay)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus(); }}
          className="glass-thick glass-solid fixed left-1/2 top-[max(10vh,calc(env(safe-area-inset-top)+0.75rem))] z-modal flex max-h-[min(640px,80dvh)] w-[calc(100%-1.5rem)] max-w-2xl -translate-x-1/2 flex-col overflow-hidden rounded-2xl bg-popover text-popover-foreground outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:zoom-in-[0.98]"
        >
          <DialogPrimitive.Title className="sr-only">{ts("palette.title")}</DialogPrimitive.Title>
          <CommandPrimitive shouldFilter={false} loop label={ts("palette.title")} className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-[var(--glass-border)] px-4">
              {loading || isStale ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
              ) : (
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <CommandPrimitive.Input
                ref={inputRef}
                value={query}
                onValueChange={setQuery}
                placeholder={notesOnly ? ts("palette.placeholderNotes") : ts("palette.placeholder")}
                aria-label={ts("palette.inputAria")}
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="go"
                className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
              />
              <button
                type="button"
                onClick={() => { setNotesOnly((v) => !v); inputRef.current?.focus(); }}
                aria-pressed={notesOnly}
                title={ts("palette.notesToggleTitle")}
                className="chip inline-flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-xs font-medium"
              >
                <StickyNote className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">{ts("palette.notesToggle")}</span>
              </button>
              {query && (
                <button type="button" aria-label={ts("palette.clearAria")} onClick={() => { setQuery(""); inputRef.current?.focus(); }} className="chip grid h-8 w-8 shrink-0 place-items-center">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
              <DialogPrimitive.Close className="chip hidden h-8 shrink-0 items-center px-2.5 text-2xs font-medium sm:inline-flex" aria-label={ts("palette.closeAria")}>
                Esc
              </DialogPrimitive.Close>
            </div>

            <CommandPrimitive.List className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
              {nothing && (
                <div role="status" className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {notesOnly ? ts("palette.nothingInNotes", { query: raw }) : ts("palette.nothing", { query: raw })}
                </div>
              )}

              {!q && recent.length > 0 && (
                <CommandPrimitive.Group heading={ts("palette.recent")} className={groupCls}>
                  {recent.map((r) => (
                    <Item
                      key={r.id}
                      value={`recent-${r.id}`}
                      icon={History}
                      title={recentTitle(r)}
                      subtitle={[kindLabel(r.kind), r.subtitle].filter(Boolean).join(" · ")}
                      onSelect={() => go(r.path, { id: r.id, title: r.title, subtitle: r.subtitle, kind: r.kind, person: r.person }, r.highlight)}
                    />
                  ))}
                </CommandPrimitive.Group>
              )}

              {peopleHits.length > 0 && (
                <CommandPrimitive.Group heading={PEOPLE.heading} className={groupCls}>
                  {peopleHits.map((h) => {
                    const acts = personActions(h.item);
                    const main = acts[0];
                    return (
                      <Item
                        key={`person-${h.item.id}`}
                        value={`person-${h.item.id}`}
                        icon={h.item.role === "trader" ? UserRound : UsersRound}
                        title={h.field === 0 ? <Highlight text={personName(h.item.name)} ranges={h.ranges} /> : personName(h.item.name)}
                        subtitle={personSubtitle(h.item)}
                        right={main ? <span className="hidden shrink-0 text-2xs text-muted-foreground sm:inline">{main.label}</span> : undefined}
                        onSelect={() => main ? go(main.path, { id: `person-${h.item.id}`, title: h.item.name, subtitle: main.label, kind: "people", person: h.item.name }) : setQuery(personName(h.item.name))}
                      />
                    );
                  })}
                </CommandPrimitive.Group>
              )}

              {topPerson && topActions.length > 0 && (
                <CommandPrimitive.Group heading={PEOPLE.actionsFor(personName(topPerson.name))} className={groupCls}>
                  {topActions.map((a) => (
                    <Item
                      key={a.id}
                      value={`person-act-${a.id}`}
                      icon={a.icon}
                      title={a.label}
                      subtitle={personName(topPerson.name)}
                      onSelect={() => go(a.path, { id: `person-${topPerson.id}-${a.id}`, title: topPerson.name, subtitle: a.label, kind: "people", person: topPerson.name })}
                    />
                  ))}
                </CommandPrimitive.Group>
              )}

              {ticker && (
                <CommandPrimitive.Group heading={tickerStats ? ts("palette.tickerHeadingStats", { ticker, trades: tickerStats.trades, ideas: tickerStats.ideas }) : ts("palette.tickerHeading", { ticker })} className={groupCls}>
                  {tickerActions.map((a) => (
                    <Item key={a.id} value={a.id} icon={a.icon} title={a.label} onSelect={() => go(a.path, { id: a.id, title: a.label, kind: "ticker" })} />
                  ))}
                </CommandPrimitive.Group>
              )}

              {otherTickers.length > 0 && (
                <CommandPrimitive.Group heading={ts("palette.tickers")} className={groupCls}>
                  {otherTickers.map(([k, c]) => (
                    <Item
                      key={k}
                      value={`ticker-${k}`}
                      icon={Hash}
                      title={k}
                      subtitle={ts("palette.tickerCounts", { trades: tc("units.trades", { count: c.trades }), ideas: tc("units.ideas", { count: c.ideas }) })}
                      right={<ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}
                      onSelect={() => { setQuery(k); inputRef.current?.focus(); }}
                    />
                  ))}
                </CommandPrimitive.Group>
              )}

              {visibleActions.length > 0 && (
                <CommandPrimitive.Group heading={ts("palette.actions")} className={groupCls}>
                  {visibleActions.map((a) => (
                    <Item
                      key={a.id}
                      value={`action-${a.id}`}
                      icon={a.icon}
                      title={a.label}
                      subtitle={a.hint}
                      onSelect={a.run}
                    />
                  ))}
                </CommandPrimitive.Group>
              )}

              {[...sections.entries()].map(([name, items]) => (
                <CommandPrimitive.Group key={name} heading={name} className={groupCls}>
                  {items.map((item) => (
                    <Item
                      key={item.id}
                      value={item.id}
                      icon={SECTION_ICON[item.section]}
                      title={item.title}
                      subtitle={item.subtitle}
                      onSelect={() => goResult(item)}
                      right={
                        <span className="flex shrink-0 items-center gap-2">
                          {item.badge && (
                            <span className={cn("rounded-full px-2 py-0.5 text-2xs font-medium tabular-nums", BADGE_TONE[item.badgeTone ?? "neutral"])}>{item.badge}</span>
                          )}
                          {item.meta && <span className="hidden text-2xs tabular-nums text-muted-foreground sm:inline">{item.meta}</span>}
                        </span>
                      }
                    />
                  ))}
                </CommandPrimitive.Group>
              ))}

              {pages.length > 0 && (
                <CommandPrimitive.Group heading={ts("palette.goTo")} className={groupCls}>
                  {pages.map((p) => (
                    <Item
                      key={p.href}
                      value={`page-${p.href}`}
                      icon={p.icon}
                      title={p.name}
                      subtitle={pagePath(p)}
                      onSelect={() => goPage(p)}
                      right={goKeyHint(p)}
                    />
                  ))}
                </CommandPrimitive.Group>
              )}

              {!q && navGroups.map((g) => (
                <CommandPrimitive.Group key={g.id} heading={g.label} className={groupCls}>
                  {g.rows.map((row) => (
                    <Item
                      key={row.href}
                      value={`page-${row.href}`}
                      icon={row.hubIcon ?? row.icon}
                      title={rowLabel(row)}
                      subtitle={rowChildren(row).map((c) => c.name).join(" · ") || undefined}
                      onSelect={() => goPage(row)}
                      right={goKeyHint(row)}
                    />
                  ))}
                </CommandPrimitive.Group>
              ))}
            </CommandPrimitive.List>

            <div aria-hidden="true" className="hidden items-center gap-4 border-t border-[var(--glass-border)] px-4 py-2 text-2xs text-muted-foreground sm:flex">
              <span className="inline-flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> {ts("palette.footerSelect")}</span>
              <span className="inline-flex items-center gap-1"><Kbd>↵</Kbd> {ts("palette.footerOpen")}</span>
              <span className="inline-flex items-center gap-1"><Kbd>$</Kbd> {ts("palette.footerTicker")}</span>
              <span className="ml-auto inline-flex items-center gap-1"><Kbd>G</Kbd> {ts("palette.footerGo")}</span>
            </div>
          </CommandPrimitive>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
