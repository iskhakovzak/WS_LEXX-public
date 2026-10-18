import { describe, expect, it } from "vitest";
import { addressedToMe, audienceReach, audienceText, isRestricted, sortTokens, tokenLabel, type AudienceOptions } from "./audience";
import { isActiveToday, isFreshThread, isLiveNow, type Thread } from "./lib";
import { pluralRu } from "@/lib/format";

const opts: AudienceOptions = {
  everyone: ["Антон", "Артур", "Закир", "Максат", "Ориф", "Тимур", "Умид"],
  moderators: ["Антон", "Тимур", "Ориф"],
  groups: [
    { token: "trainee", label: "Стажёрам", kind: "stage", members: ["Закир", "Умид"] },
    { token: "junior", label: "Джунам", kind: "stage", members: ["Артур", "Максат"] },
    { token: "trader", label: "Трейдерам", kind: "stage", members: ["Ориф"] },
    { token: "staff", label: "Кураторам", kind: "staff", members: ["Антон", "Тимур", "Ориф"] },
    { token: "cohort:2", label: "Удалённо — осень 2026", kind: "cohort", members: ["Умид", "Максат"] },
  ],
  cohortLabels: { "2": "Удалённо — осень 2026" },
  viewer: { name: "Артур", stage: "junior", staff: false, moderator: false, cohorts: [1], tokens: ["junior", "cohort:1"] },
};

describe("audience helpers", () => {
  it("labels and order", () => {
    expect(tokenLabel("junior")).toBe("Джунам");
    expect(tokenLabel("cohort:2", opts)).toBe("Удалённо — осень 2026");
    expect(tokenLabel("cohort:9", opts)).toBe("Когорта #9");
    expect(audienceText([])).toBe("Всем");
    expect(audienceText(["junior", "staff"])).toBe("Джунам, Кураторам");
    expect(sortTokens(["cohort:10", "staff", "cohort:2", "senior", "trainee", "staff"])).toEqual(["trainee", "senior", "staff", "cohort:2", "cohort:10"]);
    expect(isRestricted(undefined)).toBe(false);
    expect(isRestricted(["junior"])).toBe(true);
  });

  it("reach: everyone minus the author", () => {
    expect(audienceReach([], opts, "Артур")).toEqual({ count: 6, names: ["Антон", "Закир", "Максат", "Ориф", "Тимур", "Умид"], moderators: [] });
  });

  it("reach: group members + moderators not already in it, minus the author", () => {
    const r = audienceReach(["junior"], opts, "Артур")!;
    expect(r.names).toEqual(["Максат"]);
    expect(r.moderators).toEqual(["Антон", "Тимур", "Ориф"]);
    expect(r.count).toBe(4);
    const r2 = audienceReach(["trader", "cohort:2"], opts, "Закир")!;
    expect(r2.names).toEqual(["Максат", "Ориф", "Умид"]);
    expect(r2.moderators).toEqual(["Антон", "Тимур"]);
    expect(r2.count).toBe(5);
    expect(audienceReach(["junior"], null, "Артур")).toBeNull();
  });

  it("addressedToMe only for restricted threads that match the viewer's tokens", () => {
    expect(addressedToMe(["junior"], opts)).toBe(true);
    expect(addressedToMe(["cohort:1"], opts)).toBe(true);
    expect(addressedToMe(["staff"], opts)).toBe(false);
    expect(addressedToMe([], opts)).toBe(false);
    expect(addressedToMe(["junior"], null)).toBe(false);
  });

  it("Russian plural for people", () => {
    expect([1, 2, 5, 11, 12, 21, 22, 25].map((n) => `${n} ${pluralRu(n, "человек", "человека", "человек")}`)).toEqual([
      "1 человек", "2 человека", "5 человек", "11 человек", "12 человек", "21 человек", "22 человека", "25 человек",
    ]);
  });
});

describe("freshness", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  const h = (n: number) => new Date(now - n * 3_600_000).toISOString();
  const base = { id: 1, topic: "x", trader: "Ориф", createdAt: h(5), readAt: null, unread: true } as unknown as Thread;

  it("new topic: by someone else, never opened, under 48 h", () => {
    expect(isFreshThread(base, "Артур", now)).toBe(true);
    expect(isFreshThread(base, "Ориф", now)).toBe(false);
    expect(isFreshThread({ ...base, readAt: h(1) }, "Артур", now)).toBe(false);
    expect(isFreshThread({ ...base, createdAt: h(49) }, "Артур", now)).toBe(false);
  });

  it("live now needs a recent reply and a real conversation", () => {
    expect(isLiveNow({ ...base, lastActivityAt: h(1), commentCount: 3 }, now)).toBe(true);
    expect(isLiveNow({ ...base, lastActivityAt: h(1), commentCount: 1 }, now)).toBe(false);
    expect(isLiveNow({ ...base, lastActivityAt: h(4), commentCount: 5 }, now)).toBe(false);
    expect(isActiveToday({ ...base, lastActivityAt: h(23) }, now)).toBe(true);
    expect(isActiveToday({ ...base, lastActivityAt: h(25) }, now)).toBe(false);
  });
});
