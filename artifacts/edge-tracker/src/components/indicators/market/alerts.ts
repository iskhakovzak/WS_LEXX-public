/**
 * Alert thresholds for market indicators («VIX выше 20»), per user.
 *
 * Stored in the existing per-user table behind /api/indicator-notes (no new endpoint, works on the running API):
 * row key `mkt-alert.<indicatorId>`, note = JSON `{"op":"above"|"below","value":number}`; removing an alert writes
 * an empty note (the route never deletes). The library's notes/favourites ignore this prefix (see storage.ts).
 * localStorage keeps a copy for instant paint and as the fallback when the API is unreachable.
 */
import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import type { AlertRule, IndicatorId } from "./engine";

export const MARKET_ALERT_PREFIX = "mkt-alert.";
const LOCAL_KEY = "indicator-market-alerts-v1";
const API = "/api/indicator-notes";
const QK = ["indicator-notes", "market-alerts"] as const;

export type AlertMap = Partial<Record<IndicatorId, AlertRule>>;

export function parseRule(note: unknown): AlertRule | null {
  if (typeof note !== "string" || !note.trim()) return null;
  try {
    const v = JSON.parse(note) as { op?: unknown; value?: unknown };
    if ((v.op === "above" || v.op === "below") && typeof v.value === "number" && Number.isFinite(v.value)) return { op: v.op, value: v.value };
  } catch { /* not ours */ }
  return null;
}

function loadLocal(): AlertMap {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}") as Record<string, unknown>;
    const out: AlertMap = {};
    for (const [k, v] of Object.entries(raw ?? {})) {
      const rule = parseRule(JSON.stringify(v));
      if (rule) out[k as IndicatorId] = rule;
    }
    return out;
  } catch {
    return {};
  }
}
function saveLocal(m: AlertMap) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(m)); } catch { /* storage unavailable */ }
}

async function fetchAlerts(): Promise<AlertMap | null> {
  try {
    const d = await http.get<{ items?: Array<{ key?: string; note?: string }> }>(API);
    const out: AlertMap = {};
    for (const it of d.items ?? []) {
      if (typeof it.key !== "string" || !it.key.startsWith(MARKET_ALERT_PREFIX)) continue;
      const rule = parseRule(it.note);
      if (rule) out[it.key.slice(MARKET_ALERT_PREFIX.length) as IndicatorId] = rule;
    }
    return out;
  } catch {
    return null;
  }
}

/** Alerts map + setter. `synced` = the server answered (false ⇒ only this browser has them). */
export function useMarketAlerts() {
  const qc = useQueryClient();
  const [local, setLocal] = useState<AlertMap>(loadLocal);
  const q = useQuery({ queryKey: QK, queryFn: fetchAlerts, staleTime: STALE.long, refetchOnWindowFocus: false });

  useEffect(() => {
    if (q.data) { setLocal(q.data); saveLocal(q.data); }
  }, [q.data]);

  const setAlert = useCallback(async (id: IndicatorId, rule: AlertRule | null): Promise<boolean> => {
    setLocal((prev) => {
      const next = { ...prev };
      if (rule) next[id] = rule; else delete next[id];
      saveLocal(next);
      return next;
    });
    try {
      await http.put(`${API}/${encodeURIComponent(MARKET_ALERT_PREFIX + id)}`, { note: rule ? JSON.stringify(rule) : "" });
      qc.setQueryData<AlertMap | null>(QK, (prev) => {
        const next = { ...(prev ?? {}) };
        if (rule) next[id] = rule; else delete next[id];
        return next;
      });
      return true;
    } catch {
      return false;
    }
  }, [qc]);

  return { alerts: local, setAlert, synced: q.data != null };
}
