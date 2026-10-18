/**
 * «Команда» (partners only) + shared helpers: per-trader table, capital & goal form, CSV export and the
 * «Как считается» popover. Nothing here renders for members — the page does not mount these blocks and the
 * server never sends per-trader rows or $ to them.
 */
import * as React from "react";
import { Download, HelpCircle, Landmark, Save, Users } from "lucide-react";
import { Link } from "wouter";
import { DataTable, EmptyState, Panel, SortableTh, Sparkline, useTableSort } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  fmtDay, fmtNum, fmtParen, fmtShare, fmtV, useSaveCapital,
  type AdminResponse, type AdminSetting, type OfficeView, type Rules, type TraderRow, type Unit,
} from "./api";
import { strategyColor, useDark } from "./palette";
import { downloadCsv } from "./csv";
import { TFOOT } from "./monthly";
import { profileHref } from "@/components/curator/curator-math";
import { PeopleSearchInput } from "@/components/people/people-search-input";
import { matchPerson, prepareQuery, usePeopleAliases } from "@/components/people/search";
import { fmtCount, fmtDate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { officeI18n } from "@/i18n/ns/officeStats";
import { personName } from "@/i18n";

/** Columns that only fit from ~1400px (the sparkline): hidden on a 1280 screen so the table needs no sideways scroll. */
const WIDE_ONLY = "hidden min-[1400px]:table-cell";

type TraderKey = "trader" | "net" | "share" | "trades" | "winRate" | "profitFactor" | "consistency" | "volume" | "maxDrawdown";
const TRADER_ACCESSORS: Record<TraderKey, (r: TraderRow) => number | string | null> = {
  trader: (r) => personName(r.trader),
  net: (r) => r.net,
  share: (r) => r.share,
  trades: (r) => r.trades,
  winRate: (r) => r.winRate,
  profitFactor: (r) => r.profitFactor,
  consistency: (r) => r.consistency,
  volume: (r) => r.volume,
  // «desc» puts the shallowest drawdown (0) first, the deepest last.
  maxDrawdown: (r) => r.maxDrawdown,
};

export function TradersTable({ view, unit, periodLabel }: { view: OfficeView; unit: Unit; periodLabel: string }) {
  const { t } = officeI18n.useT();
  const dark = useDark();
  const rows = React.useMemo(() => view.period.traders ?? [], [view]);
  const [q, setQ] = React.useState("");
  const aliases = usePeopleAliases();
  const shown = React.useMemo(() => {
    const pq = prepareQuery(q);
    return pq.empty ? rows : rows.filter((r) => matchPerson(pq, r.trader, aliases, r.topStrategy));
  }, [rows, q, aliases]);
  const { rows: sorted, thProps } = useTableSort(shown, TRADER_ACCESSORS, "net", "desc", { trader: "asc" });
  const tot = view.period.totals;
  // 12 columns: tighter cell padding so the table fits a 1280–1440 screen without a sideways scroll.
  const winners = rows.filter((r) => r.net > 0).length;
  const exportCsv = () => {
    const u = unit === "usd" ? "$" : "%";
    downloadCsv(`office-traders-${view.period.from}_${view.period.to}-${unit}.csv`, [
      [t("cols.trader"), t("cols.netUnit", { unit: u }), t("cols.netShare"), t("cols.trades"), "WR", "PF", t("cols.greenDays"), t("cols.volume"), t("cols.volShare"), t("cols.maxDdUnit", { unit: u }),
        t("cols.bestDay"), t("cols.bestDayUnit", { unit: u }), t("cols.worstDay"), t("cols.worstDayUnit", { unit: u }), t("cols.topStrategy")],
      ...sorted.map((r) => [personName(r.trader), r.net, r.share, r.trades, r.winRate, r.profitFactor, r.consistency, r.volume, r.volumeShare, r.maxDrawdown,
        r.bestDay?.date, r.bestDay?.v, r.worstDay?.date, r.worstDay?.v, r.topStrategy]),
    ]);
  };
  return (
    <Panel
      title={t("team.tradersTitle")}
      description={t("team.tradersDesc", { period: periodLabel })}
      icon={Users}
      actions={rows.length > 0 && (
        <>
          <PeopleSearchInput value={q} onChange={setQ} className="sm:w-56" inputClassName="h-8" />
          <span className="text-xs tabular-nums text-muted-foreground">{q ? `${t("team.filtered", { shown: shown.length, total: rows.length })} · ` : ""}{t("team.winners", { winners, total: rows.length })}</span>
          <Button variant="ghost" size="sm" onClick={exportCsv} aria-label={t("team.csvAria")}><Download className="h-4 w-4" /> CSV</Button>
        </>
      )}
    >
      {!rows.length ? <EmptyState compact icon={Users} title={t("states.noTradesPeriod")} /> : (
        <DataTable ariaLabel={t("team.tableAria")} stickyFirstCol maxHeight="70vh" className={cn(TFOOT, "[&_thead_th]:px-2 [&_tbody_td]:px-2 [&_tfoot_td]:px-2")}>
          <table>
            <thead>
              <tr>
                <SortableTh {...thProps("trader")}>{t("cols.trader")}</SortableTh>
                <th scope="col" className={cn("!px-1.5", WIDE_ONLY)}><span className="sr-only">{t("team.curve")}</span></th>
                <SortableTh {...thProps("net")} align="right">{t("cols.net")}</SortableTh>
                <SortableTh {...thProps("share")} align="right">{t("cols.share")}</SortableTh>
                <SortableTh {...thProps("trades")} align="right">{t("cols.trades")}</SortableTh>
                <SortableTh {...thProps("winRate")} align="right">WR</SortableTh>
                <SortableTh {...thProps("profitFactor")} align="right">PF</SortableTh>
                <SortableTh {...thProps("consistency")} align="right">{t("cols.greenDaysShort")}</SortableTh>
                <SortableTh {...thProps("volume")} align="right">{t("cols.volume")}</SortableTh>
                <SortableTh {...thProps("maxDrawdown")} align="right">{t("cols.maxDd")}</SortableTh>
                <th scope="col" className="whitespace-nowrap text-right" title={t("team.bestWorstTip")}>{t("team.bestWorst")}</th>
                <th scope="col">{t("cols.strategy")}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.trader}>
                  <td className="whitespace-nowrap font-medium">
                    <Link href={profileHref(r.trader)} className="rounded text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title={t("team.profile", { name: personName(r.trader) })}>{personName(r.trader)}</Link>
                  </td>
                  <td className={cn("!px-1.5", WIDE_ONLY)}><Sparkline data={r.spark} width={64} height={22} baseline={0} ariaLabel={t("team.curveOf", { name: personName(r.trader) })} /></td>
                  <td className={cn("whitespace-nowrap text-right font-semibold", r.net >= 0 ? "text-up" : "text-down")}>{fmtV(r.net, unit)}</td>
                  <td className={cn("text-right font-medium", r.share != null && r.share < 0 && "text-down")}>{fmtShare(r.share)}</td>
                  <td className="text-right">{fmtCount(r.trades)}</td>
                  <td className="text-right">{fmtShare(r.winRate)}</td>
                  <td className={cn("text-right", r.profitFactor != null && (r.profitFactor >= 1 ? "text-up" : "text-down"))}>{r.profitFactor != null ? r.profitFactor.toFixed(2) : "—"}</td>
                  <td className="text-right" title={t("team.greenTip")}>
                    <span className="inline-flex items-center justify-end gap-1.5">
                      <span className="relative hidden h-1.5 w-8 rounded-full bg-[var(--glass-bg)] 2xl:inline-block" aria-hidden="true"><span className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${(r.consistency ?? 0) * 100}%` }} /></span>
                      <span className="w-8">{fmtShare(r.consistency)}</span>
                    </span>
                  </td>
                  <td className="whitespace-nowrap text-right" title={r.volumeShare != null ? t("team.volumeTip", { volume: fmtNum(r.volume), share: fmtShare(r.volumeShare, 1) }) : undefined}>{fmtNum(r.volume)}</td>
                  <td className={cn("whitespace-nowrap text-right", r.maxDrawdown < 0 && "text-down")}>{r.maxDrawdown < 0 ? fmtV(r.maxDrawdown, unit) : "—"}</td>
                  <td className="whitespace-nowrap text-right text-xs leading-tight">
                    <span className="block text-up">{r.bestDay ? <>{fmtV(r.bestDay.v, unit)} <span className="text-muted-foreground">{fmtDay(r.bestDay.date)}</span></> : "—"}</span>
                    <span className="block text-down">{r.worstDay && r.worstDay.v < 0 ? <>{fmtV(r.worstDay.v, unit)} <span className="text-muted-foreground">{fmtDay(r.worstDay.date)}</span></> : "—"}</span>
                  </td>
                  <td>{r.topStrategy ? <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs"><span className="h-2 w-2 rounded-full" style={{ background: strategyColor(r.topStrategy, dark) }} aria-hidden="true" />{r.topStrategy}</span> : "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td className="left-0 !z-sticky-corner">{t("team.office")}</td>
                <td className={WIDE_ONLY} />
                <td className={cn("whitespace-nowrap text-right", tot.net >= 0 ? "text-up" : "text-down")}>{fmtV(tot.net, unit)}</td>
                <td className="text-right">100%</td>
                <td className="text-right">{fmtCount(tot.trades)}</td>
                <td className="text-right">{fmtShare(tot.winRate)}</td>
                <td className="text-right">{tot.profitFactor != null ? tot.profitFactor.toFixed(2) : "—"}</td>
                <td className="text-right">{tot.tradingDays ? fmtShare(tot.greenDays / tot.tradingDays) : "—"}</td>
                <td className="text-right">{tot.volume != null ? fmtNum(tot.volume) : "—"}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </DataTable>
      )}
    </Panel>
  );
}

function CapitalRow({ s, onSaved }: { s: AdminSetting; onSaved: () => void }) {
  const { t } = officeI18n.useT();
  const save = useSaveCapital();
  const { toast } = useToast();
  const [capital, setCapital] = React.useState(s.capital != null ? String(s.capital) : "");
  const [goal, setGoal] = React.useState(String(s.goalPct));
  React.useEffect(() => { setCapital(s.capital != null ? String(s.capital) : ""); setGoal(String(s.goalPct)); }, [s.capital, s.goalPct]);
  const capNum = capital.trim() === "" ? null : Number(capital.replace(/[\s,]/g, ""));
  const goalNum = Number(goal.replace(",", "."));
  const capValid = capNum == null || (Number.isFinite(capNum) && capNum > 0 && capNum <= 1e11);
  // The server accepts 0 < goal ≤ 1000 %.
  const goalValid = Number.isFinite(goalNum) && goalNum > 0 && goalNum <= 1000;
  const goalUsd = capValid && capNum != null && goalValid ? (capNum * goalNum) / 100 : null;
  const clearing = capNum == null && s.capital != null;
  const dirty = capNum !== s.capital || goalNum !== s.goalPct;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!capValid || !goalValid) return;
    save.mutate({ year: s.year, capital: capNum, goalPct: goalNum }, {
      onSuccess: () => { toast({ title: t("capital.savedYear", { year: s.year }) }); onSaved(); },
      onError: (err) => toast({ title: t("capital.notSaved"), description: err instanceof Error ? err.message : String(err), variant: "destructive" }),
    });
  };
  return (
    <form onSubmit={submit} className="tile grid grid-cols-2 items-end gap-2 p-3 sm:grid-cols-[3.5rem_minmax(7.5rem,1fr)_5.5rem_auto]">
      <span className="col-span-2 text-sm font-semibold text-foreground sm:col-span-1 sm:pb-2">{s.year}</span>
      <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
        {t("capital.capitalLabel")}
        <Input inputMode="decimal" value={capital} onChange={(e) => setCapital(e.target.value)} placeholder={t("capital.notSet")} aria-invalid={!capValid} className={cn("tabular-nums", !capValid && "border-destructive")} />
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
        {t("capital.goalLabel")}
        <Input inputMode="decimal" value={goal} onChange={(e) => setGoal(e.target.value)} aria-invalid={!goalValid} className={cn("tabular-nums", !goalValid && "border-destructive")} />
      </label>
      <Button type="submit" size="sm" disabled={!dirty || !capValid || !goalValid || save.isPending} className="col-span-2 sm:col-span-1">
        <Save className="h-4 w-4" /> {save.isPending ? t("capital.saving") : commonI18n.t("actions.save")}
      </Button>
      <p className="col-span-2 flex flex-wrap gap-x-3 text-2xs text-muted-foreground sm:col-span-4">
        {clearing ? (
          <span className="text-warn">{t("capital.clearingWarn", { year: s.year })}</span>
        ) : capNum != null && capValid ? (
          <span className="tabular-nums">{t("capital.summary", { capital: fmtV(capNum, "usd", { signed: false }), goal: goalUsd != null ? fmtV(goalUsd, "usd") : "—" })}</span>
        ) : !capValid ? (
          <span className="text-destructive">{t("capital.capitalInvalid")}</span>
        ) : null}
        {!goalValid && <span className="text-destructive">{t("capital.goalInvalid")}</span>}
        {s.updatedBy && <span>{t("capital.changedBy", { name: personName(s.updatedBy) })}{s.updatedAt ? ` · ${fmtDate(s.updatedAt, "short")}` : ""}</span>}
      </p>
    </form>
  );
}

export function CapitalPanel({ data }: { data: AdminResponse }) {
  const { t } = officeI18n.useT();
  const years = [...data.settings].sort((a, b) => b.year - a.year);
  return (
    <Panel
      id="capital"
      title={t("capital.title")}
      description={t("capital.desc")}
      icon={Landmark}
      fill
      className="lg:col-span-6"
    >
      <div className="flex flex-col gap-2">
        {years.map((s) => <CapitalRow key={s.year} s={s} onSaved={() => undefined} />)}
        <p className="text-2xs text-muted-foreground">{t("capital.footnote")}</p>
      </div>
    </Panel>
  );
}

// ─── CSV export (partners) ─────────────────────────────────────────────────────

export function exportCsv(data: AdminResponse, unit: Unit) {
  const t = officeI18n.t;
  const avgR = commonI18n.t("trading.avgR");
  const view = unit === "usd" ? data.usd : data.pct;
  const u = unit === "usd" ? "$" : "%";
  const rows: unknown[][] = [];
  const row = (...c: unknown[]) => rows.push(c);
  row(t("csv.header", { from: view.period.from, to: view.period.to, unit: u }));
  row();
  row(t("csv.days")); row(t("cols.date"), t("cols.year"), t("cols.netUnit", { unit: u }), t("cols.ytdUnit", { unit: u }), t("cols.trades"));
  for (const y of view.years) for (const d of y.days) row(d.date, y.year, d.v, d.cum, d.trades);
  row();
  row(t("csv.strategies")); row(t("cols.strategy"), t("cols.trades"), "WR", "PF", avgR, t("cols.netUnit", { unit: u }), t("cols.netShare"), t("cols.volShare"), t("cols.volume"));
  for (const s of view.period.strategies) row(s.key, s.trades, s.winRate, s.profitFactor, s.avgR, s.net, s.netShare, s.volumeShare, s.volume);
  row();
  row(t("csv.traders")); row(t("cols.trader"), t("cols.trades"), t("cols.netUnit", { unit: u }), t("cols.share"), "WR", "PF", t("cols.greenDays"), t("cols.volume"), t("cols.maxDdUnit", { unit: u }), t("cols.strategy"));
  for (const r of view.period.traders ?? []) row(personName(r.trader), r.trades, r.net, r.share, r.winRate, r.profitFactor, r.consistency, r.volume, r.maxDrawdown, r.topStrategy);
  row();
  row(t("csv.months")); row(t("cols.year"), t("cols.month"), t("cols.netUnit", { unit: u }), t("cols.days"), t("cols.green"), t("cols.red"));
  for (const y of view.years) for (const m of y.months) if (m.days) row(y.year, m.month, m.v, m.days, m.green, m.red);
  downloadCsv(`office-stats-${view.period.from}_${view.period.to}-${unit}.csv`, rows);
}

export function CsvButton({ data, unit }: { data: AdminResponse; unit: Unit }) {
  const { t } = officeI18n.useT();
  return (
    <Button variant="outline" size="sm" onClick={() => exportCsv(data, unit)} title={t("csv.button")}>
      <Download className="h-4 w-4" /> CSV
    </Button>
  );
}

// ─── «Как считается» ─────────────────────────────────────────────────────────

export function RulesPopover({ rules, isAdmin }: { rules: Rules; isAdmin: boolean }) {
  const { t } = officeI18n.useT();
  const dark = useDark();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm"><HelpCircle className="h-4 w-4" /> {t("rules.button")}</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,30rem)] max-h-[70vh] overflow-y-auto text-sm">
        <p className="font-semibold text-foreground">{t("rules.button")}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("rules.intro")}
          {isAdmin ? t("rules.admin") : t("rules.member")}
        </p>
        <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("rules.strategiesNy")}</p>
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {rules.strategies.map((s) => (
            <li key={s.key} className="flex gap-2 text-xs">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: strategyColor(s.key, dark) }} aria-hidden="true" />
              <span><b className="text-foreground">{s.key}</b> — <span className="text-muted-foreground">{s.text}</span></span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">{rules.order}</p>
        {rules.notes.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
            {rules.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">{t("rules.insightsNote")}</p>
      </PopoverContent>
    </Popover>
  );
}

export { fmtParen };
