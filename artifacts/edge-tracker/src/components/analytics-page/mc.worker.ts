/// <reference lib="webworker" />
// Monte Carlo off the main thread. Messages: { id, input: MonteCarloInput } → { id, result: MonteCarloResult | null }.
import { monteCarlo, type MonteCarloInput, type MonteCarloResult } from "./edge-stats";

export type McRequest = { id: number; input: MonteCarloInput };
export type McResponse = { id: number; result: MonteCarloResult | null; error?: string };

self.onmessage = (e: MessageEvent<McRequest>) => {
  const { id, input } = e.data;
  try {
    const result = monteCarlo(input);
    (self as unknown as Worker).postMessage({ id, result } satisfies McResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, result: null, error: String(err) } satisfies McResponse);
  }
};
