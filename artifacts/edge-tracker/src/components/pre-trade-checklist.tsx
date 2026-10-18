import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { AlertTriangle, ShieldCheck, ShieldAlert, Check, X, Minus, RotateCcw, CheckCheck, Keyboard } from "lucide-react";
import { http } from "@/lib/api/http";
import { humanizeApiError } from "@/lib/api/errors";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { Pill, EmptyState } from "@/components/ds";
import { cn } from "@/lib/utils";
import { fmtRate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { checklistI18n } from "@/i18n/ns/checklist";

export type ChecklistTemplateItem = {
  id: number;
  label: string;
  description: string | null;
  required: boolean;
  sortOrder: number;
  active: boolean;
};

export type ChecklistAnswer = "yes" | "no" | "na";
export type ChecklistAnswers = Record<number, ChecklistAnswer>;

export type ChecklistResult = {
  responseId: number;
  passed: boolean;
  /** 0..100 — share of «Да» among applicable items. Optional for backward compatibility. */
  score?: number;
};

type Props = {
  ticker: string;
  tradeDate: string;
  trader?: string;
  initialAnswers?: ChecklistAnswers;
  onConfirm: (result: ChecklistResult) => void;
  onCancel?: () => void;
  submitLabel?: string;
  /**
   * Optional minimal score (0..100) required on top of the required items.
   * Default 0 = only required items gate the trade (previous behaviour).
   */
  minScore?: number;
};

// Labels: checklistI18n `answer.<key>` / `answer.<key>Title`, resolved in render.
const ANSWER_META: Record<ChecklistAnswer, { icon: typeof Check; active: string; row: string }> = {
  yes: { icon: Check, active: "bg-up/20 text-up", row: "border-l-up/70" },
  na: { icon: Minus, active: "bg-[hsl(var(--chart-3)/0.2)] text-[hsl(var(--chart-3))]", row: "border-l-[hsl(var(--chart-3)/0.7)]" },
  no: { icon: X, active: "bg-down/20 text-down", row: "border-l-down/70" },
};
const ANSWER_ORDER: ChecklistAnswer[] = ["yes", "na", "no"];

/** Circular progress (0..1) with centred content. */
function ProgressRing({ value, tone, children, size = 64 }: { value: number; tone: "up" | "down" | "warn" | "accent"; children?: React.ReactNode; size?: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const stroke =
    tone === "up" ? "hsl(var(--up))" : tone === "down" ? "hsl(var(--down))" : tone === "warn" ? "hsl(var(--chart-3))" : "hsl(var(--primary))";
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg viewBox="0 0 64 64" className="absolute inset-0 -rotate-90" style={{ width: size, height: size }} aria-hidden="true">
        <circle cx="32" cy="32" r={r} fill="none" stroke="hsl(var(--border))" strokeWidth="5" />
        <circle
          cx="32" cy="32" r={r} fill="none" stroke={stroke} strokeWidth="5" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, value)))}
          className="transition-[stroke-dashoffset] duration-300 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none"
        />
      </svg>
      <span className="relative text-center leading-none">{children}</span>
    </span>
  );
}

export function PreTradeChecklist({ ticker, tradeDate, trader, initialAnswers, onConfirm, onCancel, submitLabel, minScore = 0 }: Props) {
  const { t } = checklistI18n.useT();
  const { t: tc } = commonI18n.useT();
  const { data: items = [], isLoading, isError, error: loadError, refetch } = useQuery<ChecklistTemplateItem[]>({
    queryKey: ["checklist-template"],
    queryFn: ({ signal }) =>
      http.get<ChecklistTemplateItem[]>("/api/checklist-template", { signal }).then((d) => (Array.isArray(d) ? d : [])),
  });
  const [answers, setAnswers] = useState<ChecklistAnswers>(initialAnswers ?? {});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (initialAnswers) setAnswers(initialAnswers);
  }, [initialAnswers]);

  const sorted = useMemo(() => items.filter((i) => i.active !== false).sort((a, b) => a.sortOrder - b.sortOrder), [items]);
  const required = useMemo(() => sorted.filter((i) => i.required), [sorted]);
  const optional = useMemo(() => sorted.filter((i) => !i.required), [sorted]);
  const ordered = useMemo(() => [...required, ...optional], [required, optional]);

  const stats = useMemo(() => {
    let yes = 0, no = 0, na = 0;
    for (const i of sorted) {
      const a = answers[i.id];
      if (a === "yes") yes++;
      else if (a === "no") no++;
      else if (a === "na") na++;
    }
    const applicable = sorted.length - na;
    const score = applicable > 0 ? Math.round((yes / applicable) * 100) : 0;
    const reqOk = required.filter((i) => answers[i.id] === "yes" || answers[i.id] === "na").length;
    const reqFailed = required.filter((i) => answers[i.id] === "no");
    const reqMissing = required.filter((i) => !answers[i.id]);
    return { yes, no, na, answered: yes + no + na, score, reqOk, reqFailed, reqMissing };
  }, [sorted, required, answers]);

  const allRequiredAnswered = stats.reqOk === required.length;
  const scoreOk = stats.score >= minScore;
  const ready = allRequiredAnswered && scoreOk;
  const tone: "up" | "down" | "warn" | "accent" = ready ? "up" : stats.reqFailed.length > 0 ? "down" : stats.answered > 0 ? "warn" : "accent";

  const setAnswer = useCallback((id: number, a: ChecklistAnswer) => {
    setAnswers((prev) => ({ ...prev, [id]: a }));
  }, []);

  function focusRow(idx: number) {
    const item = ordered[Math.max(0, Math.min(ordered.length - 1, idx))];
    if (item) rowRefs.current.get(item.id)?.focus();
  }

  function onRowKey(e: React.KeyboardEvent<HTMLDivElement>, idx: number, id: number) {
    if (e.target !== e.currentTarget) return; // don't hijack keys on inner buttons
    const k = e.key.toLowerCase();
    // Keys of the RU keyboard layout (н/ф/т sit on Y/A/N) so the shortcuts work without switching layouts.
    const map: Record<string, ChecklistAnswer> = { y: "yes", "1": "yes", "н": "yes", a: "na", "2": "na", "ф": "na", n: "no", "3": "no", "т": "no" }; // i18n-ignore: keyboard-layout input, not UI text
    if (map[k]) {
      e.preventDefault();
      setAnswer(id, map[k]);
      focusRow(idx + 1);
    } else if (k === "arrowdown" || k === "j") {
      e.preventDefault(); focusRow(idx + 1);
    } else if (k === "arrowup" || k === "k") {
      e.preventDefault(); focusRow(idx - 1);
    }
  }

  function markAllYes() {
    setAnswers((prev) => {
      const next = { ...prev };
      for (const i of sorted) if (!next[i.id]) next[i.id] = "yes";
      return next;
    });
  }

  async function handleSubmit() {
    setAttempted(true);
    if (!ticker || !tradeDate) {
      setError(t("run.tickerDateRequired"));
      return;
    }
    if (!ready) {
      const first = stats.reqMissing[0] ?? stats.reqFailed[0];
      if (first) rowRefs.current.get(first.id)?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const responses = sorted.map((i) => ({
        templateId: i.id,
        label: i.label,
        answer: answers[i.id] ?? "no",
      }));
      const passed = ready;
      const created = await http.post<{ id: number }>("/api/checklist-responses", {
        ticker: ticker.toUpperCase(),
        tradeDate,
        trader: trader || null,
        responses: JSON.stringify(responses),
        passed,
      });
      onConfirm({ responseId: created.id, passed, score: stats.score });
    } catch (e: unknown) {
      setError(humanizeApiError(e, t("run.saveFailed")));
    } finally {
      setSubmitting(false);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-3 py-1" aria-busy="true" aria-label={t("run.loadingAria")}>
        <div className="flex items-center gap-4">
          <Skeleton className="h-16 w-16 rounded-full" />
          <div className="flex-1 space-y-2"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-56" /></div>
        </div>
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
      </div>
    );
  }
  if (isError) {
    return <QueryError error={loadError} onRetry={() => refetch()} />;
  }
  if (sorted.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title={t("run.notSetUp")}
        description={t("run.notSetUpHint")}
        action={
          <Button onClick={() => onConfirm({ responseId: 0, passed: true })}>{t("run.continueWithout")}</Button>
        }
      />
    );
  }

  const statusPill = ready ? (
    <Pill tone="up" dot>{t("run.ready")}</Pill>
  ) : stats.reqFailed.length > 0 ? (
    <Pill tone="down" dot>{t("run.requiredFailed")}</Pill>
  ) : !scoreOk && allRequiredAnswered ? (
    <Pill tone="warn" dot>{t("run.scoreBelow", { min: fmtRate(minScore / 100) })}</Pill>
  ) : (
    <Pill tone={stats.answered > 0 ? "warn" : "neutral"} dot>{t("run.requiredLeft", { count: stats.reqMissing.length })}</Pill>
  );

  const renderItem = (item: ChecklistTemplateItem, idx: number) => {
    const a = answers[item.id];
    const highlight = attempted && item.required && (!a || a === "no");
    return (
      <div
        key={item.id}
        ref={(el) => { if (el) rowRefs.current.set(item.id, el); else rowRefs.current.delete(item.id); }}
        tabIndex={0}
        role="group"
        aria-label={item.required ? t("run.requiredItemAria", { label: item.label }) : item.label}
        onKeyDown={(e) => onRowKey(e, idx, item.id)}
        className={cn(
          "flex flex-col gap-2 rounded-xl border border-l-2 border-[var(--glass-border)] bg-[var(--glass-bg)] p-3 transition-colors sm:flex-row sm:items-center sm:justify-between",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          a ? ANSWER_META[a].row : "border-l-border",
          highlight && "ring-1 ring-down/50",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2 text-sm font-medium text-foreground">
            <span className="min-w-0 break-words">{item.label}</span>
            {item.required && <span className="shrink-0 text-2xs font-medium text-down" title={t("run.requiredItemTitle")}>{t("run.requiredShort")}</span>}
          </div>
          {item.description && <p className="mt-0.5 text-xs text-muted-foreground">{item.description}</p>}
        </div>
        <div className="glass-field inline-flex shrink-0 items-center gap-0.5 self-start p-1 sm:self-auto" role="radiogroup" aria-label={t("answer.group", { label: item.label })}>
          {ANSWER_ORDER.map((key) => {
            const meta = ANSWER_META[key];
            const Icon = meta.icon;
            const active = a === key;
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={active}
                title={t(`answer.${key}Title`)}
                onClick={() => setAnswer(item.id, key)}
                className={cn(
                  "inline-flex min-h-8 items-center gap-1 rounded-full px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? meta.active : "text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {t(`answer.${key}`)}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Score header */}
      <div className="glass-panel flex items-center gap-4 rounded-2xl p-4">
        <ProgressRing value={stats.score / 100} tone={tone}>
          <span className="block text-base font-semibold tabular-nums text-foreground">{fmtRate(stats.score / 100)}</span>
          <span className="block text-2xs text-muted-foreground">{t("run.score")}</span>
        </ProgressRing>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {ready ? <ShieldCheck className="h-4 w-4 text-up" aria-hidden="true" /> : <ShieldAlert className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
            <span className="text-sm font-semibold text-foreground">{t("run.readiness")}{ticker ? ` · ${ticker.toUpperCase()}` : ""}</span>
            {statusPill}
          </div>
          <p className="text-xs tabular-nums text-muted-foreground">
            {t("run.progress", { ok: stats.reqOk, required: required.length, answered: stats.answered, total: sorted.length })}
            {stats.no > 0 && <> · <span className="text-down">{t("run.noCount", { count: stats.no })}</span></>}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Button type="button" variant="ghost" size="sm" onClick={markAllYes} disabled={stats.answered === sorted.length}>
              <CheckCheck aria-hidden="true" /> {t("run.restYes")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setAnswers({}); setAttempted(false); }} disabled={stats.answered === 0}>
              <RotateCcw aria-hidden="true" /> {tc("actions.reset")}
            </Button>
          </div>
        </div>
      </div>

      {required.length > 0 && (
        <section className="space-y-2" aria-label={t("run.requiredAria")}>
          <div className="micro-label">{t("run.requiredHeading", { count: required.length })}</div>
          {required.map((it, i) => renderItem(it, i))}
        </section>
      )}
      {optional.length > 0 && (
        <section className="space-y-2" aria-label={t("run.optionalAria")}>
          <div className="micro-label">{t("run.optionalHeading", { count: optional.length })}</div>
          {optional.map((it, i) => renderItem(it, required.length + i))}
        </section>
      )}

      <p className="hidden items-center gap-1.5 text-2xs text-muted-foreground sm:flex">
        <Keyboard className="h-3.5 w-3.5" aria-hidden="true" />
        {t("run.keysHint")}
      </p>

      {attempted && !ready && (
        <div role="alert" className={cn("flex items-start gap-2 rounded-xl p-3 text-xs text-foreground", stats.reqFailed.length > 0 ? "bg-down/10" : "bg-[hsl(var(--chart-3)/0.12)]")}>
          {stats.reqFailed.length > 0
            ? <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-down" aria-hidden="true" />
            : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--chart-3))]" aria-hidden="true" />}
          <span>
            {stats.reqFailed.length > 0
              ? t("run.failedAlert", { items: stats.reqFailed.map((i) => i.label).join(", ") })
              : stats.reqMissing.length > 0
              ? t("run.missingAlert", { items: stats.reqMissing.map((i) => i.label).join(", ") })
              : t("run.scoreAlert", { score: fmtRate(stats.score / 100), min: fmtRate(minScore / 100) })}
          </span>
        </div>
      )}
      {error && <div role="alert" className="text-xs text-down">{error}</div>}

      <div className="flex flex-col-reverse gap-2 border-t border-border pt-3 sm:flex-row">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} className="sm:flex-1" disabled={submitting}>
            {tc("actions.cancel")}
          </Button>
        )}
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          aria-disabled={!ready}
          className={cn("sm:flex-1", !ready && "opacity-60")}
        >
          {ready ? <ShieldCheck aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}
          {submitting ? tc("states.saving") : (submitLabel ?? t("run.confirm"))}
        </Button>
      </div>
    </div>
  );
}

export function ChecklistGateBadge({ passed }: { passed: boolean | null | undefined }) {
  const { t } = checklistI18n.useT();
  if (passed === true) {
    return (
      <Pill tone="up" className="text-2xs">
        <ShieldCheck className="h-3 w-3" aria-hidden="true" /> {t("badge.passed")}
      </Pill>
    );
  }
  if (passed === false) {
    return (
      <Pill tone="down" className="text-2xs">
        <AlertTriangle className="h-3 w-3" aria-hidden="true" /> {t("badge.failed")}
      </Pill>
    );
  }
  return null;
}
