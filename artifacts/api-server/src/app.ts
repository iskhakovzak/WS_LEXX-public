import express, { type Express, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import path from "path";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";
import { config } from "./config";
import { authMiddleware, apiAuthGate } from "./lib/auth";
import { jsonCompression } from "./lib/jsonCompression";
import { requestLang } from "./i18n";
import { errorMiddleware, toAppError } from "./lib/http";
import {
  corsMiddleware, genReqId, helmetMiddleware, inlineScriptHashes, jsonBody, loginBody, loginIpLimiter, loginNameLimiter,
  reportingEndpoints, trustProxySetting,
} from "./lib/security/http";
import { shutdownConnectionClose } from "./lib/security/lifecycle";
import { captureFailedResponse, captureServerError } from "./lib/errorTracking";
import { rateLimitedBody } from "./lib/rateLimits";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = config.isProduction;
const staticDir = path.resolve(__dirname, "public");

const app: Express = express();

// ─── Security middleware (A1; lib/security/http.ts) ─────────────────────────────────────────────────────
app.disable("x-powered-by");
// req.ip = the real client behind Replit's single proxy hop (TRUST_PROXY overrides; reasoning in lib/security/http.ts).
// Safe: proxy-addr is pinned ≥ 2.0.8 (pnpm-workspace.yaml override, A2) — fixes the IPv4-mapped IPv6 trust bypass.
app.set("trust proxy", trustProxySetting());

app.use(
  pinoHttp({
    logger,
    // X-Request-Id on every response; the same id is in the logs, the error tracker and 5xx bodies (lib/http).
    genReqId,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(shutdownConnectionClose);
// A /api request that ended with ≥ 500 without a thrown error (a route that answered 500 itself) is recorded too.
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  res.on("finish", () => { if (res.statusCode >= 500) void captureFailedResponse(req, res.statusCode); });
  next();
});
// Production is same-origin (no CORS layer at all); development is permissive for the API_TARGET setup.
const devCors = corsMiddleware();
if (devCors) app.use(devCors);
// CSP is report-only here (violations → /api/csp-report → error tracker); the enforced script policy is the <meta>
// CSP the Vite build writes into index.html. The inline theme script of the served index.html is hashed in.
const indexHtml = path.join(staticDir, "index.html");
app.use(helmetMiddleware(isProduction && existsSync(indexHtml) ? inlineScriptHashes(readFileSync(indexHtml, "utf8")) : []));
app.use(reportingEndpoints);

// Sign-in: tiny body, then IP+name and per-IP limiters (failures only), then the per-account lockout in routes/auth.ts.
app.use("/api/auth/login", loginBody, loginIpLimiter(), loginNameLimiter());

const guestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: rateLimitedBody,
});
app.use("/api/auth/guest", guestLimiter);

// Same budget as login: POST /auth/init-passwords is public (first-run bootstrap) and takes a secret.
const initPasswordsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: rateLimitedBody,
});
app.use("/api/auth/init-passwords", initPasswordsLimiter);

// Every /api/* request needs a valid token (member or guest). The explicit allowlist
// (method + path) lives next to the gate in lib/auth.ts: PUBLIC_API_ROUTES.
// Anonymous → 401 «Требуется вход»; guest on any mutation → 403 «Гостевой режим: только просмотр».
// gzip for JSON answers ≥ 16 KB (lib/jsonCompression: res.json only — streams, SSE and files are untouched).
app.use("/api", jsonCompression());
// requestLang: req.lang from X-Lang → users.locale → "ru" (src/i18n); adds Vary: X-Lang.
// jsonBody: 256 KB by default with per-route overrides (lib/security/http JSON_BODY_OVERRIDES), parsed only after
// the gate so anonymous requests to private routes are rejected before their body is read. No urlencoded parser.
app.use("/api", authMiddleware, apiAuthGate, requestLang, jsonBody(), router);

if (isProduction) {
  app.use(express.static(staticDir));
  app.get("/{*path}", (_req: Request, res: Response) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

// 5xx → error tracker (with stack and request id), then on to the error middleware.
app.use((err: unknown, req: Request, _res: Response, next: NextFunction) => {
  const { appError, internal } = toAppError(err);
  if (internal || appError.status >= 500) void captureServerError(err, req, appError.status);
  next(err);
});

// Last: the only writer of error bodies (src/lib/http/middleware.ts: AppError, zod, pg, multer, body-parser, CORS → { error, code, details? }).
app.use(errorMiddleware);

export default app;
