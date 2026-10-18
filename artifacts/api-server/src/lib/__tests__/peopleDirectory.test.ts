import { describe, expect, it } from "vitest";
import { cleanNameLatin, searchPeople, type DirectoryPerson } from "../peopleDirectory";

const p = (id: number, name: string, role = "trader", curator: string | null = null, nameLatin: string | null = null): DirectoryPerson =>
  ({ id, name, nameLatin, role, curator, active: true, banned: false });

// Real desk names (local users table).
const PEOPLE: DirectoryPerson[] = [
  p(1, "Закир", "trader", null, "Zakir Ishakov"), p(2, "Антон", "curator"), p(4, "Рахматулло"), p(5, "Умид"), p(7, "Тимур", "curator"),
  p(123, "Ольга Н.", "curator"), p(129, "Евгений Л.", "trader", "Ольга Н."), p(130, "Кирилл Б.", "trader", "Ольга Н."), p(135, "Максим Р."),
];

describe("people search (server)", () => {
  it.each([
    ["zokir", "Закир"], ["Pfrbh", "Закир"], ["Ишаков", "Закир"], ["Rakhmatullo", "Рахматулло"], ["Yevgeniy", "Евгений Л."],
    ["Temur", "Тимур"], ["Umid", "Умид"], ["kirill b", "Кирилл Б."], ["Maxim", "Максим Р."],
  ])("%s → %s", (q, name) => {
    expect(searchPeople(PEOPLE, q)[0]?.name).toBe(name);
  });

  it("ranks the person above people whose curator matched, and reports what matched", () => {
    const hits = searchPeople(PEOPLE, "olga");
    expect(hits.map((h) => h.name)).toEqual(["Ольга Н.", "Евгений Л.", "Кирилл Б."]);
    expect(hits[0]!.matched).toBe("name");
    expect(hits[1]!.matched).toBe("curator");
    expect(searchPeople(PEOPLE, "ishakov")[0]!.matched).toBe("nameLatin");
  });

  it("limit applies", () => {
    expect(searchPeople(PEOPLE, "а", 2).length).toBeLessThanOrEqual(2);
  });
});

describe("cleanNameLatin", () => {
  it("trims, collapses spaces, empties to null", () => {
    expect(cleanNameLatin("  Zakir   Ishakov ")).toEqual({ ok: true, value: "Zakir Ishakov" });
    expect(cleanNameLatin("")).toEqual({ ok: true, value: null });
    expect(cleanNameLatin(null)).toEqual({ ok: true, value: null });
    expect(cleanNameLatin("Oʻtkir G'ayratov-Jr.")).toEqual({ ok: true, value: "Oʻtkir G'ayratov-Jr." });
  });
  it("rejects markup, non-strings and long values", () => {
    expect(cleanNameLatin("<script>").ok).toBe(false);
    expect(cleanNameLatin(42).ok).toBe(false);
    expect(cleanNameLatin("a".repeat(81)).ok).toBe(false);
  });
});
