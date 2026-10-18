/**
 * Minimal safe markdown → AST (no raw HTML, ever). The project has no markdown library, so lessons use this:
 * headings (#–####), paragraphs, **bold**, *italic* / _italic_, `code`, fenced ``` code blocks, bullet and
 * numbered lists, > quotes, --- rules, pipe tables, [links](url) and bare http(s) links.
 * HTML tags in the source stay plain text (React escapes them); link targets are limited to http(s), mailto,
 * same-origin paths ("/…", not "//…") and "#anchors" — anything else is rendered as text.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { t: "h"; level: 1 | 2 | 3 | 4; c: Inline[]; id: string }
  | { t: "p"; c: Inline[] }
  | { t: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "hr" }
  | { t: "table"; head: Inline[][]; align: Align[]; rows: Inline[][][] };

export function safeHref(raw: string): string | null {
  const h = raw.trim();
  if (!h || h.length > 2000 || /[\s<>"]/.test(h)) return null;
  if (h.startsWith("#")) return h;
  if (h.startsWith("/") && !h.startsWith("//") && !h.startsWith("/\\")) return h;
  try {
    const u = new URL(h);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:") return u.toString();
  } catch {
    /* not absolute */
  }
  return null;
}

/* ─── inline ─────────────────────────────────────────────────────────────── */

function pushText(out: Inline[], v: string) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === "text") last.v += v;
  else out.push({ t: "text", v });
}

const AUTOLINK = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?»"')]/;

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);
    // escape
    if (ch === "\\" && i + 1 < src.length && /[\\`*_[\]()#>|~-]/.test(src[i + 1])) { pushText(out, src[i + 1]); i += 2; continue; }
    // hard line break (two trailing spaces or backslash before newline handled by caller joining with "\n")
    if (ch === "\n") { out.push({ t: "br" }); i++; continue; }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) { out.push({ t: "code", v: src.slice(i + 1, end) }); i = end + 1; continue; }
    }
    if (depth < 6 && (rest.startsWith("**") || rest.startsWith("__"))) {
      const mark = rest.slice(0, 2);
      const end = src.indexOf(mark, i + 2);
      if (end > i + 2) { out.push({ t: "strong", c: parseInline(src.slice(i + 2, end), depth + 1) }); i = end + 2; continue; }
    }
    if (depth < 6 && (ch === "*" || ch === "_") && src[i + 1] && src[i + 1] !== " " && src[i + 1] !== ch) {
      // `_` only at word boundaries so snake_case stays intact
      const okStart = ch === "*" || i === 0 || /[\s([{"«]/.test(src[i - 1]);
      if (okStart) {
        let end = i + 1;
        while (true) {
          end = src.indexOf(ch, end);
          if (end < 0) break;
          if (src[end - 1] !== " " && src[end + 1] !== ch && (ch === "*" || end + 1 >= src.length || /[\s.,;:!?)\]}"»]/.test(src[end + 1]))) break;
          end++;
        }
        if (end > i + 1) { out.push({ t: "em", c: parseInline(src.slice(i + 1, end), depth + 1) }); i = end + 1; continue; }
      }
    }
    if (ch === "[") {
      const close = findClosing(src, i);
      if (close > i && src[close + 1] === "(") {
        const pe = src.indexOf(")", close + 2);
        if (pe > close) {
          const label = src.slice(i + 1, close);
          const href = safeHref(src.slice(close + 2, pe));
          if (href) out.push({ t: "link", href, c: parseInline(label, depth + 1) });
          else pushText(out, label);
          i = pe + 1;
          continue;
        }
      }
    }
    if (ch === "h" && (rest.startsWith("http://") || rest.startsWith("https://")) && (i === 0 || /[\s(«"]/.test(src[i - 1]))) {
      const m = AUTOLINK.exec(rest);
      const href = m ? safeHref(m[0]) : null;
      if (m && href) { out.push({ t: "link", href, c: [{ t: "text", v: m[0] }] }); i += m[0].length; continue; }
    }
    pushText(out, ch);
    i++;
  }
  return out;
}

function findClosing(src: string, open: number): number {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === "\\") { k++; continue; }
    if (src[k] === "[") depth++;
    else if (src[k] === "]") { depth--; if (depth === 0) return k; }
  }
  return -1;
}

/* ─── blocks ─────────────────────────────────────────────────────────────── */

const HEADING = /^(#{1,4})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const UL = /^\s{0,6}[-*+]\s+(.*)$/;
const OL = /^\s{0,6}(\d{1,6})[.)]\s+(.*)$/;
const FENCE = /^\s{0,3}(```|~~~)\s*([\w+-]*)\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "\\" && s[k + 1] === "|") { cur += "|"; k++; continue; }
    if (s[k] === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += s[k];
  }
  cells.push(cur.trim());
  return cells;
}

export function slugId(text: string, used: Map<string, number>): string {
  const base = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "section";
  const n = used.get(base) ?? 0;
  used.set(base, n + 1);
  return n ? `${base}-${n + 1}` : base;
}

const inlineText = (c: Inline[]): string =>
  c.map((x) => (x.t === "text" || x.t === "code" ? x.v : x.t === "br" ? " " : inlineText(x.c))).join("");

export function parseMarkdown(src: string, depth = 0, used: Map<string, number> = new Map()): Block[] {
  const lines = (src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const isBlockStart = (l: string) => HEADING.test(l) || HR.test(l) || FENCE.test(l) || UL.test(l) || OL.test(l) || /^\s{0,3}>/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${fence[1]}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or EOF)
      blocks.push({ t: "code", lang: fence[2] ?? "", v: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const c = parseInline(h[2]);
      blocks.push({ t: "h", level: h[1].length as 1 | 2 | 3 | 4, c, id: slugId(inlineText(c), used) });
      i++;
      continue;
    }
    if (HR.test(line)) { blocks.push({ t: "hr" }); i++; continue; }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      blocks.push({ t: "quote", c: depth < 4 ? parseMarkdown(body.join("\n"), depth + 1, used) : [{ t: "p", c: parseInline(body.join(" ")) }] });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const align: Align[] = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        const cells = splitRow(lines[i++]);
        rows.push(head.map((_, k) => parseInline(cells[k] ?? "")));
      }
      blocks.push({ t: "table", head: head.map((c) => parseInline(c)), align: head.map((_, k) => align[k] ?? null), rows });
      continue;
    }
    const ul = UL.exec(line);
    const ol = OL.exec(line);
    if (ul || ol) {
      const ordered = !!ol;
      const items: string[] = [];
      const start = ol ? Number(ol[1]) : 1;
      while (i < lines.length) {
        const l = lines[i];
        const m = ordered ? OL.exec(l) : UL.exec(l);
        if (m) { items.push(ordered ? m[2] : m[1]); i++; continue; }
        // continuation line of the previous item (indented, not a new block)
        if (l.trim() && /^\s{2,}/.test(l) && !isBlockStart(l) && items.length) { items[items.length - 1] += `\n${l.trim()}`; i++; continue; }
        break;
      }
      blocks.push({ t: "list", ordered, start, items: items.map((s) => parseInline(s)) });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))) {
      para.push(lines[i++]);
    }
    // soft wraps join with a space; "two trailing spaces" make a hard break
    const text = para.map((l, k) => (k < para.length - 1 && / {2,}$/.test(l) ? `${l.trimEnd()}\n` : k < para.length - 1 ? `${l.trim()} ` : l.trim())).join("");
    blocks.push({ t: "p", c: parseInline(text) });
  }
  return blocks;
}

/** Headings for a table of contents (h2/h3). */
export function outlineOf(blocks: Block[]): { id: string; level: number; text: string }[] {
  return blocks.flatMap((b) => (b.t === "h" && (b.level === 2 || b.level === 3) ? [{ id: b.id, level: b.level, text: inlineText(b.c) }] : []));
}

/** Rough reading time in minutes (≈180 words/min for technical Russian text). */
export function readingMinutes(src: string): number {
  const words = (src ?? "").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 180));
}
