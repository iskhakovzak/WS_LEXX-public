/**
 * «Спроси журнал» answer card: big number + conclusion, KPI strip, mini chart, groups, every matching trade
 * (virtualised, click → trade card), «Открыть в Сделках» and «Почему такой ответ» with editable chips.
 */
import * as React from "react";
import { Link, useLocation } from "wouter";
import { ArrowRight, ChevronDown, HelpCircle, Pin, PinOff, X } from "lucide-react";
import { DataTable, EmptyState, Panel, Pill, SortableTh, VirtualRows, toneOf, toneText, useTableSort } from "@/components/ds";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { netPnl } from "@/lib/trade-math";
import { links } from "@/lib/links";
import { fmtClock, fmtDuration, type AskQuery, type AskToken } from "@/lib/ask/parse";
import { askHints, chipAlternatives, suggestFor } from "@/lib/ask/examples";
import { askI18n } from "@/i18n/ns/ask";
import { fmtCount, fmtRate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { dm, type Agg, type AskAnswer, type AskTrade, type BookIndex } from "@/lib/ask/aggregate";
import { AskChart } from "./AskChart";

import { personName } from "@/i18n";
// ── «Не понял» ────────────────────────────────────────────────────────────────

export function AskNotUnderstood({ query, tickers, onAsk }: { query: AskQuery; tickers: string[]; onAsk: (text: string) => void }) {
  const { t } = askI18n.useT();
  const suggestions = suggestFor(query.raw, query, tickers);
  return (
    <Panel>
      <EmptyState
        icon={HelpCircle}
        title={t("result.notUnderstood", { text: query.raw.trim() })}
        description={t("result.notUnderstoodHint")}
        action={
          <div className="flex max-w-2xl flex-col items-center gap-4">
            <div className="flex flex-wrap justify-center gap-2">
              {suggestions.map((s) => (
                <button key={s} type="button" className="chip min-h-8 px-3 text-sm" onClick={() => onAsk(s)}>{s}</button>
              ))}
            </div>
            <details className="w-full text-left">
              <summary className="cursor-pointer text-center text-xs text-muted-foreground hover:text-foreground">{t("result.whatIKnow")}</summary>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {askHints().map((h) => <li key={h}>• {h}</li>)}
              </ul>
            </details>
          </div>
        }
      />
    </Panel>
  );
}

// ── Editable chips («Почему такой ответ») ─────────────────────────────────────

function TokenChip({ token, alternatives, onReplace, onRemove }: {
  token: AskToken;
  alternatives: string[];
  onReplace: (key: string, text: string) => void;
  onRemove: (key: string) => void;
}) {
  const { t, tryT } = askI18n.useT();
  const [open, setOpen] = React.useState(false);
  const editable = alternatives.length > 0;
  const removable = token.start >= 0;
  const accent = token.kind === "intent" || token.kind === "compare" || token.kind === "group";
  return (
    <span className={cn(
      "inline-flex items-center rounded-full text-xs ring-1 ring-[var(--field-border)]",
      accent ? "bg-primary/10 text-foreground" : "bg-[var(--glass-bg)] text-foreground",
    )}>
      {editable ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="inline-flex min-h-7 items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1.5 hover:bg-[var(--glass-hover-bg)]" aria-label={t("result.edit", { label: token.label })}>
              {token.label}
              <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-60 p-1.5" onCloseAutoFocus={(e) => e.preventDefault()}>
            <p className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">{tryT(`result.chipKinds.${token.kind}`) ?? t("result.replaceWith")}</p>
            <ul className="max-h-64 overflow-y-auto">
              {alternatives.map((alt) => (
                <li key={alt}>
                  <button
                    type="button"
                    className="w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-[var(--glass-hover-bg)]"
                    onClick={() => { setOpen(false); onReplace(token.key, alt); }}
                  >
                    {alt}
                  </button>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      ) : (
        <span className="py-0.5 pl-2.5 pr-2">{token.label}</span>
      )}
      {removable && (
        <button
          type="button"
          aria-label={t("result.remove", { label: token.label })}
          onClick={() => onRemove(token.key)}
          className="mr-0.5 grid h-6 w-6 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground"
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

function WhyAnswer({ query, answer, defaultTrader, isStaff, tickers, setups, onReplace, onRemove, onAsk }: {
  query: AskQuery;
  answer: AskAnswer | null;
  defaultTrader: string | null;
  isStaff: boolean;
  tickers: string[];
  setups: string[];
  onReplace: (key: string, text: string) => void;
  onRemove: (key: string) => void;
  onAsk: (text: string) => void;
}) {
  const { t } = askI18n.useT();
  return (
    <div className="flex flex-col gap-2 border-t border-[var(--glass-border)] pt-4">
      <h3 className="text-xs font-medium text-muted-foreground">{t("result.why")}</h3>
      <div className="flex flex-wrap items-center gap-1.5" aria-label={t("result.howParsed")}>
        {query.tokens.map((t) => (
          <TokenChip key={t.key} token={t} alternatives={chipAlternatives(t.kind, { tickers, setups })} onReplace={onReplace} onRemove={onRemove} />
        ))}
        {defaultTrader && (
          <Pill title={t("result.defaultTraderHint")}>{t("result.trader", { name: personName(defaultTrader) })}</Pill>
        )}
        {defaultTrader && isStaff && (
          <button type="button" className="chip min-h-7 px-2.5 text-xs" onClick={() => onAsk(t("q.withDesk", { text: query.raw.trim() }))}>{t("result.addDesk")}</button>
        )}
      </div>
      <ul className="space-y-0.5 text-xs text-muted-foreground">
        {answer && !answer.empty && <li>{t("result.found", { trades: commonI18n.t("units.trades", { count: answer.matched }), total: fmtCount(answer.total) })}</li>}
        {query.corrections.length > 0 && (
          <li>{t("result.corrected", { list: query.corrections.map((c) => `«${c.from}» → «${c.to}»`).join(", ") })}</li>
        )}
        {query.unknown.length > 0 && <li>{t("result.skipped", { words: query.unknown.join(" ") })}</li>}
        <li>{t("result.method")}</li>
        {answer?.notes.map((n) => <li key={n}>{n}</li>)}
      </ul>
    </div>
  );
}

// ── Groups ────────────────────────────────────────────────────────────────────

type GroupKey = "order" | "label" | "n" | "wr" | "net" | "avg" | "fees";

function GroupTable({ groups, onAsk }: { groups: NonNullable<AskAnswer["groups"]>; onAsk: (text: string) => void }) {
  const { t } = askI18n.useT();
  const hl = new Set(groups.highlight ?? []);
  // Trader groups are keyed by the stored name; show it in the UI language.
  const labelOf = React.useCallback((r: Agg) => (groups.dim === "trader" ? personName(r.label) : r.label), [groups.dim]);
  // Default keeps the answer's own order (hours / weekdays read top-down); headers re-sort.
  const accessors = React.useMemo<Record<GroupKey, (r: Agg) => number | string | null>>(() => {
    const order = new Map(groups.rows.map((r, i) => [r.key, i]));
    return {
      order: (r) => order.get(r.key) ?? null,
      label: (r) => labelOf(r),
      n: (r) => r.n,
      wr: (r) => r.winRate,
      net: (r) => r.net,
      avg: (r) => r.avgNet,
      fees: (r) => r.fees,
    };
  }, [groups.rows, labelOf]);
  const { rows, thProps } = useTableSort(groups.rows, accessors, "order", "asc");
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">{groups.title}</h3>
      <DataTable maxHeight="60dvh" ariaLabel={groups.title}>
        <table>
          <thead>
            <tr>
              <SortableTh {...thProps("label")}>{groups.dim === "insight" ? t("result.colSlice") : t("result.colGroup")}</SortableTh>
              <SortableTh {...thProps("n")} align="right">{t("result.colTrades")}</SortableTh>
              <SortableTh {...thProps("wr")} align="right">{t("result.colWinRate")}</SortableTh>
              <SortableTh {...thProps("net")} align="right">{t("result.colNet")}</SortableTh>
              <SortableTh {...thProps("avg")} align="right">{t("result.colAvg")}</SortableTh>
              <SortableTh {...thProps("fees")} align="right">{t("result.colFees")}</SortableTh>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: Agg) => (
              <tr
                key={r.key}
                className={cn(r.ask && "cursor-pointer", hl.has(r.key) && "bg-primary/10")}
                onClick={r.ask ? () => onAsk(r.ask!) : undefined}
                title={r.ask ? t("result.askRow", { text: r.ask }) : undefined}
              >
                <td className="max-w-[260px] truncate font-medium" title={labelOf(r)}>{labelOf(r)}</td>
                <td className="text-right">{r.n}</td>
                <td className="text-right">{fmtRate(r.winRate)}</td>
                <td className={cn("text-right font-medium", toneText(toneOf(r.net)))}>{fmtUsd(r.net, { signed: true })}</td>
                <td className={cn("text-right", toneText(toneOf(r.avgNet)))}>{fmtUsd(r.avgNet, { signed: true })}</td>
                <td className="text-right text-muted-foreground">{fmtUsd(r.fees)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataTable>
      {groups.rows.some((r) => r.ask) && <p className="mt-1.5 text-xs text-muted-foreground">{t("result.rowHint")}</p>}
    </div>
  );
}

// ── Trades ────────────────────────────────────────────────────────────────────

type TradeKey = "order" | "date" | "time" | "ticker" | "trader" | "side" | "qty" | "entry" | "hold" | "net";

function TradeTable({ title, trades, index, showTrader }: { title: string; trades: AskTrade[]; index: BookIndex; showTrader: boolean }) {
  const { t } = askI18n.useT();
  const [, navigate] = useLocation();
  const cols = showTrader ? 9 : 8;
  // Default keeps the answer's order (e.g. «худшие сделки» come worst-first); headers re-sort.
  const accessors = React.useMemo<Record<TradeKey, (t: AskTrade) => number | string | null>>(() => {
    const order = new Map(trades.map((tr, i) => [tr.id, i]));
    return {
      order: (tr) => order.get(tr.id) ?? null,
      date: (tr) => { const m = index.get(tr.id); return `${m?.day ?? tr.date ?? ""} ${String(m?.min ?? 0).padStart(4, "0")}`; },
      time: (tr) => index.get(tr.id)?.min ?? null,
      ticker: (tr) => tr.ticker,
      trader: (tr) => (tr.trader ? personName(tr.trader) : null),
      side: (tr) => tr.side ?? null,
      qty: (tr) => index.get(tr.id)?.qty ?? null,
      entry: (tr) => (tr.entry == null ? null : Number(tr.entry)),
      hold: (tr) => index.get(tr.id)?.hold ?? null,
      net: (tr) => netPnl(tr),
    };
  }, [index, trades]);
  const { rows, thProps } = useTableSort(trades, accessors, "order", "asc");
  if (!trades.length) return null;
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">{title} · {commonI18n.t("units.trades", { count: trades.length })}</h3>
      <DataTable maxHeight="70dvh" ariaLabel={title}>
        <table>
          <thead>
            <tr>
              <SortableTh {...thProps("date")}>{t("result.colDate")}</SortableTh>
              <SortableTh {...thProps("time")}>{t("result.colEntryEt")}</SortableTh>
              <SortableTh {...thProps("ticker")}>{t("result.colTicker")}</SortableTh>
              {showTrader && <SortableTh {...thProps("trader")}>{t("result.colTrader")}</SortableTh>}
              <SortableTh {...thProps("side")}>{t("result.colSide")}</SortableTh>
              <SortableTh {...thProps("qty")} align="right">{t("result.colShares")}</SortableTh>
              <SortableTh {...thProps("entry")} align="right">{t("result.colEntry")}</SortableTh>
              <SortableTh {...thProps("hold")} align="right">{t("result.colHold")}</SortableTh>
              <SortableTh {...thProps("net")} align="right">{t("result.colNet")}</SortableTh>
            </tr>
          </thead>
          <VirtualRows
            rows={rows}
            colSpan={cols}
            getKey={(tr) => tr.id}
            renderRow={(tr) => {
              const m = index.get(tr.id);
              const n = netPnl(tr);
              const href = links.trade(tr.id);
              return (
                <tr
                  key={tr.id}
                  className="cursor-pointer"
                  onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) navigate(href); }}
                >
                  <td className="whitespace-nowrap">
                    <Link href={href} className="hover:underline" title={tr.date}>{dm(m?.day ?? tr.date)}</Link>
                  </td>
                  <td>{m?.min == null ? "—" : fmtClock(m.min)}</td>
                  <td className="font-medium">{tr.ticker}</td>
                  {showTrader && <td className="max-w-[140px] truncate text-muted-foreground" title={tr.trader ? personName(tr.trader) : undefined}>{tr.trader ? personName(tr.trader) : "—"}</td>}
                  <td>{tr.side === "Short" ? "Short" : tr.side === "Long" ? "Long" : "—"}</td>
                  <td className="text-right">{m?.qty == null ? "—" : fmtCount(m.qty)}</td>
                  <td className="text-right">{tr.entry == null ? "—" : `$${Number(tr.entry).toFixed(2)}`}</td>
                  <td className="text-right">{m?.hold == null ? "—" : fmtDuration(m.hold)}</td>
                  <td className={cn("text-right font-medium", toneText(toneOf(n)))}>{fmtUsd(n, { signed: true })}</td>
                </tr>
              );
            }}
          />
        </table>
      </DataTable>
    </div>
  );
}

// ── Answer card ───────────────────────────────────────────────────────────────

export interface AskResultProps {
  query: AskQuery;
  answer: AskAnswer;
  href: string;
  index: BookIndex;
  defaultTrader: string | null;
  isStaff: boolean;
  tickers: string[];
  setups: string[];
  pinned: boolean;
  onTogglePin: () => void;
  onAsk: (text: string) => void;
  onReplace: (key: string, text: string) => void;
  onRemove: (key: string) => void;
}

export function AskResult(p: AskResultProps) {
  const { t } = askI18n.useT();
  const { query, answer, href } = p;
  const showTrader = !answer.empty && new Set(answer.trades.map((t) => t.trader)).size > 1;
  const pinBtn = (
    <button
      type="button"
      onClick={p.onTogglePin}
      aria-pressed={p.pinned}
      title={p.pinned ? t("result.unpinTitle") : t("result.pinTitle")}
      className="chip inline-flex min-h-8 items-center gap-1.5 px-3 text-xs"
    >
      {p.pinned ? <PinOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Pin className="h-3.5 w-3.5" aria-hidden="true" />}
      {p.pinned ? t("result.unpin") : t("result.pin")}
    </button>
  );

  return (
    <Panel
      title={answer.subject}
      actions={
        <>
          {pinBtn}
          {!answer.empty && (
            <Link href={href} className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-primary-solid px-3.5 text-xs font-medium text-primary-foreground">
              {answer.linkLabel} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          )}
        </>
      }
      bodyClassName="flex flex-col gap-5"
      aria-live="polite"
    >
      {answer.empty ? (
        <EmptyState
          compact
          icon={HelpCircle}
          title={answer.headline}
          description={t("result.emptyHint")}
        />
      ) : (
        <>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:gap-8">
            <div className="min-w-0 shrink-0">
              <div className="text-xs text-muted-foreground">{answer.big.label}</div>
              <div className={cn("text-4xl font-semibold tabular-nums tracking-tight", toneText(toneOf(answer.big.tone)))}>{answer.big.value}</div>
              {answer.big.sub && <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">{answer.big.sub}</div>}
            </div>
            <p className="min-w-0 flex-1 text-base leading-relaxed text-foreground tabular-nums">{answer.headline}</p>
          </div>

          {answer.stats.length > 0 && (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 2xl:grid-cols-8">
              {answer.stats.map((s) => (
                <div key={s.label} className="min-w-0" title={s.hint}>
                  <dt className="truncate text-xs text-muted-foreground">{s.label}</dt>
                  <dd className={cn("truncate text-sm font-medium tabular-nums", s.tone != null ? toneText(toneOf(s.tone)) : "text-foreground")}>{s.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {(answer.chart || answer.groups) && (
            <div className={cn("grid min-w-0 gap-[var(--grid-gap)]", answer.chart && answer.groups && "2xl:grid-cols-2")}>
              {answer.chart && <AskChart chart={answer.chart} onBarClick={p.onAsk} />}
              {answer.groups && <GroupTable groups={answer.groups} onAsk={p.onAsk} />}
            </div>
          )}

          <TradeTable title={answer.tradesTitle} trades={answer.trades} index={p.index} showTrader={showTrader} />
        </>
      )}

      <WhyAnswer
        query={query}
        answer={answer}
        defaultTrader={p.defaultTrader}
        isStaff={p.isStaff}
        tickers={p.tickers}
        setups={p.setups}
        onReplace={p.onReplace}
        onRemove={p.onRemove}
        onAsk={p.onAsk}
      />
    </Panel>
  );
}

/** Same box as the answer card while the book loads (no layout jump). */
export function AskResultSkeleton() {
  return (
    <Panel aria-busy="true" bodyClassName="flex min-h-[520px] flex-col gap-5">
      <div className="skeleton h-5 w-64" />
      <div className="flex items-end gap-8">
        <div className="skeleton h-12 w-40" />
        <div className="skeleton h-5 flex-1" />
      </div>
      <div className="grid grid-cols-4 gap-6">{Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton h-9" />)}</div>
      <div className="skeleton h-[200px]" />
      <div className="skeleton h-40" />
    </Panel>
  );
}

