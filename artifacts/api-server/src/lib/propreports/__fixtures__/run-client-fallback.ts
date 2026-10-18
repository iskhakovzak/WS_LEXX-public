/**
 * Offline test of auth auto-detect: v2 token first, legacy login fallback. fetch is mocked — no network.
 * Run: NODE_ENV=production DATABASE_URL=postgresql://localhost/dummy node <bundle>
 */
import { PropReportsClient, PropReportsError } from "../client";

type Call = { action: string; token?: string; user?: string };
function mockFetch(behaviour: { acceptToken: string | null; loginOk: boolean }, log: Call[]): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body ?? ""));
    const action = params.get("action") ?? "";
    const call: Call = { action };
    if (params.get("token")) call.token = params.get("token")!;
    if (params.get("user")) call.user = params.get("user")!;
    log.push(call);
    const reply = (status: number, text: string) => new Response(text, { status, headers: { "x-api-version": "2.3" } });
    if (action === "login") return behaviour.loginOk ? reply(200, "session:abcdef0123456789") : reply(401, "Invalid credentials");
    if (params.get("token") === behaviour.acceptToken || (params.get("token") === "session:abcdef0123456789" && behaviour.loginOk)) {
      return reply(200, action === "version" ? "2.3.1\n" : "ok");
    }
    return reply(401, "Invalid token");
  }) as typeof fetch;
}

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => { if (!ok) { fails++; console.log("FAIL", name, got); } else console.log("ok  ", name); };
const base = { domain: "demo-firm", userAgent: "test" };

async function main() {
  // 1. static token accepted → v2, no login call ever sent
  {
    const log: Call[] = [];
    const c = new PropReportsClient({ ...base, token: "good-token", user: "u", password: "p" }, { fetchImpl: mockFetch({ acceptToken: "good-token", loginOk: true }, log), persistChecks: false });
    const r = await c.checkConnection();
    check("v2: ok", r.ok === true && r.mode === "v2" && r.version === "2.3.1", r);
    check("v2: no login call", !log.some((l) => l.action === "login"), log);
    check("v2: header recorded", r.apiVersionHeader === "2.3", r.apiVersionHeader);
  }
  // 2. token rejected, credentials present → one login, retry succeeds, mode v1
  {
    const log: Call[] = [];
    const c = new PropReportsClient({ ...base, token: "stale-token", user: "u", password: "p" }, { fetchImpl: mockFetch({ acceptToken: null, loginOk: true }, log), persistChecks: false });
    const r = await c.checkConnection();
    check("fallback: ok via legacy", r.ok === true && r.mode === "v1" && r.version === "2.3.1", r);
    check("fallback: sequence version(stale) → login → version(session)", log.map((l) => l.action).join(">") === "version>login>version" && log[0].token === "stale-token" && log[2].token === "session:abcdef0123456789", log);
    // subsequent calls keep using the session token (no second login)
    await c.version();
    check("fallback: session reused", log.filter((l) => l.action === "login").length === 1, log);
    check("fallback: no password in log entries beyond login", log.every((l) => l.action === "login" || !("user" in l)), log);
  }
  // 3. token rejected, no credentials → graceful error shape, mode null, nothing thrown
  {
    const log: Call[] = [];
    const c = new PropReportsClient({ ...base, token: "stale-token" }, { fetchImpl: mockFetch({ acceptToken: null, loginOk: false }, log), persistChecks: false });
    const r = await c.checkConnection();
    check("no-creds: not ok", r.ok === false && r.mode === null && r.version === null, r);
    check("no-creds: hint mentions env vars", /PROPREPORTS_USER/.test(r.error ?? ""), r.error);
    check("no-creds: no login attempted", !log.some((l) => l.action === "login"), log);
    let threw: unknown = null;
    try { await c.version(); } catch (e) { threw = e; }
    check("no-creds: call throws PropReportsError 401", threw instanceof PropReportsError && threw.status === 401, threw);
  }
  // 4. legacy only (no token): login first, mode v1
  {
    const log: Call[] = [];
    const c = new PropReportsClient({ ...base, user: "u", password: "p" }, { fetchImpl: mockFetch({ acceptToken: null, loginOk: true }, log), persistChecks: false });
    const r = await c.checkConnection();
    check("legacy-only: v1 ok", r.ok === true && r.mode === "v1", r);
    check("legacy-only: login then version", log.map((l) => l.action).join(">") === "login>version", log);
  }
  // 5. bad credentials in legacy mode → error, not a crash
  {
    const log: Call[] = [];
    const c = new PropReportsClient({ ...base, user: "u", password: "wrong" }, { fetchImpl: mockFetch({ acceptToken: null, loginOk: false }, log), persistChecks: false });
    const r = await c.checkConnection();
    check("legacy bad creds: error surfaced", r.ok === false && /401/.test(r.error ?? ""), r);
  }
  if (fails) { console.log(`${fails} CHECK(S) FAILED`); process.exit(1); }
  console.log("ALL CLIENT FALLBACK CHECKS PASSED");
}
main().catch((e) => { console.error(e); process.exit(1); });
