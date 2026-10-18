// «Спроси журнал» side column: pinned questions, recent questions, grouped examples (3 groups open, the rest folded).
import { ChevronDown, History, Pin, Sparkles, X } from "lucide-react";
import { Panel } from "@/components/ds";
import { cn } from "@/lib/utils";
import { askExampleGroups, type AskExampleGroup } from "@/lib/ask/examples";
import { askI18n } from "@/i18n/ns/ask";
import type { AskMemory } from "./use-ask-memory";

/** Example groups shown open; the rest sit under «Ещё примеры» (choice overload). */
const OPEN_GROUPS = 3;

function QuestionRow({ text, active, onAsk, onRemove, removeLabel }: { text: string; active: boolean; onAsk: () => void; onRemove?: () => void; removeLabel?: string }) {
  return (
    <li className="group flex items-center gap-1">
      <button
        type="button"
        onClick={onAsk}
        className={cn(
          "min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-[var(--dur-1)] hover:bg-[var(--glass-hover-bg)]",
          active ? "bg-primary/10 text-foreground" : "text-foreground/90",
        )}
        title={text}
        aria-current={active || undefined}
      >
        {text}
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground opacity-0 transition-opacity duration-[var(--dur-1)] hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

function ExampleGroup({ g, isCur, onAsk }: { g: AskExampleGroup; isCur: (t: string) => boolean; onAsk: (text: string) => void }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-medium text-muted-foreground">{g.title}</h3>
      <ul className="-mx-1 flex flex-col">
        {g.items.map((q) => <QuestionRow key={q} text={q} active={isCur(q)} onAsk={() => onAsk(q)} />)}
      </ul>
    </div>
  );
}

export function AskSidebar({ memory, current, onAsk }: { memory: AskMemory; current: string; onAsk: (text: string) => void }) {
  const { t } = askI18n.useT();
  const cur = current.trim().toLowerCase();
  const isCur = (q: string) => q.trim().toLowerCase() === cur;
  const groups = askExampleGroups();
  const folded = groups.slice(OPEN_GROUPS);
  return (
    <div className="flex min-w-0 flex-col gap-[var(--page-gap)]">
      {memory.pinned.length > 0 && (
        <Panel title={t("sidebar.pinned")} icon={Pin}>
          <ul className="-mx-1 flex flex-col">
            {memory.pinned.map((q) => (
              <QuestionRow key={q} text={q} active={isCur(q)} onAsk={() => onAsk(q)} onRemove={() => memory.togglePin(q)} removeLabel={t("sidebar.unpin", { text: q })} />
            ))}
          </ul>
        </Panel>
      )}
      {memory.history.length > 0 && (
        <Panel
          title={t("sidebar.recent")}
          icon={History}
          actions={<button type="button" onClick={memory.clearHistory} className="text-xs text-muted-foreground hover:text-foreground">{t("sidebar.clear")}</button>}
        >
          <ul className="-mx-1 flex flex-col">
            {memory.history.slice(0, 10).map((q) => (
              <QuestionRow key={q} text={q} active={isCur(q)} onAsk={() => onAsk(q)} onRemove={() => memory.forget(q)} removeLabel={t("sidebar.forget", { text: q })} />
            ))}
          </ul>
        </Panel>
      )}
      <Panel title={t("sidebar.examples")} icon={Sparkles} bodyClassName="flex flex-col gap-4">
        {groups.slice(0, OPEN_GROUPS).map((g) => <ExampleGroup key={g.id} g={g} isCur={isCur} onAsk={onAsk} />)}
        {folded.length > 0 && (
          <details className="group/more" open={folded.some((g) => g.items.some(isCur)) || undefined}>
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              {t("sidebar.more")}
              <ChevronDown className="h-3.5 w-3.5 transition-transform duration-[var(--dur-1)] group-open/more:rotate-180" aria-hidden="true" />
            </summary>
            <div className="mt-3 flex flex-col gap-4">
              {folded.map((g) => <ExampleGroup key={g.id} g={g} isCur={isCur} onAsk={onAsk} />)}
            </div>
          </details>
        )}
      </Panel>
    </div>
  );
}
