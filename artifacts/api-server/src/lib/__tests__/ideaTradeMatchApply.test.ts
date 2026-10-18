/**
 * matchIdeaTrades writes only differences: links a new match, clears a stale auto link (status back to
 * 'published'), keeps a second run silent, and never offers / touches hand-linked trades. DB mocked.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type Idea = { id: number; trader: string; ticker: string; side: string; status: string; published_at: Date; created_at: Date; idea_date: string; valid_until: string | null; horizon: string; converted_trade_id: number | null; trade_link_source: string | null };
let ideas: Idea[] = [];
let candidates: { idea_id: number; trade_id: number; distance_ms: number }[] = [];
const writes: { sql: string; params: unknown[] }[] = [];
let excluded: unknown = null;

vi.mock("@workspace/db", () => ({
  db: {},
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/ALTER TABLE/.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM trade_ideas\s+WHERE deleted_at IS NULL AND trader IS NOT NULL/.test(sql)) return { rows: ideas.map((i) => ({ ...i })), rowCount: ideas.length };
      if (/SELECT converted_trade_id AS t/.test(sql)) {
        const rows = ideas.filter((i) => i.converted_trade_id != null && (i.trade_link_source ?? "manual") !== "auto").map((i) => ({ t: i.converted_trade_id }));
        return { rows, rowCount: rows.length };
      }
      if (/WITH i AS/.test(sql)) { excluded = params[7]; return { rows: candidates, rowCount: candidates.length }; }
      if (/^\s*UPDATE trade_ideas/.test(sql)) {
        writes.push({ sql, params });
        const i = ideas.find((x) => x.id === params[0])!;
        if (/trade_link_source = 'auto'/.test(sql) && /converted_trade_id = \$2/.test(sql)) Object.assign(i, { converted_trade_id: params[1], trade_link_source: "auto", status: "converted" });
        else Object.assign(i, { converted_trade_id: null, trade_link_source: null, status: i.status === "converted" ? "published" : i.status });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  },
}));

const { matchIdeaTrades } = await import("../ideaTradeMatch");
const idea = (p: Partial<Idea>): Idea => ({
  id: 1, trader: "Максим Р.", ticker: "MSFT", side: "Long", status: "published", published_at: new Date("2026-10-14T12:50:00Z"),
  created_at: new Date("2026-10-14T12:00:00Z"), idea_date: "2026-10-14", valid_until: null, horizon: "intraday", converted_trade_id: null, trade_link_source: null, ...p,
});

beforeEach(() => { writes.length = 0; excluded = null; });

describe("matchIdeaTrades", () => {
  it("links, then a rerun writes nothing", async () => {
    ideas = [idea({ id: 1 })];
    candidates = [{ idea_id: 1, trade_id: 500, distance_ms: 60_000 }];
    expect(await matchIdeaTrades()).toEqual({ ideas: 1, linked: 1, unlinked: 0, moved: 0 });
    expect(ideas[0]).toMatchObject({ converted_trade_id: 500, trade_link_source: "auto", status: "converted" });
    writes.length = 0;
    expect(await matchIdeaTrades()).toEqual({ ideas: 1, linked: 0, unlinked: 0, moved: 0 });
    expect(writes).toEqual([]);
  });

  it("clears a stale auto link and returns the idea to 'published'", async () => {
    ideas = [idea({ id: 2, status: "converted", converted_trade_id: 77, trade_link_source: "auto" })];
    candidates = [];
    expect((await matchIdeaTrades()).unlinked).toBe(1);
    expect(ideas[0]).toMatchObject({ converted_trade_id: null, trade_link_source: null, status: "published" });
  });

  it("leaves hand-linked / switched-off ideas alone and excludes their trades from matching", async () => {
    ideas = [
      idea({ id: 3, status: "converted", converted_trade_id: 900, trade_link_source: null }), // legacy manual
      idea({ id: 4, trade_link_source: "off" }),
      idea({ id: 5 }),
    ];
    candidates = [{ idea_id: 5, trade_id: 901, distance_ms: 10 }];
    const out = await matchIdeaTrades();
    expect(out.ideas).toBe(1);
    expect(excluded).toEqual([900]);
    expect(writes.map((w) => w.params[0])).toEqual([5]);
  });
});
