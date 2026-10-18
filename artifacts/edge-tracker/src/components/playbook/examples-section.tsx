/** "Примеры" — gallery of concrete tickers/dates where the setup played out (CRUD on /api/playbook/:id/ideas). */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { WriteOnly } from "@/contexts/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Pill, type Tone } from "@/components/ds";
import { IconAction } from "@/components/playbook-sub/bits";
import { TickerFundamentalsBar } from "@/components/ticker-fundamentals-bar";
import type { TickerFundamentals } from "@/lib/market-intel";
import { localDateString } from "@/lib/local-date";
import { useToast } from "@/hooks/use-toast";
import { http } from "@/lib/api/http";
import { DocSection, InlineError } from "./setup-bits";
import { commonI18n } from "@/i18n/ns/common";
import { playbookExamplesI18n, type CaseStatus } from "@/i18n/ns/playbookExamples";

type Example = {
  id: number; playbook_entry_id: number; ticker: string; side: string | null; entry_zone: string | null;
  target: string | null; stop: string | null; status: string; notes: string | null; date: string | null; createdAt: string;
  market_cap: string | null; float: string | null; adv: string | null; atr: string | null; relative_volume: string | null;
  beta: string | null; short_interest: string | null; sector: string | null; long_name: string | null;
};

/** Status code (stored) → tone; the label is read in the current UI language (getter). */
const statusRow = (code: CaseStatus, tone: Tone) => ({ tone, get label() { return playbookExamplesI18n.t(`cases.status.${code}`); } });
const STATUS: Record<string, { readonly label: string; tone: Tone }> = {
  worked: statusRow("worked", "up"),
  partial: statusRow("partial", "warn"),
  failed: statusRow("failed", "down"),
  studying: statusRow("studying", "accent"),
  watching: statusRow("watching", "neutral"),
};
const CYCLE = ["worked", "partial", "failed", "studying"];

type Form = {
  ticker: string; side: string; entryZone: string; target: string; stop: string; status: string; notes: string; date: string;
  marketCap: string; float: string; adv: string; atr: string; relativeVolume: string; beta: string; shortInterest: string; sector: string; longName: string;
};
const blank = (): Form => ({
  ticker: "", side: "Long", entryZone: "", target: "", stop: "", status: "worked", notes: "", date: localDateString(),
  marketCap: "", float: "", adv: "", atr: "", relativeVolume: "", beta: "", shortInterest: "", sector: "", longName: "",
});

export function ExamplesSection({ entryId }: { entryId: number }) {
  const { t } = playbookExamplesI18n.useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<Form>(blank);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Example | null>(null);

  const { data: ideas = [], isLoading, isError, refetch } = useQuery<Example[]>({
    queryKey: ["playbook-ideas", entryId],
    queryFn: () => http.get<Example[]>(`/api/playbook/${entryId}/ideas`),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["playbook-ideas", entryId] });
    qc.invalidateQueries({ queryKey: ["playbook-summary"] });
  };
  const setF = (k: keyof Form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function run(fn: () => Promise<unknown>, errTitle: string) {
    try { await fn(); return true; } catch (e: any) { toast({ title: errTitle, description: e?.message, variant: "destructive" }); return false; }
  }

  function onFundamentals(f: TickerFundamentals) {
    setForm((prev) => ({
      ...prev,
      marketCap: prev.marketCap || (f.marketCap ?? ""), float: prev.float || (f.float ?? ""), adv: prev.adv || (f.averageDailyVolume ?? ""),
      atr: prev.atr || (f.atr != null ? String(f.atr) : ""), relativeVolume: prev.relativeVolume || (f.relativeVolume != null ? String(f.relativeVolume) : ""),
      beta: prev.beta || (f.beta != null ? String(f.beta) : ""), shortInterest: prev.shortInterest || (f.shortInterest != null ? String(f.shortInterest) : ""),
      sector: prev.sector || (f.sector ?? ""), longName: prev.longName || (f.longName ?? ""),
    }));
  }

  async function save() {
    if (!form.ticker.trim() || saving) return;
    const json = {
      ticker: form.ticker.toUpperCase(), side: form.side || null, entryZone: form.entryZone || null, target: form.target || null,
      stop: form.stop || null, status: form.status, notes: form.notes || null, date: form.date || null,
      marketCap: form.marketCap || null, float: form.float || null, adv: form.adv || null, atr: form.atr || null,
      relativeVolume: form.relativeVolume || null, beta: form.beta || null, shortInterest: form.shortInterest || null,
      sector: form.sector || null, longName: form.longName || null,
    };
    setSaving(true);
    const ok = await run(
      () => editingId
        ? http.patch(`/api/playbook/${entryId}/ideas/${editingId}`, json)
        : http.post(`/api/playbook/${entryId}/ideas`, json),
      editingId ? t("cases.saveFailed") : t("cases.addFailed"),
    );
    setSaving(false);
    if (!ok) return;
    refresh();
    toast({ title: editingId ? t("cases.saved") : t("cases.added") });
    setFormOpen(false); setEditingId(null); setForm(blank());
  }

  async function cycleStatus(idea: Example) {
    const next = CYCLE[(CYCLE.indexOf(idea.status) + 1) % CYCLE.length];
    // Full idea in the body so a status change can't clear other fields on older API builds.
    const json = { status: next, ticker: idea.ticker, side: idea.side, entryZone: idea.entry_zone, target: idea.target, stop: idea.stop, notes: idea.notes, date: idea.date };
    if (await run(() => http.patch(`/api/playbook/${entryId}/ideas/${idea.id}`, json), t("cases.statusFailed"))) refresh();
  }

  async function remove(id: number) {
    const ok = await run(() => http.del(`/api/playbook/${entryId}/ideas/${id}`), t("cases.deleteFailed"));
    setDeleting(null);
    if (ok) { refresh(); toast({ title: t("cases.deleted") }); }
  }

  function startEdit(i: Example) {
    setForm({
      ticker: i.ticker, side: i.side || "Long", entryZone: i.entry_zone || "", target: i.target || "", stop: i.stop || "",
      status: i.status, notes: i.notes || "", date: i.date || "", marketCap: i.market_cap || "", float: i.float || "",
      adv: i.adv || "", atr: i.atr || "", relativeVolume: i.relative_volume || "", beta: i.beta || "",
      shortInterest: i.short_interest || "", sector: i.sector || "", longName: i.long_name || "",
    });
    setEditingId(i.id);
    setFormOpen(true);
  }

  const worked = ideas.filter((i) => i.status === "worked").length;
  const judged = ideas.filter((i) => i.status === "worked" || i.status === "failed" || i.status === "partial").length;
  const fid = `ex-${entryId}`;

  return (
    <DocSection
      title={<>{t("cases.title")} {ideas.length > 0 && <span className="font-normal tabular-nums text-muted-foreground">{ideas.length}</span>}</>}
      icon={BookOpen}
      actions={
        <>
          {judged > 0 && <span className="mr-1 text-xs tabular-nums text-muted-foreground">{t("cases.workedOf", { worked, judged })}</span>}
          <WriteOnly>
            <Button size="sm" variant="outline" className="h-8" onClick={() => { setForm(blank()); setEditingId(null); setFormOpen((v) => !v); }}>
              <Plus className="h-4 w-4" aria-hidden="true" /> {t("cases.add")}
            </Button>
          </WriteOnly>
        </>
      }
    >
      {formOpen && (
        <form
          className="mb-3 space-y-3 rounded-xl bg-[var(--glass-bg)] p-3"
          onSubmit={(e) => { e.preventDefault(); save(); }}
        >
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor={`${fid}-ticker`} className="text-xs text-muted-foreground">{t("cases.ticker")}</Label>
              <Input id={`${fid}-ticker`} value={form.ticker} onChange={(e) => setF("ticker", e.target.value.toUpperCase())} placeholder="NVDA" className="h-9" autoFocus />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${fid}-side`} className="text-xs text-muted-foreground">{t("cases.side")}</Label>
              <Select value={form.side} onValueChange={(v) => setF("side", v)}>
                <SelectTrigger id={`${fid}-side`} className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Long">{commonI18n.t("trading.long")}</SelectItem>
                  <SelectItem value="Short">{commonI18n.t("trading.short")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${fid}-date`} className="text-xs text-muted-foreground">{t("cases.date")}</Label>
              <Input id={`${fid}-date`} type="date" value={form.date} onChange={(e) => setF("date", e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${fid}-status`} className="text-xs text-muted-foreground">{t("cases.result")}</Label>
              <Select value={form.status} onValueChange={(v) => setF("status", v)}>
                <SelectTrigger id={`${fid}-status`} className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(STATUS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${fid}-entry`} className="text-xs text-muted-foreground">{t("cases.entry")}</Label>
              <Input id={`${fid}-entry`} value={form.entryZone} onChange={(e) => setF("entryZone", e.target.value)} placeholder="142" className="h-9" />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${fid}-target`} className="text-xs text-muted-foreground">{t("cases.target")}</Label>
              <Input id={`${fid}-target`} value={form.target} onChange={(e) => setF("target", e.target.value)} placeholder="150" className="h-9" />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${fid}-stop`} className="text-xs text-muted-foreground">{t("cases.stop")}</Label>
              <Input id={`${fid}-stop`} value={form.stop} onChange={(e) => setF("stop", e.target.value)} placeholder="138" className="h-9" />
            </div>
            <div className="col-span-2 space-y-1 md:col-span-4">
              <Label htmlFor={`${fid}-notes`} className="text-xs text-muted-foreground">{t("cases.notes")}</Label>
              <Textarea id={`${fid}-notes`} value={form.notes} onChange={(e) => setF("notes", e.target.value)} rows={2} className="resize-none text-sm" />
            </div>
          </div>
          {form.ticker.length >= 1 && <TickerFundamentalsBar ticker={form.ticker} onLoaded={onFundamentals} />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => { setFormOpen(false); setEditingId(null); setForm(blank()); }}>{commonI18n.t("actions.cancel")}</Button>
            <Button type="submit" variant="outline" size="sm" disabled={!form.ticker.trim() || saving}>
              {saving ? t("cases.saving") : editingId ? commonI18n.t("actions.save") : commonI18n.t("actions.add")}
            </Button>
          </div>
        </form>
      )}

      {isLoading && <div className="grid gap-2 sm:grid-cols-2"><Skeleton className="h-20 rounded-xl" /><Skeleton className="h-20 rounded-xl" /></div>}
      {isError && <InlineError text={t("cases.loadFailed")} onRetry={() => refetch()} />}
      {!isLoading && !isError && ideas.length === 0 && !formOpen && (
        <p className="text-sm text-muted-foreground">
          {t("cases.empty")}
        </p>
      )}

      {ideas.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {ideas.map((i) => {
            const st = STATUS[i.status] ?? STATUS.studying;
            return (
              <li key={i.id} className="group rounded-xl bg-[var(--glass-bg)] p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-semibold text-foreground">{i.ticker}</span>
                      {i.side && <span className={i.side === "Long" ? "text-xs text-up" : "text-xs text-down"}>{i.side === "Long" ? `▲ ${commonI18n.t("trading.long")}` : `▼ ${commonI18n.t("trading.short")}`}</span>}
                      {i.date && <span className="text-xs tabular-nums text-muted-foreground">{i.date}</span>}
                    </div>
                    {i.long_name && <div className="truncate text-xs text-muted-foreground">{i.long_name}</div>}
                  </div>
                  <button
                    type="button"
                    onClick={() => cycleStatus(i)}
                    aria-label={t("cases.statusAria", { status: st.label })}
                    title={t("cases.statusTitle")}
                    className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Pill tone={st.tone} dot>{st.label}</Pill>
                  </button>
                </div>
                {(i.entry_zone || i.target || i.stop) && (
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums">
                    {i.entry_zone && <span><span className="text-muted-foreground">{t("cases.entry")} </span>{i.entry_zone}</span>}
                    {i.target && <span><span className="text-muted-foreground">{t("cases.target")} </span><span className="text-up">{i.target}</span></span>}
                    {i.stop && <span><span className="text-muted-foreground">{t("cases.stop")} </span><span className="text-down">{i.stop}</span></span>}
                  </div>
                )}
                {i.notes && <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">{i.notes}</p>}
                {(i.sector || i.market_cap || i.float || i.short_interest) && (
                  <div className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    {i.sector && <span>{i.sector}</span>}
                    {i.market_cap && <span>MCap {i.market_cap}</span>}
                    {i.float && <span>Float {i.float}</span>}
                    {i.short_interest && <span>SI {i.short_interest}%</span>}
                  </div>
                )}
                <WriteOnly>
                  <div className="mt-1 flex justify-end gap-0.5 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                    <IconAction aria-label={t("cases.edit", { ticker: i.ticker })} title={t("cases.edit", { ticker: i.ticker })} onClick={() => startEdit(i)}><Pencil /></IconAction>
                    <IconAction aria-label={t("cases.delete", { ticker: i.ticker })} title={t("cases.delete", { ticker: i.ticker })} onClick={() => setDeleting(i)} className="hover:text-down"><Trash2 /></IconAction>
                  </div>
                </WriteOnly>
              </li>
            );
          })}
        </ul>
      )}

      <AlertDialog open={!!deleting} onOpenChange={(v) => { if (!v) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("cases.deleteTitle", { ticker: deleting?.ticker ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("cases.deleteDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{commonI18n.t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && remove(deleting.id)} className="bg-down text-white hover:bg-down/90">{commonI18n.t("actions.delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DocSection>
  );
}
