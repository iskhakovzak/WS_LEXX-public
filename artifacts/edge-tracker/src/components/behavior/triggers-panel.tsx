/**
 * «Мои триггеры» — пороги, которые трейдер задаёт себе сам («3 убытка подряд», «сделка < 2 мин после убытка»…).
 * Хранятся в behavior_triggers (routes/behavior.ts, мягкое удаление). Проверка — ретроспективная по сделкам
 * периода: сколько раз сработал бы, сколько сделок «под триггером» и их нетто. Уведомлений в реальном времени нет.
 */
import * as React from "react";
import { Link } from "wouter";
import { BellRing, Pencil, Plus, Trash2, X } from "lucide-react";
import { EmptyState, ErrorState, ListSkeleton, Pill, Tile, toneOf, toneText } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "@/hooks/use-toast";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import {
  PATTERN_SHORT, useCreateTrigger, useDeleteTrigger,
  useTriggers, useUpdateTrigger, type BehaviorTrigger, type PatternKey, type Range, type TriggerKind, type TriggerKindDef,
} from "./api";
import { fmtDate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { behaviorI18n } from "@/i18n/ns/behavior";

const tb = behaviorI18n.t;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function defaultsOf(def: TriggerKindDef | undefined): Record<string, number> {
  return Object.fromEntries((def?.fields ?? []).map((f) => [f.key, f.default]));
}

/* ─── Поля параметров ─────────────────────────────────────────────────────── */

function ParamFields({ def, value, onChange, idPrefix }: { def: TriggerKindDef; value: Record<string, number>; onChange: (v: Record<string, number>) => void; idPrefix: string }) {
  if (!def.fields.length) return null;
  return (
    <div className="flex flex-wrap items-end gap-2">
      {def.fields.map((f) => (
        <label key={f.key} htmlFor={`${idPrefix}-${f.key}`} className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>{f.label}{f.unit ? `, ${f.unit}` : ""}</span>
          <Input
            id={`${idPrefix}-${f.key}`}
            type="number"
            inputMode="decimal"
            min={f.min}
            max={f.max}
            step={f.step ?? 1}
            value={Number.isFinite(value[f.key]) ? value[f.key] : ""}
            onChange={(e) => onChange({ ...value, [f.key]: e.target.value === "" ? Number.NaN : Number(e.target.value) })}
            className="h-8 w-28 tabular-nums"
          />
        </label>
      ))}
    </div>
  );
}

function validParams(def: TriggerKindDef, v: Record<string, number>): string | null {
  for (const f of def.fields) {
    const x = v[f.key];
    if (!Number.isFinite(x)) return tb("trig.fill", { label: f.label });
    if (x < f.min || x > f.max) return tb("trig.range", { label: f.label, min: f.min, max: f.max });
  }
  return null;
}

/* ─── Форма добавления ────────────────────────────────────────────────────── */

function AddTriggerForm({ kinds, trader, onDone }: { kinds: TriggerKindDef[]; trader: string | null; onDone: () => void }) {
  const [kind, setKind] = React.useState<TriggerKind>(kinds[0]?.kind ?? "loss_streak");
  const def = kinds.find((k) => k.kind === kind);
  const [params, setParams] = React.useState<Record<string, number>>(() => defaultsOf(def));
  const [name, setName] = React.useState("");
  const create = useCreateTrigger();
  const idPrefix = React.useId();

  React.useEffect(() => { setParams(defaultsOf(kinds.find((k) => k.kind === kind))); }, [kind, kinds]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!def) return;
    const bad = validParams(def, params);
    if (bad) { toast({ title: bad, variant: "destructive" }); return; }
    if (kind === "custom" && !name.trim()) { toast({ title: tb("trig.needText"), variant: "destructive" }); return; }
    create.mutate({ trader, kind, params, name: name.trim() || undefined }, {
      onSuccess: (r) => { toast({ title: r.existing ? tb("trig.exists") : tb("trig.added"), description: r.name }); onDone(); },
      onError: (err) => toast({ title: tb("trig.addFailed"), description: errMsg(err), variant: "destructive" }),
    });
  };

  return (
    <form onSubmit={submit} className="tile flex flex-col gap-3 p-3" aria-label={tb("trig.newAria")}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>{tb("trig.condition")}</span>
          <Select value={kind} onValueChange={(v) => setKind(v as TriggerKind)}>
            <SelectTrigger className="h-8 w-64" aria-label={tb("trig.conditionAria")}><SelectValue /></SelectTrigger>
            <SelectContent>
              {kinds.map((k) => <SelectItem key={k.kind} value={k.kind}>{k.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        {def && <ParamFields def={def} value={params} onChange={setParams} idPrefix={idPrefix} />}
        <label htmlFor={`${idPrefix}-name`} className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
          <span>{kind === "custom" ? tb("trig.text") : tb("trig.name")}</span>
          <Input id={`${idPrefix}-name`} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} className="h-8" placeholder={kind === "custom" ? tb("trig.textPlaceholder") : tb("trig.namePlaceholder")} />
        </label>
      </div>
      {def && <p className="text-xs text-muted-foreground">{def.hint}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={create.isPending} aria-busy={create.isPending}>{tb("trig.add")}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>{tb("trig.cancel")}</Button>
      </div>
    </form>
  );
}

/* ─── Строка триггера ─────────────────────────────────────────────────────── */

const TriggerRow = React.memo(function TriggerRow({
  t, def, canEdit, onPickDay,
}: {
  t: BehaviorTrigger;
  def: TriggerKindDef | undefined;
  canEdit: boolean;
  onPickDay?: (date: string) => void;
}) {
  const update = useUpdateTrigger();
  const del = useDeleteTrigger();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<string, number>>(t.params);
  const [confirm, setConfirm] = React.useState(false);
  const [showEx, setShowEx] = React.useState(false);
  const idPrefix = React.useId();
  const ev = t.eval;

  const save = () => {
    if (!def) return;
    const bad = validParams(def, draft);
    if (bad) { toast({ title: bad, variant: "destructive" }); return; }
    update.mutate({ id: t.id, params: draft }, {
      onSuccess: () => setEditing(false),
      onError: (e) => toast({ title: tb("trig.saveFailed"), description: errMsg(e), variant: "destructive" }),
    });
  };

  return (
    <li>
      <Tile className={cn("flex flex-col gap-2", !t.enabled && "opacity-60")}>
        <div className="flex flex-wrap items-start gap-3">
          {canEdit && (
            <Switch
              checked={t.enabled}
              onCheckedChange={(v) => update.mutate({ id: t.id, enabled: v }, { onError: (e) => toast({ title: tb("trig.toggleFailed"), description: errMsg(e), variant: "destructive" }) })}
              aria-label={t.enabled ? tb("trig.disable", { name: t.name }) : tb("trig.enable", { name: t.name })}
              className="mt-0.5"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-foreground">{t.name}</span>
              {t.sourcePattern && PATTERN_SHORT[t.sourcePattern as PatternKey] && (
                <Pill tone="neutral" title={tb("trig.fromPatternTitle")}>{tb("trig.fromPattern", { pattern: PATTERN_SHORT[t.sourcePattern as PatternKey] })}</Pill>
              )}
            </div>
            {t.note && t.note !== t.name && <p className="mt-0.5 text-xs text-muted-foreground">{t.note}</p>}
          </div>
          {canEdit && (
            <div className="flex shrink-0 items-center gap-1">
              {def && def.fields.length > 0 && (
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => { setDraft(t.params); setEditing((v) => !v); }} aria-label={tb("trig.editAria", { name: t.name })} aria-expanded={editing}>
                  {editing ? <X className="h-3.5 w-3.5" aria-hidden="true" /> : <Pencil className="h-3.5 w-3.5" aria-hidden="true" />}
                </Button>
              )}
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setConfirm(true)} aria-label={tb("trig.deleteAria", { name: t.name })}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          )}
        </div>

        {editing && def && (
          <div className="flex flex-wrap items-end gap-2">
            <ParamFields def={def} value={draft} onChange={setDraft} idPrefix={idPrefix} />
            <Button size="sm" onClick={save} disabled={update.isPending}>{tb("trig.save")}</Button>
          </div>
        )}

        {ev && ev.evaluable ? (
          ev.fires > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">
                {tb("trig.fires", { count: ev.fires, days: commonI18n.t("units.days", { count: ev.days }) })}{" "}
                {tb("trig.under", { trades: commonI18n.t("units.trades", { count: ev.trades }) })}{" "}
                <span className={cn("font-medium tabular-nums", toneText(toneOf(ev.net)))}>{fmtUsd(ev.net, { signed: true, decimals: "auto" })}</span>
                {ev.net != null && ev.net < 0 && <> {tb("trig.saved", { value: fmtUsd(-ev.net, { decimals: 0 }) })}</>}.
              </p>
              <div className="flex flex-wrap items-center gap-1">
                {ev.recentDates.slice(-10).map((d) => (
                  onPickDay ? (
                    <button key={d} type="button" onClick={() => onPickDay(d)} className="rounded-full bg-[var(--glass-bg)] px-2 py-0.5 text-xs tabular-nums text-muted-foreground hover:text-foreground" title={tb("trig.showDay", { date: fmtDate(d, "medium") })}>
                      {fmtDate(d, "dayMonthNumeric")}
                    </button>
                  ) : <Pill key={d} tone="neutral">{fmtDate(d, "dayMonthNumeric")}</Pill>
                ))}
                {ev.examples.length > 0 && (
                  <button type="button" onClick={() => setShowEx((v) => !v)} aria-expanded={showEx} className="ml-1 text-xs text-primary underline-offset-2 hover:underline">
                    {showEx ? tb("trig.hideExamples") : tb("trig.examples")}
                  </button>
                )}
                {ev.tradeIds.length > 0 && (
                  <Link href={links.trades({ ids: ev.tradeIds })} className="ml-auto text-xs text-primary underline-offset-2 hover:underline">{tb("trig.allTrades")}</Link>
                )}
              </div>
              {showEx && (
                <ul className="flex flex-col text-xs">
                  {ev.examples.map((e) => (
                    <li key={e.id}>
                      <Link href={links.trade(e.id)} className="flex min-h-8 items-center gap-2 rounded-lg px-2 hover:bg-[var(--glass-hover-bg)]">
                        <span className="w-11 tabular-nums text-muted-foreground">{fmtDate(e.date, "dayMonthNumeric")}</span>
                        <span className="w-12 font-medium">{e.ticker}</span>
                        <span className={cn("w-14 text-right tabular-nums", toneText(toneOf(e.net)))}>{fmtUsd(e.net, { signed: true, compact: true })}</span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{e.note}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{tb("trig.never")}</p>
          )
        ) : (
          <p className="text-xs text-muted-foreground">{tb("trig.reminder")}</p>
        )}
      </Tile>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tb("trig.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{tb("trig.deleteText", { name: t.name })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tb("trig.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => del.mutate({ id: t.id }, { onError: (e) => toast({ title: tb("trig.deleteFailed"), description: errMsg(e), variant: "destructive" }) })}
            >
              {tb("trig.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
});

/* ─── Панель ──────────────────────────────────────────────────────────────── */

export function TriggersPanel({ trader, range, onPickDay }: { trader: string | null; range: Range; onPickDay?: (date: string) => void }) {
  const q = useTriggers(trader, range);
  const [adding, setAdding] = React.useState(false);
  const kindMap = React.useMemo(() => new Map((q.data?.kinds ?? []).map((k) => [k.kind, k])), [q.data?.kinds]);

  if (q.data === undefined) {
    if (q.isError) return <ErrorState error={q.error} onRetry={q.refetch} compact />;
    return <ListSkeleton rows={3} />;
  }
  const d = q.data;
  const canEdit = d.canEdit;
  const target = d.trader;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">
          {tb("trig.history", { days: d.tradingDays ? ` (${commonI18n.t("units.days", { count: d.tradingDays })})` : "" })}
        </p>
        {canEdit && !adding && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setAdding(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> {tb("trig.addTrigger")}
          </Button>
        )}
      </div>

      {adding && <AddTriggerForm kinds={d.kinds} trader={target} onDone={() => setAdding(false)} />}

      {d.items.length === 0 ? (
        !adding && (
          <EmptyState
            icon={BellRing}
            title={tb("trig.none")}
            description={canEdit ? tb("trig.noneEdit") : tb("trig.noneView")}
          />
        )
      ) : (
        <ul className="grid grid-cols-1 gap-[var(--grid-gap)] xl:grid-cols-2" aria-label={tb("trig.listAria")}>

          {d.items.map((t) => <TriggerRow key={t.id} t={t} def={kindMap.get(t.kind)} canEdit={canEdit} onPickDay={onPickDay} />)}
        </ul>
      )}
    </div>
  );
}
