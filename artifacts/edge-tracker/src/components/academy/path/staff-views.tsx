/** Mentor views of «Путь трейдера»: funnel by stage, request queue, criteria editor. */
import * as React from "react";
import { Filter, Inbox, Plus, Save, Settings2, Trash2 } from "lucide-react";
import { EmptyState, Panel, Pill } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  type Criterion, type PathConfig, type StageKey, OP_LABEL, OPS,
  fmtInstant, useFunnel, usePathMutation, useRequests,
} from "./api";
import { http } from "@/lib/api/http";
import { academyPathI18n } from "@/i18n/ns/academyPath";
import { commonI18n } from "@/i18n/ns/common";
import { shellI18n } from "@/i18n/ns/shell";
import { personName } from "@/i18n";
import { StageLadder, selectCls } from "./bits";
import { PendingRequest } from "./person-view";
import { criterionLabel, criterionLabelByText, headlineText, metricHint, metricLabel, stageName, stageTitle } from "./labels";
import { fmtUsd } from "@/lib/format";

// ─── funnel ─────────────────────────────────────────────────────────────────

export function FunnelView({ onOpen }: { onOpen: (user: string) => void }) {
  const { t } = academyPathI18n.useT();
  const q = useFunnel(true);
  if (q.isLoading) return <Skeleton className="h-80 rounded-2xl" />;
  if (q.isError || !q.data) return <Panel><EmptyState icon={Filter} title={t("funnel.unavailable")} description={(q.error as Error | null)?.message} /></Panel>;
  const f = q.data;
  const counts = Object.fromEntries(f.columns.map((c) => [c.key, c.people.length])) as Partial<Record<StageKey, number>>;
  return (
    <div className="flex flex-col gap-4">
      <StageLadder stages={f.stages} current={null} counts={counts} />
      <p className="text-sm text-muted-foreground" role="status">
        {t("funnel.inFunnel", { count: f.totals.people })}
        {" · "}<span className={cn(f.totals.ready > 0 && "font-semibold text-up")}>{t("funnel.ready", { count: f.totals.ready })}</span>
        {" · "}{t("funnel.pending", { count: f.totals.pending })}
      </p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {f.columns.map((col) => (
          <Panel key={col.key} title={col.key === "none" ? t("stage.unassigned") : stageName(f.stages, col.key)} description={t("stage.people", { count: col.people.length })} bodyClassName="flex flex-col gap-2">
            {col.people.length === 0 && <p className="text-xs text-muted-foreground">{t("funnel.empty")}</p>}
            {col.people.map((p) => {
              const pct = p.total ? p.passed / p.total : 0;
              const cur = p.stage ? stageName(f.stages, p.stage) : null;
              const next = p.nextStage ? stageName(f.stages, p.nextStage) : null;
              return (
                <button
                  key={p.user}
                  type="button"
                  onClick={() => onOpen(p.user)}
                  className={cn("flex flex-col gap-1.5 rounded-xl border p-2.5 text-left transition-colors hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    p.ready ? "border-up/50" : "border-[var(--field-border)]")}
                  aria-label={`${personName(p.user)}: ${headlineText({ stage: cur, next, passed: p.passed, total: p.total, ready: p.ready })}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-foreground" title={personName(p.user)}>{personName(p.user)}</span>
                    {p.pendingRequestId ? <Pill tone="accent" className="shrink-0">{t("funnel.pill.request")}</Pill> : p.ready ? <Pill tone="up" className="shrink-0">{t("funnel.pill.ready")}</Pill> : null}
                  </div>
                  {p.stage && (
                    <>
                      {/* The top stage has no next step and no criteria: no «0 из 0» bar. */}
                      {p.total > 0 && (
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--glass-bg)]" aria-hidden="true">
                          <div className={cn("h-full rounded-full", p.ready ? "bg-up" : pct >= 0.7 ? "bg-[hsl(var(--chart-3))]" : "bg-primary")} style={{ width: `${pct * 100}%` }} />
                        </div>
                      )}
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {[
                          p.total > 0 ? commonI18n.t("states.ofTotal", { value: p.passed, total: p.total }) : null,
                          t("funnel.pnlWindow", { pnl: fmtUsd(p.summary.net, { decimals: 0 }), count: p.summary.windowDays }),
                        ].filter(Boolean).join(" · ")}
                      </span>
                      {p.failing.length > 0 && (
                        <span className="line-clamp-2 text-[11px] text-muted-foreground">
                          {t("funnel.missing", { list: p.failing.map((l) => criterionLabelByText(l, p.stage)).join(", ") })}
                        </span>
                      )}
                    </>
                  )}
                  {!p.stage && <span className="text-xs text-muted-foreground">{t("funnel.assignStage")}</span>}
                </button>
              );
            })}
          </Panel>
        ))}
      </div>
    </div>
  );
}

// ─── requests ───────────────────────────────────────────────────────────────

export function RequestsView({ config, me, onOpen }: { config: PathConfig | undefined; me: string | null; onOpen: (user: string) => void }) {
  const { t } = academyPathI18n.useT();
  const pending = useRequests("pending", true);
  const all = useRequests(null, true);
  const stages = config?.stages ?? [];
  if (pending.isLoading) return <Skeleton className="h-60 rounded-2xl" />;
  const decided = (all.data?.requests ?? []).filter((r) => r.status !== "pending").slice(0, 30);
  return (
    <div className="flex flex-col gap-4">
      {pending.data?.requests.length
        ? pending.data.requests.map((r) => (
          <div key={r.id} className="flex flex-col gap-1">
            <button type="button" className="self-start text-sm font-semibold text-primary hover:underline" onClick={() => onOpen(r.user)}>{t("requests.openReport", { user: personName(r.user) })}</button>
            <PendingRequest req={r} canDecide={r.user !== me} isSelf={r.user === me} stages={stages} />
          </div>
        ))
        : <Panel><EmptyState icon={Inbox} title={t("requests.emptyTitle")} description={t("requests.emptyDescription", { page: shellI18n.t("nav.academyPath") })} /></Panel>}
      {decided.length > 0 && (
        <Panel title={t("requests.decidedTitle")}>
          <ul className="flex flex-col gap-2 text-sm">
            {decided.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
                <Pill tone={r.status === "approved" ? "up" : r.status === "rejected" ? "down" : "neutral"} className="shrink-0">{t(`requests.status.${r.status}`)}</Pill>
                <button type="button" className="font-medium text-foreground hover:underline" onClick={() => onOpen(r.user)}>
                  {personName(r.user)}: {stageName(stages, r.fromStage)} → {stageName(stages, r.toStage)}
                </button>
                <span className="text-xs text-muted-foreground">{personName(r.decidedBy)} · {fmtInstant(r.decidedAt)}</span>
                {r.decisionComment && <span className="w-full text-xs text-muted-foreground">«{r.decisionComment}»</span>}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

// ─── criteria editor ────────────────────────────────────────────────────────

type Draft = Omit<Criterion, "id"> & { id?: number; _k: string };
let seq = 0;
const toDraft = (c: Criterion): Draft => ({ ...c, _k: `c${c.id}` });

export function CriteriaEditor({ config }: { config: PathConfig }) {
  const { t } = academyPathI18n.useT();
  const { toast } = useToast();
  const [rows, setRows] = React.useState<Draft[]>(() => config.criteria.map(toDraft));
  React.useEffect(() => setRows(config.criteria.map(toDraft)), [config.criteria]);
  const save = usePathMutation((body: unknown) => http.put<{ criteria: Criterion[] }>("/api/academy/path/criteria", body));
  const metrics = config.meta.metrics;
  const from = config.stages.slice(0, -1);
  const upd = (k: string, patch: Partial<Draft>) => setRows((rs) => rs.map((r) => (r._k === k ? { ...r, ...patch } : r)));

  if (!config.canEdit) return <Panel><EmptyState icon={Settings2} title={t("editor.staffOnly")} /></Panel>;

  return (
    <div className="flex flex-col gap-4">
      {from.map((st, i) => {
        const list = rows.filter((r) => r.fromStage === st.key);
        const to = config.stages[i + 1];
        return (
          <Panel key={st.key} title={`«${stageTitle(st)}» → «${to ? stageTitle(to) : ""}»`}
            description={`${t("editor.active", { count: list.filter((r) => r.enabled).length })}. ${t("editor.windowHint")}`}
            actions={<Button size="sm" variant="outline" onClick={() => setRows((rs) => [...rs, { _k: `n${++seq}`, fromStage: st.key, metric: "net_pnl", op: ">=", value: 0, windowDays: 20, label: null, enabled: true }])}><Plus className="mr-1 h-4 w-4" aria-hidden="true" />{t("editor.addCriterion")}</Button>}>
            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-1 pr-2 font-medium">{t("editor.cols.enabled")}</th>
                    <th scope="col" className="py-1 pr-2 font-medium">{t("editor.cols.metric")}</th>
                    <th scope="col" className="py-1 pr-2 font-medium">{t("editor.cols.op")}</th>
                    <th scope="col" className="py-1 pr-2 font-medium">{t("editor.cols.value")}</th>
                    <th scope="col" className="whitespace-nowrap py-1 pr-2 font-medium">{t("editor.cols.window")}</th>
                    <th scope="col" className="py-1 pr-2 font-medium">{t("editor.cols.label")}</th>
                    <th scope="col" className="py-1 font-medium"><span className="sr-only">{t("editor.cols.remove")}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => {
                    const meta = metrics.find((m) => m.key === r.metric);
                    const metaLabel = meta ? metricLabel(meta.key, meta.label) : undefined;
                    return (
                      <tr key={r._k} className="border-t border-[var(--field-border)]">
                        <td className="py-1.5 pr-2"><input type="checkbox" aria-label={t("editor.enabledAria")} checked={r.enabled} onChange={(e) => upd(r._k, { enabled: e.target.checked })} className="h-4 w-4 accent-[hsl(var(--primary))]" /></td>
                        <td className="py-1.5 pr-2">
                          <select aria-label={t("editor.cols.metric")} className={cn(selectCls, "w-full")} value={r.metric} title={meta ? metricHint(meta.key, meta.hint) : undefined} onChange={(e) => upd(r._k, { metric: e.target.value })}>
                            {metrics.map((m) => <option key={m.key} value={m.key}>{metricLabel(m.key, m.label)}</option>)}
                          </select>
                        </td>
                        <td className="py-1.5 pr-2">
                          <select aria-label={t("editor.cols.op")} className={selectCls} value={r.op} onChange={(e) => upd(r._k, { op: e.target.value as Criterion["op"] })}>
                            {OPS.map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
                          </select>
                        </td>
                        <td className="py-1.5 pr-2"><input type="number" aria-label={t("editor.cols.value")} className={cn(selectCls, "w-28 tabular-nums")} value={r.value} step="any" onChange={(e) => upd(r._k, { value: Number(e.target.value) })} /></td>
                        <td className="py-1.5 pr-2"><input type="number" aria-label={t("editor.windowAria")} className={cn(selectCls, "w-24 tabular-nums")} value={r.windowDays ?? ""} min={1} max={260} placeholder={t("editor.windowPlaceholder")} onChange={(e) => upd(r._k, { windowDays: e.target.value === "" ? null : Math.round(Number(e.target.value)) })} /></td>
                        <td className="py-1.5 pr-2"><input aria-label={t("editor.labelAria")} className={cn(selectCls, "w-full")} value={r.label ?? ""} maxLength={120} placeholder={metaLabel} title={r.label && criterionLabel(r.label, r.metric, st.key) !== r.label ? criterionLabel(r.label, r.metric, st.key) : undefined} onChange={(e) => upd(r._k, { label: e.target.value || null })} /></td>
                        <td className="py-1.5"><Button size="icon" variant="ghost" aria-label={t("editor.removeAria")} title={t("editor.removeAria")} onClick={() => setRows((rs) => rs.filter((x) => x._k !== r._k))}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={save.isPending}
          onClick={() => save.mutate(rows.map(({ _k, ...r }) => ({ ...r, value: Number.isFinite(r.value) ? r.value : 0 })), {
            onSuccess: () => toast({ title: t("editor.saved"), description: t("editor.savedDescription") }),
            onError: (err) => toast({ title: commonI18n.t("states.notSaved"), description: (err as Error).message, variant: "destructive" }),
          })}
        ><Save className="mr-1.5 h-4 w-4" aria-hidden="true" />{t("editor.save")}</Button>
        <Button variant="ghost" onClick={() => setRows(config.criteria.map(toDraft))}>{t("editor.reset")}</Button>
      </div>
    </div>
  );
}
