import * as React from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { SECTION_GROUPS, SECTIONS, parseNote } from "./author-model";
import { splitTickers } from "./author-plan";
import { notesI18n } from "@/i18n/ns/notes";

/** Wraps case-insensitive matches of `query` in <mark>. */
export function Highlight({ text, query }: { text: string; query?: string }) {
  const q = query?.trim();
  if (!q) return <>{text}</>;
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig");
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-[4px] bg-primary/25 px-0.5 text-foreground">{p}</mark>
        ) : (
          <React.Fragment key={i}>{p}</React.Fragment>
        ),
      )}
    </>
  );
}

/** Text with `$TICKER` mentions rendered as small links to the ticker's research page, the rest highlighted. */
export function RichText({ text, query }: { text: string; query?: string }) {
  const parts = splitTickers(text);
  return (
    <>
      {parts.map((p, i) =>
        p.ticker ? (
          <Link
            key={i}
            href={`/research?ticker=${encodeURIComponent(p.ticker)}`}
            className="mx-px inline-flex items-center rounded-md bg-primary/12 px-1 font-mono text-[0.92em] font-semibold text-accent-soft hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={notesI18n.t("author.openResearch", { ticker: p.ticker })}
          >
            <Highlight text={p.text} query={query} />
          </Link>
        ) : (
          <Highlight key={i} text={p.text} query={query} />
        ),
      )}
    </>
  );
}

/** Minimal markdown for AI output: **bold** lines as headings, inline **bold**, blank-line spacing. */
export function AuthorMarkdown({ text, query, className }: { text: string; query?: string; className?: string }) {
  const lines = text.split("\n");
  return (
    <div className={cn("space-y-1 text-sm leading-relaxed", className)}>
      {lines.map((line, i) => {
        const t = line.trim();
        if (t.startsWith("**") && t.endsWith("**") && t.length > 4 && !t.slice(2, -2).includes("**")) {
          return <p key={i} className="mt-3 font-semibold text-foreground first:mt-0"><Highlight text={t.slice(2, -2)} query={query} /></p>;
        }
        if (t === "---") return <hr key={i} className="my-2 border-border" />;
        if (!t) return <div key={i} className="h-1" aria-hidden="true" />;
        const parts = line.split(/\*\*([^*]+)\*\*/g);
        return (
          <p key={i} className="text-foreground/90">
            {parts.map((p, j) =>
              j % 2 === 1 ? (
                <strong key={j} className="font-semibold text-foreground"><Highlight text={p} query={query} /></strong>
              ) : (
                <RichText key={j} text={p} query={query} />
              ),
            )}
          </p>
        );
      })}
    </div>
  );
}

/** Read-only render of a note: structured sections grouped like the editor, or plain text. */
export function NoteReader({ raw, query, compact }: { raw: string; query?: string; compact?: boolean }) {
  const p = parseNote(raw);
  if (!p.structured) {
    return (
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
        <RichText text={p.free.trim() || "—"} query={query} />
      </p>
    );
  }
  return (
    <div className={cn("flex flex-col", compact ? "gap-3" : "gap-4")}>
      {p.free.trim() && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90"><RichText text={p.free.trim()} query={query} /></p>
      )}
      {SECTION_GROUPS.map((g) => {
        const defs = SECTIONS.filter((s) => s.group === g.id && p.sections[s.key].trim());
        if (!defs.length) return null;
        return (
          <section key={g.id} className="flex flex-col gap-1.5">
            <h4 className="micro-label">{g.title}</h4>
            {defs.map((s) => (
              <div key={s.key} className="flex flex-col gap-0.5">
                {defs.length > 1 || g.id === "trades" || g.id === "plan" ? (
                  <span className="text-xs font-medium text-muted-foreground">{s.label}</span>
                ) : null}
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                  <RichText text={p.sections[s.key].trim()} query={query} />
                </p>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
