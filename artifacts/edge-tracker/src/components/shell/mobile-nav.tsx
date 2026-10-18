/** Phone navigation: a floating bottom tab bar (4 key sections + «More») and a bottom sheet with every section. */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { MoreHorizontal, Search, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { openCommandPalette } from "@/components/global-search";
import { ALL_NAV_ITEMS, MOBILE_TABS, isNavActive, type NavItem } from "./nav";
import { useVisibleNav } from "./sidebar-nav";
import { usePinnedNav } from "./use-nav-prefs";
import { useShellBadges } from "./use-shell-badges";
import { preloadRoute } from "./route-loaders";
import { useAuth } from "@/contexts/auth-context";
import { shellI18n } from "@/i18n/ns/shell";

function Tile({ item, active, alert }: { item: NavItem; active: boolean; alert?: boolean }) {
  const { t } = shellI18n.useT();
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      onPointerDown={() => preloadRoute(item.href)}
      className={cn(
        "relative flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-2xl px-1 py-2 text-center text-xs font-medium transition-colors",
        active ? "bg-primary-solid text-primary-foreground" : "glass-panel text-foreground active:bg-[var(--glass-hover-bg)]",
      )}
    >
      <Icon className={cn("h-5 w-5", active ? "text-primary-foreground" : "text-primary")} aria-hidden="true" />
      <span className="line-clamp-2 leading-tight">{item.name}</span>
      {alert && <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-down" aria-label={t("mobile.needsAttention")} />}
    </Link>
  );
}

export function MobileNav({ location }: { location: string }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const { t } = shellI18n.useT();
  const groups = useVisibleNav();
  const { pins } = usePinnedNav();
  const { isCurator } = useAuth();
  const badges = useShellBadges();
  const tabs = MOBILE_TABS.map((h) => ALL_NAV_ITEMS.find((i) => i.href === h)).filter((i): i is NavItem => !!i);
  const inTabs = tabs.some((t) => isNavActive(t, location));
  // Same rule as the sidebar: a staff-only section pinned while signed in as curator never shows for a trader.
  const pinnedItems = pins.map((h) => ALL_NAV_ITEMS.find((i) => i.href === h)).filter((i): i is NavItem => !!i && !i.hidden && (!i.staff || isCurator));
  const anyAlert = Object.entries(badges).some(([href, b]) => b && !MOBILE_TABS.includes(href));

  useEffect(() => { setMoreOpen(false); }, [location]);

  return (
    <>
      <nav
        aria-label={t("mobile.navLabel")}
        className="glass-thick pb-safe fixed inset-x-2 bottom-2 z-nav rounded-[22px] px-1.5 pt-1.5 md:hidden"
      >
        <ul className="grid grid-cols-5">
          {tabs.map((t) => {
            const active = isNavActive(t, location);
            const Icon = t.icon;
            return (
              <li key={t.href}>
                <Link
                  href={t.href}
                  aria-current={active ? "page" : undefined}
                  onPointerDown={() => preloadRoute(t.href)}
                  className={cn(
                    "relative mx-auto flex h-12 flex-col items-center justify-center gap-0.5 rounded-2xl text-2xs font-medium transition-colors",
                    active ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  <span className={cn("grid h-7 w-12 place-items-center rounded-full transition-colors", active && "bg-primary/15")}>
                    <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
                  </span>
                  {t.short ?? t.name}
                  {badges[t.href] && <span className="absolute right-3 top-1 h-2 w-2 rounded-full bg-down" aria-label={badges[t.href]!.label} />}
                </Link>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              className={cn(
                "relative mx-auto flex h-12 w-full flex-col items-center justify-center gap-0.5 rounded-2xl text-2xs font-medium",
                !inTabs ? "text-primary" : "text-muted-foreground",
              )}
            >
              <span className={cn("grid h-7 w-12 place-items-center rounded-full", !inTabs && "bg-primary/15")}>
                <MoreHorizontal className="h-[18px] w-[18px]" aria-hidden="true" />
              </span>
              {t("mobile.more")}
              {anyAlert && <span className="absolute right-3 top-1 h-2 w-2 rounded-full bg-down" aria-label={t("mobile.hasWarnings")} />}
            </button>
          </li>
        </ul>
      </nav>

      <Drawer open={moreOpen} onOpenChange={setMoreOpen} shouldScaleBackground={false}>
        <DrawerContent aria-describedby="more-desc">
          <DrawerTitle className="sr-only">{t("mobile.allSections")}</DrawerTitle>
          <DrawerDescription id="more-desc" className="sr-only">{t("mobile.allSectionsDesc")}</DrawerDescription>
          <div className="overflow-y-auto overscroll-contain px-4 pb-4 pt-3">
            <button
              type="button"
              onClick={() => { setMoreOpen(false); openCommandPalette(); }}
              className="glass-field mb-4 flex h-11 w-full items-center gap-2 px-4 text-sm text-muted-foreground"
            >
              <Search className="h-4 w-4" aria-hidden="true" />
              {t("mobile.searchPlaceholder")}
            </button>
            {pinnedItems.length > 0 && (
              <section className="mb-4">
                <h3 className="micro-label mb-2 flex items-center gap-1.5"><Star className="h-3 w-3" aria-hidden="true" /> {t("sidebar.favorites")}</h3>
                <div className="grid grid-cols-3 gap-2">
                  {pinnedItems.map((i) => <Tile key={`p-${i.href}`} item={i} active={isNavActive(i, location)} alert={!!badges[i.href]} />)}
                </div>
              </section>
            )}
            {groups.map((g) => (
              <section key={g.id} className="mb-4 last:mb-0">
                <h3 className="micro-label mb-2">{g.label}</h3>
                <div className="grid grid-cols-3 gap-2">
                  {g.items.map((i) => <Tile key={i.href} item={i} active={isNavActive(i, location)} alert={!!badges[i.href]} />)}
                </div>
              </section>
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
