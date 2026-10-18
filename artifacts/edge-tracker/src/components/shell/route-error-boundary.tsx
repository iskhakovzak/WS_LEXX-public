import * as React from "react";
import { ErrorState } from "@/components/ds/states";
import { shellI18n } from "@/i18n/ns/shell";
import { reportClientError } from "@/lib/error-reporting";

/** A lazy section chunk failed to download (new deploy replaced the hashed files, or the network dropped). */
export function isChunkLoadError(error: unknown) {
  const msg = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Unable to preload CSS/i.test(msg);
}

const RELOAD_KEY = "ws_lexx_chunk_reload_at";

/** One automatic reload per minute at most: a fresh index.html points at the new chunk names. */
function reloadOnceForChunkError(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/**
 * Catches render errors inside one route so a broken section doesn't take the whole shell down.
 * `resetKey` (the current location) clears the error when the user navigates elsewhere.
 * A failed section download reloads the page once by itself; if that doesn't help, «Reload» does it
 * by hand (React.lazy caches the failed import, so a plain retry would fail again).
 */
export class RouteErrorBoundary extends React.Component<
  { resetKey: string; children: React.ReactNode },
  { error: unknown }
> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    if (isChunkLoadError(error) && reloadOnceForChunkError()) return;
    console.error("[route]", error, info.componentStack);
    if (!isChunkLoadError(error)) reportClientError({ kind: "render", error, componentStack: info.componentStack });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const t = shellI18n.t;
    if (isChunkLoadError(this.state.error)) {
      return (
        <div className="mx-auto max-w-xl py-16">
          <ErrorState
            title={t("app.sectionFailed")}
            message={t("app.chunkFailedMessage")}
            onRetry={() => window.location.reload()}
            retryLabel={t("app.reload")}
          />
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-xl py-16">
        <ErrorState
          error={this.state.error}
          title={t("app.sectionFailed")}
          message={t("app.sectionErrorMessage")}
          onRetry={() => this.setState({ error: null })}
        />
      </div>
    );
  }
}
