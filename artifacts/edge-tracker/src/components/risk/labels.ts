/**
 * Display labels for risk codes (level / status / stop state / horizon / side / alert kind) and the stop message,
 * built from codes + numbers in the current language. Call at render time, never at module scope.
 */
import { riskI18n } from "@/i18n/ns/risk";
import { commonI18n } from "@/i18n/ns/common";
import { fmtPct, fmtUsd } from "@/lib/format";
import { isShort, type RankLevel } from "./risk-math";
import type { Horizon, RiskAlert, RiskLimits, RiskMetrics, RiskStatus, StopState } from "./use-risk";

/** Server WARN_PCT: usage ≥ 70% of a limit is a warning. */
export const WARN_PCT = 70;

export const levelLabel = (l: RankLevel) => riskI18n.t(`level.${l}`);
export const statusLabel = (s: RiskStatus) => riskI18n.t(`status.${s}`);
export const stopStateLabel = (s: StopState) => riskI18n.t(`stopState.${s}`);
export const horizonLabel = (h: Horizon) => commonI18n.t(`trading.${h}`);

/** «Лонг» / «Шорт» (EN/UZ Long / Short) from any broker side spelling; «—» when unknown. */
export function sideLabel(side: string | null | undefined): string {
  if (!side || !side.trim()) return "—";
  return commonI18n.t(isShort(side) ? "trading.short" : "trading.long");
}

/** Alert label from its kind; the server's (Russian) label only for a kind this client does not know. */
export function alertLabel(a: Pick<RiskAlert, "kind" | "label">): string {
  return riskI18n.tryT(`alertKind.${a.kind}`) ?? a.label;
}

export const positionsCount = (count: number) => riskI18n.t("units.positions", { count });

const usd0 = (v: number) => fmtUsd(v, { decimals: 0 });
const loss0 = (v: number) => fmtUsd(-Math.abs(v), { decimals: 0 });
const pct0 = (v: number) => fmtPct(v, { decimals: 0, signed: false });

type StopInput = Pick<RiskMetrics, "stop" | "today" | "week" | "drawdown">;

/**
 * One-line stop message with exact numbers (mirrors the server's computeStop):
 *   stop      → «Дневной лимит убытка исчерпан: −$520 из $500.»
 *   warn / ok → «Дневной лимит убытка: осталось $120 (использовано 76%)» (· weekly · drawdown when ≥ 70%)
 */
export function stopMessage(m: StopInput, limits: RiskLimits | null | undefined): string {
  const t = riskI18n.t;
  const s = m.stop;
  const dayLoss = Math.max(0, -(m.today.pnlNet ?? 0));
  const weekLoss = Math.max(0, -(m.week.pnlNet ?? 0));
  const dd = Math.max(0, m.drawdown.currentUsd);
  // Limit from the trader's limits; else back from the usage % (server rounds it to 0.1%), else remaining + used.
  const limitOf = (own: number | null | undefined, remaining: number | null, used: number, pct: number | null) =>
    own ?? (pct != null && pct > 0 ? Math.round((used * 100) / pct) : remaining != null ? remaining + used : used);
  switch (s.state) {
    case "no_limits":
      return t("stopMsg.noLimits");
    case "drawdown":
      return t("stopMsg.drawdown", { used: usd0(dd), limit: usd0(limitOf(limits?.maxDrawdown, s.drawdownRemainingUsd, dd, s.drawdownPct)) });
    case "weekly":
      return t("stopMsg.weekly", { used: loss0(weekLoss), limit: usd0(limitOf(limits?.weeklyLossLimit, s.weeklyRemainingUsd, weekLoss, s.weeklyPct)) });
    case "stop":
      return t("stopMsg.daily", { used: loss0(dayLoss), limit: usd0(limitOf(limits?.dailyLossLimit, s.dailyRemainingUsd, dayLoss, s.dailyPct)) });
  }
  const daily = s.dailyRemainingUsd != null ? t("stopMsg.dailyLeft", { left: usd0(s.dailyRemainingUsd), pct: pct0(s.dailyPct ?? 0) }) : null;
  const weekly = s.weeklyRemainingUsd != null ? t("stopMsg.weeklyLeft", { left: usd0(s.weeklyRemainingUsd), pct: pct0(s.weeklyPct ?? 0) }) : null;
  const draw = s.drawdownRemainingUsd != null ? t("stopMsg.drawdownLeft", { left: usd0(s.drawdownRemainingUsd), pct: pct0(s.drawdownPct ?? 0) }) : null;
  if (s.state === "warn") {
    const parts = [
      (s.dailyPct ?? 0) >= WARN_PCT ? daily : null,
      (s.weeklyPct ?? 0) >= WARN_PCT ? weekly : null,
      (s.drawdownPct ?? 0) >= WARN_PCT ? draw : null,
    ].filter((x): x is string => !!x);
    if (parts.length) return parts.join(" · ");
  }
  return daily ?? weekly ?? draw ?? s.message;
}
