/** Tag editor: chips (drag to reorder), free input with server suggestions, template catalogue. */
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Plus, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { TRADE_TAGS, type TagSubgroup } from "@/lib/tags";
import { cn } from "@/lib/utils";
import { splitTags } from "./model";
import { playbookI18n } from "@/i18n/ns/playbook";
const pt = playbookI18n.t; // called at render time only
import { commonI18n } from "@/i18n/ns/common";

type Cat = [string, { name: string; groups: TagSubgroup[] }];

export function TagChipEditor({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  const chips = splitTags(value);
  const [input, setInput] = useState("");
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [tagSearch, setTagSearch] = useState("");
  const [showCatalogue, setShowCatalogue] = useState(false);
  const dragIdx = useRef<number | null>(null);

  const { data: serverTags = [] } = useQuery<{ tag: string; count: number }[]>({
    queryKey: ["playbook-tags"],
    queryFn: ({ signal }) =>
      http
        .get<{ tag: string; count: number }[]>("/api/playbook/tags", { signal })
        .then((j) => (Array.isArray(j) ? j : []))
        .catch(() => []),
    staleTime: STALE.short,
  });

  const inputLower = input.trim().toLowerCase();
  const suggestions = useMemo(
    () => (inputLower ? serverTags.filter((t) => t.tag.toLowerCase().includes(inputLower) && !chips.includes(t.tag)).slice(0, 8) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverTags, inputLower, value],
  );

  const q = tagSearch.toLowerCase();
  const categories = useMemo((): Cat[] => {
    const all = Object.entries(TRADE_TAGS) as Cat[];
    if (!q) return all;
    return all
      .map(([key, cat]) => {
        const groups = cat.groups.map((g) => ({ ...g, tags: g.tags.filter((t) => t.toLowerCase().includes(q)) })).filter((g) => g.tags.length);
        return groups.length ? ([key, { ...cat, groups }] as Cat) : null;
      })
      .filter(Boolean) as Cat[];
  }, [q]);

  const set = (next: string[]) => onChange(next.join(", "));
  function addTag(tag?: string) {
    const t = (tag ?? input).trim().replace(/,+$/, "");
    if (t && !chips.includes(t)) set([...chips, t]);
    setInput("");
  }
  const toggle = (tag: string) => set(chips.includes(tag) ? chips.filter((t) => t !== tag) : [...chips, tag]);
  function onDrop(i: number) {
    const from = dragIdx.current;
    dragIdx.current = null;
    if (from == null || from === i) return;
    const next = [...chips];
    const [item] = next.splice(from, 1);
    next.splice(i, 0, item);
    set(next);
  }

  return (
    <div className="space-y-2">
      <div className="flex min-h-7 flex-wrap gap-1.5">
        {chips.length === 0 && <span className="text-xs text-muted-foreground">{pt("tags.none")}</span>}
        {chips.map((tag, i) => (
          <span
            key={tag}
            draggable
            onDragStart={() => { dragIdx.current = i; }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(i)}
            className="inline-flex cursor-grab select-none items-center gap-1 rounded-full bg-primary/15 py-0.5 pl-2.5 pr-1 text-xs text-primary"
          >
            {tag}
            <button
              type="button"
              aria-label={pt("tags.remove", { tag })}
              onClick={() => set(chips.filter((_, j) => j !== i))}
              className="grid h-6 w-6 place-items-center rounded-full hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>

      <div className="flex gap-2">
        <Input
          id={id}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(); }
            if (e.key === "Backspace" && !input && chips.length) set(chips.slice(0, -1));
          }}
          placeholder={pt("tags.placeholder")}
          aria-label={pt("tags.newAria")}
          className="h-9 flex-1 text-sm"
        />
        <button
          type="button"
          aria-label={pt("tags.add")}
          title={pt("tags.add")}
          onClick={() => addTag()}
          className="glass-field grid h-9 w-9 shrink-0 place-items-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label={pt("tags.similar")}>
          {suggestions.map((s) => (
            <button key={s.tag} type="button" onClick={() => addTag(s.tag)} className="chip min-h-7 px-2.5 text-xs">
              {s.tag} <span className="tabular-nums text-muted-foreground">×{s.count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="rounded-xl bg-[var(--glass-bg)]">
        <button
          type="button"
          aria-expanded={showCatalogue}
          onClick={() => setShowCatalogue((v) => !v)}
          className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {pt("tags.templates")}
          <ChevronDown className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", showCatalogue && "rotate-180")} aria-hidden="true" />
        </button>
        {showCatalogue && (
          <div className="space-y-2 px-3 pb-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                value={tagSearch}
                onChange={(e) => setTagSearch(e.target.value)}
                placeholder={pt("tags.templatesSearch")}
                aria-label={pt("tags.templatesSearchAria")}
                className="h-8 pl-8 text-xs"
              />
            </div>
            <div className="max-h-[min(55dvh,440px)] space-y-1 overflow-y-auto">
              {categories.length === 0 && <p className="py-3 text-center text-xs text-muted-foreground">{commonI18n.t("states.nothingFound")}</p>}
              {categories.map(([key, cat]) => {
                const isOpen = !!q || openCat === key;
                const selected = cat.groups.flatMap((g) => g.tags).filter((t) => chips.includes(t)).length;
                return (
                  <div key={key}>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => !q && setOpenCat(isOpen ? null : key)}
                      className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs font-medium text-foreground hover:bg-[var(--glass-hover-bg)]"
                    >
                      {cat.name}
                      <span className="flex items-center gap-1.5">
                        {selected > 0 && <span className="rounded-full bg-primary/15 px-1.5 text-xs tabular-nums text-primary">{selected}</span>}
                        {!q && <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground", isOpen && "rotate-180")} aria-hidden="true" />}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="grid grid-cols-1 gap-x-3 gap-y-2 px-2 pb-2 pt-1 sm:grid-cols-2">
                        {cat.groups.map((g) => (
                          <div key={g.label}>
                            <div className="mb-1 text-xs text-muted-foreground">{g.label}</div>
                            <div className="flex flex-wrap gap-1">
                              {g.tags.map((tag) => (
                                <button
                                  key={tag}
                                  type="button"
                                  aria-pressed={chips.includes(tag)}
                                  onClick={() => toggle(tag)}
                                  className="chip min-h-6 px-2 text-xs"
                                >
                                  {tag}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
