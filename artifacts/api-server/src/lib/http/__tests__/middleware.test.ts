/**
 * Error middleware: every mapping, end to end through a throwaway express app (real body-parser for the JSON cases).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, { type Request } from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { AppError, badRequest, conflict, forbidden, notFound, sendError, tooLarge, unauthorized, ERROR_CODES, errorMessage } from "../errors";
import { errorMiddleware, toAppError } from "../middleware";
import { logger } from "../../logger";

const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);

function pgError(code: string): Error {
  return Object.assign(new Error(`pg ${code}`), { code, severity: "ERROR", routine: "x" });
}

const throwers: Record<string, () => unknown> = {
  app: () => notFound("TRADE_NOT_FOUND"),
  appStatus: () => new AppError("TRADER_NOT_FOUND", 400),
  appDetails: () => conflict("CONFLICT", { field: "name" }),
  forbiddenCap: () => forbidden("trades.write.any"),
  zod: () => z.object({ a: z.number(), b: z.object({ c: z.string() }) }).parse({ a: "x", b: {} }),
  pg23505: () => pgError("23505"),
  pg23503: () => pgError("23503"),
  pg22P02: () => pgError("22P02"),
  pg57014: () => pgError("57014"),
  pgOther: () => pgError("42P01"),
  multerSize: () => Object.assign(new Error("File too large"), { name: "MulterError", code: "LIMIT_FILE_SIZE", field: "file" }),
  multerOther: () => Object.assign(new Error("Unexpected field"), { name: "MulterError", code: "LIMIT_UNEXPECTED_FILE", field: "other" }),
  cors: () => new Error("CORS: origin not allowed"),
  unknown: () => new Error("secret internals: password=hunter2"),
  plainStatus: () => Object.assign(new Error("upstream said 401"), { status: 401 }), // no `expose` → not trusted
  httpError: () => Object.assign(new Error("Method Not Allowed"), { status: 405, expose: true }),
  string: () => "boom",
};

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => { (req as Request & { id: string }).id = "req-42"; next(); });
  app.use(express.json({ limit: "1kb" }));
  app.get("/throw/:kind", (req) => {
    const make = throwers[String(req.params.kind)]!;
    const e = make();
    throw e;
  });
  app.get("/async/:kind", async (req) => {
    await new Promise((r) => setTimeout(r, 1));
    throw throwers[String(req.params.kind)]!();
  });
  app.post("/json", (req, res) => { res.json({ ok: true, got: req.body }); });
  app.get("/send", (_req, res) => { sendError(res, badRequest("INVALID_ID")); });
  app.get("/stream", (_req, res) => { res.write("partial"); throw new Error("after headers"); });
  app.use(errorMiddleware);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function get(path: string, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, { headers });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

describe("errorMiddleware mappings", () => {
  it("AppError → its status, code and localized text", async () => {
    expect(await get("/throw/app")).toEqual({ status: 404, body: { error: "Сделка не найдена", code: "TRADE_NOT_FOUND" } });
    expect(await get("/throw/app", { "X-Lang": "en" })).toEqual({ status: 404, body: { error: "Trade not found", code: "TRADE_NOT_FOUND" } });
    expect((await get("/throw/app", { "X-Lang": "uz" })).body.error).toBe("Savdo topilmadi");
  });

  it("AppError keeps an explicit status and details", async () => {
    expect(await get("/throw/appStatus")).toEqual({ status: 400, body: { error: "Трейдер не найден", code: "TRADER_NOT_FOUND" } });
    expect(await get("/throw/appDetails")).toEqual({ status: 409, body: { error: "Конфликт с существующими данными", code: "CONFLICT", details: { field: "name" } } });
    expect(await get("/throw/forbiddenCap")).toEqual({
      status: 403,
      body: { error: "Недостаточно прав для этого действия", code: "FORBIDDEN", details: { capability: "trades.write.any" } },
    });
  });

  it("async handler errors reach the middleware (Express 5)", async () => {
    expect((await get("/async/app")).status).toBe(404);
  });

  it("ZodError → 400 VALIDATION with [{path, message}]", async () => {
    const r = await get("/throw/zod");
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("VALIDATION");
    expect(r.body.error).toBe("Проверьте заполненные поля");
    const details = r.body.details as Array<{ path: string; message: string }>;
    expect(details.map((d) => d.path)).toEqual(["a", "b.c"]);
    expect(details.every((d) => typeof d.message === "string" && d.message.length > 0)).toBe(true);
  });

  it.each([
    ["pg23505", 409, "CONFLICT"],
    ["pg23503", 409, "CONFLICT"],
    ["pg22P02", 400, "BAD_REQUEST"],
    ["pg57014", 503, "TIMEOUT"],
    ["pgOther", 500, "INTERNAL"],
  ])("pg %s → %i %s", async (kind, status, code) => {
    const r = await get(`/throw/${kind}`);
    expect(r.status).toBe(status);
    expect(r.body.code).toBe(code);
    expect(JSON.stringify(r.body)).not.toContain("pg ");
  });

  it("multer: file size → 413 TOO_LARGE, other → 400 UPLOAD_ERROR", async () => {
    expect(await get("/throw/multerSize")).toEqual({ status: 413, body: { error: "Слишком большой запрос (файл или текст)", code: "TOO_LARGE" } });
    expect(await get("/throw/multerOther")).toEqual({
      status: 400,
      body: { error: "Не удалось принять файл", code: "UPLOAD_ERROR", details: { reason: "LIMIT_UNEXPECTED_FILE", field: "other" } },
    });
  });

  it("malformed JSON → 400 INVALID_JSON; body over the limit → 413 TOO_LARGE", async () => {
    const bad = await fetch(base + "/json", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{nope" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Некорректный JSON в теле запроса", code: "INVALID_JSON" });
    const big = await fetch(base + "/json", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ s: "x".repeat(5000) }) });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { code: string }).code).toBe("TOO_LARGE");
  });

  it("CORS rejection → 403, not 500", async () => {
    expect(await get("/throw/cors")).toEqual({ status: 403, body: { error: "Запросы с этого адреса не разрешены", code: "CORS_REJECTED" } });
  });

  it("unknown error → 500 INTERNAL, no message to the client, logged with err + request id", async () => {
    errorLog.mockClear();
    const r = await get("/throw/unknown");
    expect(r).toEqual({ status: 500, body: { error: "Внутренняя ошибка сервера", code: "INTERNAL", requestId: "req-42" } });
    expect(JSON.stringify(r.body)).not.toContain("hunter2");
    expect(errorLog).toHaveBeenCalledTimes(1);
    const [fields] = errorLog.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(fields.err).toBeInstanceOf(Error);
    expect(fields.requestId).toBe("req-42");
    expect((await get("/throw/string")).status).toBe(500);
  });

  it("a status without `expose` (e.g. an upstream client error) is not trusted → 500", async () => {
    expect((await get("/throw/plainStatus")).status).toBe(500);
  });

  it("http-errors with expose keep their 4xx status and get a generic code", async () => {
    expect(await get("/throw/httpError")).toEqual({ status: 405, body: { error: "Некорректный запрос", code: "BAD_REQUEST" } });
  });

  it("sendError writes the same body without throwing", async () => {
    expect(await get("/send", { "X-Lang": "en" })).toEqual({ status: 400, body: { error: "Invalid ID", code: "INVALID_ID" } });
  });

  it("after headers were sent it delegates to Express (connection closed, no second body)", async () => {
    const r = await fetch(base + "/stream").then((x) => x.text()).catch(() => "closed");
    expect(r === "closed" || r.startsWith("partial")).toBe(true);
  });
});

describe("helpers and registry", () => {
  it("helpers carry the right status", () => {
    expect(badRequest().status).toBe(400);
    expect(badRequest("INVALID_ID").code).toBe("INVALID_ID");
    expect(notFound().code).toBe("NOT_FOUND");
    expect(unauthorized().status).toBe(401);
    expect(forbidden().details).toBeUndefined();
    expect(conflict().status).toBe(409);
    expect(tooLarge().status).toBe(413);
    expect(new AppError("AI_UNAVAILABLE").status).toBe(502);
  });

  it("every code has RU, EN and UZ text", () => {
    for (const code of Object.keys(ERROR_CODES) as (keyof typeof ERROR_CODES)[]) {
      for (const lang of ["ru", "en", "uz"] as const) {
        const msg = errorMessage(code, lang);
        expect(msg, `${code}/${lang}`).not.toBe(code);
        expect(msg.length).toBeGreaterThan(2);
      }
      expect(errorMessage(code, "en")).not.toBe(errorMessage(code, "ru"));
    }
  });

  it("toAppError marks unexpected errors as internal", () => {
    expect(toAppError(new Error("x")).internal).toBe(true);
    expect(toAppError(notFound()).internal).toBe(false);
    expect(toAppError(new AppError("INTERNAL")).internal).toBe(true);
  });
});
