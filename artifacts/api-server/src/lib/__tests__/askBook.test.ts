import { describe, expect, it } from "vitest";
import { ASK_BOOK_COLS, askBookCompact, askBookQuery, askBookResponse, askBookTuple, clockCell, type AskBookDbRow } from "../askBook";
import type { MoneyViewer } from "../playbookPrivacy";

const alex: MoneyViewer = { name: "Алекс", staff: false };
const curator: MoneyViewer = { name: "Ориф", staff: true };
const guest: MoneyViewer = { name: null, staff: false };

function row(over: Partial<AskBookDbRow> = {}): AskBookDbRow {
  return {
    id: 1, ticker: "nvda", date: "2026-03-02", exit_date: "", side: "Long", trader: "Алекс", setup: "Пробой",
    hold_time: "2h 29m", qty: null, result: "win", entry: "101.5000", exit: "104.2500", stop: null, r_multiple: "2.40",
    pnl: "275.00", fees: "-6.60", risk_usd: "110.00", horizon: "intraday",
    opened_at: "2026-03-02T09:41:00", closed_at: "2026-03-02T12:10:00", snap_qty: "100",
    ...over,
  };
}

const col = (t: unknown[], k: (typeof ASK_BOOK_COLS)[number]) => t[ASK_BOOK_COLS.indexOf(k)];

describe("askBookQuery", () => {
  it("whole desk: no trader filter, limit + 1 to detect truncation", () => {
    const q = askBookQuery(null, 100);
    expect(q.sql).toContain("deleted_at IS NULL");
    expect(q.sql).not.toContain("trader =");
    expect(q.params).toEqual([101]);
  });
  it("one trader: parameterised, never interpolated", () => {
    const q = askBookQuery("O'Brien; DROP", 10);
    expect(q.sql).toContain("trader = $1");
    expect(q.sql).toContain("LIMIT $2");
    expect(q.sql).not.toContain("O'Brien");
    expect(q.params).toEqual(["O'Brien; DROP", 11]);
  });
});

describe("askBookTuple", () => {
  it("own trade: numbers parsed, ticker upper-cased, snapshot qty folded in", () => {
    const t = askBookTuple(row(), alex);
    expect(t).toHaveLength(ASK_BOOK_COLS.length);
    expect(col(t, "ticker")).toBe("NVDA");
    expect(col(t, "entry")).toBe(101.5);
    expect(col(t, "rMultiple")).toBe(2.4);
    expect(col(t, "pnl")).toBe(275);
    expect(col(t, "fees")).toBe(-6.6);
    expect(col(t, "qty")).toBe(100);
    expect(col(t, "riskUsd")).toBe(110);
    expect(col(t, "exitDate")).toBeNull();
    expect(col(t, "stop")).toBeNull();
    expect(col(t, "openedAt")).toBe("2026-03-02T09:41:00");
  });
  it("column qty wins over the snapshot", () => {
    expect(col(askBookTuple(row({ qty: "250.00" }), alex), "qty")).toBe(250);
  });
  it("someone else's trade: $ nulled for a trader, R and prices stay", () => {
    const t = askBookTuple(row({ trader: "Сеня" }), alex);
    expect(col(t, "pnl")).toBeNull();
    expect(col(t, "fees")).toBeNull();
    expect(col(t, "qty")).toBeNull();
    expect(col(t, "riskUsd")).toBeNull();
    expect(col(t, "rMultiple")).toBe(2.4);
    expect(col(t, "entry")).toBe(101.5);
  });
  it("staff see every trade's $", () => {
    expect(col(askBookTuple(row({ trader: "Сеня" }), curator), "pnl")).toBe(275);
  });
  it("guest sees no $", () => {
    expect(col(askBookTuple(row(), guest), "pnl")).toBeNull();
  });
});

describe("askBookResponse", () => {
  it("truncates to the limit and flags it", () => {
    const rows = [row({ id: 3 }), row({ id: 2 }), row({ id: 1 })];
    const r = askBookResponse(rows, alex, "Алекс", 2);
    expect(r.truncated).toBe(true);
    expect(r.rows.map((t) => t[0])).toEqual([3, 2]);
    expect(r.cols).toBe(ASK_BOOK_COLS);
    expect(r.scope).toBe("Алекс");
    expect(r.redacted).toBe(false);
  });
  it("flags redaction when any row lost its $", () => {
    const r = askBookResponse([row(), row({ id: 2, trader: "Сеня" })], alex, null);
    expect(r.truncated).toBe(false);
    expect(r.redacted).toBe(true);
  });
  it("empty book", () => {
    expect(askBookResponse([], guest, null)).toMatchObject({ rows: [], truncated: false, redacted: false });
  });
});

describe("askBookCompact (enc=2)", () => {
  it("dictionary-encodes repeated strings and sends same-day stamps as seconds", () => {
    const book = askBookResponse([
      row({ id: 3, exit_date: "2026-03-03", closed_at: "2026-03-03T09:31:05" }),
      row({ id: 2, setup: "Отскок", opened_at: "2026-03-02T10:00:00.5", closed_at: null }),
      row({ id: 1, setup: null }),
    ], alex, "Алекс");
    const c = askBookCompact(book);
    expect(c.enc).toBe(2);
    expect(c.rows).toHaveLength(3);
    expect(c.dicts.setup).toEqual(["Пробой", "Отскок"]);
    expect(c.dicts.trader).toEqual(["Алекс"]);
    expect(col(c.rows[0], "setup")).toBe(0);
    expect(col(c.rows[1], "setup")).toBe(1);
    expect(col(c.rows[2], "setup")).toBeNull();
    expect(col(c.rows[0], "date")).toBe(0);
    expect(c.dicts.date![0]).toBe("2026-03-02");
    // openedAt on the trade date → seconds; closedAt is relative to exitDate when there is one.
    expect(col(c.rows[0], "openedAt")).toBe(9 * 3600 + 41 * 60);
    expect(col(c.rows[0], "closedAt")).toBe(9 * 3600 + 31 * 60 + 5);
    expect(col(c.rows[2], "closedAt")).toBe(12 * 3600 + 10 * 60);
    // Not a plain stamp → unchanged string; null stays null.
    expect(col(c.rows[1], "openedAt")).toBe("2026-03-02T10:00:00.5");
    expect(col(c.rows[1], "closedAt")).toBeNull();
    // Numbers untouched; the plain response is not mutated.
    expect(col(c.rows[0], "pnl")).toBe(275);
    expect(col(book.rows[0], "setup")).toBe("Пробой");
    expect(c.clock).toEqual({ openedAt: "date", closedAt: "exitDate" });
  });
  it("clockCell keeps stamps from another day", () => {
    expect(clockCell("2026-03-03T09:30:00", "2026-03-02")).toBe("2026-03-03T09:30:00");
    expect(clockCell("2026-03-02T00:00:00", "2026-03-02")).toBe(0);
    expect(clockCell(null, "2026-03-02")).toBeNull();
  });
});
