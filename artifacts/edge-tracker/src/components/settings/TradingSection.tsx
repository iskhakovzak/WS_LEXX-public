
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Calculator, ClipboardCheck, Landmark, RotateCcw, ShieldAlert, SlidersHorizontal } from "lucide-react";
import { Panel, Pill, Segmented, StatRow } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChecklistTemplateAdmin } from "@/components/checklist-template-admin";
import { useAuth } from "@/contexts/auth-context";
import { STALE } from "@/lib/api/keys";
import { riskMeQuery } from "@/lib/api/queries";
import { cn } from "@/lib/utils";
import {
  DEFAULT_TRADING_DEFAULTS, TRADING_DEFAULT_LIMITS, buyingPower, getTradingDefaults, normalizeTradingDefaults,
  resetTradingDefaults, riskPerTradePct, riskPerTradeUsd, roundTripCommission, setTradingDefaults, sharesForRisk, syncTradingDefaults,
  type Horizon, type RiskMode, type TradingDefaults,
} from "./trading-defaults";
import { Callout, HORIZON_LABEL } from "./shared";
import { fmtCount, fmtDate, fmtPct, fmtR, fmtUsd } from "@/lib/format";
import { settingsI18n } from "@/i18n/ns/settings";
import { commonI18n } from "@/i18n/ns/common";

type DeskLimits = {
  accountSize: number | null;
  maxRiskPerTrade: number | null;
  maxPositionUsd: number | null;
  maxOvernightExposure: number | null;
  allowOvernight: boolean;
  allowSwing: boolean;
  tier: string | null;
};

/** Desk limits from the Risk section; null when the endpoint is missing or the trader has no limits. */
function useDeskLimits(enabled: boolean) {
  // Shared /api/risk/me cache entry (today's NY date); an error just leaves data undefined (= no desk limits).
  return useQuery({
    ...riskMeQuery<{ limits?: DeskLimits | null } | null>(),
    select: (d): DeskLimits | null => d?.limits ?? null,
    enabled,
    staleTime: STALE.long,
    retry: false,
  });
}

type Draft = Record<"accountSize" | "riskPct" | "riskUsd" | "commissionPerShare" | "commissionMin" | "leverageIntraday" | "leverageOvernight", string>;

function toDraft(d: TradingDefaults): Draft {
  return {
    accountSize: String(d.accountSize),
    riskPct: String(d.riskPct),
    riskUsd: String(d.riskUsd),
    commissionPerShare: String(d.commissionPerShare),
    commissionMin: String(d.commissionMin),
    leverageIntraday: String(d.leverageIntraday),
    leverageOvernight: String(d.leverageOvernight),
  };
}

function fieldError(key: keyof Draft, raw: string): string | null {
  const t = settingsI18n.t;
  if (raw.trim() === "") return t("trading.enterValue");
  const n = Number(raw.replace(",", "."));
  if (!Number.isFinite(n)) return t("trading.needNumber");
  const b = TRADING_DEFAULT_LIMITS[key];
  if (n < b.min || n > b.max) return t("trading.range", { min: b.min, max: fmtCount(b.max) });
  return null;
}

function NumberField({
  id, label, hint, value, onChange, error, prefix, suffix, step = "any", className,
}: {
  id: string; label: string; hint?: string; value: string; onChange: (v: string) => void; error: string | null;
  prefix?: string; suffix?: string; step?: string; className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-xs text-muted-foreground">{label}</label>
      <div className="relative">
        {prefix && <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{prefix}</span>}
        <Input
          id={id}
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
          className={cn("tabular-nums", prefix && "pl-8", suffix && "pr-12", error && "border-down")}
          step={step}
        />
        {suffix && <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{suffix}</span>}
      </div>
      {error ? (
        <p id={`${id}-err`} className="text-xs text-down">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function useSecondsAgo(iso: string | null): string | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!iso) return;
    const t = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, [iso]);
  if (!iso) return null;
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 10) return settingsI18n.t("trading.justNow");
  if (s < 60) return settingsI18n.t("trading.secondsAgo", { count: s });
  const m = Math.round(s / 60);
  if (m < 60) return settingsI18n.t("trading.minutesAgo", { count: m });
  return fmtDate(iso, "dateTime");
}

export function TradingSection() {
  const { user, can } = useAuth();
  const { t } = settingsI18n.useT();
  const { t: tc } = commonI18n.useT();
  const isMember = !!user?.traderName && user.role !== "guest";
  const trader = user?.traderName ?? null;

  const [saved, setSaved] = useState<TradingDefaults>(() => getTradingDefaults(trader));
  const [draft, setDraft] = useState<Draft>(() => toDraft(saved));
  const [riskMode, setRiskMode] = useState<RiskMode>(saved.riskMode);
  const [horizon, setHorizon] = useState<Horizon>(saved.defaultHorizon);
  const [storageFailed, setStorageFailed] = useState(false);

  // Re-load when the user changes (per-user storage key), then reconcile with the server copy (P1-7:
  // users.settings — newer updatedAt wins; an old browser-only value is migrated to the server).
  useEffect(() => {
    const d = getTradingDefaults(trader);
    setSaved(d); setDraft(toDraft(d)); setRiskMode(d.riskMode); setHorizon(d.defaultHorizon);
    let alive = true;
    void syncTradingDefaults(trader).then((s) => {
      if (!alive || !s || s.updatedAt === d.updatedAt) return;
      setSaved(s); setDraft(toDraft(s)); setRiskMode(s.riskMode); setHorizon(s.defaultHorizon);
    });
    return () => { alive = false; };
  }, [trader]);

  const errors = useMemo(() => {
    const e: Partial<Record<keyof Draft, string | null>> = {};
    (Object.keys(draft) as (keyof Draft)[]).forEach((k) => { e[k] = fieldError(k, draft[k]); });
    return e;
  }, [draft]);
  const hasErrors = Object.values(errors).some(Boolean);

  // Live candidate (what the preview shows) — valid fields only.
  const candidate = useMemo<TradingDefaults>(() => {
    const parsed: Record<string, unknown> = { ...saved, riskMode, defaultHorizon: horizon };
    (Object.keys(draft) as (keyof Draft)[]).forEach((k) => {
      if (!errors[k]) parsed[k] = Number(draft[k].replace(",", "."));
    });
    return normalizeTradingDefaults(parsed);
  }, [draft, errors, riskMode, horizon, saved]);

  // Autosave (debounced) when everything is valid and something changed.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    if (hasErrors) return;
    const same = (Object.keys(draft) as (keyof Draft)[]).every((k) => (candidate as unknown as Record<string, number>)[k] === (saved as unknown as Record<string, number>)[k])
      && candidate.riskMode === saved.riskMode && candidate.defaultHorizon === saved.defaultHorizon;
    if (same) return;
    const t = setTimeout(() => {
      const res = setTradingDefaults(candidate, trader);
      if (res) { setSaved(res); setStorageFailed(false); } else setStorageFailed(true);
    }, 450);
    return () => clearTimeout(t);
  }, [candidate, hasErrors]); // eslint-disable-line react-hooks/exhaustive-deps

  const savedAgo = useSecondsAgo(saved.updatedAt);
  const { data: desk } = useDeskLimits(isMember);

  // Sample position (local, not saved)
  const [entry, setEntry] = useState("50");
  const [stop, setStop] = useState("49.5");
  const entryN = Number(entry.replace(",", "."));
  const stopN = Number(stop.replace(",", "."));
  const sample = sharesForRisk(candidate, entryN, stopN, candidate.defaultHorizon);
  const rt = roundTripCommission(candidate, sample.shares);
  const riskUsd = riskPerTradeUsd(candidate);
  const commInR = riskUsd > 0 ? rt / riskUsd : 0;

  const set = (k: keyof Draft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));

  function resetAll() {
    resetTradingDefaults(trader);
    const d = { ...DEFAULT_TRADING_DEFAULTS };
    setSaved(d); setDraft(toDraft(d)); setRiskMode(d.riskMode); setHorizon(d.defaultHorizon);
  }

  function applyDesk() {
    if (!desk) return;
    setDraft((d) => ({
      ...d,
      ...(desk.accountSize != null ? { accountSize: String(desk.accountSize) } : {}),
      ...(desk.maxRiskPerTrade != null ? { riskUsd: String(desk.maxRiskPerTrade) } : {}),
    }));
    if (desk.maxRiskPerTrade != null) setRiskMode("usd");
  }

  // Desk-limit conflicts
  const warnings: string[] = [];
  if (desk) {
    if (desk.maxRiskPerTrade != null && riskUsd > desk.maxRiskPerTrade + 0.005)
      warnings.push(t("trading.riskOverDesk", { risk: fmtUsd(riskUsd, { decimals: 0 }), limit: fmtUsd(desk.maxRiskPerTrade, { decimals: 0 }) }));
    if (desk.accountSize != null && Math.abs(desk.accountSize - candidate.accountSize) > 0.5)
      warnings.push(t("trading.accountDiffers", { amount: fmtUsd(desk.accountSize, { decimals: 0 }) }));
    if (candidate.defaultHorizon === "overnight" && !desk.allowOvernight) warnings.push(t("trading.overnightNotAllowed"));
    if (candidate.defaultHorizon === "swing" && !desk.allowSwing) warnings.push(t("trading.swingNotAllowed"));
    if (desk.maxOvernightExposure != null && candidate.defaultHorizon !== "intraday" && buyingPower(candidate, "overnight") > desk.maxOvernightExposure)
      warnings.push(t("trading.overnightBpOver", { bp: fmtUsd(buyingPower(candidate, "overnight"), { decimals: 0 }), limit: fmtUsd(desk.maxOvernightExposure, { decimals: 0 }) }));
  }

  if (!isMember) {
    return (
      <Panel title={t("trading.guestTitle")} icon={SlidersHorizontal}>
        <Callout>{t("trading.guest")}</Callout>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        {/* Form */}
        <Panel
          title={t("trading.accountRisk")}
          description={t("trading.accountRiskDesc")}
          icon={SlidersHorizontal}
          actions={
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground" aria-live="polite">
                {storageFailed ? <span className="text-down">{t("trading.storageFailed")}</span>
                  : hasErrors ? t("trading.fixFields")
                  : saved.updatedAt ? t("trading.savedAgo", { ago: savedAgo ?? "" }) : t("trading.defaults")}
              </span>
              <Button size="sm" variant="ghost" onClick={resetAll} className="gap-1.5" aria-label={t("trading.resetAria")}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> {t("trading.reset")}
              </Button>
            </div>
          }
        >
          <div className="flex flex-col gap-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <NumberField id="td-account" label={t("trading.accountSize")} prefix="$" value={draft.accountSize} onChange={set("accountSize")} error={errors.accountSize ?? null}
                hint={t("trading.accountSizeHint")} />
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-xs text-muted-foreground" aria-hidden="true">{t("trading.riskPerTrade")}</span>
                <div className="flex gap-2">
                  <Segmented<RiskMode> ariaLabel={t("trading.riskUnit")} size="sm" value={riskMode} onChange={setRiskMode}
                    options={[{ value: "pct", label: "%" }, { value: "usd", label: "$" }]} className="shrink-0" />
                  {riskMode === "pct" ? (
                    <NumberField id="td-risk-pct" label={t("trading.riskPct")} suffix="%" value={draft.riskPct} onChange={set("riskPct")} error={errors.riskPct ?? null} className="flex-1 [&>label]:sr-only" />
                  ) : (
                    <NumberField id="td-risk-usd" label={t("trading.riskUsd")} prefix="$" value={draft.riskUsd} onChange={set("riskUsd")} error={errors.riskUsd ?? null} className="flex-1 [&>label]:sr-only" />
                  )}
                </div>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {t("trading.isYour1R", { value: riskMode === "pct" ? fmtUsd(riskUsd, { decimals: 0 }) : t("trading.ofAccount", { pct: fmtPct(riskPerTradePct(candidate), { decimals: 2, signed: false }) }) })}
                </p>
              </div>
            </div>

            <div>
              <div className="micro-label mb-2">{t("trading.commissions")}</div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <NumberField id="td-comm" label={t("trading.perShare")} prefix="$" value={draft.commissionPerShare} onChange={set("commissionPerShare")} error={errors.commissionPerShare ?? null} hint={t("trading.perShareHint")} />
                <NumberField id="td-comm-min" label={t("trading.minPerOrder")} prefix="$" value={draft.commissionMin} onChange={set("commissionMin")} error={errors.commissionMin ?? null} />
              </div>
            </div>

            <div>
              <div className="micro-label mb-2">{t("trading.leverage")}</div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <NumberField id="td-lev-intra" label={tc("trading.intraday")} suffix="×" value={draft.leverageIntraday} onChange={set("leverageIntraday")} error={errors.leverageIntraday ?? null} hint={`Buying power ${fmtUsd(buyingPower(candidate, "intraday"), { decimals: 0 })}`} />
                <NumberField id="td-lev-on" label={t("trading.overnightSwing")} suffix="×" value={draft.leverageOvernight} onChange={set("leverageOvernight")} error={errors.leverageOvernight ?? null} hint={`Buying power ${fmtUsd(buyingPower(candidate, "overnight"), { decimals: 0 })}`} />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">{t("trading.defaultHorizon")}</div>
                <p className="text-xs text-muted-foreground">{t("trading.defaultHorizonHint")}</p>
              </div>
              <Segmented<Horizon> ariaLabel={t("trading.defaultHorizon")} value={horizon} onChange={setHorizon}
                options={(["intraday", "overnight", "swing"] as Horizon[]).map((h) => ({ value: h, label: HORIZON_LABEL[h] }))} />
            </div>
          </div>
        </Panel>

        {/* Live preview */}
        <div className="flex flex-col gap-4">
          <Panel title={t("trading.your1R")} description={t("trading.your1RDesc")} icon={Calculator}>
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="text-3xl font-semibold tabular-nums tracking-tight text-foreground">{fmtUsd(riskUsd, { decimals: 0 })}</div>
                <div className="text-xs text-muted-foreground tabular-nums">{t("trading.pctOf", { pct: fmtPct(riskPerTradePct(candidate), { decimals: 2, signed: false }), amount: fmtUsd(candidate.accountSize, { decimals: 0 }) })}</div>
              </div>
              <Pill tone="accent">{HORIZON_LABEL[candidate.defaultHorizon]}</Pill>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <NumberField id="td-sample-entry" label={t("trading.sampleEntry")} prefix="$" value={entry} onChange={setEntry} error={Number.isFinite(entryN) && entryN > 0 ? null : t("trading.priceGt0")} />
              <NumberField id="td-sample-stop" label={tc("trading.stop")} prefix="$" value={stop} onChange={setStop} error={Number.isFinite(stopN) && stopN > 0 && stopN !== entryN ? null : t("trading.notEntry")} />
            </div>
            <div className="mt-3 divide-y divide-border">
              <StatRow label={t("trading.positionSize")} value={sample.shares > 0 ? t("trading.sharesCount", { count: fmtCount(sample.shares) }) : "—"} />
              <StatRow label={tc("trading.volume")} value={fmtUsd(sample.positionUsd, { decimals: 0 })} />
              <StatRow label={t("trading.actualRisk")} value={fmtUsd(sample.riskUsd, { decimals: 0 })} />
              <StatRow label={t("trading.roundTrip")} value={fmtUsd(rt)} />
              <StatRow label={t("trading.commInR")} value={fmtR(commInR, { signed: false })} tone={commInR > 0.1 ? "down" : "neutral"} />
            </div>
            {sample.cappedByBuyingPower && (
              <Callout tone="warn" icon={AlertTriangle} className="mt-3">{t("trading.cappedByBp", { bp: fmtUsd(buyingPower(candidate), { decimals: 0 }) })}</Callout>
            )}
            {commInR > 0.1 && (
              <Callout tone="down" icon={AlertTriangle} className="mt-3">{t("trading.feesEatR")}</Callout>
            )}
          </Panel>

          {desk && (
            <Panel title={t("trading.deskLimits")} description={t("trading.deskLimitsDesc")} icon={Landmark}
              actions={desk.tier ? <Pill tone="purple">{desk.tier}</Pill> : undefined}>
              <div className="divide-y divide-border">
                <StatRow label={t("trading.allocated")} value={fmtUsd(desk.accountSize, { decimals: 0 })} />
                <StatRow label={t("trading.maxRisk")} value={fmtUsd(desk.maxRiskPerTrade, { decimals: 0 })} />
                <StatRow label={t("trading.maxPosition")} value={fmtUsd(desk.maxPositionUsd, { decimals: 0 })} />
                <StatRow label={t("trading.overnightSwing")} value={`${desk.allowOvernight ? tc("yes") : tc("no")} / ${desk.allowSwing ? tc("yes") : tc("no")}`} />
              </div>
              {warnings.length > 0 ? (
                <Callout tone="warn" icon={ShieldAlert} className="mt-3">
                  <ul className="space-y-1">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                </Callout>
              ) : (
                <Callout tone="up" icon={ShieldAlert} className="mt-3">{t("trading.withinDesk")}</Callout>
              )}
              {(desk.accountSize != null || desk.maxRiskPerTrade != null) && (
                <Button size="sm" variant="outline" onClick={applyDesk} className="mt-3">{t("trading.takeDesk")}</Button>
              )}
            </Panel>
          )}
        </div>
      </div>

      {can("checklist.template.edit") && (
        <Panel title={t("trading.checklistTitle")} description={t("trading.checklistDesc")} icon={ClipboardCheck}>
          <ChecklistTemplateAdmin />
        </Panel>
      )}
    </div>
  );
}
