import { useState, useEffect, useCallback, useId, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { VoiceRecorder } from "@/components/voice-recorder";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/auth-context";
import { TickerFundamentalsBar } from "@/components/ticker-fundamentals-bar";
import { TagSelector } from "@/components/tag-selector";
import { ScreenshotFields } from "@/components/screenshot-fields";
import { Pill, Segmented } from "@/components/ds";
import type { TickerFundamentals } from "@/lib/market-intel";
import { suggestTagsFromFundamentals } from "@/lib/tags";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { cn } from "@/lib/utils";
import { LevelsBar } from "@/components/ideas/LevelsBar";
import { levelPlan, rrTone, QUALITY_TONE, HORIZONS, horizonOf, setHorizonInTags, type Horizon } from "@/components/ideas/model";
import { fmtNum, fmtPrice } from "@/lib/format";
import { ideasI18n } from "@/i18n/ns/ideas";
import { commonI18n } from "@/i18n/ns/common";
import { AlertTriangle, BookOpen, Sparkles, User } from "lucide-react";
import { personName } from "@/i18n";

const SETUP_QUALITIES = ["A+", "A", "B+", "B", "C", "D"] as const;

const QUALITY_ACTIVE: Record<string, string> = {
  up: "aria-pressed:bg-up/20 aria-pressed:text-up",
  accent: "aria-pressed:bg-primary/20 aria-pressed:text-primary",
  warn: "aria-pressed:bg-[hsl(var(--chart-3)/0.2)] aria-pressed:text-[hsl(var(--chart-3))]",
  down: "aria-pressed:bg-down/20 aria-pressed:text-down",
};

/** One-tap thesis scaffolding — keeps ideas structured and comparable (written in the UI language). */
const THESIS_PROMPTS = ["catalyst", "trigger", "invalidation", "management"] as const;

export type TradeIdeaFormData = {
  ticker: string;
  side: string;
  setup: string;
  entryZone: string;
  target: string;
  stop: string;
  thesis: string;
  score: string;
  screenshotUrls: string[];
  tags: string;
  trader: string;
  playbookId: number | null;
  watchlistId: number | null;
  riskAmount: string;
  setupQuality: string;
  marketCap?: string | null;
  float?: string | null;
  adv?: string | null;
  atr?: number | null;
  relativeVolume?: number | null;
  beta?: number | null;
  shortInterest?: number | null;
  sector?: string | null;
  longName?: string | null;
  /** Dedicated columns: horizon and the last trading day the idea is valid (YYYY-MM-DD, NY). */
  horizon?: Horizon | null;
  validUntil?: string;
};

export const blankIdea = (): TradeIdeaFormData => ({
  ticker: "", side: "Long", setup: "", entryZone: "", target: "", stop: "",
  thesis: "", score: "", screenshotUrls: [""], tags: "", trader: "",
  playbookId: null, watchlistId: null, riskAmount: "", setupQuality: "",
  horizon: null, validUntil: "",
});

type Props = {
  initial?: Partial<TradeIdeaFormData>;
  onSubmit: (data: TradeIdeaFormData) => void;
  onCancel: () => void;
  submitting?: boolean;
  submitLabel?: string;
  /** Optional: when provided, the primary button becomes "Опубликовать" and `onSubmit` is the secondary "save draft". */
  onSubmitAndPublish?: (data: TradeIdeaFormData) => void;
  publishLabel?: string;
};

type PlaybookName = { id: number; name: string | null };

export function TradeIdeaForm({ initial, onSubmit, onCancel, submitting, submitLabel, onSubmitAndPublish, publishLabel }: Props) {
  const { user } = useAuth();
  const { t } = ideasI18n.useT();
  const { t: tc } = commonI18n.useT();
  const autoTrader = user?.traderName ?? "";
  // Keep the original author when editing an existing idea (curator edits must not re-assign authorship).
  const [form, setForm] = useState<TradeIdeaFormData>({
    ...blankIdea(),
    ...initial,
    trader: initial?.trader || autoTrader,
  });
  const [autoSuggested, setAutoSuggested] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const uid = useId();
  const fid = (name: string) => `${uid}-${name}`;
  const thesisRef = useRef<HTMLTextAreaElement>(null);

  // Callers often pass a fresh `initial` object every render; only reset when its content actually changes.
  const initialKey = useMemo(() => JSON.stringify(initial ?? null), [initial]);
  const lastInitialKey = useRef(initialKey);
  useEffect(() => {
    if (lastInitialKey.current === initialKey) return;
    lastInitialKey.current = initialKey;
    if (initial) setForm((f) => ({ ...f, ...initial, trader: initial.trader || autoTrader }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);

  const { data: playbook = [] } = useQuery<PlaybookName[]>({
    queryKey: ["trade-idea-form", "playbook-names"],
    queryFn: async ({ signal }) => {
      const rows = await http.get<PlaybookName[]>("/api/playbook", { signal }).catch(() => []);
      return Array.isArray(rows) ? rows.map((p) => ({ id: p.id, name: p.name })) : [];
    },
    staleTime: STALE.long,
  });
  const linkedPlaybook = form.playbookId ? playbook.find((p) => p.id === form.playbookId) : undefined;

  const plan = levelPlan(form.side, form.entryZone, form.stop, form.target);
  // Column first, legacy tag as fallback (older ideas were edited before the column existed).
  const horizon: Horizon | null = form.horizon ?? horizonOf(form.tags);
  const scoreNum = form.score === "" ? null : Number(form.score);
  const riskNum = form.riskAmount === "" ? null : Number(form.riskAmount);
  const shares = riskNum && plan.riskPerShare ? Math.floor(riskNum / plan.riskPerShare) : null;
  const errors: Partial<Record<"ticker" | "score" | "riskAmount", string>> = {};
  if (!form.ticker.trim()) errors.ticker = t("form.tickerRequired");
  else if (!/^[A-Z0-9^/][A-Z0-9.\-=!/^]{0,14}$/.test(form.ticker.trim())) errors.ticker = t("form.tickerFormat");
  if (scoreNum != null && (!Number.isFinite(scoreNum) || scoreNum < 0 || scoreNum > 100)) errors.score = t("form.scoreRange");
  if (riskNum != null && (!Number.isFinite(riskNum) || riskNum < 0)) errors.riskAmount = t("form.riskNegative");
  const hasErrors = Object.keys(errors).length > 0;

  function submitWith(handler: ((d: TradeIdeaFormData) => void) | undefined) {
    setTouched(true);
    if (!handler || hasErrors || submitting) return;
    handler({ ...form, ticker: form.ticker.trim(), horizon });
  }
  const primary = onSubmitAndPublish ?? onSubmit;

  function set<K extends keyof TradeIdeaFormData>(k: K, v: TradeIdeaFormData[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function onSetupChange(v: string) {
    setForm((f) => {
      const match = playbook.find((p) => p.name && p.name.toLowerCase() === v.trim().toLowerCase());
      return { ...f, setup: v, playbookId: match ? match.id : f.playbookId };
    });
  }

  function addThesisPrompt(label: string) {
    setForm((f) => {
      const line = `${label}: `;
      const thesis = f.thesis ? (f.thesis.endsWith("\n") ? f.thesis : `${f.thesis}\n`) + line : line;
      return { ...f, thesis };
    });
    requestAnimationFrame(() => {
      const el = thesisRef.current;
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
  }

  const selectedTags = form.tags ? form.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
  const setTags = (tags: string[]) => set("tags", tags.join(", "));

  const handleFundamentalsLoaded = useCallback((d: TickerFundamentals) => {
    const suggestions = suggestTagsFromFundamentals(d);
    setAutoSuggested(suggestions);
    setForm((f) => {
      const existing = f.tags ? f.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
      const merged = Array.from(new Set([...existing, ...suggestions]));
      return {
        ...f,
        tags: merged.join(", "),
        marketCap: d.marketCap ?? null,
        float: d.float ?? null,
        adv: d.averageDailyVolume ?? null,
        atr: d.atr ?? null,
        relativeVolume: d.relativeVolume ?? null,
        beta: d.beta ?? null,
        shortInterest: d.shortInterest ?? null,
        sector: d.sector ?? null,
        longName: d.longName ?? null,
      };
    });
  }, []);

  const labelCls = "text-xs font-medium text-muted-foreground";
  const errCls = "text-2xs text-down";

  return (
    <form
      className="flex flex-col gap-4 font-sans text-sm"
      noValidate
      onSubmit={(e) => { e.preventDefault(); submitWith(primary); }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitWith(primary); }
      }}
    >
      {autoTrader && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <User className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t("form.author")} <span className="font-medium text-foreground">{personName(form.trader || autoTrader)}</span>
        </div>
      )}

      {/* Ticker + direction */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[140px] flex-1 space-y-1.5">
          <Label htmlFor={fid("ticker")} className={labelCls}>{t("form.ticker")}</Label>
          <Input
            id={fid("ticker")}
            autoFocus={!initial?.ticker}
            autoComplete="off"
            className="h-11 text-lg font-semibold uppercase tracking-tight"
            value={form.ticker}
            onChange={(e) => set("ticker", e.target.value.toUpperCase().replace(/\s+/g, ""))}
            placeholder="AAPL"
            aria-invalid={touched && !!errors.ticker}
            aria-describedby={touched && errors.ticker ? fid("ticker-err") : undefined}
          />
          {touched && errors.ticker && <p id={fid("ticker-err")} className={errCls}>{errors.ticker}</p>}
        </div>
        <div className="space-y-1.5">
          <span className={labelCls} id={fid("side-label")}>{t("form.direction")}</span>
          <Segmented
            ariaLabel={t("form.direction")}
            value={form.side === "Short" ? "Short" : "Long"}
            onChange={(v) => set("side", v)}
            options={[{ value: "Long", label: tc("trading.long") }, { value: "Short", label: tc("trading.short") }]}
          />
        </div>
        <div className="space-y-1.5">
          <span className={labelCls}>{t("form.horizon")}</span>
          <Segmented<Horizon | "none">
            ariaLabel={t("form.horizonAria")}
            value={horizon ?? "none"}
            onChange={(v) => {
              const h = v === "none" ? null : v;
              setForm((f) => ({ ...f, horizon: h, tags: setHorizonInTags(f.tags, h) }));
            }}
            options={[{ value: "none", label: "—" }, ...HORIZONS.map((h) => ({ value: h.key as Horizon | "none", label: h.label }))]}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={fid("valid")} className={labelCls}>{t("form.validUntil")}</Label>
          <Input
            id={fid("valid")}
            type="date"
            className="h-9 w-[150px] tabular-nums"
            value={form.validUntil ?? ""}
            onChange={(e) => set("validUntil", e.target.value)}
            aria-describedby={fid("valid-hint")}
          />
          <p id={fid("valid-hint")} className="text-2xs text-muted-foreground">{t(`form.validHint.${horizon ?? "intraday"}`)}</p>
        </div>
      </div>

      <TickerFundamentalsBar ticker={form.ticker} onLoaded={handleFundamentalsLoaded} />

      {/* Levels with live R:R */}
      <fieldset className="glass-panel space-y-3 rounded-2xl p-4">
        <legend className="sr-only">{t("form.levels")}</legend>
        <div className="flex items-center justify-between gap-2">
          <span className="micro-label">{t("form.levels")}</span>
          {plan.rr != null
            ? <Pill tone={rrTone(plan.rr)}>R:R {fmtNum(plan.rr, 2)}{plan.rrFinal != null && plan.targets.length > 1 ? ` → ${fmtNum(plan.rrFinal, 1)}` : ""}</Pill>
            : <span className="text-2xs text-muted-foreground">{t("form.rrAuto")}</span>}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor={fid("entry")} className={labelCls}>{t("form.entryZone")}</Label>
            <Input id={fid("entry")} inputMode="decimal" className="tabular-nums" value={form.entryZone} onChange={(e) => set("entryZone", e.target.value)} placeholder="180.5–181.2" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={fid("target")} className={cn(labelCls, "text-up")}>{t("form.targets")}</Label>
            <Input id={fid("target")} inputMode="decimal" className="tabular-nums" value={form.target} onChange={(e) => set("target", e.target.value)} placeholder="185 / 187" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={fid("stop")} className={cn(labelCls, "text-down")}>{tc("trading.stop")}</Label>
            <Input id={fid("stop")} inputMode="decimal" className="tabular-nums" value={form.stop} onChange={(e) => set("stop", e.target.value)} placeholder="178" />
          </div>
        </div>
        {(plan.riskPerShare != null || plan.rewardPerShare != null) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground">
            {plan.riskPerShare != null && <span>{t("form.riskShare")} <span className="font-medium text-down">${fmtPrice(plan.riskPerShare)}</span></span>}
            {plan.rewardPerShare != null && <span>{t("form.rewardShare")} <span className="font-medium text-up">${fmtPrice(plan.rewardPerShare)}</span></span>}
            {plan.riskPerShare != null && plan.entry != null && <span>{t("form.stopPct", { pct: fmtNum((plan.riskPerShare / plan.entry) * 100, 1) })}</span>}
          </div>
        )}
        <LevelsBar plan={plan} size="lg" />
        {plan.issues.length > 0 && (
          <ul className="space-y-1" aria-live="polite">
            {plan.issues.map((s) => (
              <li key={s} className="flex items-center gap-1.5 text-xs text-[hsl(var(--chart-3))]">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{s}
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      {/* Risk + score */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={fid("risk")} className={labelCls}>{t("form.risk")}</Label>
          <Input id={fid("risk")} type="number" inputMode="decimal" min={0} step={1} className="tabular-nums" value={form.riskAmount} onChange={(e) => set("riskAmount", e.target.value)} placeholder="250"
            aria-invalid={!!errors.riskAmount} aria-describedby={errors.riskAmount ? fid("risk-err") : shares != null ? fid("risk-hint") : undefined} />
          {errors.riskAmount
            ? <p id={fid("risk-err")} className={errCls}>{errors.riskAmount}</p>
            : shares != null && <p id={fid("risk-hint")} className="text-2xs tabular-nums text-muted-foreground">{t("form.sharesByStop", { count: shares })}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={fid("score")} className={labelCls}>{t("form.score")}</Label>
          <Input id={fid("score")} type="number" inputMode="numeric" min={0} max={100} className="tabular-nums" value={form.score} onChange={(e) => set("score", e.target.value)} placeholder="75"
            aria-invalid={!!errors.score} aria-describedby={errors.score ? fid("score-err") : undefined} />
          {errors.score && <p id={fid("score-err")} className={errCls}>{errors.score}</p>}
        </div>
      </div>

      {/* Setup + quality */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={fid("setup")} className={labelCls}>{tc("trading.setup")}</Label>
          <Input id={fid("setup")} list={fid("setup-list")} value={form.setup} onChange={(e) => onSetupChange(e.target.value)} placeholder="ORB, Bull Flag, Reclaim…" autoComplete="off" />
          <datalist id={fid("setup-list")}>
            {playbook.filter((p) => p.name).slice(0, 200).map((p) => <option key={p.id} value={p.name!} />)}
          </datalist>
          {form.playbookId && (
            <p className="flex items-center gap-1 text-2xs text-muted-foreground">
              <BookOpen className="h-3 w-3" aria-hidden="true" />
              {t("form.linkedPlaybook")} <span className="text-foreground">{linkedPlaybook?.name ?? `#${form.playbookId}`}</span>
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <span className={labelCls} id={fid("quality-label")}>{t("form.quality")}</span>
          <div role="radiogroup" aria-labelledby={fid("quality-label")} className="flex flex-wrap gap-1.5">
            {SETUP_QUALITIES.map((q) => {
              const active = form.setupQuality === q;
              return (
                <button
                  key={q}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-pressed={active}
                  onClick={() => set("setupQuality", active ? "" : q)}
                  className={cn("chip min-h-8 min-w-10 px-2.5 text-sm font-semibold tabular-nums", QUALITY_ACTIVE[QUALITY_TONE[q] ?? "accent"])}
                >
                  {q}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Thesis */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor={fid("thesis")} className={labelCls}>{t("form.thesis")}</Label>
          <VoiceRecorder onTranscript={(text) => set("thesis", form.thesis ? `${form.thesis}\n${text}` : text)} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {THESIS_PROMPTS.map((p) => (
            <button key={p} type="button" onClick={() => addThesisPrompt(t(`form.thesisPrompts.${p}`))} className="chip min-h-7 px-2.5 text-xs">+ {t(`form.thesisPrompts.${p}`)}</button>
          ))}
        </div>
        <Textarea ref={thesisRef} id={fid("thesis")} className="min-h-[96px]" value={form.thesis} onChange={(e) => set("thesis", e.target.value)} placeholder={t("form.thesisPlaceholder")} />
      </div>

      <div className="space-y-1.5">
        <span className={labelCls}>{tc("fields.screenshots")}</span>
        <ScreenshotFields urls={form.screenshotUrls} onChange={(urls) => set("screenshotUrls", urls)} />
      </div>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={labelCls}>{tc("fields.tags")}</span>
          {autoSuggested.length > 0 && (
            <span className="inline-flex items-center gap-1 text-2xs text-[hsl(var(--chart-3))]">
              <Sparkles className="h-3 w-3" aria-hidden="true" />{t("form.autoTags", { tags: autoSuggested.join(", ") })}
            </span>
          )}
        </div>
        <TagSelector selectedTags={selectedTags} onChange={setTags} />
      </div>

      {form.watchlistId && (
        <p className="text-2xs text-muted-foreground">{t("form.source", { id: form.watchlistId })}</p>
      )}

      <div className="sticky bottom-0 z-sticky -mx-1 flex flex-wrap items-center gap-2 border-t border-[var(--field-border)] bg-popover px-1 pb-1 pt-3">
        <span className="mr-auto hidden text-2xs text-muted-foreground sm:inline">
          {onSubmitAndPublish
            ? publishLabel ? t("form.shortcutCustom", { action: publishLabel.toLowerCase() }) : t("form.shortcutPublish")
            : t("form.shortcutSave")}
        </span>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>{tc("actions.cancel")}</Button>
        {onSubmitAndPublish && (
          <Button type="button" variant="secondary" onClick={() => submitWith(onSubmit)} disabled={!form.ticker.trim() || !!errors.score || !!errors.riskAmount || submitting}>
            {submitLabel ?? t("form.saveDraft")}
          </Button>
        )}
        <Button type="submit" disabled={!form.ticker.trim() || !!errors.score || !!errors.riskAmount || submitting}>
          {submitting ? t("saving") : onSubmitAndPublish ? (publishLabel ?? t("sheet.publish")) : (submitLabel ?? t("form.saveIdea"))}
        </Button>
      </div>
    </form>
  );
}
