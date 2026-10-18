import type { Trade } from "@workspace/api-client-react";
import { ApiError, http } from "@/lib/api/http";
import { splitTags } from "./trade-utils";
import { tradesI18n } from "@/i18n/ns/trades";

export type BulkBody =
  | { action: "delete" | "restore"; ids: number[] }
  | { action: "setResult"; ids: number[]; result: string }
  | { action: "addTags" | "removeTags"; ids: number[]; tags: string[] }
  | { action: "setSetup"; ids: number[]; setup: string | null };


/**
 * POST /api/trades/bulk; falls back to per-trade requests when the running API
 * predates the bulk endpoint (404). Returns the ids that were actually changed.
 */
export async function bulkTrades(body: BulkBody, trades: Trade[]): Promise<number[]> {
  try {
    const d = await http.post<{ updated?: number[] } | null>("/api/trades/bulk", body, { responseType: "auto" });
    return Array.isArray(d?.updated) ? d.updated : body.ids;
  } catch (e) {
    // 404: no bulk endpoint; 400 on setSetup: an API build that predates the action → per-trade fallback.
    const status = e instanceof ApiError ? e.status : null;
    if (status !== 404 && !(status === 400 && body.action === "setSetup")) throw e;
  }

  const byId = new Map(trades.map((t) => [t.id, t]));
  const tags: string[] = "tags" in body ? body.tags : [];
  const one = async (id: number): Promise<number | null> => {
    if (body.action === "delete") await http.del(`/api/trades/${id}`, undefined, { responseType: "auto" });
    else if (body.action === "restore") await http.post(`/api/trades/${id}/restore`, undefined, { responseType: "auto" });
    else {
      let patch: Record<string, unknown>;
      if (body.action === "setResult") patch = { result: body.result };
      else if (body.action === "setSetup") patch = { setup: body.setup };
      else {
        const cur = splitTags(byId.get(id)?.tags);
        const lower = new Set(tags.map((t) => t.toLowerCase()));
        const next = body.action === "addTags"
          ? [...cur, ...tags.filter((t) => !cur.some((c) => c.toLowerCase() === t.toLowerCase()))]
          : cur.filter((c) => !lower.has(c.toLowerCase()));
        patch = { tags: next.length ? next.join(", ") : null };
      }
      await http.patch(`/api/trades/${id}`, patch, { responseType: "auto" });
    }
    return id;
  };
  const done = await Promise.all(body.ids.map((id) => one(id).catch(() => null)));
  const ok = done.filter((x): x is number => x != null);
  if (!ok.length) throw new Error(tradesI18n.t("bulk.noneChanged"));
  return ok;
}
