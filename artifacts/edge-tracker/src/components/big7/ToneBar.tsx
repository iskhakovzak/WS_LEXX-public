/**
 * Market tone bar: risk-on / risk-off verdict with up to three reasons, QQQ/SPY, breadth of the board,
 * cap-weighted move, contribution to QQQ and who leads / lags. Fixed height (no layout shift on load).
 */
import { SkeletonBlock } from "@/components/ds";
import { cn } from "@/lib/utils";
import { fmtNum } from "@/lib/format";
import { toneHint, type BoardAgg, type Big7Row, type Phase, type Tone } from "./context";
import { Signed } from "./ui";
import { big7I18n } from "@/i18n/ns/big7";

const TONE_CLS: Record<Tone["kind"], { dot: string; text: string; ring: string }> = {
  on: { dot: "bg-up", text: "text-up", ring: "bg-up/10" },
  off: { dot: "bg-down", text: "text-down", ring: "bg-down/10" },
  mixed: { dot: "bg-warn", text: "text-warn", ring: "bg-warn/10" },
};

/** Session phase name in the UI language. */
export const phaseLabel = (p: Phase) => big7I18n.t(`phaseLabel.${p}`);

function Cell({ label, children, title }: { label: React.ReactNode; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" title={title}>
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-sm font-semibold tabular-nums">{children}</span>
    </div>
  );
}

function Breadth({ up, down, n }: { up: number; down: number; n: number }) {
  const flat = Math.max(0, n - up - down);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="tabular-nums"><span className="text-up">{up}</span><span className="text-muted-foreground">/{n}</span></span>
      <span className="flex h-1.5 w-16 overflow-hidden rounded-full bg-[var(--glass-bg)]" aria-hidden="true">
        <span className="bg-up" style={{ width: `${(up / Math.max(1, n)) * 100}%` }} />
        <span className="bg-muted-foreground/40" style={{ width: `${(flat / Math.max(1, n)) * 100}%` }} />
        <span className="bg-down" style={{ width: `${(down / Math.max(1, n)) * 100}%` }} />
      </span>
    </span>
  );
}

const names = (rows: Big7Row[]) => rows.map((r) => `${r.symbol} ${fmtNum(r.rsQqq, { decimals: 1, signed: true })}`).join(" · ");

export function ToneBar({ tone, agg, qqq, spy, phase, loading }: {
  tone: Tone | null;
  agg: BoardAgg;
  qqq: Big7Row | null;
  spy: Big7Row | null;
  phase: Phase;
  loading: boolean;
}) {
  const { t } = big7I18n.useT();
  if (loading && !tone) {
    return (
      <section aria-label={t("tone.aria")} aria-busy="true" className="glass-panel flex min-h-[92px] items-center gap-6 rounded-2xl p-[var(--panel-p)]">
        <SkeletonBlock className="h-12 w-56 rounded-xl" />
        <div className="grid flex-1 grid-cols-5 gap-4">
          {Array.from({ length: 5 }, (_, i) => <SkeletonBlock key={i} className="h-9 rounded-lg" />)}
        </div>
      </section>
    );
  }
  const cls = tone ? TONE_CLS[tone.kind] : null;
  return (
    <section
      aria-label={t("tone.aria")}
      className="glass-panel grid min-h-[92px] grid-cols-1 items-center gap-x-6 gap-y-3 rounded-2xl p-[var(--panel-p)] lg:grid-cols-[minmax(240px,1fr)_minmax(0,2.2fr)]"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl", cls?.ring ?? "bg-[var(--glass-bg)]")} aria-hidden="true">
          <span className={cn("h-3 w-3 rounded-full", cls?.dot ?? "bg-muted-foreground")} />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className={cn("text-lg font-semibold leading-tight", cls?.text ?? "text-muted-foreground")}>
              {tone?.label ?? t("tone.noData")}
            </span>
            <span className="text-xs text-muted-foreground">{phaseLabel(phase)}</span>
          </div>
          <p className="line-clamp-2 text-xs text-muted-foreground" title={tone ? `${tone.reasons.join(" · ")}\n${toneHint(tone)}` : undefined}>
            {tone ? tone.reasons.join(" · ") : t("tone.noQuotes")}
          </p>
          {tone && <p className="truncate text-xs text-foreground/90" title={toneHint(tone)}>{toneHint(tone)}</p>}
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-3 gap-x-6 gap-y-3 sm:grid-cols-[repeat(5,auto)_minmax(0,1fr)]">
        <Cell label="QQQ"><Signed value={qqq?.chg} /></Cell>
        <Cell label="SPY"><Signed value={spy?.chg} /></Cell>
        <Cell label={t("tone.breadth")}><Breadth up={agg.up} down={agg.down} n={agg.n} /></Cell>
        <Cell label={t("tone.weighted")} title={t("tone.weightedTitle")}>
          <Signed value={agg.weighted} />
        </Cell>
        <Cell label={t("tone.contrib")} title={t("tone.contribTitle")}>
          <span className="inline-flex items-baseline gap-1">
            <Signed value={agg.contribQqq} suffix={t("tone.ppSuffix")} />
            {agg.shareQqq != null && <span className="text-xs font-normal text-muted-foreground">({Math.round(agg.shareQqq * 100)}%)</span>}
          </span>
        </Cell>
        <Cell label={t("tone.leadLag")} title={t("tone.leadLagTitle")}>
          <span className="flex flex-col text-xs font-medium leading-snug">
            <span className="truncate text-up" title={names(agg.leaders) || undefined}>{names(agg.leaders) || "—"}</span>
            <span className="truncate text-down" title={names(agg.laggards) || undefined}>{names(agg.laggards) || "—"}</span>
          </span>
        </Cell>
      </div>
    </section>
  );
}
