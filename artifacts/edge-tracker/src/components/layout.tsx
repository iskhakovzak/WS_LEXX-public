/**
 * App shell: floating glass sidebar (desktop), floating glass header (logo, command search, NY market
 * clock, language, theme, notifications, user menu), bottom tab bar + «More» sheet (phones), and subtle,
 * reduced-motion-aware route transitions.
 */
import React, { useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { motion, useReducedMotion } from "framer-motion";
import { MOTION } from "@/components/ds/motion";
import { Sidebar, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { GlobalSearch } from "@/components/global-search";
import { useAuth } from "@/contexts/auth-context";
import { MarketClock } from "@/components/shell/market-clock";
import { LanguageMenu, NotificationBell, ThemeToggle, UserMenu } from "@/components/shell/header-actions";
import { shellI18n } from "@/i18n/ns/shell";
import { SidebarNav } from "@/components/shell/sidebar-nav";
import { MobileNav } from "@/components/shell/mobile-nav";
import { readSidebarOpen, writeSidebarOpen } from "@/components/shell/use-nav-prefs";

/**
 * Full sidebar 15rem; icon rail 3.5rem + 1rem gutter. ui/sidebar.tsx sizes the rail with `var(--spacing-4)`, which
 * Tailwind v4 does not define (only `--spacing`), so it is set here for the sidebar subtree.
 */
const SIDEBAR_SIZES = { "--sidebar-width": "15rem", "--sidebar-width-icon": "3.5rem", "--spacing-4": "1rem" } as React.CSSProperties;

/** On phones the sidebar is a Sheet; close it once a nav link has been followed. */
function CloseMobileSidebarOnNavigate({ location }: { location: string }) {
  const { isMobile, setOpenMobile } = useSidebar();
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [location, isMobile, setOpenMobile]);
  return null;
}

/**
 * Header boundary: mark the scroller once it leaves the top, so `.app-scroller[data-scrolled]::before` (index.css)
 * fades content out under the header instead of cutting it. Passive listener, attribute flips only on change.
 */
function useScrolledFlag(ref: React.RefObject<HTMLDivElement | null>, resetKey: string) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let on = false;
    const sync = () => {
      const next = el.scrollTop > 2;
      if (next === on) return;
      on = next;
      if (on) el.setAttribute("data-scrolled", "");
      else el.removeAttribute("data-scrolled");
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    return () => el.removeEventListener("scroll", sync);
  }, [ref, resetKey]);
}

/**
 * The scroller reserves a scrollbar gutter (`scrollbar-gutter: stable`), so page content is centred in a box a few px
 * narrower than the header above it (3px off at 1920, 6px at the right edge at 1440). Mirror the measured gutter as
 * `--scroller-gutter` on <main>; the header's wrapper pads by it, so both edges line up. No React state, no re-render.
 */
function useScrollerGutter(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    let last = -1;
    const sync = () => {
      const g = Math.max(0, el.offsetWidth - el.clientWidth);
      if (g === last) return;
      last = g;
      host.style.setProperty("--scroller-gutter", `${g}px`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
}

function Logo() {
  const { t } = shellI18n.useT();
  return (
    <Link href="/" aria-label={t("header.logoAria")} className="flex shrink-0 items-center gap-2.5 rounded-xl">
      <span
        aria-hidden="true"
        className="grid h-9 w-9 place-items-center rounded-[11px] bg-primary-solid text-xs font-bold tracking-tight text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_6px_16px_-8px_hsl(var(--primary)/0.8)]"
      >
        WS
      </span>
      <span className="hidden text-sm font-semibold tracking-tight text-foreground @[960px]:inline">WS_LEXX</span>
    </Link>
  );
}

function Header() {
  const { user } = useAuth();
  const { t } = shellI18n.useT();
  return (
    // Static bar above the scroller (content never slides under it, so no backdrop blur is needed). `app-header`
    // gives it a solid fallback fill; the scroller's top fade band draws the boundary below it.
    // Same max width + gutters as <Page>, so header edges line up with page content.
    // `@container`: the clock and the search size themselves by the header's width (sidebar open or not), not the viewport.
    <div className="@container mx-auto w-full max-w-[calc(var(--page-max)_+_2_*_var(--page-px))] shrink-0 px-2 pt-[calc(0.5rem+env(safe-area-inset-top))] md:px-[var(--page-px)] md:pt-[calc(0.75rem+env(safe-area-inset-top))]">
    <header className="app-header glass-thick glass-solid relative z-header grid h-[var(--header-h)] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 rounded-2xl px-2 md:px-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger aria-label={t("header.toggleMenu")} className="chip hidden h-10 w-10 shrink-0 hover:text-foreground md:inline-flex" />
        <Logo />
        <GlobalSearch />
      </div>
      <MarketClock fit="container" className="justify-self-center" />
      <div className="flex min-w-0 items-center justify-end gap-1.5 md:gap-2">
        <LanguageMenu className="hidden md:grid" />
        <ThemeToggle className="hidden md:grid" />
        {user?.traderName && <NotificationBell traderName={user.traderName} />}
        <UserMenu />
      </div>
    </header>
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const reduce = useReducedMotion();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const { t } = shellI18n.useT();
  // Animate on section change only (sub-paths and query strings keep the page mounted).
  const routeKey = "/" + (location.split("/")[1] ?? "");
  useScrolledFlag(scrollerRef, routeKey);
  useScrollerGutter(scrollerRef);
  // Full sidebar or icon rail (header button, the sidebar footer button, Ctrl/⌘ B); remembered per browser.
  const [sidebarOpen, setSidebarOpen] = React.useState(readSidebarOpen);
  const onSidebarOpen = React.useCallback((v: boolean) => { setSidebarOpen(v); writeSidebarOpen(v); }, []);

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={onSidebarOpen} style={SIDEBAR_SIZES}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-skip focus:rounded-full focus:bg-primary-solid focus:px-4 focus:py-2 focus:text-xs focus:font-medium focus:text-primary-foreground"
      >
        {t("header.skipToContent")}
      </a>
      <CloseMobileSidebarOnNavigate location={location} />
      {/* Fixed-height shell: #main-content is the only vertical scroller (route changes reset it to top,
          page-level `sticky-top` bars stick right under the header). The sidebar never auto-hides (the playbook
          included): only the user switches it between full width and the icon rail (header button / sidebar footer /
          Ctrl+B), so the layout does not jump. */}
      <div className="flex h-svh w-full overflow-hidden text-sm text-foreground">
        <Sidebar
          variant="floating"
          collapsible="icon"
          className="p-3 pr-0 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+var(--spacing-4))]"
        >
          <div className="flex h-full min-h-0 flex-col">
            <SidebarNav location={location} />
          </div>
        </Sidebar>
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="shrink-0 pr-[var(--scroller-gutter,0px)]">
            <Header />
          </div>
          <div
            id="main-content"
            ref={scrollerRef}
            tabIndex={-1}
            className="app-scroller min-h-0 flex-1 overflow-auto overscroll-contain px-3 pb-[calc(6.5rem+env(safe-area-inset-bottom))] outline-none [scrollbar-gutter:stable] md:px-[var(--page-px)] md:pb-[calc(3rem+env(safe-area-inset-bottom))]"
          >
            {/* Top padding lives here, not on the scroller: Chrome insets `position: sticky` by the scroller's
                padding, so with it on #main-content every `.sticky-top` bar stuck 20px lower than --sticky-top
                and content peeked out above it. */}
            <motion.div
              key={routeKey}
              className="pt-4 md:pt-5"
              initial={reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={MOTION.base}
            >
              {children}
            </motion.div>
          </div>
        </main>
      </div>
      <MobileNav location={location} />
    </SidebarProvider>
  );
}
