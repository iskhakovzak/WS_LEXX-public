/**
 * routes/admin-settings.ts + lib/settings/store.ts — admin only (settings.manage), the batch is validated as a whole
 * (SETTINGS_INVALID, per-key problems, nothing written), a save lands in app_settings (in-memory here), refreshes
 * setting() at once and is audited old → new; null resets to the default but keeps who / when.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

type Who = { id: number; name: string; role: "trader" | "curator" | "admin" };
const ADMIN: Who = { id: 1, name: "Дмитрий К.", role: "admin" };
const CURATOR: Who = { id: 3, name: "Ольга Н.", role: "curator" };
let who: Who = ADMIN;

type Row = { key: string; value: unknown; updated_by: string | null; updated_at: Date };
const table = vi.hoisted(() => new Map<string, { key: string; value: unknown; updated_by: string | null; updated_at: Date }>());

vi.mock("@workspace/db", () => {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return { rows: [], rowCount: 0 };
    if (/FROM app_settings/.test(sql)) {
      const keys = /ANY\(\$1/.test(sql) ? (params[0] as string[]) : null;
      const rows = [...table.values()].filter((r) => !keys || keys.includes(r.key));
      return { rows, rowCount: rows.length };
    }
    if (/INSERT INTO app_settings/.test(sql)) {
      const [key, json, by] = params as [string, string | null, string];
      table.set(key, { key, value: json == null ? null : JSON.parse(json), updated_by: by, updated_at: new Date() });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { db: {}, pool: { query, connect: vi.fn(async () => ({ query, release: () => undefined })) } };
});
const audit = vi.hoisted(() => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock("../../lib/audit", () => audit);

process.env.JWT_SECRET ??= "vitest-only-secret";
const { default: router } = await import("../admin-settings");
const { errorMiddleware } = await import("../../lib/http");
const { setting } = await import("../../lib/settings/registry");
const store = await import("../../lib/settings/store");

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: who.id, name: who.name, role: who.role };
    // The actor lib/permissions would read from users (role_permissions → empty here: the default matrix).
    (req as unknown as { permActor: unknown }).permActor = { id: who.id, name: who.name, role: who.role, guest: false, wards: [] };
    next();
  });
  app.use("/api", router);
  app.use(errorMiddleware);
  server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => { who = ADMIN; table.clear(); store.__resetSettingsStore(); vi.clearAllMocks(); });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const byKey = (json: any, key: string) => (json.settings as any[]).find((s) => s.key === key);

describe("access", () => {
  it("a curator can neither read nor save (settings.manage is admin-only)", async () => {
    who = CURATOR;
    expect((await call("GET", "/api/admin/settings")).status).toBe(403);
    const r = await call("PUT", "/api/admin/settings", { changes: [{ key: "daily.focusWindowDays", value: 12 }] });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("FORBIDDEN");
    expect(table.size).toBe(0);
  });
});

describe("GET /admin/settings", () => {
  it("every registry key with its definition, default and effective value", async () => {
    const r = await call("GET", "/api/admin/settings");
    expect(r.status).toBe(200);
    expect(r.json.timezone).toBe("America/New_York");
    expect(byKey(r.json, "daily.focusWindowDays")).toMatchObject({ value: null, effective: 10, default: 10, updatedBy: null, def: { type: "number", min: 3, max: 30, group: "daily", unit: "days" } });
    expect(byKey(r.json, "telegram.morningTime")).toMatchObject({ effective: "08:45", def: { type: "time" } });
  });

  it("a stored value is read back (also refreshes this process's cache)", async () => {
    table.set("daily.focusMinDays", { key: "daily.focusMinDays", value: 4, updated_by: "Дмитрий К.", updated_at: new Date("2026-10-18T10:00:00Z") } as Row);
    const r = await call("GET", "/api/admin/settings");
    expect(byKey(r.json, "daily.focusMinDays")).toMatchObject({ value: 4, effective: 4, updatedBy: "Дмитрий К.", updatedAt: "2026-10-18T10:00:00.000Z" });
    expect(setting("daily.focusMinDays")).toBe(4);
  });
});

describe("PUT /admin/settings", () => {
  it("rejects the whole batch with per-key problems; nothing is written", async () => {
    const r = await call("PUT", "/api/admin/settings", { changes: [
      { key: "daily.focusWindowDays", value: 12 },
      { key: "telegram.morningTime", value: "25:00" },
      { key: "daily.feesShare", value: 5 },
      { key: "no.such", value: 1 },
    ] });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("SETTINGS_INVALID");
    expect(r.json.details.problems).toEqual([
      { key: "telegram.morningTime", kind: "time" },
      { key: "daily.feesShare", kind: "range", min: 0.1, max: 1 },
      { key: "no.such", kind: "unknown" },
    ]);
    expect(table.size).toBe(0);
    expect(setting("daily.focusWindowDays")).toBe(10);
    expect(audit.logAudit).not.toHaveBeenCalled();
  });

  it("a malformed body is a plain VALIDATION error", async () => {
    expect((await call("PUT", "/api/admin/settings", { changes: [] })).json.code).toBe("VALIDATION");
    expect((await call("PUT", "/api/admin/settings", {})).json.code).toBe("VALIDATION");
  });

  it("saves, refreshes setting() at once, audits old → new; an unchanged value is not re-written", async () => {
    const r = await call("PUT", "/api/admin/settings", { changes: [
      { key: "daily.focusWindowDays", value: 12 },
      { key: "telegram.morningTime", value: "07:30" },
      { key: "telegram.eveningEnabled", value: true }, // = default, stored explicitly
    ] });
    expect(r.status).toBe(200);
    expect(r.json.changed).toEqual(["daily.focusWindowDays", "telegram.morningTime", "telegram.eveningEnabled"]);
    expect(setting("daily.focusWindowDays")).toBe(12);
    expect(setting("telegram.morningTime")).toBe("07:30");
    expect(byKey(r.json, "daily.focusWindowDays")).toMatchObject({ value: 12, effective: 12, default: 10, updatedBy: "Дмитрий К." });
    expect(audit.logAudit).toHaveBeenCalledWith({ actor: "Дмитрий К.", action: "settings.update", targetType: "setting", targetId: "daily.focusWindowDays", details: { from: 10, to: 12, unit: "days" } });
    expect(store.settingsChangedAt("daily.")).toBe(byKey(r.json, "daily.focusWindowDays").updatedAt);
    expect(store.settingsChangedAt("privacy.")).toBeNull();

    vi.clearAllMocks();
    const again = await call("PUT", "/api/admin/settings", { changes: [{ key: "daily.focusWindowDays", value: 12 }] });
    expect(again.json.changed).toEqual([]);
    expect(audit.logAudit).not.toHaveBeenCalled();
  });

  it("null resets to the default and keeps who / when", async () => {
    await call("PUT", "/api/admin/settings", { changes: [{ key: "daily.focusMinCostUsd", value: 50 }] });
    expect(setting("daily.focusMinCostUsd")).toBe(50);
    const r = await call("PUT", "/api/admin/settings", { changes: [{ key: "daily.focusMinCostUsd", value: null }] });
    expect(r.json.changed).toEqual(["daily.focusMinCostUsd"]);
    expect(setting("daily.focusMinCostUsd")).toBe(10);
    expect(byKey(r.json, "daily.focusMinCostUsd")).toMatchObject({ value: null, effective: 10, updatedBy: "Дмитрий К." });
    expect(table.get("daily.focusMinCostUsd")?.value).toBeNull();
    expect(audit.logAudit).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: "daily.focusMinCostUsd", details: { from: 50, to: 10, unit: "usd", reset: true } }));
  });

  it("warm-up loads stored values and ignores keys no longer in the registry or out of bounds", async () => {
    table.set("daily.focusWindowDays", { key: "daily.focusWindowDays", value: 99, updated_by: "x", updated_at: new Date() } as Row);
    table.set("old.removed", { key: "old.removed", value: 1, updated_by: "x", updated_at: new Date() } as Row);
    table.set("telegram.eveningTime", { key: "telegram.eveningTime", value: "17:15", updated_by: "x", updated_at: new Date() } as Row);
    await store.warmSettings();
    expect(setting("daily.focusWindowDays")).toBe(10);
    expect(setting("telegram.eveningTime")).toBe("17:15");
  });
});
