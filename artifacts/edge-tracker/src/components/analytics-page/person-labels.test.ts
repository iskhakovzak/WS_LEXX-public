import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/i18n";
import { clearLatinNames, setLatinNames } from "@/lib/people/latin-names";
import { edgeKeyLabel, sortEdgeKeys } from "./edge-api";
import { NONE, groupLabel } from "./metrics";

beforeEach(() => {
  setLatinNames([["Закир", "Zakir"], ["Дмитрий К.", "Dmitriy K."], ["Шерзод", "Sherzod"], ["Умид", "Umid"], ["Ориф", "Orif"]]);
});
afterEach(async () => {
  clearLatinNames();
  await setLang("ru", { source: "init" });
});

describe("trader keys in analytics show the display name", () => {
  it("edge matrix / costs labels: Latin in EN, stored name in RU; other dimensions untouched", async () => {
    await setLang("en", { source: "init" });
    expect(edgeKeyLabel("trader", "Закир", 30)).toBe("Zakir");
    expect(edgeKeyLabel("trader", "Анвар", 30)).toBe("Анвар");
    expect(edgeKeyLabel("setup", "Закир", 30)).toBe("Закир");
    await setLang("ru", { source: "init" });
    expect(edgeKeyLabel("trader", "Закир", 30)).toBe("Закир");
  });

  it("sorts trader keys by the shown name, keys stay stored names", async () => {
    await setLang("en", { source: "init" });
    expect(sortEdgeKeys("trader", ["Шерзод", "Умид", "Ориф"])).toEqual(["Ориф", "Шерзод", "Умид"]);
    await setLang("ru", { source: "init" });
    expect(sortEdgeKeys("trader", ["Шерзод", "Умид", "Ориф"])).toEqual(["Ориф", "Умид", "Шерзод"]);
  });

  it("breakdown group label of the trader dimension", async () => {
    await setLang("en", { source: "init" });
    expect(groupLabel("trader", "Дмитрий К.")).toBe("Dmitriy K.");
    expect(groupLabel("trader", NONE)).not.toBe(NONE);
  });
});
