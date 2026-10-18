/** «Деск на тикере» — words for results, sides and takeaways (read in the current language at call time). */
import { fmtEtTime, isoToEpoch } from "@/components/chart-engine/lib/time";
import { fmtR } from "@/lib/format";
import { personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";
import { deskDayI18n } from "@/i18n/ns/deskDay";
import type { DayResult, DeskTakeaway, Side } from "./api";

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

/** One takeaway as a sentence. */
export function takeawayText(tk: DeskTakeaway): string {
  const t = deskDayI18n.t;
  switch (tk.kind) {
    case "best": {
      const p = { name: personName(tk.trader), r: fmtR(tk.r), side: sideLabel(tk.side), time: etTime(tk.at) };
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
