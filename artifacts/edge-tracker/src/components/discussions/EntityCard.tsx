import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowUpRight, BookOpen, CalendarClock, Lightbulb, LineChart, Lock, NotebookPen } from "lucide-react";
import { Pill, toneOf, toneText } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { http } from "@/lib/api/http";
import { nullIfMissing } from "@/lib/api/errors";
import { STALE } from "@/lib/api/keys";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { fmtPct, fmtPrice, fmtR, fmtUsd } from "@/lib/format";
import type { Thread } from "./lib";
import { discussionsI18n } from "@/i18n/ns/discussions";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

/* `GET /api/discussions/:id/entity` — the thing a contextual thread is about.
 * Numbers come from the shared API math (net = gross − |fees|, signed R). */

type EntityTrade =
  | { id: number; restricted: true }
  | {
      id: number; ticker: string; date: string; exitDate: string | null; closeDate: string; side: string | null; setup: string | null;
      result: string | null; res: string | null; horizon: string | null; entry: number | null; exit: number | null; stop: number | null; qty: number | null;
      pnl: number | null; fees: number | null; netPnl: number | null; signedR: number | null; trader: string | null; source: string | null;
      brokerAccount: string | null; playbookId: number | null; restricted?: false;
    };
type EntityPayload = {
  id: number; tradeId: number | null; eventId: number | null; ideaId: number | null; playbookId: number | null; journalDate: string | null; ticker: string | null;
  trade?: EntityTrade | null;
  event?: { id: number; ticker: string; date: string; eventType: string; headline: string; reaction: string | null; percentMove: number | null; session: string | null } | null;
  idea?: { id: number; ticker: string; side: string | null; setup: string | null; status: string | null; trader: string | null; score: number | null; ideaDate: string | null } | null;
  playbook?: { id: number; name?: string } | null;
};

// Side arrives as a code ("long"/"short") or, from older rows, as Russian text: recognize both, show Long/Short.
const isShort = (side: string) => /short|шорт/i.test(side); // i18n-ignore (matches stored values)
const isLong = (side: string) => /long|лонг/i.test(side); // i18n-ignore (matches stored values)
function sideLabel(side: string): string {
  return isShort(side) ? commonI18n.t("trading.short") : isLong(side) ? commonI18n.t("trading.long") : side;
}

export function hasContext(t: Thread): boolean {
  return !!(t.tradeId || t.eventId || t.ideaId || t.playbookId || t.journalDate);
}

function Row({ icon: Icon, label, href, children }: { icon: React.ElementType; label: string; href: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-[var(--glass-bg)] px-3 py-2 text-xs">
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="micro-label">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">{children}</div>
      <Link href={href} className="inline-flex items-center gap-0.5 text-primary hover:underline">{discussionsI18n.t("entity.open")}<ArrowUpRight className="h-3 w-3" aria-hidden="true" /></Link>
    </div>
  );
}

export function EntityCard({ thread }: { thread: Thread }) {
  const { t: tr } = discussionsI18n.useT();
  const enabled = hasContext(thread);
  const q = useQuery({
    queryKey: ["discussion-entity", thread.id, thread.tradeId ?? 0, thread.eventId ?? 0, thread.ideaId ?? 0, thread.playbookId ?? 0, thread.journalDate ?? ""],
    queryFn: ({ signal }): Promise<EntityPayload | null> =>
      http.get<EntityPayload>(`/api/discussions/${thread.id}/entity`, { signal }).catch(nullIfMissing),
    enabled,
    staleTime: STALE.short,
    retry: false,
  });
  if (!enabled) return null;
  if (q.isLoading) return <Skeleton className="h-10 rounded-xl" />;
  const d = q.data;
  if (!d) return null;
  const t = d.trade;
  return (
    <div className="space-y-1.5" aria-label={tr("entity.aria")}>
      {t && ("restricted" in t && t.restricted ? (
        <div className="flex items-center gap-2 rounded-xl bg-[var(--glass-bg)] px-3 py-2 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5" aria-hidden="true" />{tr("entity.tradeRestricted", { id: t.id })}
        </div>
      ) : (
        <Row icon={LineChart} label={tr("entity.trade")} href={links.trade(t.id)}>
          <span className="font-semibold text-foreground">{t.ticker}</span>
          {t.side && <span className="text-muted-foreground">{sideLabel(t.side)}</span>}
          <span className="tabular-nums text-muted-foreground">{t.date}{t.exitDate && t.exitDate !== t.date ? ` → ${t.exitDate}` : ""}</span>
          {t.setup && <span className="truncate text-muted-foreground">{t.setup}</span>}
          {t.horizon && <Pill tone="neutral" className="py-0 text-2xs">{t.horizon}</Pill>}
          {t.trader && <span className="text-muted-foreground">{personName(t.trader)}</span>}
          {t.entry != null && <span className="tabular-nums text-muted-foreground">{tr("entity.entry", { price: fmtPrice(t.entry) })}{t.stop != null ? ` · ${tr("entity.stop", { price: fmtPrice(t.stop) })}` : ""}{t.exit != null ? ` · ${tr("entity.exit", { price: fmtPrice(t.exit) })}` : ""}</span>}
          {t.signedR != null && <span className={cn("font-semibold tabular-nums", toneText(toneOf(t.signedR)))}>{fmtR(t.signedR, 1)}</span>}
          {t.netPnl != null && <span className={cn("tabular-nums", toneText(toneOf(t.netPnl)))} title={tr("entity.netTitle", { gross: fmtUsd(t.pnl, { decimals: 0 }), fees: fmtUsd(t.fees, { decimals: 0 }) })}>{tr("entity.net", { value: fmtUsd(t.netPnl, { decimals: 0 }) })}</span>}
          <Pill tone={t.res === "win" ? "up" : t.res === "loss" ? "down" : "neutral"} className="py-0 text-2xs">{discussionsI18n.tryT(`entity.res.${t.res ?? "open"}`) ?? t.res}</Pill>
          {t.playbookId != null && <Link href={links.setup(t.playbookId)} className="text-primary hover:underline">{tr("entity.setupLink")}</Link>}
        </Row>
      ))}
      {d.event && (
        <Row icon={CalendarClock} label={tr("entity.event")} href={`/events?id=${d.event.id}`}>
          <span className="font-semibold text-foreground">{d.event.ticker}</span>
          <span className="tabular-nums text-muted-foreground">{d.event.date}{d.event.session ? ` ${d.event.session}` : ""}</span>
          <span className="truncate">{d.event.headline}</span>
          {d.event.percentMove != null && <span className={cn("tabular-nums", toneText(toneOf(d.event.percentMove)))}>{fmtPct(d.event.percentMove, 1)}</span>}
        </Row>
      )}
      {d.idea && (
        <Row icon={Lightbulb} label={tr("entity.idea")} href={links.idea(d.idea.id)}>
          <span className="font-semibold text-foreground">{d.idea.ticker}</span>
          {d.idea.side && <Pill tone={isShort(d.idea.side) ? "down" : "up"} className="py-0 text-2xs">{sideLabel(d.idea.side)}</Pill>}
          {d.idea.setup && <span className="truncate text-muted-foreground">{d.idea.setup}</span>}
          {d.idea.status && <span className="text-muted-foreground">{discussionsI18n.tryT(`ticker.ideaStatus.${d.idea.status}`) ?? d.idea.status}</span>}
          {d.idea.trader && <span className="text-muted-foreground">{personName(d.idea.trader)}</span>}
        </Row>
      )}
      {d.playbook && (
        <Row icon={BookOpen} label={tr("entity.setup")} href={links.setup(d.playbook.id)}>
          <span className="font-semibold text-foreground">{d.playbook.name ?? `#${d.playbook.id}`}</span>
        </Row>
      )}
      {d.journalDate && (
        <Row icon={NotebookPen} label={tr("entity.day")} href={links.journalDay(d.journalDate)}>
          <span className="tabular-nums text-foreground">{d.journalDate}</span>
          <Link href={links.trades({ from: d.journalDate, to: d.journalDate })} className="text-primary hover:underline">{tr("entity.dayTrades")}</Link>
        </Row>
      )}
    </div>
  );
}
