/**
 * A1 security, end to end through the REAL app (src/app.ts) with the DB mocked:
 * typed-name login (resolve / generic error / lockout / limiter), staff forced password change, JWT (HS256 only,
 * sliding refresh, no ?access_token), JSON body limits (413), GET /users behind auth, CORS, request id,
 * report-only CSP, client error reports.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "vitest-only-secret-for-auth-security";

type U = { id: number; name: string; name_latin: string | null; role: string; password_hash: string; banned: boolean; token_version: number; must_change_secret?: boolean };
const users: U[] = [];
const recorded: unknown[][] = [];

vi.mock("@workspace/db", () => ({
  db: { insert: () => ({ values: async () => undefined }) },
  setPoolErrorHandler: () => undefined,
  pool: {
    connect: async () => { throw new Error("no pg in tests"); },
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/FROM users WHERE active = true\s*$/.test(sql.trim()) || /password_hash, role, COALESCE\(banned, false\) AS banned, must_change_secret\s+FROM users WHERE active = true/.test(sql)) {
        return { rows: users.map((u) => ({ id: u.id, name: u.name, name_latin: u.name_latin, password_hash: u.password_hash, role: u.role, banned: u.banned, must_change_secret: !!u.must_change_secret })), rowCount: users.length };
      }
      if (/SELECT must_change_secret AS m FROM users WHERE id = \$1/.test(sql)) {
        const u = users.find((x) => x.id === params[0]);
        return { rows: u ? [{ m: !!u.must_change_secret }] : [], rowCount: u ? 1 : 0 };
      }
      if (/SELECT token_version FROM users WHERE id = \$1/.test(sql)) {
        const u = users.find((x) => x.id === params[0]);
        return { rows: u ? [{ token_version: u.token_version }] : [], rowCount: u ? 1 : 0 };
      }
      if (/UPDATE users SET token_version = token_version \+ 1/.test(sql)) {
        const u = users.find((x) => x.id === params[0]);
        if (u) u.token_version++;
        return { rows: [], rowCount: u ? 1 : 0 };
      }
      if (/SELECT password_hash, role, name FROM users WHERE id = \$1/.test(sql)) {
        const u = users.find((x) => x.id === params[0]);
        return { rows: u ? [{ password_hash: u.password_hash, role: u.role, name: u.name }] : [], rowCount: u ? 1 : 0 };
      }
      if (/UPDATE users SET password_hash = \$1, must_change_secret = false WHERE id = \$2/.test(sql)) {
        const u = users.find((x) => x.id === params[1]);
        if (u) { u.password_hash = String(params[0]); u.must_change_secret = false; }
        return { rows: [], rowCount: u ? 1 : 0 };
      }
      if (/INSERT INTO app_errors/.test(sql)) {
        recorded.push(params);
        return { rows: [{ id: "1", count: 1, inserted: true, reopened: false }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  },
}));
vi.mock("@workspace/integrations-anthropic-ai", () => ({ anthropic: {}, getAnthropic: () => ({}), isAnthropicConfigured: () => false, AnthropicNotConfiguredError: class extends Error {} }));
vi.mock("../../lib/audit", () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock("../../lib/permissions", async (orig) => ({
  ...(await orig<typeof import("../../lib/permissions")>()),
  can: vi.fn(async () => false),
  requireCap: vi.fn(async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => { res.status(403).json({ error: "forbidden", code: "FORBIDDEN" }); return false; }),
}));

const { setLockoutStore, memoryLockoutStore } = await import("../../lib/security/loginGuard");
const { default: app } = await import("../../app");

let server: http.Server;
let base = "";
let ipCounter = 0;
/** Each test gets its own client IP (X-Forwarded-For through `trust proxy = 1`), so limiter buckets don't leak. */
let ip = "203.0.113.1";

async function call(method: string, path: string, opts: { body?: unknown; token?: string; headers?: Record<string, string>; raw?: string } = {}) {
  const headers: Record<string, string> = { "X-Forwarded-For": ip, ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.raw !== undefined) { body = opts.raw; headers["Content-Type"] ??= "application/json"; }
  else if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers["Content-Type"] = "application/json"; }
  const r = await fetch(`${base}/api${path}`, { method, headers, body });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json, headers: r.headers };
}
const login = (name: string, password: string) => call("POST", "/auth/login", { body: { name, password } });

beforeAll(async () => {
  users.push(
    { id: 1, name: "Закир", name_latin: "Zakir Ishakov", role: "trader", password_hash: await bcrypt.hash("135790", 4), banned: false, token_version: 0 },
    { id: 2, name: "Антон", name_latin: null, role: "curator", password_hash: await bcrypt.hash("246810", 4), banned: false, token_version: 0 },
    { id: 3, name: "Артур", name_latin: null, role: "trader", password_hash: await bcrypt.hash("111222", 4), banned: false, token_version: 0 },
    { id: 4, name: "Дмитрий К.", name_latin: null, role: "admin", password_hash: await bcrypt.hash("long-admin-pass", 4), banned: false, token_version: 0 },
    { id: 5, name: "Умид", name_latin: null, role: "trader", password_hash: await bcrypt.hash("000000", 4), banned: false, token_version: 0, must_change_secret: true },
  );
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  setLockoutStore(memoryLockoutStore());
  ip = `203.0.113.${++ipCounter}`;
});

describe("typed-name login", () => {
  it("resolves a Latin spelling and returns a token (no forced change for traders)", async () => {
    const r = await login("zakir", "135790");
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ id: 1, name: "Закир", role: "trader" });
    expect(r.json.mustChangePassword).toBe(false);
    expect(jwt.decode(r.json.token, { complete: true })?.header.alg).toBe("HS256");
  });

  it("unknown name and wrong PIN get the same generic answer", async () => {
    const a = await login("Никто Такой", "135790");
    const b = await login("Закир", "000000");
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.json).toEqual(b.json);
    expect(a.json.code).toBe("INVALID_CREDENTIALS");
  });

  it("5 failures lock that account (429 LOGIN_LOCKED + Retry-After) even for the right PIN; another name is unaffected", async () => {
    for (let i = 0; i < 4; i++) expect((await login("Артур", "999999")).status).toBe(401);
    const locked = await login("Артур", "999999");
    expect(locked.status).toBe(429);
    expect(locked.json.code).toBe("LOGIN_LOCKED");
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(800);
    expect((await login("Артур", "111222")).status).toBe(429);
    // Another person from the same IP signs in fine.
    expect((await login("Закир", "135790")).status).toBe(200);
  });

  it("unknown names lock the same way (no enumeration through the lock)", async () => {
    let last = 0;
    for (let i = 0; i < 5; i++) last = (await login("Призрак", "123456")).status;
    expect(last).toBe(429);
  });

  it("IP + name limiter: successes never count, failures do, another name keeps working", async () => {
    for (let i = 0; i < 12; i++) expect((await login("Закир", "135790")).status).toBe(200);
    setLockoutStore({ ...memoryLockoutStore(), fail: async () => ({ locked: false, failures: 1 }) }); // isolate the limiter
    for (let i = 0; i < 10; i++) expect((await login("Антон", "wrong-pin")).status).toBe(401);
    const limited = await login("Антон", "wrong-pin");
    expect(limited.status).toBe(429);
    expect(limited.json.code).toBe("RATE_LIMITED");
    expect((await login("Закир", "135790")).status).toBe(200);
  });

  it("GET /users needs a token (no roster before sign-in)", async () => {
    expect((await call("GET", "/users")).status).toBe(401);
    const t = (await login("Закир", "135790")).json.token;
    expect((await call("GET", "/users", { token: t })).status).toBe(200);
  });
});

describe("staff forced password change", () => {
  it("short staff password → pwc token limited to the change; a valid change returns a working token", async () => {
    const r = await login("Антон", "246810");
    expect(r.status).toBe(200);
    expect(r.json.mustChangePassword).toBe(true);
    expect(r.json.secretPolicy).toMatchObject({ kind: "password", min: 10 });
    const pwc = r.json.token as string;

    const blocked = await call("GET", "/users", { token: pwc });
    expect(blocked.status).toBe(403);
    expect(blocked.json.code).toBe("PASSWORD_CHANGE_REQUIRED");
    const me = await call("GET", "/auth/me", { token: pwc });
    expect(me.status).toBe(200);
    expect(me.json.mustChangePassword).toBe(true);

    const weak = await call("POST", "/users/me/password", { token: pwc, body: { currentPassword: "246810", newPassword: "short1234" } });
    expect(weak.status).toBe(400);
    expect(weak.json.code).toBe("WEAK_PASSWORD");

    const ok = await call("POST", "/users/me/password", { token: pwc, body: { currentPassword: "246810", newPassword: "a-much-longer-pass" } });
    expect(ok.status).toBe(200);
    expect(typeof ok.json.token).toBe("string");
    expect((await call("GET", "/users", { token: ok.json.token })).status).toBe(200);
    // The old pwc token is revoked (token_version bumped).
    expect((await call("GET", "/auth/me", { token: pwc })).status).toBe(401);
    // Next sign-in with the new password: no forced change.
    expect((await login("Антон", "a-much-longer-pass")).json.mustChangePassword).toBe(false);
  });

  it("an issued secret (first sign-in) forces a trader to set an own PIN, then signs in normally", async () => {
    const r = await login("Умид", "000000");
    expect(r.status).toBe(200);
    expect(r.json.mustChangePassword).toBe(true);
    expect(r.json.mustChangeReason).toBe("first");
    expect(r.json.secretPolicy).toMatchObject({ kind: "pin", min: 6 });
    const pwc = r.json.token as string;
    expect((await call("GET", "/users", { token: pwc })).json.code).toBe("PASSWORD_CHANGE_REQUIRED");
    expect((await call("GET", "/auth/me", { token: pwc })).json.mustChangeReason).toBe("first");
    const same = await call("POST", "/users/me/password", { token: pwc, body: { currentPassword: "000000", newPassword: "000000" } });
    expect(same.json.code).toBe("SAME_PASSWORD");
    const ok = await call("POST", "/users/me/password", { token: pwc, body: { currentPassword: "000000", newPassword: "482915" } });
    expect(ok.status).toBe(200);
    const again = await login("Умид", "482915");
    expect(again.json.mustChangePassword).toBe(false);
    expect(again.json.mustChangeReason).toBeUndefined();
    expect((await login("Умид", "000000")).status).toBe(401);
  });

  it("staff with a long password sign in normally", async () => {
    const r = await login("Дмитрий К.", "long-admin-pass");
    expect(r.json.mustChangePassword).toBe(false);
  });
});

describe("JWT", () => {
  const secret = process.env.JWT_SECRET!;
  it("rejects tokens signed with another algorithm", async () => {
    const hs512 = jwt.sign({ sub: 1, name: "Закир", role: "trader", tv: 0 }, secret, { algorithm: "HS512" });
    expect((await call("GET", "/auth/me", { token: hs512 })).status).toBe(401);
    const none = jwt.sign({ sub: 1, name: "Закир", role: "trader", tv: 0 }, "", { algorithm: "none" as jwt.Algorithm });
    expect((await call("GET", "/auth/me", { token: none })).status).toBe(401);
  });

  it("7-day TTL; /auth/me re-issues a token older than 24 h, not a fresh one", async () => {
    const fresh = (await login("Закир", "135790")).json.token as string;
    const d = jwt.decode(fresh) as { iat: number; exp: number };
    expect(d.exp - d.iat).toBe(7 * 24 * 3600);
    expect((await call("GET", "/auth/me", { token: fresh })).json.token).toBeUndefined();
    const tv = users.find((u) => u.id === 1)!.token_version;
    const old = jwt.sign({ sub: 1, name: "Закир", role: "trader", tv, iat: Math.floor(Date.now() / 1000) - 25 * 3600 }, secret, { algorithm: "HS256", expiresIn: "6d" });
    const me = await call("GET", "/auth/me", { token: old });
    expect(me.status).toBe(200);
    expect(typeof me.json.token).toBe("string");
    expect((jwt.decode(me.json.token) as { iat: number }).iat).toBeGreaterThan(Math.floor(Date.now() / 1000) - 60);
  });

  it("?access_token= is not accepted", async () => {
    const t = (await login("Закир", "135790")).json.token as string;
    const r = await fetch(`${base}/api/users?access_token=${encodeURIComponent(t)}`, { headers: { "X-Forwarded-For": ip } });
    expect(r.status).toBe(401);
  });
});

describe("body limits", () => {
  it("> 256 KB JSON → 413 on a normal route", async () => {
    const t = (await login("Закир", "135790")).json.token as string;
    const big = JSON.stringify({ text: "x".repeat(300 * 1024) });
    const r = await call("PUT", "/users/me/settings", { token: t, raw: big });
    expect(r.status).toBe(413);
  });

  it("the per-route override lets a long lesson body through the parser (no 413)", async () => {
    const t = (await login("Закир", "135790")).json.token as string;
    const big = JSON.stringify({ moduleId: 1, title: "x", bodyMd: "y".repeat(300 * 1024) });
    const r = await call("POST", "/academy/content/lessons", { token: t, raw: big });
    expect(r.status).not.toBe(413);
  });

  it("anonymous requests to private routes are rejected before the body is read", async () => {
    const r = await call("PUT", "/users/me/settings", { raw: JSON.stringify({ x: "y".repeat(300 * 1024) }) });
    expect(r.status).toBe(401);
  });
});

describe("headers", () => {
  it("X-Request-Id on every response; report-only CSP; no x-powered-by", async () => {
    const r = await fetch(`${base}/api/healthz`);
    expect(r.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.headers.get("content-security-policy-report-only")).toContain("frame-ancestors 'none'");
    expect(r.headers.get("content-security-policy")).toBeNull();
    expect(r.headers.get("x-powered-by")).toBeNull();
  });

  it("dev CORS answers a foreign origin (API_TARGET setup)", async () => {
    const r = await fetch(`${base}/api/healthz`, { headers: { Origin: "http://localhost:24460" } });
    expect(r.headers.get("access-control-allow-origin")).toBe("http://localhost:24460");
  });
});

describe("client error reports", () => {
  it("POST /client-errors works without a session and is stored scrubbed", async () => {
    recorded.length = 0;
    const r = await call("POST", "/client-errors", { body: { kind: "error", name: "TypeError", message: "x is undefined token=abc123secret", page: "/journal?id=5" } });
    expect(r.status).toBe(204);
    expect(recorded).toHaveLength(1);
    expect(JSON.stringify(recorded[0])).not.toContain("abc123secret");
    expect(JSON.stringify(recorded[0])).not.toContain("?id=5");
  });

  it("rejects malformed reports", async () => {
    expect((await call("POST", "/client-errors", { body: { kind: "nope", message: 1 } })).status).toBe(400);
  });
});
