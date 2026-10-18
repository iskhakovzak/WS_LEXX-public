import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, CheckCircle2, Cloud, Copy, Loader2, NotebookPen, Pencil, Plus } from "lucide-react";
import { Panel, Pill } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { QueryError } from "@/components/query-error";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { MARKET_BIAS, TICKER_BIAS, gpApi, gpKeys, type GamePlan, type InPlayItem, type MyPlanResponse, type PlanStatus, type TraderPlan } from "./types";
import { fmtDate } from "@/lib/format";
import { applyTemplate, docToDraft, draftToDoc, isDraftEmpty, sameDoc, validateDraft, type DraftErrors, type PlanDraft } from "./plan-draft";
import { PlanEditor, type SetDraft, type TickerSuggestion } from "./plan-editor";
import { PlanDocView } from "./plan-doc-view";
import { TemplateMenu } from "./plan-templates";
import { FocusBanner, shortDay } from "./plan-briefing";
import { gpI18n } from "@/i18n/ns/gamePlan";
import { personName } from "@/i18n";
import { ApiError } from "@/lib/api/http";
import { dailyMeQuery } from "@/lib/api/queries";

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; at: string } | { kind: "error"; message: string } | { kind: "invalid" };

const AUTOSAVE_MS = 1200;

function fromDesk(i: InPlayItem): TickerSuggestion {
  const join = (a?: number[]) => (a ?? []).join(" ");
  return {
    ticker: i.ticker,
    catalyst: i.catalyst ?? "",
    bias: i.bias ?? "neutral",
    grade: i.grade ?? "none",
    horizon: i.horizon ?? "intraday",
    support: join(i.levels?.support),
    resistance: join(i.levels?.resistance),
    scenarioA: i.scenarioA ?? "",
    scenarioB: i.scenarioB ?? "",
    trigger: i.trigger ?? "",
    invalidation: i.invalidation ?? "",
    tvLink: i.tvLink ?? "",
    // Desk screenshots stay on the desk plan — a personal plan only holds the trader's own uploads.
  };
}

/**
 * «Мой план»: the trader's own plan for the day. Autosaves to the server ~1 s after typing stops;
 * «Готов» marks it ready for the curator. Desk tickers can be pulled in with one click.
 */
export function MyPlan({ date, deskPlan }: { date: string; deskPlan: GamePlan | null }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: gpKeys.my(date), queryFn: () => gpApi.my(date), retry: false });

  if (q.isLoading) return <MyPlanSkeleton />;
  if (q.isError)
    return <QueryError error={q.error} onRetry={() => q.refetch()} message={serverMsg(q.error)} />;
  return (
    <MyPlanEditor
      key={date}
      date={date}
      initial={q.data!}
      deskPlan={deskPlan}
      onSaved={(p) => qc.setQueryData<MyPlanResponse>(gpKeys.my(date), (prev) => (prev ? { ...prev, plan: p } : prev))}
    />
  );
}

function MyPlanEditor({
  date,
  initial,
  deskPlan,
  onSaved,
}: {
  date: string;
  initial: MyPlanResponse;
  deskPlan: GamePlan | null;
  onSaved: (p: TraderPlan) => void;
}) {
  const { t } = gpI18n.useT();
  const start = useMemo(() => docToDraft(initial.plan?.doc), [initial.plan]);
  const [draft, setDraftState] = useState<PlanDraft>(start);
  const [status, setStatus] = useState<PlanStatus>(initial.plan?.status ?? "draft");
  const [editing, setEditing] = useState(() => !initial.plan || initial.plan.status !== "ready");
  const [errors, setErrors] = useState<DraftErrors>({});
  const [save, setSave] = useState<SaveState>(initial.plan ? { kind: "saved", at: initial.plan.updatedAt } : { kind: "idle" });
  const [copying, setCopying] = useState(false);

  const saved = useRef<{ draft: PlanDraft; status: PlanStatus }>({ draft: start, status: initial.plan?.status ?? "draft" });
  const latest = useRef({ draft, status });
  latest.current = { draft, status };
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const ctrl = useRef<AbortController | null>(null);
  const timer = useRef<number | null>(null);

  const pending = !sameDoc(draft, saved.current.draft) || status !== saved.current.status;

  const flush = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (timer.current) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      const { draft: d, status: s } = latest.current;
      if (sameDoc(d, saved.current.draft) && s === saved.current.status) return true;
      // Nothing written yet → don't create an empty row.
      if (!initial.plan && !saved.current.draft.inPlay.length && isDraftEmpty(d) && s === "draft") return true;
      const errs = validateDraft(d);
      setErrors(errs);
      if (Object.keys(errs).length) {
        setSave({ kind: "invalid" });
        return false;
      }
      ctrl.current?.abort();
      const ac = new AbortController();
      ctrl.current = ac;
      setSave({ kind: "saving" });
      try {
        const out = await gpApi.saveMy(date, { ...draftToDoc(d), status: s }, opts.silent ? undefined : ac.signal);
        saved.current = { draft: d, status: s };
        if (ctrl.current === ac) setSave({ kind: "saved", at: out.updatedAt });
        onSavedRef.current(out);
        return true;
      } catch (e) {
        if (ac.signal.aborted) return false;
        setSave({ kind: "error", message: e instanceof Error ? e.message : gpI18n.t("my.networkError") });
        return false;
      }
    },
    [date, initial.plan],
  );

  // Debounced autosave.
  useEffect(() => {
    if (!pending) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), AUTOSAVE_MS);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [draft, status, pending, flush]);

  // Leaving the view / switching the day: save what's pending; warn on tab close.
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      const { draft: d, status: s } = latest.current;
      if (!sameDoc(d, saved.current.draft) || s !== saved.current.status) {
        void flush({ silent: true });
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", onBefore);
    return () => {
      window.removeEventListener("beforeunload", onBefore);
      void flush({ silent: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setDraft: SetDraft = useCallback((fn) => setDraftState(fn), []);

  // Prefill law: on the focus day a rule of the day that was never chosen starts as the focus. A plan without a row
  // keeps it as the baseline (saved with the first real edit, no «unsaved» warning); an existing plan saves it.
  const dailyQ = useQuery({ ...dailyMeQuery(), retry: false });
  const focus = dailyQ.data?.focus;
  const focusMistake = focus && focus.date === date && focus.source !== "none" ? focus.mistake : null;
  useEffect(() => {
    if (!focusMistake) return;
    const fill = (d: PlanDraft): PlanDraft => (d.ownRule === undefined ? { ...d, ownRule: focusMistake } : d);
    if (!initial.plan) saved.current = { ...saved.current, draft: fill(saved.current.draft) };
    setDraftState(fill);
  }, [focusMistake, initial.plan]);

  // Clear errors as fields get fixed.
  useEffect(() => {
    if (Object.keys(errors).length) setErrors(validateDraft(draft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  async function markReady(next: PlanStatus) {
    if (next === "ready") {
      const errs = validateDraft(draft);
      setErrors(errs);
      if (Object.keys(errs).length) {
        toast({ title: t("my.checkFields"), description: Object.values(errs)[0], variant: "destructive" });
        return;
      }
      if (isDraftEmpty(draft)) {
        toast({ title: t("my.emptyPlan"), description: t("my.emptyPlanDesc") });
        return;
      }
    }
    setStatus(next);
    latest.current = { draft, status: next };
    const ok = await flush();
    if (ok && next === "ready") {
      setEditing(false);
      toast({ title: t("my.ready"), description: t("my.readyDesc") });
    }
  }

  async function copyPrev() {
    if (!initial.prevDate) return;
    setCopying(true);
    try {
      const r = await gpApi.my(initial.prevDate);
      if (!r.plan) throw new Error(t("my.notFound"));
      const prev = docToDraft(r.plan.doc);
      setDraft(() => prev);
      toast({ title: t("my.copied"), description: t("my.copiedDesc", { date: shortDay(initial.prevDate) }) });
    } catch (e) {
      toast({ title: t("my.copyFailed"), description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setCopying(false);
    }
  }

  const deskTickers = deskPlan?.inPlay ?? [];
  const taken = new Set(draft.inPlay.map((t) => t.ticker.trim().toUpperCase()));

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <SaveIndicator state={save} pending={pending} onRetry={() => void flush()} />
      {editing ? (
        <Button
          type="button"
          size="sm"
          className={cn(status !== "ready" && "bg-primary-solid")}
          variant={status === "ready" ? "outline" : "default"}
          onClick={() => void markReady(status === "ready" ? "draft" : "ready")}
        >
          {status === "ready" ? <CheckCircle2 aria-hidden="true" /> : <Check aria-hidden="true" />}
          {status === "ready" ? t("my.readyBack") : t("my.ready")}
        </Button>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
          <Pencil aria-hidden="true" />
          {t("page.edit")}
        </Button>
      )}
    </div>
  );

  return (
    <div className="grid gap-[var(--grid-gap)] lg:grid-cols-[minmax(0,1fr)_300px]">
      <Panel
        title={
          <span className="flex items-center gap-2">
            {t("my.title", { date: shortDay(date) })}
            {status === "ready" && (
              <Pill tone="accent" dot>
                {t("my.readyPill")}
              </Pill>
            )}
          </span>
        }
        icon={NotebookPen}
        description={editing ? t("my.autosaveHint") : undefined}
        actions={header}
      >
        {editing ? (
          <PlanEditor
            mode="personal"
            date={date}
            draft={draft}
            setDraft={setDraft}
            errors={errors}
            focusMistake={focusMistake}
            tickerActions={deskTickers.length > 0 ? <DeskTickerPicker items={deskTickers} taken={taken} onPick={(l) => addTickers(setDraft, l)} /> : null}
            navSlot={
              <>
                {initial.prevDate && (
                  <Button type="button" variant="ghost" size="sm" onClick={copyPrev} disabled={copying} title={t("my.copyFrom", { date: shortDay(initial.prevDate) })}>
                    {copying ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Copy aria-hidden="true" />}
                    {t("my.likeDay", { date: shortDay(initial.prevDate) })}
                  </Button>
                )}
                <TemplateMenu
                  kind="personal"
                  currentDoc={() => draftToDoc(draft)}
                  onApply={(doc, name) => {
                    setDraft((d) => applyTemplate(d, doc));
                    toast({ title: t("templates.applied", { name }), description: t("templates.appliedDesc") });
                  }}
                />
              </>
            }
          />
        ) : (
          <PlanDocView doc={draftToDoc(draft)} compactTickers />
        )}
      </Panel>

      <DeskSummary plan={deskPlan} taken={taken} onAdd={(l) => { setEditing(true); addTickers(setDraft, l); }} />
    </div>
  );
}

function addTickers(setDraft: SetDraft, list: TickerSuggestion[]) {
  // PlanEditor exposes adding via its own pickers; here we merge directly (same de-dup rules).
  setDraft((d) => {
    const have = new Set(d.inPlay.map((t) => t.ticker.trim().toUpperCase()));
    const fresh = list.filter((s) => !have.has(s.ticker.toUpperCase()));
    if (!fresh.length) return d;
    const next = docToDraft({ inPlay: fresh.map((s) => suggestionToItem(s)) }).inPlay;
    return { ...d, inPlay: [...d.inPlay, ...next].slice(0, 30) };
  });
}

function suggestionToItem(s: TickerSuggestion): InPlayItem {
  const lv = (str?: string) => (str ?? "").split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
  return {
    ticker: s.ticker.toUpperCase(),
    catalyst: s.catalyst ?? "",
    bias: s.bias ?? "neutral",
    grade: s.grade && s.grade !== "none" ? s.grade : null,
    horizon: s.horizon ?? "intraday",
    levels: { support: lv(s.support), resistance: lv(s.resistance) },
    plan: s.plan ?? "",
    risk_note: s.risk_note ?? "",
    scenarioA: s.scenarioA ?? "",
    scenarioB: s.scenarioB ?? "",
    trigger: s.trigger ?? "",
    invalidation: s.invalidation ?? "",
    tvLink: s.tvLink ?? "",
    media: [],
  };
}

function SaveIndicator({ state, pending, onRetry }: { state: SaveState; pending: boolean; onRetry: () => void }) {
  const { t } = gpI18n.useT();
  let content: React.ReactNode = null;
  if (state.kind === "saving")
    content = (
      <>
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> {t("my.saving")}
      </>
    );
  else if (state.kind === "error")
    content = (
      <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 text-destructive hover:underline" title={state.message}>
        <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" /> {t("my.saveRetry")}
      </button>
    );
  else if (state.kind === "invalid")
    content = (
      <span className="inline-flex items-center gap-1.5 text-destructive">
        <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" /> {t("my.fixFields")}
      </span>
    );
  else if (pending) content = <span>{t("my.changes")}</span>;
  else if (state.kind === "saved")
    content = (
      <>
        <Cloud className="h-3.5 w-3.5" aria-hidden="true" /> {t("my.savedAt", { time: fmtDate(state.at, "time") })}
      </>
    );
  return (
    <span className="inline-flex min-h-8 items-center gap-1.5 text-xs tabular-nums text-muted-foreground" aria-live="polite">
      {content}
    </span>
  );
}

function DeskTickerPicker({ items, taken, onPick }: { items: InPlayItem[]; taken: Set<string>; onPick: (l: TickerSuggestion[]) => void }) {
  const { t } = gpI18n.useT();
  const [open, setOpen] = useState(false);
  const fresh = items.filter((i) => !taken.has(i.ticker.toUpperCase()));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Plus aria-hidden="true" />
          {t("my.fromDesk")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end">
        <Command>
          <CommandList>
            <CommandEmpty>{t("editor.noTickers")}</CommandEmpty>
            <CommandGroup heading={t("my.deskTickers")}>
              {fresh.length > 1 && (
                <CommandItem
                  value="__all__"
                  onSelect={() => {
                    onPick(fresh.map(fromDesk));
                    setOpen(false);
                  }}
                  className="font-medium text-primary"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t("editor.addAll", { count: fresh.length })}
                </CommandItem>
              )}
              {items.map((i) => {
                const added = taken.has(i.ticker.toUpperCase());
                return (
                  <CommandItem
                    key={i.ticker}
                    value={i.ticker}
                    disabled={added}
                    onSelect={() => {
                      onPick([fromDesk(i)]);
                      setOpen(false);
                    }}
                    className="flex items-center gap-2"
                  >
                    <span className="w-14 shrink-0 font-semibold">{i.ticker}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{i.catalyst || TICKER_BIAS[i.bias]?.label}</span>
                    {added && <Check className="h-4 w-4 shrink-0 text-primary" aria-label={t("editor.inPlan")} />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function DeskSummary({ plan, taken, onAdd }: { plan: GamePlan | null; taken: Set<string>; onAdd: (l: TickerSuggestion[]) => void }) {
  const { t } = gpI18n.useT();
  if (!plan)
    return (
      <Panel title={t("my.deskPlan")}>
        <p className="text-sm text-muted-foreground">{t("my.deskNotPublished")}</p>
      </Panel>
    );
  const bias = MARKET_BIAS[plan.bias] ?? MARKET_BIAS.neutral;
  return (
    <aside aria-label={t("my.deskPlan")} className="flex min-w-0 flex-col gap-[var(--grid-gap)]">
      <Panel title={t("my.deskPlan")} description={personName(plan.author)}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={bias.tone} dot>
              {bias.label}
            </Pill>
          </div>
          <FocusBanner focus={plan.focus} />
          {plan.marketView && <p className="line-clamp-6 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{plan.marketView}</p>}
          {plan.inPlay.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">{t("my.deskTickersHint")}</span>
              <ul className="flex flex-wrap gap-1.5">
                {plan.inPlay.map((i) => {
                  const added = taken.has(i.ticker.toUpperCase());
                  return (
                    <li key={i.ticker}>
                      <button
                        type="button"
                        className="chip inline-flex min-h-8 items-center gap-1 px-3 text-xs font-semibold"
                        aria-pressed={added}
                        disabled={added}
                        onClick={() => onAdd([fromDesk(i)])}
                        title={i.catalyst || undefined}
                      >
                        {added ? <Check className="h-3 w-3" aria-hidden="true" /> : <Plus className="h-3 w-3" aria-hidden="true" />}
                        {i.ticker}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {plan.riskNotes && (
            <div className="rounded-xl border border-[var(--field-border)] p-2.5">
              <p className="text-xs text-muted-foreground">{t("my.deskRisk")}</p>
              <p className="whitespace-pre-wrap text-sm">{plan.riskNotes}</p>
            </div>
          )}
        </div>
      </Panel>
    </aside>
  );
}

function MyPlanSkeleton() {
  return (
    <div className="grid gap-[var(--grid-gap)] lg:grid-cols-[minmax(0,1fr)_300px]" aria-busy="true" aria-label={gpI18n.t("page.loadingPlan")}>
      <div className="glass-panel flex flex-col gap-4 rounded-2xl p-[var(--panel-p)]">
        <Skeleton className="h-5 w-48 rounded-full" />
        <Skeleton className="h-9 w-80 rounded-full" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  );
}

function serverMsg(e: unknown): string | undefined {
  if (!(e instanceof Error)) return undefined;
  return e instanceof ApiError && e.status === 404 ? gpI18n.t("my.notDeployed") : e.message;
}
