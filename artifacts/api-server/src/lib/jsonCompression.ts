/**
 * gzip for large JSON answers (res.json only).
 *
 * The API sent every JSON body uncompressed: /whatif/base for staff is ~19 MB, /reconcile ~1 MB, /playbook ~0.3 MB.
 * JSON compresses 8–15×, so this middleware wraps `res.json`: when the client accepts gzip and the serialized body is
 * at least `minBytes`, it is gzipped off the event loop (zlib thread pool) and sent with `Content-Encoding: gzip`.
 *
 * Deliberately narrow: streams / SSE (`res.write`), files (`res.sendFile`, `res.download`) and handlers that already
 * set `Content-Encoding` (ask/book) go through untouched. Small bodies are sent as before.
 */
import type { Request, Response, NextFunction } from "express";
import { gzip, constants } from "node:zlib";

const DEFAULT_MIN_BYTES = 16 * 1024;
/** Above this, favour speed over ratio (level 1 still gives ~6–8× on JSON at a fraction of the CPU). */
const FAST_ABOVE_BYTES = 2 * 1024 * 1024;

function appendVary(res: Response, field: string): void {
  const cur = res.getHeader("Vary");
  const list = (Array.isArray(cur) ? cur.join(",") : String(cur ?? "")).split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.some((v) => v === "*" || v.toLowerCase() === field.toLowerCase())) list.push(field);
  res.setHeader("Vary", list.join(", "));
}

export function acceptsGzip(req: Request): boolean {
  return /\bgzip\b/i.test(String(req.headers["accept-encoding"] ?? ""));
}

export function jsonCompression(minBytes = DEFAULT_MIN_BYTES) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === "HEAD") { next(); return; }
    const gz = acceptsGzip(req);
    const send = res.send.bind(res);
    res.json = function json(body?: unknown): Response {
      appendVary(res, "Accept-Encoding");
      if (!res.get("Content-Type")) res.type("application/json");
      // JSON.stringify(undefined) is undefined — express sends an empty body then; keep that.
      const text = body === undefined ? "" : JSON.stringify(body);
      const raw = Buffer.byteLength(text);
      if (!gz || raw < minBytes || res.headersSent || res.getHeader("Content-Encoding")) return send(text);
      const level = raw > FAST_ABOVE_BYTES ? constants.Z_BEST_SPEED : 6;
      gzip(text, { level }, (err, zipped) => {
        if (res.headersSent || res.writableEnded) return;
        if (err) { send(text); return; }
        res.setHeader("Content-Encoding", "gzip");
        res.setHeader("X-Raw-Length", String(raw));
        send(zipped);
      });
      return res;
    };
    next();
  };
}
