/**
 * Options tab: chain + advisor, single-option Black-Scholes, multi-leg strategy builder.
 * State for B-S and builder lives here so the chain/advisor can hand contracts over to either one.
 * All three views stay mounted (hidden) so a loaded chain survives switching views.
 */
import { useCallback, useEffect, useRef } from "react";
import { Calculator, Layers, Table2 } from "lucide-react";
import { Segmented } from "@/components/ds";
import { newLegId, usePersistedState } from "./lib";
import BlackScholesView, { type BsInputs } from "./BlackScholes";
import StrategyBuilder, { type BuilderState, type LegDraft } from "./StrategyBuilder";
import ChainAdvisor from "./ChainAdvisor";
import { calculatorI18n } from "@/i18n/ns/calculator";

type Mode = "chain" | "bs" | "builder";

export type UseInBsParams = { symbol: string; spot: number; strike: number; side: "call" | "put"; days: number; iv: number | null; premium: number; contracts: number };
export type OpenInBuilderParams = {
  symbol: string;
  spot: number;
  days: number;
  iv: number | null;
  legs: { side: "buy" | "sell"; kind: "call" | "put" | "stock"; strike: number; premium: number; qty: number }[];
  append?: boolean;
};

function useBsInputs(): BsInputs {
  const [ticker, setTicker] = usePersistedState<string>("opt_ticker", "");
  const [spot, setSpot] = usePersistedState<string>("opt_spot", "100");
  const [strike, setStrike] = usePersistedState<string>("opt_strike", "100");
  const [days, setDays] = usePersistedState<string>("opt_days", "30");
  const [iv, setIv] = usePersistedState<string>("opt_iv", "30");
  const [rate, setRate] = usePersistedState<string>("opt_rate", "4.5");
  const [contracts, setContracts] = usePersistedState<string>("opt_contracts", "1");
  const [premium, setPremium] = usePersistedState<string>("opt_premium", "");
  const [side, setSide] = usePersistedState<"call" | "put">("opt_side", "call");
  const [action, setAction] = usePersistedState<"buy" | "sell">("opt_action", "buy");
  const [showHelp, setShowHelp] = usePersistedState<boolean>("opt_show_help", true);
  return { ticker, setTicker, spot, setSpot, strike, setStrike, days, setDays, iv, setIv, rate, setRate, contracts, setContracts, premium, setPremium, side, setSide, action, setAction, showHelp, setShowHelp };
}

function useBuilder(): BuilderState {
  const [symbol, setSymbol] = usePersistedState<string>("builder_symbol", "");
  const [spot, setSpot] = usePersistedState<string>("builder_spot", "100");
  const [days, setDays] = usePersistedState<string>("builder_days", "30");
  const [iv, setIv] = usePersistedState<string>("builder_iv", "30");
  const [rate, setRate] = usePersistedState<string>("builder_rate", "4.5");
  const [legs, setLegs] = usePersistedState<LegDraft[]>("builder_legs", []);
  return { symbol, setSymbol, spot, setSpot, days, setDays, iv, setIv, rate, setRate, legs, setLegs };
}

const MODES: Mode[] = ["chain", "bs", "builder"];

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.getAttribute("role") === "combobox";
}

export default function OptionsSection({ initialTicker }: { initialTicker?: string } = {}) {
  const { t } = calculatorI18n.useT();
  const [mode, setMode] = usePersistedState<Mode>("opt_mode_v2", "chain");
  const bs = useBsInputs();
  const builder = useBuilder();

  // ?ticker=XYZ → prefill every view once (chain, B-S, builder); nothing is loaded automatically.
  const prefilled = useRef(false);
  useEffect(() => {
    if (!initialTicker || prefilled.current) return;
    prefilled.current = true;
    bs.setTicker(initialTicker);
    builder.setSymbol(initialTicker);
  }, [initialTicker, bs, builder]);

  // Alt+1/2/3 switches views (ignored while typing).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || e.ctrlKey || e.metaKey || isTypingTarget(e.target)) return;
      const idx = ["1", "2", "3"].indexOf(e.key);
      if (idx === -1) return;
      e.preventDefault();
      setMode(MODES[idx]);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setMode]);

  const useInBs = useCallback((p: UseInBsParams) => {
    bs.setSpot(p.spot.toFixed(2));
    bs.setStrike(String(p.strike));
    bs.setSide(p.side);
    bs.setAction("buy");
    bs.setDays(String(p.days));
    if (p.iv != null) bs.setIv(String(p.iv));
    bs.setPremium(p.premium > 0 ? p.premium.toFixed(3) : "");
    bs.setContracts(String(p.contracts));
    bs.setTicker(p.symbol);
    setMode("bs");
  }, [bs, setMode]);

  const openInBuilder = useCallback((p: OpenInBuilderParams) => {
    const drafts: LegDraft[] = p.legs.map((l) => ({
      id: newLegId(),
      kind: l.kind,
      side: l.side,
      strike: String(+l.strike.toFixed(2)),
      premium: l.kind === "stock" ? "" : String(+l.premium.toFixed(3)),
      qty: String(l.qty),
    }));
    builder.setSymbol(p.symbol);
    builder.setSpot(p.spot.toFixed(2));
    builder.setDays(String(p.days));
    if (p.iv != null) builder.setIv(String(p.iv));
    builder.setLegs((prev) => (p.append ? [...prev, ...drafts] : drafts));
    if (!p.append) setMode("builder");
  }, [builder, setMode]);

  const current: Mode = MODES.includes(mode) ? mode : "chain";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2" title={t("modes.shortcut")}>
      <Segmented<Mode>
        ariaLabel={t("modes.aria")}
        value={current}
        onChange={setMode}
        className="self-start"
        options={[
          { value: "chain", label: <><Table2 className="h-4 w-4" aria-hidden="true" />{t("modes.chain")}</> },
          { value: "bs", label: <><Calculator className="h-4 w-4" aria-hidden="true" />{t("modes.bs")}</> },
          { value: "builder", label: <><Layers className="h-4 w-4" aria-hidden="true" />{builder.legs.length ? t("modes.builderCount", { count: builder.legs.length }) : t("modes.builder")}</> },
        ]}
      />
      <p className="max-w-3xl text-xs text-muted-foreground">{t(`modeHint.${current}`)}</p>
      </div>
      <div hidden={current !== "chain"}>
        <ChainAdvisor initialTicker={initialTicker} onUseInBs={useInBs} onOpenInBuilder={openInBuilder} builderLegCount={builder.legs.length} onShowBuilder={() => setMode("builder")} />
      </div>
      <div hidden={current !== "bs"}>
        <BlackScholesView s={bs} onOpenInBuilder={openInBuilder} />
      </div>
      <div hidden={current !== "builder"}>
        <StrategyBuilder b={builder} />
      </div>
    </div>
  );
}
