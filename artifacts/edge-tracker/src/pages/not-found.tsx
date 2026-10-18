import { useMemo } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeft, LayoutDashboard, ListChecks, BookOpen, Lightbulb, Eye, Compass, Target, CalendarDays, FlaskConical, NotebookPen, ShieldAlert, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { shellI18n, type NavKey } from "@/i18n/ns/shell";
import { commonI18n } from "@/i18n/ns/common";

type Dest = { href: string; nav: NavKey | "research"; icon: LucideIcon; keys: string[]; chip?: boolean };

// Main sections + loose keywords so a mistyped / outdated URL can suggest the right place.
const DESTS: Dest[] = [
  { href: "/", nav: "dashboard", icon: LayoutDashboard, keys: ["dashboard", "home", "main", "today", "dash"] },
  { href: "/game-plan", nav: "gamePlan", icon: Target, keys: ["game-plan", "gameplan", "plan", "premarket"], chip: true },
  { href: "/trades", nav: "trades", icon: ListChecks, keys: ["trades", "trade", "deal", "sdelki", "positions"], chip: true },
  { href: "/playbook", nav: "playbook", icon: BookOpen, keys: ["playbook", "setup", "setups", "play"], chip: true },
  { href: "/trade-ideas", nav: "ideas", icon: Lightbulb, keys: ["trade-ideas", "ideas", "idea"], chip: true },
  { href: "/watchlist", nav: "watchlist", icon: Eye, keys: ["watchlist", "watch", "list"], chip: true },
  { href: "/events", nav: "events", icon: CalendarDays, keys: ["events", "event", "calendar", "earnings"] },
  { href: "/research", nav: "research", icon: FlaskConical, keys: ["research", "study"] },
  { href: "/journal", nav: "journal", icon: NotebookPen, keys: ["journal", "diary", "notes"] },
  { href: "/risk", nav: "risk", icon: ShieldAlert, keys: ["risk", "limits"] },
];

function score(path: string, d: Dest) {
  const p = path.toLowerCase().replace(/[^a-z0-9/-]/g, "");
  const seg = p.split("/").filter(Boolean)[0] ?? "";
  if (!seg) return 0;
  let best = 0;
  for (const k of d.keys) {
    if (seg === k) best = Math.max(best, 3);
    else if (seg.startsWith(k) || k.startsWith(seg)) best = Math.max(best, 2);
    else if (seg.includes(k) || k.includes(seg)) best = Math.max(best, 1);
  }
  return best;
}

export default function NotFound() {
  const [location] = useLocation();
  const { t } = shellI18n.useT();
  const { t: tc } = commonI18n.useT();
  const label = (d: Dest) => (d.nav === "research" ? t("titles.research") : t(`nav.${d.nav}`));
  const canGoBack = typeof window !== "undefined" && window.history.length > 1;

  const suggestion = useMemo(() => {
    const ranked = DESTS.map((d) => ({ d, s: score(location, d) })).filter((x) => x.s > 0 && x.d.href !== "/").sort((a, b) => b.s - a.s);
    return ranked[0]?.d ?? null;
  }, [location]);

  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center px-1 py-8">
      <div className="glass-panel w-full max-w-md rounded-3xl p-6 text-center sm:p-8">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary/15 text-primary">
          <Compass className="h-6 w-6" aria-hidden="true" />
        </span>
        <p className="mt-4 text-5xl font-semibold tabular-nums tracking-tight text-foreground">404</p>
        <h1 className="mt-1 text-lg font-semibold text-foreground">{t("titles.notFound")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("notFound.lead")}
        </p>
        <p className="mx-auto mt-3 max-w-full truncate rounded-full bg-[var(--glass-bg)] px-3 py-1 text-xs text-muted-foreground" title={location}>
          {location}
        </p>

        {suggestion && (
          <Link
            href={suggestion.href}
            className="lift mt-5 flex items-center gap-3 rounded-2xl border border-primary/30 bg-primary/10 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary">
              <suggestion.icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-xs text-muted-foreground">{t("notFound.maybe")}</span>
              <span className="block text-sm font-semibold text-foreground">{label(suggestion)}</span>
            </span>
          </Link>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {canGoBack && (
            <Button type="button" variant="outline" onClick={() => window.history.back()}>
              <ArrowLeft aria-hidden="true" />
              {tc("actions.back")}
            </Button>
          )}
          <Button asChild variant={suggestion ? "outline" : "default"}>
            <Link href="/">
              <LayoutDashboard aria-hidden="true" />
              {t("notFound.toDashboard")}
            </Link>
          </Button>
        </div>

        <nav aria-label={t("notFound.sections")} className="mt-6 border-t border-[var(--glass-border)] pt-4">
          <ul className="flex flex-wrap justify-center gap-1.5">
            {DESTS.filter((d) => d.chip).map((d) => (
              <li key={d.href}>
                <Link
                  href={d.href}
                  className="chip inline-flex min-h-8 items-center gap-1.5 px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <d.icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {label(d)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  );
}
