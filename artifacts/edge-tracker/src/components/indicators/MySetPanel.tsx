import { useRef } from "react";
import { ClipboardCopy, Download, FileJson, FileText, Layers, MoreHorizontal, Plus, Upload, X } from "lucide-react";
import { Panel, Pill, toneOf } from "@/components/ds";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { DESK_PRESETS, HORIZONS, HORIZON_META, LIB_BY_ID, type LibIndicator } from "./library";
import type { IndicatorStats } from "./stats";
import { EMPTY_STATS } from "./stats";
import { commonI18n } from "@/i18n/ns/common";
import { indicatorsI18n } from "@/i18n/ns/indicators";
import { fmtDate, fmtR } from "@/lib/format";

export type SetExport = { version: 1; exportedAt: string; favorites: string[]; notes: Record<string, string> };

export function buildMarkdown(ids: string[], notes: Record<string, string>, stats: Record<string, IndicatorStats>): string {
  const t = indicatorsI18n.t;
  const date = fmtDate(new Date(), "short");
  const lines = [t("md.title"), ``, t("md.exported", { date, count: ids.length }), ``];
  ids.forEach((id, i) => {
    const ind = LIB_BY_ID.get(id);
    if (!ind) return;
    const s = stats[id] ?? EMPTY_STATS;
    lines.push(`## ${i + 1}. ${ind.shortName} — ${ind.name}`);
    lines.push(t("md.horizon", { value: HORIZONS.map((h) => `${HORIZON_META[h].label} ${"●".repeat(ind.horizons[h])}${"○".repeat(3 - ind.horizons[h])}`).join(" · ") }));
    lines.push(t("md.timeframe", { value: ind.timeframe }));
    if (ind.settings.length) lines.push(t("md.settings", { value: ind.settings.map((x) => `${x.label} — ${x.value}`).join("; ") }));
    lines.push(t("md.long", { value: ind.signals.long }), t("md.short", { value: ind.signals.short }), t("md.avoid", { value: ind.signals.avoid }));
    if (s.count) {
      const trades = commonI18n.t("units.trades", { count: s.count });
      lines.push(s.avgR != null ? t("md.statsAvg", { trades, wr: s.winRate, avgR: fmtR(s.avgR) }) : t("md.stats", { trades, wr: s.winRate }));
    }
    if (notes[id]) lines.push(``, `> ${notes[id].replace(/\n/g, "\n> ")}`);
    lines.push(``);
  });
  return lines.join("\n");
}

export function parseImport(text: string): SetExport | null {
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object") return null;
    const favorites = Array.isArray(raw.favorites) ? raw.favorites.filter((x: unknown): x is string => typeof x === "string" && LIB_BY_ID.has(x)) : [];
    const notes: Record<string, string> = {};
    if (raw.notes && typeof raw.notes === "object") {
      for (const [k, v] of Object.entries(raw.notes)) if (typeof v === "string" && LIB_BY_ID.has(k)) notes[k] = v.slice(0, 5000);
    }
    if (!favorites.length && !Object.keys(notes).length) return null;
    return { version: 1, exportedAt: String(raw.exportedAt ?? ""), favorites, notes };
  } catch {
    return null;
  }
}

export function MySetPanel({
  ids, stats, statsLoading, onOpen, onRemove, onApplyPreset, onExportMd, onExportJson, onCopy, onImport,
}: {
  ids: string[];
  stats: Record<string, IndicatorStats>;
  statsLoading: boolean;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  onApplyPreset: (presetId: string) => void;
  onExportMd: () => void;
  onExportJson: () => void;
  onCopy: () => void;
  onImport: (file: File) => void;
}) {
  const { t } = indicatorsI18n.useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const items = ids.map((id) => LIB_BY_ID.get(id)).filter((x): x is LibIndicator => !!x);

  return (
    <Panel
      title={t("set.title")}
      description={items.length ? t("set.countDesc", { count: items.length }) : t("set.emptyDesc")}
      icon={Layers}
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t("set.menuAria")}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>{t("set.exportLabel")}</DropdownMenuLabel>
            <DropdownMenuItem disabled={!items.length} onSelect={onExportMd}><FileText className="mr-2 h-4 w-4" /> Markdown (.md)</DropdownMenuItem>
            <DropdownMenuItem disabled={!items.length} onSelect={onExportJson}><FileJson className="mr-2 h-4 w-4" /> {t("set.jsonExport")}</DropdownMenuItem>
            <DropdownMenuItem disabled={!items.length} onSelect={onCopy}><ClipboardCopy className="mr-2 h-4 w-4" /> {t("set.copyText")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => fileRef.current?.click()}><Upload className="mr-2 h-4 w-4" /> {t("set.importJson")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-label={t("set.fileAria")}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImport(f);
          e.target.value = "";
        }}
      />

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("set.emptyText")}
        </p>
      ) : (
        <ul className="-mx-1 space-y-0.5">
          {items.map((ind) => {
            const s = stats[ind.id] ?? EMPTY_STATS;
            return (
              <li key={ind.id} className="group flex items-center gap-1 rounded-xl px-1 hover:bg-[var(--glass-hover-bg)]">
                <button type="button" onClick={() => onOpen(ind.id)} className="flex min-w-0 flex-1 items-center gap-2 rounded-xl py-1.5 pl-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="w-14 shrink-0 text-sm font-semibold">{ind.shortName}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{ind.name}</span>
                  {!statsLoading && s.count > 0 && (
                    <span className={cn("shrink-0 text-xs tabular-nums", s.avgR != null && toneOf(s.avgR) === "up" ? "text-up" : s.avgR != null && s.avgR < 0 ? "text-down" : "text-muted-foreground")}>
                      {s.avgR != null ? fmtR(s.avgR, 1) : commonI18n.t("units.tradesShort", { count: s.count })}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(ind.id)}
                  aria-label={t("set.remove", { short: ind.shortName })}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 space-y-2">
        <div className="micro-label">{t("set.presets")}</div>
        <div className="space-y-1.5">
          {DESK_PRESETS.map((p) => {
            const missing = p.ids.filter((id) => !ids.includes(id)).length;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onApplyPreset(p.id)}
                disabled={missing === 0}
                className="flex w-full items-center gap-2 rounded-xl bg-[var(--glass-bg)] px-3 py-2 text-left transition-colors hover:bg-[var(--glass-hover-bg)] disabled:cursor-default disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {p.label} <Pill>{HORIZON_META[p.horizon].label}</Pill>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {p.ids.map((id) => LIB_BY_ID.get(id)?.shortName).join(" · ")}
                  </span>
                </span>
                {missing === 0 ? (
                  <span className="text-xs text-muted-foreground">{t("set.inSet")}</span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-primary"><Plus className="h-3.5 w-3.5" />{missing}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {items.length > 0 && (
        <Button variant="outline" size="sm" className="mt-4 w-full" onClick={onExportMd}>
          <Download /> {t("set.download")}
        </Button>
      )}
    </Panel>
  );
}
