import { Link } from "wouter";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, CalendarClock, Compass, Crosshair, Eye, ShieldAlert, ShieldX, Target, Zap } from "lucide-react";
import { Panel, Pill } from "@/components/ds";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { MediaGallery, TvQuickLink } from "./plan-media";
import {
  HORIZON,
  IMPACT,
  MARKET_BIAS,
  RISK_MODE,
  TICKER_BIAS,
  dateObj,
  type GamePlan,
  type InPlayItem,
  type LevelSet,
  type MacroItem,
} from "./types";
import { fmtDate, fmtPrice } from "@/lib/format";
import { gpI18n } from "@/i18n/ns/gamePlan";
import { personName } from "@/i18n";

export function longDate(date: string) {
  const s = fmtDate(dateObj(date), "full");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** «пт, 16 окт» — compact day label (lower case, no trailing dot). */
export function shortDay(date: string) {
  return fmtDate(dateObj(date), "weekdayDayMonth").replace(/\.$/, "");
}

/** The one rule of the day — shown first, above everything else. */
export function FocusBanner({ focus, className }: { focus?: string | null; className?: string }) {
  const { t } = gpI18n.useT();
  if (!focus?.trim()) return null;
  return (
    <div className={cn("flex items-start gap-2.5 rounded-xl border border-primary/30 bg-primary/10 px-3 py-2.5", className)}>
      <Compass className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-xs font-medium text-primary">{t("briefing.focus")}</p>
        <p className="whitespace-pre-wrap text-sm font-medium leading-snug">{focus}</p>
      </div>
    </div>
  );
}

/* ── Hero ───────────────────────────────────────────────────────────────────── */
export function PlanHero({ plan, readSlot }: { plan: GamePlan; readSlot?: React.ReactNode }) {
  const { t } = gpI18n.useT();
  const bias = MARKET_BIAS[plan.bias] ?? MARKET_BIAS.neutral;
  const risk = RISK_MODE[plan.riskMode] ?? RISK_MODE.normal;
  const edited = plan.updatedAt !== plan.createdAt && plan.updatedBy;
  return (
    <section className="glass-panel relative overflow-hidden rounded-2xl" aria-labelledby="gp-hero-title">
      {/* Bias-tinted wash in the corner — the one thing the trader should see first. */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full opacity-25 blur-3xl",
          plan.bias === "bull" && "bg-up",
          plan.bias === "bear" && "bg-down",
          plan.bias === "mixed" && "bg-[hsl(var(--chart-3))]",
          plan.bias === "neutral" && "bg-primary",
        )}
      />
      <div className="relative flex flex-col gap-5 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="micro-label">{t("briefing.premarket")}</p>
            <h2 id="gp-hero-title" className="mt-1 text-lg font-semibold tracking-tight sm:text-xl">
              {longDate(plan.date)}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {personName(plan.author)}
              {edited ? t("briefing.editedBy", { name: personName(plan.updatedBy), time: fmtDate(plan.updatedAt, "time") }) : t("briefing.publishedAt", { time: fmtDate(plan.createdAt, "time") })}
            </p>
          </div>
          {readSlot}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("briefing.market")}</span>
          <Pill tone={bias.tone} dot className="px-3 py-1 text-sm">
            {bias.label}
          </Pill>
          <span className="ml-2 text-xs text-muted-foreground">{t("briefing.risk")}</span>
          <Pill tone={risk.tone} className="px-3 py-1 text-sm">
            {risk.label}
          </Pill>
          <span className="hidden text-xs text-muted-foreground sm:inline">{risk.hint}</span>
        </div>

        <FocusBanner focus={plan.focus} />

        {plan.marketView ? (
          <p className="max-w-3xl whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">{plan.marketView}</p>
        ) : (
          <p className="text-sm text-muted-foreground">{t("briefing.noMarketView")}</p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <IndexLevels symbol="SPY" set={plan.keyLevels?.SPY} />
          <IndexLevels symbol="QQQ" set={plan.keyLevels?.QQQ} />
        </div>

        <MediaGallery media={plan.media} tvLinks={plan.tvLinks} />
      </div>
    </section>
  );
}

function IndexLevels({ symbol, set }: { symbol: string; set?: LevelSet }) {
  const { t } = gpI18n.useT();
  const res = [...(set?.resistance ?? [])].sort((a, b) => b - a);
  const sup = [...(set?.support ?? [])].sort((a, b) => b - a);
  const empty = res.length === 0 && sup.length === 0;
  return (
    <div className="rounded-xl border border-[var(--field-border)] bg-[var(--glass-bg)] p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{symbol}</span>
        <span className="text-xs text-muted-foreground">{t("briefing.keyLevels")}</span>
      </div>
      {empty ? (
        <p className="mt-2 text-xs text-muted-foreground">{t("briefing.noLevels")}</p>
      ) : (
        <ol className="mt-2 flex flex-col gap-1 text-sm tabular-nums" aria-label={t("briefing.levelsOf", { symbol })}>
          {res.map((v, i) => (
            <li key={`r${i}`} className="flex items-center justify-between rounded-lg px-2 py-0.5">
              <span className="text-xs text-muted-foreground">R{res.length - i}</span>
              <span className="font-medium text-down">{fmtPrice(v)}</span>
            </li>
          ))}
          {res.length > 0 && sup.length > 0 && <li aria-hidden="true" className="my-0.5 h-px bg-border" />}
          {sup.map((v, i) => (
            <li key={`s${i}`} className="flex items-center justify-between rounded-lg px-2 py-0.5">
              <span className="text-xs text-muted-foreground">S{i + 1}</span>
              <span className="font-medium text-up">{fmtPrice(v)}</span>
            </li>
          ))}
        </ol>
      )}
      {set?.note && <p className="mt-2 text-xs text-muted-foreground">{set.note}</p>}
    </div>
  );
}

/* ── Macro / events strip ──────────────────────────────────────────────────── */
export type DayEvent = { id: number; ticker: string; headline: string; eventType: string };

export function MacroStrip({ macro, events }: { macro: MacroItem[]; events: DayEvent[] }) {
  const { t } = gpI18n.useT();
  const items = [...macro].sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
  if (items.length === 0 && events.length === 0) return null;
  return (
    <Panel
      title={t("briefing.macroTitle")}
      icon={CalendarClock}
      description={t("briefing.macroDesc")}
      bodyClassName="pt-2 sm:pt-2"
    >
      <ul className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1" aria-label={t("briefing.macroAria")}>
        {items.map((m, i) => {
          const imp = IMPACT[m.impact] ?? IMPACT.medium;
          return (
            <li
              key={`m${i}`}
              className="flex min-w-[180px] max-w-[260px] shrink-0 snap-start flex-col gap-1 rounded-xl border border-[var(--field-border)] bg-[var(--glass-bg)] p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold tabular-nums">{m.time || "—"}</span>
                <Pill tone={imp.tone} dot>
                  {imp.label}
                </Pill>
              </div>
              <span className="text-sm leading-snug">{m.title}</span>
            </li>
          );
        })}
        {events.map((e) => (
          <li key={`e${e.id}`} className="shrink-0 snap-start">
            <Link
              href={`/events?ticker=${encodeURIComponent(e.ticker.split(/[,\s]+/)[0] ?? "")}`}
              className="lift flex h-full min-w-[180px] max-w-[260px] flex-col gap-1 rounded-xl border border-[var(--field-border)] bg-[var(--glass-bg)] p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold">{e.ticker}</span>
                <Pill tone="accent">{e.eventType}</Pill>
              </div>
              <span className="line-clamp-2 text-sm leading-snug text-muted-foreground">{e.headline}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/* ── In-play card ─────────────────────────────────────────────────────────── */
export function InPlayCard({ item, index }: { item: InPlayItem; index: number }) {
  const { t } = gpI18n.useT();
  const reduce = useReducedMotion();
  const bias = TICKER_BIAS[item.bias] ?? TICKER_BIAS.neutral;
  const hz = HORIZON[item.horizon] ?? HORIZON.intraday;
  const sup = [...(item.levels?.support ?? [])].sort((a, b) => b - a);
  const res = [...(item.levels?.resistance ?? [])].sort((a, b) => a - b);
  return (
    <motion.article
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: reduce ? 0 : Math.min(index, 8) * 0.03, ease: [0.2, 0.8, 0.2, 1] }}
      className="glass-panel flex min-w-0 flex-col gap-3 rounded-2xl p-4"
      aria-label={`${item.ticker} — ${bias.label}`}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold tracking-tight">{item.ticker}</h3>
        {item.grade && (
          <Pill tone="purple" className="font-semibold">
            {item.grade}
          </Pill>
        )}
        <Pill tone={bias.tone} dot>
          {bias.label}
        </Pill>
        <Pill tone={hz.tone}>{hz.label}</Pill>
      </header>

      {item.catalyst && (
        <p className="flex gap-2 text-sm">
          <Zap className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--chart-3))]" aria-hidden="true" />
          <span>{item.catalyst}</span>
        </p>
      )}

      {(sup.length > 0 || res.length > 0) && (
        <div className="grid grid-cols-2 gap-2 text-sm tabular-nums">
          <div className="rounded-xl bg-up/10 px-3 py-2">
            <div className="text-xs text-muted-foreground">{t("editor.support")}</div>
            <div className="mt-0.5 font-medium text-up">{sup.length ? sup.map((v) => fmtPrice(v)).join(" · ") : "—"}</div>
          </div>
          <div className="rounded-xl bg-down/10 px-3 py-2">
            <div className="text-xs text-muted-foreground">{t("editor.resistance")}</div>
            <div className="mt-0.5 font-medium text-down">{res.length ? res.map((v) => fmtPrice(v)).join(" · ") : "—"}</div>
          </div>
        </div>
      )}

      {(item.scenarioA || item.scenarioB) && (
        <div className="grid gap-2 text-sm">
          {item.scenarioA && <Scenario label="A" text={item.scenarioA} />}
          {item.scenarioB && <Scenario label="B" text={item.scenarioB} />}
        </div>
      )}

      {(item.trigger || item.invalidation) && (
        <dl className="grid gap-1.5 text-sm">
          {item.trigger && (
            <div className="flex gap-2">
              <dt className="flex shrink-0 items-center gap-1 text-muted-foreground">
                <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
                {t("briefing.trigger")}
              </dt>
              <dd className="min-w-0">{item.trigger}</dd>
            </div>
          )}
          {item.invalidation && (
            <div className="flex gap-2">
              <dt className="flex shrink-0 items-center gap-1 text-muted-foreground">
                <ShieldX className="h-3.5 w-3.5" aria-hidden="true" />
                {t("briefing.invalidIf")}
              </dt>
              <dd className="min-w-0">{item.invalidation}</dd>
            </div>
          )}
        </dl>
      )}

      {item.plan && (
        <div className="flex gap-2 text-sm">
          <Target className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <p className="whitespace-pre-wrap leading-relaxed">{item.plan}</p>
        </div>
      )}

      <MediaGallery media={item.media} tvLinks={item.tvLink ? [item.tvLink] : []} ticker={item.ticker} dense />

      {(item.risk_note || item.horizon !== "intraday") && (
        <div className="flex gap-2 rounded-xl bg-[hsl(var(--chart-3)/0.1)] px-3 py-2 text-sm">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--chart-3))]" aria-hidden="true" />
          <div className="min-w-0">
            {item.risk_note && <p className="whitespace-pre-wrap">{item.risk_note}</p>}
            {item.horizon !== "intraday" && <p className="text-xs text-muted-foreground">{hz.hint}</p>}
          </div>
        </div>
      )}

      <footer className="mt-auto flex flex-wrap gap-1.5 pt-1">
        {!item.tvLink && <TvQuickLink ticker={item.ticker} />}
        <QuickLink href={links.watchlist(item.ticker)} icon={Eye} label={t("briefing.watchlist")} />
        <QuickLink href={links.events(item.ticker)} icon={CalendarClock} label={t("briefing.events")} />
      </footer>
    </motion.article>
  );
}

function Scenario({ label, text }: { label: string; text: string }) {
  const { t } = gpI18n.useT();
  return (
    <div className="flex gap-2 rounded-xl border border-[var(--field-border)] px-3 py-2">
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-primary/12 text-xs font-semibold text-primary" aria-label={t("briefing.scenario", { label })}>
        {label}
      </span>
      <p className="min-w-0 whitespace-pre-wrap leading-relaxed">{text}</p>
    </div>
  );
}

function QuickLink({ href, icon: Icon, label }: { href: string; icon: typeof Eye; label: string }) {
  return (
    <Link
      href={href}
      className="chip inline-flex min-h-8 items-center gap-1.5 px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
      <ArrowUpRight className="h-3 w-3 opacity-70" aria-hidden="true" />
    </Link>
  );
}
