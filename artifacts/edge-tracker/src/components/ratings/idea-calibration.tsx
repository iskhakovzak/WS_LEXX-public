import { useMemo } from "react";
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Gauge } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel, Pill, Segmented, toneOf, toneText } from "@/components/ds";
import { CHART_CURSOR, CHART_TOOLTIP, OutcomeBar, useStoredState } from "./shared";
import { fmtNum, fmtR } from "@/lib/format";
import { ratingsI18n } from "@/i18n/ns/ratings";
import { calibVerdict, calibrationOf, qualityCalibration, scoreCalibration, type EnrichedIdea, type OutcomeBasis } from "./idea-metrics";

type Mode = "score" | "quality";

export function IdeaCalibration({ ideas, basis = "trades", pending = false }: { ideas: EnrichedIdea[]; basis?: OutcomeBasis; pending?: boolean }) {
  const { t } = ratingsI18n.useT();
  const byPrice = basis === "price";
  const [mode, setMode] = useStoredState<Mode>("ideaStats.calibMode", "score", ["score", "quality"]);
  const rows = useMemo(() => (mode === "score" ? scoreCalibration(ideas) : qualityCalibration(ideas)), [ideas, mode]);
  const calib = useMemo(() => calibrationOf(ideas), [ideas]);
  const verdict = calibVerdict(calib);
  const chartRows = rows.filter((r) => r.ideas > 0).map((r) => ({
    label: r.label,
    hit: r.hitRate != null ? Math.round(r.hitRate * 100) : null,
    avgR: r.avgR != null ? Number(r.avgR.toFixed(2)) : null,
    closed: r.closed,
  }));
  const hasOutcomes = rows.some((r) => r.closed > 0);

  return (
    <Panel
      icon={Gauge}
      title={t("calib.title")}
      description={mode === "score"
        ? byPrice ? t("calib.descScorePrice") : t("calib.descScoreTrades")
        : t("calib.descQuality")}
      actions={
        <Segmented
          ariaLabel={t("calib.groupAria")}
          size="sm"
          value={mode}
          onChange={setMode}
          options={[{ value: "score", label: t("calib.byScore") }, { value: "quality", label: t("calib.byQuality") }]}
        />
      }
      className="h-full"
    >
      <div className="flex flex-col gap-4">
        {mode === "score" && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t("calib.correlation")}</span>
            <span className={cn("font-semibold tabular-nums", toneText(calib.r == null ? "neutral" : toneOf(calib.r)))}>
              {fmtNum(calib.r, { decimals: 2, signed: true })}
            </span>
            <Pill tone={verdict.tone}>{verdict.text}</Pill>
            <span className="text-xs text-muted-foreground">n = {calib.n}</span>
          </div>
        )}

        {pending ? (
          <Skeleton className="h-52 w-full rounded-xl" />
        ) : hasOutcomes ? (
          <div className="h-52 w-full" role="img" aria-label={t("calib.chartAria")}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartRows} margin={{ top: 8, right: 4, bottom: 0, left: -16 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                <YAxis yAxisId="hit" domain={[0, 100]} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} unit="%" />
                <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={36} />
                <Tooltip
                  contentStyle={CHART_TOOLTIP}
                  cursor={CHART_CURSOR}
                  formatter={(v, name, p) => {
                    const n = v == null ? null : Number(v);
                    return name === "hit"
                      ? [n == null ? "—" : t("calib.closed", { value: n, count: (p?.payload as { closed?: number } | undefined)?.closed ?? 0 }), "Hit rate"]
                      : [fmtR(n), t("calib.avgR")];
                  }}
                />
                <Bar isAnimationActive={false} yAxisId="hit" dataKey="hit" fill="hsl(var(--chart-1))" radius={[6, 6, 0, 0]} maxBarSize={36} />
                <Line isAnimationActive={false} yAxisId="r" dataKey="avgR" stroke="hsl(var(--chart-3))" strokeWidth={2} dot={{ r: 3, fill: "hsl(var(--chart-3))" }} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="rounded-xl bg-[var(--glass-bg)] p-4 text-sm text-muted-foreground">
            {byPrice
              ? t(mode === "score" ? "calib.emptyPrice" : "calib.emptyPriceQuality")
              : t(mode === "score" ? "calib.emptyTrades" : "calib.emptyTradesQuality")}
          </p>
        )}

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-[hsl(var(--chart-1))]" aria-hidden="true" /> {t("calib.legendHit")}</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-3 rounded bg-[hsl(var(--chart-3))]" aria-hidden="true" /> {t("calib.avgR")}</span>
        </div>

        <table className="w-full text-sm">
          <caption className="sr-only">{t("calib.caption")}</caption>
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th scope="col" className="py-2 text-left font-medium">{mode === "score" ? t("calib.colScore") : t("calib.colQuality")}</th>
              <th scope="col" className="py-2 text-right font-medium">{t("calib.colIdeas")}</th>
              <th scope="col" className="hidden py-2 text-right font-medium sm:table-cell">{t("calib.colInTrades")}</th>
              <th scope="col" className="w-1/4 py-2 pl-3 text-left font-medium">{t("calib.colOutcomes")}</th>
              <th scope="col" className="py-2 text-right font-medium">Hit</th>
              <th scope="col" className="py-2 text-right font-medium">{t("calib.colAvgR")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={cn("border-b border-border/50 last:border-0", r.ideas === 0 && "opacity-60")}>
                <td className="py-2 font-medium text-foreground">{r.label}</td>
                <td className="py-2 text-right tabular-nums">{r.ideas}</td>
                <td className="hidden py-2 text-right tabular-nums sm:table-cell">{r.converted}</td>
                <td className="py-2 pl-3"><OutcomeBar wins={r.wins} losses={r.losses} be={r.be} open={r.open} /></td>
                <td className="py-2 text-right tabular-nums">{r.hitRate == null ? "—" : `${Math.round(r.hitRate * 100)}%`}</td>
                <td className={cn("py-2 text-right tabular-nums", toneText(toneOf(r.avgR)))}>{fmtR(r.avgR)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
