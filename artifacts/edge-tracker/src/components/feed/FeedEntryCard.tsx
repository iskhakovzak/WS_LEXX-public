import React, { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { Bookmark, BookmarkCheck, Copy, Pencil, Trash2, TrendingUp, TrendingDown, Circle, CheckCheck, Hash, CheckCircle2, Crosshair, Eye, UserRound } from "lucide-react";
import { AddToPlaybookButton, type PlaybookPayload } from "@/components/add-to-playbook";
import { Pill } from "@/components/ds";
import { cn } from "@/lib/utils";
import { FeedGallery } from "./FeedGallery";
import { hasServerAcks, parseShots, parseTickers, splitList, type AckKind, type FeedEntry } from "./feed-utils";
import { fmtTimeNY } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { feedI18n } from "@/i18n/ns/feed";
import { personName } from "@/i18n";

/** «Принято» / «Торгую это» — per-trader acks from the server; names on hover. */
function AckChip({ kind, icon: Icon, label, acks, me, onAck }: {
  kind: Exclude<AckKind, "read">; icon: React.ElementType; label: string; acks: FeedEntry["acks"]; me: string; onAck?: (kind: Exclude<AckKind, "read">) => void;
}) {
  if (!acks) return null;
  const on = acks.mine.includes(kind);
  const n = acks.counts[kind] ?? 0;
  const users = acks.users[kind] ?? [];
  const others = users.filter((u) => u !== me);
  const title = n === 0 ? label : `${label}: ${[on ? feedI18n.t("card.you") : null, ...others.map(personName)].filter(Boolean).join(", ")}`;
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={!onAck}
      title={title}
      onClick={(e) => { e.stopPropagation(); onAck?.(kind); }}
      className={cn(
        "chip inline-flex min-h-7 items-center gap-1 px-2.5 text-xs disabled:cursor-default disabled:opacity-70",
        on && "border-primary/50 text-primary",
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
      {n > 0 && <span className="tabular-nums text-muted-foreground">{n}</span>}
    </button>
  );
}

/** Highlights case-insensitive matches of `q` inside `text`. */
export function Hl({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const at = lower.indexOf(needle, i);
    if (at === -1) { parts.push(text.slice(i)); break; }
    if (at > i) parts.push(text.slice(i, at));
    parts.push(<mark key={k++} className="rounded-sm bg-primary/25 px-0.5 text-foreground">{text.slice(at, at + needle.length)}</mark>);
    i = at + needle.length;
  }
  return <>{parts}</>;
}

function IconBtn({ label, onClick, children, active, className }: {
  label: string; onClick: () => void; children: React.ReactNode; active?: boolean; className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn(
        "grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "text-primary",
        className,
      )}
    >
      {children}
    </button>
  );
}

function Notes({ text, q }: { text: string; q: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 320 || text.split("\n").length > 5;
  return (
    <div>
      <p className={cn("whitespace-pre-wrap text-sm leading-relaxed text-foreground/90", !open && long && "line-clamp-4")}>
        <Hl text={text} q={q} />
      </p>
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1 text-xs font-medium text-primary hover:underline">
          {open ? commonI18n.t("actions.collapse") : feedI18n.t("card.readMore")}
        </button>
      )}
    </div>
  );
}

export type FeedEntryCardProps = {
  feed: FeedEntry;
  unread: boolean;
  /** Signed-in trader (for «вы» in ack tooltips and the author chip). */
  me?: string;
  /** Toggle «Принято» / «Торгую это»; absent for read-only viewers. */
  onAck?: (kind: Exclude<AckKind, "read">) => void;
  /** Auto-mark as read after the card has been on screen for a moment. */
  autoRead?: boolean;
  bookmarked: boolean;
  query: string;
  activeTickers: string[];
  activeTags: string[];
  tradedTickers?: Map<string, number>;
  canEdit: boolean;
  focused?: boolean;
  playbookPayload: PlaybookPayload;
  onToggleTicker: (t: string) => void;
  onToggleTag: (t: string) => void;
  onBookmark: () => void;
  onMarkRead: () => void;
  onMarkUnread: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onNotesChange: (notes: string[]) => void;
};

export function FeedEntryCard(p: FeedEntryCardProps) {
  const { feed, unread, query: q } = p;
  const { t } = feedI18n.useT();
  const reduce = useReducedMotion();
  const ref = useRef<HTMLElement | null>(null);
  const tickers = parseTickers(feed.bestTickers);
  const tags = splitList(feed.tags);
  const shots = parseShots(feed.screenshotUrl, feed.screenshotNotes);
  const acks = hasServerAcks(feed) ? feed.acks : undefined;
  const me = p.me ?? "";
  const readers = acks ? acks.users.read.filter((u) => u !== me && u !== feed.createdBy) : [];
  // NY time, like every other row of the feed (local time read as «21:44» next to «15:00 ET» items).
  const time = feed.createdAt ? fmtTimeNY(feed.createdAt) : "";

  // Mark as read once the card has been at least half-visible for ~1.5s.
  const onMarkReadRef = useRef(p.onMarkRead);
  onMarkReadRef.current = p.onMarkRead;
  useEffect(() => {
    if (!unread || p.autoRead === false || !ref.current || typeof IntersectionObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) timer = setTimeout(() => onMarkReadRef.current(), 1500);
      else if (timer) { clearTimeout(timer); timer = null; }
    }, { threshold: 0.5 });
    io.observe(ref.current);
    return () => { io.disconnect(); if (timer) clearTimeout(timer); };
  }, [unread, p.autoRead]);

  useEffect(() => {
    if (p.focused && ref.current) ref.current.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  }, [p.focused, reduce]);

  return (
    <article
      ref={ref}
      id={`feed-${feed.id}`}
      aria-label={t("card.entryAria", { theme: feed.marketTheme || t("card.noThemeLower") })}
      className={cn(
        "glass-panel relative overflow-hidden rounded-2xl",
        unread && "ring-1 ring-primary/50",
        p.focused && "ring-2 ring-primary",
      )}
    >
      {unread && <span className="absolute inset-y-0 left-0 w-[3px] bg-primary" aria-hidden="true" />}

      {/* header */}
      <div className="flex items-start gap-3 px-4 pt-4 sm:px-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {unread && <Pill tone="accent" dot>{t("card.newBadge")}</Pill>}
            {p.bookmarked && <Pill tone="warn"><Bookmark className="h-3 w-3" aria-hidden="true" />{t("card.bookmarked")}</Pill>}
            {time && <span className="text-xs tabular-nums text-muted-foreground">{t("card.added", { time })}</span>}
            {feed.createdBy && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={t("card.author")}>
                <UserRound className="h-3 w-3" aria-hidden="true" />{feed.createdBy === me ? t("card.you") : personName(feed.createdBy)}
              </span>
            )}
            {readers.length > 0 && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={t("card.readBy", { names: readers.map(personName).join(", ") })}>
                <Eye className="h-3 w-3" aria-hidden="true" />{t("card.readers", { count: readers.length })}
              </span>
            )}
          </div>
          <h3 className="mt-1.5 text-base font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">
            {feed.marketTheme ? <Hl text={feed.marketTheme} q={q} /> : <span className="text-muted-foreground">{t("card.noTheme")}</span>}
          </h3>
        </div>
        <div className="-mr-1 flex shrink-0 items-center">
          <IconBtn label={p.bookmarked ? t("card.unbookmark") : t("card.bookmark")} active={p.bookmarked} onClick={p.onBookmark}>
            {p.bookmarked ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
          </IconBtn>
          <IconBtn label={unread ? t("card.markRead") : t("card.markUnread")} onClick={unread ? p.onMarkRead : p.onMarkUnread}>
            {unread ? <CheckCheck className="h-4 w-4" /> : <Circle className="h-3.5 w-3.5" />}
          </IconBtn>
          <IconBtn label={t("card.copy")} onClick={p.onCopy}><Copy className="h-4 w-4" /></IconBtn>
        </div>
      </div>

      <div className="space-y-4 px-4 pb-4 pt-3 sm:px-5 [overflow-wrap:anywhere]">
        {/* tickers */}
        {tickers.length > 0 && (
          <div className="flex flex-wrap gap-1.5" aria-label={t("card.tickersAria")}>
            {tickers.map((tk) => {
              const traded = p.tradedTickers?.get(tk);
              const active = p.activeTickers.includes(tk);
              return (
                <button
                  key={tk}
                  type="button"
                  aria-pressed={active}
                  onClick={() => p.onToggleTicker(tk)}
                  title={traded ? t("card.tradedTitle", { ticker: tk, count: traded }) : t("card.filterBy", { ticker: tk })}
                  className="chip inline-flex min-h-8 items-center gap-1.5 px-3 text-sm font-semibold tabular-nums text-foreground"
                >
                  <Hl text={tk} q={q} />
                  {traded ? (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-up/15 px-1.5 text-xs font-semibold text-up">
                      {traded}×
                      <span className="sr-only">{t("card.tradesSr")}</span>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}

        {/* works / doesn't */}
        {(feed.whatWorksNow || feed.whatDoesntWork) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {feed.whatWorksNow && (
              <div className="rounded-xl border border-up/25 bg-up/[0.06] p-3">
                <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-up">
                  <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" /> {t("card.works")}
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground"><Hl text={feed.whatWorksNow} q={q} /></p>
              </div>
            )}
            {feed.whatDoesntWork && (
              <div className="rounded-xl border border-down/25 bg-down/[0.06] p-3">
                <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-down">
                  <TrendingDown className="h-3.5 w-3.5" aria-hidden="true" /> {t("card.doesntWork")}
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground"><Hl text={feed.whatDoesntWork} q={q} /></p>
              </div>
            )}
          </div>
        )}

        {feed.notes && <Notes text={feed.notes} q={q} />}

        {shots.length > 0 && (
          <FeedGallery shots={shots} onNotesChange={p.canEdit ? p.onNotesChange : undefined} />
        )}

        {/* footer: tags + acks + write actions */}
        {(tags.length > 0 || p.canEdit || acks) && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {acks && (
                <span className="mr-1 inline-flex items-center gap-1" role="group" aria-label={t("card.reactionsAria")}>
                  <AckChip kind="ack" icon={CheckCircle2} label={t("card.ack")} acks={acks} me={me} onAck={p.onAck} />
                  <AckChip kind="trading_this" icon={Crosshair} label={t("card.tradingThis")} acks={acks} me={me} onAck={p.onAck} />
                </span>
              )}
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  aria-pressed={p.activeTags.includes(tag)}
                  onClick={() => p.onToggleTag(tag)}
                  aria-label={t("card.filterTag", { tag })}
                  className="chip inline-flex min-h-7 items-center gap-0.5 px-2.5 text-xs"
                >
                  <Hash className="h-3 w-3" aria-hidden="true" />
                  <Hl text={tag} q={q} />
                </button>
              ))}
            </div>
            {p.canEdit && (
              <div className="ml-auto flex items-center gap-0.5">
                <span className="grid h-8 w-8 place-items-center"><AddToPlaybookButton payload={p.playbookPayload} size="icon" /></span>
                <IconBtn label={t("card.edit")} onClick={p.onEdit}><Pencil className="h-4 w-4" /></IconBtn>
                <IconBtn label={t("card.delete")} onClick={p.onDelete} className="hover:text-down"><Trash2 className="h-4 w-4" /></IconBtn>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
