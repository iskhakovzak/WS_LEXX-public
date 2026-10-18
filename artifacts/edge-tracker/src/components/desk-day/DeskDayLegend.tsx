/**
 * Legend of «Деск на тикере»: one row per trader (colour, name, side, trades, result, R, $ for allowed viewers, time
 * window and time in position). Clicking a row focuses that trader's legs on the chart; «Все» clears the focus.
 * Plus the key of marker shapes (drawn with the chart's own glyph painter).
 */
import * as React from "react";
import { Pill, toneText, type Tone } from "@/components/ds";
import { readChartTheme } from "@/components/chart-engine/theme";
import { ROLE_LABEL, ROLE_ORDER } from "@/components/chart-engine/lib/structure";
import { etDayKey, fmtEtDay, fmtEtTime, formatDuration, isoToEpoch } from "@/components/chart-engine/lib/time";
import type { TradeRole } from "@/components/chart-engine/types";
import { cn } from "@/lib/utils";
import { fmtR, fmtUsd } from "@/lib/format";
import { deskDayI18n } from "@/i18n/ns/deskDay";
import type { DayResult, DeskDay, DeskTrader } from "./api";
import { drawDeskGlyph } from "./DeskFillsPrimitive";
import { resultLabel, sideLabel, traderLabel } from "./labels";

const RESULT_TONE: Record<DayResult, Tone> = { win: "up", loss: "down", be: "neutral", open: "accent" };

const et = (iso: string | null, day?: string) => {
  const e = isoToEpoch(iso);
  if (!Number.isFinite(e)) return "—";
  // Another day (overnight / swing exit): the date goes with the time.
  return day && etDayKey(e) !== day ? `${fmtEtDay(e)} ${fmtEtTime(e)}` : fmtEtTime(e);
};

function TraderRow({ tr, day, color, active, dimmed, onToggle }: { tr: DeskTrader; day: DeskDay; color: string; active: boolean; dimmed: boolean; onToggle: () => void }) {
  const { t } = deskDayI18n.useT();
  const name = traderLabel(day, tr.name);
  const date = day.date;
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={active}
        aria-label={t("legend.focus", { name })}
        className={cn(
          "flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-opacity hover:bg-[var(--glass-hover-bg)]",
          active && "bg-[var(--glass-hover-bg)] ring-1 ring-[var(--glass-border)]",
          dimmed && "opacity-55",
        )}
      >
        <span className="mt-1 h-3 w-3 shrink-0 rounded-full ring-2 ring-background" style={{ background: color }} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium text-foreground">{name}</span>
            {tr.me && day.view !== "anonymous" && <Pill tone="accent">{t("legend.me")}</Pill>}
            <span className="text-xs text-muted-foreground">{sideLabel(tr.side)}</span>
            <span className="text-xs text-muted-foreground">· {t("legend.trades", { count: tr.trades })}</span>
          </span>
          <span className="mt-0.5 block text-xs tabular-nums text-muted-foreground">
            {t("legend.window", { from: et(tr.firstAt, date), to: et(tr.lastAt, date) })}
            {tr.holdSec != null && <> · {t("legend.hold", { time: formatDuration(tr.holdSec) })}</>}
            {tr.addedAgainst && <> · <span className="text-warn">{t("legend.added")}</span></>}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 tabular-nums">
          {tr.result ? <Pill tone={RESULT_TONE[tr.result]}>{resultLabel(tr.result)}</Pill> : <span className="text-xs text-muted-foreground">—</span>}
          <span className="text-xs">
            {tr.r != null && <span className={toneText(tr.r > 0 ? "up" : tr.r < 0 ? "down" : "neutral")}>{fmtR(tr.r)}</span>}
            {!tr.redacted && tr.net != null && <span className={cn("ml-2", toneText(tr.net > 0 ? "up" : tr.net < 0 ? "down" : "neutral"))}>{fmtUsd(tr.net, { signed: true })}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

function Glyph({ role }: { role: TradeRole }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = 16 * dpr; c.height = 16 * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, 16, 16);
    const theme = readChartTheme();
    drawDeskGlyph(ctx, theme, role, 8, role === "stop" ? 2 : role === "add" || role === "exit" ? 0 : 1, 9, true, theme.fg(0.85));
  });
  return <canvas ref={ref} aria-hidden="true" className="h-4 w-4 shrink-0" />;
}

/** Shapes present today, in the engine's role order. */
export function RoleKey({ day }: { day: DeskDay }) {
  const { t } = deskDayI18n.useT();
  const roles = React.useMemo(() => {
    const seen = new Set<TradeRole>();
    for (const tr of day.trades) for (const l of tr.legs) seen.add(l.role);
    return ROLE_ORDER.filter((r) => seen.has(r));
  }, [day.trades]);
  if (!roles.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label={t("key")}>
      {roles.map((r) => (
        <span key={r} className="inline-flex items-center gap-1"><Glyph role={r} />{ROLE_LABEL[r]}</span>
      ))}
    </div>
  );
}

export function DeskDayLegend({ day, colors, focus, onToggle, onClear }: {
  day: DeskDay;
  colors: ReadonlyMap<string, string>;
  focus: readonly string[];
  onToggle: (name: string) => void;
  onClear: () => void;
}) {
  const { t } = deskDayI18n.useT();
  const focused = new Set(focus);
  const anyHidden = day.traders.some((tr) => tr.redacted);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-2.5">
        <p className="micro-label">{t("legend.title")} · {t("legend.count", { count: day.traders.length })}</p>
        {focus.length > 0 && (
          <button type="button" onClick={onClear} className="text-xs font-medium text-primary hover:underline">{t("legend.all")}</button>
        )}
      </div>
      <ul className="flex flex-col gap-0.5">
        {day.traders.map((tr) => (
          <TraderRow
            key={tr.name}
            tr={tr}
            day={day}
            color={colors.get(tr.name) ?? "#888"}
            active={focused.has(tr.name)}
            dimmed={focus.length > 0 && !focused.has(tr.name)}
            onToggle={() => onToggle(tr.name)}
          />
        ))}
      </ul>
      {day.view === "anonymous" && <p className="px-2.5 text-2xs text-muted-foreground">{t("legend.anon")}</p>}
      {anyHidden && <p className="px-2.5 text-2xs text-muted-foreground">{t("legend.moneyHidden")}</p>}
    </div>
  );
}
