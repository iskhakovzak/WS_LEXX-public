import { useEffect, useState } from "react";
import { http, ApiError } from "@/lib/api/http";
import { compressImage, imageFilesFrom } from "@/components/game-plan/media";
import { playbookI18n } from "@/i18n/ns/playbook";

/**
 * Playbook screenshots (setup card + example trades): same approach as game-plan media —
 * client-side compression → POST /api/playbook-media?playbookId= (raw bytes) → { id }.
 * Read back with http.raw (the global fetch patch adds the Bearer token) and shown as blob: URLs, so no token
 * ever ends up in an <img src>. compressImage / imageFilesFrom are imported read-only from game-plan.
 */
export { imageFilesFrom };

export type UploadedPlaybookMedia = { id: number; url: string; size: number };

const blobUrls = new Map<number, string>();
const inflight = new Map<number, Promise<string>>();

export async function uploadPlaybookImage(file: Blob, playbookId: number): Promise<UploadedPlaybookMedia> {
  const { blob, width, height } = await compressImage(file);
  let out: UploadedPlaybookMedia;
  try {
    out = await http.post<UploadedPlaybookMedia>("/api/playbook-media", blob, {
      query: { playbookId, w: width, h: height },
      headers: { "Content-Type": blob.type || "image/jpeg" },
    });
  } catch (e) {
    // An API build without the media route answers a bare 404.
    if (e instanceof ApiError && e.status === 404 && !e.field("error")) {
      throw new ApiError({ status: 404, message: playbookI18n.t("mediaNotLive"), body: e.body, method: e.method, url: e.url });
    }
    throw e;
  }
  blobUrls.set(out.id, URL.createObjectURL(blob));
  return out;
}

function loadImage(id: number): Promise<string> {
  const cached = blobUrls.get(id);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(id);
  if (pending) return pending;
  const p = http
    .raw(`/api/playbook-media/${id}`)
    .then(async (r) => {
      const url = URL.createObjectURL(await r.blob());
      blobUrls.set(id, url);
      return url;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/** blob: URL for a stored screenshot (null while loading; "error" when it can't be shown). */
export function usePlaybookMediaUrl(id: number | null | undefined): string | null | "error" {
  const [state, setState] = useState<string | null | "error">(() => (id ? blobUrls.get(id) ?? null : null));
  useEffect(() => {
    if (!id) { setState(null); return; }
    let alive = true;
    const hit = blobUrls.get(id);
    if (hit) { setState(hit); return; }
    setState(null);
    loadImage(id).then((u) => alive && setState(u)).catch(() => alive && setState("error"));
    return () => { alive = false; };
  }, [id]);
  return state;
}
