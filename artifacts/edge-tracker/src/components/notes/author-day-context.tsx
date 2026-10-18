
import { Link } from "wouter";
import { ArrowUpRight, CandlestickChart, ClipboardList, Moon, CornerDownLeft } from "lucide-react";
import { Panel, Pill, toneOf, toneText, type Tone } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { horizonLabel, type DayContext, type DayTrade } from "./author-model";
import { notesI18n } from "@/i18n/ns/notes";
import { shellI18n } from "@/i18n/ns/shell";
import { fmtDate, fmtR, fmtUsd } from "@/lib/format";

const RESULT_TONE: Record<string, Tone> = { win: "up", loss: "down", breakeven: "neutral", open: "accent" };
type ResultKey = "win" | "loss" | "breakeven" | "open";
const isResult = (r: string): r is ResultKey => r in RESULT_TONE;

function TradeLine({ t, showSince }: { t: DayTrade; showSince?: boolean }) {
  const res = isResult(t.result)
    ? { label: notesI18n.t(`result.${t.result}`), tone: RESULT_TONE[t.result]! }
    : { label: t.result, tone: "neutral" as Tone };
  const money = t.pnlNet ?? null;
  return (
    <li>
      <Link
        href={`/trades?highlight=${t.id}`}
        className="group flex min-h-10 items-center gap-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="w-14 shrink-0 truncate text-sm font-semibold">{t.ticker}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {[t.side, t.horizon !== "intraday" ? horizonLabel(t.horizon).toLowerCase() : null, showSince ? notesI18n.t("author.day.since", { date: fmtDate(t.date, "dayMonth") }) : t.setup]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {showSince ? (
          <Pill tone={t.horizon === "swing" ? "purple" : "accent"}>{horizonLabel(t.horizon)}</Pill>
        ) : (
          <>
            {money != null ? (
              <span className={cn("text-sm font-medium tabular-nums", toneText(toneOf(money)))}>{fmtUsd(money, { signed: true, decimals: 0 })}</span>
            ) : (t.rSigned ?? t.rMultiple) != null ? (
              <span className={cn("text-sm font-medium tabular-nums", toneText(toneOf(t.rSigned ?? t.rMultiple)))}>{fmtR(t.rSigned ?? t.rMultiple, 1)}</span>
            ) : (
              <Pill tone={res.tone}>{res.label}</Pill>
            )}
          </>
        )}
        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
      </Link>
    </li>
  );
}

export function AuthorDayContext({
  date,
  data,
  loading,
  unavailable,
  canInsert,
  onInsertTrades,
  onInsertHeld,
}: {
  date: string;
  data: DayContext | undefined;
  loading: boolean;
  unavailable: boolean;
  canInsert: boolean;
  onInsertTrades: (trades: DayTrade[]) => void;
  onInsertHeld: (held: DayTrade[]) => void;
}) {
  const s = data?.summary;
  const { t } = notesI18n.useT();
  return (
    <Panel
      title={t("author.day.title")}
      description={fmtDate(date, "dayMonth")}
      icon={CandlestickChart}
      actions={
        <Button asChild variant="ghost" size="sm" className="gap-1">
          <Link href={`/game-plan?date=${date}`}>
            <ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />
            {shellI18n.t("nav.gamePlan")}
          </Link>
        </Button>
      }
    >
      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label={t("author.day.loading")}>
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-9 w-full rounded-xl" />
          <Skeleton className="h-9 w-full rounded-xl" />
        </div>
      ) : unavailable || !data ? (
        <p className="text-sm text-muted-foreground">
          {t("author.day.unavailable")}{" "}
          <Link href="/trades" className="text-primary hover:underline">{t("author.day.openTrades")}</Link>
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-[var(--glass-bg)] px-3 py-2">
              <div className="text-xs text-muted-foreground">{t("tradesCount")}</div>
              <div className="text-lg font-semibold tabular-nums">{s?.count ?? 0}</div>
            </div>
            <div className="rounded-xl bg-[var(--glass-bg)] px-3 py-2">
              <div className="text-xs text-muted-foreground">P&L net</div>
              <div className={cn("text-lg font-semibold tabular-nums", toneText(toneOf(s?.pnlNet)))}>{fmtUsd(s?.pnlNet, { signed: true, decimals: 0 })}</div>
            </div>
            <div className="rounded-xl bg-[var(--glass-bg)] px-3 py-2">
              <div className="text-xs text-muted-foreground">Σ R</div>
              <div className={cn("text-lg font-semibold tabular-nums", toneText(toneOf(s?.rSum)))}>{fmtR(s?.rSum, 1)}</div>
            </div>
          </div>

          {data.trades.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("author.day.noTrades")}</p>
          ) : (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="micro-label">{t("author.day.dayTrades", { wins: s?.wins ?? 0, losses: s?.losses ?? 0 })}</span>
                {canInsert && (
                  <Button variant="ghost" size="sm" className="gap-1" title={t("author.day.insertTitle")} onClick={() => onInsertTrades(data.trades)}>
                    <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
                    {t("author.day.insert")}
                  </Button>
                )}
              </div>
              <ul className="-mx-2 flex flex-col">
                {data.trades.slice(0, 12).map((t) => <TradeLine key={t.id} t={t} />)}
              </ul>
              {data.trades.length > 12 && (
                <span className="text-xs text-muted-foreground">{t("moreCount", { count: data.trades.length - 12 })}</span>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="micro-label inline-flex items-center gap-1.5">
                <Moon className="h-3 w-3" aria-hidden="true" />
                {t("author.day.held", { count: data.held.length })}
              </span>
              {canInsert && data.held.length > 0 && (
                <Button variant="ghost" size="sm" className="gap-1" onClick={() => onInsertHeld(data.held)}>
                  <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("author.day.insertPlan")}
                </Button>
              )}
            </div>
            {data.held.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("author.day.flat")}</p>
            ) : (
              <ul className="-mx-2 flex flex-col">
                {data.held.map((t) => <TradeLine key={t.id} t={t} showSince />)}
              </ul>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

/**
 * Lines inserted into the note from the day's trades. R only, never $: the note is read by the whole team and
 * traders must not see each other's money (same rule as lib/playbookPrivacy on the server).
 */
export function tradeLine(t: DayTrade): string {
  const parts = [t.ticker, t.side ?? undefined];
  const r = t.rSigned ?? (t.result === "open" ? null : t.rMultiple);
  const res = r != null ? fmtR(r, 1) : isResult(t.result) ? notesI18n.t(`resultLower.${t.result}`) : undefined;
  return `• ${parts.filter(Boolean).join(" ")}${t.setup ? ` (${t.setup})` : ""} — ${res ?? t.result}: `;
}

export function heldLine(t: DayTrade): string {
  return notesI18n.t("author.day.heldLine", {
    position: `${t.ticker}${t.side ? ` ${t.side}` : ""}`,
    horizon: horizonLabel(t.horizon).toLowerCase(),
    date: fmtDate(t.date, "dayMonth"),
  });
}
