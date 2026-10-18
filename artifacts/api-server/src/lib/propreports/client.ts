/**
 * PropReports web API client (research summary, confirmed against the vendor docs on 2026-10-17:
 * https://propreports.atlassian.net/wiki/spaces/PR/pages/589971/API ("API v2", PropReports ≥ v1.22.12)
 * and https://propreports.atlassian.net/wiki/spaces/PR/pages/589962 (Generic Executions Format)).
 *
 *   Endpoint    POST https://<firm>.propreports.com/api.php  (HTTPS only; body form-urlencoded or multipart)
 *   Auth        every request carries `token`:
 *                 v2 — pre-generated token (Profile → API Tokens, up to 10, revocable)      → PROPREPORTS_TOKEN
 *                 v1 — legacy `action=login&user=&password=` returns a 32-char token (~2 h)  → PROPREPORTS_USER/_PASSWORD
 *               responses carry `X-Api-Version: 1|2`
 *   Rate limit  40 requests / 4 s (~600/min). This client spaces calls ≥ 110 ms apart and retries 429/5xx once.
 *   Pagination  `page` (1-based); CSV body ends with a trailer line `Page X/Y`.
 *               accounts/adjustments/fills/locates/profiles ≤ 50 000 rows per page; positions ≤ 10 000.
 *   Actions     version · accounts(page, groupId?, optionalFields=accountName,groups,…)
 *               groups · fills(startDate, endDate, accountId|groupId, page, symbol?, type?, optionalFields=fillId,propReportsId,…)
 *               positions(startDate, endDate, accountId|groupId, type=all|open|closed|long|short, page)
 *               adjustments · reports · report(type=trades|detailed|performance…, startDate, endDate, accountId|groupId, mode?)
 *               locates · instruments/profiles/upload* (superuser only)
 *   Dates       YYYY-MM-DD. Fill timestamps are naive Eastern Time "YYYY-MM-DD HH:MM:SS.mmm".
 *   CSV shapes  fills:     Date/Time,Account,B/S,Qty,Symbol,Price,Route,Comm,Ecn Fee,SEC,TAF,NSCC,Clr,Misc,Trade Date,Order Id,Status
 *               positions: Date,Account,Qty,Symbol,Avg,Close,Unrealized Delta,Unrealized,Qty Traded,Realized,Comm,Ecn Fee,SEC,TAF,NSCC,Clr,Misc,Currency,Spot Rate
 *               accounts:  Account Id,Account,Groups,Account Name,First Traded,Last Traded,Currency,Cash,Unrealized
 *               groups:    Group Id,Group Name   (negative ids = system groups: -4 "My Accounts", -2 "All Accounts")
 *               report "Summary by Date": Date,Type,Orders,Fills,Qty,Gross,Comm,Ecn Fee,…,Trade Fees,Net,…,End Balance
 *   Fee columns vary by firm configuration/permissions (ORF, NFA, CAT, Acc may appear) — parse-fills maps by header name.
 *   Unconfirmed (needs the owner's account): exact column set of `report&type=trades` over the API (the web XLS
 *   export is what parse-trades-report handles), whether `Account` in fills equals the display name used in
 *   the web exports, and the error body format.
 *
 * Safety: credentials come only from env (never logged, never echoed to clients); nothing in this module
 * runs unless `isConfigured()` and a curator triggers a sync (or PROPREPORTS_SYNC_MINUTES is set).
 */
import { logger } from "../logger";
import { config } from "../../config";
import { parseCsvTable, type CsvTable } from "./csv";
import { parseFillsCsv } from "./parse-fills";
import type { DetectedFeeColumn } from "./fees";
import { getSettings, setSetting, type ConnectionState } from "./settings";
import type { Fill } from "./types";
import { propreportsT } from "../../i18n/ns";
import type { Lang } from "../../i18n";

export interface PropReportsConfig {
  domain: string; // "<firm>" or "<firm>.propreports.com"
  token?: string;
  user?: string;
  password?: string;
  groupId?: string;
  accountIds?: string[];
  userAgent: string;
}

export interface PropReportsStatusConfig {
  configured: boolean;
  domain: string | null;
  authMode: "token" | "login" | null;
  groupId: string | null;
  accountIds: string[];
  syncMinutes: number | null;
  /** Env var names the owner has to put in .env.local (never values). */
  envVars: string[];
  missing: string[];
}

export const ENV_VARS = {
  domain: "PROPREPORTS_DOMAIN",
  token: "PROPREPORTS_TOKEN",
  user: "PROPREPORTS_USER",
  password: "PROPREPORTS_PASSWORD",
  groupId: "PROPREPORTS_GROUP_ID",
  accountIds: "PROPREPORTS_ACCOUNT_IDS",
  syncMinutes: "PROPREPORTS_SYNC_MINUTES",
} as const;

const env = (k: string): string => config.propreportsEnv(k);

export function readConfig(): PropReportsConfig | null {
  const domain = env(ENV_VARS.domain).toLowerCase();
  const token = env(ENV_VARS.token);
  const user = env(ENV_VARS.user);
  const password = env(ENV_VARS.password);
  if (!domain) return null;
  if (!token && !(user && password)) return null;
  return {
    domain,
    token: token || undefined,
    user: user || undefined,
    password: password || undefined,
    groupId: env(ENV_VARS.groupId) || undefined,
    accountIds: env(ENV_VARS.accountIds) ? env(ENV_VARS.accountIds).split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    userAgent: "WS_LEXX-journal/1.0 (propreports-sync)",
  };
}

export function syncMinutes(): number | null {
  const raw = env(ENV_VARS.syncMinutes);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 5 ? Math.round(n) : null;
}

export function statusConfig(lang: Lang = "ru"): PropReportsStatusConfig {
  const cfg = readConfig();
  const missing: string[] = [];
  if (!env(ENV_VARS.domain)) missing.push(ENV_VARS.domain);
  if (!env(ENV_VARS.token) && !(env(ENV_VARS.user) && env(ENV_VARS.password))) missing.push(propreportsT.tFor(lang)("wizard.env.or", { token: ENV_VARS.token, user: ENV_VARS.user, password: ENV_VARS.password }));
  return {
    configured: !!cfg,
    domain: cfg ? hostFor(cfg.domain) : null,
    authMode: cfg ? (cfg.token ? "token" : "login") : null,
    groupId: cfg?.groupId ?? null,
    accountIds: cfg?.accountIds ?? [],
    syncMinutes: syncMinutes(),
    envVars: Object.values(ENV_VARS),
    missing,
  };
}

export function isConfigured(): boolean {
  return readConfig() != null;
}

function hostFor(domain: string): string {
  const d = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(d)) throw new PropReportsError(propreportsT.tFor("ru")("conn.domainInvalid", { name: ENV_VARS.domain }), 0, "conn.domainInvalid", { name: ENV_VARS.domain });
  return d.endsWith(".propreports.com") ? d : `${d}.propreports.com`;
}

export class PropReportsError extends Error {
  /** `propreports` namespace key + params for the message (rendered per reader language), when it is ours. */
  key?: string;
  params?: Record<string, string | number>;
  constructor(message: string, public readonly status: number, key?: string, params?: Record<string, string | number>) {
    super(message);
    this.key = key;
    this.params = params;
    this.name = "PropReportsError";
  }
}

export interface ClientOptions {
  /** Injected for offline tests; defaults to global fetch. Never pointed at a real host in tests. */
  fetchImpl?: typeof fetch;
  /** Persist the result of checkConnection() to propreports_settings (default true; off in tests). */
  persistChecks?: boolean;
}

export type AuthMode = "v2" | "v1";

export interface PropReportsAccount {
  accountId: string;
  account: string;
  accountName: string | null;
  groups: string[];
  firstTraded: string | null;
  lastTraded: string | null;
  currency: string | null;
}

export class PropReportsClient {
  private token: string | null;
  private tokenExpires = 0;
  private lastCall = 0;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly persistChecks: boolean;
  /** Detected auth mode: "v2" = static API token accepted, "v1" = legacy login (token rejected or absent). */
  mode: AuthMode | null = null;
  apiVersionHeader: string | null = null;
  lastCheck: ConnectionState = { checkedAt: null, ok: null, mode: null, version: null, error: null };
  /** Group chosen in the UI (settings); env PROPREPORTS_GROUP_ID wins, then this, then "-4" (My Accounts). */
  defaultGroupId: string | null = null;

  constructor(private readonly cfg: PropReportsConfig, opts: ClientOptions = {}) {
    this.url = `https://${hostFor(cfg.domain)}/api.php`;
    this.token = cfg.token ?? null;
    if (cfg.token) this.tokenExpires = Number.POSITIVE_INFINITY;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.persistChecks = opts.persistChecks ?? true;
  }

  get host(): string { return hostFor(this.cfg.domain); }
  get hasStaticToken(): boolean { return !!this.cfg.token; }
  get hasLoginCredentials(): boolean { return !!(this.cfg.user && this.cfg.password); }

  private groupFor(explicit?: string): string { return explicit ?? this.cfg.groupId ?? this.defaultGroupId ?? "-4"; }

  private async throttle(): Promise<void> {
    const wait = this.lastCall + 110 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCall = Date.now();
  }

  private async post(params: Record<string, string>, retry = true): Promise<{ text: string; apiVersion: string | null }> {
    await this.throttle();
    const body = new URLSearchParams(params);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": this.cfg.userAgent, Accept: "text/csv, text/plain" },
        body,
        signal: ctrl.signal,
      });
      const text = await res.text();
      this.apiVersionHeader = res.headers.get("x-api-version") ?? this.apiVersionHeader;
      // Some installations answer 200 with an error line instead of an HTTP status.
      if (res.ok && /^(error|invalid (token|credentials|login)|unauthori[sz]ed|access denied|authentication (failed|required))/i.test(text.trim())) {
        throw new PropReportsError(`PropReports ${params.action}: ${text.trim().slice(0, 200)}`, 401);
      }
      if (!res.ok) {
        if (retry && (res.status === 429 || res.status >= 500)) {
          await new Promise((r) => setTimeout(r, 2000));
          return this.post(params, false);
        }
        throw new PropReportsError(`PropReports ${params.action}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
      }
      return { text, apiVersion: res.headers.get("x-api-version") };
    } catch (e) {
      if (e instanceof PropReportsError) throw e;
      throw new PropReportsError(`PropReports ${params.action}: ${e instanceof Error ? e.message : String(e)}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }

  /** v1 legacy login → ~2 h token; v2 tokens are static. */
  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpires) return this.token;
    if (!this.cfg.user || !this.cfg.password) throw new PropReportsError(propreportsT.tFor("ru")("conn.noCredentials"), 0, "conn.noCredentials");
    this.mode = "v1";
    const { text } = await this.post({ action: "login", user: this.cfg.user, password: this.cfg.password });
    const tok = text.trim();
    if (!/^[A-Za-z0-9:]{16,128}$/.test(tok)) throw new PropReportsError(propreportsT.tFor("ru")("conn.loginUnexpected"), 0, "conn.loginUnexpected");
    this.token = tok;
    this.tokenExpires = Date.now() + 100 * 60 * 1000; // docs: ~2 h; refresh after 100 min
    return tok;
  }

  /**
   * Auth auto-detect: the static v2 token is tried first; when the server rejects it (401/403 or an error
   * body) and legacy credentials exist, the client switches to v1 login once and retries the same call.
   */
  async call(action: string, params: Record<string, string> = {}): Promise<string> {
    const token = await this.ensureToken();
    try {
      const { text } = await this.post({ action, ...params, token });
      if (this.mode == null) this.mode = this.cfg.token && token === this.cfg.token ? "v2" : "v1";
      return text;
    } catch (e) {
      const auth = e instanceof PropReportsError && (e.status === 401 || e.status === 403);
      const usingStatic = !!this.cfg.token && token === this.cfg.token;
      if (auth && usingStatic && this.hasLoginCredentials) {
        logger.warn({ action }, "propreports: API token rejected, falling back to legacy login");
        this.token = null; this.tokenExpires = 0; this.mode = "v1";
        const fresh = await this.ensureToken();
        const { text } = await this.post({ action, ...params, token: fresh });
        return text;
      }
      throw e;
    }
  }

  /**
   * Read-only connection probe (action=version). Records the detected mode and persists it for the setup
   * wizard; never throws — the result carries the error text instead.
   */
  async checkConnection(): Promise<ConnectionState & { apiVersionHeader: string | null; host: string }> {
    let version: string | null = null;
    let error: string | null = null;
    let errorKey: string | undefined;
    let errorParams: Record<string, string | number> | undefined;
    try {
      version = await this.version();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      if (e instanceof PropReportsError && e.key) { errorKey = e.key; errorParams = e.params; }
      if (e instanceof PropReportsError && (e.status === 401 || e.status === 403)) {
        const tokenOnly = this.hasStaticToken && !this.hasLoginCredentials;
        errorKey = tokenOnly ? "conn.tokenRejected" : "conn.authRejected";
        errorParams = tokenOnly ? { status: e.status, user: ENV_VARS.user, password: ENV_VARS.password } : { status: e.status, error };
        error = propreportsT.tryFor("ru", errorKey, errorParams) ?? error;
      }
    }
    const state: ConnectionState = {
      checkedAt: new Date().toISOString(),
      ok: error == null,
      mode: error == null ? (this.mode ?? (this.hasStaticToken ? "v2" : "v1")) : null,
      version,
      error,
      ...(errorKey ? { errorKey, errorParams } : {}),
    };
    this.lastCheck = state;
    if (this.persistChecks) await setSetting("connection", state).catch((err) => logger.warn({ err }, "propreports: could not persist connection check"));
    return { ...state, apiVersionHeader: this.apiVersionHeader, host: this.host };
  }

  async callCsv(action: string, params: Record<string, string> = {}): Promise<CsvTable> {
    return parseCsvTable(await this.call(action, params));
  }

  /** Follows the `Page X/Y` trailer; the header row is kept once. */
  async callCsvAllPages(action: string, params: Record<string, string> = {}, maxPages = 50): Promise<CsvTable> {
    const first = await this.callCsv(action, { ...params, page: "1" });
    const total = Math.min(first.page?.total ?? 1, maxPages);
    for (let p = 2; p <= total; p++) {
      const next = await this.callCsv(action, { ...params, page: String(p) });
      first.rows.push(...next.rows);
    }
    if ((first.page?.total ?? 1) > maxPages) logger.warn({ action, total: first.page?.total }, "propreports: page cap reached");
    return first;
  }

  async version(): Promise<string> {
    return (await this.call("version")).trim();
  }

  async accounts(): Promise<PropReportsAccount[]> {
    const params: Record<string, string> = { optionalFields: "accountName,groups" };
    const g = this.groupFor();
    if (g !== "-4") params.groupId = g;
    const t = await this.callCsvAllPages("accounts", params);
    const col = (name: string) => t.header.findIndex((h) => h.trim().toLowerCase() === name);
    const iId = col("account id"), iAcc = col("account"), iName = col("account name"), iGroups = col("groups"), iFirst = col("first traded"), iLast = col("last traded"), iCur = col("currency");
    return t.rows
      .filter((r) => iAcc >= 0 && (r[iAcc] ?? "").trim())
      .map((r) => ({
        accountId: iId >= 0 ? (r[iId] ?? "").trim() : "",
        account: (r[iAcc] ?? "").trim(),
        accountName: iName >= 0 ? (r[iName] ?? "").trim() || null : null,
        groups: iGroups >= 0 ? (r[iGroups] ?? "").split("|").map((s) => s.trim()).filter(Boolean) : [],
        firstTraded: iFirst >= 0 ? (r[iFirst] ?? "").trim() || null : null,
        lastTraded: iLast >= 0 ? (r[iLast] ?? "").trim() || null : null,
        currency: iCur >= 0 ? (r[iCur] ?? "").trim() || null : null,
      }));
  }

  async groups(): Promise<Array<{ groupId: string; name: string }>> {
    const t = await this.callCsv("groups");
    return t.rows.map((r) => ({ groupId: (r[0] ?? "").trim(), name: (r[1] ?? "").trim() })).filter((g) => g.groupId);
  }

  /** Fills for a date range; scope = accountIds (comma list) or groupId (defaults to env, then "-4" My Accounts). */
  async fills(startDate: string, endDate: string, scope: { accountIds?: string[]; groupId?: string; lang?: Lang } = {}): Promise<{ fills: Fill[]; raw: string; issues: Array<{ line: number; message: string }>; feeColumns: DetectedFeeColumn[] }> {
    const params: Record<string, string> = { startDate, endDate, optionalFields: "fillId,propReportsId" };
    const accountIds = scope.accountIds ?? this.cfg.accountIds;
    if (accountIds?.length) params.accountId = accountIds.join(",");
    else params.groupId = this.groupFor(scope.groupId);
    // Re-assemble pages into one CSV text so the file parser is the single source of truth.
    const t = await this.callCsvAllPages("fills", params);
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const raw = [t.header, ...t.rows].map((r) => r.map(esc).join(",")).join("\n");
    const parsed = parseFillsCsv(raw, scope.lang);
    return { fills: parsed.fills, raw, issues: parsed.issues, feeColumns: parsed.feeColumns };
  }

  async positions(startDate: string, endDate: string, type: "all" | "open" | "closed" | "long" | "short" = "open", scope: { accountIds?: string[]; groupId?: string } = {}): Promise<CsvTable> {
    const params: Record<string, string> = { startDate, endDate, type };
    const accountIds = scope.accountIds ?? this.cfg.accountIds;
    if (accountIds?.length) params.accountId = accountIds.join(",");
    else params.groupId = this.groupFor(scope.groupId);
    return this.callCsvAllPages("positions", params);
  }

  async report(type: string, startDate: string, endDate: string, scope: { accountId?: string; groupId?: string }, mode?: string): Promise<string> {
    const params: Record<string, string> = { type, startDate, endDate };
    if (scope.accountId) params.accountId = scope.accountId; else params.groupId = this.groupFor(scope.groupId);
    if (mode) params.mode = mode;
    return this.call("report", params);
  }
}

let shared: PropReportsClient | null = null;
/** Lazily built from env; returns null when not configured. */
export function getClient(): PropReportsClient | null {
  const cfg = readConfig();
  if (!cfg) return null;
  if (!shared || shared.host !== hostFor(cfg.domain)) shared = new PropReportsClient(cfg);
  return shared;
}

/** getClient() + UI settings applied (group chosen in /integrations; env still wins). */
export async function getConfiguredClient(): Promise<PropReportsClient | null> {
  const client = getClient();
  if (!client) return null;
  const settings = await getSettings().catch(() => null);
  client.defaultGroupId = settings?.groupId ?? null;
  return client;
}

/** Effective group for API calls: env → settings → "-4" (My Accounts). */
export function effectiveGroupId(settingsGroupId: string | null | undefined): { groupId: string; source: "env" | "settings" | "default" } {
  const envGroup = env(ENV_VARS.groupId);
  if (envGroup) return { groupId: envGroup, source: "env" };
  if (settingsGroupId) return { groupId: settingsGroupId, source: "settings" };
  return { groupId: "-4", source: "default" };
}
