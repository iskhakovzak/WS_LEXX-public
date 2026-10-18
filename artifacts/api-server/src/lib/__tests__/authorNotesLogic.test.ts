import { describe, expect, it } from "vitest";
import { MAX_SNAPSHOT_TICKERS, buildAudience, daySnapshot, groupTradesByDay, isAudienceStage } from "../authorNotesLogic";
import type { MoneyViewer } from "../playbookPrivacy";

const author = "Ориф";
const junior: MoneyViewer = { name: "Артур", staff: false };
const owner: MoneyViewer = { name: "Ориф", staff: false };
const curator: MoneyViewer = { name: "Антон", staff: true };

const trades = [
  { ticker: "tsla", result: "win", pnl: 300, fees: 4, r_multiple: 1.5 },
  { ticker: "NVDA", result: "loss", pnl: -120, fees: 2, r_multiple: 1 },
  { ticker: "TSLA", result: "be", pnl: 0, fees: 1, r_multiple: null },
  { ticker: "AMD", result: "open", pnl: null, fees: null, r_multiple: null },
];

describe("daySnapshot", () => {
  it("no trades → null (feed card shows nothing)", () => {
    expect(daySnapshot([], owner, author)).toBeNull();
  });

  it("counts, W/L, Σ signed R over closed trades, unique upper-cased tickers in order", () => {
    const s = daySnapshot(trades, owner, author)!;
    expect(s.count).toBe(4);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.rSum).toBe(0.5); // +1.5 − 1 + 0 (BE); the open trade has no R
    expect(s.tickers).toEqual(["TSLA", "NVDA", "AMD"]);
  });

  it("owner and staff see net $; another trader gets null and redacted: true", () => {
    expect(daySnapshot(trades, owner, author)).toMatchObject({ pnlNet: 173, redacted: false }); // 296 − 122 − 1
    expect(daySnapshot(trades, curator, author)).toMatchObject({ pnlNet: 173, redacted: false });
    const forJunior = daySnapshot(trades, junior, author)!;
    expect(forJunior.pnlNet).toBeNull();
    expect(forJunior.redacted).toBe(true);
    expect(forJunior.rSum).toBe(0.5); // R stays visible
  });

  it("guest / anonymous viewer never sees $", () => {
    expect(daySnapshot(trades, { name: null, staff: false }, author)).toMatchObject({ pnlNet: null, redacted: true });
  });

  it("only open trades → no R, no $", () => {
    const s = daySnapshot([{ ticker: "AMD", result: "open", pnl: null }], owner, author)!;
    expect(s).toMatchObject({ count: 1, wins: 0, losses: 0, rSum: null, pnlNet: null });
  });

  it("caps the ticker list", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ticker: `T${i}`, result: "win", r_multiple: 1 }));
    expect(daySnapshot(many, owner, author)!.tickers).toHaveLength(MAX_SNAPSHOT_TICKERS);
  });
});

describe("groupTradesByDay", () => {
  it("keys by trader|YYYY-MM-DD", () => {
    const g = groupTradesByDay([
      { trader: "Ориф", date: "2026-10-15", ticker: "A" },
      { trader: "Ориф", date: "2026-10-15", ticker: "B" },
      { trader: "Антон", date: "2026-10-15", ticker: "C" },
    ]);
    expect(g.get("Ориф|2026-10-15")).toHaveLength(2);
    expect(g.get("Антон|2026-10-15")).toHaveLength(1);
    expect(g.get("Ориф|2026-10-14")).toBeUndefined();
  });
});

describe("buildAudience", () => {
  const members = [
    { name: "Ориф", role: "trader", stage: "trader" as const },
    { name: "Антон", role: "curator", stage: null },
    { name: "Закир", role: "trader", stage: "trainee" as const },
    { name: "Артур", role: "trader", stage: "junior" as const },
    { name: "Умид", role: "trader", stage: null },
    { name: "Максат", role: "trader", stage: "junior" as const },
  ];

  it("excludes the author; unread first; trainees → juniors → no stage → staff; then by name", () => {
    const a = buildAudience(members, [{ reader: "Максат", read_at: "2026-10-17T13:00:00.000Z" }], "Ориф");
    expect(a.total).toBe(5);
    expect(a.read).toBe(1);
    expect(a.members.map((m) => m.name)).toEqual(["Закир", "Артур", "Умид", "Антон", "Максат"]);
    expect(a.members[4]!.readAt).toBe("2026-10-17T13:00:00.000Z");
    expect(a.members[0]!.readAt).toBeNull();
  });

  it("readers that are no longer members are ignored, Date read_at is serialised", () => {
    const a = buildAudience(
      members.slice(0, 3),
      [{ reader: "Бывший", read_at: "2026-10-17T10:00:00Z" }, { reader: "Закир", read_at: new Date("2026-10-17T11:00:00Z") }],
      "Ориф",
    );
    expect(a.total).toBe(2);
    expect(a.read).toBe(1);
    expect(a.members.find((m) => m.name === "Закир")!.readAt).toBe("2026-10-17T11:00:00.000Z");
  });

  it("duplicate member rows are counted once", () => {
    const a = buildAudience([...members, { name: "Закир", role: "trader", stage: "trainee" }], [], "Ориф");
    expect(a.total).toBe(5);
  });
});

describe("isAudienceStage", () => {
  it("accepts only the four ladder keys", () => {
    expect(isAudienceStage("trainee")).toBe(true);
    expect(isAudienceStage("senior")).toBe(true);
    expect(isAudienceStage("bootcamp")).toBe(false);
    expect(isAudienceStage(null)).toBe(false);
    expect(isAudienceStage("toString")).toBe(false);
  });
});
