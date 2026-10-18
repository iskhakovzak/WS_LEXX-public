import { describe, expect, it } from "vitest";
import { outlineOf, parseInline, parseMarkdown, readingMinutes, safeHref, type Block, type Inline } from "./markdown-parse";
import { parseStartSeconds, videoEmbed } from "./video";

const text = (nodes: Inline[]): string =>
  nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "br" ? "\n" : text(n.c))).join("");

const links = (nodes: Inline[]): string[] =>
  nodes.flatMap((n) => (n.t === "link" ? [n.href, ...links(n.c)] : n.t === "strong" || n.t === "em" ? links(n.c) : []));

describe("safeHref", () => {
  it("allows http(s), mailto, same-origin paths and anchors", () => {
    expect(safeHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeHref("http://x.io")).toBe("http://x.io/");
    expect(safeHref("mailto:desk@ws.io")).toBe("mailto:desk@ws.io");
    expect(safeHref("/playbook?id=3")).toBe("/playbook?id=3");
    expect(safeHref("#risk")).toBe("#risk");
  });
  it("rejects script-ish and protocol-relative targets", () => {
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "//evil.com", "/\\evil.com", "file:///etc/passwd", "", "  ", "https://a.com/\"onmouseover=x"]) {
      expect(safeHref(bad), bad).toBeNull();
    }
  });
});

describe("parseInline", () => {
  it("parses bold, italic, code and links", () => {
    const n = parseInline("**риск** и *R* — `1R = $50`, [плейбук](/playbook)");
    expect(n.some((x) => x.t === "strong")).toBe(true);
    expect(n.some((x) => x.t === "em")).toBe(true);
    expect(n.some((x) => x.t === "code" && x.v === "1R = $50")).toBe(true);
    expect(links(n)).toEqual(["/playbook"]);
  });
  it("keeps unsafe links as plain text", () => {
    const n = parseInline("[клик](javascript:alert(1))");
    expect(links(n)).toEqual([]);
    expect(text(n)).toContain("клик");
  });
  it("autolinks bare https URLs without trailing punctuation", () => {
    const n = parseInline("См. https://ws.example/lesson.");
    expect(links(n)).toEqual(["https://ws.example/lesson"]);
    expect(text(n).endsWith(".")).toBe(true);
  });
  it("leaves HTML as text (React escapes it on render)", () => {
    const n = parseInline('<img src=x onerror="alert(1)"><script>alert(1)</script>');
    expect(n.every((x) => x.t === "text")).toBe(true);
    expect(text(n)).toContain("<script>");
  });
});

describe("parseMarkdown", () => {
  const src = [
    "# Урок",
    "",
    "## Риск и R",
    "Абзац **текста**.",
    "",
    "- раз",
    "- два",
    "",
    "1. первый",
    "2. второй",
    "",
    "> цитата",
    "",
    "---",
    "",
    "| Метрика | Значение |",
    "|:--|--:|",
    "| Gross | $932.68 |",
    "| Fees | $867.94 |",
    "",
    "```",
    "<b>не HTML</b>",
    "```",
    "",
    "## Риск и R",
  ].join("\n");
  const blocks = parseMarkdown(src);
  const kinds = blocks.map((b) => b.t);

  it("produces the expected block kinds", () => {
    expect(kinds).toEqual(["h", "h", "p", "list", "list", "quote", "hr", "table", "code", "h"]);
  });
  it("parses lists (ordered/unordered)", () => {
    const lists = blocks.filter((b): b is Extract<Block, { t: "list" }> => b.t === "list");
    expect(lists[0].ordered).toBe(false);
    expect(lists[0].items.map(text)).toEqual(["раз", "два"]);
    expect(lists[1].ordered).toBe(true);
    expect(lists[1].start).toBe(1);
  });
  it("parses tables with alignment", () => {
    const t = blocks.find((b): b is Extract<Block, { t: "table" }> => b.t === "table")!;
    expect(t.head.map(text)).toEqual(["Метрика", "Значение"]);
    expect(t.align).toEqual(["left", "right"]);
    expect(t.rows.map((r) => r.map(text))).toEqual([["Gross", "$932.68"], ["Fees", "$867.94"]]);
  });
  it("keeps fenced code verbatim", () => {
    const c = blocks.find((b): b is Extract<Block, { t: "code" }> => b.t === "code")!;
    expect(c.v).toBe("<b>не HTML</b>");
  });
  it("gives headings unique ids and builds an h2/h3 outline", () => {
    const toc = outlineOf(blocks);
    expect(toc.map((h) => h.text)).toEqual(["Риск и R", "Риск и R"]);
    expect(new Set(toc.map((h) => h.id)).size).toBe(2);
    expect(toc[0].id).toBe("риск-и-r");
  });
  it("handles empty / CRLF input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("a\r\nb").map((b) => b.t)).toEqual(["p"]);
  });
  it("estimates reading time", () => {
    expect(readingMinutes("")).toBe(1);
    expect(readingMinutes("слово ".repeat(900))).toBe(5);
  });
});

describe("video allow-list (mirror of server)", () => {
  it("embeds YouTube via nocookie with start time", () => {
    const v = videoEmbed("https://youtu.be/dQw4w9WgXcQ?t=1m30s")!;
    expect(v.provider).toBe("youtube");
    expect(v.embedUrl).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90");
    expect(videoEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ")?.id).toBe("dQw4w9WgXcQ");
    expect(videoEmbed("https://youtube.com/shorts/dQw4w9WgXcQ")?.id).toBe("dQw4w9WgXcQ");
  });
  it("embeds Vimeo and Loom", () => {
    expect(videoEmbed("https://vimeo.com/123456789")?.embedUrl).toBe("https://player.vimeo.com/video/123456789");
    expect(videoEmbed("https://www.loom.com/share/0123456789abcdef0123")?.embedUrl).toBe("https://www.loom.com/embed/0123456789abcdef0123");
  });
  it("rejects anything else", () => {
    for (const bad of ["https://evil.com/watch?v=dQw4w9WgXcQ", "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ", "javascript:alert(1)", "https://rutube.ru/video/abc", "https://youtu.be/<script>", "not a url", ""]) {
      expect(videoEmbed(bad), bad).toBeNull();
    }
  });
  it("parses start seconds", () => {
    expect(parseStartSeconds("90")).toBe(90);
    expect(parseStartSeconds("1h2m3s")).toBe(3723);
    expect(parseStartSeconds("abc")).toBeNull();
  });
});
