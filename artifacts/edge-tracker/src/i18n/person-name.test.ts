import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLang } from "./index";
import { comparePersonNames, personInitials, personName, personNameFor } from "./person-name";
import { clearLatinNames, latinNamesVersion, setLatinNames } from "@/lib/people/latin-names";

beforeEach(() => {
  setLatinNames([["Закир", "Zakir"], ["Дмитрий К.", "Dmitriy K."], ["Умид", null], ["Ориф", "  "]]);
});
afterEach(async () => {
  clearLatinNames();
  await setLang("ru", { source: "init" });
});

describe("personName", () => {
  it("shows the stored name in Russian", async () => {
    await setLang("ru", { source: "init" });
    expect(personName("Закир")).toBe("Закир");
    expect(personInitials("Дмитрий К.")).toBe("ДК");
  });

  it("shows the Latin name in English and Uzbek when one is set", async () => {
    for (const lang of ["en", "uz"] as const) {
      await setLang(lang, { source: "init" });
      expect(personName("Закир")).toBe("Zakir");
      expect(personName("Дмитрий К.")).toBe("Dmitriy K.");
      expect(personInitials("Дмитрий К.")).toBe("DK");
      expect(personInitials("Закир")).toBe("ZA");
    }
  });

  it("falls back to the stored name when no (or a blank) Latin name is set", async () => {
    await setLang("en", { source: "init" });
    expect(personName("Умид")).toBe("Умид");
    expect(personName("Ориф")).toBe("Ориф");
    expect(personName("")).toBe("");
    expect(personName(null)).toBe("");
    expect(personInitials(undefined)).toBe("?");
  });

  it("personNameFor ignores the UI language", () => {
    expect(personNameFor("Закир", "uz")).toBe("Zakir");
    expect(personNameFor("Закир", "ru")).toBe("Закир");
  });

  it("sorts by the displayed name", async () => {
    setLatinNames([["Закир", "Zakir"], ["Ольга Н.", "Olga N."]]);
    await setLang("ru", { source: "init" });
    expect(["Ольга Н.", "Закир"].sort(comparePersonNames)).toEqual(["Закир", "Ольга Н."]);
    await setLang("en", { source: "init" });
    expect(["Закир", "Ольга Н."].sort(comparePersonNames)).toEqual(["Ольга Н.", "Закир"]);
  });
});

describe("Latin name store", () => {
  it("bumps the version only when the content changes", () => {
    const v = latinNamesVersion();
    setLatinNames([["Закир", "Zakir"], ["Дмитрий К.", "Dmitriy K."]]);
    expect(latinNamesVersion()).toBe(v);
    setLatinNames([["Закир", "Zakir Ishakov"], ["Дмитрий К.", "Dmitriy K."]]);
    expect(latinNamesVersion()).toBe(v + 1);
  });
});
