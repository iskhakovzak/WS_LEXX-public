import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { apiErrorStatus } from "@/lib/api/errors";
import { STALE } from "@/lib/api/keys";
import { qualityKeys } from "@/lib/query-keys";
import type { TradeQualityLite, QualityMap } from "@/components/trades/trade-utils";
import { DEFAULT_AFTER_EXIT, type QualityBatchResponse, type QualityRecord } from "./types";


/** Quality of one trade (detail sheet). `refresh` forces a recompute on the server. */
export function useTradeQuality(tradeId: number | null | undefined, afterExit = DEFAULT_AFTER_EXIT) {
  const qc = useQueryClient();
  const query = useQuery<QualityRecord>({
    queryKey: qualityKeys.one(tradeId ?? 0, afterExit),
    queryFn: ({ signal }) => http.get<QualityRecord>(`/api/trades/${tradeId}/quality?afterExit=${afterExit}`, { signal }),
    enabled: Boolean(tradeId),
    staleTime: STALE.short,
    retry: (count, err) => apiErrorStatus(err) === 503 && count < 2,
  });
  const refresh = async () => {
    if (!tradeId) return;
    const rec = await http.get<QualityRecord>(`/api/trades/${tradeId}/quality?afterExit=${afterExit}&refresh=1`);
    qc.setQueryData(qualityKeys.one(tradeId, afterExit), rec);
    void qc.invalidateQueries({ queryKey: ["trades-quality"] });
  };
  return { ...query, refresh };
}

export function toLite(rec: QualityRecord): TradeQualityLite {
  const q = rec.quality;
  return {
    status: q.status,
    exitEfficiency: q.exitEfficiency,
    mfeR: q.mfe?.r ?? null,
    maeR: q.mae?.r ?? null,
    mfeUsd: q.mfe?.usd ?? null,
    capturedR: q.captured?.r ?? null,
    leftOnTableR: q.leftOnTable?.r ?? null,
    leftOnTableUsd: q.leftOnTable?.usd ?? null,
  };
}

const CHUNK = 150;

/**
 * Quality for many trades (table / summary strip). One request per 150 ids; the server answers cached rows
 * immediately and computes a bounded number of misses per call — while `pending` is non-empty we poll
 * again (only for the pending ids), so the map fills in progressively without an N+1.
 */
export function useTradesQuality(ids: number[], opts: { enabled?: boolean; afterExit?: number } = {}) {
  const afterExit = opts.afterExit ?? DEFAULT_AFTER_EXIT;
  const enabled = opts.enabled !== false && ids.length > 0;
  const key = useMemo(() => [...ids].sort((a, b) => a - b), [ids]);
  const [map, setMap] = useState<QualityMap>({});
  const [pending, setPending] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const runRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const run = ++runRef.current;
    let cancelled = false;
    let todo = key.filter((id) => map[id] === undefined);
    if (!todo.length) { setPending([]); return; }
    setLoading(true);
    (async () => {
      let rounds = 0;
      while (todo.length && !cancelled && runRef.current === run && rounds < 40) {
        rounds++;
        const next: number[] = [];
        for (let i = 0; i < todo.length; i += CHUNK) {
          const chunk = todo.slice(i, i + CHUNK);
          try {
            const res = await http.get<QualityBatchResponse>(`/api/trade-quality?ids=${chunk.join(",")}&afterExit=${afterExit}`);
            if (cancelled || runRef.current !== run) return;
            setMap((m) => {
              const out = { ...m };
              for (const rec of res.items) out[rec.tradeId] = toLite(rec);
              return out;
            });
            next.push(...res.pending);
          } catch {
            // Network / auth problem: stop polling this round; the table simply shows «—».
            if (cancelled || runRef.current !== run) return;
          }
        }
        todo = next;
        setPending(next);
        if (next.length) await new Promise((r) => setTimeout(r, 1500));
      }
      if (!cancelled && runRef.current === run) { setLoading(false); setPending([]); }
    })();
    return () => { cancelled = true; };
    // `map` intentionally excluded: we only want to re-run when the id set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key.join(","), enabled, afterExit]);

  return { quality: map, pending, loading };
}
