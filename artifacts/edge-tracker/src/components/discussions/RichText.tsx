/**
 * Markdown-lite renderer for discussions. Safe: builds React nodes, never HTML.
 * Supports **bold**, *italic*, `code`, links, > quotes, - lists,
 * $TICKER cashtags (+ known tickers), @mentions and search highlight.
 */
import * as React from "react";
import { TickerLink } from "./TickerContext";
import { mentionedName } from "./lib";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/auth-context";
import { personName } from "@/i18n";

type Ctx = {
  knownTickers: Set<string>;
  /** Stored names of the desk: a mention chip covers the whole name («@Дмитрий К.»), as the server matches it. */
  people: readonly string[];
  me?: string | null;
  highlight?: string;
  onTickerFilter?: (t: string) => void;
};

export function Highlight({ text, q }: { text: string; q?: string }) {
  if (!q || q.length < 2) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const j = lower.indexOf(needle, i);
    if (j === -1) { out.push(text.slice(i)); break; }
    if (j > i) out.push(text.slice(i, j));
    out.push(<mark key={k++} className="rounded-sm bg-primary/25 px-0.5 text-foreground">{text.slice(j, j + needle.length)}</mark>);
    i = j + needle.length;
  }
  return <>{out}</>;
}

function buildInlineRe(known: Set<string>) {
  const tick = known.size ? `|\\b(${Array.from(known).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b` : "";
  // 1 code, 2 bold, 3 italic, 4 url, 5 cashtag, 6 mention, 7 known ticker
  return new RegExp(
    "`([^`\\n]+)`|\\*\\*([^*\\n]+)\\*\\*|(?<![\\p{L}\\d*])\\*([^*\\n]+)\\*(?![\\p{L}\\d])|(https?:\\/\\/[^\\s<>()]+[^\\s<>().,;:!?'\"])|\\$([A-Za-z]{1,6}(?:\\.[A-Za-z])?)(?![\\p{L}\\d])|(?<![\\p{L}\\d])@([\\p{L}\\d_]{2,30})" + tick,
    "gu",
  );
}

function renderInline(text: string, ctx: Ctx, re: RegExp, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let k = 0;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  const plain = (s: string) => <Highlight key={`${keyBase}-t${k++}`} text={s} q={ctx.highlight} />;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(plain(text.slice(last, m.index)));
    const key = `${keyBase}-${k++}`;
    if (m[1] != null) out.push(<code key={key} className="rounded-md bg-[var(--glass-bg)] px-1 py-0.5 font-mono text-[0.85em]">{m[1]}</code>);
    else if (m[2] != null) out.push(<strong key={key} className="font-semibold text-foreground"><Highlight text={m[2]} q={ctx.highlight} /></strong>);
    else if (m[3] != null) out.push(<em key={key}><Highlight text={m[3]} q={ctx.highlight} /></em>);
    else if (m[4] != null) {
      const href = m[4];
      let label = href;
      try { const u = new URL(href); label = u.hostname.replace(/^www\./, "") + (u.pathname.length > 1 ? u.pathname.slice(0, 24) + (u.pathname.length > 24 ? "…" : "") : ""); } catch { /* keep */ }
      out.push(<a key={key} href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary [overflow-wrap:anywhere]">{label}</a>);
    } else if (m[5] != null) out.push(<TickerLink key={key} ticker={m[5].toUpperCase()} onFilter={ctx.onTickerFilter} />);
    else if (m[6] != null) {
      // The text keeps the stored name («@Закир»: the server matches mentions by it); the chip shows the display name.
      const full = mentionedName(text, m.index + 1, ctx.people) ?? m[6];
      const isMe = !!ctx.me && full.toLowerCase() === ctx.me.toLowerCase();
      out.push(
        <span key={key} title={personName(full) !== full ? `@${full}` : undefined} className={cn("rounded-full px-1.5 py-px text-[0.92em] font-medium", isMe ? "bg-primary text-primary-foreground" : "bg-primary/15 text-primary")}>@{personName(full)}</span>,
      );
      if (full.length > m[6].length) re.lastIndex = m.index + 1 + full.length;
    } else if (m[7] != null) out.push(<TickerLink key={key} ticker={m[7]} onFilter={ctx.onTickerFilter} />);
    last = Math.max(m.index + m[0].length, re.lastIndex);
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) out.push(plain(text.slice(last)));
  return out;
}

export function RichText({ text, className, knownTickers, me, highlight, onTickerFilter, clamp }: {
  text: string;
  className?: string;
  knownTickers?: Set<string>;
  me?: string | null;
  highlight?: string;
  onTickerFilter?: (t: string) => void;
  clamp?: boolean;
}) {
  const { dbUsers } = useAuth();
  const people = React.useMemo(() => dbUsers.map((u) => u.name).filter(Boolean), [dbUsers]);
  const ctx: Ctx = { knownTickers: knownTickers ?? new Set(), people, me, highlight, onTickerFilter };
  const re = React.useMemo(() => buildInlineRe(ctx.knownTickers), [ctx.knownTickers]);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let b = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      blocks.push(
        <blockquote key={b++} className="border-l-2 border-primary/40 pl-3 text-muted-foreground">
          {quote.map((q, qi) => <div key={qi}>{renderInline(q, ctx, re, `q${b}-${qi}`)}</div>)}
        </blockquote>,
      );
      continue;
    }
    if (/^\s*[-•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-•]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-•]\s+/, "")); i++; }
      blocks.push(
        <ul key={b++} className="list-disc space-y-0.5 pl-5 marker:text-muted-foreground">
          {items.map((it, ii) => <li key={ii}>{renderInline(it, ctx, re, `l${b}-${ii}`)}</li>)}
        </ul>,
      );
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*>\s?/.test(lines[i]) && !/^\s*[-•]\s+/.test(lines[i])) { para.push(lines[i]); i++; }
    blocks.push(
      <p key={b++}>
        {para.map((p, pi) => (
          <React.Fragment key={pi}>{pi > 0 && <br />}{renderInline(p, ctx, re, `p${b}-${pi}`)}</React.Fragment>
        ))}
      </p>,
    );
  }
  return <div className={cn("space-y-2 text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]", clamp && "line-clamp-3", className)}>{blocks}</div>;
}

/** Plain one-line preview (markup stripped) for list rows. */
export function plainPreview(text: string, max = 140): string {
  const s = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
