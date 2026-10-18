/** «Деск на тикере» — words for results, sides, trader names and takeaways (read in the current language at call time). */
import { fmtEtTime, isoToEpoch } from "@/components/chart-engine/lib/time";
import { fmtCount, fmtPrice, fmtR, fmtUsd } from "@/lib/format";
import { personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";
import { deskDayI18n } from "@/i18n/ns/deskDay";
import type { DayResult, DeskDay, DeskTakeaway, Side } from "./api";

/**
 * How a trader key reads on screen. Anonymous view: «я» for the viewer, «Трейдер {n}» for everyone else (the key is
 * "t<alias>"); staff / named view: the person's display name.
 */
export function traderLabel(day: Pick<DeskDay, "view" | "traders">, key: string): string {
  if (day.view !== "anonymous") return personName(key);
  const tr = day.traders.find((x) => x.name === key);
  if (tr?.me) return deskDayI18n.t("legend.meName");
  const n = tr?.alias ?? Number(key.replace(/^t/, ""));
  return deskDayI18n.t("legend.alias", { n });
}

export function resultLabel(r: DayResult | null): string {
  const t = deskDayI18n.t;
  switch (r) {
    case "win": return t("result.win");
    case "loss": return t("result.loss");
    case "open": return t("result.open");
    case "be": return t("result.be");
    default: return "—";
  }
}

export function sideLabel(s: Side | "both"): string {
  if (s === "both") return deskDayI18n.t("side.both");
  return s === "short" ? commonI18n.t("trading.short") : commonI18n.t("trading.long");
}

const etTime = (iso: string) => {
  const e = isoToEpoch(iso);
  return Number.isFinite(e) ? fmtEtTime(e) : "—";
};

/** One takeaway as a sentence; `nameOf` renders a trader key (traderLabel). */
export function takeawayText(tk: DeskTakeaway, nameOf: (key: string) => string = personName): string {
  const t = deskDayI18n.t;
  switch (tk.kind) {
    case "best": {
      const p = { name: nameOf(tk.trader), r: fmtR(tk.r), side: sideLabel(tk.side), time: etTime(tk.at) };
      if (tk.minutesFromOpen === 0) return t("takeaway.bestOpen", p);
      return tk.minutesFromOpen > 0 ? t("takeaway.best", { ...p, min: tk.minutesFromOpen }) : t("takeaway.bestPre", p);
    }
    case "averaging":
      return t("takeaway.averaging", { averaged: tk.averaged, losers: tk.losers });
    case "timing":
      return t("takeaway.timing", { winners: etTime(tk.winnersAt), losers: etTime(tk.losersAt) });
    case "sides":
      return t("takeaway.sides", { sw: tk.short.winners, st: tk.short.traders, lw: tk.long.winners, lt: tk.long.traders });
  }
}

const usd = (p: number) => fmtPrice(p, { dollar: true });
/** «09:35–09:52», or one time when the window is a single minute. */
const span = (from: string, to: string) => { const a = etTime(from), b = etTime(to); return a === b ? a : `${a}–${b}`; };

/**
 * The office layer in one line: «Офис (лонг) набрал основную позицию 09:35–09:52 ET по ~$674.20, вышел 10:40–11:05 ET
 * по ~$676.90 · итог офиса +$412 · основной вклад: Трейдер 3 — 42 %, я — 18 %». Parts without data are skipped.
 */
export function officeSummary(day: Pick<DeskDay, "view" | "traders" | "office">): string | null {
  const o = day.office;
  if (!o) return null;
  const t = deskDayI18n.t;
  const head: string[] = [];
  const side = sideLabel(o.side);
  if (o.build) head.push(t("office.build", { side, time: span(o.build.from, o.build.to), price: usd(o.build.vwap) }));
  else if (o.avgEntry != null) head.push(t("office.entry", { side, price: usd(o.avgEntry) }));
  if (o.exit) head.push(t("office.exit", { time: span(o.exit.from, o.exit.to), price: usd(o.exit.vwap) }));
  else head.push(t("office.held"));
  const parts = [head.join(", ")];
  if (o.peakShares != null) parts.push(t("office.peak", { qty: fmtCount(Math.abs(o.peakShares)), time: etTime(o.peakAt) }));
  if (o.net != null) parts.push(t("office.net", { net: fmtUsd(o.net, { signed: true, decimals: "auto" }) }));
  const top = o.contributors.slice(0, 3).map((c) => t("office.share", { name: traderLabel(day, c.trader), pct: Math.round(c.share * 100) }));
  if (top.length) parts.push(t("office.contrib", { list: top.join(", ") }));
  return parts.join(" · ");
}
