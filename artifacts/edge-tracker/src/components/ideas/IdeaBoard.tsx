import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Pill } from "@/components/ds";
import { cn } from "@/lib/utils";
import { IdeaCard } from "./IdeaCard";
import { STAGES, type IdeaTracking, type Stage, type TradeIdea } from "./model";
import { ideasI18n } from "@/i18n/ns/ideas";
import { commonI18n } from "@/i18n/ns/common";

const emptyCopy = (s: Stage): string => (s === "rejected" ? commonI18n.t("states.empty") : ideasI18n.t(`board.empty.${s}`));

/** Closed lanes (won / lost / rejected) show the newest cards first; the rest unfold on demand. */
const CLOSED_LANES = new Set<Stage>(["won", "lost", "rejected"]);
const CLOSED_PREVIEW = 6;

/** Kanban-style pipeline: Черновик → На ревью → Активна → Сработала / Не сработала (+ Отклонена when present). */
export function IdeaBoard({
  groups,
  tracking,
  onOpen,
  query,
  selectedId,
}: {
  groups: Record<Stage, TradeIdea[]>;
  tracking: Record<string, IdeaTracking>;
  onOpen: (i: TradeIdea) => void;
  query: string;
  selectedId: number | null;
}) {
  const { t } = ideasI18n.useT();
  const lanes = STAGES.filter((s) => s.key !== "rejected" || groups.rejected.length > 0);
  const [expanded, setExpanded] = useState<Partial<Record<Stage, boolean>>>({});
  // A card reached via J/K in the sheet unfolds its lane (and keeps it open), so focus can return to it on close.
  useEffect(() => {
    if (selectedId == null) return;
    for (const k of CLOSED_LANES) {
      if (!expanded[k] && groups[k].slice(CLOSED_PREVIEW).some((i) => i.id === selectedId)) setExpanded((e) => ({ ...e, [k]: true }));
    }
  }, [selectedId, groups, expanded]);
  // Empty lanes shrink so the lanes that hold cards get the width (cards stay readable at 1280–1440).
  const template = lanes.map((l) => (groups[l.key].length ? "minmax(0,1fr)" : "minmax(8.5rem,0.5fr)")).join(" ");
  return (
    <div
      className={cn(
        "flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2",
        lanes.length === 5 ? "xl:grid xl:overflow-visible" : "2xl:grid 2xl:overflow-visible",
      )}
      style={{ gridTemplateColumns: template }}
      role="list"
      aria-label={t("board.aria")}
    >
      {lanes.map((lane) => {
        const all = groups[lane.key];
        const capped = CLOSED_LANES.has(lane.key) && !expanded[lane.key] && all.length > CLOSED_PREVIEW + 2;
        const items = capped ? all.slice(0, CLOSED_PREVIEW) : all;
        return (
          <section
            key={lane.key}
            role="listitem"
            aria-label={t("board.laneAria", { stage: lane.label, count: all.length })}
            className={cn(
              "flex w-[80vw] max-w-[320px] shrink-0 snap-start flex-col gap-2 sm:w-[300px]",
              lanes.length === 5 ? "xl:w-auto xl:min-w-0 xl:max-w-none" : "2xl:w-auto 2xl:min-w-0 2xl:max-w-none",
            )}
          >
            <header className="flex min-h-6 items-center justify-between gap-2 px-1" title={lane.hint}>
              <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Pill tone={lane.tone} dot className="px-1.5"><span className="sr-only">{lane.label}</span></Pill>
                {lane.label}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">{all.length}</span>
            </header>
            <div className="flex flex-col gap-2">
              {items.map((idea) => (
                <IdeaCard
                  key={idea.id}
                  idea={idea}
                  stage={lane.key}
                  tracking={tracking[String(idea.id)]}
                  onOpen={onOpen}
                  query={query}
                  selected={selectedId === idea.id}
                />
              ))}
              {CLOSED_LANES.has(lane.key) && all.length > CLOSED_PREVIEW + 2 && (
                <button
                  type="button"
                  onClick={() => setExpanded((e) => ({ ...e, [lane.key]: !e[lane.key] }))}
                  aria-expanded={!capped}
                  className="chip inline-flex min-h-8 items-center justify-center gap-1.5 px-3 text-xs font-medium"
                >
                  {capped ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />}
                  {capped ? t("board.more", { count: all.length - CLOSED_PREVIEW }) : commonI18n.t("actions.collapse")}
                </button>
              )}
              {all.length === 0 && (
                <div className="rounded-xl border border-dashed border-[var(--field-border)] px-3 py-6 text-center text-xs text-muted-foreground">
                  {emptyCopy(lane.key)}
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
