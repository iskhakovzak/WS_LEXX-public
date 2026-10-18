// Quick review tagging: setup / mistake / emotion pickers (keyboard-first) and the chips shown on a trade row.
// Setup goes to trades.setup (single value); mistakes and emotions live in trades.tags (vocabulary in review-presets).
import * as React from "react";
import type { Trade } from "@workspace/api-client-react";
import { Check, Plus } from "lucide-react";
import { Kbd, Pill, type Tone } from "@/components/ds";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { tradesI18n } from "@/i18n/ns/trades";
import { EMOTIONS, MISTAKES, classifyTags, tagLabel, tagMatches, type TagKind } from "./review-presets";

const kindMeta = (kind: TagKind, key: string, tone: Tone) => ({
  key,
  tone,
  get label() { return tradesI18n.t(`tagging.kind.${kind}.label`); },
  get add() { return tradesI18n.t(`tagging.kind.${kind}.label`); },
  get placeholder() { return tradesI18n.t(`tagging.kind.${kind}.placeholder`); },
});
/** Labels are read in the current language on access. */
export const KIND_META: Record<TagKind, { label: string; add: string; key: string; tone: Tone; placeholder: string }> = {
  setup: kindMeta("setup", "S", "accent"),
  mistake: kindMeta("mistake", "M", "warn"),
  emotion: kindMeta("emotion", "E", "purple"),
};

/** Setup names are user content; mistake / emotion vocabulary words are shown in the UI language. */
const shown = (kind: TagKind, v: string) => (kind === "setup" ? v : tagLabel(v));

export type PickState = "all" | "some" | "none";
export type PickerTarget = { id: number | "bulk"; kind: TagKind } | null;

/** Options of a picker: vocabulary first, then values already used on the desk. */
export function pickerOptions(kind: TagKind, setupOptions: readonly string[]): string[] {
  if (kind === "setup") return Array.from(new Set(setupOptions.filter(Boolean)));
  return [...(kind === "mistake" ? MISTAKES : EMOTIONS)];
}

/**
 * Popover list with digit hotkeys (1–9), arrows + Enter, and free text (Enter adds what is typed).
 * Setup is single-choice: picking closes the popover. Mistakes / emotions toggle and stay open.
 */
export function TagPicker({
  kind,
  open,
  onOpenChange,
  options,
  stateOf,
  onPick,
  onClear,
  children,
  align = "start",
}: {
  kind: TagKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: readonly string[];
  stateOf: (value: string) => PickState;
  onPick: (value: string) => void;
  /** Setup only: remove the current value. */
  onClear?: () => void;
  /** Anchor element(s) the popover attaches to. */
  children: React.ReactNode;
  align?: "start" | "end" | "center";
}) {
  const { t } = tradesI18n.useT();
  const meta = KIND_META[kind];
  const [q, setQ] = React.useState("");
  const [hi, setHi] = React.useState(0);
  React.useEffect(() => { if (open) { setQ(""); setHi(0); } }, [open]);
  const query = q.trim().toLowerCase();
  const list = React.useMemo(() => (query ? options.filter((o) => (kind === "setup" ? o.toLowerCase().includes(query) : tagMatches(o, query))) : options), [options, query, kind]);
  const exact = list.some((o) => o.toLowerCase() === query || shown(kind, o).toLowerCase() === query);
  const canAdd = query.length > 0 && !exact;

  const pick = (v: string) => {
    onPick(v);
    if (kind === "setup") onOpenChange(false);
    else setQ("");
  };

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!q && /^[1-9]$/.test(e.key)) {
      const v = list[Number(e.key) - 1];
      if (v) { e.preventDefault(); pick(v); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(list.length - 1, h + 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (canAdd && (!list.length || hi >= list.length)) pick(q.trim().slice(0, 60));
      else if (list[hi]) pick(list[hi]);
      else if (canAdd) pick(q.trim().slice(0, 60));
    }
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        align={align}
        side="bottom"
        collisionPadding={12}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onClick={(e) => e.stopPropagation()}
        className="w-[min(92vw,280px)] p-2"
      >
        <div className="flex items-center justify-between gap-2 px-1 pb-1.5">
          <span className="text-xs font-semibold text-foreground">{meta.label}</span>
          <span className="text-xs text-muted-foreground">1–9 · Enter</span>
        </div>
        <Input
          autoFocus
          value={q}
          onChange={(e) => { setQ(e.target.value); setHi(0); }}
          onKeyDown={onKeyDown}
          placeholder={meta.placeholder}
          aria-label={meta.placeholder}
          maxLength={60}
          className="h-8 text-sm"
        />
        <ul role="listbox" aria-label={meta.label} className="mt-1.5 max-h-[min(320px,calc(var(--radix-popover-content-available-height,400px)-90px))] overflow-y-auto overscroll-contain">
          {list.map((o, i) => {
            const st = stateOf(o);
            return (
              <li key={o}>
                <button
                  type="button"
                  role="option"
                  aria-selected={st === "all"}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => pick(o)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
                    i === hi ? "bg-[var(--glass-hover-bg)] text-foreground" : "text-foreground/90",
                  )}
                >
                  <span className={cn("grid h-4 w-4 shrink-0 place-items-center rounded border border-[var(--field-border)]", st === "all" && "border-primary bg-primary-solid text-primary-foreground", st === "some" && "border-primary")}>
                    {st === "all" && <Check className="h-3 w-3" aria-hidden="true" />}
                    {st === "some" && <span className="h-0.5 w-2 rounded bg-primary" aria-hidden="true" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={shown(kind, o)}>{shown(kind, o)}</span>
                  {i < 9 && !q && <Kbd>{i + 1}</Kbd>}
                </button>
              </li>
            );
          })}
          {canAdd && (
            <li>
              <button
                type="button"
                onClick={() => pick(q.trim().slice(0, 60))}
                className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm", hi >= list.length && "bg-[var(--glass-hover-bg)]")}
              >
                <Plus className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">{t("tagging.addValue", { value: q.trim() })}</span>
              </button>
            </li>
          )}
          {!list.length && !canAdd && <li className="px-2 py-2 text-xs text-muted-foreground">{t("tagging.startTyping")}</li>}
        </ul>
        {onClear && (
          <button type="button" onClick={() => { onClear(); onOpenChange(false); }} className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground">
            {t("tagging.clearSetup")}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Setup / mistake / emotion chips of one trade with "+" buttons (visible on row hover / focus / when the row is
 * active). Each group anchors its own picker; the page owns which picker is open (keyboard S / M / E).
 */
export function ReviewChips({
  trade,
  canTag,
  picker,
  setPicker,
  onPick,
  setupOptions,
  className,
}: {
  trade: Trade;
  canTag: boolean;
  picker: PickerTarget;
  setPicker: (p: PickerTarget) => void;
  onPick: (t: Trade, kind: TagKind, value: string | null) => void;
  setupOptions: readonly string[];
  className?: string;
}) {
  const { t } = tradesI18n.useT();
  const { mistakes, emotions, other } = classifyTags(trade.tags);
  const setup = trade.setup?.trim() || "";
  const isOpen = (k: TagKind) => picker?.id === trade.id && picker.kind === k;
  const openPicker = (k: TagKind) => (e: React.MouseEvent) => { e.stopPropagation(); setPicker(isOpen(k) ? null : { id: trade.id, kind: k }); };
  const addBtn = (k: TagKind) =>
    canTag ? (
      <button
        type="button"
        onClick={openPicker(k)}
        aria-label={t("tagging.addAria", { kind: KIND_META[k].add, key: KIND_META[k].key })}
        className={cn(
          "inline-flex h-6 items-center gap-0.5 rounded-full border border-dashed border-[var(--field-border)] px-2 text-xs text-muted-foreground transition-opacity hover:border-primary/60 hover:text-foreground focus-visible:opacity-100",
          isOpen(k) ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-data-[active=true]:opacity-100",
        )}
      >
        <Plus className="h-3 w-3" aria-hidden="true" /> {KIND_META[k].add}
      </button>
    ) : null;

  const group = (k: TagKind, chips: React.ReactNode, showAdd: boolean) => {
    const values = k === "setup" ? (setup ? [setup] : []) : k === "mistake" ? mistakes : emotions;
    const lower = new Set(values.map((v) => v.toLowerCase()));
    const opts = pickerOptions(k, setupOptions);
    // Values already on the trade that are not in the vocabulary stay pickable (to remove them).
    const merged = [...values.filter((v) => !opts.some((o) => o.toLowerCase() === v.toLowerCase())), ...opts];
    return (
      <TagPicker
        kind={k}
        open={isOpen(k)}
        onOpenChange={(o) => setPicker(o ? { id: trade.id, kind: k } : null)}
        options={merged}
        stateOf={(v) => (lower.has(v.toLowerCase()) ? "all" : "none")}
        onPick={(v) => onPick(trade, k, v)}
        onClear={k === "setup" && setup ? () => onPick(trade, "setup", null) : undefined}
      >
        <span className="inline-flex flex-wrap items-center gap-1">
          {chips}
          {showAdd && addBtn(k)}
        </span>
      </TagPicker>
    );
  };

  const chip = (k: TagKind, v: string) => (
    <button key={`${k}:${v}`} type="button" disabled={!canTag} onClick={openPicker(k)} className="rounded-full disabled:cursor-default" title={t("tagging.chipTitle", { kind: KIND_META[k].label, value: shown(k, v) })}>
      <Pill tone={KIND_META[k].tone} className="max-w-[160px]"><span className="truncate">{shown(k, v)}</span></Pill>
    </button>
  );

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-1", className)} onClick={(e) => e.stopPropagation()}>
      {group("setup", setup ? chip("setup", setup) : null, !setup)}
      {group("mistake", mistakes.map((m) => chip("mistake", m)), true)}
      {group("emotion", emotions.map((m) => chip("emotion", m)), true)}
      {other.length > 0 && (
        <Pill tone="neutral" title={other.map(tagLabel).join(", ")} className="max-w-[140px]">
          <span className="truncate">{tagLabel(other[0])}</span>{other.length > 1 && <span>+{other.length - 1}</span>}
        </Pill>
      )}
    </div>
  );
}
