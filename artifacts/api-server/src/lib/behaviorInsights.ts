/**
 * Тексты «почему это вредит» и конкретное правило-рекомендация для каждого поведенческого паттерна,
 * плюс действие для кнопки «Сделать правилом»:
 *   rule    — есть подходящий вид в правилах деска (lib/rulesEngine RULE_KINDS → POST /api/rules, сканер нарушений);
 *   trigger — личный триггер (lib/behaviorTriggers → POST /api/behavior/triggers), если вида правила нет.
 * Чистые функции; числа в рекомендации — из параметров/норм трейдера, а не константы.
 */
import type { PatternKey } from "./behaviorEngine";
import type { TriggerKind } from "./behaviorTriggers";
import { describeTrigger } from "./behaviorTriggers";
import { behaviorT, fmtDurFor } from "./behaviorI18n";
import { DEFAULT_LANG, type Lang } from "../i18n";

export type TriggerDraft = { kind: TriggerKind; params: Record<string, number>; name: string };
export type RuleDraft = { kind: string; threshold: Record<string, number>; name: string };

export type PatternInsight = {
  why: string;
  recommendation: string;
  /** Текст правила для копирования / напоминания. */
  ruleText: string;
  /** Подходящее правило деска (если есть вид). */
  rule: RuleDraft | null;
  /** Личный триггер (всегда есть — запасной путь, если правила нет). */
  trigger: TriggerDraft;
};

type InsightInput = {
  key: PatternKey;
  extra: Record<string, number | string | null>;
  opts: { revengeMin: number; martingaleRatio: number; euphoriaMin: number; morningEndMin: number };
};

const num = (v: number | string | null | undefined, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clock = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

function trig(kind: TriggerKind, params: Record<string, number>, lang: Lang): TriggerDraft {
  return { kind, params, name: describeTrigger(kind, params, lang) };
}

/** Insight texts in `lang`; rule / trigger names are the defaults offered to the user (user content once saved). */
export function insightFor({ key, extra, opts }: InsightInput, lang: Lang = DEFAULT_LANG): PatternInsight {
  const t = behaviorT.tFor(lang);
  switch (key) {
    case "revenge": {
      const pause = Math.max(10, Math.ceil(opts.revengeMin * 1.5 / 5) * 5);
      return {
        why: t("insights.revenge.why"),
        recommendation: t("insights.revenge.recommendation", { pause }),
        ruleText: t("insights.revenge.ruleText", { pause }),
        rule: null,
        trigger: trig("quick_after_loss", { minutes: pause }, lang),
      };
    }
    case "martingale": {
      const r = opts.martingaleRatio;
      return {
        why: t("insights.martingale.why"),
        recommendation: t("insights.martingale.recommendation"),
        ruleText: t("insights.martingale.ruleText"),
        rule: null,
        trigger: trig("size_up_after_loss", { ratio: r }, lang),
      };
    }
    case "overtrading": {
      const n = Math.max(1, Math.round(num(extra.norm, 10)));
      return {
        why: t("insights.overtrading.why"),
        recommendation: t("insights.overtrading.recommendation", { n, median: num(extra.medianPerDay, 0) }),
        ruleText: t("insights.overtrading.ruleText", { n }),
        rule: { kind: "max_trades_per_day", threshold: { n }, name: t("insights.overtrading.ruleName", { n }) },
        trigger: trig("max_trades_day", { n }, lang),
      };
    }
    case "fatigue": {
      const cut = Math.max(2, Math.round(num(extra.cut, 5)));
      return {
        why: t("insights.fatigue.why"),
        recommendation: t("insights.fatigue.recommendation", { cut }),
        ruleText: t("insights.fatigue.ruleText", { cut }),
        rule: null,
        trigger: trig("max_trades_day", { n: cut }, lang),
      };
    }
    case "chase": {
      const usd = Math.max(1, Math.round(num(extra.threshold, 150)));
      const time = clock(opts.morningEndMin);
      return {
        why: t("insights.chase.why"),
        recommendation: t("insights.chase.recommendation", { usd, time }),
        ruleText: t("insights.chase.ruleText", { usd, time }),
        rule: null,
        trigger: trig("red_morning", { usd }, lang),
      };
    }
    case "tilt":
      return {
        why: t("insights.tilt.why"),
        recommendation: t("insights.tilt.recommendation"),
        ruleText: t("insights.tilt.ruleText"),
        rule: { kind: "no_trade_after_n_losses", threshold: { n: 3 }, name: t("insights.tilt.ruleName") },
        trigger: trig("loss_streak", { n: 3 }, lang),
      };
    case "disposition": {
      const m = Math.max(1, Math.round(num(extra.medianHoldWinMin, 10) * 2));
      const hold = fmtDurFor(lang, m);
      return {
        why: t("insights.disposition.why"),
        recommendation: t("insights.disposition.recommendation", { hold }),
        ruleText: t("insights.disposition.ruleText", { hold }),
        rule: null,
        trigger: trig("long_loser_hold", { minutes: m }, lang),
      };
    }
    case "firstTrade":
      return {
        why: t("insights.firstTrade.why"),
        recommendation: t("insights.firstTrade.recommendation"),
        ruleText: t("insights.firstTrade.ruleText"),
        rule: null,
        trigger: { kind: "custom", params: {}, name: t("insights.firstTrade.triggerName") },
      };
    case "euphoria": {
      const usd = Math.max(1, Math.round(num(extra.bigWinThreshold, 100)));
      return {
        why: t("insights.euphoria.why"),
        recommendation: t("insights.euphoria.recommendation", { usd, min: opts.euphoriaMin }),
        ruleText: t("insights.euphoria.ruleText", { usd, min: opts.euphoriaMin }),
        rule: null,
        trigger: trig("after_big_win", { usd, minutes: opts.euphoriaMin }, lang),
      };
    }
  }
}
