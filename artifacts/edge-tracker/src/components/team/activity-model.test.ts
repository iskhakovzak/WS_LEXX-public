import { afterAll, describe as suite, expect, it } from "vitest";
import { setLang, type Lang } from "@/i18n";
import { activityI18n } from "@/i18n/ns/activity";
import { clearLatinNames, setLatinNames } from "@/lib/people/latin-names";
import { describe, describeBurst, itemHref, itemTitle, sectionMeta, type FeedItem } from "./activity-model";

const item = (p: Partial<FeedItem>): FeedItem => ({
  uid: "log:1", action: "created", section: "trades", entityId: null, entityTitle: null, trader: "Ольга Н.", details: null, rating: null,
  createdAt: "2026-10-17T12:00:00.000Z", ...p,
});

const ACTIONS = ["created", "updated", "deleted", "published", "converted", "resubmitted", "acknowledged", "rated", "synced", "reconciled",
  "conflict", "closed", "reopened", "reviewed", "approved", "rejected", "violation", "halted", "limit_warning", "liked", "reacted", "commented",
  "digest_evening_sent", "digest_morning_sent"];
const SECTIONS = ["trades", "trade-ideas", "playbook", "discussions", "research", "dailyfeed", "events", "eod", "journal", "risk", "game-plan",
  "ratings", "sync", "scaling", "weekly-review", "watchlist", "offerings", "unknown-section"];

/** Every phrase the feed can produce in the current language (single items, bursts, example rows). */
function allPhrases(): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  for (const action of ACTIONS) for (const section of SECTIONS) {
    out.push({ key: `${action}/${section}`, text: describe(item({ action, section })) });
    for (const n of [1, 2, 5, 21]) out.push({ key: `${action}/${section}×${n}`, text: describeBurst(action, section, n) });
  }
  for (const action of ["created", "updated", "deleted"]) {
    out.push({ key: `example/${action}`, text: describe(item({ action, section: "playbook", details: "Эталоны (Tier 1): +2" })) });
    out.push({ key: `examples/${action}×3`, text: describeBurst(action, "playbook", 3, true) });
  }
  return out;
}

/*
 * The feed doesn't know anyone's gender, so no phrase may agree with the actor in any language:
 * - RU: no past-tense verb conjugated by the actor («оставил», «закрыла») — participles agree with the noun;
 * - EN: no gendered pronouns (he/she/his/her…) — passive phrases («trade added»);
 * - UZ: the language has no grammatical gender; keep the same passive style (no active past «qoʻshdi», «yopdi»
 *   that implies a subject) and no gendered words.
 */
const GENDERED: Record<Lang, RegExp> = {
  ru: /(^|\s)(добавил|обновил|удалил|оставил|закрыл|разобрал|оценил|отправил|открыл|написал|прочитал|подтвердил|утвердил|отклонил|пересдал|синхронизировал|сверил|нарушил|приблизился|отреагировал|прокомментировал|перевёл|переоткрыл|опубликовал|поставил|убрал|изменил|провёл|нашёл|заполнил)а?(\s|$)/,
  en: /\b(he|she|his|her|hers|him|himself|herself|guy|girl|man|woman)\b/i,
  uz: /(^|\s)(qoʻshdi|yangiladi|oʻchirdi|yopdi|ochdi|yozdi|oʻqidi|yubordi|baholadi|tasdiqladi|qabul qildi|maʼqulladi|rad etdi|tahlil qildi|qoʻydi|oʻtkazdi|topdi|toʻldirdi|olib tashladi|oʻzgartirdi|aylantirdi|sinxronladi|solishtirdi|erkak|ayol|qiz|yigit)(\s|$|:)/,
};

afterAll(async () => {
  await setLang("ru", { source: "init" });
});

for (const lang of ["ru", "en", "uz"] as const) {
  suite(`activity phrases are gender-neutral (${lang})`, () => {
    it("no phrase agrees with the actor", async () => {
      await setLang(lang, { source: "init" });
      await activityI18n.ready();
      for (const { key, text } of allPhrases()) {
        expect(text, `${lang} ${key}`).not.toMatch(GENDERED[lang]);
        expect(text.trim(), `${lang} ${key}`).not.toBe("");
        // A missing key comes back as the key itself: never show «verbs.created.f» or «{noun}».
        expect(text, `${lang} ${key}`).not.toMatch(/\{\w+\}|(^|\s)(verbs|nouns|special|bursts|phrase)\./);
      }
    });
  });
}

suite("activity phrases per language", () => {
  it("ru: participles agree with the noun", async () => {
    await setLang("ru", { source: "init" });
    expect(describe(item({ action: "created", section: "trades" }))).toBe("добавлена сделка");
    expect(describe(item({ action: "created", section: "playbook" }))).toBe("добавлен сетап");
    expect(describe(item({ action: "deleted", section: "events" }))).toBe("удалено событие");
    expect(describe(item({ action: "closed", section: "eod" }))).toBe("закрыт торговый день");
    expect(describe(item({ action: "reviewed", section: "eod" }))).toBe("разобран торговый день");
    expect(describeBurst("created", "trades", 12)).toBe("добавлено: 12 сделок");
    expect(sectionMeta("trades").label).toBe("Сделки");
  });

  it("en: passive, plural bursts", async () => {
    await setLang("en", { source: "init" });
    await activityI18n.ready();
    expect(describe(item({ action: "created", section: "trades" }))).toBe("trade added");
    expect(describe(item({ action: "deleted", section: "events" }))).toBe("event deleted");
    expect(describeBurst("created", "trades", 12)).toBe("12 trades added");
    expect(describeBurst("created", "trades", 1)).toBe("1 trade added");
    expect(sectionMeta("trades").label).toBe("Trades");
  });

  it("uz: passive, singular noun after a number", async () => {
    await setLang("uz", { source: "init" });
    await activityI18n.ready();
    expect(describe(item({ action: "created", section: "trades" }))).toBe("savdo qoʻshildi");
    expect(describeBurst("created", "trades", 12)).toBe("12 ta savdo qoʻshildi");
    expect(sectionMeta("trades").label).toBe("Savdolar");
  });
});

suite("eod links", () => {
  it("a curator's review links to the trader's day, not the curator's", () => {
    expect(itemHref(item({ action: "reviewed", section: "eod", entityId: "2026-10-09|Кирилл Б.", trader: "Ольга Н." })))
      .toBe(itemHref(item({ action: "closed", section: "eod", entityId: "2026-10-09", trader: "Кирилл Б." })));
  });
});

suite("itemTitle", () => {
  it("shows the reviewed trader's name in the UI language; other titles stay as written", async () => {
    setLatinNames([["Кирилл Б.", "Kirill B."]]);
    const review = item({ section: "eod", action: "reviewed", entityId: "2026-10-09|Кирилл Б.", entityTitle: "Кирилл Б., 2026-10-09" });
    await setLang("ru", { source: "init" });
    expect(itemTitle(review)).toBe("Кирилл Б., 2026-10-09");
    await setLang("uz", { source: "init" });
    expect(itemTitle(review)).toBe("Kirill B., 2026-10-09");
    expect(itemTitle(item({ section: "playbook", entityTitle: "Кирилл Б. сетап" }))).toBe("Кирилл Б. сетап");
    expect(itemTitle(item({ entityTitle: "  " }))).toBeUndefined();
    clearLatinNames();
    await setLang("ru", { source: "init" });
  });
});
