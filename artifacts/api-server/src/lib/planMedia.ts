import { pool } from "@workspace/db";
import { safeHttpUrl } from "./safe-url";

/**
 * Plan media ("План дня" screenshots) + TradingView link helpers.
 *
 * Object storage is a Replit sidecar that does not exist locally, so plan screenshots live in Postgres:
 * the client resizes to ≤1600px and re-encodes (WebP/JPEG ~0.8) before upload, the server only sniffs the
 * magic bytes, enforces the size/quota limits and stores the bytes. Plans reference media by id
 * ({ id, caption }) inside their JSON; removing a reference and saving soft-deletes the row.
 *
 * No server-side fetching of external URLs: TradingView snapshots are rendered by the browser directly.
 */

export type MediaContext = "desk" | "personal";

/** Hard cap per image after client-side compression (a 1600px WebP is usually 80–400 KB). */
export const PLAN_MEDIA_MAX_BYTES = 2_500_000;
/** Uploads per member per rolling 24h (abuse guard, not a product limit). */
export const PLAN_MEDIA_DAILY_LIMIT = 150;
export const PLAN_MEDIA_MAX_PER_PLAN = 12;
export const PLAN_MEDIA_MAX_PER_TICKER = 8;

let ensured: Promise<void> | null = null;
export function ensurePlanMedia(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(
        `CREATE TABLE IF NOT EXISTS plan_media (
           id SERIAL PRIMARY KEY,
           context TEXT NOT NULL,
           owner TEXT NOT NULL,
           plan_date TEXT NOT NULL,
           mime TEXT NOT NULL,
           bytes BYTEA NOT NULL,
           size_bytes INTEGER NOT NULL,
           width INTEGER,
           height INTEGER,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           deleted_at TIMESTAMPTZ
         );
         CREATE INDEX IF NOT EXISTS plan_media_owner_created_idx ON plan_media (owner, created_at);
         CREATE INDEX IF NOT EXISTS plan_media_date_idx ON plan_media (plan_date, context);`,
      )
      .then(() => undefined)
      .catch((err) => {
        ensured = null;
        throw err;
      });
  }
  return ensured;
}

/** Image type from magic bytes (never trust the Content-Type header). */
export function sniffImageMime(buf: Buffer): "image/webp" | "image/jpeg" | "image/png" | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Ids from a list of media refs (ignores junk). */
export function mediaIds(refs: unknown): number[] {
  if (!Array.isArray(refs)) return [];
  const out: number[] = [];
  for (const r of refs) {
    const id = Number((r as { id?: unknown })?.id);
    if (Number.isSafeInteger(id) && id > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Every media id referenced by a plan document (plan level + per ticker). */
export function collectPlanMediaIds(doc: { media?: unknown; inPlay?: unknown } | null | undefined): number[] {
  if (!doc) return [];
  const ids = new Set<number>(mediaIds(doc.media));
  if (Array.isArray(doc.inPlay)) for (const item of doc.inPlay) for (const id of mediaIds((item as { media?: unknown })?.media)) ids.add(id);
  return [...ids];
}

/**
 * Which of `ids` may be referenced from a plan in `context` (and, for personal plans, owned by `owner`).
 * Unknown / deleted / foreign ids are dropped silently by the caller.
 */
export async function allowedMediaIds(ids: number[], context: MediaContext, owner: string | null): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  await ensurePlanMedia();
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM plan_media
      WHERE id = ANY($1::int[]) AND context = $2 AND deleted_at IS NULL
        AND ($3::text IS NULL OR owner = $3)`,
    [ids, context, owner],
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * Soft-delete media that the previous version of a plan referenced and the new one no longer does.
 * Only rows uploaded for this same plan date are touched, so a plan copied from yesterday never
 * removes yesterday's screenshots.
 */
export async function softDeleteDropped(
  before: number[],
  after: number[],
  context: MediaContext,
  date: string,
  owner: string | null,
): Promise<void> {
  const keep = new Set(after);
  const dropped = before.filter((id) => !keep.has(id));
  if (dropped.length === 0) return;
  await ensurePlanMedia();
  await pool.query(
    `UPDATE plan_media SET deleted_at = NOW()
      WHERE id = ANY($1::int[]) AND context = $2 AND plan_date = $3 AND deleted_at IS NULL
        AND ($4::text IS NULL OR owner = $4)`,
    [dropped, context, date, owner],
  );
}

/** Keep only allowed refs in a plan document (mutates a shallow copy). */
export function filterPlanMedia<T extends { media: { id: number; caption: string }[]; inPlay: { media: { id: number; caption: string }[] }[] }>(
  doc: T,
  allowed: Set<number>,
): T {
  return {
    ...doc,
    media: doc.media.filter((m) => allowed.has(m.id)),
    inPlay: doc.inPlay.map((i) => ({ ...i, media: i.media.filter((m) => allowed.has(m.id)) })),
  };
}

// ── TradingView links ─────────────────────────────────────────────────────────

export type TradingViewLink =
  | { kind: "snapshot"; url: string; id: string; imageUrl: string }
  | { kind: "chart"; url: string; symbol: string | null; exchange: string | null }
  | { kind: "other"; url: string };

const TV_HOST = /^(?:[a-z0-9-]+\.)?tradingview\.com$/i;
const SNAPSHOT_ID = /^[A-Za-z0-9]{6,16}$/;
const SYMBOL = /^[A-Za-z0-9._!-]{1,24}$/;

function splitSymbol(raw: string): { symbol: string | null; exchange: string | null } {
  const s = decodeURIComponent(raw).trim();
  const m = s.split(/[:-]/);
  if (m.length >= 2 && SYMBOL.test(m[0]!) && SYMBOL.test(m.slice(1).join("-"))) {
    return { exchange: m[0]!.toUpperCase(), symbol: m.slice(1).join("-").toUpperCase() };
  }
  return SYMBOL.test(s) ? { symbol: s.toUpperCase(), exchange: null } : { symbol: null, exchange: null };
}

/**
 * Classify a TradingView URL. Returns null when the URL is not a safe https link on tradingview.com.
 *   https://www.tradingview.com/x/AbCd1234/            → snapshot (image at s3.tradingview.com/snapshots/a/AbCd1234.png)
 *   https://www.tradingview.com/chart/?symbol=NASDAQ:NVDA, /chart/<layout>/?symbol=…, /chart/NVDA/<idea>/ → chart
 *   https://www.tradingview.com/symbols/NASDAQ-NVDA/   → chart
 */
export function parseTradingViewUrl(raw: string | null | undefined): TradingViewLink | null {
  const safe = safeHttpUrl(raw);
  if (!safe) return null;
  let u: URL;
  try {
    u = new URL(safe);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !TV_HOST.test(u.hostname) || u.username || u.password) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  const url = u.toString();
  if (parts[0] === "x" && parts[1] && SNAPSHOT_ID.test(parts[1])) {
    const id = parts[1];
    return { kind: "snapshot", url, id, imageUrl: `https://s3.tradingview.com/snapshots/${id[0]!.toLowerCase()}/${id}.png` };
  }
  if (parts[0] === "chart") {
    const q = u.searchParams.get("symbol");
    if (q) return { kind: "chart", url, ...splitSymbol(q) };
    // Ideas: /chart/NVDA/AbCdEf12-title/ — first segment is the ticker when it looks like one (layout ids are mixed-case).
    const seg = parts[1];
    if (seg && parts.length >= 3 && /^[A-Z0-9.!]{1,12}$/.test(seg)) return { kind: "chart", url, symbol: seg, exchange: null };
    return { kind: "chart", url, symbol: null, exchange: null };
  }
  if (parts[0] === "symbols" && parts[1]) return { kind: "chart", url, ...splitSymbol(parts[1]) };
  return { kind: "other", url };
}
