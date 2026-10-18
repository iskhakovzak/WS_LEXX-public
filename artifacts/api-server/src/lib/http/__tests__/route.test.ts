/**
 * route(): authorization through the capability matrix, zod validation of params/query/body, typed args,
 * return-value → JSON, thrown errors → error middleware. The DB is mocked (role lookup + no desk overrides).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, { type Request } from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

const roles: Record<number, string> = { 1: "trader", 2: "curator", 3: "admin" };
vi.mock("@workspace/db", () => ({
  db: {},
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/FROM users WHERE id = \$1/.test(sql)) {
        const role = roles[Number(params[0])];
        return { rows: role ? [{ role, name: `user${params[0]}` }] : [], rowCount: role ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 }; // role_permissions: no overrides; CREATE TABLE: ok
    }),
  },
}));

const { route, idParam } = await import("../route");
const { notFound } = await import("../errors");
const { errorMiddleware } = await import("../middleware");

type Who = "anon" | "guest" | "trader" | "curator" | "inactive";
const USERS: Record<Who, unknown> = {
  anon: undefined,
  guest: { id: 0, name: "Гость", role: "guest" },
  trader: { id: 1, name: "user1", role: "trader" },
  curator: { id: 2, name: "user2", role: "curator" },
  inactive: { id: 99, name: "gone", role: "trader" },
};

const seen: unknown[] = [];
let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const who = (req.get("x-who") ?? "anon") as Who;
    req.authUser = USERS[who] as Request["authUser"];
    next();
  });
  app.post(
    "/items/:id",
    route(
      {
        cap: "checklist.template.edit",
        params: z.object({ id: idParam }),
        query: z.object({ dry: z.enum(["1", "0"]).optional() }),
        body: z.object({ label: z.string().trim().min(1), sortOrder: z.number().int().optional() }),
      },
      async ({ params, query, body, actor }) => {
        // typed: params.id is a number, body.label a string, actor non-null
        const id: number = params.id;
        seen.push({ id, dry: query.dry, label: body.label, actor: actor.name });
        if (id === 404) throw notFound("CHECKLIST_ITEM_NOT_FOUND");
        return { id, label: body.label, sortOrder: body.sortOrder ?? 0 };
      },
    ),
  );
  app.get("/open", route({ query: z.object({ q: z.string().optional() }) }, ({ query, actor }) => ({ q: query.q ?? null, actor })));
  app.get("/any", route({ cap: ["trades.write.any", "journal.write.own"] }, ({ actor }) => ({ role: actor.role })));
  app.delete("/self", route({}, ({ res }) => { res.status(204).end(); }));
  app.use(errorMiddleware);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function call(method: string, path: string, who: Who, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { "x-who": who, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

describe("route() authorization", () => {
  it.each([
    ["anon", 401, "AUTH_REQUIRED"],
    ["inactive", 401, "AUTH_REQUIRED"],
    ["guest", 403, "GUEST_READ_ONLY"],
    ["trader", 403, "FORBIDDEN"],
  ] as const)("%s → %i %s", async (who, status, code) => {
    const r = await call("POST", "/items/5", who, { label: "x" });
    expect(r.status).toBe(status);
    expect(r.body?.code).toBe(code);
  });

  it("missing capability names it in details", async () => {
    const r = await call("POST", "/items/5", "trader", { label: "x" });
    expect(r.body?.details).toEqual({ capability: "checklist.template.edit" });
  });

  it("authorizes before validating (no validation details leak to the unauthorized)", async () => {
    expect((await call("POST", "/items/abc", "anon", {})).status).toBe(401);
  });

  it("any-of list: one held capability is enough", async () => {
    expect(await call("GET", "/any", "trader")).toEqual({ status: 200, body: { role: "trader" } });
    expect((await call("GET", "/any", "guest")).status).toBe(403);
  });
});

describe("route() validation and typed args", () => {
  it("valid request → typed values, return value sent as JSON", async () => {
    seen.length = 0;
    const r = await call("POST", "/items/7?dry=1", "curator", { label: "  Катализатор  ", sortOrder: 3 });
    expect(r).toEqual({ status: 200, body: { id: 7, label: "Катализатор", sortOrder: 3 } });
    expect(seen).toEqual([{ id: 7, dry: "1", label: "Катализатор", actor: "user2" }]);
  });

  it.each([
    ["/items/abc", { label: "x" }, "params.id"],
    ["/items/0", { label: "x" }, "params.id"],
    ["/items/7?dry=maybe", { label: "x" }, "query.dry"],
    ["/items/7", { label: "" }, "body.label"],
    ["/items/7", { label: "x", sortOrder: 1.5 }, "body.sortOrder"],
    ["/items/7", {}, "body.label"],
  ])("%s %j → 400 VALIDATION at %s", async (path, body, where) => {
    const r = await call("POST", path, "curator", body);
    expect(r.status).toBe(400);
    expect(r.body?.code).toBe("VALIDATION");
    expect((r.body?.details as Array<{ path: string }>).map((d) => d.path)).toContain(where);
  });

  it("thrown AppError goes through the middleware", async () => {
    expect(await call("POST", "/items/404", "curator", { label: "x" })).toEqual({
      status: 404,
      body: { error: "Пункт чек-листа не найден", code: "CHECKLIST_ITEM_NOT_FOUND" },
    });
  });

  it("no cap: open to any caller the gate let through; actor is null", async () => {
    expect(await call("GET", "/open?q=abc", "anon")).toEqual({ status: 200, body: { q: "abc", actor: null } });
  });

  it("handler that answers itself (undefined return) is left alone", async () => {
    expect(await call("DELETE", "/self", "trader")).toEqual({ status: 204, body: null });
  });
});
