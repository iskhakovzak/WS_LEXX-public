import { Link } from "wouter";
import { Check, ChevronRight, Minus, ShieldCheck, X } from "lucide-react";
import { Pill, toneText } from "@/components/ds";
import { mistakeRule } from "@/components/shared/mistake-labels";
import type { ContractVerdict } from "@/lib/daily/types";
import { links } from "@/lib/links";
import { fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { dailyI18n } from "@/i18n/ns/daily";
import { contractOverall, fmtDelta, statusTone, type ContractLine as Line, type ContractStatus } from "./daily-model";
import { dayShort } from "./focus-line";

export function StatusIcon({ status, className }: { status: ContractStatus; className?: string }) {
  const Icon = status === "kept" ? Check : status === "broken" ? X : Minus;
  return <Icon className={cn("h-3.5 w-3.5 shrink-0", toneText(statusTone(status)), className)} aria-hidden="true" />;
}

/** «16 окт: контракт соблюдён · дисциплина +3» — yesterday's verdict, one pill. */
export function VerdictPill({ verdict }: { verdict: ContractVerdict }) {
  const { t } = dailyI18n.useT();
  const overall = contractOverall(verdict);
  if (overall === "unset") return null;
  const word = overall === "kept" ? t("contract.kept") : overall === "broken" ? t("contract.broken") : t(`status.${overall}`);
  return (
    <Pill tone={statusTone(overall)} title={t("contract.disciplineTitle")}>
      <StatusIcon status={overall} className="text-current" />
      {t("contract.yesterday", { date: dayShort(verdict.date) })} {word}
      {verdict.disciplineDelta !== 0 && <span className="opacity-80">· {t("contract.discipline", { delta: fmtDelta(verdict.disciplineDelta) })}</span>}
    </Pill>
  );
}

/**
 * Today's own contract as the trader wrote it in the personal plan (daily stop · max trades · rule of the day), with
 * the rule prefilled from the focus until the trader picks another one. Unset → one link into the plan.
 */
export function ContractLine({ line, date, intraday, yesterday }: { line: Line; date: string; intraday: boolean; yesterday?: ContractVerdict | null }) {
  const { t } = dailyI18n.useT();
  const parts = [
    line.maxLossUsd != null ? t("contract.stop", { amount: fmtUsd(line.maxLossUsd, { decimals: 0 }) }) : null,
    line.maxTrades != null ? t("contract.maxTrades", { count: line.maxTrades }) : null,
  ].filter(Boolean);
  const onlyPrefill = line.maxLossUsd == null && line.maxTrades == null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-sm" title={intraday ? t("contract.intradayOn") : t("contract.intradayOff")}>
      <ShieldCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <span className="font-medium">{t("contract.title")}</span>
      {line.empty ? (
        <span className="text-muted-foreground">{t("contract.unset")}</span>
      ) : (
        <span className="min-w-0 tabular-nums [overflow-wrap:anywhere]">
          {parts.join(" · ")}
          {line.rule && (
            <>
              {parts.length > 0 ? " · " : ""}
              {t("contract.rule", { rule: mistakeRule(line.rule) })}
              {line.ruleFromFocus && <span className="text-muted-foreground"> ({t("contract.ruleFromFocus")})</span>}
            </>
          )}
        </span>
      )}
      <Link href={links.myPlan(date)} className="inline-flex items-center gap-0.5 text-xs font-medium text-muted-foreground hover:text-foreground">
        {line.empty || onlyPrefill ? t("contract.set") : t("contract.edit")}
        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
      {yesterday && <VerdictPill verdict={yesterday} />}
    </div>
  );
}

/** The verdict of one finished day, item by item (evening card). */
export function ContractVerdictRow({ verdict }: { verdict: ContractVerdict }) {
  const { t } = dailyI18n.useT();
  if (contractOverall(verdict) === "unset") return null;
  const items: { key: string; label: string; status: ContractStatus; detail?: string }[] = [];
  const ml = verdict.maxLoss;
  if (ml.status !== "unset" && ml.limit != null) {
    items.push({
      key: "loss",
      label: t("contract.item.maxLoss"),
      status: ml.status,
      detail: ml.actual != null ? t("contract.lossActual", { actual: fmtUsd(ml.actual, { signed: true, decimals: 0 }), limit: fmtUsd(ml.limit, { decimals: 0 }) }) : undefined,
    });
  }
  const mt = verdict.maxTrades;
  if (mt.status !== "unset" && mt.limit != null) {
    items.push({ key: "trades", label: t("contract.item.maxTrades"), status: mt.status, detail: t("contract.tradesActual", { actual: mt.actual, limit: mt.limit }) });
  }
  if (verdict.rule.status !== "unset" && verdict.rule.mistake) {
    items.push({ key: "rule", label: t("contract.item.rule"), status: verdict.rule.status, detail: mistakeRule(verdict.rule.mistake) });
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
        <ShieldCheck className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        {t("contract.title")}
      </span>
      {items.map((i) => (
        <span key={i.key} className="inline-flex min-w-0 items-center gap-1 text-muted-foreground" title={t(`status.${i.status}`)}>
          <StatusIcon status={i.status} />
          <span className="text-foreground/90">{i.label}</span>
          {i.detail && <span className="truncate tabular-nums">{i.detail}</span>}
        </span>
      ))}
      {verdict.disciplineDelta !== 0 && (
        <Pill tone={verdict.disciplineDelta > 0 ? "up" : "down"} title={t("contract.disciplineTitle")}>
          {t("contract.discipline", { delta: fmtDelta(verdict.disciplineDelta) })}
        </Pill>
      )}
    </div>
  );
}
