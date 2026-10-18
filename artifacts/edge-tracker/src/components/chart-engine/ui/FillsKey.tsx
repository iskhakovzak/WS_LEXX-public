import * as React from "react";
import { cn } from "@/lib/utils";
import type { Fill, TradeRole, TradeStructureDto } from "../types";
import { readChartTheme } from "../theme";
import { drawRoleGlyph } from "../primitives/FillsPrimitive";
import { ROLE_LABEL, ROLE_ORDER, structureSummary } from "../lib/structure";
import { chartI18n } from "@/i18n/ns/chart";
import type { StructureLayer } from "../hooks/useStructureLayer";

/** One marker glyph, drawn with the chart's own painter so the key matches the chart exactly. */
function Glyph({ role, inferred }: { role: TradeRole; inferred: boolean }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = 16 * dpr; c.height = 16 * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, 16, 16);
    // A "buy" glyph hangs below the price line: anchor it near the top so it sits centred in the box.
    drawRoleGlyph(ctx, readChartTheme(), role, 8, role === "stop" ? 2 : role === "add" ? 0 : 1, 9, true, inferred);
  });
  return <canvas ref={ref} aria-hidden className="h-4 w-4 shrink-0" />;
}

/**
 * Key of the marker shapes present on this chart («▲ Вход · △ Фикс · ■ Стоп?») plus the trade's structure summary
 * («вход частями · перезаход №1»), with on/off switches for the average-price line and the session's other trades.
 * Hidden when the trade is a plain entry → exit with nothing to explain.
 */
export function FillsKey({ fills, structure, layer, className }: { fills: readonly Fill[]; structure: TradeStructureDto | null; layer: StructureLayer; className?: string }) {
  const roles = React.useMemo(() => {
    const seen = new Map<TradeRole, boolean>();
    for (const f of fills) seen.set(f.role, (seen.get(f.role) ?? false) || f.inferred);
    return ROLE_ORDER.filter((r) => seen.has(r)).map((r) => ({ role: r, inferred: seen.get(r) ?? false }));
  }, [fills]);
  const { t } = chartI18n.useT();
  // Built on the client from the stats (the server's `summary` is Russian only).
  const summary = structure ? structureSummary(structure.stats) : "";
  const { toggles, available, setToggle } = layer;
  const chain = available.chain && toggles.chain;
  const plain = roles.every((r) => r.role === "entry" || r.role === "exit") && !summary && !available.chain && !available.steps;
  if (!roles.length || plain) return null;
  return (
    <div
      className={cn(
        "pointer-events-none absolute left-2 top-11 z-raised flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl border border-[var(--glass-border)] bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-[var(--glass-shadow-sm)]",
        className,
      )}
      title={structure?.stats.notes?.join("\n") || undefined}
    >
      {roles.map(({ role, inferred }) => (
        <span key={role} className="inline-flex items-center gap-1">
          <Glyph role={role} inferred={inferred} />
          {ROLE_LABEL[role]}{inferred ? "?" : ""}
        </span>
      ))}
      {chain && <span className="inline-flex items-center gap-1"><span className="inline-block w-4 border-t border-dashed border-[hsl(var(--chart-2))]" />{t("fillsKey.chain")}</span>}
      {summary && <span className="font-medium text-foreground">{summary}</span>}
      {available.steps && <Switch on={toggles.steps} onChange={(v) => setToggle("steps", v)} title={t("fillsKey.stepsTitle")}>{t("fillsKey.steps")}</Switch>}
      {available.chain && <Switch on={toggles.chain} onChange={(v) => setToggle("chain", v)} title={t("fillsKey.chainTitle")}>{t("fillsKey.chainToggle")}</Switch>}
    </div>
  );
}

function Switch({ on, onChange, title, children }: { on: boolean; onChange: (on: boolean) => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={() => onChange(!on)}
      className={cn(
        "pointer-events-auto rounded-full border px-1.5 py-px text-[10px] transition-colors",
        on ? "border-primary/50 bg-primary/15 text-foreground" : "border-border/70 text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
