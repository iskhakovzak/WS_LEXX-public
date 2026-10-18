import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Kbd } from "@/components/ui/kbd";
import { Segmented } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { http } from "@/lib/api/http";
import { humanizeApiError } from "@/lib/api/errors";
import { MISTAKE_CATEGORIES, RULE_PREFIX, SEVERITY, SEVERITY_ORDER } from "./constants";
import { commonI18n } from "@/i18n/ns/common";
import { rulesI18n } from "@/i18n/ns/rules";
import { fmtDate, fmtR, fmtUsd } from "@/lib/format";
import type { DisciplineTrade, Mistake, MistakePrefill, Rule, Severity } from "./types";

const NO_TRADE = "none";

export function MistakeDialog({
  open,
  onOpenChange,
  trader,
  editing,
  prefill,
  rules,
  trades,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  trader: string;
  editing: Mistake | null;
  prefill: MistakePrefill | null;
  rules: Rule[];
  trades: DisciplineTrade[];
  onSaved: () => void;
}) {
  const { t } = rulesI18n.useT();
  const { toast } = useToast();
  const [category, setCategory] = useState("");
  const [custom, setCustom] = useState("");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [severityTouched, setSeverityTouched] = useState(false);
  const [tradeId, setTradeId] = useState<string>(NO_TRADE);
  const [ticker, setTicker] = useState("");
  const [description, setDescription] = useState("");
  const [lesson, setLesson] = useState("");
  const [resolved, setResolved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [catError, setCatError] = useState<string | null>(null);

  const ruleCats = useMemo(() => rules.filter((r) => r.enabled).map((r) => `${RULE_PREFIX}${r.name}`), [rules]);
  const presetLabels = useMemo(() => new Set([...MISTAKE_CATEGORIES.map((c) => c.value), ...ruleCats]), [ruleCats]);

  useEffect(() => {
    if (!open) return;
    setCatError(null);
    setSeverityTouched(!!editing);
    if (editing) {
      const isPreset = presetLabels.has(editing.errorType);
      setCategory(isPreset ? editing.errorType : "");
      setCustom(isPreset ? "" : editing.errorType);
      setSeverity((SEVERITY_ORDER as readonly string[]).includes(editing.severity) ? (editing.severity as Severity) : "medium");
      setTradeId(editing.tradeId ? String(editing.tradeId) : NO_TRADE);
      setTicker(editing.ticker ?? "");
      setDescription(editing.description === editing.errorType ? "" : editing.description);
      setLesson(editing.lesson ?? "");
      setResolved(editing.resolved === "yes");
    } else {
      const p = prefill ?? {};
      const cat = p.errorType ?? "";
      const isPreset = !cat || presetLabels.has(cat);
      setCategory(isPreset ? cat : "");
      setCustom(isPreset ? "" : cat);
      setSeverity(p.severity ?? (MISTAKE_CATEGORIES.find((c) => c.value === cat)?.severity ?? "medium"));
      setSeverityTouched(!!p.severity);
      setTradeId(p.tradeId ? String(p.tradeId) : NO_TRADE);
      setTicker(p.ticker ?? "");
      setDescription(p.description ?? "");
      setLesson("");
      setResolved(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, prefill]);

  const tradeOptions = useMemo(() => {
    const list = trades.slice(0, 60);
    const extraId = editing?.tradeId ?? prefill?.tradeId ?? null;
    if (extraId && !list.some((t) => t.id === extraId)) {
      list.unshift({
        id: extraId, ticker: editing?.ticker ?? prefill?.ticker ?? "#" + extraId, date: editing?.tradeDate ?? "",
        closeDate: editing?.tradeDate ?? "", side: null, setup: null, playbookId: null, result: "", rMultiple: editing?.tradeR ?? null,
        pnl: null, fees: null, netPnl: editing?.tradeNetPnl ?? null, horizon: null, source: null, violations: 0, violationCost: 0, mistakes: 0,
      });
    }
    return list;
  }, [trades, editing, prefill]);

  function pickCategory(label: string, sev?: Severity) {
    setCatError(null);
    setCustom("");
    setCategory(label);
    if (!severityTouched && sev) setSeverity(sev);
  }

  const errorType = (custom.trim() || category).trim();

  async function save() {
    if (!errorType) { setCatError(t("mistake.needCategory")); return; }
    setSaving(true);
    const body: Record<string, unknown> = {
      errorType,
      description: description.trim() || errorType,
      severity,
      lesson: lesson.trim() || null,
      tradeId: tradeId === NO_TRADE ? null : Number(tradeId),
      ticker: tradeId === NO_TRADE ? (ticker.trim() || null) : undefined,
    };
    try {
      if (editing) {
        body.resolved = resolved ? "yes" : "no";
        await http.patch(`/api/errors/${editing.id}`, body);
        toast({ title: t("mistake.updated") });
      } else {
        await http.post(`/api/errors`, { ...body, trader });
        toast({ title: t("mistake.logged"), description: t("mistake.loggedHint") });
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast({ title: commonI18n.t("states.error"), description: humanizeApiError(e, editing ? commonI18n.t("states.saveFailed") : t("mistake.logFailed")), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[92dvh] max-w-xl overflow-y-auto"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); if (!saving) save(); }
        }}
      >
        <DialogHeader>
          <DialogTitle>{editing ? t("mistake.editTitle") : t("mistake.newTitle")}</DialogTitle>
          <DialogDescription>
            {editing ? t("mistake.editDesc") : t("mistake.newDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{t("mistake.what")}</legend>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("mistake.catsAria")}>
              {MISTAKE_CATEGORIES.map((c) => (
                <button
                  key={c.code}
                  type="button"
                  title={c.hint}
                  aria-pressed={category === c.value && !custom}
                  onClick={() => pickCategory(c.value, c.severity)}
                  className="chip min-h-8 px-3 text-xs font-medium"
                >
                  {c.label}
                </button>
              ))}
            </div>
            {ruleCats.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="micro-label">{t("mistake.myRules")}</span>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("mistake.myRules")}>
                  {ruleCats.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-pressed={category === c && !custom}
                      onClick={() => pickCategory(c, "high")}
                      className="chip min-h-8 px-3 text-xs font-medium"
                    >
                      {c.slice(RULE_PREFIX.length)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <Label htmlFor="mistake-custom" className="text-xs text-muted-foreground">{t("mistake.custom")}</Label>
              <Input
                id="mistake-custom"
                value={custom}
                maxLength={80}
                placeholder={t("mistake.customPlaceholder")}
                aria-invalid={!!catError || undefined}
                aria-describedby={catError ? "mistake-cat-error" : undefined}
                onChange={(e) => { setCatError(null); setCustom(e.target.value); }}
              />
              {catError && <p id="mistake-cat-error" className="text-xs text-down">{catError}</p>}
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium" id="mistake-sev-label">{t("mistake.severity")}</span>
            <Segmented
              ariaLabel={t("mistake.severity")}
              size="sm"
              value={severity}
              onChange={(v) => { setSeverity(v); setSeverityTouched(true); }}
              options={SEVERITY_ORDER.map((s) => ({ value: s, label: SEVERITY[s].label }))}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="mistake-trade" className="text-sm font-medium">{t("mistake.trade")}</Label>
              <Select value={tradeId} onValueChange={setTradeId}>
                <SelectTrigger id="mistake-trade"><SelectValue placeholder={t("mistake.noTrade")} /></SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={NO_TRADE}>{t("mistake.noTrade")}</SelectItem>
                  {tradeOptions.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      <span className="font-medium">{t.ticker}</span>
                      <span className="ml-2 text-muted-foreground tabular-nums">{fmtDate(t.closeDate || t.date, "dayMonth")}{t.netPnl != null ? ` · ${fmtUsd(t.netPnl, { signed: true, decimals: "trim" })}` : t.rMultiple != null ? ` · ${fmtR(t.rMultiple, 1)}` : ""}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="mistake-ticker" className={cn("text-sm font-medium", tradeId !== NO_TRADE && "opacity-60")}>{commonI18n.t("trading.ticker")}</Label>
              <Input
                id="mistake-ticker"
                value={tradeId !== NO_TRADE ? (tradeOptions.find((t) => String(t.id) === tradeId)?.ticker ?? ticker) : ticker}
                disabled={tradeId !== NO_TRADE}
                maxLength={12}
                placeholder="AAPL"
                className="uppercase"
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="mistake-desc" className="text-sm font-medium">{t("mistake.details")}</Label>
            <Textarea id="mistake-desc" rows={2} value={description} maxLength={4000} placeholder={t("mistake.detailsPlaceholder")} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="mistake-lesson" className="text-sm font-medium">{t("mistake.lesson")}</Label>
            <Textarea id="mistake-lesson" rows={2} value={lesson} maxLength={4000} placeholder={t("log.lessonPlaceholder")} onChange={(e) => setLesson(e.target.value)} />
          </div>
          {editing && (
            <div className="flex items-center gap-2">
              <Switch id="mistake-resolved" checked={resolved} onCheckedChange={setResolved} />
              <Label htmlFor="mistake-resolved" className="cursor-pointer text-sm">{t("mistake.reviewed")}</Label>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:items-center">
          <span className="hidden text-xs text-muted-foreground sm:mr-auto sm:inline-flex sm:items-center sm:gap-1">
            <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> {t("mistake.ctrlEnter")}
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{commonI18n.t("actions.cancel")}</Button>
          <Button onClick={save} disabled={saving}>{saving ? commonI18n.t("states.saving") : editing ? commonI18n.t("actions.save") : t("mistake.log")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
