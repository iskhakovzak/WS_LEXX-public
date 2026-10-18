// History and pinned questions of «Спроси журнал» (localStorage via usePersistentState; one owner — the page).
import * as React from "react";
import { usePersistentState } from "@/components/ds";

const HISTORY_MAX = 20;
const PINNED_MAX = 12;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const clean = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : []);

export interface AskMemory {
  history: string[];
  pinned: string[];
  remember: (text: string) => void;
  forget: (text: string) => void;
  clearHistory: () => void;
  isPinned: (text: string) => boolean;
  togglePin: (text: string) => void;
}

export function useAskMemory(): AskMemory {
  const [rawHistory, setHistory] = usePersistentState<string[]>("ask.history", []);
  const [rawPinned, setPinned] = usePersistentState<string[]>("ask.pinned", []);
  const history = React.useMemo(() => clean(rawHistory).slice(0, HISTORY_MAX), [rawHistory]);
  const pinned = React.useMemo(() => clean(rawPinned).slice(0, PINNED_MAX), [rawPinned]);

  const remember = React.useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    setHistory((h) => [t, ...clean(h).filter((x) => !same(x, t))].slice(0, HISTORY_MAX));
  }, [setHistory]);
  const forget = React.useCallback((text: string) => setHistory((h) => clean(h).filter((x) => !same(x, text))), [setHistory]);
  const clearHistory = React.useCallback(() => setHistory([]), [setHistory]);
  const isPinned = React.useCallback((text: string) => pinned.some((x) => same(x, text)), [pinned]);
  const togglePin = React.useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    setPinned((p) => {
      const list = clean(p);
      return list.some((x) => same(x, t)) ? list.filter((x) => !same(x, t)) : [t, ...list].slice(0, PINNED_MAX);
    });
  }, [setPinned]);

  return { history, pinned, remember, forget, clearHistory, isPinned, togglePin };
}
