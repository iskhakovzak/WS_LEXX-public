import { useEffect, useState, useCallback, useMemo } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Pill, EmptyState, type Tone } from "@/components/ds";
import { http, ApiError } from "@/lib/api/http";
import { humanizeApiError, nullIfMissing } from "@/lib/api/errors";
import { cn } from "@/lib/utils";
import { fmtDate, fmtUsd } from "@/lib/format";
import { tradesI18n } from "@/i18n/ns/trades";
import { commonI18n } from "@/i18n/ns/common";
import {
  Sparkles, ThumbsUp, AlertTriangle, Target, Clock, ChevronDown, Copy, Check, RefreshCw, Brain, Loader2,
  type LucideIcon,
} from "lucide-react";

type ReviewSections = Record<string, unknown>;

type Review = {
  reviewId: number;
  tradeId: number;
  model: string;
  reviewText: string;
  sections: ReviewSections | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  generatedAt: string;
};

type UsageInfo = {
  hourlyCount: number;
  hourlyLimit: number;
  dailyCount: number;
  dailyCostUsd: number;
};

type EmotionalState = {
  sleepWell: boolean;
  stressed: boolean;
  tilted: boolean;
  focused: boolean;
  anxious: boolean;
  revenge: boolean;
  freeText: string | null;
};

type Point = { text: string; source?: string };

// Parses model output (it may answer «нет данных»), not UI text. i18n-ignore
const EMPTY_TEXT = /^(null|none|n\/a|нет данных|—|-)?$/i;

/** Accepts a string (possibly bulleted / multi-line) or a string array; returns clean bullet items. */
function toPoints(v: unknown, source?: string): Point[] {
  if (v == null) return [];
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === "string" ? x : x && typeof x === "object" && "text" in x ? String((x as { text: unknown }).text) : ""))
      .map((s) => s.trim())
      .filter((s) => !EMPTY_TEXT.test(s))
      .map((text) => ({ text, source }));
  }
  if (typeof v !== "string") return [];
  const s = v.trim();
  if (EMPTY_TEXT.test(s)) return [];
  const lines = s.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const bulleted = lines.length > 1 && lines.every((l) => /^([-•*]|\d+[.)])\s+/.test(l));
  if (bulleted) return lines.map((l) => ({ text: l.replace(/^([-•*]|\d+[.)])\s+/, ""), source }));
  return [{ text: s, source }];
}

function str(v: unknown): string | null {
  return typeof v === "string" && !EMPTY_TEXT.test(v.trim()) ? v.trim() : null;
}

/** Map the model output (old or new schema) into strengths / mistakes / next time. */
function structure(sections: ReviewSections) {
  const strengths = toPoints(sections.strengths ?? sections.whatWorked ?? sections.positives);
  const mistakes = [
    ...toPoints(sections.mistakes ?? sections.errors),
    ...(sections.mistakes || sections.errors ? [] : [
      ...toPoints(sections.riskErrors, tradesI18n.t("ai.source.risk")),
      ...toPoints(sections.playbookDeviation, tradesI18n.t("ai.source.playbook")),
    ]),
  ];
  const nextTime = sections.nextTime || sections.improvements
    ? toPoints(sections.nextTime ?? sections.improvements)
    : toPoints(sections.alternativeExecution, tradesI18n.t("ai.source.alternative"));
  const timing = toPoints(sections.entryTiming);

  const used = new Set(["summary", "grade", "confidence", "strengths", "whatWorked", "positives", "mistakes", "errors", "riskErrors", "playbookDeviation", "nextTime", "improvements", "alternativeExecution"]);
  if (!strengths.length) used.add("entryTiming");
  const DETAIL_KEYS = ["entryTiming", "statisticalComparison", "psychologyImpact", "playbookDeviation", "riskErrors", "alternativeExecution"] as const;
  const details = DETAIL_KEYS
    .filter((k) => !used.has(k))
    .map((k) => ({ label: tradesI18n.t(`ai.detail.${k}`), text: str(sections[k]) }))
    .filter((d): d is { label: string; text: string } => !!d.text);

  return { strengths, mistakes, nextTime, timing, details };
}

function gradeTone(grade: string | undefined): Tone {
  const g = (grade ?? "").trim().toUpperCase();
  if (g.startsWith("A")) return "up";
  if (g.startsWith("B")) return "accent";
  if (g.startsWith("C")) return "warn";
  if (g) return "down";
  return "neutral";
}

function confidenceTone(pct: number): Tone {
  if (pct >= 75) return "up";
  if (pct >= 50) return "warn";
  return "down";
}

function ConvictionBars({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={tradesI18n.t("ai.conviction", { value })}>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={cn("inline-block h-3 w-1.5 rounded-full", i < value ? "bg-[hsl(var(--chart-3))]" : "bg-muted-foreground/25")}
        />
      ))}
    </span>
  );
}

type EmoKey = "focused" | "sleepWell" | "stressed" | "anxious" | "tilted" | "revenge";
const EMO_FLAGS: { key: EmoKey; positive: boolean }[] = [
  { key: "focused", positive: true },
  { key: "sleepWell", positive: true },
  { key: "stressed", positive: false },
  { key: "anxious", positive: false },
  { key: "tilted", positive: false },
  { key: "revenge", positive: false },
];

function PsychologyStrip({
  conviction, confidenceGrade, emotionalState,
}: { conviction: number | null | undefined; confidenceGrade: string | null | undefined; emotionalState: EmotionalState | null }) {
  const { t } = tradesI18n.useT();
  if (conviction == null && !confidenceGrade && !emotionalState) return null;
  const active = emotionalState ? EMO_FLAGS.filter((f) => emotionalState[f.key] === true) : [];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-[var(--glass-bg)] px-3 py-2">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Brain className="h-3.5 w-3.5" aria-hidden="true" /> {t("ai.psychology")}
      </span>
      {conviction != null && (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t("ai.convictionLabel")} <ConvictionBars value={conviction} />
          <span className="font-semibold tabular-nums text-foreground">{conviction}/5</span>
        </span>
      )}
      {confidenceGrade && (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t("ai.grade")} <Pill tone={gradeTone(confidenceGrade)}>{confidenceGrade}</Pill>
        </span>
      )}
      {active.map((f) => (
        <Pill key={f.key} tone={f.positive ? "up" : "down"}>{t(`ai.emo.${f.key}`)}</Pill>
      ))}
      {emotionalState?.freeText && (
        <span className="max-w-[240px] truncate text-xs italic text-muted-foreground" title={emotionalState.freeText}>
          «{emotionalState.freeText}»
        </span>
      )}
      {!emotionalState && <span className="text-xs text-muted-foreground">{t("ai.noEmotions")}</span>}
    </div>
  );
}

function Column({ title, icon: Icon, tone, points, empty }: { title: string; icon: LucideIcon; tone: Tone; points: Point[]; empty: string }) {
  const toneCls = tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-[hsl(var(--chart-3))]" : "text-primary";
  const barCls = tone === "up" ? "bg-up" : tone === "down" ? "bg-down" : tone === "warn" ? "bg-[hsl(var(--chart-3))]" : "bg-primary";
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] p-3">
      <div className="flex items-center gap-2">
        <span className={cn("grid h-7 w-7 place-items-center rounded-full bg-current/10", toneCls)}>
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        {points.length > 0 && <span className="ml-auto text-xs tabular-nums text-muted-foreground">{points.length}</span>}
      </div>
      {points.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {points.map((p, i) => (
            <li key={i} className="flex gap-2 text-sm leading-snug text-foreground/90">
              <span className={cn("mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full", barCls)} aria-hidden="true" />
              <span className="min-w-0 whitespace-pre-wrap">
                {p.source && <span className="mb-0.5 block text-2xs text-muted-foreground">{p.source}</span>}
                {p.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function reviewToText(review: Review, s: ReturnType<typeof structure>, summary: string | null, grade?: string): string {
  const t = tradesI18n.t;
  const out: string[] = [grade ? t("ai.copyHeaderGrade", { id: review.tradeId, grade }) : t("ai.copyHeader", { id: review.tradeId })];
  if (summary) out.push("", summary);
  const block = (t: string, pts: Point[]) => { if (pts.length) out.push("", `${t}:`, ...pts.map((p) => `• ${p.source ? `${p.source}: ` : ""}${p.text}`)); };
  block(s.strengths.length ? t("ai.strengths") : t("ai.timing"), s.strengths.length ? s.strengths : s.timing);
  block(t("ai.mistakes"), s.mistakes);
  block(t("ai.nextTime"), s.nextTime);
  for (const d of s.details) out.push("", `${d.label}: ${d.text}`);
  return out.join("\n");
}

export function AiReviewPanel({
  tradeId,
  conviction,
  confidenceGrade,
  tradeDate,
  trader,
  className,
}: {
  tradeId: number;
  conviction?: number | null;
  confidenceGrade?: string | null;
  tradeDate?: string | null;
  trader?: string | null;
  className?: string;
}) {
  const { t } = tradesI18n.useT();
  const { t: tc } = commonI18n.useT();
  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [emotionalState, setEmotionalState] = useState<EmotionalState | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingForce, setPendingForce] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadUsage = useCallback(async () => {
    try {
      // Usage is keyed by the signed-in member on the server (Bearer token from lib/install-fetch-auth).
      setUsage(await http.get<UsageInfo>("/api/ai-review/usage"));
    } catch {
      /* usage is informational */
    }
  }, []);

  const loadEmotionalState = useCallback(async () => {
    if (!trader || !tradeDate) {
      setEmotionalState(null);
      return;
    }
    try {
      const row = await http.get<EmotionalState | null>("/api/emotional-state/by-date", { query: { userId: trader, date: tradeDate.slice(0, 10) } });
      setEmotionalState(row ?? null);
    } catch {
      setEmotionalState(null);
    }
  }, [trader, tradeDate]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    try {
      // 404 = no review yet.
      setReview(await http.get<Review>(`/api/trades/${tradeId}/ai-review`).catch(nullIfMissing));
    } catch (e: unknown) {
      setLoadErr(humanizeApiError(e, tradesI18n.t("ai.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [tradeId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadUsage(); }, [loadUsage]);
  useEffect(() => { loadEmotionalState(); }, [loadEmotionalState]);

  const generate = async (force = false) => {
    setErr(null);
    setGenerating(true);
    try {
      const data = await http.post<Review>(`/api/trades/${tradeId}/ai-review`, { force }, { query: { force: force ? "true" : null } });
      setReview(data);
      loadUsage();
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 429) {
        setErr(tradesI18n.t("ai.rateLimit", { sec: String(e.field("retryAfterSec") ?? 60) }));
        loadUsage();
      } else {
        setErr(humanizeApiError(e));
      }
    } finally {
      setGenerating(false);
    }
  };

  const sections: ReviewSections = useMemo(
    () => (review?.sections && typeof review.sections === "object" ? review.sections : {}),
    [review],
  );
  const grade = str(sections.grade) ?? undefined;
  // Model is asked for 0..1 but sometimes answers in percent (e.g. 85).
  const rawConfidence = typeof sections.confidence === "number" && Number.isFinite(sections.confidence) ? sections.confidence : undefined;
  const confidence = rawConfidence == null ? undefined : rawConfidence > 1 ? Math.min(rawConfidence, 100) / 100 : rawConfidence;
  const confidencePct = confidence != null ? Math.round(confidence * 100) : null;
  const summary = str(sections.summary);
  const s = useMemo(() => structure(sections), [sections]);
  const hasStructured = s.strengths.length + s.mistakes.length + s.nextTime.length + s.timing.length > 0;

  const nearLimit = usage != null && usage.hourlyCount >= Math.max(1, usage.hourlyLimit - 5);
  const atLimit = usage != null && usage.hourlyCount >= usage.hourlyLimit;
  const dailyCostFormatted = usage ? fmtUsd(Number(usage.dailyCostUsd ?? 0), { decimals: 4 }) : "—";

  async function copyReview() {
    if (!review) return;
    try {
      await navigator.clipboard.writeText(hasStructured ? reviewToText(review, s, summary, grade) : review.reviewText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  }

  const busy = generating || loading;

  return (
    <>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingForce ? t("ai.confirmRefresh") : t("ai.confirmRun")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 pt-1 text-sm text-muted-foreground">
                <p>{t("ai.costNote")}</p>
                {usage && (
                  <p className="tabular-nums">
                    <span className="text-foreground">{t("ai.todayCost", { cost: dailyCostFormatted })}</span>
                    {" · "}<span className={nearLimit ? "font-semibold text-[hsl(var(--chart-3))]" : "text-foreground"}>{t("ai.perHour", { used: usage.hourlyCount, limit: usage.hourlyLimit })}</span>
                  </p>
                )}
                {pendingForce && (
                  <p className="text-[hsl(var(--chart-3))]">{t("ai.willReplace")}</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmOpen(false); generate(pendingForce); }}>{t("ai.run")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <section className={cn("glass-panel space-y-4 rounded-2xl p-4", className)} data-testid="ai-review-panel" aria-label={t("ai.title")}>
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-primary/15 text-primary">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            </span>
            <h3 className="text-sm font-semibold text-foreground">{t("ai.title")}</h3>
            {grade && <Pill tone={gradeTone(grade)}>{t("ai.gradePill", { grade })}</Pill>}
            {confidencePct != null && (
              <Pill tone={confidenceTone(confidencePct)} dot>{t("ai.confidencePill", { pct: confidencePct })}</Pill>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {review && (
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={copyReview} aria-label={t("ai.copy")} title={t("ai.copy")}>
                {copied ? <Check className="text-up" aria-hidden="true" /> : <Copy aria-hidden="true" />}
              </Button>
            )}
            <Button
              type="button"
              variant={review ? "outline" : "default"}
              size="sm"
              onClick={() => { setPendingForce(!!review); setConfirmOpen(true); }}
              disabled={busy || atLimit}
              data-testid="button-ai-review"
            >
              {generating ? <Loader2 className="animate-spin" aria-hidden="true" /> : review ? <RefreshCw aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
              {generating ? t("ai.analyzing") : review ? t("ai.refresh") : t("ai.runReview")}
            </Button>
          </div>
        </div>

        <PsychologyStrip conviction={conviction} confidenceGrade={confidenceGrade} emotionalState={emotionalState} />

        {err && <div role="alert" className="rounded-xl bg-down/10 px-3 py-2 text-xs text-down">{err}</div>}
        {loadErr && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl bg-down/10 px-3 py-2 text-xs text-down">
            {loadErr}
            <button type="button" onClick={() => load()} className="font-medium text-primary hover:underline">{tc("actions.retry")}</button>
          </div>
        )}

        {(loading || generating) && !review && (
          <div className="space-y-3" aria-busy="true" aria-label={generating ? t("ai.generatingAria") : t("ai.loadingAria")}>
            <Skeleton className="h-4 w-3/4" />
            <div className="grid gap-3 md:grid-cols-3">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
            </div>
          </div>
        )}

        {!loading && !loadErr && !review && !generating && (
          <EmptyState
            icon={Sparkles}
            className="py-6"
            title={t("ai.emptyTitle")}
            description={t("ai.emptyDesc")}
          />
        )}

        {review && (
          <div className={cn("space-y-3", generating && "opacity-60")}>
            {summary && (
              <p className="border-l-2 border-primary/60 pl-3 text-sm leading-relaxed text-foreground">{summary}</p>
            )}

            {hasStructured ? (
              <div className="grid gap-3 md:grid-cols-3">
                {s.strengths.length > 0 ? (
                  <Column title={t("ai.strengths")} icon={ThumbsUp} tone="up" points={s.strengths} empty="—" />
                ) : (
                  <Column title={t("ai.timing")} icon={Clock} tone="accent" points={s.timing} empty={t("ai.noTiming")} />
                )}
                <Column title={t("ai.mistakes")} icon={AlertTriangle} tone="down" points={s.mistakes} empty={t("ai.noMistakes")} />
                <Column title={t("ai.nextTime")} icon={Target} tone="warn" points={s.nextTime} empty={t("ai.noRecommendations")} />
              </div>
            ) : (
              !summary && <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{review.reviewText}</p>
            )}

            {s.details.length > 0 && (
              <div className="rounded-xl border border-[var(--glass-border)]">
                <button
                  type="button"
                  onClick={() => setDetailsOpen((v) => !v)}
                  aria-expanded={detailsOpen}
                  className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium text-foreground hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t("ai.details")}
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {s.details.length}
                    <ChevronDown className={cn("h-4 w-4 transition-transform duration-200", detailsOpen && "rotate-180")} aria-hidden="true" />
                  </span>
                </button>
                {detailsOpen && (
                  <div className="space-y-3 border-t border-[var(--glass-border)] px-3 py-3">
                    {s.details.map((d) => (
                      <div key={d.label}>
                        <div className="micro-label">{d.label}</div>
                        <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{d.text}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--glass-border)] pt-2 text-2xs tabular-nums text-muted-foreground">
              <span>{review.model} · {fmtDate(review.generatedAt, "dateTime")}</span>
              <span>
                {t("ai.tokens", { input: review.inputTokens ?? "?", output: review.outputTokens ?? "?" })}
                {review.costUsd != null && <> · {fmtUsd(Number(review.costUsd), { decimals: 4 })}</>}
              </span>
            </div>
          </div>
        )}

        {usage != null && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs tabular-nums text-muted-foreground">
            <span className="flex items-center gap-1.5">
              {t("ai.hour")}
              <span className="relative inline-block h-1.5 w-16 overflow-hidden rounded-full bg-muted-foreground/20" aria-hidden="true">
                <span
                  className={cn("absolute inset-y-0 left-0 rounded-full", atLimit ? "bg-down" : nearLimit ? "bg-[hsl(var(--chart-3))]" : "bg-primary")}
                  style={{ width: `${Math.min(100, (usage.hourlyCount / Math.max(1, usage.hourlyLimit)) * 100)}%` }}
                />
              </span>
              <span className={cn(atLimit ? "text-down" : nearLimit && "text-[hsl(var(--chart-3))]")}>{usage.hourlyCount}/{usage.hourlyLimit}</span>
            </span>
            <span>{t("ai.todayUsage", { count: usage.dailyCount, cost: dailyCostFormatted })}</span>
            {atLimit && <span className="text-down">{t("ai.hourLimitReached")}</span>}
          </div>
        )}
      </section>
    </>
  );
}
