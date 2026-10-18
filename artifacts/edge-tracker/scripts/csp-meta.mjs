// @ts-check
/**
 * Vite plugin (build only): writes an ENFORCED Content-Security-Policy <meta> into the built index.html.
 *
 * A <meta> CSP can't be report-only and can't carry frame-ancestors / report-uri, so it holds only the XSS-critical
 * directives: scripts from our origin plus the sha256 of each inline <script> (the theme bootstrap), no plugins,
 * no <base> hijack. The full policy (styles, images, frames, connect…) is sent as a REPORT-ONLY header by Express
 * (api-server lib/security/http.ts) — enforce it there after a clean week of reports in Пульт → Ошибки.
 * Dev builds are untouched (Vite's dev server injects inline scripts for HMR / React refresh).
 */
import { createHash } from "node:crypto";

/** sha256 hashes of inline <script> bodies (scripts with src= are covered by 'self'). */
export function inlineScriptHashes(html) {
  const out = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1];
    if (body.trim()) out.push(`sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`);
  }
  return out;
}

/** The enforced meta policy for a document with these inline-script hashes. */
export function metaCsp(hashes) {
  return [
    `script-src 'self'${hashes.map((h) => ` '${h}'`).join("")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

/** Insert the meta right after <meta charset> (it must precede every script it governs). */
export function injectMetaCsp(html) {
  if (/http-equiv=["']Content-Security-Policy["']/i.test(html)) return html;
  const tag = `<meta http-equiv="Content-Security-Policy" content="${metaCsp(inlineScriptHashes(html))}" />`;
  return /<meta charset[^>]*>/i.test(html) ? html.replace(/(<meta charset[^>]*>)/i, `$1\n    ${tag}`) : html.replace(/<head>/i, `<head>\n    ${tag}`);
}

/** @returns {import("vite").Plugin} */
export function cspMeta() {
  return {
    name: "ws-csp-meta",
    apply: "build",
    transformIndexHtml: { order: "post", handler: (html) => injectMetaCsp(html) },
  };
}
