/**
 * Trade-structure layers of the chart, kept out of WsChart: the running average / size step line and the session's
 * re-entry chain (other trades on the ticker with «Перезаход №n» / «Переворот» links), plus their on/off toggles
 * (remembered in localStorage). WsChart only calls `attach` / `detach` when it builds / tears down the candle series.
 */
import * as React from "react";
import type { ISeriesApi, SeriesType, Time } from "lightweight-charts";
import type { ChartTheme } from "../theme";
import type { Geometry } from "../lib/geometry";
import { PositionStepsPrimitive } from "../primitives/PositionStepsPrimitive";
import { ChainPrimitive } from "../primitives/ChainPrimitive";
import { readChartTheme } from "../theme";

export type StructureToggles = { steps: boolean; chain: boolean };
const KEY = "wschart.structureLayers.v1";
const DEFAULTS: StructureToggles = { steps: true, chain: true };

function load(): StructureToggles {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<StructureToggles> | null;
    return { ...DEFAULTS, ...(raw ?? {}) };
  } catch {
    return DEFAULTS;
  }
}

export type StructureLayer = {
  attach: (series: ISeriesApi<SeriesType, Time>, theme: ChartTheme) => void;
  detach: (series: ISeriesApi<SeriesType, Time>) => void;
  toggles: StructureToggles;
  setToggle: (k: keyof StructureToggles, on: boolean) => void;
  /** Whether each layer has anything to draw on this trade (the key shows a toggle only then). */
  available: StructureToggles;
};

/**
 * `hideExits` (training before the answer) empties both layers: the steps would reveal the exits, the chain the
 * trades after this one. `limit` is the replay cursor (null = everything revealed).
 */
export function useStructureLayer(geo: Geometry, hideExits: boolean, limit: number | null): StructureLayer {
  const prims = React.useRef<{ steps: PositionStepsPrimitive; chain: ChainPrimitive } | null>(null);
  if (!prims.current) {
    const th = readChartTheme();
    prims.current = { steps: new PositionStepsPrimitive(th), chain: new ChainPrimitive(th) };
  }
  const [toggles, setToggles] = React.useState<StructureToggles>(load);

  const push = React.useCallback(() => {
    const p = prims.current!;
    p.steps.set(hideExits ? [] : geo.steps);
    p.steps.setVisible(toggles.steps);
    p.chain.set(hideExits ? { marks: [], links: [] } : geo.chain, new Map((geo.structure?.siblings ?? []).map((s) => [s.id, s.side])));
    p.chain.setVisible(toggles.chain);
    p.steps.setLimit(limit);
    p.chain.setLimit(limit);
  }, [geo, hideExits, toggles, limit]);
  const pushRef = React.useRef(push);
  pushRef.current = push;
  React.useEffect(() => { push(); }, [push]);

  const attach = React.useCallback((series: ISeriesApi<SeriesType, Time>, theme: ChartTheme) => {
    const p = prims.current!;
    p.steps.setTheme(theme); p.chain.setTheme(theme);
    series.attachPrimitive(p.chain);
    series.attachPrimitive(p.steps);
    pushRef.current();
  }, []);
  const detach = React.useCallback((series: ISeriesApi<SeriesType, Time>) => {
    const p = prims.current!;
    series.detachPrimitive(p.steps);
    series.detachPrimitive(p.chain);
  }, []);
  const setToggle = React.useCallback((k: keyof StructureToggles, on: boolean) => {
    setToggles((t) => {
      const next = { ...t, [k]: on };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);

  const available = React.useMemo(() => ({
    steps: !hideExits && geo.steps.length > 2,
    chain: !hideExits && (geo.chain.links.length > 0 || geo.chain.marks.length > 0),
  }), [geo, hideExits]);

  return React.useMemo(() => ({ attach, detach, toggles, setToggle, available }), [attach, detach, toggles, setToggle, available]);
}
