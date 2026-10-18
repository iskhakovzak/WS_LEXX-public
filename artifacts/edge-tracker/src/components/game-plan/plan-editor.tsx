import { useCallback, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useReducedMotion } from "framer-motion";
import { Check, ChevronDown, Compass, Eye, Globe2, Loader2, Plus, ShieldAlert, Target, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Segmented } from "@/components/ds";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { cn } from "@/lib/utils";
import { HORIZON, IMPACT, MARKET_BIAS, RISK_MODE, TICKER_BIAS, type Horizon, type Impact, type MarketBias, type MediaRef, type RiskMode, type TickerBias } from "./types";
import { fmtPrice } from "@/lib/format";
import {
  MAX_PLAN_MEDIA,
  MAX_PLAN_TV,
  MAX_TICKERS,
  MAX_TICKER_MEDIA,
  blockDone,
  emptyTicker,
  newKey,
  parseLevels,
  type DraftErrors,
  type PlanDraft,
  type TickerDraft,
} from "./plan-draft";
import { MediaStrip, PasteRouterProvider, TvLinkField, useEditorPaste } from "./plan-media";
import type { MediaContext } from "./media";
import { OwnRuleField } from "./own-rule-field";
import { gpI18n } from "@/i18n/ns/gamePlan";
import { commonI18n } from "@/i18n/ns/common";

export type SetDraft = (fn: (d: PlanDraft) => PlanDraft) => void;

/** Ticker suggestion from another source (watchlist, desk plan). */
export type TickerSuggestion = Partial<TickerDraft> & { ticker: string };

/** Quick rules in the UI language (they are inserted into the trader's own focus text). */
const FOCUS_CHIP_KEYS = ["a", "b", "c", "d", "e"] as const;

/**
 * Block editor shared by the desk plan (sheet) and a personal plan (inline).
 * Quick blocks: Рынок · Тикеры · Риск · Фокус. Ctrl+V anywhere pastes a screenshot into the focused block.
 */
export function PlanEditor(props: {
  mode: MediaContext;
  date: string;
  draft: PlanDraft;
  setDraft: SetDraft;
  errors: DraftErrors;
  /** Extra buttons in the «Тикеры» header (e.g. «Из плана деска»). */
  tickerActions?: React.ReactNode;
  /** Right side of the block nav (templates menu, status). */
  navSlot?: React.ReactNode;
  /** Offset for the sticky block nav inside its scroller. */
  stickyClassName?: string;
  /** Personal plan for the focus day: today's focus (MistakeId), listed first in «Правило дня». */
  focusMistake?: string | null;
}) {
  return (
    <PasteRouterProvider>
      <EditorInner {...props} />
    </PasteRouterProvider>
  );
}

function EditorInner({
  mode,
  date,
  draft,
  setDraft,
  errors,
  tickerActions,
  navSlot,
  stickyClassName,
  focusMistake,
}: Parameters<typeof PlanEditor>[0]) {
  const { t: tr } = gpI18n.useT();
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  useEditorPaste(rootRef, "plan");
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(draft.inPlay.length <= 2 ? draft.inPlay.map((t) => t.key) : draft.inPlay.filter((t) => !t.ticker).map((t) => t.key)),
  );
  const [showIdx, setShowIdx] = useState(() => !!(draft.spyS || draft.spyR || draft.qqqS || draft.qqqR || draft.spyNote || draft.qqqNote));
  const done = blockDone(draft);
  const isDesk = mode === "desk";

  const patch = useCallback((p: Partial<PlanDraft>) => setDraft((d) => ({ ...d, ...p })), [setDraft]);
  const patchTicker = useCallback(
    (key: string, p: Partial<TickerDraft>) => setDraft((d) => ({ ...d, inPlay: d.inPlay.map((t) => (t.key === key ? { ...t, ...p } : t)) })),
    [setDraft],
  );
  const addTickers = useCallback(
    (list: TickerSuggestion[]) => {
      const fresh: TickerDraft[] = [];
      setDraft((d) => {
        const have = new Set(d.inPlay.map((t) => t.ticker.trim().toUpperCase()));
        for (const s of list) {
          const tk = s.ticker.trim().toUpperCase();
          if (tk && have.has(tk)) continue;
          have.add(tk);
          fresh.push(emptyTicker({ ...s, ticker: tk }));
        }
        return { ...d, inPlay: [...d.inPlay, ...fresh].slice(0, MAX_TICKERS) };
      });
      // setDraft is synchronous for the updater above in React 18 batching; open the new cards.
      queueMicrotask(() => setOpen((o) => new Set([...o, ...fresh.map((f) => f.key)])));
    },
    [setDraft],
  );
  const addBlank = () => {
    const t = emptyTicker();
    setDraft((d) => ({ ...d, inPlay: [...d.inPlay, t].slice(0, MAX_TICKERS) }));
    setOpen((o) => new Set([...o, t.key]));
    requestAnimationFrame(() => document.getElementById(`${uid}-t-${t.key}`)?.focus());
  };
  const removeTicker = (key: string) => setDraft((d) => ({ ...d, inPlay: d.inPlay.filter((t) => t.key !== key) }));

  const goto = (id: string) =>
    document.getElementById(`${uid}-${id}`)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });

  const blocks: { id: string; label: string; done: boolean; count?: number }[] = [
    { id: "market", label: tr("editor.blocks.market"), done: done.market },
    { id: "tickers", label: isDesk ? tr("editor.blocks.tickers") : tr("editor.blocks.myTickers"), done: done.tickers, count: draft.inPlay.length },
    { id: "risk", label: tr("editor.blocks.risk"), done: done.risk },
    { id: "focus", label: tr("editor.blocks.focus"), done: done.focus },
  ];

  const takenTickers = draft.inPlay.map((t) => t.ticker.trim().toUpperCase()).filter(Boolean);

  return (
    <div ref={rootRef} className="flex flex-col gap-6">
      {/* Block nav */}
      <nav
        aria-label={tr("editor.blocksAria")}
        className={cn("sticky-top z-sticky -mx-1 flex flex-wrap items-center gap-1.5 rounded-full px-1 py-1", stickyClassName)}
      >
        <div className="glass-field flex flex-wrap items-center gap-0.5 p-1">
          {blocks.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => goto(b.id)}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", b.done ? "bg-primary" : "bg-muted-foreground/40")} aria-hidden="true" />
              {b.label}
              {b.count ? <span className="tabular-nums text-muted-foreground">{b.count}</span> : null}
              <span className="sr-only">{b.done ? tr("editor.blockFilled") : tr("editor.blockEmpty")}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">{navSlot}</div>
      </nav>

      {/* ── Рынок ── */}
      <Block id={`${uid}-market`} icon={Globe2} title={tr("editor.blocks.market")} hint={tr("editor.marketHint")} pasteKey="plan">
        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted-foreground">{tr("editor.bias")}</span>
          <Segmented<MarketBias>
            ariaLabel={tr("editor.bias")}
            size="sm"
            value={draft.bias}
            onChange={(v) => patch({ bias: v })}
            options={(Object.keys(MARKET_BIAS) as MarketBias[]).map((k) => ({ value: k, label: MARKET_BIAS[k].label }))}
          />
        </div>
        <Field label={tr("editor.context")} htmlFor={`${uid}-mv`}>
          <Textarea
            id={`${uid}-mv`}
            rows={4}
            maxLength={6000}
            value={draft.marketView}
            onChange={(e) => patch({ marketView: e.target.value })}
            placeholder={tr("editor.contextPlaceholder")}
          />
        </Field>

        {isDesk && <MacroEditor uid={uid} draft={draft} setDraft={setDraft} errors={errors} />}

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setShowIdx((v) => !v)}
            aria-expanded={showIdx}
            className="inline-flex w-fit items-center gap-1.5 rounded-full text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !showIdx && "-rotate-90")} aria-hidden="true" />
            {tr("editor.indexLevels")}
            {(draft.spyS || draft.spyR || draft.qqqS || draft.qqqR) && !showIdx && <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />}
          </button>
          {showIdx && (
            <div className="grid gap-3 md:grid-cols-2">
              {(["spy", "qqq"] as const).map((sym) => {
                const S = sym === "spy" ? "spyS" : "qqqS";
                const R = sym === "spy" ? "spyR" : "qqqR";
                const N = sym === "spy" ? "spyNote" : "qqqNote";
                return (
                  <div key={sym} className="flex flex-col gap-2 rounded-xl border border-[var(--field-border)] p-3">
                    <p className="text-sm font-semibold">{sym.toUpperCase()}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label={tr("editor.support")} htmlFor={`${uid}-${S}`} error={errors[S]}>
                        <Input id={`${uid}-${S}`} inputMode="decimal" placeholder="578.2 575" value={draft[S]} onChange={(e) => patch({ [S]: e.target.value } as Partial<PlanDraft>)} />
                      </Field>
                      <Field label={tr("editor.resistance")} htmlFor={`${uid}-${R}`} error={errors[R]}>
                        <Input id={`${uid}-${R}`} inputMode="decimal" placeholder="583.5 586" value={draft[R]} onChange={(e) => patch({ [R]: e.target.value } as Partial<PlanDraft>)} />
                      </Field>
                    </div>
                    <Input
                      aria-label={tr("editor.indexComment", { symbol: sym.toUpperCase() })}
                      placeholder={tr("editor.indexCommentPlaceholder")}
                      maxLength={500}
                      value={draft[N]}
                      onChange={(e) => patch({ [N]: e.target.value } as Partial<PlanDraft>)}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted-foreground">{tr("editor.marketMedia")}</span>
          <TvLinkField
            links={draft.tvLinks}
            max={MAX_PLAN_TV}
            onChange={(tvLinks) => patch({ tvLinks })}
            label={tr("editor.planTvLink")}
          />
          <MediaStrip
            refs={draft.media}
            onChange={(fn) => setDraft((d) => ({ ...d, media: fn(d.media) }))}
            context={mode}
            date={date}
            max={MAX_PLAN_MEDIA}
            pasteKey="plan"
            label={tr("editor.blocks.market")}
            onAddTvLinks={(urls) => setDraft((d) => ({ ...d, tvLinks: [...new Set([...d.tvLinks, ...urls])].slice(0, MAX_PLAN_TV) }))}
          />
        </div>
      </Block>

      {/* ── Тикеры ── */}
      <Block
        id={`${uid}-tickers`}
        icon={Target}
        title={isDesk ? tr("editor.tickersDesk") : tr("editor.blocks.myTickers")}
        hint={tr("editor.tickersHint")}
        actions={
          <>
            {tickerActions}
            <WatchlistPicker taken={takenTickers} onPick={(list) => addTickers(list)} />
            <Button type="button" variant="outline" size="sm" onClick={addBlank} disabled={draft.inPlay.length >= MAX_TICKERS}>
              <Plus aria-hidden="true" />
              {tr("editor.addTicker")}
            </Button>
          </>
        }
      >
        {draft.inPlay.length === 0 ? (
          <button
            type="button"
            onClick={addBlank}
            className="rounded-xl border border-dashed border-[var(--field-border)] px-4 py-6 text-center text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {isDesk ? tr("editor.addTickerEmptyDesk") : tr("editor.addTickerEmpty")}
          </button>
        ) : (
          <div className="flex flex-col gap-2">
            {draft.inPlay.map((t, idx) => (
              <TickerEditor
                key={t.key}
                uid={uid}
                t={t}
                idx={idx}
                mode={mode}
                date={date}
                errors={errors}
                open={open.has(t.key)}
                onToggle={() =>
                  setOpen((o) => {
                    const n = new Set(o);
                    if (n.has(t.key)) n.delete(t.key);
                    else n.add(t.key);
                    return n;
                  })
                }
                patch={(p) => patchTicker(t.key, p)}
                setMedia={(fn) => setDraft((d) => ({ ...d, inPlay: d.inPlay.map((x) => (x.key === t.key ? { ...x, media: fn(x.media) } : x)) }))}
                onRemove={() => removeTicker(t.key)}
              />
            ))}
          </div>
        )}
      </Block>

      {/* ── Риск ── */}
      <Block id={`${uid}-risk`} icon={ShieldAlert} title={tr("editor.riskTitle")} hint={isDesk ? tr("editor.riskHintDesk") : tr("editor.riskHint")} pasteKey="plan">
        {isDesk && (
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">{tr("editor.sizeMode")}</span>
            <Segmented<RiskMode>
              ariaLabel={tr("editor.riskModeAria")}
              size="sm"
              value={draft.riskMode}
              onChange={(v) => patch({ riskMode: v })}
              options={(Object.keys(RISK_MODE) as RiskMode[]).map((k) => ({ value: k, label: RISK_MODE[k].label }))}
            />
            <span className="text-xs text-muted-foreground">{RISK_MODE[draft.riskMode].hint}</span>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 sm:max-w-md">
          <Field label={tr("editor.maxLoss")} htmlFor={`${uid}-ml`} error={errors.maxLoss}>
            <Input id={`${uid}-ml`} inputMode="decimal" placeholder="300" value={draft.maxLoss} onChange={(e) => patch({ maxLoss: e.target.value })} className="tabular-nums" />
          </Field>
          <Field label={tr("editor.maxTrades")} htmlFor={`${uid}-mt`} error={errors.maxTrades}>
            <Input id={`${uid}-mt`} inputMode="numeric" placeholder="10" value={draft.maxTrades} onChange={(e) => patch({ maxTrades: e.target.value })} className="tabular-nums" />
          </Field>
        </div>
        {!isDesk && <OwnRuleField id={`${uid}-or`} value={draft.ownRule} onChange={(v) => patch({ ownRule: v })} focusMistake={focusMistake} />}
        <Field label={isDesk ? tr("editor.riskNotesDesk") : tr("editor.riskNotes")} htmlFor={`${uid}-rn`}>
          <Textarea
            id={`${uid}-rn`}
            rows={3}
            maxLength={6000}
            value={draft.riskNotes}
            onChange={(e) => patch({ riskNotes: e.target.value })}
            placeholder={tr("editor.riskNotesPlaceholder")}
          />
        </Field>
      </Block>

      {/* ── Фокус ── */}
      <Block id={`${uid}-focus`} icon={Compass} title={tr("editor.focusTitle")} hint={tr("editor.focusHint")} pasteKey="plan">
        <Field label={tr("editor.focusRule")} htmlFor={`${uid}-fc`}>
          <Input
            id={`${uid}-fc`}
            maxLength={1000}
            value={draft.focus}
            onChange={(e) => patch({ focus: e.target.value })}
            placeholder={tr("editor.focusPlaceholder")}
            className="font-medium"
          />
        </Field>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={tr("editor.quickRules")}>
          {FOCUS_CHIP_KEYS.map((k) => tr(`editor.focusChips.${k}`)).map((c) => {
            const on = draft.focus.includes(c);
            return (
              <button
                key={c}
                type="button"
                className="chip min-h-8 px-3 text-xs"
                aria-pressed={on}
                onClick={() =>
                  patch({
                    focus: on
                      ? draft.focus.replace(c, "").replace(/^[\s;·]+|[\s;·]+$/g, "").replace(/\s*;\s*;\s*/g, "; ")
                      : draft.focus.trim()
                        ? `${draft.focus.trim().replace(/[;.]$/, "")}; ${c}`
                        : c,
                  })
                }
              >
                {on && <Check className="mr-1 inline h-3 w-3" aria-hidden="true" />}
                {c}
              </button>
            );
          })}
        </div>
      </Block>
    </div>
  );
}

/* ── Pieces ─────────────────────────────────────────────────────────────────── */
function Block({
  id,
  icon: Icon,
  title,
  hint,
  actions,
  children,
  pasteKey,
}: {
  id: string;
  icon: typeof Globe2;
  title: string;
  hint?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  pasteKey?: string;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-16 flex flex-col gap-3" data-paste-target={pasteKey}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 id={`${id}-h`} className="text-sm font-semibold leading-tight">
              {title}
            </h3>
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

export function Field({
  label,
  htmlFor,
  error,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      {children}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function MacroEditor({ uid, draft, setDraft, errors }: { uid: string; draft: PlanDraft; setDraft: SetDraft; errors: DraftErrors }) {
  const { t: tr } = gpI18n.useT();
  const set = (key: string, p: Partial<PlanDraft["macro"][number]>) =>
    setDraft((d) => ({ ...d, macro: d.macro.map((m) => (m.key === key ? { ...m, ...p } : m)) }));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{tr("editor.macroTitle")}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2.5"
          disabled={draft.macro.length >= 30}
          onClick={() => setDraft((d) => ({ ...d, macro: [...d.macro, { key: newKey(), time: "08:30", title: "", impact: "high" }] }))}
        >
          <Plus aria-hidden="true" />
          {tr("editor.addEvent")}
        </Button>
      </div>
      {draft.macro.map((m) => (
        <div key={m.key} className="grid grid-cols-[84px_minmax(0,1fr)_130px_32px] items-start gap-2">
          <div>
            <Input
              aria-label={tr("editor.eventTime")}
              placeholder="08:30"
              inputMode="numeric"
              value={m.time}
              onChange={(e) => set(m.key, { time: e.target.value })}
              aria-invalid={!!errors[`macro.${m.key}.time`]}
              className="tabular-nums"
            />
            {errors[`macro.${m.key}.time`] && <p className="mt-1 text-xs text-destructive">{errors[`macro.${m.key}.time`]}</p>}
          </div>
          <div>
            <Input
              aria-label={tr("editor.event")}
              placeholder="CPI m/m"
              maxLength={200}
              value={m.title}
              onChange={(e) => set(m.key, { title: e.target.value })}
              aria-invalid={!!errors[`macro.${m.key}.title`]}
            />
            {errors[`macro.${m.key}.title`] && <p className="mt-1 text-xs text-destructive">{errors[`macro.${m.key}.title`]}</p>}
          </div>
          <Select value={m.impact} onValueChange={(v) => set(m.key, { impact: v as Impact })}>
            <SelectTrigger aria-label={tr("editor.impact")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(IMPACT) as Impact[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {IMPACT[k].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-8"
            aria-label={tr("editor.removeEvent")}
            onClick={() => setDraft((d) => ({ ...d, macro: d.macro.filter((x) => x.key !== m.key) }))}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      ))}
      <span id={`${uid}-macro-end`} className="sr-only" />
    </div>
  );
}

function TickerEditor({
  uid,
  t,
  idx,
  mode,
  date,
  errors,
  open,
  onToggle,
  patch,
  setMedia,
  onRemove,
}: {
  uid: string;
  t: TickerDraft;
  idx: number;
  mode: MediaContext;
  date: string;
  errors: DraftErrors;
  open: boolean;
  onToggle: () => void;
  patch: (p: Partial<TickerDraft>) => void;
  setMedia: (fn: (prev: MediaRef[]) => MediaRef[]) => void;
  onRemove: () => void;
}) {
  const { t: tr } = gpI18n.useT();
  const id = (k: string) => `${uid}-t-${t.key}${k ? `-${k}` : ""}`;
  const e = (k: string) => errors[`inPlay.${t.key}.${k}`];
  const label = t.ticker.trim().toUpperCase() || tr("editor.tickerN", { n: idx + 1 });
  const summary = useMemo(() => {
    const parts: string[] = [];
    if (t.catalyst.trim()) parts.push(t.catalyst.trim());
    const sup = parseLevels(t.support).filter(Number.isFinite);
    const res = parseLevels(t.resistance).filter(Number.isFinite);
    if (sup.length || res.length) parts.push(`S ${sup.map((v) => fmtPrice(v)).join("/") || "—"} · R ${res.map((v) => fmtPrice(v)).join("/") || "—"}`);
    if (t.scenarioA.trim()) parts.push(tr("editor.scenarioA"));
    if (t.scenarioB.trim()) parts.push("B");
    if (t.media.length) parts.push(tr("editor.shots", { count: t.media.length }));
    if (t.tvLink) parts.push("TradingView");
    return parts.join(" · ");
  }, [t, tr]);
  const hasError = Object.keys(errors).some((k) => k.startsWith(`inPlay.${t.key}.`));

  return (
    <article
      data-paste-target={t.key}
      aria-label={label}
      className={cn("rounded-xl border bg-[var(--glass-bg)]", hasError ? "border-destructive/50" : "border-[var(--field-border)]")}
    >
      <div className="flex flex-wrap items-center gap-2 p-2.5">
        <Input
          id={id("")}
          aria-label={tr("editor.ticker")}
          className="h-9 w-24 font-semibold uppercase"
          autoCapitalize="characters"
          placeholder="NVDA"
          maxLength={12}
          value={t.ticker}
          aria-invalid={!!e("ticker")}
          onChange={(ev) => patch({ ticker: ev.target.value.toUpperCase() })}
        />
        <Segmented<TickerBias>
          ariaLabel={tr("editor.direction", { label })}
          size="sm"
          value={t.bias}
          onChange={(v) => patch({ bias: v })}
          options={(Object.keys(TICKER_BIAS) as TickerBias[]).map((k) => ({ value: k, label: k === "neutral" ? tr("labels.tickerBias.neutralShort") : TICKER_BIAS[k].label }))}
        />
        <Select value={t.grade} onValueChange={(v) => patch({ grade: v as TickerDraft["grade"] })}>
          <SelectTrigger aria-label={tr("editor.grade", { label })} className="h-9 min-w-[92px] w-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{tr("editor.noGrade")}</SelectItem>
            <SelectItem value="A+">A+</SelectItem>
            <SelectItem value="A">A</SelectItem>
            <SelectItem value="B">B</SelectItem>
          </SelectContent>
        </Select>
        <Select value={t.horizon} onValueChange={(v) => patch({ horizon: v as Horizon })}>
          <SelectTrigger aria-label={tr("editor.horizon", { label })} className="h-9 min-w-[124px] w-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(HORIZON) as Horizon[]).map((k) => (
              <SelectItem key={k} value={k}>
                {HORIZON[k].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={tr("editor.remove", { label })} title={tr("editor.remove", { label })} onClick={onRemove}>
            <Trash2 aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-expanded={open}
            aria-controls={id("body")}
            aria-label={open ? tr("editor.collapse", { label }) : tr("editor.expand", { label })}
            onClick={onToggle}
          >
            <ChevronDown className={cn("transition-transform", !open && "-rotate-90")} aria-hidden="true" />
          </Button>
        </div>
        {e("ticker") && <p className="basis-full text-xs text-destructive">{e("ticker")}</p>}
        {!open && (
          <button type="button" onClick={onToggle} className="basis-full truncate text-left text-xs text-muted-foreground hover:text-foreground">
            {summary || tr("editor.emptyCard")}
          </button>
        )}
      </div>

      {open && (
        <div id={id("body")} className="flex flex-col gap-3 border-t border-[var(--field-border)] p-3">
          <Field label={tr("editor.catalyst")} htmlFor={id("c")}>
            <Input id={id("c")} maxLength={500} placeholder={tr("editor.catalystPlaceholder")} value={t.catalyst} onChange={(ev) => patch({ catalyst: ev.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr("editor.support")} htmlFor={id("s")} error={e("support")}>
              <Input id={id("s")} inputMode="decimal" placeholder="121.5 119" value={t.support} onChange={(ev) => patch({ support: ev.target.value })} className="tabular-nums" />
            </Field>
            <Field label={tr("editor.resistance")} htmlFor={id("r")} error={e("resistance")}>
              <Input id={id("r")} inputMode="decimal" placeholder="125 127.8" value={t.resistance} onChange={(ev) => patch({ resistance: ev.target.value })} className="tabular-nums" />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr("editor.scenarioALabel")} htmlFor={id("a")}>
              <Textarea id={id("a")} rows={2} maxLength={1500} placeholder={tr("editor.scenarioAPlaceholder")} value={t.scenarioA} onChange={(ev) => patch({ scenarioA: ev.target.value })} />
            </Field>
            <Field label={tr("editor.scenarioBLabel")} htmlFor={id("b")}>
              <Textarea id={id("b")} rows={2} maxLength={1500} placeholder={tr("editor.scenarioBPlaceholder")} value={t.scenarioB} onChange={(ev) => patch({ scenarioB: ev.target.value })} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr("editor.trigger")} htmlFor={id("tr")}>
              <Input id={id("tr")} maxLength={1000} placeholder={tr("editor.triggerPlaceholder")} value={t.trigger} onChange={(ev) => patch({ trigger: ev.target.value })} />
            </Field>
            <Field label={tr("editor.invalidation")} htmlFor={id("iv")}>
              <Input id={id("iv")} maxLength={1000} placeholder={tr("editor.invalidationPlaceholder")} value={t.invalidation} onChange={(ev) => patch({ invalidation: ev.target.value })} />
            </Field>
          </div>
          <Field label={tr("editor.tickerRisk")} htmlFor={id("k")}>
            <Input id={id("k")} maxLength={1000} placeholder={tr("editor.tickerRiskPlaceholder")} value={t.risk_note} onChange={(ev) => patch({ risk_note: ev.target.value })} />
          </Field>
          {t.plan.trim() && (
            <Field label={tr("editor.notes")} htmlFor={id("p")}>
              <Textarea id={id("p")} rows={2} maxLength={3000} value={t.plan} onChange={(ev) => patch({ plan: ev.target.value })} />
            </Field>
          )}
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">{t.ticker ? tr("editor.chartMediaOf", { ticker: t.ticker.toUpperCase() }) : tr("editor.chartMedia")}</span>
            <TvLinkField
              links={t.tvLink ? [t.tvLink] : []}
              max={1}
              onChange={(l) => patch({ tvLink: l[0] ?? "" })}
              label={tr("editor.tickerTvLink", { label })}
            />
            <MediaStrip
              refs={t.media}
              onChange={setMedia}
              context={mode}
              date={date}
              max={MAX_TICKER_MEDIA}
              pasteKey={t.key}
              label={label}
              onAddTvLinks={(urls) => patch({ tvLink: urls[0] ?? t.tvLink })}
            />
          </div>
        </div>
      )}
    </article>
  );
}

/* ── Watchlist picker ───────────────────────────────────────────────────────── */
type WatchItem = {
  id: number;
  ticker: string;
  catalyst: string | null;
  targetPrice: string | null;
  stopPrice: string | null;
  status: string;
  notes: string | null;
  inPlay?: boolean | null;
};

function fromWatch(w: WatchItem): TickerSuggestion {
  const tp = w.targetPrice ? Number(w.targetPrice) : NaN;
  const sp = w.stopPrice ? Number(w.stopPrice) : NaN;
  return {
    ticker: w.ticker.toUpperCase(),
    catalyst: w.catalyst ?? "",
    support: Number.isFinite(sp) ? String(sp) : "",
    resistance: Number.isFinite(tp) ? String(tp) : "",
    bias: Number.isFinite(tp) && Number.isFinite(sp) ? (tp > sp ? "bull" : "bear") : "neutral",
    plan: (w.notes ?? "").slice(0, 3000),
  };
}

function WatchlistPicker({ taken, onPick }: { taken: string[]; onPick: (list: TickerSuggestion[]) => void }) {
  const { t: tr } = gpI18n.useT();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["game-plan", "watchlist-picker"],
    queryFn: ({ signal }) => http.get<WatchItem[]>("/api/watchlist", { signal }),
    enabled: open,
    staleTime: STALE.short,
  });
  const { hot, watching } = useMemo(() => {
    const rows = Array.isArray(q.data) ? q.data : [];
    const isHot = (w: WatchItem) => w.inPlay === true && w.status === "watching";
    return { hot: rows.filter(isHot), watching: rows.filter((w) => w.status === "watching" && !isHot(w)) };
  }, [q.data]);
  const freshHot = hot.filter((w) => !taken.includes(w.ticker.toUpperCase()));

  const item = (w: WatchItem) => {
    const added = taken.includes(w.ticker.toUpperCase());
    return (
      <CommandItem
        key={w.id}
        value={`${w.ticker} ${w.catalyst ?? ""} ${w.id}`}
        disabled={added}
        onSelect={() => {
          onPick([fromWatch(w)]);
          setOpen(false);
        }}
        className="flex items-start gap-2"
      >
        <span className="w-14 shrink-0 font-semibold">{w.ticker}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{w.catalyst ?? "—"}</span>
        {added && <Check className="h-4 w-4 shrink-0 text-primary" aria-label={tr("editor.inPlan")} />}
      </CommandItem>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Eye aria-hidden="true" />
          {tr("editor.fromWatchlist")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <Command>
          <CommandInput placeholder={tr("editor.tickerSearch")} />
          <CommandList>
            {q.isLoading ? (
              <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {commonI18n.t("states.loading")}
              </div>
            ) : q.isError ? (
              <div className="p-3 text-sm text-muted-foreground">{tr("editor.watchlistUnavailable")}</div>
            ) : (
              <>
                <CommandEmpty>{tr("editor.noTickers")}</CommandEmpty>
                {hot.length > 0 && (
                  <CommandGroup heading={tr("editor.hotOnWatchlist")}>
                    {freshHot.length > 1 && (
                      <CommandItem
                        value="__all_in_play__"
                        onSelect={() => {
                          onPick(freshHot.map(fromWatch));
                          setOpen(false);
                        }}
                        className="font-medium text-primary"
                      >
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        {tr("editor.addAll", { count: freshHot.length })}
                      </CommandItem>
                    )}
                    {hot.map(item)}
                  </CommandGroup>
                )}
                {watching.length > 0 && <CommandGroup heading={tr("editor.watchlist")}>{watching.map(item)}</CommandGroup>}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
