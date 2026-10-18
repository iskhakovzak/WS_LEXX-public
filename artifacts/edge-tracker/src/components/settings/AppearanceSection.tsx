import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { Check, CloudMoon, Moon, Palette, Sun } from "lucide-react";
import { Panel } from "@/components/ds";
import { Kbd } from "@/components/ui/kbd";
import { useTheme, type Theme } from "@/contexts/theme-context";
import { cn } from "@/lib/utils";
import { Callout } from "./shared";
import { visibleSections } from "./SettingsNav";
import { useAuth } from "@/contexts/auth-context";
import { settingsI18n } from "@/i18n/ns/settings";
import { commonI18n } from "@/i18n/ns/common";

const THEMES: { id: Theme; icon: React.ElementType; selectors: string[] }[] = [
  { id: "dark", icon: Moon, selectors: [":root", ".dark"] },
  { id: "dim", icon: CloudMoon, selectors: [":root", ".dark", ".dim"] },
  { id: "light", icon: Sun, selectors: [":root"] },
];

/**
 * Collects the CSS custom properties (design tokens) declared for the given selectors, in order,
 * straight from the app stylesheet. Used to render each theme's preview with its real tokens,
 * independent of the theme currently applied to <html>.
 */
function readThemeTokens(selectors: string[]): React.CSSProperties {
  const out: Record<string, string> = {};
  for (const sel of selectors) {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { continue; } // cross-origin sheet
      const walk = (list: CSSRuleList) => {
        for (const rule of Array.from(list)) {
          if (rule instanceof CSSStyleRule) {
            const parts = rule.selectorText.split(",").map((s) => s.trim());
            if (!parts.includes(sel)) continue;
            for (let i = 0; i < rule.style.length; i++) {
              const prop = rule.style[i];
              if (prop.startsWith("--")) out[prop] = rule.style.getPropertyValue(prop).trim();
            }
          } else if ("cssRules" in rule && !(rule instanceof CSSMediaRule)) {
            // @layer / @supports blocks
            try { walk((rule as CSSGroupingRule).cssRules); } catch { /* ignore */ }
          }
        }
      };
      walk(rules);
    }
  }
  return out as React.CSSProperties;
}

/** Miniature app screen rendered with a theme's own tokens. */
function ThemePreview({ tokens }: { tokens: React.CSSProperties }) {
  return (
    <div
      aria-hidden="true"
      style={{ ...tokens, colorScheme: "normal" }}
      className="pointer-events-none relative h-36 overflow-hidden rounded-xl bg-background p-2.5 text-foreground"
    >
      <div className="flex h-full gap-2">
        {/* sidebar */}
        <div className="flex w-8 flex-col items-center gap-1.5 rounded-lg bg-card py-2">
          <span className="h-3.5 w-3.5 rounded-md bg-primary" />
          <span className="h-1.5 w-4 rounded-full bg-muted" />
          <span className="h-1.5 w-4 rounded-full bg-muted" />
          <span className="h-1.5 w-4 rounded-full bg-muted" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {/* header */}
          <div className="flex items-center justify-between rounded-lg bg-card px-2 py-1.5">
            <span className="h-1.5 w-12 rounded-full bg-foreground/70" />
            <span className="h-3 w-8 rounded-full bg-primary" />
          </div>
          {/* KPI tiles */}
          <div className="grid grid-cols-3 gap-1.5">
            <div className="rounded-lg border border-border bg-card p-1.5">
              <span className="block h-1 w-6 rounded-full bg-muted-foreground/60" />
              <span className="mt-1 block text-2xs font-semibold leading-none text-up">+2.4R</span>
            </div>
            <div className="rounded-lg border border-border bg-card p-1.5">
              <span className="block h-1 w-6 rounded-full bg-muted-foreground/60" />
              <span className="mt-1 block text-2xs font-semibold leading-none text-down">−0.8R</span>
            </div>
            <div className="rounded-lg border border-border bg-card p-1.5">
              <span className="block h-1 w-6 rounded-full bg-muted-foreground/60" />
              <span className="mt-1 block text-2xs font-semibold leading-none">62%</span>
            </div>
          </div>
          {/* chart */}
          <div className="relative flex-1 rounded-lg border border-border bg-card">
            <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="absolute inset-1 h-[calc(100%-8px)] w-[calc(100%-8px)]">
              <polyline points="0,24 12,20 24,22 36,14 48,16 60,9 72,12 84,6 100,4" fill="none" stroke="hsl(var(--chart-1))" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AppearanceSection() {
  const { t: ts } = settingsI18n.useT();
  const { t: tc } = commonI18n.useT();
  const { theme, cycleTheme } = useTheme();
  const { can } = useAuth();
  const sectionCount = Math.min(9, visibleSections(can).length);
  // ThemeContext only exposes cycleTheme; step through the cycle until the chosen theme is applied.
  const [target, setTarget] = useState<Theme | null>(null);
  useEffect(() => {
    if (!target) return;
    if (theme === target) { setTarget(null); return; }
    cycleTheme();
  }, [target, theme, cycleTheme]);

  const tokens = useMemo(() => Object.fromEntries(THEMES.map((t) => [t.id, readThemeTokens(t.selectors)])) as Record<Theme, React.CSSProperties>, []);

  function onKey(e: React.KeyboardEvent, idx: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const next = THEMES[(idx + dir + THEMES.length) % THEMES.length];
    setTarget(next.id);
    (e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]")[THEMES.indexOf(next)])?.focus();
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel title={ts("appearance.title")} description={ts("appearance.description")} icon={Palette}>
        <div role="radiogroup" aria-label={ts("appearance.title")} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {THEMES.map((t, idx) => {
            const active = (target ?? theme) === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                onClick={() => setTarget(t.id)}
                onKeyDown={(e) => onKey(e, idx)}
                className={cn(
                  "lift flex flex-col gap-3 rounded-2xl border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "border-primary bg-primary/10" : "border-border hover:bg-[var(--glass-hover-bg)]",
                )}
              >
                <ThemePreview tokens={tokens[t.id]} />
                <div className="flex items-start justify-between gap-2 px-1 pb-1">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                      <t.icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> {tc(`theme.${t.id}`)}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{ts(`appearance.${t.id}Hint`)}</p>
                  </div>
                  <span className={cn("grid h-5 w-5 shrink-0 place-items-center rounded-full border", active ? "border-transparent bg-primary-solid text-primary-foreground" : "border-border")}>
                    {active && <Check className="h-3 w-3" aria-hidden="true" />}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel title={ts("appearance.hotkeys")} description={ts("appearance.hotkeysDesc")}>
        <ul className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <li className="flex items-center justify-between gap-3 rounded-xl bg-[var(--glass-bg)] px-3 py-2"><span className="text-muted-foreground">{ts("appearance.keySearch")}</span><Kbd>/</Kbd></li>
          <li className="flex items-center justify-between gap-3 rounded-xl bg-[var(--glass-bg)] px-3 py-2"><span className="text-muted-foreground">{ts("appearance.keySection")}</span><span className="flex gap-1"><Kbd>1</Kbd>–<Kbd>{sectionCount}</Kbd></span></li>
          <li className="flex items-center justify-between gap-3 rounded-xl bg-[var(--glass-bg)] px-3 py-2"><span className="text-muted-foreground">{ts("appearance.keyNav")}</span><span className="flex gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd></span></li>
          <li className="flex items-center justify-between gap-3 rounded-xl bg-[var(--glass-bg)] px-3 py-2"><span className="text-muted-foreground">{ts("appearance.keyClose")}</span><Kbd>Esc</Kbd></li>
        </ul>
        <Callout className="mt-3">{ts("appearance.reducedMotion")}</Callout>
      </Panel>
    </div>
  );
}
