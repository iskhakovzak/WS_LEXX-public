/**
 * Latin display names: the admin bulk edit (POST /admin/console/people/name-latin/bulk) and the self-service edit
 * (PATCH /users/me/name-latin). The DB, permissions and the display table are mocked: the tests read the SQL sent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

type Q = { sql: string; params: unknown[] };
const calls: Q[] = [];
let manage = true;
let manageAdmins = false;
let me: { id: number; name: string; role: string } = { id: 121, name: "Дмитрий К.", role: "admin" };
const USERS = [
  { id: 1, name: "Закир", role: "trader", name_latin: null as string | null },
  { id: 3, name: "Артур", role: "trader", name_latin: "Artur" },
  { id: 2, name: "Антон", role: "curator", name_latin: null },
  { id: 121, name: "Дмитрий К.", role: "admin", name_latin: null },
  { id: 122, name: "Ольга Н.", role: "admin", name_latin: null },
];

function answer(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });
  if (/SELECT id, name, role FROM users WHERE id = ANY/.test(sql)) {
    const ids = params[0] as number[];
    const rows = USERS.filter((u) => ids.includes(u.id)).map(({ id, name, role }) => ({ id, name, role }));
    return { rows, rowCount: rows.length };
  }
  if (/^\s*UPDATE users u SET name_latin/.test(sql)) {
    const u = USERS.find((x) => x.id === params[1]);
    return u ? { rows: [{ prev: u.name_latin }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  return { rows: [], rowCount: 0 };
}

vi.mock("@workspace/db", () => ({
  db: {},
  pool: {
    query: vi.fn(async (sql: string, params?: unknown[]) => answer(sql, params)),
    connect: vi.fn(async () => ({ query: vi.fn(async (sql: string, params?: unknown[]) => answer(sql, params)), release: vi.fn() })),
  },
}));
vi.mock("@workspace/integrations-anthropic-ai", () => ({ anthropic: {}, getAnthropic: () => ({}), isAnthropicConfigured: () => false, AnthropicNotConfiguredError: class extends Error {} }));
const reload = vi.fn(async () => undefined);
vi.mock("../../lib/people/latinNames", () => ({ reloadLatinNames: reload, personNameFor: (n: string) => n, personNamesFor: (n: string[]) => n, touchLatinNames: () => undefined }));
vi.mock("../../lib/permissions", async (orig) => ({
  ...(await orig<typeof import("../../lib/permissions")>()),
  can: vi.fn(async (_req: unknown, cap: string) => (cap === "users.manage.admins" ? manageAdmins : manage)),
  requireCap: vi.fn(async (_req: unknown, res: express.Response) => {
    if (manage) return true;
    res.status(403).json({ error: "forbidden", code: "FORBIDDEN" });
    return false;
  }),
  resolveActor: vi.fn(async () => ({ id: me.id, name: me.name, role: me.role })),
}));

// lib/auth reads JWT_SECRET at import time; the routes are imported after the mocks are registered.
process.env.JWT_SECRET ??= "vitest-only-secret";
const { default: adminRouter } = await import("../admin-console");
const { default: usersRouter } = await import("../users");
const { errorMiddleware } = await import("../../lib/http");

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { authUser: unknown }).authUser = me; next(); });
  app.use("/api", adminRouter);
  app.use("/api", usersRouter);
  app.use(errorMiddleware);
  server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  calls.length = 0;
  reload.mockClear();
  manage = true;
  manageAdmins = false;
  me = { id: 121, name: "Дмитрий К.", role: "admin" };
});

async function send(method: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const updates = () => calls.filter((c) => /^\s*UPDATE users u SET name_latin/.test(c.sql));
const audits = () => calls.filter((c) => /INSERT INTO audit_log/.test(c.sql));

describe("POST /admin/console/people/name-latin/bulk", () => {
  it("saves every item in one transaction with one audit entry per changed user", async () => {
    const r = await send("POST", "/api/admin/console/people/name-latin/bulk", {
      items: [{ id: 1, nameLatin: "  Zakir " }, { id: 3, nameLatin: "Artur" }, { id: 2, nameLatin: "Anton" }],
    });
    expect(r.status).toBe(200);
    expect(r.json.changed.map((c: { nameLatin: string }) => c.nameLatin)).toEqual(["Zakir", "Anton"]);
    expect(r.json.unchanged).toBe(1);
    expect(calls.map((c) => c.sql.trim())).toContain("BEGIN");
    expect(calls.map((c) => c.sql.trim())).toContain("COMMIT");
    expect(updates()).toHaveLength(3);
    expect(audits()).toHaveLength(2);
    expect(JSON.parse(audits()[0]!.params[2] as string)).toEqual({ name: "Закир", from: null, to: "Zakir", bulk: true });
    expect(audits()[0]!.params[0]).toBe("Дмитрий К.");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("one bad value → NAME_LATIN_INVALID_FOR naming the person, nothing written", async () => {
    const r = await send("POST", "/api/admin/console/people/name-latin/bulk", { items: [{ id: 1, nameLatin: "Zakir" }, { id: 2, nameLatin: "An<ton>" }] });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("NAME_LATIN_INVALID_FOR");
    expect(r.json.error).toContain("Антон");
    expect(r.json.details).toEqual({ id: 2, code: "NAME_LATIN_CHARS" });
    expect(updates()).toHaveLength(0);
    expect(reload).not.toHaveBeenCalled();
  });

  it("another admin needs users.manage.admins; an unknown id is 404", async () => {
    const a = await send("POST", "/api/admin/console/people/name-latin/bulk", { items: [{ id: 122, nameLatin: "Olga N." }] });
    expect(a.status).toBe(403);
    expect(a.json.code).toBe("ADMIN_ONLY");
    const own = await send("POST", "/api/admin/console/people/name-latin/bulk", { items: [{ id: 121, nameLatin: "Dmitriy K." }] });
    expect(own.status).toBe(200);
    const nf = await send("POST", "/api/admin/console/people/name-latin/bulk", { items: [{ id: 999, nameLatin: "X" }] });
    expect(nf.status).toBe(404);
    expect(nf.json.code).toBe("USER_NOT_FOUND");
  });

  it("needs users.manage and a non-empty list", async () => {
    manage = false;
    expect((await send("POST", "/api/admin/console/people/name-latin/bulk", { items: [{ id: 1, nameLatin: "Zakir" }] })).status).toBe(403);
    manage = true;
    const empty = await send("POST", "/api/admin/console/people/name-latin/bulk", { items: [] });
    expect(empty.status).toBe(400);
    expect(empty.json.code).toBe("VALIDATION");
  });
});

describe("POST /admin/console/people/:id/name-latin", () => {
  it("keeps the single edit's contract (own error codes, audit without the bulk mark)", async () => {
    const ok = await send("POST", "/api/admin/console/people/1/name-latin", { nameLatin: " Zakir " });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ ok: true, name: "Закир", nameLatin: "Zakir" });
    expect(JSON.parse(audits()[0]!.params[2] as string)).toEqual({ name: "Закир", from: null, to: "Zakir" });
    const bad = await send("POST", "/api/admin/console/people/1/name-latin", { nameLatin: "<x>" });
    expect(bad.json.code).toBe("NAME_LATIN_CHARS");
    expect((await send("POST", "/api/admin/console/people/999/name-latin", { nameLatin: "X" })).json.code).toBe("USER_NOT_FOUND");
  });
});

describe("PATCH /users/me/name-latin", () => {
  it("a member sets their own Latin name; the audit actor is themselves", async () => {
    me = { id: 1, name: "Закир", role: "trader" };
    const r = await send("PATCH", "/api/users/me/name-latin", { nameLatin: "Zakir  Ishakov" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, name: "Закир", nameLatin: "Zakir Ishakov" });
    expect(updates()[0]!.params).toEqual(["Zakir Ishakov", 1]);
    expect(audits()[0]!.params[0]).toBe("Закир");
    expect(JSON.parse(audits()[0]!.params[2] as string)).toEqual({ name: "Закир", from: null, to: "Zakir Ishakov" });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("rejects bad characters and guests", async () => {
    me = { id: 1, name: "Закир", role: "trader" };
    const bad = await send("PATCH", "/api/users/me/name-latin", { nameLatin: "<b>" });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("NAME_LATIN_CHARS");
    me = { id: 0, name: "Гость", role: "guest" };
    const guest = await send("PATCH", "/api/users/me/name-latin", { nameLatin: "Guest" });
    expect(guest.status).toBe(403);
    expect(guest.json.code).toBe("GUEST_READ_ONLY");
    expect(updates()).toHaveLength(0);
  });
});
