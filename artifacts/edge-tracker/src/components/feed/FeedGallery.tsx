import { useState } from "react";
import { ExternalLink, ImageOff, Pencil, Check, X, Maximize2 } from "lucide-react";
import { Lightbox } from "@/components/screenshot-fields";
import { cn } from "@/lib/utils";
import type { Shot } from "./feed-utils";
import { commonI18n } from "@/i18n/ns/common";
import { feedI18n } from "@/i18n/ns/feed";

function Thumb({ shot, index, onOpen }: { shot: Shot; index: number; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <a
        href={shot.href}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border text-xs text-muted-foreground hover:text-foreground",
        )}
      >
        <ImageOff className="h-4 w-4" aria-hidden="true" />
        {feedI18n.t("gallery.openLink", { n: index + 1 })}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={shot.note ? feedI18n.t("gallery.openShotNote", { n: index + 1, note: shot.note }) : feedI18n.t("gallery.openShot", { n: index + 1 })}
      className={cn(
        "group relative block w-full overflow-hidden rounded-xl border border-border bg-[var(--glass-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aspect-[4/3]",
      )}
    >
      <img
        src={shot.img}
        alt=""
        loading="lazy"
        decoding="async"
        width={240}
        height={180}
        className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
        onError={() => setFailed(true)}
      />
      <span className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-background/70 text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <span className="absolute bottom-1.5 left-1.5 rounded-full bg-background/75 px-1.5 text-xs font-medium tabular-nums text-foreground">
        {index + 1}
      </span>
    </button>
  );
}

function Caption({ note, onSave }: { note: string; onSave?: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note);
  if (editing && onSave) {
    return (
      <div className="mt-1.5 flex items-center gap-1">
        <input
          autoFocus
          aria-label={feedI18n.t("gallery.caption")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { onSave(draft.trim()); setEditing(false); }
            if (e.key === "Escape") { e.stopPropagation(); setEditing(false); }
          }}
          className="glass-field h-8 min-w-0 flex-1 px-3 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button type="button" aria-label={feedI18n.t("gallery.saveCaption")} onClick={() => { onSave(draft.trim()); setEditing(false); }} className="grid h-8 w-8 place-items-center rounded-full text-up hover:bg-[var(--glass-hover-bg)]">
          <Check className="h-4 w-4" />
        </button>
        <button type="button" aria-label={commonI18n.t("actions.cancel")} onClick={() => setEditing(false)} className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)]">
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }
  return (
    <div className="group/cap mt-1.5 flex items-start gap-1">
      <p className={cn("min-w-0 flex-1 text-xs leading-snug", note ? "text-foreground/90" : "text-muted-foreground")}>
        {note || (onSave ? feedI18n.t("gallery.noCaption") : "")}
      </p>
      {onSave && (
        <button
          type="button"
          aria-label={feedI18n.t("gallery.editCaption")}
          onClick={() => { setDraft(note); setEditing(true); }}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted-foreground opacity-70 hover:bg-[var(--glass-hover-bg)] hover:text-foreground group-hover/cap:opacity-100"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/** Screenshot gallery: uniform 4:3 tiles (max 240px); click opens the zoomable lightbox. */
export function FeedGallery({ shots, onNotesChange, max = 4 }: {
  shots: Shot[];
  onNotesChange?: (notes: string[]) => void;
  max?: number;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  if (!shots.length) return null;
  const visible = expanded ? shots : shots.slice(0, max);
  const hidden = shots.length - visible.length;
  const saveAt = onNotesChange
    ? (i: number) => (v: string) => onNotesChange(shots.map((s, j) => (j === i ? v : s.note)))
    : undefined;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="micro-label">{feedI18n.t("gallery.shots", { count: shots.length })}</span>
        <a href={shots[0].href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary">
          <ExternalLink className="h-3 w-3" aria-hidden="true" /> {feedI18n.t("gallery.original")}
        </a>
      </div>
      {/* Uniform 4:3 tiles, capped width: the box size is known before images load (no CLS, no 700px blank). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {visible.map((s, i) => (
          <figure key={s.href + i} className="min-w-0 max-w-[240px]">
            <Thumb shot={s} index={i} onOpen={() => setOpen(i)} />
            <figcaption>
              <Caption note={s.note} onSave={saveAt?.(i)} />
            </figcaption>
          </figure>
        ))}
      </div>
      {hidden > 0 && (
        <button type="button" onClick={() => setExpanded(true)} className="chip mt-3 inline-flex min-h-8 items-center px-3 text-xs font-medium">
          {feedI18n.t("gallery.more", { count: hidden })}
        </button>
      )}
      {open !== null && (
        <Lightbox urls={shots.map((s) => s.img)} notes={shots.map((s) => s.note)} initialIndex={open} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}
