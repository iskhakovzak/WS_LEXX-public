/**
 * First entry / last exit execution time per trade as `e.first_entry` / `e.last_exit` (NULL when a trade has no
 * timed executions). Returns a complete `LEFT JOIN … e …` clause for a trades alias.
 *
 * - "lateral": one index probe per trade (trade_executions_trade_idx). Use when the trade set is bounded — one
 *   trader, one day, one playbook. Local DB: day report 30 → 3 ms, challenge window 30 → 5 ms.
 * - "global": aggregates every execution once (hash) and joins. Cheaper for desk-wide scans (≳10k trades), where
 *   per-row probes lose (45k trades: 0.8 s global vs 1.4 s lateral).
 * Both modes return identical values.
 */
export function execSpanJoin(mode: "lateral" | "global", alias = "t"): string {
  if (mode === "lateral") {
    return `LEFT JOIN LATERAL (
      SELECT MIN(x.executed_at) FILTER (WHERE x.kind IN ('entry','add')) AS first_entry,
             MAX(x.executed_at) FILTER (WHERE x.kind IN ('exit','stop','trim')) AS last_exit
        FROM trade_executions x
       WHERE x.trade_id = ${alias}.id AND x.executed_at IS NOT NULL
    ) e ON TRUE`;
  }
  return `LEFT JOIN (
      SELECT trade_id,
             MIN(executed_at) FILTER (WHERE kind IN ('entry','add')) AS first_entry,
             MAX(executed_at) FILTER (WHERE kind IN ('exit','stop','trim')) AS last_exit
        FROM trade_executions
       WHERE executed_at IS NOT NULL
       GROUP BY trade_id
    ) e ON e.trade_id = ${alias}.id`;
}
