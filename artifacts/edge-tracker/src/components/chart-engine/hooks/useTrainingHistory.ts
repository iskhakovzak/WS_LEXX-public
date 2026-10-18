/** Training attempts stored in this browser (localStorage), shared between every chart on the page and other tabs. */
import * as React from "react";
import { TRAINING_HISTORY_KEY, parseHistory, pushHistory, type TrainingRecord } from "../lib/training-sim";

const EVENT = "ws-chart:training-history";

function read(): TrainingRecord[] {
  try { return parseHistory(localStorage.getItem(TRAINING_HISTORY_KEY)); } catch { return []; }
}

export function useTrainingHistory(): { list: TrainingRecord[]; add: (rec: TrainingRecord) => void } {
  const [list, setList] = React.useState<TrainingRecord[]>(read);
  React.useEffect(() => {
    const sync = () => setList(read());
    const onStorage = (e: StorageEvent) => { if (e.key === TRAINING_HISTORY_KEY) sync(); };
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener("storage", onStorage); };
  }, []);
  const add = React.useCallback((rec: TrainingRecord) => {
    const next = pushHistory(read(), rec);
    try { localStorage.setItem(TRAINING_HISTORY_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
    setList(next);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { list, add };
}
