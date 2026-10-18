/**
 * Side panels of the chart workspace for analysis and replay: the live position, the fill log and the
 * «что сделал vs что было можно» summary. Another trader's trade (`redacted`) shows per-share moves and R only.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import type { Fill, PositionState, Side } from "../types";
import { fmtEtTime, formatDuration } from "../lib/time";
import { fmtCount, fmtPct, fmtPrice, fmtR, fmtUsd } from "@/lib/format";
import { KIND_LABEL, isOpening } from "../lib/position";
import { fmtPerShare, type TradeSummary } from "../lib/trade-summary";
import { chartI18n } from "@/i18n/ns/chart";
import { commonI18n } from "@/i18n/ns/common";

const tone = (n: number | null | undefined) => (n == null || !Number.isFinite(n) || Math.abs(n) < 1e-12 ? "text-foreground" : n > 0 ? "text-up" : "text-down");

export function AsideCard({ title, action, children, className }: { title: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-2 rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg)] p-3", className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children, title }: { label: React.ReactNode; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm" title={title}>
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right tabular-nums">{children}</span>
    </div>
  );
}

/** Live position at the replay cursor. Fixed rows, so the panel does not jump while it plays. */
export function PositionCard({ position, side, mark, risk, redacted, sinceEntry, entered }: {
  position: PositionState | null;
  side: Side;
  mark: number | null;
  risk: number | null;
  redacted: boolean;
  sinceEntry: number | null;
  /** Whether the cursor has reached the first entry. */
  entered: boolean;
}) {
  const { t } = chartI18n.useT();
  const dir = side === "short" ? -1 : 1;
  const open = !!position && position.avg != null;
  const perShare = open && mark != null ? dir * (mark - (position!.avg as number)) : null;
  const r = perShare != null && risk ? perShare / risk : null;
  const usd = !redacted && position ? position.total : null;
  const sideText = side === "short" ? commonI18n.t("trading.short") : commonI18n.t("trading.long");
  const status = !entered ? t("panels.waiting") : open ? (!redacted && position && position.qty > 0 ? t("panels.openQty", { side: sideText, qty: fmtCount(Math.round(position.qty)) }) : sideText) : t("panels.closed");
  return (
    <AsideCard title={t("panels.position")}>
      <div className="flex items-end justify-between gap-2">
        <span className="text-sm font-medium">{status}</span>
        <span className={cn("text-2xl font-semibold leading-none tabular-nums", open ? tone(perShare) : "text-muted-foreground")}>
          {open ? (r != null ? fmtR(r) : fmtPerShare(perShare)) : "—"}
        </span>
      </div>
      <Row label={t("panels.avg")}>{open ? fmtPrice(position!.avg) : "—"}</Row>
      <Row label={t("panels.perShare")}><span className={tone(perShare)}>{open ? fmtPerShare(perShare) : "—"}</span></Row>
      {!redacted && <Row label={t("panels.pnlUsd")} title={t("panels.pnlTitle")}><span className={tone(usd)}>{entered && usd != null ? fmtUsd(usd, { signed: true, decimals: "auto" }) : "—"}</span></Row>}
      <Row label={t("panels.inTrade")}>{sinceEntry != null && open ? formatDuration(sinceEntry) : "—"}</Row>
    </AsideCard>
  );
}

/** Fills up to the cursor; click jumps there. */
export function FillLog({ fills, cursor, redacted, onJump }: { fills: readonly Fill[]; cursor: number | null; redacted: boolean; onJump: (idx: number) => void }) {
  const { t } = chartI18n.useT();
  const shown = cursor == null ? fills : fills.filter((f) => f.idx <= cursor);
  const ahead = fills.length - shown.length;
  return (
    <AsideCard title={t("panels.fills", { shown: shown.length, total: fills.length })}>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{fills.length ? t("panels.noneYet") : t("panels.noFills")}</p>
      ) : (
        <ul className="flex flex-col">
          {shown.map((f) => (
            <li key={f.id}>
              <button type="button" onClick={() => onJump(f.idx)} className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-[var(--glass-hover-bg)]">
                <span className={cn("h-2.5 w-1 shrink-0 rounded-full", isOpening(f.kind) ? "bg-primary" : "bg-purple")} aria-hidden="true" />
                <span className="font-medium">{KIND_LABEL[f.kind]}</span>
                <span className="tabular-nums text-muted-foreground">{f.time != null ? fmtEtTime(f.time, true) : "—"}</span>
                <span className="ml-auto tabular-nums">{fmtPrice(f.price)}{!redacted && f.qty != null ? <span className="text-muted-foreground"> × {fmtCount(Math.round(f.qty))}</span> : null}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {ahead > 0 && cursor != null && <p className="text-xs text-muted-foreground">{t("panels.ahead", { count: ahead })}</p>}
    </AsideCard>
  );
}

/** «Что сделал vs что было можно». */
export function SummaryCard({ s, redacted, onJumpBest }: { s: TradeSummary; redacted: boolean; onJumpBest?: () => void }) {
  const { t } = chartI18n.useT();
  const headline = s.r != null ? fmtR(s.r) : fmtPerShare(s.perShare);
  const capturePct = s.capture != null ? Math.round(s.capture * 100) : null;
  return (
    <AsideCard title={t("panels.summary")}>
      <div className="flex items-end justify-between gap-2">
        <span className="text-sm text-muted-foreground">{s.side === "short" ? commonI18n.t("trading.short") : commonI18n.t("trading.long")} {fmtPrice(s.avgEntry)} → {fmtPrice(s.avgExit)}</span>
        <span className={cn("text-2xl font-semibold leading-none tabular-nums", tone(s.perShare))}>{headline}</span>
      </div>
      <Row label={t("panels.perShare")}><span className={tone(s.perShare)}>{fmtPerShare(s.perShare)}</span> <span className="text-muted-foreground">({fmtPct(s.pct)})</span></Row>
      {!redacted && s.pnlUsd != null && <Row label={t("panels.pnlUsd")}><span className={tone(s.pnlUsd)}>{fmtUsd(s.pnlUsd, { signed: true, decimals: "auto" })}</span></Row>}
      {s.holdSec != null && <Row label={t("panels.held")}>{formatDuration(s.holdSec)}</Row>}
      <div className="my-1 h-px bg-[var(--glass-border)]" />
      <p className="text-xs font-semibold text-muted-foreground">{t("panels.couldHave")}{s.approximate ? " (≈)" : ""}</p>
      <Row label={t("panels.mfe")} title={t("panels.mfeTitle")}><span className="text-up">{fmtPerShare(s.mfePerShare)}</span>{s.mfeR != null && <span className="text-muted-foreground"> · {fmtR(s.mfeR)}</span>}</Row>
      <Row label={t("panels.mae")} title={t("panels.maeTitle")}><span className="text-down">{s.maePerShare != null ? fmtPerShare(-s.maePerShare) : "—"}</span>{s.maeR != null && <span className="text-muted-foreground"> · {fmtR(-s.maeR)}</span>}</Row>
      {s.bestExitPrice != null && (
        <Row label={t("panels.bestExit")}>
          {(() => {
            const text = s.bestExitTime != null ? t("panels.atTime", { price: fmtPrice(s.bestExitPrice), time: fmtEtTime(s.bestExitTime) }) : fmtPrice(s.bestExitPrice);
            return onJumpBest ? <button type="button" className="underline decoration-dotted underline-offset-2 hover:text-primary" onClick={onJumpBest}>{text}</button> : <>{text}</>;
          })()}
        </Row>
      )}
      {capturePct != null && (
        <div className="flex flex-col gap-1" title={t("panels.captureTitle")}>
          <Row label={t("panels.capture")}><span className={tone(capturePct)}>{capturePct}%</span></Row>
          <div className="h-1.5 overflow-hidden rounded-full bg-[hsl(var(--muted-foreground)/0.18)]">
            <div className={cn("h-full rounded-full", capturePct >= 0 ? "bg-up" : "bg-down")} style={{ width: `${Math.max(2, Math.min(100, Math.abs(capturePct)))}%` }} />
          </div>
        </div>
      )}
      {s.leftPerShare != null && s.leftPerShare > 0 && <Row label={t("panels.leftOnTable")}>{fmtPerShare(s.leftPerShare).replace("+", "")}{s.r != null && s.mfeR != null ? <span className="text-muted-foreground"> · {(s.mfeR - s.r).toFixed(2)}R</span> : null}</Row>}
    </AsideCard>
  );
}
