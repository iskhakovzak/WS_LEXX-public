import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/i18n";
import { clearLatinNames, setLatinNames } from "@/lib/people/latin-names";
import { audienceReach, type AudienceOptions } from "./audience";
import { initials, mentionedName } from "./lib";
import { initials as ideaInitials } from "@/components/ideas/model";

const opts: AudienceOptions = {
  everyone: ["Шерзод", "Умид", "Дмитрий К."],
  moderators: [],
  groups: [{ token: "junior", label: "Джунам", kind: "stage", members: ["Шерзод", "Умид", "Дмитрий К."] }],
  cohortLabels: {},
  viewer: { name: null, stage: null, staff: true, moderator: true, cohorts: [], tokens: [] },
};

beforeEach(() => {
  setLatinNames([["Закир", "Zakir"], ["Дмитрий К.", "Dmitriy K."], ["Шерзод", "Sherzod"], ["Умид", "Umid"]]);
});
afterEach(async () => {
  clearLatinNames();
  await setLang("ru", { source: "init" });
});

describe("Latin display names in discussions / ideas", () => {
  it("avatar initials follow the display name", async () => {
    await setLang("en", { source: "init" });
    expect(initials("Дмитрий К.")).toBe("DK");
    expect(ideaInitials("Закир")).toBe("ZA");
    await setLang("ru", { source: "init" });
    expect(initials("Дмитрий К.")).toBe("ДК");
    expect(initials(null)).toBe("?");
  });

  it("audience names sort by how they are shown, keeping the stored names", async () => {
    await setLang("en", { source: "init" });
    expect(audienceReach(["junior"], opts, null)?.names).toEqual(["Дмитрий К.", "Шерзод", "Умид"]);
    await setLang("ru", { source: "init" });
    expect(audienceReach(["junior"], opts, null)?.names).toEqual(["Дмитрий К.", "Умид", "Шерзод"]);
  });

  it("mentionedName finds the longest stored name after «@», whole word, any case", () => {
    const names = ["Закир", "Закир Х", "Дмитрий К."];
    expect(mentionedName("hi @Дмитрий К., look", 4, names)).toBe("Дмитрий К.");
    expect(mentionedName("@закир х ok", 1, names)).toBe("Закир Х");
    expect(mentionedName("@Закир!", 1, names)).toBe("Закир");
    expect(mentionedName("@Закиров", 1, names)).toBeNull();
    expect(mentionedName("@Zakir", 1, names)).toBeNull();
  });
});
