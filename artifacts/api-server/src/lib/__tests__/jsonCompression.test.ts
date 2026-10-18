import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { jsonCompression } from "../jsonCompression";

const big = { rows: Array.from({ length: 2000 }, (_, i) => ({ id: i, ticker: "AAPL", note: "повтор ".repeat(5) })) };

let server: http.Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(jsonCompression(1024));
  app.get("/big", (_req, res) => { res.json(big); });
  app.get("/small", (_req, res) => { res.json({ ok: true }); });
  app.get("/status", (_req, res) => { res.status(404).json(big); });
  app.get("/preset", (_req, res) => { res.setHeader("Content-Encoding", "identity"); res.json(big); });
  app.get("/text", (_req, res) => { res.send("x".repeat(5000)); });
  server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function get(path: string, gzip: boolean): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http.get(base + path, { headers: gzip ? { "accept-encoding": "gzip, deflate" } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

describe("jsonCompression", () => {
  it("gzips a large JSON body when the client accepts gzip", async () => {
    const r = await get("/big", true);
    expect(r.headers["content-encoding"]).toBe("gzip");
    expect(r.headers["content-type"]).toMatch(/application\/json/);
    expect(r.headers.vary).toMatch(/Accept-Encoding/);
    expect(Number(r.headers["x-raw-length"])).toBeGreaterThan(r.body.length);
    expect(JSON.parse(gunzipSync(r.body).toString("utf8"))).toEqual(big);
  });

  it("keeps the status code", async () => {
    const r = await get("/status", true);
    expect(r.status).toBe(404);
    expect(JSON.parse(gunzipSync(r.body).toString("utf8"))).toEqual(big);
  });

  it("sends plain JSON without Accept-Encoding: gzip", async () => {
    const r = await get("/big", false);
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(r.body.toString("utf8"))).toEqual(big);
  });

  it("leaves small bodies, non-JSON sends and preset encodings alone", async () => {
    const small = await get("/small", true);
    expect(small.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(small.body.toString("utf8"))).toEqual({ ok: true });
    const text = await get("/text", true);
    expect(text.headers["content-encoding"]).toBeUndefined();
    const preset = await get("/preset", true);
    expect(preset.headers["content-encoding"]).toBe("identity");
    expect(JSON.parse(preset.body.toString("utf8"))).toEqual(big);
  });
});
