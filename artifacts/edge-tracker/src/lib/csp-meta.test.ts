import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { injectMetaCsp, inlineScriptHashes, metaCsp } from "../../scripts/csp-meta.mjs";

const theme = `\n      try { var t = localStorage.getItem("ws_lexx_theme"); } catch (e) {}\n    `;
const html = `<!DOCTYPE html><html><head>\n    <meta charset="UTF-8" />\n    <script>${theme}</script>\n    <script type="module" crossorigin src="/assets/index-abc.js"></script>\n  </head><body></body></html>`;

describe("csp meta (build)", () => {
  it("hashes inline scripts only", () => {
    const expected = `sha256-${createHash("sha256").update(theme, "utf8").digest("base64")}`;
    expect(inlineScriptHashes(html)).toEqual([expected]);
  });

  it("locks scripts to self + the inline hash, no plugins, no base hijack", () => {
    const p = metaCsp(["sha256-x"]);
    expect(p).toContain("script-src 'self' 'sha256-x'");
    expect(p).toContain("object-src 'none'");
    expect(p).toContain("base-uri 'self'");
    expect(p).not.toContain("unsafe-inline");
    expect(p).not.toContain("unsafe-eval");
  });

  it("injects the meta right after <meta charset>, once", () => {
    const out = injectMetaCsp(html);
    expect(out.indexOf('http-equiv="Content-Security-Policy"')).toBeGreaterThan(out.indexOf("<meta charset"));
    expect(out.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(out.indexOf("<script"));
    expect(injectMetaCsp(out)).toBe(out);
  });
});
