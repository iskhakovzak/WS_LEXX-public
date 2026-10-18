import { TrendingUp } from "lucide-react";
import { DataTable, Delta, EmptyState, Pill, SortableTh, useTableSort } from "@/components/ds";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { PERIOD_HINT, weekHref } from "@/lib/period-links";
import type { TrendResult, } from "./api";
import { fmtDate, fmtNum, fmtR, fmtRate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { benchmarkI18n } from "@/i18n/ns/benchmark";
import { personName } from "@/i18n";

const VERDICT_TONE = { better: "up", worse: "down", flat: "neutral", nodata: "neutral" } as const;
const PP = () => ` ${commonI18n.t("units.percentPoints", { value: "" }).trim()}`;

type Col = { key: "trades" | "net" | "winRate" | "profitFactor" | "expectancy" | "greenShare" | "maxDd" | "feeShare" | "totalR"; fmt: (v: number | null) => string; delta?: { scale: number; suffix: string; invert?: boolean; precision?: number } };

/** Labels: benchmark namespace `trend.col.<key>`; the «п.п.» suffix follows the language (`pp` → read at render). */
const COLS: Col[] = [
  { key: "trades", fmt: (v) => (v == null ? "—" : String(v)) },
  { key: "net", fmt: (v) => fmtUsd(v, { signed: true, decimals: "auto" }), delta: { scale: 1, suffix: "", precision: 0 } },
  { key: "winRate", fmt: (v) => fmtRate(v), delta: { scale: 100, suffix: "pp", precision: 0 } },
  { key: "profitFactor", fmt: (v) => fmtNum(v), delta: { scale: 1, suffix: "", precision: 2 } },
  { key: "expectancy", fmt: (v) => fmtUsd(v, { signed: true, decimals: "auto" }), delta: { scale: 1, suffix: "", precision: 2 } },
  { key: "greenShare", fmt: (v) => fmtRate(v), delta: { scale: 100, suffix: "pp", precision: 0 } },
  { key: "maxDd", fmt: (v) => (v == null ? "—" : fmtUsd(v, { decimals: "auto" })), delta: { scale: 1, suffix: "", invert: true, precision: 0 } },
  { key: "feeShare", fmt: (v) => fmtRate(v), delta: { scale: 100, suffix: "pp", invert: true, precision: 0 } },
  { key: "totalR", fmt: (v) => fmtR(v), delta: { scale: 1, suffix: "R", precision: 2 } },
];

const VERDICT_ORDER: Record<string, number | null> = { worse: 0, flat: 1, better: 2, nodata: null };
/** Columns sort by the current 4-week value; «Вердикт» by worse → flat → better (no data sinks). */
const TREND_ACCESSORS: Record<string, (t: TrendResult) => number | string | null> = {
  trader: (t) => personName(t.trader),
  verdict: (t) => VERDICT_ORDER[t.verdict] ?? null,
  ...Object.fromEntries(COLS.map((c) => [c.key, (t: TrendResult) => (t.curM[c.key] as number | null) ?? null])),
};

/** Weekly bars of the 8-week window (net $, else R). Each bar opens that week's review of the trader. */
function WeekBars({ weeks, trader }: { weeks: TrendResult["weeks"]; trader: string }) {
  const { t } = benchmarkI18n.useT();
  const vals = weeks.map((w) => w.net ?? w.r ?? 0);
  const max = Math.max(1e-9, ...vals.map(Math.abs));
  const W = 8 * weeks.length + 2 * (weeks.length - 1), H = 28;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="group" aria-label={t("trend.weeksAria", { trader: personName(trader), list: weeks.map((w) => `${fmtDate(w.week, "shortYY")} ${w.net != null ? fmtUsd(w.net, { signed: true, decimals: "auto" }) : fmtR(w.r)}`).join("; ") })} className="overflow-visible">
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="hsl(var(--border))" />
      {weeks.map((w, i) => {
        const v = vals[i];
        const h = (Math.abs(v) / max) * (H / 2 - 1);
        const title = t("trend.barTitle", { week: fmtDate(w.week, "shortYY"), value: w.net != null ? fmtUsd(w.net, { signed: true, decimals: "auto" }) : fmtR(w.r), trades: commonI18n.t("units.tradesShort", { count: w.trades }), hint: PERIOD_HINT.week.toLowerCase() });
        return (
          <Link key={w.week} href={weekHref(w.week, trader)} aria-label={title} className="group cursor-pointer outline-none">
            <title>{title}</title>
            {/* Full-height hit area: thin bars are hard to hit; the ring shows keyboard focus. */}
            <rect x={i * 10 - 1} width={10} y={0} height={H} rx={2} className="fill-transparent group-hover:fill-[hsl(var(--muted-foreground)/0.12)] group-focus-visible:fill-[hsl(var(--ring)/0.25)]" />
            <rect x={i * 10} width={8} y={v >= 0 ? H / 2 - h : H / 2} height={Math.max(h, w.trades ? 1 : 0)} rx={1}
              fill={i < weeks.length - 4 ? "hsl(var(--muted-foreground) / 0.45)" : v >= 0 ? "hsl(var(--up))" : "hsl(var(--down))"} />
          </Link>
        );
      })}
    </svg>
  );
}

export function TrendView({ trend }: { trend: TrendResult[] }) {
  const { t } = benchmarkI18n.useT();
  if (!trend.length) return <EmptyState icon={TrendingUp} title={t("trend.empty")} description={t("trend.emptyHint")} />;
  const t0 = trend[0];
  return <TrendTable trend={trend} t0={t0} />;
}

function TrendTable({ trend, t0 }: { trend: TrendResult[]; t0: TrendResult }) {
  const { t } = benchmarkI18n.useT();
  const { rows, thProps } = useTableSort(trend, TREND_ACCESSORS, "verdict", "asc");
  const pp = PP();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {t("trend.intro", {
          cur: `${fmtDate(t0.cur.from, "shortYY")}–${fmtDate(t0.cur.to, "shortYY")}`,
          prev: `${fmtDate(t0.prev.from, "shortYY")}–${fmtDate(t0.prev.to, "shortYY")}`,
        })}
      </p>
      <DataTable stickyFirstCol ariaLabel={t("trend.aria")}>
        <table>
          <thead>
            <tr>
              <SortableTh {...thProps("trader")}>{t("trend.trader")}</SortableTh>
              <SortableTh {...thProps("verdict")}>{t("trend.verdictCol")}</SortableTh>
              <th scope="col">{t("trend.weeks8")}</th>
              {COLS.map((c) => <SortableTh key={c.key} {...thProps(c.key)} align="right">{t(`trend.col.${c.key}`)}</SortableTh>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((tr) => (
              <tr key={tr.trader}>
                <td className="font-medium text-foreground">{personName(tr.trader)}</td>
                <td><Pill tone={VERDICT_TONE[tr.verdict]} dot>{t(`trend.verdict.${tr.verdict}`)}</Pill></td>
                <td><WeekBars weeks={tr.weeks} trader={tr.trader} /></td>
                {COLS.map((c) => {
                  const cur = tr.curM[c.key] as number | null;
                  const prev = tr.prevM[c.key] as number | null;
                  const d = c.delta && cur != null && prev != null ? (cur - prev) * c.delta.scale : null;
                  return (
                    <td key={c.key} className="text-right">
                      <div className={cn(cur == null && "text-muted-foreground")}>{c.fmt(cur)}</div>
                      <div className="flex items-center justify-end gap-1 text-2xs text-muted-foreground">
                        <span>{t("trend.was", { value: c.fmt(prev) })}</span>
                        {c.delta && d != null && Math.abs(d) > 1e-9 && (
                          <Delta value={d} suffix={c.delta.suffix === "pp" ? pp : c.delta.suffix} precision={c.delta.precision ?? 1} invert={c.delta.invert} bare showIcon={false} />
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </DataTable>
      <p className="text-2xs text-muted-foreground">{t("trend.footnote")}</p>

    </div>
  );
}
