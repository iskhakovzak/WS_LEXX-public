// «Спроси журнал» start screen: a few ready answers computed from the book (click → full answer).
import * as React from "react";
import { ArrowRight, MessageSquareText } from "lucide-react";
import { EmptyState, Panel, toneOf, toneText } from "@/components/ds";
import { cn } from "@/lib/utils";
import { parseAsk, type ParseContext } from "@/lib/ask/parse";
import { runAsk, type AskBook } from "@/lib/ask/run";
import { askStarters } from "@/lib/ask/examples";
import { askI18n } from "@/i18n/ns/ask";

export function AskOverview({ book, ctx, me, onAsk }: { book: AskBook | null; ctx: ParseContext; me: string | null; onAsk: (text: string) => void }) {
  const { t, lang } = askI18n.useT();
  const cards = React.useMemo(() => {
    if (!book) return null;
    return askStarters().map((text) => {
      const q = parseAsk(text, ctx);
      const r = q.ok ? runAsk(q, book, { me }) : null;
      return r && !r.answer.empty ? { text, answer: r.answer } : null;
    }).filter((x): x is NonNullable<typeof x> => x != null);
    // `lang`: starters and answers are texts in the UI language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, ctx, me, lang]);

  if (!book) {
    return (
      <div className="grid min-h-[420px] gap-[var(--grid-gap)] md:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton h-[180px] rounded-2xl" />)}
      </div>
    );
  }
  if (!cards?.length) {
    return (
      <Panel>
        <EmptyState icon={MessageSquareText} title={t("overview.noTrades")} description={t("overview.noTradesHint")} />
      </Panel>
    );
  }
  return (
    <section aria-label={t("overview.aria")} className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-foreground">{t("overview.title")}</h2>
      <div className="grid gap-[var(--grid-gap)] md:grid-cols-2">
        {cards.map(({ text, answer }) => (
          <button
            key={text}
            type="button"
            onClick={() => onAsk(text)}
            className="glass-panel group flex min-h-[176px] flex-col gap-2 rounded-2xl p-[var(--panel-p)] text-left transition-colors duration-[var(--dur-1)] hover:bg-[var(--glass-hover-bg)]"
          >
            <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <span className="min-w-0 truncate" title={text}>«{text}»</span>
              <ArrowRight className="ml-auto h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity duration-[var(--dur-1)] group-hover:opacity-100" aria-hidden="true" />
            </span>
            <span className="text-xs text-muted-foreground">{answer.big.label}</span>
            <span className={cn("-mt-1 text-2xl font-semibold tabular-nums tracking-tight", toneText(toneOf(answer.big.tone)))}>{answer.big.value}</span>
            <span className="line-clamp-3 text-sm text-foreground/90 tabular-nums" title={answer.headline}>{answer.headline}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
