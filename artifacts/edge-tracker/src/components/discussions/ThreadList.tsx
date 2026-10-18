
import { ArrowBigUp, CheckCircle2, MessageSquare, Pin, AtSign, Lock, Flame } from "lucide-react";
import { Pill, toneOf, toneText } from "@/components/ds";
import { cn } from "@/lib/utils";
import { Highlight, plainPreview } from "./RichText";
import {
  type Thread, type VoteMap, TYPE_LABELS, TYPE_TONE, lastActivity, lastActivityBy, participants,
  isPinned, isResolved, relTime, absTime, initials, avatarTone, parseComment, splitNotes, isLiveNow,
} from "./lib";
import { discussionsI18n } from "@/i18n/ns/discussions";
import { personName } from "@/i18n";

export function Avatar({ name, size = "sm", className }: { name?: string | null; size?: "xs" | "sm" | "md"; className?: string }) {
  const dim = size === "xs" ? "h-6 w-6 text-2xs" : size === "sm" ? "h-7 w-7 text-2xs" : "h-8 w-8 text-xs";
  return (
    <span title={personName(name) || undefined} aria-hidden="true" className={cn("inline-grid shrink-0 place-items-center rounded-full font-semibold ring-2 ring-background", dim, avatarTone(name), className)}>
      {initials(name)}
    </span>
  );
}

function previewOf(t: Thread): { who: string | null; text: string } {
  const cs = t.comments ?? [];
  if (cs.length) {
    const c = cs[cs.length - 1];
    return { who: c.trader ?? null, text: plainPreview(parseComment(c.text).body, 120) };
  }
  return { who: null, text: plainPreview(splitNotes(t.notes).text, 120) };
}

export function ThreadListItem({ t, selected, unread, mentionsMe, fresh = false, audienceLabel, votes, q, onSelect, index }: {
  t: Thread;
  selected: boolean;
  unread: boolean;
  mentionsMe: boolean;
  /** New topic the viewer has not opened yet («Новая»). */
  fresh?: boolean;
  /** Restricted thread: who can read it («Джунам, Кураторам»); omitted for public threads. */
  audienceLabel?: string | null;
  votes: VoteMap;
  q: string;
  onSelect: (id: number) => void;
  index: number;
}) {
  const { t: tr } = discussionsI18n.useT();
  const score = votes[t.id]?.score ?? 0;
  const replies = t.comments?.length ?? 0;
  const people = participants(t);
  const pv = previewOf(t);
  const resolved = isResolved(t);
  const live = isLiveNow(t);
  return (
    <li>
      <button
        type="button"
        data-thread-id={t.id}
        onClick={() => onSelect(t.id)}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "group relative w-full rounded-xl px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected ? "bg-primary/12 ring-1 ring-primary/40" : "hover:bg-[var(--glass-hover-bg)]",
          resolved && !selected && "opacity-80",
        )}
      >
        {unread && <span className="absolute left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-primary" aria-label={tr("list.unreadAria")} />}
        <div className="flex min-w-0 items-center gap-1.5 pl-2">
          {isPinned(t) && <Pin className="h-3.5 w-3.5 shrink-0 text-primary" aria-label={tr("list.pinnedAria")} />}
          {fresh && <Pill tone="accent" className="py-0 text-2xs font-semibold">{tr("list.fresh")}</Pill>}
          {t.type && <Pill tone={TYPE_TONE[t.type] ?? "neutral"} className="py-0 text-2xs">{TYPE_LABELS[t.type] ?? t.type}</Pill>}
          {t.ticker && <span className="rounded-full bg-primary/15 px-1.5 text-2xs font-semibold tabular-nums leading-5 text-primary">${t.ticker}</span>}
          {resolved && <span className="inline-flex items-center gap-0.5 text-2xs text-up"><CheckCircle2 className="h-3 w-3" aria-hidden="true" />{tr("list.resolved")}</span>}
          {mentionsMe && <AtSign className="h-3.5 w-3.5 shrink-0 text-primary" aria-label={tr("list.mentionedAria")} />}
          {live && <Flame className="h-3.5 w-3.5 shrink-0 text-warn" aria-label={tr("list.liveAria")} />}
          {audienceLabel && (
            <span className="inline-flex min-w-0 items-center gap-0.5 text-2xs text-muted-foreground" title={tr("list.visibleOnly", { who: audienceLabel })}>
              <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="sr-only">{tr("list.visibleOnly", { who: "" })}</span>
              <span className="truncate">{audienceLabel}</span>
            </span>
          )}
          <span className="ml-auto shrink-0 text-2xs text-muted-foreground tabular-nums" title={absTime(lastActivity(t))}>{relTime(lastActivity(t))}</span>
        </div>
        <div className={cn("mt-1 line-clamp-2 pl-2 text-sm", unread ? "font-semibold text-foreground" : "font-medium text-foreground")}>
          <Highlight text={t.topic} q={q} />
        </div>
        {pv.text && (
          <div className="mt-0.5 truncate pl-2 text-xs text-muted-foreground">
            {pv.who && <span className="text-foreground/80">{personName(pv.who)}: </span>}
            <Highlight text={pv.text} q={q} />
          </div>
        )}
        <div className="mt-1.5 flex items-center gap-3 pl-2 text-xs text-muted-foreground">
          <span className="flex -space-x-1.5" aria-label={tr("list.participantsAria", { names: people.map(personName).join(", ") })}>
            {people.slice(0, 4).map((p) => <Avatar key={p} name={p} size="xs" />)}
            {people.length > 4 && <span className="grid h-6 w-6 place-items-center rounded-full bg-[var(--glass-bg)] text-2xs">+{people.length - 4}</span>}
          </span>
          <span className={cn("inline-flex items-center gap-0.5 tabular-nums", score !== 0 && toneText(toneOf(score)))} aria-label={tr("list.scoreAria", { score })}>
            <ArrowBigUp className="h-3.5 w-3.5" aria-hidden="true" />{score > 0 ? `+${score}` : score < 0 ? `−${Math.abs(score)}` : 0}
          </span>
          <span className="inline-flex items-center gap-1 tabular-nums" aria-label={tr("list.repliesAria", { count: replies })}>
            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />{replies}
          </span>
          {lastActivityBy(t) && <span className="ml-auto truncate">{personName(lastActivityBy(t))}</span>}
        </div>
      </button>
    </li>
  );
}
