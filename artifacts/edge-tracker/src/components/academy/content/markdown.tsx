/**
 * Safe markdown renderer for lessons: builds React elements from the AST in markdown-parse.ts
 * (no dangerouslySetInnerHTML, no raw HTML). External links open in a new tab with rel=noopener.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { academyI18n } from "@/i18n/ns/academy";
import { parseMarkdown, type Align, type Block, type Inline } from "./markdown-parse";

function InlineView({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text": return <React.Fragment key={i}>{n.v}</React.Fragment>;
          case "br": return <br key={i} />;
          case "code": return <code key={i} className="rounded bg-[var(--glass-bg)] px-1 py-0.5 font-mono text-[0.85em] text-foreground">{n.v}</code>;
          case "strong": return <strong key={i} className="font-semibold text-foreground"><InlineView nodes={n.c} /></strong>;
          case "em": return <em key={i}><InlineView nodes={n.c} /></em>;
          case "link": {
            const external = /^(https?:|mailto:)/.test(n.href);
            return (
              <a key={i} href={n.href} className="text-primary underline-offset-4 hover:underline" {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}>
                <InlineView nodes={n.c} />
              </a>
            );
          }
        }
      })}
    </>
  );
}

const alignCls = (a: Align) => (a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left");

function BlockView({ b }: { b: Block }) {
  switch (b.t) {
    case "h": {
      const cls = {
        1: "mt-6 text-xl font-semibold",
        2: "mt-6 text-lg font-semibold",
        3: "mt-5 text-base font-semibold",
        4: "mt-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground",
      }[b.level];
      const Tag = (`h${Math.min(6, b.level + 1)}`) as "h2" | "h3" | "h4" | "h5";
      return <Tag id={b.id} className={cn("scroll-mt-24 text-foreground first:mt-0", cls)}><InlineView nodes={b.c} /></Tag>;
    }
    case "p": return <p className="mt-3 leading-relaxed first:mt-0"><InlineView nodes={b.c} /></p>;
    case "hr": return <hr className="my-5 border-[var(--glass-border)]" />;
    case "code":
      return (
        <pre className="mt-3 overflow-x-auto rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] p-3 font-mono text-xs leading-relaxed text-foreground" aria-label={b.lang ? academyI18n.t("markdown.codeLang", { lang: b.lang }) : academyI18n.t("markdown.code")}>
          <code>{b.v}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote className="mt-4 rounded-r-xl border-l-2 border-primary/70 bg-primary/5 py-2 pl-4 pr-3 text-foreground/90">
          {b.c.map((x, i) => <BlockView key={i} b={x} />)}
        </blockquote>
      );
    case "list": {
      const items = b.items.map((it, i) => <li key={i} className="pl-1 leading-relaxed"><InlineView nodes={it} /></li>);
      return b.ordered
        ? <ol start={b.start} className="mt-3 list-decimal space-y-1.5 pl-6 marker:text-muted-foreground marker:tabular-nums">{items}</ol>
        : <ul className="mt-3 list-disc space-y-1.5 pl-6 marker:text-muted-foreground">{items}</ul>;
    }
    case "table":
      return (
        <div className="mt-4 overflow-x-auto rounded-xl border border-[var(--glass-border)]">
          <table className="w-full border-collapse text-sm tabular-nums">
            <thead>
              <tr>
                {b.head.map((h, i) => (
                  <th key={i} scope="col" className={cn("border-b border-[var(--glass-border)] bg-[var(--glass-bg)] px-3 py-2 text-xs font-medium text-muted-foreground", alignCls(b.align[i]))}>
                    <InlineView nodes={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri} className="border-b border-border/50 last:border-0">
                  {r.map((c, ci) => <td key={ci} className={cn("px-3 py-2", alignCls(b.align[ci]))}><InlineView nodes={c} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function Markdown({ source, blocks, className }: { source?: string; blocks?: Block[]; className?: string }) {
  const { t } = academyI18n.useT();
  const parsed = React.useMemo(() => blocks ?? parseMarkdown(source ?? ""), [source, blocks]);
  if (!parsed.length) return <p className={cn("text-sm text-muted-foreground", className)}>{t("markdown.empty")}</p>;
  return (
    <div className={cn("max-w-[72ch] text-sm text-foreground/90", className)}>
      {parsed.map((b, i) => <BlockView key={i} b={b} />)}
    </div>
  );
}
