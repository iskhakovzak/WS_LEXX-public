import { useMemo, useState } from "react";
import { TRADE_TAGS, getCategoryForTag, type TagCategory } from "@/lib/tags";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { Check, Plus, Tag, X, History } from "lucide-react";
import { commonI18n } from "@/i18n/ns/common";
import { rich, slots } from "@/i18n/rich";

interface TagSelectorProps {
  selectedTags: string[];
  onChange: (tags: string[]) => void;
  /** Optional: allow creating tags that are not in the catalogue (default true). */
  allowCreate?: boolean;
  /** Optional: trigger placeholder. */
  placeholder?: string;
  /** Optional: accessible label for the control (default «Теги»). */
  label?: string;
}

/** CSS colour per catalogue category (token based). Custom tags fall back to muted. */
const CATEGORY_COLOR: Record<string, string> = {
  setup: "hsl(var(--chart-1))",
  catalyst: "hsl(var(--chart-3))",
  levels: "hsl(var(--chart-2))",
  stock_profile: "hsl(var(--chart-5))",
  market: "hsl(var(--chart-4))",
  execution: "hsl(var(--primary))",
  mistakes: "hsl(var(--down))",
  result: "hsl(var(--up))",
};
const CUSTOM_COLOR = "hsl(var(--muted-foreground))";

/** Colour for a tag's dot (exported so lists can render matching dots). */
export function tagDotColor(tag: string): string {
  const cat = getCategoryForTag(tag);
  return (cat && CATEGORY_COLOR[cat as string]) || CUSTOM_COLOR;
}

function Dot({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block h-2 w-2 shrink-0 rounded-full", className)} style={{ background: color }} />;
}

const RECENT_KEY = "ws_lexx_recent_tags";
function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string").slice(0, 12) : [];
  } catch { return []; }
}
function pushRecent(tag: string) {
  try {
    const next = [tag, ...readRecent().filter((t) => t !== tag)].slice(0, 12);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* storage blocked */ }
}

const CATEGORIES = Object.entries(TRADE_TAGS) as Array<[TagCategory, (typeof TRADE_TAGS)[string]]>;
const ALL_TAGS_LOWER = new Set(CATEGORIES.flatMap(([, c]) => c.groups.flatMap((g) => g.tags.map((t) => t.toLowerCase()))));

export function TagSelector({ selectedTags, onChange, allowCreate = true, placeholder: placeholderProp, label: labelProp }: TagSelectorProps) {
  const { t: tc } = commonI18n.useT();
  const placeholder = placeholderProp ?? tc("tagPicker.add");
  const label = labelProp ?? tc("fields.tags");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [cat, setCat] = useState<TagCategory | "all">("all");
  const [recent, setRecent] = useState<string[]>(() => readRecent());

  const selected = useMemo(() => new Set(selectedTags), [selectedTags]);

  const toggle = (tag: string) => {
    if (selected.has(tag)) {
      onChange(selectedTags.filter((t) => t !== tag));
    } else {
      onChange([...selectedTags, tag]);
      pushRecent(tag);
      setRecent(readRecent());
    }
  };

  const term = search.trim();
  const canCreate =
    allowCreate && term.length > 0 && term.length <= 60 &&
    !ALL_TAGS_LOWER.has(term.toLowerCase()) &&
    !selectedTags.some((t) => t.toLowerCase() === term.toLowerCase());

  const create = () => {
    if (!canCreate) return;
    onChange([...selectedTags, term]);
    pushRecent(term);
    setRecent(readRecent());
    setSearch("");
  };

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of selectedTags) {
      const c = getCategoryForTag(t);
      if (c) m[c as string] = (m[c as string] ?? 0) + 1;
    }
    return m;
  }, [selectedTags]);

  const visibleCats = cat === "all" ? CATEGORIES : CATEGORIES.filter(([k]) => k === cat);
  const recentSuggestions = recent.filter((t) => !selected.has(t)).slice(0, 6);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
        {selectedTags.map((tag) => (
          <span
            key={tag}
            className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-[var(--field-border)] bg-[var(--glass-bg)] py-0.5 pl-2.5 pr-0.5 text-xs font-medium text-foreground"
          >
            <Dot color={tagDotColor(tag)} />
            {tag}
            <button
              type="button"
              onClick={() => toggle(tag)}
              aria-label={tc("tagPicker.removeAria", { tag })}
              className="grid h-6 w-6 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}

        <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(""); }}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={open}
              className="chip inline-flex min-h-7 items-center gap-1.5 px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {selectedTags.length === 0 ? placeholder : tc("tagPicker.more")}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(92vw,380px)] p-0">
            <Command loop className="bg-transparent">
              <CommandInput
                value={search}
                onValueChange={setSearch}
                placeholder={tc("tagPicker.searchPlaceholder")}
                aria-label={tc("tagPicker.searchAria")}
              />
              <div className="flex gap-1 overflow-x-auto border-b border-[var(--glass-border)] px-2 py-2" role="group" aria-label={tc("tagPicker.category")}>
                {([["all", tc("states.all")], ...CATEGORIES.map(([k, c]) => [k, c.name])] as Array<[TagCategory | "all", string]>).map(([k, name]) => (
                  <button
                    key={k as string}
                    type="button"
                    aria-pressed={cat === k}
                    onClick={() => setCat(k)}
                    className="chip inline-flex min-h-7 shrink-0 items-center gap-1.5 px-2.5 text-xs font-medium"
                  >
                    {k !== "all" && <Dot color={CATEGORY_COLOR[k as string] ?? CUSTOM_COLOR} />}
                    {name}
                    {k !== "all" && counts[k as string] ? <span className="tabular-nums opacity-80">{counts[k as string]}</span> : null}
                  </button>
                ))}
              </div>
              <CommandList className="max-h-[320px]">
                <CommandEmpty className="py-6 text-center text-sm text-muted-foreground">
                  {allowCreate ? tc("tagPicker.nothingCreate") : tc("states.nothingFound")}
                </CommandEmpty>
                {canCreate && (
                  <CommandGroup>
                    <CommandItem value={`__create__ ${term}`} onSelect={create}>
                      <Plus aria-hidden="true" />
                      {rich(tc("tagPicker.create", slots("term")), { term: <span className="font-semibold">{term}</span> })}
                    </CommandItem>
                  </CommandGroup>
                )}
                {!term && cat === "all" && recentSuggestions.length > 0 && (
                  <CommandGroup heading={tc("tagPicker.recent")}>
                    {recentSuggestions.map((t) => (
                      <CommandItem key={`recent-${t}`} value={`recent ${t}`} onSelect={() => toggle(t)}>
                        <History className="text-muted-foreground" aria-hidden="true" />
                        <Dot color={tagDotColor(t)} />
                        <span className="truncate">{t}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {visibleCats.map(([key, category]) =>
                  category.groups.map((group) => (
                    <CommandGroup key={`${key}-${group.label}`} heading={`${category.name} · ${group.label}`}>
                      {group.tags.map((tag) => {
                        const on = selected.has(tag);
                        return (
                          <CommandItem
                            key={`${key}-${group.label}-${tag}`}
                            value={`${tag} ${group.label} ${key}`}
                            keywords={[tag, group.label, category.name]}
                            onSelect={() => toggle(tag)}
                            aria-selected={on}
                          >
                            <Dot color={CATEGORY_COLOR[key as string] ?? CUSTOM_COLOR} />
                            <span className="flex-1 truncate">{tag}</span>
                            {on && <Check className="text-primary" aria-hidden="true" />}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  )),
                )}
              </CommandList>
              <div className="flex items-center justify-between gap-2 border-t border-[var(--glass-border)] px-3 py-2 text-2xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Tag className="h-3 w-3" aria-hidden="true" />
                  {rich(tc("tagPicker.selected", slots("count")), { count: <span className="tabular-nums text-foreground">{selectedTags.length}</span> })}
                </span>
                <span className="hidden sm:inline">{tc("tagPicker.keys")}</span>
              </div>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {selectedTags.length === 0 && recentSuggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-2xs text-muted-foreground">{tc("tagPicker.recentLabel")}</span>
          {recentSuggestions.slice(0, 5).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => toggle(t)}
              className="inline-flex min-h-6 items-center gap-1.5 rounded-full px-2 text-2xs text-muted-foreground transition-colors hover:bg-[var(--glass-hover-bg)] hover:text-foreground"
            >
              <Dot color={tagDotColor(t)} className="h-1.5 w-1.5" />
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
