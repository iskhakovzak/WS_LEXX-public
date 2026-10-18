import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, BookOpen, ChevronLeft, ChevronRight, Ban, Settings2, Star, StickyNote, Clock,
} from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Kbd } from "@/components/ui/kbd";
import { Pill, StatRow, toneOf } from "@/components/ds";
import { cn } from "@/lib/utils";
import { CATEGORY_META, HORIZONS, HORIZON_META, LIB_BY_ID, fitWord, type Horizon, type LibIndicator } from "./library";
import { IndicatorSpark } from "./IndicatorSpark";
import { FitMeter } from "./IndicatorCard";
import type { IndicatorStats } from "./stats";
import { fmtDate, fmtR, fmtUsd } from "@/lib/format";
import { indicatorsI18n } from "@/i18n/ns/indicators";
import { useLang } from "@/i18n";

const resultLabel = (r: string) => indicatorsI18n.tryT(`sheet.result.${r === "be" ? "breakeven" : r}`) ?? r;

function Section({ icon: Icon, title, children }: { icon: typeof Clock; title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        {title}
      </h3>
      {children}
    </section>
  );
}

function NoteEditor({ id, note, onSave, synced }: { id: string; note: string; onSave: (text: string) => void; synced: boolean }) {
  const { t } = indicatorsI18n.useT();
  const [draft, setDraft] = useState(note);
  const saved = draft.trim() === note.trim();
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const noteRef = useRef(note);
  noteRef.current = note;
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  // Save on unmount / indicator switch if dirty.
  useEffect(() => () => {
    if (draftRef.current.trim() !== noteRef.current.trim()) saveRef.current(draftRef.current);
  }, []);
  return (
    <div className="space-y-2">
      <label htmlFor={`ind-note-${id}`} className="sr-only">{t("note.label")}</label>
      <Textarea
        id={`ind-note-${id}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (!saved) onSave(draft); }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); onSave(draft); }
          e.stopPropagation();
        }}
        placeholder={t("note.placeholder")}
        className="min-h-[110px] rounded-xl text-sm"
      />
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span aria-live="polite">{saved ? (note ? (synced ? t("note.savedServer") : t("note.savedLocal")) : t("note.empty")) : t("note.dirty")}</span>
        <span className="hidden items-center gap-1 sm:inline-flex"><Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> {t("note.saveHint")}</span>
      </div>
    </div>
  );
}

export function IndicatorSheet({
  ind, stats, statsLoading, favorite, note, horizon, position, onClose, onPrev, onNext, onOpen, onToggleFavorite, onSaveNote, synced = false,
}: {
  ind: LibIndicator | null;
  stats: IndicatorStats;
  statsLoading: boolean;
  favorite: boolean;
  note: string;
  horizon: Horizon | "all";
  position: { index: number; total: number } | null;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onOpen: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onSaveNote: (id: string, text: string) => void;
  /** Notes/favourites are stored on the server (false ⇒ only the browser cache). */
  synced?: boolean;
}) {
  const { t } = indicatorsI18n.useT();
  const lang = useLang();
  const open = ind != null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft" || e.key === "k") { e.preventDefault(); onPrev(); }
      else if (e.key === "ArrowRight" || e.key === "j") { e.preventDefault(); onNext(); }
      else if ((e.key === "f" || e.key === "F") && ind) { e.preventDefault(); onToggleFavorite(ind.id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, ind, onPrev, onNext, onToggleFavorite]);

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl lg:max-w-2xl [&>*]:shrink-0">
        {ind && (
          <>
            <SheetHeader className="space-y-3 border-b border-border/60 p-5 pr-14 text-left">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={CATEGORY_META[ind.category].tone}>{CATEGORY_META[ind.category].label}</Pill>
                <span className="text-xs text-muted-foreground tabular-nums">{t("sheet.signalStrength", { value: ind.strength })}</span>
                {position && (
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">{position.index + 1} / {position.total}</span>
                )}
              </div>
              <div>
                <SheetTitle className="text-2xl tracking-tight">{ind.shortName}</SheetTitle>
                <SheetDescription>
                  {ind.name}
                  {lang !== "en" && ind.enName !== ind.name && <span className="text-muted-foreground"> · {ind.enName}</span>}
                </SheetDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant={favorite ? "secondary" : "default"} onClick={() => onToggleFavorite(ind.id)} aria-pressed={favorite}>
                  <Star className={cn(favorite && "fill-current text-[hsl(var(--chart-3))]")} />
                  {favorite ? t("sheet.inMySet") : t("sheet.toMySet")}
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/playbook?q=${encodeURIComponent(ind.playbookQuery)}`} onClick={onClose}>
                    <BookOpen /> {t("sheet.playbookSetups")}
                  </Link>
                </Button>
                <div className="ml-auto flex items-center gap-1">
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onPrev} aria-label={t("sheet.prev")}>
                    <ChevronLeft />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onNext} aria-label={t("sheet.next")}>
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            </SheetHeader>

            <div className="flex-1 space-y-6 p-5">
              <div className="glass-panel rounded-2xl p-3">
                <IndicatorSpark id={ind.id} kind={ind.spark} className="h-24" />
                <p className="mt-1 text-xs text-muted-foreground">{t("sheet.illustration")}</p>
              </div>

              <section className="space-y-2">
                <h3 className="micro-label">{t("sheet.deskUse")}</h3>
                <p className="text-sm leading-relaxed text-foreground">{ind.deskUse}</p>
              </section>

              <section className="space-y-3">
                <h3 className="micro-label">{t("sheet.horizon")}</h3>
                <div className="grid grid-cols-3 gap-2">
                  {HORIZONS.map((h) => (
                    <div
                      key={h}
                      className={cn("rounded-xl bg-[var(--glass-bg)] p-3", horizon === h && "ring-1 ring-primary/50")}
                      title={HORIZON_META[h].hint}
                    >
                      <div className="text-xs text-muted-foreground">{HORIZON_META[h].label}</div>
                      <div className="mt-1.5"><FitMeter value={ind.horizons[h]} active={ind.horizons[h] === 3} /></div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {fitWord(ind.horizons[h])}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" aria-hidden="true" /> {ind.timeframe}
                </p>
              </section>

              {ind.settings.length > 0 && (
                <Section icon={Settings2} title={t("sheet.settings")}>
                  <div className="divide-y divide-border/60 rounded-xl bg-[var(--glass-bg)] px-3">
                    {ind.settings.map((s) => <StatRow key={s.label} label={s.label} value={s.value} />)}
                  </div>
                </Section>
              )}

              <Section icon={ArrowUpRight} title={t("sheet.signals")}>
                <ul className="space-y-2">
                  <li className="flex gap-2.5 rounded-xl bg-up/10 p-3 text-sm">
                    <ArrowUpRight className="mt-0.5 h-4 w-4 shrink-0 text-up" aria-hidden="true" />
                    <span><span className="font-medium text-up">{t("sheet.long")} · </span>{ind.signals.long}</span>
                  </li>
                  <li className="flex gap-2.5 rounded-xl bg-down/10 p-3 text-sm">
                    <ArrowDownRight className="mt-0.5 h-4 w-4 shrink-0 text-down" aria-hidden="true" />
                    <span><span className="font-medium text-down">{t("sheet.short")} · </span>{ind.signals.short}</span>
                  </li>
                  <li className="flex gap-2.5 rounded-xl bg-[var(--glass-bg)] p-3 text-sm">
                    <Ban className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span><span className="font-medium">{t("sheet.avoid")} · </span>{ind.signals.avoid}</span>
                  </li>
                </ul>
              </Section>

              <Section icon={AlertTriangle} title={t("sheet.pitfalls")}>
                <ul className="space-y-1.5">
                  {ind.pitfalls.map((p) => (
                    <li key={p} className="flex gap-2 text-sm text-foreground/90">
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--chart-3))]" aria-hidden="true" />
                      {p}
                    </li>
                  ))}
                </ul>
              </Section>

              {ind.combos.length > 0 && (
                <section className="space-y-2">
                  <h3 className="micro-label">{t("sheet.combos")}</h3>
                  <div className="flex flex-wrap gap-2">
                    {ind.combos.map((c) => {
                      const other = LIB_BY_ID.get(c);
                      return other ? (
                        <button key={c} type="button" className="chip inline-flex min-h-8 items-center gap-1.5 px-3 text-sm" onClick={() => onOpen(c)}>
                          <span className="font-medium text-foreground">{other.shortName}</span>
                          <span className="text-xs">{other.name}</span>
                        </button>
                      ) : null;
                    })}
                  </div>
                </section>
              )}

              <section className="space-y-3">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="micro-label">{t("sheet.myStats")}</h3>
                  <span className="text-xs text-muted-foreground">
                    {t("sheet.statsScope")}{horizon !== "all" ? ` · ${HORIZON_META[horizon].label.toLowerCase()}` : ""}
                  </span>
                </div>
                {statsLoading ? (
                  <div className="h-24 animate-pulse rounded-xl bg-[var(--glass-bg)]" />
                ) : stats.count === 0 ? (
                  <p className="rounded-xl bg-[var(--glass-bg)] p-3 text-sm text-muted-foreground">
                    {t("sheet.noTrades", { tag: ind.tags[0] })}
                  </p>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Tile label={t("table.trades")} value={String(stats.count)} />
                      <Tile label={t("sheet.winRate")} value={`${stats.winRate}%`} tone={stats.winRate >= 50 ? "text-up" : "text-down"} />
                      <Tile label={t("sheet.avgR")} value={fmtR(stats.avgR)} tone={toneClass(stats.avgR)} />
                      <Tile label={t("table.netPnl")} value={fmtUsd(stats.netPnl, { signed: true, decimals: 0 })} tone={toneClass(stats.netPnl)} />
                    </div>
                    <div className="overflow-hidden rounded-xl bg-[var(--glass-bg)]">
                      <table className="w-full text-sm tabular-nums">
                        <caption className="sr-only">{t("sheet.byHorizonCaption")}</caption>
                        <thead>
                          <tr className="text-xs text-muted-foreground">
                            <th className="px-3 py-2 text-left font-medium">{t("sheet.horizon")}</th>
                            <th className="px-3 py-2 text-right font-medium">{t("table.trades")}</th>
                            <th className="px-3 py-2 text-right font-medium">WR</th>
                            <th className="px-3 py-2 text-right font-medium">{t("table.avgR")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {HORIZONS.map((h) => {
                            const s = stats.byHorizon[h];
                            return (
                              <tr key={h} className="border-t border-border/50">
                                <td className="px-3 py-2">{HORIZON_META[h].label}</td>
                                <td className="px-3 py-2 text-right">{s.count || "—"}</td>
                                <td className="px-3 py-2 text-right">{s.count ? `${s.winRate}%` : "—"}</td>
                                <td className={cn("px-3 py-2 text-right", toneClass(s.avgR))}>{fmtR(s.avgR)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground">{t("sheet.recent")}</div>
                      <ul className="divide-y divide-border/50">
                        {stats.recent.map((tr) => (
                          <li key={tr.id}>
                            <Link
                              href={`/trades?highlight=${tr.id}`}
                              onClick={onClose}
                              className="flex items-center gap-3 rounded-lg px-1 py-2 text-sm hover:bg-[var(--glass-hover-bg)]"
                            >
                              <span className="w-14 font-semibold">{tr.ticker}</span>
                              <span className="text-xs text-muted-foreground tabular-nums">{fmtDate(tr.date?.slice(0, 10), "short")}</span>
                              <Pill className="hidden sm:inline-flex">{HORIZON_META[tr.horizon].short}</Pill>
                              <span className="ml-auto text-xs text-muted-foreground">{resultLabel(tr.result)}</span>
                              <span className={cn("w-16 text-right tabular-nums", toneClass(tr.r))}>{fmtR(tr.r)}</span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </>
                )}
              </section>

              <Section icon={StickyNote} title={t("sheet.myNotes")}>
                <NoteEditor key={ind.id} id={ind.id} note={note} synced={synced} onSave={(text) => onSaveNote(ind.id, text)} />
              </Section>
            </div>

            <div className="sticky bottom-0 z-sticky hidden items-center gap-3 border-t border-border/60 bg-popover px-5 py-2.5 text-xs text-muted-foreground sm:flex">
              <span className="inline-flex items-center gap-1"><Kbd>←</Kbd><Kbd>→</Kbd> {t("sheet.keyFlip")}</span>
              <span className="inline-flex items-center gap-1"><Kbd>F</Kbd> {t("sheet.keyFav")}</span>
              <span className="inline-flex items-center gap-1"><Kbd>Esc</Kbd> {t("sheet.keyClose")}</span>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function toneClass(n: number | null) {
  const t = toneOf(n);
  return t === "up" ? "text-up" : t === "down" ? "text-down" : "";
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-[var(--glass-bg)] p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-lg font-semibold tabular-nums", tone)}>{value}</div>
    </div>
  );
}
