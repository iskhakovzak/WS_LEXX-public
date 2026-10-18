import { describe, expect, it } from "vitest";
import {
  damerauLevenshtein, latinizeName, highlightSegments, literal, matchText, matchesAny, prepareQuery, searchItems, skeleton, switchLayout,
  tokenize, translit, translitVariants,
} from "./index";

/** The real desk (local users table, 2026-10-17). */
const DESK = [
  "Закир", "Антон", "Артур", "Рахматулло", "Умид", "Максат", "Тимур", "Ориф", "Дмитрий К.", "Сергей В.", "Ольга Н.",
  "Руслан Т.", "Алексей М.", "Игорь П.", "Никита С.", "Павел Д.", "Евгений Л.", "Кирилл Б.", "Артём Г.", "Денис Ф.",
  "Илья Ш.", "Владислав Е.", "Максим Р.", "Роман Ж.", "Глеб А.", "Андрей Н.", "Виктор С.", "Даниил О.", "Степан Л.", "Егор М.",
];

const top = (q: string, list: string[] = DESK) => searchItems(list, q, (n) => [n])[0]?.item ?? null;
const all = (q: string, list: string[] = DESK) => searchItems(list, q, (n) => [n]).map((h) => h.item);

describe("normalisation", () => {
  it("literal keeps й / ў, folds ё and Latin diacritics", () => {
    expect(literal("Артём")).toBe("артем");
    expect(literal("Дмитрий")).toBe("дмитрий");
    expect(literal("Ўктам")).toBe("ўктам");
    expect(literal("José")).toBe("jose");
    expect(literal("Oʻtkir")).toBe("otkir");
  });

  it("translit: Russian, Uzbek Cyrillic and Uzbek / English Latin meet in one spelling", () => {
    expect(translit("Рахматулло")).toBe("rahmatullo");
    expect(translit("Rakhmatullo")).toBe("rahmatullo");
    expect(translit("Ольга")).toBe("olga");
    expect(translit("Қодир")).toBe(translit("Qodir"));
    expect(translit("Ғайрат")).toBe(translit("Gʻayrat"));
    expect(translit("Ғайрат")).toBe(translit("G'ayrat"));
    expect(translit("Ўктам")).toBe(translit("O`ktam"));
    expect(translit("Ҳасан")).toBe(translit("Hasan"));
    expect(translit("Хуршид")).toBe(translit("Xurshid"));
    expect(translit("Жасур")).toBe(translit("Jasur"));
    expect(translit("Джамшид")).toBe(translit("Djamshid"));
    expect(translit("Шоҳрух")).toBe("shohruh");
    expect(translitVariants("Shohrux")).toContain("shohruh");
    expect(translitVariants("Maxim")).toContain("maksim");
    expect(translit("Виктор")).toBe(translit("Victor"));
    expect(translitVariants("Baxtiyor")).toContain(translit("Бахтиёр"));
    expect(translitVariants("Егор")).toEqual(expect.arrayContaining(["egor", "yegor"]));
  });

  it("skeleton merges a/o, e/i/y and doubled letters", () => {
    expect(skeleton(translit("Закир"))).toBe(skeleton(translit("Zokir")));
    expect(skeleton(translit("Тимур"))).toBe(skeleton(translit("Темур")));
    expect(skeleton(translit("Евгений"))).toBe(skeleton(translit("Yevgeniy")));
    expect(skeleton(translit("Евгений"))).toBe(skeleton(translit("Evgeniy")));
    expect(skeleton(translit("Кирилл"))).toBe(skeleton(translit("Kiril")));
  });

  it("tokenize keeps offsets and in-word apostrophes", () => {
    expect(tokenize("Ольга Н.")).toEqual([{ text: "Ольга", start: 0, end: 5 }, { text: "Н", start: 6, end: 7 }]);
    expect(tokenize("Oʻtkir 'Toshkent'").map((t) => t.text)).toEqual(["Oʻtkir", "Toshkent"]);
  });
});

describe("keyboard layout", () => {
  it("switches both ways", () => {
    expect(switchLayout("Pfrbh")).toBe("закир");
    expect(switchLayout("щдпф")).toBe("olga");
    expect(switchLayout("Jkmuf Y.")).toBe("ольга ню");
    expect(switchLayout("Zakir Закир")).toBeNull();
    expect(switchLayout("123")).toBeNull();
  });
});

describe("distance", () => {
  it("Damerau–Levenshtein counts a swap as one edit and exits early", () => {
    expect(damerauLevenshtein("kirill", "kirill")).toBe(0);
    expect(damerauLevenshtein("kirlil", "kirill")).toBe(1);
    expect(damerauLevenshtein("rahmtula", "rahmatula")).toBe(1);
    expect(damerauLevenshtein("abcdef", "uvwxyz", 1)).toBe(2);
  });
});

describe("cross-script name matching (owner's examples)", () => {
  const cases: [string, string][] = [
    ["Zakir", "Закир"], ["zokir", "Закир"], ["Закир", "Закир"], ["закир", "Закир"],
    ["Rahmatullo", "Рахматулло"], ["Rakhmatullo", "Рахматулло"], ["rahmat", "Рахматулло"],
    ["Kirill", "Кирилл Б."], ["kiril", "Кирилл Б."], ["Kirill B", "Кирилл Б."],
    ["Olga", "Ольга Н."], ["olga n", "Ольга Н."],
    ["Yevgeniy", "Евгений Л."], ["Evgeniy", "Евгений Л."], ["Evgeny", "Евгений Л."],
    ["Umid", "Умид"], ["Timur", "Тимур"], ["Temur", "Тимур"], ["Темур", "Тимур"],
    ["Artyom", "Артём Г."], ["Артем", "Артём Г."], ["Dmitriy", "Дмитрий К."], ["Dmitry", "Дмитрий К."],
    ["Sergey", "Сергей В."], ["Nikita", "Никита С."], ["Pavel", "Павел Д."], ["Ilya", "Илья Ш."],
    ["Vladislav", "Владислав Е."], ["Maksim", "Максим Р."], ["Maxim", "Максим Р."], ["Roman", "Роман Ж."],
    ["Gleb", "Глеб А."], ["Andrey", "Андрей Н."], ["Andrei", "Андрей Н."], ["Viktor", "Виктор С."], ["Victor", "Виктор С."],
    ["Daniil", "Даниил О."], ["Stepan", "Степан Л."], ["Egor", "Егор М."], ["Yegor", "Егор М."], ["Orif", "Ориф"],
    ["Ruslan", "Руслан Т."], ["Aleksey", "Алексей М."], ["Alexey", "Алексей М."], ["Igor", "Игорь П."], ["Denis", "Денис Ф."],
    ["Anton", "Антон"], ["Artur", "Артур"], ["Maksat", "Максат"],
  ];
  it.each(cases)("%s → %s", (q, name) => {
    expect(top(q)).toBe(name);
  });

  it("keyboard-layout slips find the person", () => {
    expect(top("Pfrbh")).toBe("Закир");
    expect(top("Jkmuf")).toBe("Ольга Н.");
    expect(top("Rbhbkk")).toBe("Кирилл Б.");
    expect(top("ьфлыфе")).toBe("Максат"); // «maksat» typed on the RU layout
  });

  it("typos within the fuzzy budget", () => {
    expect(top("Рахмтулло")).toBe("Рахматулло"); // 1 edit, ≥4 letters
    expect(top("Кирлил")).toBe("Кирилл Б."); // swap
    expect(top("Vladsilav")).toBe("Владислав Е."); // ≥8 letters → up to 2
    expect(top("Zakr")).toBe("Закир");
  });

  it("does not over-match short or unrelated queries", () => {
    expect(all("ал")).toEqual(["Алексей М."]); // no «Ольга» from the a/o merge
    expect(all("xyzq")).toEqual([]);
    expect(all("Ян")).toEqual([]);
    expect(top("Тим")).toBe("Тимур");
    expect(all("z")).toEqual(["Закир"]); // one keystroke: prefixes only (no «Илья» via «я» → «ya»)
  });

  it("ranks exact > word prefix > substring > fuzzy", () => {
    const list = ["Максимилиан", "Максим Р.", "Темаксим", "Маским"];
    const hits = searchItems(list, "максим", (n) => [n]);
    expect(hits.map((h) => [h.item, h.tier])).toEqual([
      ["Максим Р.", "exact"], ["Максимилиан", "prefix"], ["Темаксим", "substring"], ["Маским", "fuzzy"],
    ]);
  });

  it("literal match beats a phonetic one in the same tier", () => {
    expect(all("Арт")).toEqual(["Артур", "Артём Г."]);
    const hits = searchItems(["Закир", "Zakir Ishakov"], "zakir", (n) => [n]);
    expect(hits[0]!.item).toBe("Zakir Ishakov");
  });

  it("initials: «Ольга Николаева» finds «Ольга Н.»", () => {
    expect(top("Ольга Николаева")).toBe("Ольга Н.");
    expect(top("Kirill Bondarenko")).toBe("Кирилл Б.");
  });

  it("every query word must match", () => {
    expect(all("Ольга М")).toEqual([]);
    expect(top("Андрей Н")).toBe("Андрей Н.");
    expect(all("М.").slice(0, 2)).toEqual(["Алексей М.", "Егор М."]); // initials first, then «Максим…» prefixes
    expect(top("Yegor")).toBe("Егор М.");
    expect(top("Igor")).toBe("Игорь П.");
  });
});

describe("searchItems with aliases and weights", () => {
  type P = { name: string; latin: string | null; curator: string | null };
  const people: P[] = [
    { name: "Закир", latin: "Zakir Ishakov", curator: null },
    { name: "Никита С.", latin: null, curator: "Ольга Н." },
    { name: "Ольга Н.", latin: "Olga N.", curator: null },
  ];
  const fields = (p: P) => [p.name, p.latin, { text: p.curator, weight: 0.5 }];

  it("finds by Latin alias surname", () => {
    expect(searchItems(people, "ishakov", fields)[0]!.item.name).toBe("Закир");
    expect(searchItems(people, "Ишаков", fields)[0]!.item.name).toBe("Закир");
  });

  it("secondary fields rank below the person themselves", () => {
    const hits = searchItems(people, "Ольга", fields);
    expect(hits.map((h) => h.item.name)).toEqual(["Ольга Н.", "Никита С."]);
    expect(hits[1]!.field).toBe(2);
  });

  it("empty query returns everything in order; limit applies", () => {
    expect(searchItems(people, "  ", fields).map((h) => h.item.name)).toEqual(["Закир", "Никита С.", "Ольга Н."]);
    expect(searchItems(people, "", fields, { limit: 1 })).toHaveLength(1);
  });

  it("minTier drops fuzzy hits", () => {
    expect(searchItems(people, "Zakr", fields, { minTier: "substring" })).toEqual([]);
  });
});

describe("helpers", () => {
  it("matchesAny is a drop-in filter", () => {
    expect(matchesAny("", "x")).toBe(true);
    expect(matchesAny("Rakhmatullo", "Рахматулло")).toBe(true);
    expect(matchesAny("Rakhmatullo", null, "Умид")).toBe(false);
  });

  it("ranges point at the matched words", () => {
    const r = matchText(prepareQuery("olga"), "Ольга Н.")!;
    expect(r.ranges).toEqual([[0, 5]]);
    expect(highlightSegments("Ольга Н.", r.ranges)).toEqual([{ text: "Ольга", hit: true }, { text: " Н.", hit: false }]);
    expect(highlightSegments("abc", [])).toEqual([{ text: "abc", hit: false }]);
  });

  it("is fast enough for a 2 000-name desk", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `${DESK[i % DESK.length]} ${i}`);
    const t0 = performance.now();
    for (const q of ["zokir", "Рахмт", "Pfrbh", "ol"]) searchItems(big, q, (n) => [n]);
    expect(performance.now() - t0).toBeLessThan(400);
  });
});

describe("latinizeName", () => {
  it("keeps case and punctuation of a display name", () => {
    expect(latinizeName("Дмитрий К.")).toBe("Dmitriy K.");
    expect(latinizeName("Артём Г.")).toBe("Artyom G.");
    expect(latinizeName("Рахматулло")).toBe("Rahmatullo");
    expect(latinizeName("Илья Ш.")).toBe("Ilya Sh.");
  });
  it("leaves Latin words as written", () => {
    expect(latinizeName("Zakir Ishakov")).toBe("Zakir Ishakov");
    expect(latinizeName("Закир Ishakov")).toBe("Zakir Ishakov");
  });
});
