/**
 * «Спроси журнал» — questions about the trade book in plain Russian, English or Uzbek, parsed deterministically (no AI).
 * Route /ask?q=<phrase> (the command palette can deep-link here). The book is loaded once per scope and every
 * question runs on the client: the viewer's own trades by default; staff load the whole desk only when the question
 * needs it («весь деск», another trader's name, «по трейдерам») — lib/ask/run askBookScope.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { MessageSquareText } from "lucide-react";
import { ErrorState, Page, PageHeader, Panel } from "@/components/ds";
import { useAuth } from "@/contexts/auth-context";
import { nyDate } from "@/lib/trading-date";
import { parseAsk, removeToken, replaceToken, type ParseContext } from "@/lib/ask/parse";
import { askBookKey, askBookScope, fetchAskBook, runAsk, type AskBook, type AskLoadProgress } from "@/lib/ask/run";
import { dmy } from "@/lib/ask/aggregate";
import { commonI18n } from "@/i18n/ns/common";
import { askI18n } from "@/i18n/ns/ask";
import { AskBar } from "@/components/ask/AskBar";
import { AskNotUnderstood, AskResult, AskResultSkeleton } from "@/components/ask/AskResult";
import { AskSidebar } from "@/components/ask/AskSidebar";
import { AskOverview } from "@/components/ask/AskOverview";
import { useAskMemory } from "@/components/ask/use-ask-memory";

function readQ(search: string): string {
  try {
    return new URLSearchParams(search).get("q")?.trim() ?? "";
  } catch {
    return "";
  }
}

export default function AskPage() {
  const { t } = askI18n.useT();
  const search = useSearch();
  const [, navigate] = useLocation();
  const { user, dbUsers, isCurator, isAdmin } = useAuth();
  const isStaff = isCurator || isAdmin;
  const me = user?.role !== "guest" ? user?.traderName ?? null : null;
  const memory = useAskMemory();

  const submitted = readQ(search);
  const [input, setInput] = useState(submitted);
  useEffect(() => { setInput(submitted); }, [submitted]);

  // Own book first (fast); the desk book only when a staff question needs it. Both cached for 5 min.
  const [progress, setProgress] = useState<Record<string, AskLoadProgress | undefined>>({});
  const mine = useQuery<AskBook>({
    queryKey: askBookKey("mine"),
    queryFn: ({ signal }) => fetchAskBook("mine", { me, signal, onProgress: (p) => setProgress((s) => ({ ...s, mine: p })) }),
    staleTime: 5 * 60_000,
    enabled: !(isStaff && !me),
  });
  const ownEmpty = mine.data ? mine.data.trades.length === 0 : false;

  const today = nyDate();
  const [deskWanted, setDeskWanted] = useState(false);
  const desk = useQuery<AskBook>({
    queryKey: askBookKey("desk"),
    queryFn: ({ signal }) => fetchAskBook("desk", { me, signal, onProgress: (p) => setProgress((s) => ({ ...s, desk: p })) }),
    staleTime: 5 * 60_000,
    enabled: isStaff && deskWanted,
  });
  // Parsing and suggestions need the known tickers / setups: the widest book already loaded.
  const parseBook = desk.data ?? mine.data;

  const traderNames = useMemo(() => {
    const fromBook = parseBook?.traders.map((t) => t.value) ?? [];
    return [...new Set([...fromBook, ...dbUsers.map((u) => u.name).filter(Boolean)])];
  }, [parseBook, dbUsers]);
  const tickerNames = useMemo(() => parseBook?.tickers.map((t) => t.value) ?? [], [parseBook]);
  const setupNames = useMemo(() => parseBook?.setups.map((t) => t.value) ?? [], [parseBook]);
  const ctx = useMemo<ParseContext>(
    () => ({ today, traders: isStaff ? traderNames : [], tickers: tickerNames, setups: setupNames }),
    [today, isStaff, traderNames, tickerNames, setupNames],
  );

  const query = useMemo(() => (submitted ? parseAsk(submitted, ctx) : null), [submitted, ctx]);
  const scope = askBookScope(query, { me, isStaff, ownEmpty });
  useEffect(() => { if (scope === "desk") setDeskWanted(true); }, [scope]);
  const book = scope === "desk" ? desk : mine;
  const result = useMemo(() => (query?.ok && book.data ? runAsk(query, book.data, { me }) : null), [query, book.data, me]);

  const ask = (text: string) => {
    const t = text.trim();
    if (!t) return;
    memory.remember(t);
    setInput(t);
    navigate(`/ask?q=${encodeURIComponent(t)}`);
    document.getElementById("main-content")?.scrollTo({ top: 0 });
  };
  const onRemove = (key: string) => {
    if (!query) return;
    const text = removeToken(query, key, ctx).raw.trim();
    if (!text) { setInput(""); navigate("/ask"); return; }
    ask(text);
  };
  const onReplace = (key: string, text: string) => {
    if (query) ask(replaceToken(query, key, text));
  };

  const prog = progress[scope];
  const loadingText = prog
    ? prog.total ? ` ${Math.min(99, Math.round((prog.loaded / prog.total) * 100))}%` : prog.loaded > 1e5 ? ` ${t("page.mb", { n: (prog.loaded / 1e6).toFixed(1) })}` : ""
    : "";
  const meta = book.data ? (
    <span className="tabular-nums">
      {isStaff ? (scope === "desk" ? t("page.scopeDesk") : t("page.scopeMine")) : ""}{t("page.inJournal", { trades: commonI18n.t("units.trades", { count: book.data.trades.length }) })}
      {book.data.firstDate && book.data.lastDate ? ` · ${dmy(book.data.firstDate)} — ${dmy(book.data.lastDate)}` : ""}
      {book.data.truncated ? t("page.partial") : ""}
    </span>
  ) : book.isLoading || (scope === "desk" && !desk.data && !desk.isError) ? (
    <span className="tabular-nums" role="status">{scope === "desk" ? t("page.loadingDesk") : t("page.loading")}{loadingText}</span>
  ) : null;

  return (
    <Page>
      <PageHeader
        title={t("page.title")}
        icon={MessageSquareText}
        description={t("page.description")}
        meta={meta}
      />

      <div className="grid min-w-0 items-start gap-[var(--page-gap)] xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-[var(--page-gap)]">
          <Panel>
            <AskBar
              value={input}
              onChange={setInput}
              onSubmit={ask}
              ctx={ctx}
              tickers={parseBook?.tickers}
              setups={parseBook?.setups}
              history={memory.history}
              pinned={memory.pinned}
              autoFocus={!submitted}
            />
          </Panel>

          {book.isError ? (
            <ErrorState title={t("page.loadError")} error={book.error} onRetry={() => book.refetch()} />
          ) : query && !query.ok ? (
            <AskNotUnderstood query={query} tickers={tickerNames} onAsk={ask} />
          ) : query && !result ? (
            <AskResultSkeleton />
          ) : query && result ? (
            <AskResult
              query={query}
              answer={result.answer}
              href={result.href}
              index={book.data!.index}
              defaultTrader={result.defaultTrader}
              isStaff={isStaff}
              tickers={tickerNames}
              setups={setupNames}
              pinned={memory.isPinned(query.raw)}
              onTogglePin={() => memory.togglePin(query.raw)}
              onAsk={ask}
              onReplace={onReplace}
              onRemove={onRemove}
            />
          ) : (
            <AskOverview book={book.data ?? null} ctx={ctx} me={me} onAsk={ask} />
          )}
        </div>

        <AskSidebar memory={memory} current={submitted} onAsk={ask} />
      </div>
    </Page>
  );
}
