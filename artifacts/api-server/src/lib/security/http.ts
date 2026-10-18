/**
 * HTTP security middleware for app.ts (Phase A, docs/research/tooling.md §5.4–5.5):
 *   trust proxy · request id · CORS (dev only) · helmet + report-only CSP · JSON body limits · sign-in limiters.
 * Pure configuration + small factories; app.ts wires them in order.
 */
import { randomUUID, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import express, { type Request, type RequestHandler, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { langOf } from "../../i18n";
import { securityT } from "./i18n";
import { normalizeLoginName } from "./loginGuard";
import { config } from "../../config";


// ─── trust proxy ────────────────────────────────────────────────────────────────────────────────────────
/**
 * Replit Deployments (Reserved VM / Autoscale) put exactly ONE reverse proxy in front of the container (Google
 * Front End → Replit router → our port). That proxy appends the real client address as the LAST entry of
 * X-Forwarded-For, so `trust proxy = 1` (trust one hop) makes `req.ip` the client and ignores anything a client
 * puts in the header itself. Never `true`: that would trust the client-supplied left-most entry (spoofable).
 * TRUST_PROXY overrides: a hop count ("2" behind an extra CDN such as Cloudflare in front of the custom domain),
 * "false"/"0" to disable (local dev without a proxy), or a subnet list ("loopback, 10.0.0.0/8").
 * Verify once after deploy: log `req.ips` + `req.ip` for one request (see the owner checklist).
 */
export function trustProxySetting(raw: string | undefined = config.trustProxy): number | string | false {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return 1;
  if (v === "false" || v === "0" || v === "off") return false;
  if (/^\d+$/.test(v)) return Number(v);
  if (v === "true") return 1; // never trust every hop
  return raw!.trim();
}

// ─── request id ─────────────────────────────────────────────────────────────────────────────────────────
const INCOMING_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** pino-http `genReqId`: reuse a sane incoming X-Request-Id (a proxy's), else a UUID; echo it in the response. */
export function genReqId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers["x-request-id"];
  const id = typeof incoming === "string" && INCOMING_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", id);
  return id;
}

// ─── CORS ───────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Production: the SPA and the API share one origin and auth is a bearer header → no CORS layer at all (a foreign
 * origin simply gets no Access-Control-* headers; nothing throws, nothing becomes a 500).
 * Development: permissive, for the API_TARGET setup (a second Vite dev server on another port proxying here).
 */
export function corsMiddleware(production: boolean = config.isProduction): RequestHandler | null {
  if (production) return null;
  return cors({ origin: true, credentials: false });
}

// ─── CSP ────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * External origins the SPA needs (checked in the code, 2026-10-17):
 *   fonts.googleapis.com (CSS) + fonts.gstatic.com (font files) — index.html;
 *   img https: — user screenshot URLs (any host) and TradingView snapshots (s3.tradingview.com);
 *   media https: — voice notes redirect to a signed object-storage URL (storage.googleapis.com);
 *   frames — academy video embeds: youtube-nocookie.com / youtube.com, player.vimeo.com, loom.com.
 * Everything else (API, chunks, worker, plan media blobs) is same-origin, blob: or data:.
 */
export const CSP_FRAME_SOURCES = [
  "https://www.youtube-nocookie.com",
  "https://www.youtube.com",
  "https://player.vimeo.com",
  "https://www.loom.com",
] as const;

export const CSP_REPORT_PATH = "/api/csp-report";

export function cspDirectives(scriptHashes: readonly string[] = []): Record<string, string[]> {
  return {
    "default-src": ["'self'"],
    "script-src": ["'self'", ...scriptHashes.map((h) => `'${h}'`)],
    // React style= attributes and Recharts emit inline styles; scripts are what matters.
    "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "media-src": ["'self'", "blob:", "https:"],
    "connect-src": ["'self'"],
    "worker-src": ["'self'", "blob:"],
    "frame-src": [...CSP_FRAME_SOURCES],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    "report-uri": [CSP_REPORT_PATH],
    "report-to": ["csp"],
  };
}

/** sha256 hashes of the inline <script> bodies of an HTML document (the theme bootstrap in index.html). */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1];
    if (body.trim()) out.push(`sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`);
  }
  return out;
}

/**
 * helmet with the CSP in REPORT-ONLY mode (violations → POST /api/csp-report → error tracker; enforce after a clean
 * week). The enforced part lives in the <meta> CSP that the Vite build writes into index.html (scripts only).
 * CORP is same-origin now (nothing embeds our resources cross-origin).
 */
export function helmetMiddleware(scriptHashes: readonly string[] = []): RequestHandler {
  return helmet({
    contentSecurityPolicy: { useDefaults: false, reportOnly: true, directives: cspDirectives(scriptHashes) },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-origin" },
  });
}

/** Reporting API endpoint name used by `report-to csp`. */
export function reportingEndpoints(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Reporting-Endpoints", `csp="${CSP_REPORT_PATH}"`);
  next();
}

// ─── JSON bodies ────────────────────────────────────────────────────────────────────────────────────────
export const DEFAULT_JSON_LIMIT = "256kb";

type BodyOverride = { methods: readonly string[]; path: RegExp; limit: string; note: string };

/**
 * Routes that legitimately post more than 256 KB of JSON (paths relative to /api). Uploads (voice notes,
 * PropReports/XLS files) are multipart and plan / playbook screenshots are raw image bodies with their own parsers
 * and limits in the route files, so they are not here.
 */
export const JSON_BODY_OVERRIDES: readonly BodyOverride[] = [
  { methods: ["POST", "PATCH", "PUT"], path: /^\/academy\/content\/(lessons|assignments)(\/\d+)?$/, limit: "1mb", note: "lesson / assignment markdown (bodyMd ≤ 200k chars)" },
  { methods: ["PUT", "POST"], path: /^\/game-plan(\/my)?\/[^/]+$/, limit: "1mb", note: "premarket plan with up to 30 in-play tickers" },
  { methods: ["POST"], path: /^\/game-plan\/templates$/, limit: "1mb", note: "plan templates" },
  { methods: ["PUT"], path: /^\/journal\/days\/[^/]+$/, limit: "1mb", note: "journal day (long free text)" },
  { methods: ["POST", "PATCH"], path: /^\/research(\/\d+)?$/, limit: "1mb", note: "research notes" },
  { methods: ["POST", "PATCH"], path: /^\/playbook(\/\d+)?$/, limit: "1mb", note: "playbook setup (conditions, checklist, notes)" },
  { methods: ["PUT", "PATCH"], path: /^\/author-notes(\/\d+)?$/, limit: "1mb", note: "author notes" },
  { methods: ["POST"], path: /^\/client-errors$/, limit: "32kb", note: "browser error reports" },
];

function bodyLimitFor(method: string, path: string): string {
  const p = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return JSON_BODY_OVERRIDES.find((o) => o.methods.includes(method) && o.path.test(p))?.limit ?? DEFAULT_JSON_LIMIT;
}

/**
 * One JSON parser per limit, picked per request. Mount it AFTER the auth gate, so anonymous requests to private
 * routes are rejected before their body is read. Over the limit → 413 via the error middleware (body-parser
 * `entity.too.large`). No urlencoded parser: nothing posts forms.
 */
export function jsonBody(): RequestHandler {
  const parsers = new Map<string, RequestHandler>();
  const parserFor = (limit: string) => {
    let p = parsers.get(limit);
    if (!p) { p = express.json({ limit }); parsers.set(limit, p); }
    return p;
  };
  return (req, res, next) => parserFor(bodyLimitFor(req.method.toUpperCase(), req.path))(req, res, next);
}

/** CSP reports arrive as application/csp-report (report-uri) or application/reports+json (report-to). */
export const cspReportBody: RequestHandler = express.json({ limit: "16kb", type: ["application/csp-report", "application/reports+json", "application/json"] });

// ─── Limiters ───────────────────────────────────────────────────────────────────────────────────────────
const WINDOW_MS = 15 * 60 * 1000;

function limited(code: string, key: "login.rateLimited" | "body.tooManyRequests") {
  return (req: Request) => ({ error: securityT.tFor(langOf(req))(key), code });
}

/** Body of the login request is needed by the per-name limiter, so parse it (tiny) before the limiters. */
export const loginBody: RequestHandler = express.json({ limit: "4kb" });

/** IP + typed (normalized) name: 10 failed attempts per 15 min. Successful sign-ins never count. */
export function loginNameLimiter(limit = 10): RequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => {
      const name = typeof req.body?.name === "string" ? normalizeLoginName(req.body.name).slice(0, 100) : "";
      return `${ipKeyGenerator(req.ip ?? "")}|${name}`;
    },
    message: limited("RATE_LIMITED", "login.rateLimited"),
  });
}

/** Per IP across all names (password spraying): 50 failed attempts per 15 min. A whole office behind one NAT
 *  signing in successfully never gets near it because successes don't count. */
export function loginIpLimiter(limit = 50): RequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
    message: limited("RATE_LIMITED", "login.rateLimited"),
  });
}

/** POST /client-errors and /csp-report: anonymous-capable, so per IP (60 per 5 min). */
export function reportLimiter(limit = 60): RequestHandler {
  return rateLimit({
    windowMs: 5 * 60 * 1000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => (req.authUser?.id ? `u:${req.authUser.id}` : `ip:${ipKeyGenerator(req.ip ?? "")}`),
    message: limited("RATE_LIMITED", "body.tooManyRequests"),
  });
}
