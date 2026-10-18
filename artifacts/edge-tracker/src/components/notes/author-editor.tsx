import * as React from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  SECTION_GROUPS, SECTIONS, parseNote, serializeNote,
  type Horizon, type SectionKey,
} from "./author-model";
import { commonI18n } from "@/i18n/ns/common";
import { notesI18n } from "@/i18n/ns/notes";

export type EditorTarget = SectionKey | "free";
export type EditorMode = "sections" | "free";

const FIELD =
  "w-full resize-none rounded-xl border border-transparent bg-transparent px-3 py-2.5 text-[15px] leading-relaxed text-foreground " +
  "placeholder:text-muted-foreground/80 transition-colors [field-sizing:content] " +
  "hover:bg-[var(--glass-hover-bg)] focus-visible:border-[var(--field-border)] focus-visible:bg-[var(--glass-bg)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60";

function Caption({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className="px-3 text-sm italic text-muted-foreground" aria-live="polite">
      {text}…
    </p>
  );
}

/**
 * Writing-first editor. `raw` is the single source of truth (raw_text); sections are parsed
 * from it and serialised back on every keystroke, so autosave and AI-improve keep working.
 */
export function AuthorEditor({
  raw,
  mode,
  disabled,
  onEdit,
  activeKey,
  onFocusTarget,
  recording,
  interim,
  horizonCounts,
  firstFieldRef,
}: {
  raw: string;
  mode: EditorMode;
  disabled?: boolean;
  onEdit: (updater: (prev: string) => string) => void;
  activeKey: EditorTarget | null;
  onFocusTarget: (k: EditorTarget) => void;
  recording: boolean;
  interim: string;
  horizonCounts?: Partial<Record<Horizon, number>>;
  firstFieldRef?: React.Ref<HTMLTextAreaElement>;
}) {
  const { t } = notesI18n.useT();
  const parsed = React.useMemo(() => parseNote(raw), [raw]);
  const [revealed, setRevealed] = React.useState<Set<SectionKey>>(new Set());
  const pendingFocus = React.useRef<SectionKey | null>(null);
  const fieldRefs = React.useRef<Partial<Record<SectionKey, HTMLTextAreaElement | null>>>({});

  React.useEffect(() => {
    const k = pendingFocus.current;
    if (k && fieldRefs.current[k]) {
      fieldRefs.current[k]!.focus();
      pendingFocus.current = null;
    }
  });

  if (mode === "free") {
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor="author-note-free" className="sr-only">{t("author.editor.freeLabel")}</label>
        <textarea
          id="author-note-free"
          ref={firstFieldRef}
          value={raw}
          disabled={disabled}
          onFocus={() => onFocusTarget("free")}
          onChange={(e) => {
            const v = e.target.value;
            onEdit(() => v);
          }}
          placeholder={t("author.editor.freePlaceholder")}
          className={cn(FIELD, "min-h-[360px]")}
        />
        {recording && activeKey === "free" && <Caption text={interim} />}
      </div>
    );
  }

  const setSection = (k: SectionKey, v: string) =>
    onEdit((prev) => {
      const p = parseNote(prev);
      return serializeNote({ ...p.sections, [k]: v }, p.free);
    });
  const setFree = (v: string) =>
    onEdit((prev) => {
      const p = parseNote(prev);
      return serializeNote(p.sections, v);
    });

  // Overnight / swing stay folded for intraday-only days unless they have text or trades.
  const isVisible = (k: SectionKey) =>
    (k !== "overnight" && k !== "swing") ||
    !!parsed.sections[k] ||
    revealed.has(k) ||
    (horizonCounts?.[k as Horizon] ?? 0) > 0 ||
    activeKey === k;

  let first = true;
  return (
    <div className="flex flex-col gap-5">
      {parsed.free.trim() && (
        <div className="flex flex-col gap-1">
          <label htmlFor="author-note-intro" className="px-3 text-xs font-medium text-muted-foreground">{t("author.general")}</label>
          <textarea
            id="author-note-intro"
            value={parsed.free}
            disabled={disabled}
            onFocus={() => onFocusTarget("free")}
            onChange={(e) => setFree(e.target.value)}
            className={cn(FIELD, "min-h-[72px]")}
          />
          {recording && activeKey === "free" && <Caption text={interim} />}
        </div>
      )}
      {SECTION_GROUPS.map((g) => {
        const defs = SECTIONS.filter((s) => s.group === g.id);
        const shown = defs.filter((s) => isVisible(s.key));
        const folded = defs.filter((s) => !isVisible(s.key));
        const multi = defs.length > 1;
        return (
          <section key={g.id} aria-labelledby={`author-g-${g.id}`} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3">
              <h3 id={`author-g-${g.id}`} className="text-sm font-semibold text-foreground">{g.title}</h3>
              <span className="text-xs text-muted-foreground">{g.hint}</span>
            </div>
            <div className={cn("grid gap-1.5", g.id === "plan" && "md:grid-cols-2 md:gap-3")}>
              {shown.map((s) => {
                const count = horizonCounts?.[s.key as Horizon];
                const isFirst = first;
                first = false;
                return (
                  <div key={s.key} className="flex min-w-0 flex-col gap-0.5">
                    <label
                      htmlFor={`author-s-${s.key}`}
                      className={cn("flex items-center gap-2 px-3 text-xs font-medium text-muted-foreground", !multi && "sr-only")}
                    >
                      {s.label}
                      {count != null && count > 0 && (
                        <span className="rounded-full bg-primary/15 px-1.5 text-2xs font-medium tabular-nums text-primary">
                          {commonI18n.t("units.trades", { count })}
                        </span>
                      )}
                    </label>
                    <textarea
                      id={`author-s-${s.key}`}
                      ref={(el) => {
                        fieldRefs.current[s.key] = el;
                        if (isFirst && firstFieldRef) {
                          if (typeof firstFieldRef === "function") firstFieldRef(el);
                          else (firstFieldRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
                        }
                      }}
                      value={parsed.sections[s.key]}
                      disabled={disabled}
                      onFocus={() => onFocusTarget(s.key)}
                      onChange={(e) => setSection(s.key, e.target.value)}
                      placeholder={s.placeholder}
                      className={cn(FIELD, g.id === "market" || g.id === "lessons" ? "min-h-[88px]" : "min-h-[64px]")}
                    />
                    {recording && activeKey === s.key && <Caption text={interim} />}
                  </div>
                );
              })}
              {folded.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-3 pt-1">
                  {folded.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        pendingFocus.current = s.key;
                        setRevealed((prev) => new Set(prev).add(s.key));
                      }}
                      className="chip inline-flex min-h-8 items-center gap-1 px-3 text-xs font-medium"
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
