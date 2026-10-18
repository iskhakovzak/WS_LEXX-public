/**
 * Day / week click-through for analytics charts: one place for the hrefs, the hover hint and the
 * click + keyboard wiring, so every chart whose X axis is a day or a week opens the same pages.
 *
 *   day  → /day-report?date=YYYY-MM-DD&trader=…
 *   week → /weekly-review?week=YYYY-Www&trader=…  (ISO week, the format that page reads)
 */
import * as React from "react";
import { useLocation } from "wouter";
import { links } from "./links";
import { commonI18n } from "@/i18n/ns/common";

export type PeriodKind = "day" | "week";

/** "Открыть разбор дня" / "Открыть неделю" in the UI language (getters: read at render). */
export const PERIOD_HINT: Readonly<Record<PeriodKind, string>> = {
  get day() { return commonI18n.t("periodNav.openDay"); },
  get week() { return commonI18n.t("periodNav.openWeek"); },
};

const YMD = /^\d{4}-\d{2}-\d{2}/;
const WEEK = /^\d{4}-W\d{2}$/;

/** «2026-10-16T…» / «2026-10-16» → «2026-10-16»; anything else → null. */
export function ymdOf(v: unknown): string | null {
  return typeof v === "string" && YMD.test(v) ? v.slice(0, 10) : null;
}

/** ISO week key «YYYY-Www» of a date (Mon–Sun weeks, the week of its Thursday). */
export function isoWeekOf(ymd: string): string {
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
  const wd = (d.getUTCDay() + 6) % 7; // Mon = 0
  d.setUTCDate(d.getUTCDate() - wd + 3); // Thursday of the week decides the year
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** A real trader name for a link: «all» / empty mean «not one trader». */
const traderParam = (t?: string | null) => (t && t !== "all" ? t : undefined);

export function dayHref(date: string, trader?: string | null): string {
  return links.dayReport(date.slice(0, 10), traderParam(trader));
}

/** `week` is a week key («2026-W42») or any date inside the week. */
export function weekHref(week: string, trader?: string | null): string {
  return links.weeklyReview({ week: WEEK.test(week) ? week : isoWeekOf(week), trader: traderParam(trader) });
}

export function periodHref(kind: PeriodKind, date: string, trader?: string | null): string {
  return kind === "week" ? weekHref(date, trader) : dayHref(date, trader);
}

/**
 * The period under a recharts click: the payload row's `key` field (default «date»), else the category label.
 * Accepts recharts' chart-level onClick state ({ activePayload, activeLabel }) or a Bar / Cell payload.
 */
export function chartClickDate(state: unknown, key = "date"): string | null {
  if (!state || typeof state !== "object") return null;
  const s = state as { activePayload?: { payload?: Record<string, unknown> }[]; activeLabel?: unknown; payload?: Record<string, unknown> };
  const row = s.activePayload?.[0]?.payload ?? s.payload;
  const v = row?.[key] ?? s.activeLabel;
  if (typeof v !== "string") return null;
  return ymdOf(v) ?? (WEEK.test(v) ? v : null);
}

/** Small «→ Открыть разбор дня» line for a chart tooltip. */
export function PeriodHint({ kind }: { kind: PeriodKind }) {
  return React.createElement(
    "span",
    { className: "mt-1 block text-2xs font-medium text-primary" },
    commonI18n.t(kind === "week" ? "periodNav.clickWeek" : "periodNav.clickDay"),
  );
}

/**
 * Click + keyboard wiring for a chart of days / weeks.
 *
 *   const nav = usePeriodNav({ kind: "day", dates: data.map((d) => d.date), trader });
 *   <div {...nav.wrapperProps}> <BarChart {...nav.chartProps}> … </BarChart> {nav.caption} </div>
 *
 * Mouse: click a bar / point. Keyboard: focus the chart, ←/→ (Home/End) pick a period, Enter opens it.
 */
export function usePeriodNav({
  kind, dates, trader, label, describe, key = "date",
}: {
  kind: PeriodKind;
  /** Period of each data row, in chart order (YYYY-MM-DD; for weeks any day of the week or a week key). */
  dates: (string | null | undefined)[];
  trader?: string | null;
  /** Accessible name of the chart («Результат дня»). */
  label?: string;
  /** Text of the keyboard-selected row («пт, 16 окт · +$120»). */
  describe?: (i: number) => string;
  /** Field of the recharts row holding the date. */
  key?: string;
}) {
  const [, navigate] = useLocation();
  const [active, setActive] = React.useState(-1);
  const n = dates.length;
  const live = React.useRef({ dates, trader, kind });
  live.current = { dates, trader, kind };

  const open = React.useCallback((date: string | null | undefined) => {
    const d = date ? ymdOf(date) ?? (WEEK.test(date) ? date : null) : null;
    if (d) navigate(periodHref(live.current.kind, d, live.current.trader));
  }, [navigate]);

  const onClick = React.useCallback((state: unknown) => open(chartClickDate(state, key)), [open, key]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!n) return;
    const go = (i: number) => { e.preventDefault(); setActive(Math.max(0, Math.min(n - 1, i))); };
    switch (e.key) {
      case "ArrowRight": return go(active < 0 ? n - 1 : active + 1);
      case "ArrowLeft": return go(active < 0 ? n - 1 : active - 1);
      case "Home": return go(0);
      case "End": return go(n - 1);
      case "Enter":
      case " ":
        if (active >= 0) { e.preventDefault(); open(dates[active]); }
        return;
      case "Escape": setActive(-1);
    }
  };

  const hint = PERIOD_HINT[kind];
  const sel = active >= 0 && active < n ? (describe?.(active) ?? dates[active] ?? "") : null;
  return {
    open,
    active,
    hint,
    chartProps: { onClick, style: { cursor: "pointer" } as React.CSSProperties },
    wrapperProps: {
      tabIndex: 0,
      role: "group" as const,
      "aria-roledescription": commonI18n.t("periodNav.roleDescription"),
      "aria-label": `${label ? `${label}. ` : ""}${commonI18n.t(kind === "week" ? "periodNav.ariaWeek" : "periodNav.ariaDay")}`,
      title: hint,
      onKeyDown,
      onBlur: () => setActive(-1),
      className: "rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    },
    /** Keyboard selection line (visible only while choosing with arrows); render under the chart. */
    caption: sel
      ? React.createElement(
          "p",
          { className: "mt-1 text-2xs text-muted-foreground", "aria-live": "polite" },
          React.createElement("span", { className: "font-medium text-foreground" }, sel),
          ` · ${commonI18n.t(kind === "week" ? "periodNav.enterWeek" : "periodNav.enterDay")}`,
        )
      : null,
  };
}
