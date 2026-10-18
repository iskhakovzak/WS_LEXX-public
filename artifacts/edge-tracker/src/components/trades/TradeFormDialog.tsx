import * as React from "react";
import type { Trade } from "@workspace/api-client-react";
import { AlertTriangle, Brain, Calculator, Camera, ClipboardList, Database, Lock, NotebookPen, Tag } from "lucide-react";
import { Pill, Segmented } from "@/components/ds";
import { resultConflictsWithPrice } from "@/lib/trade-math";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TagSelector } from "@/components/tag-selector";
import { ScreenshotFields } from "@/components/screenshot-fields";
import { TickerFundamentalsBar } from "@/components/ticker-fundamentals-bar";
import { suggestTagsFromFundamentals } from "@/lib/tags";
import { cn } from "@/lib/utils";
import { BROKER_OWNED_FIELDS, EVENT_LABEL, EVENT_TYPES, GRADES, HORIZONS, HORIZON_LABEL, RESULT_LABEL, RESULTS, SESSIONS, SESSION_LABEL, computedR, isBrokerTrade, suggestedRiskUsd, type FormData } from "./trade-utils";
import { syncedAgo } from "./trade-bits";
import { PersonSelect } from "@/components/people/person-select";
import { fmtR, fmtUsd } from "@/lib/format";
import { tradesI18n } from "@/i18n/ns/trades";
import { commonI18n } from "@/i18n/ns/common";

/** Validation shared with the page's save handler: returns an error message or null. */
export function formSaveError(form: FormData): string | null {
  const entry = form.entry ? Number(form.entry) : null;
  const stop = form.stop ? Number(form.stop) : null;
  if (entry != null && stop != null && Number.isFinite(entry) && Number.isFinite(stop) && entry === stop) {
    return tradesI18n.t("form.stopEqualsEntry");
  }
  return null;
}

/** «Результат win, но по ценам убыток» (и наоборот) — предупреждение, не блокировка. */
export function formConflictWarning(form: FormData): string | null {
  const conflicts = resultConflictsWithPrice({
    result: form.result,
    side: form.side,
    entry: form.entry ? Number(form.entry) : null,
    stop: form.stop ? Number(form.stop) : null,
    exit: form.exit ? Number(form.exit) : null,
  });
  if (!conflicts) return null;
  return tradesI18n.t(form.result === "win" ? "form.conflictWin" : "form.conflictLoss");
}

const LazyVoiceRecorder = React.lazy(() => import("@/components/voice-recorder").then((m) => ({ default: m.VoiceRecorder })));

function Section({ icon: Icon, title, hint, children, className }: {
  icon: React.ComponentType<{ className?: string }>; title: string; hint?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-border/70 bg-[var(--glass-bg)] p-4", className)}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function LockedLabel({ locked, children }: { locked: boolean; children: React.ReactNode }) {
  const { t } = tradesI18n.useT();
  if (!locked) return <>{children}</>;
  return (
    <span className="inline-flex items-center gap-1" title={t("form.lockedTitle")}>
      {children}
      <Lock className="h-3 w-3 text-muted-foreground" aria-label={t("form.lockedAria")} />
    </span>
  );
}

function Field({ id, label, children, className }: { id?: string; label: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

/** Built in render: labels follow the UI language. */
function numFields(): { key: keyof FormData; label: string }[] {
  const t = tradesI18n.t, tc = commonI18n.t;
  return [
    { key: "entry", label: tc("trading.entry") },
    { key: "stop", label: tc("trading.stop") },
    { key: "exit", label: tc("trading.exit") },
    { key: "rMultiple", label: t("form.num.rMultiple") },
    { key: "pnl", label: t("form.num.pnl") },
    { key: "qty", label: t("form.num.qty") },
    { key: "fees", label: t("form.num.fees") },
    { key: "slippage", label: t("form.num.slippage") },
    { key: "relativeVolume", label: "RVOL" },
  ];
}

export function TradeFormDialog({
  open,
  onClose,
  form,
  setForm,
  editing,
  traderNames,
  onSave,
  isPending,
  onVoiceUploaded,
}: {
  open: boolean;
  onClose: () => void;
  form: FormData;
  setForm: React.Dispatch<React.SetStateAction<FormData>>;
  editing: Trade | null;
  traderNames: string[];
  onSave: () => void;
  isPending: boolean;
  onVoiceUploaded: () => void;
}) {
  const { t } = tradesI18n.useT();
  const { t: tc } = commonI18n.useT();
  const req = (label: string) => t("form.required", { label });
  // Broker-synced trades (PropReports): the broker layer is read-only, the trader layer stays editable.
  const broker = editing != null && isBrokerTrade(editing);
  const lockedFields = React.useMemo(() => new Set<string>(broker ? BROKER_OWNED_FIELDS : []), [broker]);
  const isLocked = (k: keyof FormData) => lockedFields.has(k);
  const set = (k: keyof FormData, v: string | number) => {
    if (lockedFields.has(k)) return;
    setForm((f) => ({ ...f, [k]: v }));
  };
  const saveError = formSaveError(form);
  const conflictWarning = formConflictWarning(form);
  const syncedLabel = broker ? syncedAgo(editing?.syncedAt) : null;
  const autoR = computedR({
    entry: form.entry ? Number(form.entry) : null,
    stop: form.stop ? Number(form.stop) : null,
    exit: form.exit ? Number(form.exit) : null,
    side: form.side,
  });
  const riskHint = suggestedRiskUsd(form);

  const voice = (field: "notes" | "whatWorked" | "whatFailed" | "conclusion") => (
    <React.Suspense fallback={null}>
      <LazyVoiceRecorder
        onTranscript={(text) => setForm((f) => ({ ...f, [field]: f[field] ? `${f[field]}\n${text}` : text }))}
        onUploaded={onVoiceUploaded}
        userId={form.trader || undefined}
        tradeId={editing?.id}
      />
    </React.Suspense>
  );

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("form.title", { ticker: editing?.ticker ?? form.ticker })}</DialogTitle>
          <DialogDescription>{t("form.description")}</DialogDescription>
        </DialogHeader>

        <div
          className="space-y-4"
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSave(); } }}
        >
          {broker && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-xs" role="note">
              <Pill tone="accent" dot><Database className="mr-1 h-3 w-3" aria-hidden="true" />PropReports</Pill>
              <span className="text-muted-foreground">
                {t("form.brokerNote")}{" "}{t("form.brokerYours")}
                {editing?.brokerAccount || syncedLabel ? (
                  <span className="block tabular-nums">
                    {[editing?.brokerAccount ? t("form.brokerAccount", { account: editing.brokerAccount }) : null, syncedLabel ? t("form.brokerSynced", { ago: syncedLabel }) : null].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
              </span>
            </div>
          )}
          <Section icon={ClipboardList} title={t("form.sections.main")}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field id="tf-ticker" label={<LockedLabel locked={isLocked("ticker")}>{req(tc("trading.ticker"))}</LockedLabel>}>
                <Input id="tf-ticker" aria-required="true" aria-invalid={!form.ticker.trim()} value={form.ticker} readOnly={isLocked("ticker")} aria-readonly={isLocked("ticker") || undefined} onChange={(e) => set("ticker", e.target.value.toUpperCase())} placeholder="NVDA" className={cn("uppercase", isLocked("ticker") && "opacity-70")} />
              </Field>
              <Field id="tf-date" label={<LockedLabel locked={isLocked("date")}>{req(tc("time.date"))}</LockedLabel>}>
                <Input id="tf-date" type="date" value={form.date} readOnly={isLocked("date")} aria-readonly={isLocked("date") || undefined} onChange={(e) => set("date", e.target.value)} className={cn("px-3", isLocked("date") && "opacity-70")} />
              </Field>
              <Field id="tf-trader" label={tc("fields.trader")}>
                <PersonSelect id="tf-trader" value={form.trader} onValueChange={(v) => set("trader", v)} options={traderNames} placeholder="—" ariaLabel={tc("fields.trader")} />
              </Field>
              <Field id="tf-setup" label={tc("trading.setup")}>
                <Input id="tf-setup" value={form.setup} onChange={(e) => set("setup", e.target.value)} placeholder="Gap & Go" />
              </Field>
              <div className="col-span-2 space-y-1.5">
                <span id="tf-side-label" className="text-xs text-muted-foreground"><LockedLabel locked={isLocked("side")}>{req(tc("trading.side"))}</LockedLabel></span>
                <Segmented ariaLabel={tc("trading.side")} options={[{ value: "Long", label: "Long" }, { value: "Short", label: "Short" }]} value={form.side || "Long"} onChange={(v) => set("side", v)} className={cn("flex w-full [&>button]:flex-1 [&>button]:justify-center", isLocked("side") && "pointer-events-none opacity-70")} />
              </div>
              <div className="col-span-2 space-y-1.5">
                <span className="text-xs text-muted-foreground">{req(tc("trading.result"))}</span>
                <Segmented
                  ariaLabel={tc("trading.result")}
                  options={RESULTS.map((r) => ({ value: r, label: RESULT_LABEL[r] }))}
                  value={(RESULTS as readonly string[]).includes(form.result) ? (form.result as (typeof RESULTS)[number]) : "open"}
                  onChange={(v) => set("result", v)}
                  className="flex w-full [&>button]:flex-1 [&>button]:justify-center"
                />
              </div>
              <div className="col-span-2 space-y-1.5">
                <span className="text-xs text-muted-foreground"><LockedLabel locked={isLocked("horizon")}>{tc("trading.horizon")}</LockedLabel></span>
                <Segmented
                  ariaLabel={t("form.horizonAria")}
                  options={HORIZONS.map((h) => ({ value: h, label: HORIZON_LABEL[h] }))}
                  value={form.horizon}
                  onChange={(v) => set("horizon", v)}
                  className={cn("flex w-full [&>button]:flex-1 [&>button]:justify-center", isLocked("horizon") && "pointer-events-none opacity-70")}
                />
              </div>
              {form.horizon !== "intraday" && (
                <Field id="tf-exitDate" label={<LockedLabel locked={isLocked("exitDate")}>{t("form.exitDate")}</LockedLabel>}>
                  <Input id="tf-exitDate" type="date" min={form.date || undefined} value={form.exitDate} readOnly={isLocked("exitDate")} aria-readonly={isLocked("exitDate") || undefined} onChange={(e) => set("exitDate", e.target.value)} className={cn("px-3", isLocked("exitDate") && "opacity-70")} />
                </Field>
              )}
              <Field id="tf-event" label={t("filters.eventType")}>
                <Select value={form.eventType} onValueChange={(v) => set("eventType", v)}>
                  <SelectTrigger id="tf-event"><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>{EVENT_TYPES.map((s) => <SelectItem key={s} value={s}>{EVENT_LABEL[s] ?? s}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field id="tf-session" label={tc("trading.session")}>
                <Select value={form.session} onValueChange={(v) => set("session", v)}>
                  <SelectTrigger id="tf-session"><SelectValue /></SelectTrigger>
                  <SelectContent>{SESSIONS.map((s) => <SelectItem key={s} value={s}>{SESSION_LABEL[s] ?? s}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field id="tf-hold" label={t("form.holdTime")}>
                <Input id="tf-hold" value={form.holdTime} onChange={(e) => set("holdTime", e.target.value)} placeholder="1h 30m" />
              </Field>
            </div>
            <div className="mt-3">
              <TickerFundamentalsBar
                ticker={form.ticker}
                onLoaded={(d) => {
                  setForm((prev) => {
                    const suggestions = suggestTagsFromFundamentals(d);
                    const existing = prev.tags ? prev.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
                    const merged = Array.from(new Set([...existing, ...suggestions]));
                    return {
                      ...prev,
                      marketCap: prev.marketCap || (d.marketCap ?? ""),
                      float: prev.float || (d.float ?? ""),
                      relativeVolume: prev.relativeVolume || (d.relativeVolume != null ? String(d.relativeVolume) : ""),
                      atr: prev.atr || (d.atr != null ? String(d.atr) : ""),
                      sector: prev.sector || (d.sector ?? ""),
                      beta: prev.beta || (d.beta != null ? String(d.beta) : ""),
                      shortInterest: prev.shortInterest || (d.shortInterest != null ? String(d.shortInterest) : ""),
                      adv: prev.adv || (d.averageDailyVolume ?? ""),
                      longName: prev.longName || (d.longName ?? ""),
                      tags: merged.join(", "),
                    };
                  });
                }}
              />
            </div>
          </Section>

          <Section
            icon={Calculator}
            title={t("form.sections.numbers")}
            hint={autoR != null && !form.rMultiple ? (
              <button type="button" onClick={() => set("rMultiple", String(autoR))} className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary hover:bg-primary/20">
                {t("form.autoR", { r: fmtR(autoR) })}
              </button>
            ) : undefined}
          >
            {(saveError || conflictWarning) && (
              <div className="mb-3 space-y-1.5">
                {saveError && (
                  <p role="alert" className="flex items-start gap-2 rounded-xl border border-down/30 bg-down/10 px-3 py-2 text-xs text-down">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{saveError}
                  </p>
                )}
                {conflictWarning && (
                  <p role="status" className="flex items-start gap-2 rounded-xl border border-[hsl(var(--chart-3)/0.3)] bg-[hsl(var(--chart-3)/0.1)] px-3 py-2 text-xs text-[hsl(var(--chart-3))]">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{conflictWarning}
                  </p>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {numFields().map(({ key, label }) => (
                <Field key={key} id={`tf-${key}`} label={<LockedLabel locked={isLocked(key)}>{label}</LockedLabel>}>
                  <Input
                    id={`tf-${key}`} type="number" step="any" inputMode="decimal" value={form[key] as string}
                    readOnly={isLocked(key)} aria-readonly={isLocked(key) || undefined}
                    aria-invalid={(key === "stop" || key === "entry") && !!saveError ? true : undefined}
                    onChange={(e) => set(key, e.target.value)}
                    className={cn("tabular-nums", isLocked(key) && "opacity-70")}
                  />
                </Field>
              ))}
              <Field id="tf-riskUsd" label={t("form.riskUsd")}>
                <Input id="tf-riskUsd" type="number" step="any" inputMode="decimal" value={form.riskUsd} placeholder={riskHint != null ? String(riskHint) : undefined} onChange={(e) => set("riskUsd", e.target.value)} className="tabular-nums" aria-describedby={riskHint != null ? "tf-riskUsd-hint" : undefined} />
                {riskHint != null && String(riskHint) !== form.riskUsd && (
                  <button id="tf-riskUsd-hint" type="button" onClick={() => set("riskUsd", String(riskHint))} className="text-2xs font-medium text-primary hover:underline">
                    {t("form.riskHint", { risk: fmtUsd(riskHint, { decimals: "auto" }) })}
                  </button>
                )}
              </Field>
              <Field id="tf-marketCap" label={tc("trading.marketCap")}>
                <Input id="tf-marketCap" value={form.marketCap} onChange={(e) => set("marketCap", e.target.value)} placeholder="Large Cap" />
              </Field>
              <Field id="tf-float" label="Float">
                <Input id="tf-float" value={form.float} onChange={(e) => set("float", e.target.value)} placeholder="2.45B" />
              </Field>
              <Field id="tf-atr" label="ATR">
                <Input id="tf-atr" value={form.atr} onChange={(e) => set("atr", e.target.value)} placeholder="13.88" />
              </Field>
              <Field id="tf-sector" label={tc("trading.sector")}>
                <Input id="tf-sector" value={form.sector} onChange={(e) => set("sector", e.target.value)} placeholder="Technology" />
              </Field>
            </div>
          </Section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section icon={Tag} title={tc("fields.tags")}>
              <TagSelector
                selectedTags={form.tags ? form.tags.split(",").map((t) => t.trim()).filter(Boolean) : []}
                onChange={(tags) => set("tags", tags.join(", "))}
              />
            </Section>
            <Section icon={Brain} title={t("form.sections.psychology")}>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="tf-conviction" className="text-xs text-muted-foreground">
                    {t("form.conviction")} <span className="font-semibold text-foreground tabular-nums">{form.conviction}/5</span>
                  </Label>
                  <input
                    id="tf-conviction" type="range" min={1} max={5} step={1} value={form.conviction}
                    onChange={(e) => set("conviction", Number(e.target.value))}
                    className="h-1.5 w-full cursor-pointer accent-[hsl(var(--primary))]"
                  />
                  <div className="flex justify-between text-2xs text-muted-foreground">
                    <span>{t("form.convictionScale.low")}</span><span>{t("form.convictionScale.mid")}</span><span>{t("form.convictionScale.high")}</span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">{t("form.grade")}</span>
                  <Segmented
                    ariaLabel={t("form.grade")}
                    size="sm"
                    options={GRADES.map((g) => ({ value: g, label: g }))}
                    value={form.confidenceGrade as (typeof GRADES)[number]}
                    onChange={(g) => set("confidenceGrade", g)}
                  />
                </div>
              </div>
            </Section>
          </div>

          <Section icon={NotebookPen} title={t("form.sections.review")}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {([
                ["notes", tc("fields.notes")],
                ["whatWorked", t("reviewFields.whatWorked")],
                ["whatFailed", t("reviewFields.whatFailed")],
                ["conclusion", t("reviewFields.conclusion")],
              ] as const).map(([key, label]) => (
                <div key={key} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor={`tf-${key}`} className="text-xs text-muted-foreground">{label}</Label>
                    {voice(key)}
                  </div>
                  <Textarea id={`tf-${key}`} value={form[key]} onChange={(e) => set(key, e.target.value)} rows={3} className="resize-y rounded-xl" />
                </div>
              ))}
            </div>
          </Section>

          <Section icon={Camera} title={tc("fields.screenshots")}>
            <ScreenshotFields
              urls={form.screenshotUrls}
              onChange={(urls) => setForm((f) => ({ ...f, screenshotUrls: urls }))}
              notes={form.screenshotNotes}
              onNotesChange={(notes) => setForm((f) => ({ ...f, screenshotNotes: notes }))}
            />
          </Section>
        </div>

        <DialogFooter className="mt-2 flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          <span className="hidden text-2xs text-muted-foreground lg:mr-auto lg:inline">{t("form.ctrlEnter")}</span>
          <Button variant="outline" onClick={onClose}>{tc("actions.cancel")}</Button>
          <Button onClick={onSave} disabled={isPending || !form.ticker.trim() || !!saveError} title={!form.ticker.trim() ? t("form.tickerRequired") : saveError ?? undefined}>
            {isPending ? tc("states.saving") : tc("actions.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

