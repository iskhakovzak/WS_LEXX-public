/**
 * Sync history: propreports_sync_runs table with expandable error text / details.
 */
import * as React from "react";
import { ChevronDown, ChevronRight, History } from "lucide-react";
import { DataTable, EmptyState, Panel, Pill, SortableTh, useTableSort, type Tone } from "@/components/ds";
import { runStatusLabel, type SyncRun } from "./api";
import { fmtDate } from "@/lib/format";
import { propreportsI18n } from "@/i18n/ns/propreports";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

const STATUS_TONE: Record<SyncRun["status"], Tone> = { running: "accent", ok: "up", partial: "warn", error: "down" };

const STATUS_RANK: Record<SyncRun["status"], number> = { running: 0, ok: 1, partial: 2, error: 3 };

const RUN_ACCESSORS = {
  when: (r: SyncRun) => Date.parse(r.startedAt) || null,
  source: (r: SyncRun) => r.source,
  period: (r: SyncRun) => r.fileName ?? r.dateFrom ?? null,
  status: (r: SyncRun) => STATUS_RANK[r.status] ?? null,
  inserted: (r: SyncRun) => r.inserted,
  updated: (r: SyncRun) => r.updated,
  unchanged: (r: SyncRun) => r.unchanged,
  conflicts: (r: SyncRun) => r.conflicts,
  skipped: (r: SyncRun) => r.skipped,
  errors: (r: SyncRun) => r.errors,
  actor: (r: SyncRun) => (r.actor ? personName(r.actor) : r.actor),
};
const RUN_FIRST_DIR = { source: "asc", period: "asc", actor: "asc" } as const;

export function SyncHistory({ runs, loading }: { runs: SyncRun[]; loading: boolean }) {
  const { t } = propreportsI18n.useT();
  const [open, setOpen] = React.useState<Set<number>>(() => new Set());
  const sort = useTableSort(runs, RUN_ACCESSORS, "when", "desc", RUN_FIRST_DIR);
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Panel title={t("history.title")} description={t("history.description")} icon={History}>
      {loading ? (
        <div className="py-6 text-center text-sm text-muted-foreground">{commonI18n.t("states.loading")}</div>
      ) : !runs.length ? (
        <EmptyState icon={History} title={t("history.empty")} />
      ) : (
        <DataTable maxHeight="70vh" ariaLabel={t("history.title")} className="[&_tbody_td]:px-2 [&_thead_th]:px-2">
          <table>
            <thead>
              <tr>
                <th className="w-6" />
                <SortableTh {...sort.thProps("when")}>{t("history.col.when")}</SortableTh>
                <SortableTh {...sort.thProps("source")}>{t("history.col.source")}</SortableTh>
                <SortableTh {...sort.thProps("period")}>{t("history.col.period")}</SortableTh>
                <SortableTh {...sort.thProps("status")}>{t("history.col.status")}</SortableTh>
                <SortableTh {...sort.thProps("inserted")} align="right">{t("history.col.inserted")}</SortableTh>
                <SortableTh {...sort.thProps("updated")} align="right">{t("history.col.updated")}</SortableTh>
                <SortableTh {...sort.thProps("unchanged")} align="right">{t("history.col.unchanged")}</SortableTh>
                <SortableTh {...sort.thProps("conflicts")} align="right">{t("history.col.conflicts")}</SortableTh>
                <SortableTh {...sort.thProps("skipped")} align="right">{t("history.col.skipped")}</SortableTh>
                <SortableTh {...sort.thProps("errors")} align="right">{t("history.col.errors")}</SortableTh>
                <SortableTh {...sort.thProps("actor")}>{t("history.col.actor")}</SortableTh>
              </tr>
            </thead>
            <tbody>
              {sort.rows.map((r) => {
                const isOpen = open.has(r.id);
                const expandable = !!r.errorText || !!r.details;
                const st = { label: runStatusLabel(r.status), tone: STATUS_TONE[r.status] ?? ("neutral" as Tone) };
                const dur = r.finishedAt ? Math.max(0, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000)) : null;
                return (
                  <React.Fragment key={r.id}>
                    <tr>
                      <td>
                        {expandable && (
                          <button type="button" onClick={() => toggle(r.id)} aria-expanded={isOpen} aria-label={t("history.details")} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                            {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          </button>
                        )}
                      </td>
                      <td className="whitespace-nowrap">{fmtDate(r.startedAt, "numericDateTime")}{dur != null && <span className="text-muted-foreground"> · {commonI18n.t("time.secondsShort", { count: dur })}</span>}</td>
                      <td>{r.source === "api" ? <Pill tone="accent">API</Pill> : <Pill tone="neutral">{t("file")}</Pill>}</td>
                      <td className="max-w-[10rem] truncate text-xs text-muted-foreground" title={r.fileName ?? undefined}>{r.fileName ?? (r.dateFrom ? `${r.dateFrom} → ${r.dateTo}` : "—")}</td>
                      <td><Pill tone={st.tone} dot>{st.label}</Pill></td>
                      <td className="text-right">{r.inserted}</td>
                      <td className="text-right">{r.updated}</td>
                      <td className="text-right text-muted-foreground">{r.unchanged}</td>
                      <td className="text-right">{r.conflicts ? <span className="text-[hsl(var(--chart-3))]">{r.conflicts}</span> : 0}</td>
                      <td className="text-right text-muted-foreground">{r.skipped}</td>
                      <td className="text-right">{r.errors ? <span className="text-down">{r.errors}</span> : 0}</td>
                      <td className="text-xs">{r.actor ? personName(r.actor) : "—"}</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td />
                        <td colSpan={11} className="!py-2">
                          {r.errorText && <pre className="mb-2 whitespace-pre-wrap rounded-lg bg-down/10 p-2 text-xs text-down">{r.errorText}</pre>}
                          {r.details && <pre className="max-w-[min(90vw,64rem)] whitespace-pre-wrap break-words text-2xs text-muted-foreground">{JSON.stringify(r.details, null, 1)}</pre>}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </DataTable>
      )}
    </Panel>
  );
}
