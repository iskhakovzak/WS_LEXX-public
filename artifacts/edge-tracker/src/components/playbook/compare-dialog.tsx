/** Side-by-side comparison of two setups: edge numbers (better side highlighted), checklist overlap, conditions. */
import { useMemo, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { toneText, type Tone } from "@/components/ds";
import { deriveChecklistItems } from "@/components/playbook-checklist-marks";
import { IconAction } from "@/components/playbook-sub/bits";
import { cn } from "@/lib/utils";
import { EdgeMini, SetupTypePill } from "./setup-bits";
import { STRUCTURED, timeAgo, type PlaybookEntry, type SetupSummary } from "./model";
import { fmtR, fmtRate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { playbookDialogsI18n } from "@/i18n/ns/playbookDialogs";

const dt = playbookDialogsI18n.t; // called at render time only

/** What the setup says about entry: the legacy free text, else the structured card (most setups live there now). */
function describe(e: PlaybookEntry): { label: string; text: string } {
  if (e.conditions?.trim()) return { label: dt("compare.conditions"), text: e.conditions };
  const text = STRUCTURED.filter((f) => (e[f.key] ?? "").trim()).map((f) => `${f.label}: ${(e[f.key] ?? "").trim()}`).join("\n");
  return { label: dt("compare.description2"), text: text || "—" };
}

function SetupPicker({
  value, entries, summary, onChange, exclude, label,
}: {
  value: PlaybookEntry | null; entries: PlaybookEntry[]; summary: Map<number, SetupSummary>; onChange: (e: PlaybookEntry) => void; exclude?: number; label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="glass-field flex min-h-10 w-full min-w-0 items-center gap-2 px-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {value ? <span className="truncate font-semibold" title={value.name}>{value.name}</span> : <span className="text-muted-foreground">{dt("compare.pickSetup")}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(360px,calc(100vw-2rem))] p-0" align="start">
        <Command className="bg-transparent">
          <CommandInput placeholder={dt("compare.findSetup")} aria-label={dt("compare.findSetup")} />
          <CommandList className="max-h-[min(55dvh,440px)]">
            <CommandEmpty className="py-3 text-center text-xs text-muted-foreground">{dt("compare.notFound")}</CommandEmpty>
            <CommandGroup>
              {entries.filter((e) => e.id !== exclude).map((e) => (
                <CommandItem key={e.id} value={`${e.name} ${e.folder ?? ""} ${e.setupType ?? ""} #${e.id}`} onSelect={() => { onChange(e); setOpen(false); }}>
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  <EdgeMini s={summary.get(e.id)} />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

type Metric = { label: string; a: number | null; b: number | null; fmt: (v: number | null) => string; higherIsBetter?: boolean; minN?: boolean };

export function CompareDialog({
  open, onOpenChange, initial, entries, summary, onOpen,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial: PlaybookEntry | null;
  entries: PlaybookEntry[];
  summary: Map<number, SetupSummary>;
  onOpen: (id: number) => void;
}) {
  const { t } = playbookDialogsI18n.useT();
  const [aId, setAId] = useState<number | null>(null);
  const [bId, setBId] = useState<number | null>(null);
  const [lastInitial, setLastInitial] = useState<number | null>(null);
  // Reset when opened for another setup.
  if (open && initial && initial.id !== lastInitial) {
    setLastInitial(initial.id);
    setAId(initial.id);
    // Suggest the best-edge setup from the same folder as the default counterpart.
    const peers = entries.filter((e) => e.id !== initial.id && e.folder === initial.folder);
    const best = [...peers].sort((x, y) => (summary.get(y.id)?.edgeScore ?? -9) - (summary.get(x.id)?.edgeScore ?? -9))[0];
    setBId(best?.id ?? null);
  }
  const a = entries.find((e) => e.id === aId) ?? null;
  const b = entries.find((e) => e.id === bId) ?? null;
  const sa = a ? summary.get(a.id) : undefined;
  const sb = b ? summary.get(b.id) : undefined;

  const metrics: Metric[] = [
    { label: t("compare.trades"), a: sa?.tradeCount ?? 0, b: sb?.tradeCount ?? 0, fmt: (v) => String(v ?? 0), higherIsBetter: true },
    { label: "Win rate", a: sa?.winrate ?? null, b: sb?.winrate ?? null, fmt: fmtRate, higherIsBetter: true },
    { label: t("compare.avgR"), a: sa?.avgR ?? null, b: sb?.avgR ?? null, fmt: fmtR, higherIsBetter: true },
    { label: t("compare.expectancy"), a: sa?.expectancy ?? null, b: sb?.expectancy ?? null, fmt: fmtR, higherIsBetter: true },
    { label: t("compare.edgeScore"), a: sa?.edgeScore ?? null, b: sb?.edgeScore ?? null, fmt: fmtR, higherIsBetter: true },
    { label: t("compare.confidence"), a: a?.confidenceLevel ?? null, b: b?.confidenceLevel ?? null, fmt: (v) => (v == null ? "—" : `${v}%`), higherIsBetter: true },
    { label: t("compare.examples"), a: sa?.exampleCount ?? 0, b: sb?.exampleCount ?? 0, fmt: (v) => String(v ?? 0), higherIsBetter: true },
  ];

  const items = useMemo(() => {
    const ia = a ? deriveChecklistItems(a.checklistItems, a.checklist).map((i) => i.text.trim()) : [];
    const ib = b ? deriveChecklistItems(b.checklistItems, b.checklist).map((i) => i.text.trim()) : [];
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
    const nb = new Set(ib.map(norm));
    const na = new Set(ia.map(norm));
    return { a: ia.map((t) => ({ t, shared: nb.has(norm(t)) })), b: ib.map((t) => ({ t, shared: na.has(norm(t)) })), shared: ia.filter((t) => nb.has(norm(t))).length };
  }, [a, b]);

  const better = (m: Metric, side: "a" | "b"): Tone => {
    const x = side === "a" ? m.a : m.b, y = side === "a" ? m.b : m.a;
    if (x == null || y == null || x === y) return "neutral";
    return (m.higherIsBetter ? x > y : x < y) ? "up" : "neutral";
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setLastInitial(null); }}>
      <DialogContent className="max-h-[85dvh] w-full max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("compare.title")}</DialogTitle>
          <DialogDescription>{t("compare.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
          <SetupPicker label={t("compare.first")} value={a} entries={entries} summary={summary} onChange={(e) => setAId(e.id)} exclude={bId ?? undefined} />
          <IconAction aria-label={t("compare.swap")} title={t("compare.swap")} onClick={() => { setAId(bId); setBId(aId); }}><ArrowLeftRight /></IconAction>
          <SetupPicker label={t("compare.second")} value={b} entries={entries} summary={summary} onChange={(e) => setBId(e.id)} exclude={aId ?? undefined} />
        </div>

        {a && b ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {[a, b].map((e) => (
                <div key={e.id} className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <SetupTypePill type={e.setupType} />
                  <span className="truncate">{e.folder ?? commonI18n.t("fields.noFolder")}</span>
                  <span>· {timeAgo(summary.get(e.id)?.lastUsedAt) ?? t("compare.notUsed")}</span>
                </div>
              ))}
            </div>

            <div className="overflow-hidden rounded-xl bg-[var(--glass-bg)]">
              <table className="w-full table-fixed text-sm">
                <caption className="sr-only">{t("compare.metricsCaption")}</caption>
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th scope="col" className="w-[38%] px-3 py-2 text-left font-normal">{t("compare.metric")}</th>
                    <th scope="col" className="truncate px-3 py-2 text-right font-normal" title={a.name}>{a.name}</th>
                    <th scope="col" className="truncate px-3 py-2 text-right font-normal" title={b.name}>{b.name}</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((m) => (
                    <tr key={m.label} className="border-t border-border/60">
                      <th scope="row" className="px-3 py-2 text-left font-normal text-muted-foreground">{m.label}</th>
                      <td className={cn("px-3 py-2 text-right font-semibold tabular-nums", toneText(better(m, "a")))}>{m.fmt(m.a)}</td>
                      <td className={cn("px-3 py-2 text-right font-semibold tabular-nums", toneText(better(m, "b")))}>{m.fmt(m.b)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {((sa?.tradeCount ?? 0) < 10 || (sb?.tradeCount ?? 0) < 10) && (
              <p className="text-xs text-muted-foreground">{t("compare.smallSample")}</p>
            )}

            <div>
              <div className="mb-2 text-sm font-semibold">
                {t("compare.checklist")} <span className="font-normal text-muted-foreground">{t("compare.sharedItems", { count: items.shared })}</span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[items.a, items.b].map((list, idx) => (
                  <ul key={idx} className="space-y-1 rounded-xl bg-[var(--glass-bg)] p-3 text-sm">
                    {list.length === 0 && <li className="text-muted-foreground">{t("compare.noChecklist")}</li>}
                    {list.map((it, i) => (
                      <li key={i} className={cn("flex gap-2", it.shared ? "text-muted-foreground" : "text-foreground")}>
                        <span aria-hidden="true" className={it.shared ? "text-muted-foreground" : "text-primary"}>{it.shared ? "=" : "+"}</span>
                        <span className="min-w-0 [overflow-wrap:anywhere]">{it.t}</span>
                        {!it.shared && <span className="sr-only">{t("compare.onlyHere")}</span>}
                      </li>
                    ))}
                  </ul>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[a, b].map((e) => {
                const d = describe(e);
                return (
                  <div key={e.id} className="rounded-xl bg-[var(--glass-bg)] p-3">
                    <div className="mb-1 text-xs text-muted-foreground">{d.label}</div>
                    <p className="line-clamp-[12] whitespace-pre-wrap text-sm">{d.text}</p>
                    <Button variant="ghost" size="sm" className="mt-2 h-8" onClick={() => { onOpen(e.id); onOpenChange(false); }}>{t("compare.openSetup")}</Button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("compare.pickSecond")}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
