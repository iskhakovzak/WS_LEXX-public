import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Trash2, Undo2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { commonI18n } from "@/i18n/ns/common";

type Props = {
  label: string;
  onUndo: () => void;
  onDismiss: () => void;
  durationMs?: number;
  /** Optional: verb after the label (common `undo.deleted` by default; pass a translated word). */
  actionText?: string;
  /** Optional: show a spinner on the undo button (e.g. useUndoDelete().restoring). */
  restoring?: boolean;
  /** Optional: enable Ctrl/⌘+Z shortcut (default true). */
  shortcut?: boolean;
};

const RING_R = 9;
const RING_C = 2 * Math.PI * RING_R;

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/**
 * Glass undo toast with a countdown ring. The countdown pauses while the toast
 * is hovered or focused and calls onDismiss when it runs out. Ctrl/⌘+Z undoes.
 */
export function UndoToast({
  label,
  onUndo,
  onDismiss,
  durationMs = 8000,
  actionText,
  restoring,
  shortcut = true,
}: Props) {
  const { t } = commonI18n.useT();
  const [remaining, setRemaining] = useState(durationMs);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const remainingRef = useRef(durationMs);
  const dismissedRef = useRef(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const isBusy = busy || !!restoring;

  useEffect(() => {
    if (paused || isBusy) return;
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      remainingRef.current = Math.max(0, remainingRef.current - (now - last));
      last = now;
      setRemaining(remainingRef.current);
      if (remainingRef.current <= 0 && !dismissedRef.current) {
        dismissedRef.current = true;
        window.clearInterval(id);
        onDismissRef.current();
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [paused, isBusy]);

  const handleUndo = useCallback(() => {
    if (isBusy || dismissedRef.current) return;
    setBusy(true);
    onUndo();
  }, [isBusy, onUndo]);

  useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== "z" && e.code !== "KeyZ") return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      handleUndo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut, handleUndo]);

  const frac = durationMs > 0 ? remaining / durationMs : 0;
  const seconds = Math.ceil(remaining / 1000);
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-toast flex justify-center px-4 sm:bottom-6"
    >
      <div
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false); }}
        className={cn(
          "glass-thick pointer-events-auto flex w-full max-w-[440px] items-center gap-3 rounded-2xl py-2 pl-2 pr-2 sm:w-auto sm:min-w-[340px]",
          "animate-in fade-in slide-in-from-bottom-4 duration-200 motion-reduce:animate-none",
        )}
      >
        <span className="relative grid h-10 w-10 shrink-0 place-items-center" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="absolute inset-0 h-10 w-10 -rotate-90">
            <circle cx="12" cy="12" r={RING_R} fill="none" stroke="hsl(var(--border))" strokeWidth="2" />
            <circle
              cx="12" cy="12" r={RING_R} fill="none"
              stroke="hsl(var(--primary))" strokeWidth="2" strokeLinecap="round"
              strokeDasharray={RING_C}
              strokeDashoffset={RING_C * (1 - frac)}
              className="transition-[stroke-dashoffset] duration-100 ease-linear motion-reduce:transition-none"
            />
          </svg>
          <span className="text-2xs font-semibold tabular-nums text-foreground">
            {paused ? <Trash2 className="h-3.5 w-3.5 text-muted-foreground" /> : seconds}
          </span>
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-foreground">
            <span className="font-semibold">{label}</span>{" "}
            <span className="text-muted-foreground">{actionText ?? t("undo.deleted")}</span>
          </p>
          <p className="truncate text-2xs text-muted-foreground">
            {paused ? t("undo.paused") : t("undo.canRestore", { count: seconds })}
            {shortcut && <span className="hidden sm:inline"> · {isMac ? "⌘" : "Ctrl"}+Z</span>}
          </p>
        </div>

        <button
          type="button"
          onClick={handleUndo}
          disabled={isBusy}
          className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary/15 px-3.5 text-sm font-medium text-primary transition-colors hover:bg-primary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          {isBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Undo2 className="h-4 w-4" aria-hidden="true" />}
          {isBusy ? t("undo.restoring") : t("actions.undo")}
        </button>
        <button
          type="button"
          aria-label={t("undo.dismissAria")}
          onClick={() => { dismissedRef.current = true; onDismiss(); }}
          disabled={isBusy}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
