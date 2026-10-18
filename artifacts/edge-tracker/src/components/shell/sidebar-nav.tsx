/**
 * Desktop sidebar: ~15 rows grouped by the trader's day, second-level pages under their row (shown while you are in
 * that set, on the chevron, or when pinned), attention badges only where someone should act, a «Сегодня» footer
 * (own P&L and daily stop) and an icon rail (Ctrl/⌘ B). Press G to see every quick-jump letter.
 */
import React from "react";
import { Link } from "wouter";
import { ChevronRight, PanelLeftClose, PanelLeftOpen, Pin } from "lucide-react";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/ds";
import { Reveal } from "@/components/ds/motion";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSidebar } from "@/components/ui/sidebar";
import { useAuth } from "@/contexts/auth-context";
import { fmtUsd, fmtRate } from "@/lib/format";
import { GO_MODE_EVENT, NAV_GROUPS, isNavActive, isWithin, rowChildren, rowLabel, type NavGroup, type NavItem } from "./nav";
import { usePinnedNav } from "./use-nav-prefs";
import { useRiskToday, useShellBadges, type NavBadge, type RiskToday } from "./use-shell-badges";
import { preloadRoute } from "./route-loaders";
import { shellI18n } from "@/i18n/ns/shell";
import { commonI18n } from "@/i18n/ns/common";


const BADGE_CLS: Record<NavBadge["tone"], string> = {
  down: "bg-down/12 text-down",
  warn: "bg-warn/12 text-warn",
  up: "bg-up/12 text-up",
};
const DOT_CLS: Record<NavBadge["tone"], string> = {
  down: "bg-down",
  warn: "bg-warn",
  up: "bg-up",
};

const MOD_KEY = /Mac|iPhone|iPad/.test(typeof navigator !== "undefined" ? navigator.platform : "") ? "⌘" : "Ctrl";

export type VisibleGroup = Omit<NavGroup, "items"> & {
  /** Sidebar rows with only the children this viewer may open. */
  rows: NavItem[];
  /** Every visible page of the group, flat (rows and their children) — the phone «More» sheet. */
  items: NavItem[];
};

/** Visible nav for the current role (staff-only pages filtered, hidden ones dropped). */
export function useVisibleNav(): VisibleGroup[] {
  const { isCurator } = useAuth();
  return React.useMemo(() => visibleNav(isCurator), [isCurator]);
}

function visibleNav(isCurator: boolean): VisibleGroup[] {
  const ok = (i: NavItem) => !i.hidden && (!i.staff || isCurator);
  return NAV_GROUPS.map((g) => {
    const rows = g.items.filter(ok).map((r) => {
      if (!r.children) return r;
      const copy = withGetters(r);
      copy.children = r.children.filter(ok);
      return copy;
    });
    return { id: g.id, get label() { return g.label; }, rows, items: rows.flatMap((r) => [r, ...(r.children ?? [])]) };
  }).filter((g) => g.rows.length);
}

/** Copy of an item that keeps its label getters (spreading would freeze them in one language). */
function withGetters(i: NavItem): NavItem {
  return Object.create(Object.getPrototypeOf(i), Object.getOwnPropertyDescriptors(i));
}

/** Badge chip / dot. `onSolid` = drawn on the active (solid) pill. */
function BadgeMark({ badge, onSolid, className }: { badge: NavBadge; onSolid?: boolean; className?: string }) {
  if (badge.count) {
    return (
      <span
        role="img"
        aria-label={badge.label}
        title={badge.label}
        className={cn("grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-2xs font-semibold tabular-nums", onSolid ? "bg-primary-foreground/20 text-primary-foreground" : BADGE_CLS[badge.tone], className)}
      >
        {badge.count > 99 ? "99+" : badge.count}
      </span>
    );
  }
  return <span role="img" aria-label={badge.label} title={badge.label} className={cn("h-2 w-2 shrink-0 rounded-full", DOT_CLS[badge.tone], className)} />;
}

/**
 * «G X» chip while go mode is on (G pressed): drawn over the right end of the row, so it never takes room from the
 * label or the badge. On hover the row's title says the same («Аналитика: G, затем A»).
 */
function GoHint({ k, go, className }: { k?: string; go: boolean; className: string }) {
  if (!k) return null;
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute top-1/2 grid h-5 min-w-5 -translate-y-1/2 place-items-center rounded-full bg-primary-solid px-1.5 font-sans text-2xs font-semibold leading-none text-primary-foreground shadow-[0_0_0_2px_hsl(var(--background))] transition-opacity duration-[var(--dur-1)] motion-reduce:transition-none",
        go ? "opacity-100" : "opacity-0",
        className,
      )}
    >
      {k.toUpperCase()}
    </kbd>
  );
}

const rowBase =
  "relative flex items-center gap-3 rounded-full text-[13px] outline-none transition-[background-color,color] duration-[var(--dur-1)] focus-visible:ring-2 focus-visible:ring-ring";
const rowIdle = "text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground";
const rowActive =
  "bg-primary-solid font-medium text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_6px_16px_-8px_hsl(var(--primary)/0.7)]";
/** The row whose child page is open: named, not filled (one solid pill per sidebar). */
const rowWithin = "font-medium text-foreground hover:bg-[var(--glass-hover-bg)]";

type RowCtx = {
  location: string;
  badges: Record<string, NavBadge | undefined>;
  go: boolean;
  pins: ReturnType<typeof usePinnedNav>;
  /** Rows opened with the chevron (not persisted). */
  opened: Set<string>;
  toggleOpened: (href: string) => void;
};

function ChildLink({ item, ctx }: { item: NavItem; ctx: RowCtx }) {
  const { t } = shellI18n.useT();
  const active = isNavActive(item, ctx.location);
  const pinned = ctx.pins.isPinned(item.href);
  const blocked = !pinned && !ctx.pins.canPin;
  const badge = ctx.badges[item.href];
  return (
    <li className="group/row relative">
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        onPointerEnter={() => preloadRoute(item.href)}
        onFocus={() => preloadRoute(item.href)}
        title={item.goKey ? t("sidebar.goKeyTitle", { name: item.name, key: item.goKey.toUpperCase() }) : item.name}
        className={cn(rowBase, "ml-[26px] h-7 gap-2 pl-3 pr-8", active ? rowActive : rowIdle)}
      >
        <span className="min-w-0 flex-1 truncate">{item.name}</span>
        {badge && <BadgeMark badge={badge} onSolid={active} />}
        <GoHint k={item.goKey} go={ctx.go} className="right-2" />
      </Link>
      <button
        type="button"
        onClick={() => ctx.pins.togglePin(item.href)}
        disabled={blocked}
        aria-label={pinned ? t("sidebar.unpinAria", { name: item.name }) : t("sidebar.pinAria", { name: item.name })}
        aria-pressed={pinned}
        title={pinned ? t("sidebar.unpinTitle") : blocked ? t("sidebar.pinFullTitle") : t("sidebar.pinTitle")}
        className={cn(
          "absolute right-0.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full outline-none transition-opacity duration-[var(--dur-1)] focus-visible:ring-2 focus-visible:ring-ring",
          pinned ? "opacity-70" : "opacity-0",
          "focus-visible:opacity-100 group-hover/row:opacity-100 disabled:cursor-not-allowed disabled:group-hover/row:opacity-40",
          active ? "text-primary-foreground hover:bg-primary-foreground/15" : pinned ? "text-primary hover:bg-[var(--glass-hover-bg)]" : "text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground",
        )}
      >
        <Pin className={cn("h-3.5 w-3.5", pinned && "fill-current")} aria-hidden="true" />
      </button>
    </li>
  );
}

function Row({ row, ctx }: { row: NavItem; ctx: RowCtx }) {
  const { t } = shellI18n.useT();
  const kids = rowChildren(row);
  const label = rowLabel(row);
  const Icon = row.hubIcon ?? row.icon;
  // A hub (named for its job) is "active" only through its children: its own page is listed among them.
  const self = !row.hubLabel && isNavActive(row, ctx.location);
  const within = isWithin(row, ctx.location);
  const open = kids.length > 0 && (within || ctx.opened.has(row.href));
  const pinnedKids = open ? [] : kids.filter((k) => ctx.pins.isPinned(k.href));
  // A closed row still tells you something inside needs you.
  const badge = ctx.badges[row.href] ?? (open ? undefined : kids.map((k) => ctx.badges[k.href]).find(Boolean));
  const listId = `nav-sub-${row.key}`;
  return (
    <li>
      <div className="group/row relative">
        <Link
          href={row.href}
          aria-current={self ? "page" : undefined}
          onPointerEnter={() => preloadRoute(row.href)}
          onFocus={() => preloadRoute(row.href)}
          className={cn(rowBase, "h-8 pl-3", kids.length ? "pr-9" : "pr-2.5", self ? rowActive : within ? rowWithin : rowIdle)}
        >
          <Icon className={cn("h-4 w-4 shrink-0", self ? "text-primary-foreground" : within ? "text-primary" : "text-muted-foreground group-hover/row:text-foreground")} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate" title={row.goKey ? t("sidebar.goKeyTitle", { name: label, key: row.goKey.toUpperCase() }) : label}>{label}</span>
          {badge && <BadgeMark badge={badge} onSolid={self} />}
          <GoHint k={row.goKey} go={ctx.go} className={kids.length ? "right-9" : "right-2"} />
        </Link>
        {kids.length > 0 && (
          <button
            type="button"
            onClick={() => ctx.toggleOpened(row.href)}
            disabled={within}
            aria-expanded={open}
            aria-controls={listId}
            aria-label={open ? t("sidebar.hideChildren", { name: label }) : t("sidebar.showChildren", { name: label })}
            title={open ? t("sidebar.hideChildren", { name: label }) : t("sidebar.showChildren", { name: label })}
            className={cn(
              "absolute right-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full outline-none transition-[background-color,color,opacity] duration-[var(--dur-1)] focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none",
              self ? "text-primary-foreground/80 hover:bg-primary-foreground/15" : "text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground",
              // Inside the set the list is always open: the chevron only shows the state.
              within ? "opacity-50" : "opacity-40 group-hover/row:opacity-100 focus-visible:opacity-100",
            )}
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform duration-[var(--dur-2)] ease-smooth motion-reduce:transition-none", open && "rotate-90")} aria-hidden="true" />
          </button>
        )}
      </div>
      {kids.length > 0 && (
        <>
          <Reveal open={open} id={listId}>
            <ul className="relative space-y-0.5 py-0.5 before:absolute before:inset-y-1 before:left-[19px] before:w-px before:bg-[var(--glass-border)]">
              {kids.map((k) => <ChildLink key={k.href} item={k} ctx={ctx} />)}
            </ul>
          </Reveal>
          {pinnedKids.length > 0 && (
            <ul className="relative space-y-0.5 pb-0.5 before:absolute before:inset-y-1 before:left-[19px] before:w-px before:bg-[var(--glass-border)]">
              {pinnedKids.map((k) => <ChildLink key={`pin-${k.href}`} item={k} ctx={ctx} />)}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

/** Icon-only row of the rail; the label, quick-jump keys and badge live in the tooltip. */
function RailLink({ item, ctx, label, icon, small, self, within }: {
  item: NavItem; ctx: RowCtx; label: string; icon: NavItem["icon"]; small?: boolean; self: boolean; within?: boolean;
}) {
  const Icon = icon;
  const badge = ctx.badges[item.href];
  return (
    <li className="flex justify-center">
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href={item.href}
            aria-current={self ? "page" : undefined}
            onPointerEnter={() => preloadRoute(item.href)}
            onFocus={() => preloadRoute(item.href)}
            className={cn(
              "relative grid place-items-center rounded-full outline-none transition-[background-color,color] duration-[var(--dur-1)] focus-visible:ring-2 focus-visible:ring-ring",
              small ? "h-7 w-7" : "h-9 w-9",
              self ? rowActive : within ? "bg-[var(--glass-hover-bg)] text-primary" : rowIdle,
            )}
          >
            <Icon className={small ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden="true" />
            <span className="sr-only">{label}</span>
            {badge && (
              <span aria-hidden="true" className={cn("absolute right-0.5 top-0.5 h-2 w-2 rounded-full ring-2 ring-background", DOT_CLS[badge.tone])} />
            )}
            {ctx.go && item.goKey && (
              <span aria-hidden="true" className="absolute -bottom-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-primary-solid px-1 text-[10px] font-semibold leading-none text-primary-foreground">
                {item.goKey.toUpperCase()}
              </span>
            )}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={10} className="flex items-center gap-2">
          <span className="font-medium">{label}</span>
          {item.goKey && <Kbd keys={["G", item.goKey.toUpperCase()]} />}
          {badge && <span className="text-muted-foreground">{badge.label}</span>}
        </TooltipContent>
      </Tooltip>
    </li>
  );
}

function RailRow({ row, ctx }: { row: NavItem; ctx: RowCtx }) {
  const kids = rowChildren(row);
  const self = !row.hubLabel && isNavActive(row, ctx.location);
  const within = isWithin(row, ctx.location);
  // In the rail a set opens only while you are in it (plus pinned pages), so its pages stay one click away.
  const shown = within ? kids : kids.filter((k) => ctx.pins.isPinned(k.href));
  return (
    <>
      <RailLink item={row} ctx={ctx} label={rowLabel(row)} icon={row.hubIcon ?? row.icon} self={self} within={within && !self} />
      {shown.map((k) => (
        <RailLink key={`sub-${k.href}`} item={k} ctx={ctx} label={k.name} icon={k.icon} small self={isNavActive(k, ctx.location)} />
      ))}
    </>
  );
}

/** Today's own numbers from the risk desk: net P&L, trades, how much of the daily stop is used. Links to /risk. */
function TodayCard({ risk, rail }: { risk: RiskToday; rail: boolean }) {
  const { t } = shellI18n.useT();
  const { t: tc } = commonI18n.useT();
  const tone: NavBadge["tone"] | "ok" = risk.halted || risk.status === "breach" ? "down" : risk.status === "warn" ? "warn" : "ok";
  const used = risk.dailyUsedPct == null ? null : Math.max(0, Math.min(100, risk.dailyUsedPct));
  const pnl = risk.trades > 0 || risk.pnlNet != null ? fmtUsd(risk.pnlNet ?? 0, { signed: true, decimals: "auto" }) : null;
  const pnlCls = (risk.pnlNet ?? 0) > 0 ? "text-up" : (risk.pnlNet ?? 0) < 0 ? "text-down" : "text-foreground";
  const barCls = tone === "down" ? "bg-down" : tone === "warn" ? "bg-warn" : "bg-primary";
  const limitLine = risk.halted
    ? t("today.halted")
    : risk.dailyRemainingUsd != null ? t("today.toStop", { amount: fmtUsd(risk.dailyRemainingUsd, { decimals: "trim" }) }) : null;
  const tradesLine = risk.trades > 0 ? tc("units.trades", { count: risk.trades }) : t("today.noTrades");

  if (rail) {
    // Ring = share of the daily stop used; the centre dot = sign of the day.
    const r = 15;
    const c = 2 * Math.PI * r;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link href="/risk" className="relative mx-auto grid h-9 w-9 place-items-center rounded-full outline-none transition-[background-color] duration-[var(--dur-1)] hover:bg-[var(--glass-hover-bg)] focus-visible:ring-2 focus-visible:ring-ring">
            <svg viewBox="0 0 36 36" className="h-8 w-8 -rotate-90" aria-hidden="true">
              <circle cx="18" cy="18" r={r} fill="none" strokeWidth="3" className="stroke-muted-foreground/25" />
              {used != null && used > 0 && (
                <circle cx="18" cy="18" r={r} fill="none" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${(used / 100) * c} ${c}`}
                  className={tone === "down" ? "stroke-down" : tone === "warn" ? "stroke-warn" : "stroke-primary"} />
              )}
            </svg>
            <span aria-hidden="true" className={cn("absolute h-2 w-2 rounded-full", (risk.pnlNet ?? 0) > 0 ? "bg-up" : (risk.pnlNet ?? 0) < 0 ? "bg-down" : "bg-muted-foreground/50")} />
            <span className="sr-only">{[t("today.title"), pnl ?? t("today.noTrades"), limitLine].filter(Boolean).join(". ")}</span>
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={10}>
          <div className="font-medium">{t("today.title")}{pnl && <span className={cn("ml-2 tabular-nums", pnlCls)}>{pnl}</span>}</div>
          <div className="text-muted-foreground">{tradesLine}{limitLine && <> · {limitLine}</>}</div>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Link
      href="/risk"
      title={t("today.open")}
      className="block rounded-xl px-2.5 py-1.5 outline-none transition-[background-color] duration-[var(--dur-1)] hover:bg-[var(--glass-hover-bg)] focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-foreground">{t("today.title")}</span>
        <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">{tradesLine}</span>
        {pnl && <span className={cn("text-xs font-semibold tabular-nums", pnlCls)}>{pnl}</span>}
      </span>
      {used != null && (
        <>
          <span
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(used)}
            aria-label={t("today.usedAria", { pct: fmtRate(used / 100) })}
            className="mt-1.5 block h-1 overflow-hidden rounded-full bg-[var(--glass-border)]"
          >
            <span className={cn("block h-full origin-left rounded-full transition-transform duration-[var(--dur-3)] ease-smooth", barCls)} style={{ transform: `scaleX(${used / 100})` }} />
          </span>
          {limitLine && <span className={cn("mt-1 block truncate text-2xs", tone === "down" ? "text-down" : tone === "warn" ? "text-warn" : "text-muted-foreground")}>{limitLine}</span>}
        </>
      )}
    </Link>
  );
}

// Trades arrive from the broker automatically, so the sidebar offers no manual entry.
export function SidebarNav({ location }: { location: string }) {
  const groups = useVisibleNav();
  const { t } = shellI18n.useT();
  const { user } = useAuth();
  const { state, isMobile, toggleSidebar } = useSidebar();
  const rail = state === "collapsed" && !isMobile;
  const pins = usePinnedNav(user?.role);
  const badges = useShellBadges();
  const { data: risk } = useRiskToday();
  // The footer shows the trader's own day; a curator without limits or trades today gets no empty card.
  const showToday = !!risk && (risk.hasLimits || risk.trades > 0);
  // The footer already carries the risk state: no second signal on the «Риск-деск» row.
  const rowBadges = React.useMemo(() => (showToday ? { ...badges, "/risk": undefined } : badges), [badges, showToday]);

  const [opened, setOpened] = React.useState<Set<string>>(() => new Set());
  const toggleOpened = React.useCallback((href: string) => {
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(href)) next.delete(href); else next.add(href);
      return next;
    });
  }, []);

  // Go mode: G pressed somewhere (palette key handler) → show every letter for a moment.
  const [go, setGo] = React.useState(false);
  React.useEffect(() => {
    let timer = 0;
    const on = (e: Event) => {
      window.clearTimeout(timer);
      const v = (e as CustomEvent<boolean>).detail !== false;
      setGo(v);
      if (v) timer = window.setTimeout(() => setGo(false), 1300);
    };
    window.addEventListener(GO_MODE_EVENT, on);
    return () => { window.removeEventListener(GO_MODE_EVENT, on); window.clearTimeout(timer); };
  }, []);
  React.useEffect(() => setGo(false), [location]);

  // Keep the current section visible in the (scrollable) list after navigation.
  const listRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const id = requestAnimationFrame(() => {
      const list = listRef.current;
      const el = list?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!list || !el) return;
      const l = list.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.top < l.top || r.bottom > l.bottom) el.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(id);
  }, [location, rail]);

  const ctx: RowCtx = { location, badges: rowBadges, go, pins, opened, toggleOpened };

  return (
    <nav aria-label={t("sidebar.navLabel")} className="flex min-h-0 flex-1 flex-col">
      <div ref={listRef} className={cn("scrollbar-none min-h-0 flex-1 overflow-y-auto pb-2", rail ? "px-1.5" : "px-2")}>
        {groups.map((g, gi) =>
          rail ? (
            <section key={g.id} aria-label={g.label} className={cn(gi === 0 ? "pt-1.5" : "mt-1.5 border-t border-[var(--glass-border)] pt-1.5")}>
              <ul className="space-y-0.5">
                {g.rows.map((row) => <RailRow key={row.href} row={row} ctx={ctx} />)}
              </ul>
            </section>
          ) : (
            <section key={g.id} aria-labelledby={`nav-group-${g.id}`} className="pt-2.5 first:pt-1.5">
              <h3 id={`nav-group-${g.id}`} className="micro-label px-3 pb-0.5">{g.label}</h3>
              <ul className="space-y-0.5">
                {g.rows.map((row) => <Row key={row.href} row={row} ctx={ctx} />)}
              </ul>
            </section>
          ),
        )}
      </div>
      <div className={cn("border-t border-[var(--glass-border)]", rail ? "space-y-1 px-1.5 py-2" : "px-2 pb-1.5 pt-1")}>
        {showToday && risk && <TodayCard risk={risk} rail={rail} />}
        <div className={cn("flex items-center text-2xs text-muted-foreground", rail ? "justify-center" : "justify-between gap-2 pl-2.5 pr-0.5")}>
          {!rail && (
            <span className="inline-flex min-w-0 items-center gap-1 truncate" title={t("sidebar.goHint")}>
              <Kbd>G</Kbd>{t("sidebar.goLetter")}
            </span>
          )}
          {!isMobile && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={toggleSidebar}
                  aria-label={rail ? t("sidebar.fromRail") : t("sidebar.toRail")}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full outline-none transition-[background-color,color] duration-[var(--dur-1)] hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {rail ? <PanelLeftOpen className="h-4 w-4" aria-hidden="true" /> : <PanelLeftClose className="h-4 w-4" aria-hidden="true" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side={rail ? "right" : "top"} className="flex items-center gap-2">
                {rail ? t("sidebar.fromRail") : t("sidebar.toRail")}
                <Kbd keys={[MOD_KEY, "B"]} />
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </nav>
  );
}
