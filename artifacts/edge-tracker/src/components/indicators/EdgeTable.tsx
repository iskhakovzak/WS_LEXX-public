import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Star, StickyNote } from "lucide-react";
import { Panel, Pill, TableScroll, toneOf } from "@/components/ds";
import { cn } from "@/lib/utils";
import { CATEGORY_META, HORIZONS, HORIZON_META, type Horizon, type LibIndicator } from "./library";
import { FitMeter, Highlight } from "./IndicatorCard";
import { EMPTY_STATS, type IndicatorStats } from "./stats";
import { fmtR, fmtUsd } from "@/lib/format";
import { indicatorsI18n } from "@/i18n/ns/indicators";

type Col = "name" | "count" | "winRate" | "avgR" | "netPnl" | Horizon;

const toneCls = (n: number | null) => ({ up: "text-up", down: "text-down" } as Record<string, string>)[toneOf(n)] ?? "";

/**
 * Dense comparison of the filtered indicators by personal results: where is my edge?
 * Click a header to sort, a row to open the detail sheet.
 */
export function EdgeTable({
  items, stats, statsLoading, favorites, notes, query, onOpen,
}: {
  items: LibIndicator[];
  stats: Record<string, IndicatorStats>;
  statsLoading: boolean;
  favorites: Set<string>;
  notes: Record<string, string>;
  query: string;
  onOpen: (id: string) => void;
}) {
  const { t } = indicatorsI18n.useT();
  const [sort, setSort] = useState<{ col: Col; dir: 1 | -1 } | null>(null);

  const rows = useMemo(() => {
    if (!sort) return items;
    const st = (id: string) => stats[id] ?? EMPTY_STATS;
    const val = (i: LibIndicator): number | string => {
      switch (sort.col) {
        case "name": return i.shortName;
        case "count": return st(i.id).count;
        case "winRate": return st(i.id).count ? st(i.id).winRate : -1;
        case "avgR": return st(i.id).avgR ?? -Infinity;
        case "netPnl": return st(i.id).netPnl ?? -Infinity;
        default: return i.horizons[sort.col];
      }
    };
    return [...items].sort((a, b) => {
      const va = val(a), vb = val(b);
      const c = typeof va === "string" ? va.localeCompare(String(vb)) : va - (vb as number);
      return c * sort.dir;
    });
  }, [items, stats, sort]);

  const toggle = (col: Col) =>
    setSort((s) => (s?.col === col ? (s.dir === -1 ? { col, dir: 1 } : null) : { col, dir: col === "name" ? 1 : -1 }));

  const Th = ({ col, children, className }: { col: Col; children: ReactNode; className?: string }) => {
    const active = sort?.col === col;
    return (
      <th
        scope="col"
        aria-sort={active ? (sort!.dir === 1 ? "ascending" : "descending") : "none"}
        className={cn("sticky top-0 z-sticky bg-[var(--sticky-bg)] px-3 py-2 font-medium", className)}
      >
        <button
          type="button"
          onClick={() => toggle(col)}
          className={cn("inline-flex items-center gap-1 rounded-full hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active && "text-foreground")}
        >
          {children}
          {active && (sort!.dir === 1 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
        </button>
      </th>
    );
  };

  return (
    <Panel padded={false} className="overflow-hidden">
      <TableScroll className="mx-0 px-0">
        <table className="w-full min-w-[760px] text-sm tabular-nums">
          <caption className="sr-only">{t("table.caption")}</caption>
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b border-border/60">
              <Th col="name" className="text-left">{t("table.indicator")}</Th>
              {HORIZONS.map((h) => <Th key={h} col={h} className="text-center">{HORIZON_META[h].label}</Th>)}
              <Th col="count" className="text-right">{t("table.trades")}</Th>
              <Th col="winRate" className="text-right">WR</Th>
              <Th col="avgR" className="text-right">{t("table.avgR")}</Th>
              <Th col="netPnl" className="text-right">{t("table.netPnl")}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((ind) => {
              const s = stats[ind.id] ?? EMPTY_STATS;
              return (
                <tr
                  key={ind.id}
                  tabIndex={0}
                  onClick={() => onOpen(ind.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(ind.id); } }}
                  className="cursor-pointer border-b border-border/40 last:border-0 hover:bg-[var(--glass-hover-bg)] focus-visible:bg-[var(--glass-hover-bg)] focus-visible:outline-none"
                  aria-label={t("table.openRow", { short: ind.shortName })}
                >
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      {favorites.has(ind.id) && <Star className="h-3.5 w-3.5 shrink-0 fill-current text-[hsl(var(--chart-3))]" aria-label={t("table.inSet")} />}
                      <span className="font-semibold"><Highlight text={ind.shortName} q={query} /></span>
                      <span className="truncate text-xs text-muted-foreground">{ind.name}</span>
                      <Pill tone={CATEGORY_META[ind.category].tone} className="ml-auto">{CATEGORY_META[ind.category].label}</Pill>
                      {notes[ind.id] && <StickyNote className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t("card.hasNote")} />}
                    </div>
                  </td>
                  {HORIZONS.map((h) => (
                    <td key={h} className="px-3 py-2.5 text-center"><FitMeter value={ind.horizons[h]} active={ind.horizons[h] === 3} /></td>
                  ))}
                  {statsLoading ? (
                    <td colSpan={4} className="px-3 py-2.5"><span className="ml-auto block h-4 w-40 animate-pulse rounded-full bg-[var(--glass-hover-bg)]" /></td>
                  ) : (
                    <>
                      <td className="px-3 py-2.5 text-right">{s.count || <span className="text-muted-foreground">—</span>}</td>
                      <td className={cn("px-3 py-2.5 text-right", s.count ? (s.winRate >= 50 ? "text-up" : "text-down") : "text-muted-foreground")}>
                        {s.count ? `${s.winRate}%` : "—"}
                      </td>
                      <td className={cn("px-3 py-2.5 text-right font-medium", toneCls(s.avgR))}>{fmtR(s.avgR)}</td>
                      <td className={cn("px-3 py-2.5 text-right", toneCls(s.netPnl))}>{fmtUsd(s.netPnl, { signed: true, decimals: 0 })}</td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </Panel>
  );
}
