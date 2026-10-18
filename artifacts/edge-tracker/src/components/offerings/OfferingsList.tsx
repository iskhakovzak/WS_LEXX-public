import { memo, type ReactNode } from "react";
import { Link } from "wouter";
import { CalendarPlus, Check, ExternalLink, Lightbulb, Star } from "lucide-react";
import { DataTable, SortableTh, TermTooltip, type SortDir } from "@/components/ds";
import { links } from "@/lib/links";
import { safeHttpUrl } from "@/lib/url";
import { cn } from "@/lib/utils";
import { DealTypePill, ExposureBadge, ScoreBadge, SignedPct, pctTone } from "./bits";
import { advMultiple, dealTypeOf, dilutionScore, discountOf, hasWarrants, pctOfFloat } from "./score";
import {
  fmtDay, fmtM, fmtPctCap, pctOfMcap,
  type Exposure, type Offering,
} from "./types";
import { fmtCompact, fmtPrice } from "@/lib/format";
import { offeringsI18n } from "@/i18n/ns/offerings";

export type SortKey = "score" | "pct" | "size" | "discount" | "adv" | "delta" | "time" | "gap" | "ticker" | "price";
const SORT_KEYS: readonly SortKey[] = ["score", "pct", "size", "discount", "adv", "delta", "time", "gap", "ticker", "price"];
/** Sort key → column label in the UI language (getters: read at access time). */
export const SORT_LABEL = {} as Record<SortKey, string>;
for (const k of SORT_KEYS) Object.defineProperty(SORT_LABEL, k, { get: () => offeringsI18n.t(`list.sort.${k}`), enumerable: true });

export function sortValue(o: Offering, k: SortKey): number | string | null {
  switch (k) {
    case "score": return dilutionScore(o).score;
    case "pct": return pctOfMcap(o);
    case "size": return o.dealSizeM ?? o.shelfCapacityM ?? null;
    case "discount": { const d = discountOf(o); return d == null ? null : -d; }
    case "adv": return pctOfFloat(o) ?? advMultiple(o);
    case "delta": return o.priceChangePct;
    case "time": return o.acceptedAt ? Date.parse(o.acceptedAt.replace(" ", "T") + ":00Z") : null;
    case "gap": return o.reaction ? o.reaction.o2cPct : null;
    case "ticker": return o.ticker;
    case "price": return o.currentPrice ?? o.prevClose ?? o.offerPrice ?? null;
  }
}

function Hl({ text, q }: { text: string; q: string }): ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded bg-primary/25 px-0.5 text-foreground">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}


/** «07:02 · до рынка», plus «→ пн 19 окт» when the deal trades on a later session than the filing day. */
export function TimingCell({ o, day }: { o: Offering; day?: string }) {
  const { t } = offeringsI18n.useT();
  const hhmm = o.acceptedAt?.slice(11, 16) ?? null;
  const later = o.reactionDate && o.reactionDate !== (day ?? o.date) ? o.reactionDate : null;
  if (!hhmm && !later) return <span className="text-muted-foreground">{fmtDay(o.date)}</span>;
  return (
    <div className="leading-tight">
      <div className="tabular-nums text-foreground">{hhmm ?? fmtDay(o.date)}</div>
      <div className={cn("text-2xs", o.session === "post" ? "text-[hsl(var(--chart-3))]" : "text-muted-foreground")}>
        {later ? t("list.tradesOn", { date: fmtDay(later, { weekday: "short", day: "numeric" }) }) : o.session ? t(`list.session.${o.session}`) : ""}
      </div>
    </div>
  );
}

export type RowActionsProps = {
  o: Offering;
  watched: boolean;
  pending: boolean;
  onAddWatch: (o: Offering) => void;
  onAddPlan: (o: Offering) => void;
  planPending: boolean;
};

/** Quick actions: watchlist / plan / idea / SEC. Hover-reveal on pointer devices, always visible on touch. */
export function RowActions({ o, watched, pending, onAddWatch, onAddPlan, planPending }: RowActionsProps) {
  const { t } = offeringsI18n.useT();
  const sec = safeHttpUrl(o.filingUrl ?? null);
  const btn = "inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
  return (
    <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button type="button" className={cn(btn, watched && "text-primary")} disabled={watched || pending} onClick={() => onAddWatch(o)}
        aria-label={watched ? t("list.inWatchAria", { ticker: o.ticker }) : t("list.addWatchAria", { ticker: o.ticker })} title={watched ? t("list.inWatchTitle") : t("list.addWatchTitle")}>
        {watched ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Star className="h-3.5 w-3.5" aria-hidden="true" />}
      </button>
      <button type="button" className={btn} disabled={planPending} onClick={() => onAddPlan(o)} aria-label={t("list.addPlanAria", { ticker: o.ticker })} title={t("list.addPlanTitle")}>
        <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <Link href={links.newIdea(o.ticker)} className={btn} aria-label={t("list.ideaAria", { ticker: o.ticker })} title={t("list.ideaTitle")}>
        <Lightbulb className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
      {sec && (
        <a href={sec} target="_blank" rel="noreferrer noopener" className={btn} aria-label={t("list.secAria", { ticker: o.ticker })} title={t("list.secTitle")}>
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

export type ListVariant = "deals" | "overhang";

type ListProps = {
  items: Offering[];
  variant?: ListVariant;
  day?: string;
  exposure: Map<string, Exposure>;
  activeIndex: number;
  /** Row index offset (keyboard selection across two tables). */
  indexBase?: number;
  query: string;
  sort: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  onOpen: (o: Offering) => void;
  onHover: (i: number) => void;
  actions: Omit<RowActionsProps, "o" | "watched" | "pending"> & { pendingTicker: string | null };
};

const numCell = "text-right tabular-nums";

const Row = memo(function Row({
  o, i, active, variant, day, e, query, onOpen, onHover, actions,
}: {
  o: Offering; i: number; active: boolean; variant: ListVariant; day?: string; e: Exposure | undefined; query: string;
  onOpen: (o: Offering) => void; onHover: (i: number) => void; actions: ListProps["actions"];
}) {
  const { t } = offeringsI18n.useT();
  const s = dilutionScore(o);
  const pct = pctOfMcap(o);
  const disc = discountOf(o);
  const fl = pctOfFloat(o);
  const adv = advMultiple(o);
  const type = dealTypeOf(o);
  const price = o.currentPrice ?? o.prevClose ?? null;
  return (
    <tr
      data-row={i}
      onClick={() => onOpen(o)}
      onMouseEnter={() => onHover(i)}
      aria-selected={active}
      className={cn(
        "group cursor-pointer",
        active && "bg-[var(--glass-hover-bg)]",
        o.status === "withdrawn" && "opacity-70",
        e?.held.length ? "shadow-[inset_3px_0_0_hsl(var(--down))]" : e?.watched ? "shadow-[inset_3px_0_0_hsl(var(--primary))]" : "",
      )}
    >
      <td className="max-w-[11rem]">
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={(ev) => { ev.stopPropagation(); onOpen(o); }}
            className="rounded font-semibold text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("list.openAria", { ticker: o.ticker })}>
            <Hl text={o.ticker} q={query} />
          </button>
          <ExposureBadge e={e} compact />
        </div>
        <div className="truncate text-2xs text-muted-foreground" title={o.company}><Hl text={o.company} q={query} /></div>
      </td>
      <td>
        <div className="flex items-center gap-1">
          <DealTypePill o={o} />
          {hasWarrants(o) && type !== "shelf" && <span onClick={(ev) => ev.stopPropagation()}><TermTooltip term="warrants" className="text-2xs font-medium text-[hsl(var(--chart-3))]">W</TermTooltip></span>}
          {o.status === "withdrawn" && <span className="text-2xs text-muted-foreground">{t("list.withdrawn")}</span>}
        </div>
      </td>
      <td className="hidden lg:table-cell"><TimingCell o={o} day={day} /></td>
      <td className={numCell}>
        {variant === "overhang"
          ? <span title={t("list.capacityTitle")}>{o.babyShelf && o.babyShelfLimitM != null ? `≤${fmtM(o.babyShelfLimitM)}` : fmtM(o.shelfCapacityM ?? o.dealSizeM)}</span>
          : <span className="text-foreground">{fmtM(o.dealSizeM ?? (type === "atm" ? o.shelfCapacityM : null))}</span>}
      </td>
      <td className={numCell}>
        {pct != null ? (
          <span className={cn(pctTone(pct) === "down" ? "text-down" : pctTone(pct) === "warn" ? "text-[hsl(var(--chart-3))]" : "text-foreground")}
            title={pct > 1000 ? t("list.staleShares", { pct: pct.toFixed(0) }) : undefined}>
            {fmtPctCap(pct)}
          </span>
        ) : <span className="text-muted-foreground">—</span>}
      </td>
      {variant === "deals" && (
        <>
          <td className={cn(numCell, "hidden xl:table-cell")}>
            {fl != null ? <span title={t("list.floatTitle", { shares: fmtCompact(o.sharesOffered), pct: fl })}>{t("list.floatShort", { pct: fmtPctCap(fl, 0) })}</span>
              : adv != null ? <span title={t("list.advTitle", { shares: fmtCompact(o.sharesOffered), adv })}>{adv < 10 ? adv.toFixed(1) : Math.round(adv)}× ADV</span>
              : <span className="text-muted-foreground">—</span>}
          </td>
          <td className={numCell}>
            {disc != null ? <span className={disc <= -15 ? "text-down" : disc < 0 ? "text-foreground" : "text-up"}>{disc < 0 ? `−${Math.abs(disc).toFixed(1)}%` : `+${disc.toFixed(1)}%`}</span>
              : <span className="text-muted-foreground">{type === "atm" ? t("list.market") : "—"}</span>}
          </td>
        </>
      )}
      <td className={numCell}>
        <div className="leading-tight">
          <div className="text-foreground">{fmtPrice(price ?? o.offerPrice, { dollar: true })}</div>
          {o.offerPrice != null && price != null && <div className="text-2xs text-muted-foreground">{t("list.offerShort", { price: fmtPrice(o.offerPrice, { dollar: true }) })}</div>}
          {o.offerPrice == null && o.priceRange && <div className="text-2xs text-muted-foreground">${o.priceRange}</div>}
        </div>
      </td>
      {variant === "deals" && (
        <td className={cn(numCell, "hidden md:table-cell")}>
          {o.reaction ? (
            <div className="leading-tight" title={`${t("list.reactionTitle", { gap: o.reaction.gapPct, o2c: o.reaction.o2cPct, low: o.reaction.lowFromOpenPct })}${o.reaction.live ? t("list.reactionLive") : ""}`}>
              <div><SignedPct value={o.reaction.gapPct} /> <span className="text-2xs text-muted-foreground">{t("list.gap")}</span></div>
              <div className="text-2xs"><SignedPct value={o.reaction.o2cPct} /> <span className="text-muted-foreground">{o.reaction.live ? t("list.now") : t("list.o2c")}</span></div>
            </div>
          ) : <span className="text-muted-foreground">—</span>}
        </td>
      )}
      <td><ScoreBadge o={o} s={s} /></td>
      <td className="w-[7.5rem] !px-1">
        <div className={cn(
          "transition-opacity duration-[var(--dur-1)] motion-reduce:transition-none",
          !active && "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 group-focus-within:opacity-100",
        )}>
          <RowActions o={o} watched={!!e?.watched} pending={actions.pendingTicker === o.ticker} onAddWatch={actions.onAddWatch} onAddPlan={actions.onAddPlan} planPending={actions.planPending} />
        </div>
      </td>
    </tr>
  );
});

/**
 * Compact offerings table. Lives in a horizontal scroller with min-w-0 (never overlaps neighbours),
 * sticky header, ~44 px rows. Below md it becomes a card list.
 */
export function OfferingsList({
  items, variant = "deals", day, exposure, activeIndex, indexBase = 0, query, sort, sortDir, onSort, onOpen, onHover, actions,
}: ListProps) {
  const { t } = offeringsI18n.useT();
  const th = (k: SortKey, label: string, cls?: string) => (
    <SortableTh active={sort === k} dir={sortDir} onSort={() => onSort(k)} align="right" className={cls}>{label}</SortableTh>
  );
  return (
    <>
      <DataTable className="hidden md:block" ariaLabel={variant === "deals" ? t("list.dealsAria") : t("list.overhangAria")}>
        <table className="min-w-[720px] [&_td]:!px-2 [&_th]:!px-2">
          <thead>
            <tr>
              <SortableTh active={sort === "ticker"} dir={sortDir} onSort={() => onSort("ticker")}>{t("list.sort.ticker")}</SortableTh>
              <th scope="col">{t("list.type")}</th>
              <SortableTh active={sort === "time"} dir={sortDir} onSort={() => onSort("time")} className="hidden lg:table-cell">{t("list.sort.time")}</SortableTh>
              {th("size", variant === "overhang" ? t("list.capacity") : t("list.sort.size"))}
              {th("pct", t("list.sort.pct"))}
              {variant === "deals" && th("adv", t("list.sort.adv"), "hidden xl:table-cell")}
              {variant === "deals" && th("discount", t("list.sort.discount"))}
              {th("price", t("list.sort.price"))}
              {variant === "deals" && th("gap", t("list.sort.gap"), "hidden md:table-cell")}
              <SortableTh active={sort === "score"} dir={sortDir} onSort={() => onSort("score")}>{t("list.sort.score")}</SortableTh>
              <th scope="col"><span className="sr-only">{t("list.actions")}</span></th>
            </tr>
          </thead>
          <tbody>
            {items.map((o, i) => (
              <Row
                key={`${o.ticker}|${o.form ?? o.type}|${o.date}|${o.status}`}
                o={o} i={indexBase + i} active={indexBase + i === activeIndex} variant={variant} day={day}
                e={exposure.get(o.ticker.toUpperCase())} query={query} onOpen={onOpen} onHover={onHover} actions={actions}
              />
            ))}
          </tbody>
        </table>
      </DataTable>

      <ul className="flex flex-col gap-2 md:hidden">
        {items.map((o) => {
          const e = exposure.get(o.ticker.toUpperCase());
          const pct = pctOfMcap(o);
          const disc = discountOf(o);
          return (
            <li key={`${o.ticker}|${o.form ?? o.type}|${o.date}|${o.status}`}
              className={cn("rounded-xl bg-[var(--glass-bg)] p-3", e?.held.length ? "ring-1 ring-down/40" : e?.watched ? "ring-1 ring-primary/30" : "")}>
              <button type="button" onClick={() => onOpen(o)} className="flex w-full flex-col gap-2 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-foreground"><Hl text={o.ticker} q={query} /></span>
                  <DealTypePill o={o} />
                  <ExposureBadge e={e} compact />
                  <span className="ml-auto text-xs tabular-nums text-muted-foreground">{o.acceptedAt?.slice(11, 16) ?? fmtDay(o.date)}</span>
                </div>
                <div className="grid grid-cols-4 gap-2 text-xs tabular-nums">
                  <div><div className="text-muted-foreground">{t("list.sort.size")}</div><div className="text-foreground">{fmtM(o.dealSizeM ?? o.shelfCapacityM)}</div></div>
                  <div><div className="text-muted-foreground">{t("list.sort.pct")}</div><div className={pctTone(pct) === "down" ? "text-down" : "text-foreground"}>{fmtPctCap(pct, 0)}</div></div>
                  <div><div className="text-muted-foreground">{t("list.sort.discount")}</div><div className="text-foreground">{disc != null ? `${disc.toFixed(1)}%` : "—"}</div></div>
                  <div><div className="text-muted-foreground">{t("list.sort.score")}</div><div className="text-foreground">{dilutionScore(o).score}</div></div>
                </div>
              </button>
              <div className="mt-2 flex justify-end">
                <RowActions o={o} watched={!!e?.watched} pending={actions.pendingTicker === o.ticker} onAddWatch={actions.onAddWatch} onAddPlan={actions.onAddPlan} planPending={actions.planPending} />
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
