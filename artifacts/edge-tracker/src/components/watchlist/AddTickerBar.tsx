import * as React from "react";
import { Plus, Loader2, CornerDownLeft, ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Kbd, toneText } from "@/components/ds";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { LISTS, LIST_LABELS, TICKER_TOKEN_RE, parseTickers, type ListName } from "./lib";
import type { TickerHistory } from "./use-history";
import { fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { watchlistI18n } from "@/i18n/ns/watchlist";

type Suggestion = {
  ticker: string;
  /** Right-hand meta: «23 сд · +$246», «в «Сегодня»», «из архива», «новый». */
  meta: string;
  metaTone?: "up" | "down" | "neutral";
  hint?: string;
};

export type ActiveInfo = { id: number; list: ListName | null; archived: boolean };

/**
 * Fast add: type one or many tickers («AAPL, NVDA TSLA» or paste a column) → Enter.
 * Suggestions come from the trader's own book (how often / how well they traded it), archived rows
 * and the typed symbol itself. Picking a ticker already on the list moves it to the target list.
 */
export function AddTickerBar({
  inputRef, active, history, archived, target, onTargetChange, onAdd, busy, prefill,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  active: Map<string, ActiveInfo>;
  history: Map<string, TickerHistory>;
  archived: string[];
  target: ListName;
  onTargetChange: (l: ListName) => void;
  onAdd: (tickers: string[], list: ListName) => Promise<boolean> | boolean;
  busy: boolean;
  /** Put a value into the input (deep link ?ticker= for a ticker not on the list). `nonce` re-applies the same value. */
  prefill?: { value: string; nonce: number } | null;
}) {
  const { t } = watchlistI18n.useT();
  const [value, setValue] = React.useState("");
  React.useEffect(() => {
    if (!prefill) return;
    setValue(prefill.value.toUpperCase());
    requestAnimationFrame(() => { inputRef.current?.focus(); setOpen(true); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);
  const [open, setOpen] = React.useState(false);
  const [hi, setHi] = React.useState(0);
  const listId = React.useId();

  // Last token = what autocompletion works on («AAPL, NV|» → «NV»).
  const lastToken = React.useMemo(() => {
    const parts = value.split(/[\s,;|]+/);
    return (parts[parts.length - 1] ?? "").trim().toUpperCase().replace(/^\$/, "");
  }, [value]);
  const parsed = React.useMemo(() => parseTickers(value), [value]);

  const historyRanked = React.useMemo(
    () => Array.from(history.entries()).sort((a, b) => b[1].n - a[1].n),
    [history],
  );

  const suggestions = React.useMemo<Suggestion[]>(() => {
    const out: Suggestion[] = [];
    const seen = new Set<string>();
    const histMeta = (h: TickerHistory): Pick<Suggestion, "meta" | "metaTone"> => ({
      meta: t("add.metaHistory", { count: h.n, net: fmtUsd(h.net, { signed: true, decimals: 0 }) }),
      metaTone: h.net > 0 ? "up" : h.net < 0 ? "down" : "neutral",
    });
    const push = (tk: string) => {
      if (seen.has(tk) || parsed.tickers.slice(0, -1).includes(tk)) return;
      seen.add(tk);
      const a = active.get(tk);
      const h = history.get(tk);
      if (a && !a.archived) {
        out.push({ ticker: tk, meta: a.list ? (a.list === target ? t("add.alreadyIn", { list: LIST_LABELS[a.list] }) : t("add.fromTo", { from: LIST_LABELS[a.list], to: LIST_LABELS[target] })) : t("add.alreadyInWatchlist"), metaTone: "neutral" });
      } else if (h) {
        out.push({ ticker: tk, ...histMeta(h), hint: a?.archived ? t("add.fromArchive") : undefined });
      } else if (a?.archived) {
        out.push({ ticker: tk, meta: t("add.fromArchive"), metaTone: "neutral" });
      } else {
        out.push({ ticker: tk, meta: t("add.newTicker"), metaTone: "neutral" });
      }
    };
    const q = lastToken;
    if (!q) {
      // Empty input: the names you trade most that are not on the working lists yet.
      for (const [tk] of historyRanked) {
        const a = active.get(tk);
        if (a && !a.archived) continue;
        push(tk);
        if (out.length >= 6) break;
      }
      return out;
    }
    if (TICKER_TOKEN_RE.test(q)) push(q);
    for (const [tk] of historyRanked) { if (out.length >= 8) break; if (tk.startsWith(q)) push(tk); }
    for (const tk of archived) { if (out.length >= 8) break; if (tk.startsWith(q)) push(tk); }
    for (const [tk] of active) { if (out.length >= 8) break; if (tk.startsWith(q)) push(tk); }
    return out.slice(0, 8);
  }, [lastToken, historyRanked, archived, active, history, parsed.tickers, target, t]);

  React.useEffect(() => { setHi(0); }, [lastToken]);

  const commit = async (pick?: string) => {
    let tickers = parsed.tickers;
    if (pick) {
      const rest = tickers.filter((x) => x !== lastToken);
      tickers = Array.from(new Set([...rest, pick]));
    }
    if (!tickers.length) return;
    const ok = await onAdd(tickers, target);
    if (ok !== false) { setValue(""); setHi(0); }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && suggestions.length) { e.preventDefault(); setOpen(true); setHi((h) => (h + 1) % suggestions.length); return; }
    if (e.key === "ArrowUp" && suggestions.length) { e.preventDefault(); setOpen(true); setHi((h) => (h - 1 + suggestions.length) % suggestions.length); return; }
    if (e.key === "Tab" && open && suggestions[hi] && lastToken && suggestions[hi].ticker !== lastToken) {
      // Complete the last token, keep typing.
      e.preventDefault();
      setValue((v) => v.replace(/[^\s,;|]*$/, suggestions[hi].ticker) + ", ");
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (busy) return;
      const multi = parsed.tickers.length > 1;
      const pick = open && suggestions[hi] && (!multi || lastToken) ? suggestions[hi].ticker : undefined;
      void commit(pick && (lastToken || !value.trim()) ? pick : undefined);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (open && suggestions.length) setOpen(false);
      else if (value) setValue("");
      else e.currentTarget.blur();
    }
  };

  const showList = open && suggestions.length > 0;
  const multiPreview = parsed.tickers.length > 1;
  const activeDesc = showList ? `${listId}-opt-${hi}` : undefined;

  return (
    <div className="relative min-w-[280px] flex-[1_1_320px]">
      <div className={cn("glass-field flex h-9 items-center gap-2 pl-3 pr-1", showList && "ring-1 ring-primary/40")}>
        {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" />
          : <Plus className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={activeDesc}
          aria-autocomplete="list"
          aria-label={t("add.aria")}
          value={value}
          onChange={(e) => { setValue(e.target.value.toUpperCase()); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          onPaste={() => setOpen(true)}
          placeholder={t("add.placeholder")}
          title={t("add.title")}
          autoComplete="off"
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent text-sm uppercase tracking-wide outline-none placeholder:normal-case placeholder:tracking-normal placeholder:text-muted-foreground"
        />
        {multiPreview && (
          <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground md:inline">
            {commonI18n.t("units.tickers", { count: parsed.tickers.length })}{parsed.invalid.length ? ` · ${t("add.skipped", { count: parsed.invalid.length })}` : ""}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("add.targetAria", { list: LIST_LABELS[target] })}
            >
              {t("add.target", { list: LIST_LABELS[target] })}<ChevronDown className="h-3 w-3" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel className="text-xs text-muted-foreground">{t("add.whereTo")}</DropdownMenuLabel>
            {LISTS.map((l) => (
              <DropdownMenuItem key={l} onSelect={() => onTargetChange(l)}>
                <Check className={cn("mr-2 h-4 w-4", l === target ? "opacity-100" : "opacity-0")} />{LIST_LABELS[l]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={() => void commit()}
          disabled={!parsed.tickers.length || busy}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary-solid text-primary-foreground transition-opacity disabled:opacity-40"
          aria-label={commonI18n.t("actions.add")}
          title={t("add.addTitle")}
        >
          <CornerDownLeft className="h-3.5 w-3.5" />
        </button>
      </div>

      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t("add.suggestAria")}
          className="glass-thick absolute inset-x-0 top-[calc(100%+4px)] z-popover max-h-80 overflow-auto rounded-xl bg-popover p-1 shadow-xl"
        >
          {!lastToken && <li className="px-2.5 pb-1 pt-0.5 text-xs text-muted-foreground" aria-hidden="true">{t("add.frequent")}</li>}
          {suggestions.map((s, i) => (
            <li
              key={s.ticker}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === hi}
              onMouseDown={(e) => { e.preventDefault(); void commit(s.ticker); }}
              onMouseEnter={() => setHi(i)}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-item px-2.5 py-1.5 text-sm",
                i === hi ? "bg-[var(--glass-hover-bg)] text-foreground" : "text-foreground/90",
              )}
            >
              <span className="w-16 font-semibold tracking-tight">{s.ticker}</span>
              {s.hint && <span className="text-xs text-muted-foreground">{s.hint}</span>}
              <span className={cn("ml-auto text-xs tabular-nums", s.metaTone && s.metaTone !== "neutral" ? toneText(s.metaTone) : "text-muted-foreground")}>{s.meta}</span>
            </li>
          ))}
          <li className="flex items-center gap-1.5 border-t border-[var(--glass-border)] px-2.5 pb-0.5 pt-1.5 text-xs text-muted-foreground" aria-hidden="true">
            <Kbd>↑</Kbd><Kbd>↓</Kbd> {t("add.keysPick")} · <Kbd>Tab</Kbd> {t("add.keysComplete")} · <Kbd>Enter</Kbd> {t("add.keysAdd")}
          </li>
        </ul>
      )}
    </div>
  );
}
