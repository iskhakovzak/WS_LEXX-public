/**
 * Video allow-list mirrored from api-server/src/lib/academyContent.ts (videoEmbed): YouTube, Vimeo, Loom only.
 * Used for the live preview in the content editor; the server validates again on save and returns `video`.
 */
import type { VideoEmbed } from "./api";

const YT_ID = /^[A-Za-z0-9_-]{6,20}$/;
const VIMEO_ID = /^\d{4,15}$/;
const LOOM_ID = /^[A-Za-z0-9]{10,64}$/;

export function parseStartSeconds(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s) || null;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const sec = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return sec > 0 ? sec : null;
}

export function videoEmbed(raw: string | null | undefined): VideoEmbed | null {
  if (!raw || !raw.trim()) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "youtube.com" || host === "youtube-nocookie.com" || host === "youtu.be" || host === "music.youtube.com") {
    let id: string | null = null;
    if (host === "youtu.be") id = parts[0] ?? null;
    else if (parts[0] === "watch") id = u.searchParams.get("v");
    else if (["embed", "shorts", "live", "v"].includes(parts[0] ?? "")) id = parts[1] ?? null;
    if (!id || !YT_ID.test(id)) return null;
    const start = parseStartSeconds(u.searchParams.get("t") ?? u.searchParams.get("start"));
    return { provider: "youtube", id, embedUrl: `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ""}`, watchUrl: `https://www.youtube.com/watch?v=${id}${start ? `&t=${start}s` : ""}` };
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = host === "player.vimeo.com" ? (parts[0] === "video" ? parts[1] : null) : parts.find((p) => VIMEO_ID.test(p)) ?? null;
    if (!id || !VIMEO_ID.test(id)) return null;
    return { provider: "vimeo", id, embedUrl: `https://player.vimeo.com/video/${id}`, watchUrl: `https://vimeo.com/${id}` };
  }
  if (host === "loom.com") {
    const id = parts[0] === "share" || parts[0] === "embed" ? parts[1] : null;
    if (!id || !LOOM_ID.test(id)) return null;
    return { provider: "loom", id, embedUrl: `https://www.loom.com/embed/${id}`, watchUrl: `https://www.loom.com/share/${id}` };
  }
  return null;
}

export const PROVIDER_LABEL: Record<VideoEmbed["provider"], string> = { youtube: "YouTube", vimeo: "Vimeo", loom: "Loom" };
