import { useState, useCallback, useRef, useEffect } from "react";
import { http } from "@/lib/api/http";
import { useToast } from "@/hooks/use-toast";
import { commonI18n } from "@/i18n/ns/common";

/** Default undo window. UndoToast uses the same default. */
export const UNDO_WINDOW_MS = 8000;

type UndoState = {
  id: number;
  section: string;
  label: string;
  /** Epoch ms when the undo was scheduled. */
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type Options = {
  /**
   * Safety-net lifetime of the pending entry. The visible countdown lives in
   * UndoToast (it pauses on hover/focus and calls onDismiss when it ends), so
   * this fallback is intentionally longer than the toast window.
   */
  fallbackMs?: number;
};

export function useUndoDelete(onRestore?: () => void, options?: Options) {
  const { toast } = useToast();
  const fallbackMs = options?.fallbackMs ?? UNDO_WINDOW_MS * 6;
  const [pending, setPending] = useState<UndoState | null>(null);
  const [restoring, setRestoring] = useState(false);
  const pendingRef = useRef<UndoState | null>(null);
  const restoringRef = useRef(false);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    return () => {
      if (pendingRef.current) clearTimeout(pendingRef.current.timer);
    };
  }, []);

  const scheduleUndo = useCallback((id: number, section: string, label: string) => {
    if (pendingRef.current) clearTimeout(pendingRef.current.timer);
    const timer = setTimeout(() => {
      setPending((cur) => (cur && cur.id === id && cur.section === section ? null : cur));
    }, fallbackMs);
    const next = { id, section, label, createdAt: Date.now(), timer };
    pendingRef.current = next;
    setPending(next);
  }, [fallbackMs]);

  const restore = useCallback(async () => {
    const cur = pendingRef.current;
    if (!cur || restoringRef.current) return;
    restoringRef.current = true;
    setRestoring(true);
    clearTimeout(cur.timer);
    try {
      await http.post(`/api/${cur.section}/${cur.id}/restore`);
      onRestore?.();
      toast({ title: commonI18n.t("undo.restored", { label: cur.label }) });
    } catch (e) {
      toast({ title: commonI18n.t("undo.restoreFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      restoringRef.current = false;
      setRestoring(false);
      pendingRef.current = null;
      setPending(null);
    }
  }, [onRestore, toast]);

  const dismiss = useCallback(() => {
    const cur = pendingRef.current;
    if (cur) clearTimeout(cur.timer);
    pendingRef.current = null;
    setPending(null);
  }, []);

  return { pending, restoring, scheduleUndo, restore, dismiss };
}
