import { useEffect, useState } from "react";
import { http, ApiError } from "@/lib/api/http";
import { gpI18n } from "@/i18n/ns/gamePlan";

/**
 * Plan screenshots: client-side compression → POST /api/plan-media (raw bytes) → { id }.
 * Images are read back with http.raw (the global fetch patch adds the Bearer token) and shown as blob: URLs,
 * so no token ever ends up in an <img src>. Blob URLs are cached for the session.
 */
export type MediaContext = "desk" | "personal";

export const MAX_EDGE = 1600;
export const MAX_UPLOAD_BYTES = 2_400_000; // server hard cap is 2.5 MB
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

export type UploadedMedia = { id: number; width: number | null; height: number | null; size: number };

const blobUrls = new Map<number, string>();
const inflight = new Map<number, Promise<string>>();

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

async function decode(file: Blob): Promise<{ draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    const bmp = await createImageBitmap(file);
    return { draw: (ctx, w, h) => ctx.drawImage(bmp, 0, 0, w, h), width: bmp.width, height: bmp.height, close: () => bmp.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode"));
      el.src = url;
    });
    return { draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h), width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/** Resize to ≤1600px on the long edge and re-encode as WebP (JPEG fallback) ~0.8; steps down until ≤2.4 MB. */
export async function compressImage(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  if (!file.type.startsWith("image/")) throw new Error(gpI18n.t("media.notImage"));
  if (file.size > MAX_SOURCE_BYTES) throw new Error(gpI18n.t("media.tooBig"));
  let src;
  try {
    src = await decode(file);
  } catch {
    throw new Error(gpI18n.t("media.readFailed"));
  }
  try {
    const attempts: [number, number][] = [
      [MAX_EDGE, 0.8],
      [MAX_EDGE, 0.65],
      [1280, 0.6],
      [1024, 0.55],
    ];
    for (const [edge, q] of attempts) {
      const scale = Math.min(1, edge / Math.max(src.width, src.height));
      const w = Math.max(1, Math.round(src.width * scale));
      const h = Math.max(1, Math.round(src.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error(gpI18n.t("media.noCanvas"));
      src.draw(ctx, w, h);
      let blob = await canvasToBlob(canvas, "image/webp", q);
      // Safari < 17 silently falls back to PNG for unsupported types — use JPEG there.
      if (!blob || blob.type !== "image/webp") blob = await canvasToBlob(canvas, "image/jpeg", Math.min(0.85, q + 0.02));
      if (blob && blob.size <= MAX_UPLOAD_BYTES) return { blob, width: w, height: h };
    }
    throw new Error(gpI18n.t("media.tooBigAfter"));
  } finally {
    src.close();
  }
}

/** Compress + upload one image. The compressed blob doubles as the instant preview (no refetch). */
export async function uploadPlanImage(file: Blob, context: MediaContext, date: string): Promise<UploadedMedia> {
  const { blob, width, height } = await compressImage(file);
  let out: UploadedMedia;
  try {
    out = await http.post<UploadedMedia>("/api/plan-media", blob, {
      query: { context, date, w: width, h: height },
      headers: { "Content-Type": blob.type || "image/jpeg" },
    });
  } catch (e) {
    // An API build without the media route answers a bare 404.
    if (e instanceof ApiError && e.status === 404 && !e.field("error")) {
      throw new ApiError({ status: 404, message: gpI18n.t("media.uploadsNotDeployed"), body: e.body, method: e.method, url: e.url });
    }
    throw e;
  }
  blobUrls.set(out.id, URL.createObjectURL(blob));
  return out;
}

/** Image files from a paste/drop (ignores text, html, non-image files). */
export function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const files: File[] = [];
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length === 0) for (const f of Array.from(dt.files ?? [])) if (f.type.startsWith("image/")) files.push(f);
  return files;
}

export function loadPlanImage(id: number): Promise<string> {
  const cached = blobUrls.get(id);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(id);
  if (pending) return pending;
  const p = http
    .raw(`/api/plan-media/${id}`)
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
export function useMediaUrl(id: number | null | undefined): string | null | "error" {
  const [state, setState] = useState<string | null | "error">(() => (id ? blobUrls.get(id) ?? null : null));
  useEffect(() => {
    if (!id) {
      setState(null);
      return;
    }
    let alive = true;
    const hit = blobUrls.get(id);
    if (hit) {
      setState(hit);
      return;
    }
    setState(null);
    loadPlanImage(id)
      .then((u) => alive && setState(u))
      .catch(() => alive && setState("error"));
    return () => {
      alive = false;
    };
  }, [id]);
  return state;
}
