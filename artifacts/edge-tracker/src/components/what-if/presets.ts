/**
 * «Вопросы» of the simulator: one click = one ready rule («а если бы я не торговал после 3 убытков?»), plus the
 * pure helpers behind them (worst setups, cheapest tariff, the days a scenario changed). No React, no fetch.
 * A question that the data cannot answer (no setups / grades marked) is returned disabled with the reason.
 */
import { type CommissionPlan, type PreviewTrade, type Rule, gradeRank, netOf, planSummary } from "./rules";
import { fmtUsd } from "@/lib/format";
import { whatIfI18n } from "@/i18n/ns/whatIf";

export type PlanParams = Omit<CommissionPlan, "type">;
export type TariffOption = { id: string; label: string; note?: string; plan: PlanParams };

/** Generic example tariffs (regulatory fees kept, as the presets do). Labels are getters: they follow the UI language. */
export const TARIFF_EXAMPLES: TariffOption[] = [
  {
    id: "ex-share", get label() { return whatIfI18n.t("tariffs.exShare.label"); }, get note() { return whatIfI18n.t("tariffs.exShare.note"); },
    plan: { perShare: 0.002, minPerOrder: 0.25, ecnPerShare: 0.001, keepRegulatory: true },
  },
  {
    id: "ex-flat", get label() { return whatIfI18n.t("tariffs.exFlat.label"); }, get note() { return whatIfI18n.t("tariffs.exFlat.note"); },
    plan: { perShare: 0, minPerOrder: 1, ecnPerShare: 0, keepRegulatory: true },
  },
];

export type Question = {
  id: "after3" | "worstSetups" | "aplus" | "tariff" | "dayLimit";
  label: string;
  /** Short explanation under the chip / in the tooltip. */
  hint: string;
  rule: Rule | null;
  /** Why the question cannot be asked of this data (chip disabled), or null. */
  disabled: string | null;
};

type PresetLike = { id: string; label: string; rules: Rule[] };

/** Losing setups with at least `minTrades` trades, worst (most negative net) first. */
export function worstSetups(trades: PreviewTrade[], minTrades = 5, limit = 2): { name: string; net: number; n: number }[] {
  const by = new Map<string, { name: string; net: number; n: number }>();
  for (const t of trades) {
    const net = netOf(t);
    const s = t.setup?.trim();
    if (net == null || !s) continue;
    const k = s.toLowerCase();
    const e = by.get(k) ?? { name: s, net: 0, n: 0 };
    e.net += net; e.n++;
    by.set(k, e);
  }
  return [...by.values()].filter((e) => e.n >= minTrades && e.net < 0).sort((a, b) => a.net - b.net).slice(0, limit)
    .map((e) => ({ ...e, net: Math.round(e.net * 100) / 100 }));
}

/** The tariff with the lowest total fees on these trades; null when none beats the actual fees (or no qty known). */
export function cheapestTariff(trades: PreviewTrade[], options: TariffOption[]): { option: TariffOption; saving: number } | null {
  const actual = planSummary(trades, null);
  let best: { option: TariffOption; saving: number } | null = null;
  for (const o of options) {
    const s = planSummary(trades, o.plan);
    const saving = Math.round((actual.fees - s.fees) * 100) / 100;
    if (saving > 0 && (!best || saving > best.saving)) best = { option: o, saving };
  }
  return best;
}

/** Tariffs to try: commission presets from the server first, then the generic examples. */
export function tariffOptions(presets: PresetLike[]): TariffOption[] {
  const out: TariffOption[] = [];
  for (const p of presets) {
    const r = p.rules.length === 1 ? p.rules[0] : null;
    if (r?.type === "commissionPlan") out.push({ id: `preset-${p.id}`, label: p.label, plan: { perShare: r.perShare, minPerOrder: r.minPerOrder, ecnPerShare: r.ecnPerShare, keepRegulatory: r.keepRegulatory } });
  }
  return [...out, ...TARIFF_EXAMPLES];
}

/** Median of the trader's losing days, rounded to a «nice» number (for «а если бы я стопил день на …»). */
export function typicalDayLoss(trades: PreviewTrade[]): number | null {
  const byDay = new Map<string, number>();
  for (const t of trades) { const n = netOf(t); if (n != null) byDay.set(t.day, (byDay.get(t.day) ?? 0) + n); }
  const losses = [...byDay.values()].filter((v) => v < 0).map(Math.abs).sort((a, b) => a - b);
  if (losses.length < 3) return null;
  const m = losses[Math.floor((losses.length - 1) / 2)];
  const nice = m < 100 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50;
  return nice > 0 ? nice : null;
}

/** The question chips for these trades (always the same five, some disabled with a reason). */
export function buildQuestions(trades: PreviewTrade[], presets: PresetLike[]): Question[] {
  const t = whatIfI18n.t;
  const qs: Question[] = [];
  qs.push({ id: "after3", label: t("questions.after3.label"), hint: t("questions.after3.hint"), rule: { type: "stopAfterLosses", n: 3 }, disabled: null });

  const dl = typicalDayLoss(trades);
  qs.push({
    id: "dayLimit", label: dl ? t("questions.dayLimit.label", { amount: fmtUsd(dl, { decimals: 0 }) }) : t("questions.dayLimit.labelBare"), hint: dl ? t("questions.dayLimit.hint") : "",
    rule: dl ? { type: "dailyLossLimit", usd: dl } : null, disabled: dl ? null : t("questions.dayLimit.disabled"),
  });

  const hasSetups = trades.some((tr) => tr.setup?.trim());
  const worst = worstSetups(trades);
  qs.push({
    id: "worstSetups",
    label: worst.length ? t("questions.worstSetups.label", { setups: worst.map((w) => w.name).join(", ") }) : t("questions.worstSetups.labelBare"),
    hint: worst.length ? t("questions.worstSetups.hint", { list: worst.map((w) => `${w.name} ${fmtUsd(w.net, { decimals: 0 })}`).join(", ") }) : "",
    rule: worst.length ? { type: "excludeSetups", setups: worst.map((w) => w.name) } : null,
    disabled: worst.length ? null : hasSetups ? t("questions.worstSetups.noLosing") : t("questions.worstSetups.noSetups"),
  });

  const graded = trades.some((tr) => gradeRank(tr.grade) != null);
  qs.push({ id: "aplus", label: t("questions.aplus.label"), hint: t("questions.aplus.hint"), rule: graded ? { type: "minGrade", grade: "A+" } : null, disabled: graded ? null : t("questions.aplus.disabled") });

  const best = cheapestTariff(trades, tariffOptions(presets));
  qs.push({
    id: "tariff", label: best ? t("questions.tariff.label", { name: best.option.label }) : t("questions.tariff.labelBare"),
    hint: best ? t("questions.tariff.hint", { note: best.option.note ?? t("questions.tariff.presetNote"), amount: fmtUsd(best.saving, { decimals: 0 }) }) : "",
    rule: best ? { type: "commissionPlan", ...best.option.plan } : null,
    disabled: best ? null : trades.some((tr) => tr.qty != null) ? t("questions.tariff.noCheaper") : t("questions.tariff.noQty"),
  });
  return qs;

}

export type DayChange = { day: string; before: number; after: number; delta: number; removed: boolean };

/** Days whose net the scenario changed, biggest change first. A day with no scenario trades is «removed». */
export function changedDays(base: { day: string; net: number }[], scenario: { day: string; net: number }[], limit = 8): DayChange[] {
  const sc = new Map(scenario.map((d) => [d.day, d.net]));
  const out: DayChange[] = [];
  for (const d of base) {
    const after = sc.get(d.day) ?? 0;
    const delta = Math.round((after - d.net) * 100) / 100;
    if (Math.abs(delta) < 0.005) continue;
    out.push({ day: d.day, before: d.net, after, delta, removed: !sc.has(d.day) });
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.day.localeCompare(b.day)).slice(0, limit);
}
