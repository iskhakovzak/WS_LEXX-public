import { useState } from "react";
import { AlertCircle, RefreshCw, WifiOff, Lock, ChevronDown } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";
import { commonI18n } from "@/i18n/ns/common";

type Props = {
  error?: unknown;
  onRetry?: () => void;
  message?: string;
  /** Optional: title above the message (default derived from the error). */
  title?: string;
  /** Optional: inline single-row variant for small panels and lists. */
  compact?: boolean;
  /** Retry button text (default common `actions.retry`). */
  retryLabel?: string;
  className?: string;
};

type Kind = "network" | "auth" | "server" | "generic";

function classify(error: unknown): { kind: Kind; status: number | null; raw: string | null } {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  const statusFromObj = (error as { status?: unknown } | null)?.status;
  const m = raw ? /\b([45]\d\d)\b/.exec(raw) : null;
  const status = typeof statusFromObj === "number" ? statusFromObj : m ? Number(m[1]) : null;
  if (raw && /failed to fetch|networkerror|network error|load failed|err_network|timeout/i.test(raw)) return { kind: "network", status, raw };
  if (status === 401 || status === 403) return { kind: "auth", status, raw };
  if (status != null && status >= 500) return { kind: "server", status, raw };
  return { kind: "generic", status, raw };
}

const ICON: Record<Kind, typeof AlertCircle> = { network: WifiOff, auth: Lock, server: AlertCircle, generic: AlertCircle };

export function QueryError({ error, onRetry, message, title, compact, retryLabel: retryLabelProp, className }: Props) {
  const { t } = commonI18n.useT();
  const [retrying, setRetrying] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const { kind, status, raw } = classify(error);
  const copy = { title: t(`queryError.${kind}Title`), hint: t(`queryError.${kind}Hint`) };
  const retryLabel = retryLabelProp ?? t("actions.retry");
  const Icon = ICON[kind];
  const heading = title ?? message ?? copy.title;
  // With both a title and a message the message is the explanation line (it used to be dropped).
  const text = title && message ? message : message && error == null ? null : copy.hint;
  const details = raw && raw !== heading ? raw : null;

  const retry = () => {
    if (!onRetry) return;
    setRetrying(true);
    try { onRetry(); } finally { setTimeout(() => setRetrying(false), 800); }
  };

  if (compact) {
    return (
      <div role="alert" className={cn("flex flex-wrap items-center gap-2 rounded-xl bg-down/10 px-3 py-2 text-sm text-down", className)}>
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">{heading}</span>
        {onRetry && (
          <Button type="button" variant="ghost" size="sm" onClick={retry} disabled={retrying} className="h-7 text-down hover:text-down">
            <RefreshCw className={cn(retrying && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
            {retryLabel}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div role="alert" className={cn("glass-panel flex flex-col items-center justify-center gap-3 rounded-2xl px-6 py-10 text-center", className)}>
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-down/12 text-down">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="max-w-sm">
        <p className="text-sm font-semibold text-foreground">
          {heading}
          {status != null && <span className="ml-1.5 text-xs font-normal tabular-nums text-muted-foreground">· {status}</span>}
        </p>
        {text && <p className="mt-1 text-sm text-muted-foreground">{text}</p>}
      </div>
      {onRetry && (
        <Button type="button" variant="outline" size="sm" onClick={retry} disabled={retrying}>
          <RefreshCw className={cn(retrying && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
          {retryLabel}
        </Button>
      )}
      {details && (
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
            className="inline-flex min-h-6 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            {t("queryError.details")}
            <ChevronDown className={cn("h-3 w-3 transition-transform", showDetails && "rotate-180")} aria-hidden="true" />
          </button>
          {showDetails && (
            <code className="max-w-md break-all rounded-lg bg-[var(--glass-bg)] px-2 py-1 text-2xs text-muted-foreground">{details}</code>
          )}
        </div>
      )}
    </div>
  );
}
