import { type ReactNode, useMemo, useState } from "react";
import { Link } from "wouter";
import { Check, ChevronDown, Plus, Receipt, Scissors, Target } from "lucide-react";
import { DataTable, Panel, Pill, SortableTh, TermTooltip, toneOf, useTableSort } from "@/components/ds";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { commonI18n } from "@/i18n/ns/common";
import { whatIfI18n } from "@/i18n/ns/whatIf";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import type { FeeGroupRow, FeesResponse, Preset } from "./api";
import { TARIFF_EXAMPLES } from "./presets";
import { type CommissionPlan, type PreviewTrade, type Rule, isApplied, planSummary } from "./rules";
import { fmtDate, fmtNum, fmtRate, fmtUsd } from "@/lib/format";

type EatenRow = FeesResponse["eaten"][number];


/** 0 → transparent, 1+ → full warn tint. Colour plus the number, never colour alone. */
function heat(v: number | null): string | undefined {
  if (v == null) return undefined;
  const a = Math.min(1, Math.max(0, v)) * 0.4;
  return `hsl(var(--warn) / ${a.toFixed(2)})`;
}

type PlanParams = Omit<CommissionPlan, "type">;
type PlanRow = { id: string; label: string; note?: string; plan: PlanParams | null };

/** Generic example tariffs for the comparison (shared with the «Другой тариф» question). */
const EXAMPLE_PLANS: PlanRow[] = TARIFF_EXAMPLES;

/**
 * Fees block: one clear headline («комиссии съедают X% брутто»), the break-even move per share, a plan comparison
 * computed in the browser with the same formula as the server engine, and the detailed breakdown on demand.
 */
export function FeesBlock({
  trades,
  data,
  isLoading,
  presets,
  rules,
  canApplyPlan,
  onApplyPlan,
  costsByGroup,
}: {
  trades: PreviewTrade[];
  data: FeesResponse | undefined;
  isLoading: boolean;
  presets: Preset[];
  rules: Rule[];
  canApplyPlan: boolean;
  onApplyPlan: (r: CommissionPlan) => void;
  /** The per-trader / account / month / setup / horizon cost table (/api/edge/costs), composed by the page. */
  costsByGroup?: React.ReactNode;
}) {
  const { t } = whatIfI18n.useT();
  const fact = useMemo(() => planSummary(trades, null), [trades]);
  const [custom, setCustom] = useState({ perShare: "0.003", minPerOrder: "0.5", ecnPerShare: "0.002" });
  const customPlan = useMemo<PlanParams | null>(() => {
    const p = Number(custom.perShare), m = Number(custom.minPerOrder), e = Number(custom.ecnPerShare);
    return [p, m, e].every((x) => Number.isFinite(x) && x >= 0) ? { perShare: p, minPerOrder: m, ecnPerShare: e, keepRegulatory: true } : null;
  }, [custom]);

  const rows = useMemo<PlanRow[]>(() => {
    const fromPresets: PlanRow[] = [];
    for (const p of presets) {
      const r = p.rules.find((x): x is CommissionPlan => x.type === "commissionPlan");
      if (r && p.rules.length === 1) fromPresets.push({ id: `preset-${p.id}`, label: p.label, note: p.description, plan: { perShare: r.perShare, minPerOrder: r.minPerOrder, ecnPerShare: r.ecnPerShare, keepRegulatory: r.keepRegulatory } });
    }
    return [{ id: "fact", label: t("fees.current"), note: t("fees.currentNote"), plan: null }, ...fromPresets, ...EXAMPLE_PLANS];
  }, [presets, t]);

  const eatenPct = fact.feePctOfGross;
  const grossPositive = fact.gross > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
            {grossPositive && eatenPct != null ? (
              <EatsHeadline pct={eatenPct} />
            ) : (
              <>{t("fees.period", { amount: "" })}<span className="tabular-nums">{fmtUsd(Math.abs(fact.fees))}</span></>
            )}
          </p>
          <p className="mt-1 text-sm text-muted-foreground tabular-nums">
            {t("fees.flow", { gross: fmtUsd(fact.gross, { signed: true, decimals: "auto" }) })} <span className={cn("font-medium", toneOf(fact.net) === "down" ? "text-down" : "text-foreground")}>{fmtUsd(fact.net, { signed: true, decimals: "auto" })}</span>{t("fees.took", { fees: fmtUsd(Math.abs(fact.fees)), trades: commonI18n.t("units.trades", { count: fact.trades }) })}
            {fact.trades ? ` ${t("fees.perTrade", { amount: fmtUsd(Math.abs(fact.fees / fact.trades)) })}` : ""}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-[var(--grid-gap)] md:grid-cols-3">
        <Fact
          icon={Target}
          title={t("fees.breakEven")}
          value={fmtNum(fact.breakEvenCents, { decimals: 1, suffix: " ¢" })}
          text={
            data?.breakEvenCents != null && data.typicalQty != null
              ? t("fees.breakEvenText", { qty: Math.round(data.typicalQty), cents: fmtNum(data.breakEvenCents, { decimals: 1, suffix: " ¢" }) })
              : t("fees.breakEvenTextBare")
          }
        />
        <Fact
          icon={Scissors}
          title={t("fees.eatenTitle")}
          value={isLoading || !data ? "…" : commonI18n.t("units.trades", { count: data.eatenCount })}
          tone={data?.eatenCount ? "down" : undefined}
          text={data ? `${t("fees.eatenText")}${data.feesOverGrossCount ? ` ${t("fees.overGross", { count: data.feesOverGrossCount })}` : ""}` : t("fees.eatenTextBare")}
        />
        <Fact
          icon={Receipt}
          title={t("fees.composition")}
          value={data?.byType[0] ? `${data.byType[0].label} ${fmtRate(data.byType[0].share)}` : "…"}
          text={data?.byType.length ? data.byType.slice(1, 4).map((b) => `${b.label} ${fmtRate(b.share)}`).join(" · ") || t("fees.onlyItem") : t("fees.compositionBare")}
        />
      </div>

      <div>
        <p className="mb-2 text-sm font-semibold">{t("fees.compare")}</p>
        <DataTable ariaLabel={t("fees.compareAria")}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t("fees.colPlan")}</th>
                <th scope="col" className="text-right">{t("fees.colFees")}</th>
                <th scope="col" className="text-right">{t("fees.colNet")}</th>
                <th scope="col" className="text-right">{t("fees.colOfGross")}</th>
                <th scope="col" className="text-right" title={t("fees.colBreakEvenTitle")}>{t("fees.colBreakEven")}</th>
                <th scope="col" className="text-right">{t("fees.colDiff")}</th>
                <th scope="col" className="w-0"><span className="sr-only">{t("fees.colAction")}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <PlanTr key={row.id} row={row} trades={trades} fact={fact.net} rules={rules} canApply={canApplyPlan} onApply={onApplyPlan} />
              ))}
              <PlanTr
                row={{ id: "custom", label: t("fees.custom"), plan: customPlan }}
                trades={trades}
                fact={fact.net}
                rules={rules}
                canApply={canApplyPlan}
                onApply={onApplyPlan}
                editor={
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    $<Input aria-label={t("fees.perShareAria")} value={custom.perShare} onChange={(e) => setCustom((c) => ({ ...c, perShare: e.target.value }))} className="h-7 w-16 rounded-full px-2 text-xs tabular-nums" inputMode="decimal" />{t("fees.perShareUnit")}{" "}
                    {t("fees.minLabel")}<Input aria-label={t("fees.minAria")} value={custom.minPerOrder} onChange={(e) => setCustom((c) => ({ ...c, minPerOrder: e.target.value }))} className="h-7 w-14 rounded-full px-2 text-xs tabular-nums" inputMode="decimal" />
                    ECN $<Input aria-label={t("fees.ecnAria")} value={custom.ecnPerShare} onChange={(e) => setCustom((c) => ({ ...c, ecnPerShare: e.target.value }))} className="h-7 w-16 rounded-full px-2 text-xs tabular-nums" inputMode="decimal" />
                  </span>
                }
              />
            </tbody>
          </table>
        </DataTable>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t("fees.note")}
        </p>
      </div>

      {data?.recommendations.length ? (
        <ul className="flex flex-col gap-1.5 text-sm">
          {data.recommendations.map((r, i) => <li key={i} className="rounded-xl bg-[var(--glass-bg)] px-3 py-2">{r}</li>)}
        </ul>
      ) : null}

      <FeeDetails data={data} isLoading={isLoading} costsByGroup={costsByGroup} />
    </div>
  );
}

/** «Комиссии съедают 34% брутто» — the share and the glossary term are styled parts of one sentence. */
function EatsHeadline({ pct }: { pct: number }) {
  const { t } = whatIfI18n.useT();
  const parts = t("fees.eats", { pct: "\u0000", gross: "\u0001" }).split(/(\u0000|\u0001)/);
  return (
    <>
      {parts.map((p, i) =>
        p === "\u0000" ? <span key={i} className={cn("tabular-nums", pct >= 0.5 ? "text-down" : pct >= 0.25 ? "text-warn" : "text-foreground")}>{fmtRate(pct)}</span>
          : p === "\u0001" ? <TermTooltip key={i} term="gross">{t("fees.grossWord")}</TermTooltip>
            : p)}
    </>
  );
}

function Fact({ icon: Icon, title, value, text, tone }: { icon: typeof Target; title: string; value: string; text: string; tone?: "down" }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl bg-[var(--glass-bg)] p-3">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon className="h-3.5 w-3.5" aria-hidden="true" />{title}</span>
      <span className={cn("text-lg font-semibold tabular-nums", tone === "down" ? "text-down" : "text-foreground")}>{value}</span>
      <span className="text-xs leading-snug text-muted-foreground">{text}</span>
    </div>
  );
}

function PlanTr({
  row, trades, fact, rules, canApply, onApply, editor,
}: {
  row: PlanRow; trades: PreviewTrade[]; fact: number; rules: Rule[]; canApply: boolean; onApply: (r: CommissionPlan) => void; editor?: ReactNode;
}) {
  const s = useMemo(() => planSummary(trades, row.plan), [trades, row.plan]);
  const d = row.plan ? s.net - fact : null;
  const rule: CommissionPlan | null = row.plan ? { type: "commissionPlan", ...row.plan, keepRegulatory: row.plan.keepRegulatory ?? true } : null;
  const applied = rule ? isApplied(rules, rule) : false;
  const { t } = whatIfI18n.useT();
  return (
    <tr className={cn("[&>td:not(:first-child)]:whitespace-nowrap", !row.plan && "bg-[var(--glass-bg)]")}>
      <td>
        <span className="font-medium">{row.label}</span>
        {row.note && <span className="block text-xs text-muted-foreground">{row.note}</span>}
        {editor}
      </td>
      <td className="text-right">{fmtUsd(Math.abs(s.fees))}</td>
      <td className={cn("text-right font-medium", s.net > 0 ? "text-up" : s.net < 0 ? "text-down" : "")}>{fmtUsd(s.net, { signed: true, decimals: "auto" })}</td>
      <td className="text-right">{s.gross > 0 ? fmtRate(s.feePctOfGross) : "—"}</td>
      <td className="text-right">{fmtNum(s.breakEvenCents, { decimals: 1, suffix: " ¢" })}</td>
      <td className={cn("text-right", d == null ? "text-muted-foreground" : d > 0 ? "text-up" : d < 0 ? "text-down" : "")}>{d == null ? "—" : fmtUsd(d, { signed: true, decimals: "auto" })}</td>
      <td className="text-right">
        {rule && canApply && (
          <button
            type="button"
            disabled={applied}
            onClick={() => onApply(rule)}
            className={cn("inline-flex min-h-7 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-xs font-medium", applied ? "text-primary" : "chip")}
            aria-label={applied ? t("fees.inScenarioAria", { name: row.label }) : t("fees.applyAria", { name: row.label })}
          >
            {applied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
            {applied ? t("fees.inScenario") : t("fees.apply")}
          </button>
        )}
      </td>
    </tr>
  );
}

type GroupRow = FeeGroupRow & { order: number };
const GROUP_ACCESSORS = {
  // Hidden key: server order (price / size / hold / hour buckets go in their natural order).
  order: (r: GroupRow) => r.order,
  key: (r: GroupRow) => r.key,
  trades: (r: GroupRow) => r.trades,
  gross: (r: GroupRow) => r.gross,
  fees: (r: GroupRow) => r.fees,
  net: (r: GroupRow) => r.net,
  feePct: (r: GroupRow) => r.feePctOfGross,
  breakEven: (r: GroupRow) => r.breakEvenCents,
  eaten: (r: GroupRow) => r.eatenWinners,
} as const;

function GroupTable({ title, rows, description, keyLabel, defaultSort = "order", maxHeight = 440 }: {
  title: string; rows: FeeGroupRow[]; description?: string; keyLabel: string; defaultSort?: "order" | "fees"; maxHeight?: number | string;
}) {
  const { t } = whatIfI18n.useT();
  const data = useMemo(() => rows.filter((r) => r.trades > 0).map((r, order) => ({ ...r, order })), [rows]);
  const { rows: sorted, thProps } = useTableSort(data, GROUP_ACCESSORS, defaultSort, defaultSort === "order" ? "asc" : "desc");
  return (
    <Panel title={title} description={description} padded={false} bodyClassName="p-2 sm:p-3">
      {data.length ? (
        <DataTable maxHeight={maxHeight} ariaLabel={title}>
          <table>
            <thead>
              <tr>
                <SortableTh {...thProps("key")}>{keyLabel}</SortableTh>
                <SortableTh {...thProps("trades")} align="right">{t("fees.colTrades")}</SortableTh>
                <SortableTh {...thProps("gross")} align="right">{t("fees.gross")}</SortableTh>
                <SortableTh {...thProps("fees")} align="right">{t("fees.fees")}</SortableTh>
                <SortableTh {...thProps("net")} align="right">{t("fees.net")}</SortableTh>
                <SortableTh {...thProps("feePct")} align="right"><span title={t("fees.pctTitle")}>{t("fees.colOfGross")}</span></SortableTh>
                <SortableTh {...thProps("breakEven")} align="right"><span title={t("fees.colBreakEvenTitle")}>{t("fees.colBreakEven")}</span></SortableTh>
                <SortableTh {...thProps("eaten")} align="right"><span title={t("fees.eatenColTitle")}>{t("fees.eatenCol")}</span></SortableTh>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.key}>
                  <td className="whitespace-nowrap font-medium">{r.key}</td>
                  <td className="text-right">{r.trades}</td>
                  <td className={cn("text-right", r.gross > 0 ? "text-up" : r.gross < 0 ? "text-down" : "")}>{fmtUsd(r.gross, { signed: true, decimals: "auto" })}</td>
                  <td className="text-right">{fmtUsd(Math.abs(r.fees))}</td>
                  <td className={cn("text-right font-medium", r.net > 0 ? "text-up" : r.net < 0 ? "text-down" : "")}>{fmtUsd(r.net, { signed: true, decimals: "auto" })}</td>
                  <td className="text-right" style={{ backgroundColor: heat(r.feePctOfGross) }}>{fmtRate(r.feePctOfGross)}</td>
                  <td className="text-right">{fmtNum(r.breakEvenCents, { decimals: 1, suffix: " ¢" })}</td>
                  <td className="text-right">{r.eatenWinners || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
      ) : (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("fees.noData")}</p>
      )}
    </Panel>
  );
}

function FeeDetails({ data, isLoading, costsByGroup }: { data: FeesResponse | undefined; isLoading: boolean; costsByGroup?: React.ReactNode }) {
  const { t } = whatIfI18n.useT();
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="inline-flex items-center gap-1.5 rounded-full px-1 text-sm font-medium text-primary hover:underline">
        <ChevronDown className={cn("h-4 w-4 transition-transform duration-[var(--dur-1)]", open && "rotate-180")} aria-hidden="true" />
        {open ? t("fees.hideDetails") : t("fees.showDetails")}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3">
        {isLoading || !data ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-64 rounded-2xl" />)}</div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <GroupTable title={t("fees.byPrice")} keyLabel={t("fees.byPriceKey")} rows={data.byPrice} description={t("fees.byPriceHint")} />
              <GroupTable title={t("fees.bySize")} keyLabel={t("fees.bySizeKey")} rows={data.bySize} description={t("fees.bySizeHint")} />
              <GroupTable title={t("fees.byHold")} keyLabel={t("fees.byHoldKey")} rows={data.byHold} description={t("fees.byHoldHint")} />
              <GroupTable title={t("fees.byHour")} keyLabel={t("fees.byHourKey")} rows={data.byHour} />
            </div>
            <GroupTable title={t("fees.byTicker")} keyLabel={t("fees.byTickerKey")} rows={data.byTicker} defaultSort="fees" maxHeight="60vh" />
            {costsByGroup}
            <Panel
              title={t("fees.eatenPanel")}
              icon={Scissors}
              description={`${t("fees.eatenPanelHint", { trades: commonI18n.t("units.trades", { count: data.eatenCount }) })}${data.eatenCount > data.eaten.length ? ` ${t("fees.shown", { count: data.eaten.length })}` : ""}`}
              padded={false}
              bodyClassName="p-2 sm:p-3"
            >
              {data.eaten.length ? (
                <EatenTable rows={data.eaten} />
              ) : (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("fees.noEaten")}</p>
              )}
            </Panel>
          </div>
        )}
        {data && data.byType.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {data.byType.map((b) => <Pill key={b.key} tone="neutral">{b.label} {fmtUsd(Math.abs(b.amount))} · {fmtRate(b.share)}</Pill>)}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

const EATEN_ACCESSORS = {
  day: (e: EatenRow) => e.day,
  ticker: (e: EatenRow) => e.ticker,
  qty: (e: EatenRow) => e.qty,
  gross: (e: EatenRow) => e.gross,
  fees: (e: EatenRow) => e.fees,
  net: (e: EatenRow) => e.net,
} as const;

function EatenTable({ rows }: { rows: EatenRow[] }) {
  const { t } = whatIfI18n.useT();
  const { rows: sorted, thProps } = useTableSort(rows, EATEN_ACCESSORS, "day");
  return (
    <DataTable maxHeight="60vh" ariaLabel={t("fees.eatenAria")}>
      <table>
        <thead>
          <tr>
            <SortableTh {...thProps("day")}>{t("fees.colDate")}</SortableTh>
            <SortableTh {...thProps("ticker")}>{t("fees.colTicker")}</SortableTh>
            <SortableTh {...thProps("qty")} align="right">{t("fees.colShares")}</SortableTh>
            <SortableTh {...thProps("gross")} align="right">{t("fees.gross")}</SortableTh>
            <SortableTh {...thProps("fees")} align="right">{t("fees.fees")}</SortableTh>
            <SortableTh {...thProps("net")} align="right">{t("fees.net")}</SortableTh>
          </tr>
        </thead>
        <tbody>
          {sorted.map((e) => (
            <tr key={e.id}>
              <td className="whitespace-nowrap">{fmtDate(e.day, "short")}</td>

              <td><Link href={links.trade(e.id)} className="font-medium text-primary underline-offset-4 hover:underline">{e.ticker}</Link></td>
              <td className="text-right">{e.qty ?? "—"}</td>
              <td className="text-right text-up">{fmtUsd(e.gross, { signed: true, decimals: "auto" })}</td>
              <td className="text-right">{fmtUsd(Math.abs(e.fees))}</td>
              <td className="text-right font-medium text-down">{fmtUsd(e.net, { signed: true, decimals: "auto" })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </DataTable>
  );
}
