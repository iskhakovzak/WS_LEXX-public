import { BellRing, Compass, History } from "lucide-react";
import { Link } from "wouter";
import { Panel, Pill } from "@/components/ds";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { INDICATOR_BY_ID, MIN_DAYS, type Analogue, type AlertRule, type BucketStats, type IndicatorId, type Reading } from "./engine";
import { NetBar, type DimResult } from "./EdgeByRegime";
import { dayLabel, toneOfMoney, usd } from "./format";
import { fmtRate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { indicatorsI18n } from "@/i18n/ns/indicators";

const TEXT = { up: "text-up", down: "text-down", neutral: "text-foreground" } as const;
const tx = (v: number) => TEXT[toneOfMoney(v) as keyof typeof TEXT];

/** Short verdict on the day for this trader: analogues + the buckets today falls into. */
export function TodayForYou({
  sessionLabel, analogues, pre, base, fired, alertsCount, sectors,
}: {
  sessionLabel: string;
  analogues: Analogue[];
  pre: DimResult[];
  base: BucketStats;
  fired: { id: IndicatorId; rule: AlertRule; reading: Reading }[];
  alertsCount: number;
  sectors: { up: number; total: number; label: string } | null;
}) {
  const { t } = indicatorsI18n.useT();
  const n = analogues.length;
  const net = analogues.reduce((a, x) => a + x.day.net, 0);
  const avg = n ? net / n : 0;
  const green = analogues.filter((a) => a.day.net > 0).length;
  const sorted = analogues.map((a) => a.day.net).sort((x, y) => x - y);
  // Median alongside the mean: one big day can carry the average of 8 sessions.
  const median = n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : 0;
  const w = analogues.reduce((a, x) => a + x.day.wins, 0);
  const l = analogues.reduce((a, x) => a + x.day.losses, 0);
  const todayRows = pre
    .map((r) => ({ r, b: r.buckets.find((b) => b.id === r.today) ?? null }))
    .filter((x): x is { r: DimResult; b: BucketStats } => x.b != null);
  const max = Math.max(1, ...todayRows.map((x) => Math.abs(x.b.netPerDay)), Math.abs(base.netPerDay));

  return (
    <Panel title={t("today.title")} description={sessionLabel} icon={Compass} fill>
      <div className="flex flex-col gap-4">
        <div className="tile flex flex-col gap-1 p-3">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><History className="h-3.5 w-3.5" aria-hidden="true" />{t("today.similarAvg")}</span>
          {n ? (
            <>
              <span className={cn("text-2xl font-semibold leading-tight tabular-nums", tx(avg))}>{usd(avg)} <span className="text-sm font-normal text-muted-foreground">{t("today.perDay")}</span></span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {t("today.summary", {
                  days: commonI18n.t("units.days", { count: n }),
                  green,
                  n,
                  median: usd(median),
                  wr: fmtRate(w + l ? w / (w + l) : null),
                  base: usd(base.netPerDay),
                })}
              </span>
              {n < MIN_DAYS && <Pill tone="warn" className="mt-1 self-start">{t("today.fewSimilar")}</Pill>}
            </>
          ) : (
            <span className="text-sm text-muted-foreground">{t("today.nothingYet")}</span>
          )}
        </div>

        {todayRows.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">{t("today.yourResult")}</p>
            <ul className="flex flex-col gap-2">
              {todayRows.map(({ r, b }) => (
                <li key={r.dim.id} className="grid grid-cols-[minmax(0,1fr)_4.5rem_5rem] items-center gap-2 text-sm tabular-nums">
                  <span className="min-w-0">
                    <span className="block truncate text-xs text-muted-foreground">{r.dim.label}</span>
                    <span className="block truncate" title={`${b.label} · ${t("today.daysShort", { count: b.days })}`}>{b.label}<span className="text-xs text-muted-foreground"> · {t("today.daysShort", { count: b.days })}</span></span>
                  </span>
                  <NetBar v={b.netPerDay} max={max} dim={b.days < MIN_DAYS} />
                  <span className={cn("text-right font-medium", b.days < MIN_DAYS ? "text-muted-foreground" : tx(b.netPerDay))} title={b.days < MIN_DAYS ? t("today.unreliable") : undefined}>
                    {b.days > 0 ? usd(b.netPerDay) : "—"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-auto flex flex-col gap-2 border-t border-border/50 pt-3 text-xs">
          {fired.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {fired.map((f) => {
                const def = INDICATOR_BY_ID.get(f.id)!;
                return (
                  <li key={f.id} className="flex items-center gap-2">
                    <BellRing className="h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{def.label}</span> {t(f.rule.op === "above" ? "mcard.above" : "mcard.below")} {def.format(f.rule.value)}
                      <span className="text-muted-foreground"> · {t("today.firedNow", { value: f.reading.value != null ? def.format(f.reading.value) : "—" })}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <span className="text-muted-foreground">
              {alertsCount ? t("today.noneFired", { count: alertsCount }) : t("today.setAlertHint")}
            </span>
          )}
          {sectors && (
            <span className="text-muted-foreground tabular-nums">
              {sectors.label}: <span className="font-medium text-foreground">{t("today.sectorsUp", { up: sectors.up, total: sectors.total })}</span>
            </span>
          )}
        </div>
      </div>
    </Panel>
  );
}

export function AnaloguesPanel({ analogues, trader }: { analogues: Analogue[]; trader: string }) {
  const { t } = indicatorsI18n.useT();
  return (
    <Panel
      title={t("analogues.title")}
      description={t("analogues.description")}
      icon={History}
      fill
    >
      {analogues.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("analogues.empty")}</p>
      ) : (
        <ul className="flex flex-col">
          {analogues.map((a) => (
            <li key={a.d}>
              <Link
                href={links.journalDay(a.d, trader || undefined)}
                className="grid grid-cols-[4.75rem_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-2 text-sm tabular-nums transition-colors duration-[var(--dur-1)] hover:bg-[var(--tile-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t("analogues.rowAria", { day: dayLabel(a.d, true), pct: Math.round(a.similarity * 100), net: usd(a.day.net) })}
              >
                <span className="flex flex-col">
                  <span className="font-medium">{dayLabel(a.d, true)}</span>
                  <span className="text-xs text-muted-foreground">{a.d.slice(0, 4)}</span>
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="relative h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-[var(--glass-hover-bg)]" aria-hidden="true">
                      <span className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${Math.round(a.similarity * 100)}%` }} />
                    </span>
                    <span className="text-xs text-muted-foreground">{Math.round(a.similarity * 100)}%</span>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    SPY {a.spyChg != null ? `${a.spyChg >= 0.05 ? "+" : a.spyChg <= -0.05 ? "−" : ""}${Math.abs(a.spyChg).toFixed(1)}%` : "—"}
                    {a.dayType ? ` · ${t(a.dayType === "trend" ? "analogues.trend" : "analogues.range")}` : ""}
                    {a.vix != null ? ` · VIX ${a.vix.toFixed(1)}` : ""}
                  </span>
                </span>
                <span className="flex flex-col items-end">
                  <span className={cn("font-medium", tx(a.day.net))}>{usd(a.day.net)}</span>
                  <span className="text-xs text-muted-foreground">{commonI18n.t("units.tradesShort", { count: a.day.trades })}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
