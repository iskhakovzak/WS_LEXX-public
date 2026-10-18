/**
 * Global API gate (lib/auth apiAuthGate), table-driven over PUBLIC_API_ROUTES so the test follows the allowlist:
 *   - every public route passes for an anonymous caller;
 *   - every other route answers 401 AUTH_REQUIRED to an anonymous caller;
 *   - a guest may read but every mutation (except POST /auth/logout) is 403 GUEST_READ_ONLY;
 *   - a member passes.
 * The signed-in identity is injected (no JWT / DB): this tests the gate's rules, not token parsing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, { type Request } from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("@workspace/db", () => ({ db: {}, pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }));
process.env.JWT_SECRET ??= "vitest-only-secret";
const { apiAuthGate, PUBLIC_API_ROUTES } = await import("../../auth");

type Who = "anon" | "guest" | "member";
const USERS: Record<Who, unknown> = {
  anon: undefined,
  guest: { id: 0, name: "Гость", role: "guest" },
  member: { id: 1, name: "Закир", role: "trader" },
};

/** A concrete path for an allowlist entry (RegExp entries: `\d+` → 1, `[^/]+` → x). */
function samplePath(p: string | RegExp): string {
  if (typeof p === "string") return p;
  const s = p.source.replace(/^\^/, "").replace(/\$$/, "").replace(/\\d\+/g, "1").replace(/\[\^\/\]\+/g, "x").replace(/\\\//g, "/");
  if (!p.test(s)) throw new Error(`authGate.test: add a sample path for ${p}`);
  return s;
}

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.authUser = USERS[(req.get("x-who") ?? "anon") as Who] as Request["authUser"];
    next();
  });
  // Same mount as app.ts: the gate sees paths relative to /api.
  app.use("/api", apiAuthGate, (_req, res) => { res.status(200).json({ passed: true }); });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function call(method: string, path: string, who: Who) {
  const r = await fetch(`${base}/api${path}`, { method, headers: { "x-who": who } });
  const text = await r.text();
  let body: Record<string, unknown> | null = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: r.status, body };
}

const PUBLIC = PUBLIC_API_ROUTES.map((r) => ({ method: r.method, path: samplePath(r.path) }));
const MUTATIONS = ["POST", "PATCH", "PUT", "DELETE"] as const;
/** Representative member routes across areas (none is public). */
const PRIVATE_SAMPLES: Array<[string, string]> = [
  ["GET", "/trades"], ["GET", "/trades/42"], ["GET", "/users/all"], ["GET", "/dashboard"], ["GET", "/playbook"],
  ["GET", "/admin/console/people"], ["GET", "/permissions/matrix"], ["GET", "/voice-notes/1"], ["GET", "/auth/me"],
  ["POST", "/trades/42/reviews"], ["PATCH", "/watchlist/1"], ["PUT", "/game-plan/my/2026-10-16"], ["DELETE", "/playbook/1"],
  ["POST", "/checklist-template"], ["POST", "/auth/logout"], ["POST", "/telegram/broadcast"],
];
const GUEST_MUTATION_SAMPLES: Array<[string, string]> = [
  ["POST", "/trades/42/reviews"], ["PATCH", "/watchlist/1"], ["PUT", "/game-plan/my/2026-10-16"], ["DELETE", "/playbook/1"],
  ["POST", "/checklist-template"], ["POST", "/telegram/broadcast"], ["PATCH", "/users/me/settings"], ["POST", "/notifications/read-all"],
  ["DELETE", "/watchlist/1"], ["POST", "/admin/console/people"],
];

describe("apiAuthGate: public allowlist", () => {
  it("has entries", () => expect(PUBLIC.length).toBeGreaterThan(3));

  it.each(PUBLIC)("$method $path passes for an anonymous caller", async ({ method, path }) => {
    expect(await call(method, path, "anon")).toEqual({ status: 200, body: { passed: true } });
  });

  it.each(PUBLIC.filter((r) => r.method === "GET"))("HEAD $path is public like GET", async ({ path }) => {
    expect((await call("HEAD", path, "anon")).status).toBe(200);
  });

  it.each(PUBLIC.filter((r) => typeof r.path === "string" && r.path !== "/"))("trailing slash on $path is the same route", async ({ method, path }) => {
    expect((await call(method, `${path}/`, "anon")).status).toBe(200);
  });

  it.each(PUBLIC)("only the listed method is public: other methods on $path need auth", async ({ method, path }) => {
    const other = method === "GET" ? "POST" : "GET";
    if (PUBLIC.some((p) => p.method === other && p.path === path)) return;
    expect((await call(other, path, "anon")).status).toBe(401);
  });

  it("CORS preflight (OPTIONS) always passes", async () => {
    expect((await call("OPTIONS", "/trades", "anon")).status).toBe(200);
  });
});

describe("apiAuthGate: anonymous", () => {
  it.each(PRIVATE_SAMPLES)("%s %s → 401 AUTH_REQUIRED", async (method, path) => {
    const r = await call(method, path, "anon");
    expect(r.status).toBe(401);
    expect(r.body?.code).toBe("AUTH_REQUIRED");
  });
});

describe("apiAuthGate: guest", () => {
  it.each(GUEST_MUTATION_SAMPLES)("%s %s → 403 GUEST_READ_ONLY", async (method, path) => {
    const r = await call(method, path, "guest");
    expect(r.status).toBe(403);
    expect(r.body?.code).toBe("GUEST_READ_ONLY");
  });

  it.each(MUTATIONS)("every mutation method is blocked (%s)", async (method) => {
    expect((await call(method, "/anything/at/all", "guest")).body?.code).toBe("GUEST_READ_ONLY");
  });

  it("reads pass (routes then scope the data)", async () => {
    expect((await call("GET", "/trades", "guest")).status).toBe(200);
    expect((await call("GET", "/dashboard", "guest")).status).toBe(200);
  });

  it("POST /auth/logout is the one allowed guest mutation", async () => {
    expect((await call("POST", "/auth/logout", "guest")).status).toBe(200);
  });
});

describe("apiAuthGate: member", () => {
  it.each(PRIVATE_SAMPLES)("%s %s passes (capabilities are checked by the route)", async (method, path) => {
    expect((await call(method, path, "member")).status).toBe(200);
  });
});
