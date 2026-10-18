import * as React from "react";
import { useLocation } from "wouter";
import {
  AlertTriangle, ArrowRightLeft, ChevronDown, Link2, ChevronUp, ExternalLink, Flag, Hourglass, ImageIcon, Pencil, Radar, Send, ThumbsDown, ThumbsUp, Trash2,
} from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Pill, StatRow, toneOf } from "@/components/ds";
import { ScreenshotDisplay } from "@/components/screenshot-fields";
import { AddToPlaybookButton } from "@/components/add-to-playbook";
import { WriteOnly, useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { http } from "@/lib/api/http";
import { humanizeApiError } from "@/lib/api/errors";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { useIdeaMutations } from "./hooks";
import { Avatar, OutcomeChips } from "./IdeaCard";
import { LevelsBar } from "./LevelsBar";
import { CommentsThread } from "./CommentsThread";
import { ReviewActions, ReviewVerdict } from "./ReviewActions";
import {
  QUALITY_TONE, SIDE_TONE, STAGE_BY_KEY, ideaHorizon, horizonLabel, ideaPlan, linkedR, normalizeTradeResult, relTime, rrTone, scoreTone, sideLabel, splitTags,
  type IdeaTracking, type LevelPlan, type Stage, type TradeIdea,
} from "./model";
import { fmtDate, fmtNum, fmtPrice, fmtR, fmtUsd } from "@/lib/format";
import { ideasI18n } from "@/i18n/ns/ideas";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

const numOrNull = (v: string | number | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Idea → trade: the plan the idea promised vs. the fill the trade got.
 * Slippage is signed against the trader (positive = worse than planned), R is measured in the idea's own risk unit.
 */
function ConversionPanel({ idea, plan, onOpenTrade }: { idea: TradeIdea; plan: LevelPlan; onOpenTrade: (id: number) => void }) {
  const { t: tr } = ideasI18n.useT();
  const t = idea.linkedTrade;
  if (!t) return null;
  const sideRaw = (t.side ?? idea.side ?? "").toLowerCase();
  const dir = sideRaw.startsWith("short") || sideRaw === "sell" || sideRaw === "шорт" ? -1 : 1; // i18n-ignore (stored side value)
  const fillEntry = numOrNull(t.entry);
  const fillStop = numOrNull(t.stop);
  const fillExit = numOrNull(t.exit);
  const outcome = t.outcome ?? normalizeTradeResult(t.result);
  const isOpen = outcome === "open";
  // Entry slippage: for a long, paying more than planned is adverse; for a short, selling lower is adverse.
  const entrySlip = plan.entry != null && fillEntry != null ? (fillEntry - plan.entry) * dir : null;
  // Stop slippage: a wider stop than planned (further from entry) is adverse.
  const stopSlip = plan.stop != null && fillStop != null ? (plan.stop - fillStop) * dir : null;
  const planRisk = plan.riskPerShare;
  const rByIdea = planRisk != null && planRisk > 0 && fillEntry != null && fillExit != null && !isOpen ? ((fillExit - fillEntry) * dir) / planRisk : null;
  const rTrade = linkedR(t);
  const net = t.net != null && Number.isFinite(t.net) ? t.net : numOrNull(t.pnl);
  const slipPct = (slip: number | null) => (slip != null && plan.riskPerShare ? ` · ${fmtR(slip / plan.riskPerShare)}` : "");
  const slipTone = (slip: number | null) => (slip == null ? "neutral" : slip > 0 ? "down" : slip < 0 ? "up" : "neutral");
  const fmtSlip = (slip: number | null) => (slip == null ? "—" : `${slip > 0 ? "+" : slip < 0 ? "−" : ""}$${fmtPrice(Math.abs(slip))}${slipPct(slip)}`);

  return (
    <Section
      title={tr("sheet.conversionTitle")}
      action={
        <span className="flex items-center gap-1.5">
          {idea.tradeLinkSource && (
            <span title={idea.tradeLinkedAt ? tr("sheet.linkedAt", { date: fmtDate(idea.tradeLinkedAt, "dateTime") }) : undefined}>
              <Pill tone={idea.tradeLinkSource === "auto" ? "accent" : "neutral"}>
                <Link2 className="h-3 w-3" aria-hidden="true" />
                {idea.tradeLinkSource === "auto" ? tr("sheet.linkedAuto") : tr("sheet.linkedManual")}
              </Pill>
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={() => onOpenTrade(t.id)} className="h-7 gap-1 px-2 text-xs">
            <ExternalLink className="h-3 w-3" aria-hidden="true" /> {tr("tradeNo", { id: t.id })}
          </Button>
        </span>
      }
    >
      <OutcomeChips idea={idea} tracking={null} />
      <div className="mt-3 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        <StatRow label={tr("sheet.entryPlanFact")} value={`${plan.entry != null ? fmtPrice(plan.entry) : "—"} → ${fillEntry != null ? fmtPrice(fillEntry) : "—"}`} />
        <StatRow label={tr("sheet.entrySlip")} value={fmtSlip(entrySlip)} tone={slipTone(entrySlip)} />
        <StatRow label={tr("sheet.stopPlanFact")} value={`${plan.stop != null ? fmtPrice(plan.stop) : "—"} → ${fillStop != null ? fmtPrice(fillStop) : "—"}`} />
        <StatRow label={tr("sheet.stopWider")} value={fmtSlip(stopSlip)} tone={slipTone(stopSlip)} />
        {!isOpen && <StatRow label={tr("sheet.rByIdea")} value={rByIdea != null ? fmtR(rByIdea) : "—"} tone={toneOf(rByIdea)} />}
        {!isOpen && <StatRow label={tr("sheet.rByTrade")} value={rTrade != null ? fmtR(rTrade) : "—"} tone={toneOf(rTrade)} />}
        {!isOpen && <StatRow label={tr("sheet.netPnl")} value={net != null ? fmtUsd(net, { decimals: 0 }) : "—"} tone={toneOf(net)} />}
        {t.date && <StatRow label={tr("sheet.date")} value={`${t.date}${t.exitDate && t.exitDate !== t.date ? ` → ${t.exitDate}` : ""}`} />}
      </div>
      {entrySlip != null && planRisk != null && planRisk > 0 && Math.abs(entrySlip) / planRisk >= 0.25 && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-[hsl(var(--chart-3))]">
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
          {entrySlip > 0 ? tr("sheet.entryWorse") : tr("sheet.entryBetter")}
        </p>
      )}
    </Section>
  );
}

function Section({ title, children, className, action }: { title: string; children: React.ReactNode; className?: string; action?: React.ReactNode }) {
  return (
    <section className={cn("glass-panel rounded-2xl p-4", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="micro-label">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function ReportIdea({ idea, currentUser }: { idea: TradeIdea; currentUser: string }) {
  const { toast } = useToast();
  const { t } = ideasI18n.useT();
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const id = React.useId();

  async function submit() {
    if (!reason.trim()) return;
    setSubmitting(true);
    try {
      await http.post("/api/reports", { reporter: currentUser, targetType: "trade_idea", targetId: String(idea.id), reason: reason.trim() });
      toast({ title: ideasI18n.t("sheet.reportSent") });
      setReason(""); setOpen(false);
    } catch (e) {
      toast({ title: humanizeApiError(e, ideasI18n.t("sheet.reportFailed")), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground">
          <Flag className="h-3.5 w-3.5" aria-hidden="true" /> {t("sheet.report")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-2 rounded-2xl p-3">
        <label htmlFor={id} className="text-xs font-medium text-foreground">{t("sheet.reportLabel", { id: idea.id })}</label>
        <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder={t("sheet.reportPlaceholder")} autoFocus />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{commonI18n.t("actions.cancel")}</Button>
          <Button size="sm" variant="secondary" onClick={submit} disabled={submitting || !reason.trim()}>
            {submitting ? t("sending") : commonI18n.t("actions.send")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Reactions({ idea, me }: { idea: TradeIdea; me: string }) {
  const { react } = useIdeaMutations();
  const { t } = ideasI18n.useT();
  const mine = idea.reactions.find((r) => r.trader === me)?.reaction;
  const opts = [
    { key: "thumbs_up", label: t("reactions.thumbs_up"), icon: ThumbsUp, cls: "aria-pressed:bg-up/20 aria-pressed:text-up" },
    { key: "warning", label: t("reactions.warning"), icon: AlertTriangle, cls: "aria-pressed:bg-[hsl(var(--chart-3)/0.2)] aria-pressed:text-[hsl(var(--chart-3))]" },
    { key: "thumbs_down", label: t("reactions.thumbs_down"), icon: ThumbsDown, cls: "aria-pressed:bg-down/20 aria-pressed:text-down" },
  ] as const;
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-2" role="group" aria-label={t("sheet.reactionsAria")}>
        {opts.map((o) => {
          const who = idea.reactions.filter((r) => r.reaction === o.key);
          const Icon = o.icon;
          return (
            <button
              key={o.key}
              type="button"
              aria-pressed={mine === o.key}
              disabled={!me || react.isPending}
              onClick={() => react.mutate(mine === o.key ? { id: idea.id, remove: true } : { id: idea.id, reaction: o.key })}
              title={who.length ? who.map((r) => personName(r.trader)).join(", ") : o.label}
              className={cn("chip flex min-h-10 items-center justify-center gap-1.5 px-2 text-xs font-medium disabled:opacity-60", o.cls)}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{o.label}</span>
              <span className="tabular-nums">{who.length}</span>
            </button>
          );
        })}
      </div>
      {idea.reactions.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {idea.reactions.map((r, i) => (
            <span key={r.id}>
              {i > 0 && ", "}
              <span className={r.reaction === "thumbs_up" ? "text-up" : r.reaction === "thumbs_down" ? "text-down" : "text-[hsl(var(--chart-3))]"}>{personName(r.trader)}</span>
              {r.comment && <span> ({r.comment})</span>}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

export function IdeaDetailSheet({
  idea,
  stage,
  tracking,
  open,
  onOpenChange,
  onEdit,
  onDelete,
  onPrev,
  onNext,
  sameTickerCount = 0,
  onFilterTicker,
}: {
  idea: TradeIdea | null;
  stage: Stage | null;
  tracking?: IdeaTracking | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onEdit: (i: TradeIdea) => void;
  onDelete: (i: TradeIdea) => void;
  onPrev?: () => void;
  onNext?: () => void;
  sameTickerCount?: number;
  onFilterTicker?: (ticker: string) => void;
}) {
  const { user, isCurator, isAdmin, canEdit } = useAuth();
  const { t } = ideasI18n.useT();
  const { t: tc } = commonI18n.useT();
  const [, setLocation] = useLocation();
  const m = useIdeaMutations();
  const me = user?.traderName ?? "";
  const isReviewer = isCurator || isAdmin;

  // Opening an idea counts as reading its notifications.
  const markedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!open || !idea || !me || !(idea.unreadCount && idea.unreadCount > 0)) return;
    if (markedRef.current === idea.id) return;
    markedRef.current = idea.id;
    m.markRead.mutate(idea.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, idea?.id, idea?.unreadCount, me]);

  if (!idea || !stage) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-xl lg:max-w-2xl"><SheetTitle className="sr-only">{t("sheet.idea")}</SheetTitle></SheetContent>
      </Sheet>
    );
  }

  const plan = ideaPlan(idea);
  const st = STAGE_BY_KEY[stage];
  const isOwner = !!me && idea.trader === me;
  const canManage = canEdit && (isOwner || isReviewer || !idea.trader);
  const risk = idea.riskAmount != null && idea.riskAmount !== "" ? Number(idea.riskAmount) : null;
  const shares = risk && plan.riskPerShare ? Math.floor(risk / plan.riskPerShare) : null;
  const tags = splitTags(idea.tags);
  const showReview = isReviewer && idea.status !== "draft" && idea.status !== "converted";

  // Next best action for this viewer, shown on top.
  let nextAction: React.ReactNode = null;
  if (canManage && idea.status === "draft") {
    nextAction = (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/30 bg-primary/10 p-3">
        <p className="text-sm text-foreground">{t("sheet.draftAction")}</p>
        <Button size="sm" onClick={() => m.publish.mutate(idea.id)} disabled={m.publish.isPending} className="gap-1.5">
          <Send className="h-3.5 w-3.5" aria-hidden="true" /> {m.publish.isPending ? t("sheet.publishing") : t("sheet.publish")}
        </Button>
      </div>
    );
  } else if (canManage && (idea.review_status === "needs_work" || idea.review_status === "rejected") && idea.status !== "converted" && stage !== "won" && stage !== "lost") {
    nextAction = (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[hsl(var(--chart-3)/0.35)] bg-[hsl(var(--chart-3)/0.1)] p-3">
        <p className="text-sm text-foreground">
          {t(idea.review_status === "needs_work" ? "sheet.needsWorkAction" : "sheet.rejectedAction")}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => onEdit(idea)} className="gap-1.5"><Pencil className="h-3.5 w-3.5" aria-hidden="true" />{tc("actions.edit")}</Button>
          <Button size="sm" onClick={() => m.resubmit.mutate(idea.id)} disabled={m.resubmit.isPending} className="gap-1.5">
            <Send className="h-3.5 w-3.5" aria-hidden="true" />{m.resubmit.isPending ? t("sheet.resending") : t("sheet.toReview")}
          </Button>
        </div>
      </div>
    );
  } else if (canEdit && stage === "active" && idea.status !== "converted") {
    nextAction = (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/30 bg-primary/10 p-3">
        <p className="text-sm text-foreground">{t("sheet.activeAuto", { ticker: idea.ticker })}</p>
        <Button size="sm" variant="secondary" onClick={() => setLocation(links.trades({ ticker: idea.ticker }))} className="gap-1.5">
          <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" /> {t("tickerTrades", { ticker: idea.ticker })}
        </Button>
      </div>
    );
  }
  const horizon = ideaHorizon(idea);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl lg:max-w-2xl"
        // Opened programmatically, so Radix has no trigger to return focus to: hand it back to the idea's card
        // (the last one viewed after J/K), keeping the keyboard position on the board / list.
        onCloseAutoFocus={(e) => {
          const card = document.querySelector<HTMLElement>(`[data-idea-id="${idea.id}"]`);
          if (!card) return;
          e.preventDefault();
          card.focus({ preventScroll: true });
          card.scrollIntoView({ block: "nearest" });
        }}
      >
        {/* Header */}
        <div className="flex flex-col gap-2 border-b border-[var(--field-border)] px-5 pb-4 pt-5 pr-14">
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle className="text-2xl font-semibold tracking-tight">{idea.ticker}</SheetTitle>
            {idea.side && <Pill tone={SIDE_TONE(idea.side)}>{sideLabel(idea.side)}</Pill>}
            {idea.setupQuality && <Pill tone={QUALITY_TONE[idea.setupQuality] ?? "neutral"}>{idea.setupQuality}</Pill>}
            {horizon && <Pill tone="purple">{horizonLabel(horizon)}</Pill>}
            <Pill tone={st.tone} dot>{st.label}</Pill>
            {idea.validUntil && (
              <span title={idea.expired ? t("sheet.expiredTitle") : t("sheet.validTitle")}>
                <Pill tone={idea.expired ? "warn" : "neutral"}>
                  <Hourglass className="h-3 w-3" aria-hidden="true" />{idea.expired ? t("card.expired") : t("sheet.until", { date: fmtDate(idea.validUntil, "dayMonth") })}
                </Pill>
              </span>
            )}
          </div>
          <SheetDescription asChild>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <Avatar name={idea.trader} />
              <span className="text-foreground">{idea.trader ? personName(idea.trader) : t("sheet.noAuthor")}</span>
              <span>· {relTime(idea.publishedAt ?? idea.createdAt)}</span>
              {idea.setup && <span>· {idea.setup}</span>}
              {idea.longName && <span className="truncate">· {idea.longName}</span>}
            </div>
          </SheetDescription>
          <div className="flex flex-wrap items-center gap-2">
            {onPrev && <Button size="sm" variant="ghost" onClick={onPrev} aria-label={t("sheet.prevAria")} className="h-8 w-8 p-0"><ChevronUp className="h-4 w-4" /></Button>}
            {onNext && <Button size="sm" variant="ghost" onClick={onNext} aria-label={t("sheet.nextAria")} className="h-8 w-8 p-0"><ChevronDown className="h-4 w-4" /></Button>}
            {sameTickerCount > 1 && onFilterTicker && (
              <button type="button" onClick={() => onFilterTicker(idea.ticker)} className="chip min-h-7 px-2.5 text-xs">
                {t("sheet.allByTicker", { ticker: idea.ticker, count: sameTickerCount })}
              </button>
            )}
            {idea.playbookId && <Pill tone="purple">{t("sheet.fromPlaybook", { id: idea.playbookId })}</Pill>}
            {idea.watchlistId && <Pill tone="neutral">{t("sheet.fromWatchlist", { id: idea.watchlistId })}</Pill>}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {nextAction}

          {showReview && (
            <Section title={t("sheet.curatorDecision")}>
              <ReviewActions
                idea={idea}
                pending={m.review.isPending}
                onSubmit={(status, reason) => m.review.mutate({ id: idea.id, status, reason })}
              />
            </Section>
          )}
          <ReviewVerdict idea={idea} />

          <Section
            title={t("sheet.plan")}
            action={plan.rr != null ? <Pill tone={rrTone(plan.rr)}>R:R {fmtNum(plan.rr, 2)}</Pill> : undefined}
          >
            <LevelsBar plan={plan} price={tracking?.price} size="lg" className="mb-3" />
            <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
              <StatRow label={t("entry")} value={idea.entryZone || "—"} />
              <StatRow label={tc("trading.target")} value={idea.target || "—"} tone="up" />
              <StatRow label={tc("trading.stop")} value={idea.stop || "—"} tone="down" />
              <StatRow label={t("sheet.riskPerShare")} value={plan.riskPerShare != null ? `$${fmtPrice(plan.riskPerShare)}` : "—"} />
              {plan.rrFinal != null && plan.targets.length > 1 && <StatRow label={t("sheet.rrFinal")} value={fmtNum(plan.rrFinal, 2)} tone={rrTone(plan.rrFinal)} />}
              <StatRow label={t("sheet.riskUsd")} value={risk != null ? fmtUsd(risk, { decimals: "trim" }) : "—"} />
              {shares != null && <StatRow label={t("sheet.sizeByRisk")} value={t("sheet.shares", { count: shares })} />}
              <StatRow label="Score" value={idea.score ?? "—"} tone={idea.score != null ? scoreTone(idea.score) : "neutral"} />
            </div>
            {plan.issues.length > 0 && (
              <ul className="mt-2 space-y-1">
                {plan.issues.map((s) => (
                  <li key={s} className="flex items-center gap-1.5 text-xs text-[hsl(var(--chart-3))]">
                    <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />{s}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {tracking ? (
            <Section
              title={t("sheet.tracking")}
              action={<span className="flex items-center gap-1 text-2xs text-muted-foreground"><Radar className="h-3 w-3" aria-hidden="true" />{t("sheet.hourlySince", { date: fmtDate(tracking.since, "dayMonth") })}</span>}
            >
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div><div className="text-xs text-muted-foreground">{t("sheet.price")}</div><div className="text-lg font-semibold tabular-nums">{fmtPrice(tracking.price)}</div></div>
                <div><div className="text-xs text-muted-foreground">{t("sheet.now")}</div><div className={cn("text-lg font-semibold tabular-nums", toneOf(tracking.rNow) === "up" ? "text-up" : toneOf(tracking.rNow) === "down" ? "text-down" : "")}>{fmtR(tracking.rNow)}</div></div>
                {/* Excursions from the planned entry: a price that never went past entry shows 0R, not a wrong-signed number. */}
                <div><div className="text-xs text-muted-foreground">{t("sheet.maxUp")}</div><div className="text-lg font-semibold tabular-nums text-up">{fmtR(tracking.mfeR != null ? Math.max(0, tracking.mfeR) : null)}</div></div>
                <div><div className="text-xs text-muted-foreground">{t("sheet.maxDown")}</div><div className="text-lg font-semibold tabular-nums text-down">{fmtR(tracking.maeR != null ? Math.min(0, tracking.maeR) : null)}</div></div>
              </div>
              <div className="mt-3"><OutcomeChips idea={idea} tracking={tracking} /></div>
            </Section>
          ) : (
            idea.linkedTrade ? (
              <ConversionPanel idea={idea} plan={plan} onOpenTrade={(id) => setLocation(links.trade(id))} />
            ) : idea.status !== "draft" && plan.rr == null ? (
              <p className="rounded-xl border border-dashed border-[var(--field-border)] p-3 text-xs text-muted-foreground">
                {t("sheet.noLevels")}
              </p>
            ) : null
          )}

          {(idea.thesis || tags.length > 0) && (
            <Section title={t("sheet.thesis")}>
              {idea.thesis && <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{idea.thesis}</p>}
              {tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {tags.map((t) => <Pill key={t} tone="accent">{t}</Pill>)}
                </div>
              )}
            </Section>
          )}

          {idea.screenshotUrl && (
            <Section title={tc("fields.screenshots")} action={<ImageIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}>
              <ScreenshotDisplay urls={idea.screenshotUrl} />
            </Section>
          )}

          <Section title={t("sheet.teamOpinion")}>
            <Reactions idea={idea} me={me} />
          </Section>

          <CommentsThread idea={idea} currentUser={me} isReviewer={isReviewer} />
        </div>

        {/* Footer actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--field-border)] px-5 py-3">
          <WriteOnly>
            {idea.convertedTradeId ? (
              <Button size="sm" variant="secondary" onClick={() => setLocation(links.trade(idea.convertedTradeId!))} className="gap-1.5">
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /> {t("tradeNo", { id: idea.convertedTradeId })}
              </Button>
            ) : stage !== "active" && (
              <Button size="sm" variant="secondary" onClick={() => setLocation(links.trades({ ticker: idea.ticker }))} className="gap-1.5">
                <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" /> {t("tickerTrades", { ticker: idea.ticker })}
              </Button>
            )}
            <AddToPlaybookButton payload={{
              name: `${idea.ticker}${idea.setup ? ` — ${idea.setup}` : ""}`,
              setupType: idea.setup ?? undefined,
              notes: idea.thesis ?? undefined,
              screenshotUrl: idea.screenshotUrl ?? undefined,
              tags: idea.tags ?? undefined,
              sourceType: "trade_idea",
              sourceId: idea.id,
            }} />
            {canManage && (
              <Button size="sm" variant="ghost" onClick={() => onEdit(idea)} className="gap-1.5">
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> {tc("actions.edit")}
              </Button>
            )}
          </WriteOnly>
          <div className="ml-auto flex items-center gap-1">
            {me && <ReportIdea idea={idea} currentUser={me} />}
            {canManage && (
              <Button size="sm" variant="ghost" onClick={() => onDelete(idea)} aria-label={t("sheet.deleteIdea")} className="h-8 w-8 p-0 text-down hover:bg-down/15">
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
