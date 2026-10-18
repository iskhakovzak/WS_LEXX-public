/**
 * Process lifecycle (ARCHITECTURE.md §2.11, tooling.md P1-4 / P2-3):
 *
 *  • Crash policy — after an `uncaughtException` or `unhandledRejection` Node's state is undefined, so we log it,
 *    record it in the error tracker (bounded wait) and exit(1); the process manager (Replit) restarts us.
 *  • Graceful shutdown on SIGTERM / SIGINT — stop accepting connections, let in-flight requests finish (idle
 *    keep-alive sockets are closed at once, busy ones get `Connection: close`), stop background jobs, close the
 *    pg pool, exit(0). A hard timeout (10 s) exits with 1 if anything hangs.
 *
 * Everything is injectable so tests can drive it without a real process or database.
 */
import type { Server } from "node:http";
import type { RequestHandler } from "express";

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void; fatal?: (o: object, m?: string) => void };

let shuttingDown = false;
export function isShuttingDown(): boolean { return shuttingDown; }
/** Tests only. */
export function resetShutdownStateForTests(): void { shuttingDown = false; }

/** During shutdown every response asks the client to drop its keep-alive connection. */
export const shutdownConnectionClose: RequestHandler = (_req, res, next) => {
  if (shuttingDown) res.setHeader("Connection", "close");
  next();
};

export type CrashDeps = {
  logger: Log;
  capture?: (err: unknown, kind: "uncaughtException" | "unhandledRejection") => Promise<unknown>;
  exit?: (code: number) => void;
  /** Max time spent recording the crash before exiting. */
  captureTimeoutMs?: number;
};

/** Returns the handler (exported for tests); `installCrashHandlers` registers it on `process`. */
export function crashHandler(kind: "uncaughtException" | "unhandledRejection", deps: CrashDeps): (err: unknown) => Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let handled = false;
  return async (err: unknown) => {
    if (handled) return; // a second crash while we are already going down
    handled = true;
    (deps.logger.fatal ?? deps.logger.error)({ err }, `${kind} — exiting (the process manager restarts the server)`);
    if (deps.capture) {
      await Promise.race([
        deps.capture(err, kind).catch(() => undefined),
        new Promise((r) => setTimeout(r, deps.captureTimeoutMs ?? 1500).unref?.()),
      ]);
    }
    exit(1);
  };
}

export function installCrashHandlers(deps: CrashDeps): void {
  process.on("uncaughtException", crashHandler("uncaughtException", deps));
  process.on("unhandledRejection", crashHandler("unhandledRejection", deps));
}

export type ShutdownDeps = {
  logger: Log;
  /** Stop schedulers / pollers and wait (bounded) for running jobs. */
  stopJobs?: () => Promise<void>;
  /** pool.end() */
  closePool?: () => Promise<void>;
  exit?: (code: number) => void;
  timeoutMs?: number;
};

/** Returns `shutdown(signal)`; idempotent (a second signal while draining is ignored). */
export function createShutdown(server: Server, deps: ShutdownDeps): (signal: string) => Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = deps.timeoutMs ?? 10_000;
  let started = false;
  return async (signal: string) => {
    if (started) return;
    started = true;
    shuttingDown = true;
    const t0 = Date.now();
    deps.logger.info({ signal, timeoutMs }, "shutdown: draining");
    const hard = setTimeout(() => {
      deps.logger.error({ signal, ms: Date.now() - t0 }, "shutdown: timed out — forcing exit");
      server.closeAllConnections?.();
      exit(1);
    }, timeoutMs);
    hard.unref?.();
    try {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections?.();
      await Promise.all([closed, deps.stopJobs?.().catch((err) => deps.logger.warn({ err }, "shutdown: stopping jobs failed"))]);
      await deps.closePool?.().catch((err) => deps.logger.warn({ err }, "shutdown: closing the pool failed"));
      clearTimeout(hard);
      deps.logger.info({ signal, ms: Date.now() - t0 }, "shutdown: done");
      exit(0);
    } catch (err) {
      clearTimeout(hard);
      deps.logger.error({ err }, "shutdown: failed");
      exit(1);
    }
  };
}

export function installGracefulShutdown(server: Server, deps: ShutdownDeps): void {
  const shutdown = createShutdown(server, deps);
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => void shutdown(sig));
}
