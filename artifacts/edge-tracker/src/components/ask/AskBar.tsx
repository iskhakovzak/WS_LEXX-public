/**
 * «Спроси журнал» (Ask the journal) query bar — a combobox whose dropdown is a Radix Popover portal (z-popover) anchored to the
 * field, so it never hides under the answer panels and never pushes the layout. The «понял как» preview lives
 * inside the dropdown (debounced), not under the field.
 *
 * Keyboard: ↑/↓ — move through suggestions, Enter — ask (or take the highlighted suggestion), Tab — accept the
 * ticker/setup completion, Esc — close the list, a second Esc clears the field.
 */
import * as React from "react";
import { CornerDownLeft, History, MessageSquareText, Pin, Sparkles, Tag, X } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Kbd, Pill } from "@/components/ds";
import { cn } from "@/lib/utils";
import { parseAsk, type ParseContext } from "@/lib/ask/parse";
import { askExamples } from "@/lib/ask/examples";
import { askI18n } from "@/i18n/ns/ask";
import { commonI18n } from "@/i18n/ns/common";

type ItemKind = "complete" | "pinned" | "history" | "example";
interface Item { kind: ItemKind; text: string; label: string; meta?: string }

const KIND_ICON: Record<ItemKind, typeof History> = { complete: Tag, pinned: Pin, history: History, example: Sparkles };

/** The word being typed (last run of letters/digits at the end of the text). */
function lastWord(text: string): { word: string; start: number } | null {
  const m = /([\p{L}\d][\p{L}\d&\-]*)$/u.exec(text);
  return m ? { word: m[1], start: m.index } : null;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function AskBar({
  value,
  onChange,
  onSubmit,
  ctx,
  tickers = [],
  setups = [],
  history = [],
  pinned = [],
  autoFocus,
  busy,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (text: string) => void;
  ctx: ParseContext;
  /** Tickers / setups from the book with trade counts (autocomplete). */
  tickers?: Array<{ value: string; n: number }>;
  setups?: Array<{ value: string; n: number }>;
  history?: string[];
  pinned?: string[];
  autoFocus?: boolean;
  busy?: boolean;
  className?: string;
}) {
  const { t } = askI18n.useT();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  // The mount-time autofocus must not pop the list over the page (it covered the example cards on load):
  // the dropdown opens only on a real interaction — typing, click, arrows, or a later focus.
  const skipAutoFocusOpen = React.useRef(Boolean(autoFocus));

  const q = value.trim().toLowerCase();
  const items = React.useMemo<Item[]>(() => {
    const out: Item[] = [];
    const lw = lastWord(value);
    if (lw && lw.word.length >= 1) {
      const w = lw.word.toLowerCase();
      const head = value.slice(0, lw.start);
      const tick = /^[a-z]{1,5}$/i.test(lw.word)
        ? tickers.filter((t) => t.value.toLowerCase().startsWith(w) && t.value.toLowerCase() !== w).slice(0, 5)
        : [];
      for (const tk of tick) out.push({ kind: "complete", text: `${head}${tk.value} `, label: tk.value, meta: commonI18n.t("units.tradesShort", { count: tk.n }) });
      if (w.length >= 2) {
        for (const s of setups.filter((s) => s.value.toLowerCase().startsWith(w) && s.value.toLowerCase() !== w).slice(0, 3)) {
          out.push({ kind: "complete", text: `${head}${s.value} `, label: t("bar.setup", { name: s.value }), meta: commonI18n.t("units.tradesShort", { count: s.n }) });
        }
      }
    }
    const match = (s: string) => !q || (s.toLowerCase().includes(q) && s.toLowerCase() !== q);
    const seen = new Set<string>();
    const add = (kind: ItemKind, list: readonly string[], max: number) => {
      let n = 0;
      for (const s of list) {
        const k = s.toLowerCase();
        if (n >= max || seen.has(k) || !match(s)) continue;
        seen.add(k);
        out.push({ kind, text: s, label: s });
        n++;
      }
    };
    add("pinned", pinned, q ? 3 : 5);
    add("history", history, q ? 4 : 6);
    // Fewer examples once the person has their own questions (choice overload: 3–5 options at a glance).
    add("example", askExamples(), q ? 4 : pinned.length || history.length ? 3 : 6);
    return out;
  }, [value, q, tickers, setups, history, pinned, t]);

  // «Понял как» preview, debounced so typing stays smooth.
  const debounced = useDebounced(value, 150);
  const preview = React.useMemo(() => (debounced.trim() ? parseAsk(debounced, ctx) : null), [debounced, ctx]);
  const showPreview = Boolean(preview && value.trim());

  React.useEffect(() => { setActive(-1); }, [value]);

  const submit = (text: string) => {
    const t = text.trim();
    if (!t) return;
    setOpen(false);
    setActive(-1);
    onChange(t);
    onSubmit(t);
  };

  const pick = (it: Item) => {
    if (it.kind === "complete") {
      onChange(it.text);
      setActive(-1);
      inputRef.current?.focus();
      return;
    }
    submit(it.text);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        if (open && active >= 0 && items[active]) pick(items[active]);
        else submit(value);
        return;
      case "Tab": {
        if (!open) return;
        const it = active >= 0 && items[active]?.kind === "complete" ? items[active] : items.find((x) => x.kind === "complete");
        if (it && !e.shiftKey) { e.preventDefault(); pick(it); }
        return;
      }
      case "Escape":
        if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setActive(-1); return; }
        if (value) { e.preventDefault(); onChange(""); }
        return;
      case "ArrowDown":
        e.preventDefault();
        if (!open) { setOpen(true); setActive(items.length ? 0 : -1); return; }
        if (items.length) setActive((i) => (i + 1) % items.length);
        return;
      case "ArrowUp":
        e.preventDefault();
        if (!open) { setOpen(true); setActive(items.length - 1); return; }
        if (items.length) setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
        return;
    }
  };

  // Keep the highlighted option in view.
  React.useEffect(() => {
    if (active < 0) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listId]);

  const hasContent = items.length > 0 || showPreview;
  let lastKind: ItemKind | null = null;

  return (
    <Popover open={open && hasContent} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          ref={anchorRef}
          className={cn("glass-field flex items-center gap-2 px-3 py-1.5 focus-within:ring-2 focus-within:ring-primary/40", className)}
        >
          <MessageSquareText className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <input
            ref={inputRef}
            autoFocus={autoFocus}
            value={value}
            onChange={(e) => { onChange(e.target.value); setOpen(true); }}
            onFocus={() => {
              if (skipAutoFocusOpen.current) { skipAutoFocusOpen.current = false; return; }
              setOpen(true);
            }}
            onClick={() => setOpen(true)}
            onBlur={(e) => {
              const next = e.relatedTarget as Node | null;
              if (next && (contentRef.current?.contains(next) || anchorRef.current?.contains(next))) return;
              setOpen(false);
            }}
            onKeyDown={onKeyDown}
            placeholder={t("bar.placeholder")}
            aria-label={t("bar.aria")}
            role="combobox"
            aria-expanded={open && hasContent}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
            className="h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            spellCheck={false}
            autoComplete="off"
            enterKeyHint="search"
          />
          {value && (
            <button
              type="button"
              aria-label={t("bar.clear")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onChange(""); inputRef.current?.focus(); setOpen(true); }}
              className="chip grid h-7 w-7 shrink-0 place-items-center"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => submit(value)}
            disabled={!value.trim() || busy}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary-solid px-3 text-xs font-medium text-primary-foreground transition-opacity duration-[var(--dur-1)] disabled:opacity-50"
          >
            {t("bar.submit")} <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </PopoverAnchor>

      <PopoverContent
        ref={contentRef}
        align="start"
        sideOffset={6}
        collisionPadding={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        // Esc is handled by the input (first closes, second clears); Radix must not close it first.
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => { if (anchorRef.current?.contains(e.target as Node)) e.preventDefault(); }}
        className="flex w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] flex-col bg-popover p-0 shadow-xl"
      >
        {showPreview && preview && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--glass-border)] px-3 py-2.5 text-xs text-muted-foreground" aria-live="polite">
            {preview.tokens.length ? (
              <>
                <span>{t("bar.understood")}</span>
                {preview.tokens.map((t) => <Pill key={t.key} tone={t.kind === "intent" || t.kind === "compare" || t.kind === "group" ? "accent" : "neutral"}>{t.label}</Pill>)}
                {preview.unknown.length > 0 && <span>{t("bar.skip", { words: preview.unknown.join(" ") })}</span>}
              </>
            ) : (
              <span>{t("bar.notYet")}</span>
            )}
          </div>
        )}
        {items.length > 0 && (
          <ul id={listId} role="listbox" aria-label={t("bar.suggestions")} className="max-h-[min(360px,calc(var(--radix-popover-content-available-height)-56px))] overflow-y-auto overscroll-contain p-1.5">
            {items.map((it, i) => {
              const header = it.kind !== lastKind ? t(`bar.kinds.${it.kind}`) : null;
              lastKind = it.kind;
              const Icon = KIND_ICON[it.kind];
              return (
                <React.Fragment key={`${it.kind}-${it.text}`}>
                  {header && <li role="presentation" className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground first:pt-1">{header}</li>}
                  <li
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => { e.preventDefault(); pick(it); }}
                    onMouseMove={() => { if (active !== i) setActive(i); }}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors duration-[var(--dur-1)]",
                      i === active ? "bg-[var(--glass-hover-bg)] text-foreground" : "text-foreground/90",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className={cn("truncate", it.kind === "complete" && "font-medium")}>{it.label}</span>
                    {it.meta && <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{it.meta}</span>}
                  </li>
                </React.Fragment>
              );
            })}
          </ul>
        )}
        <div className="flex items-center gap-3 border-t border-[var(--glass-border)] px-3 py-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> {t("bar.keyMove")}</span>
          <span className="inline-flex items-center gap-1"><Kbd>↵</Kbd> {t("bar.keyAsk")}</span>
          <span className="inline-flex items-center gap-1"><Kbd>Tab</Kbd> {t("bar.keyComplete")}</span>
          <span className="ml-auto inline-flex items-center gap-1"><Kbd>Esc</Kbd> {t("bar.keyClose")}</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
