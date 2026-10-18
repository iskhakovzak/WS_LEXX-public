import { beforeEach, describe, expect, it } from "vitest";
import { __setLatinNamesForTest, personNameFor, personNamesFor } from "../people/latinNames";
import { localizeActivity, accessCustomParams } from "../activityText";
import { renderNotification } from "../notificationText";
import { errorMessage } from "../http/errors";
import { riskNotice, violationNotice } from "../notifyEventsCore";
import { buildIdeaHtml } from "../telegramBot";

// Server texts a person reads show the Latin name (users.name_latin) to EN / UZ readers and the stored name to RU
// readers; params / stored rows keep the stored name.
beforeEach(() => {
  __setLatinNamesForTest({ "Закир": "Zakir", "Антон": "Anton", "Дмитрий К.": "Dmitriy K." });
});

describe("personNameFor", () => {
  it("EN / UZ → Latin when set, RU and unknown names → stored", () => {
    expect(personNameFor("Закир", "en")).toBe("Zakir");
    expect(personNameFor("Закир", "uz")).toBe("Zakir");
    expect(personNameFor("Закир", "ru")).toBe("Закир");
    expect(personNameFor("Умид", "en")).toBe("Умид");
    expect(personNameFor(null, "en")).toBe("");
    expect(personNamesFor(["Закир", "Дмитрий К."], "uz")).toEqual(["Zakir", "Dmitriy K."]);
  });
});

describe("activity rows (lib/activityText)", () => {
  const moved = { entityTitle: "Сетап", details: "Перенесён в Офис из «Мой» (Закир), эталонов: 2", params: { detailsKey: "movedToOffice", trader: "Закир", count: 2 } };

  it("person values in params", () => {
    expect(localizeActivity(moved, "en").details).toBe("Moved to Office from Mine (Zakir), examples: 2");
    expect(localizeActivity(moved, "uz").details).toContain("Zakir");
    expect(localizeActivity(moved, "ru").details).toContain("Закир");
  });

  it("access list: people Latin, cohorts as before", () => {
    const { details, params } = accessCustomParams(["Закир", "Антон"], [3]);
    expect(details).toContain("Закир, Антон");
    const en = localizeActivity({ entityTitle: null, details, params }, "en").details!;
    expect(en).toContain("Zakir, Anton");
    expect(en).toContain("3");
    expect(localizeActivity({ entityTitle: null, details, params }, "ru").details).toBe(details);
  });

  it("rules / behavior keys and the reviewed-day title (new rows and legacy rows)", () => {
    expect(localizeActivity({ entityTitle: "R", details: "Правило офиса для Закир", params: { detailsKey: "rules.activity.officeRule", trader: "Закир" } }, "en").details).toBe("Office rule for Zakir");
    expect(localizeActivity({ entityTitle: "T", details: "триггер для Закир", params: { detailsKey: "behavior.activity.triggerCreated", trader: "Закир" } }, "en").details).toBe("trigger for Zakir");
    expect(localizeActivity({ entityTitle: "Закир, 2026-10-12", details: null, params: { titleKey: "eod_reviewed", trader: "Закир", date: "2026-10-12" } }, "uz").entityTitle).toBe("Zakir, 2026-10-12");
    expect(localizeActivity({ entityTitle: "Закир, 2026-10-12", details: null, params: null }, "en").entityTitle).toBe("Zakir, 2026-10-12");
    expect(localizeActivity({ entityTitle: "Закир, 2026-10-12", details: null, params: null }, "ru").entityTitle).toBe("Закир, 2026-10-12");
  });
});

describe("notifications: custom renderers read person params (lib/notificationText)", () => {
  it("review / discussions / scaling renderers", () => {
    const ack = { trader: "Закир", week: "2026-10-12", overall: 4, acker: "Антон" };
    const en = renderNotification("rating_ack", ack, "en")!;
    expect(en.title).toBe("Rating acknowledged: Zakir");
    expect(en.body).toContain("Anton");
    expect(renderNotification("rating_ack", ack, "ru")!.title).toContain("Закир");

    const reply = { variant: "toYou", actor: "Антон", topic: "NVDA", preview: "ок" };
    expect(renderNotification("reply", reply, "uz")!.title).toContain("Anton");
    expect(renderNotification("reply", reply, "ru")!.title).toContain("Антон");

    const decision = { variant: "staff", trader: "Закир", approved: 1, actionCode: "promote", to: "Tier 2", actor: "Антон" };
    const d = renderNotification("scaling_decision", decision, "en")!;
    expect(d.title).toContain("Zakir");
    expect(d.body).toContain("Anton");
    expect(d.telegram).not.toContain("Закир");
  });

  it("stored params are not changed", () => {
    const params = { trader: "Закир", week: "2026-10-12" };
    renderNotification("rating_ack", params, "en");
    expect(params.trader).toBe("Закир");
  });
});

describe("other server texts", () => {
  it("error messages with a person param", () => {
    expect(errorMessage("ALREADY_ENROLLED", "en", { user: "Закир" })).toBe("Zakir is already in this cohort");
    expect(errorMessage("ALREADY_ENROLLED", "uz", { user: "Закир" })).toContain("Zakir");
    expect(errorMessage("ALREADY_ENROLLED", "ru", { user: "Закир" })).toContain("Закир");
  });

  it("staff risk / rule notices", () => {
    const snap = {
      trader: "Закир", state: "stop", halted: true, todayLoss: 600, weekLoss: 600, currentDd: 0, dailyLimit: 500, weeklyLimit: null,
      maxDrawdown: null, dailyPct: 120, weeklyPct: null, drawdownPct: null, warnPct: 70,
    };
    expect(riskNotice(snap, "en")!.staffTitle).toContain("Zakir");
    expect(riskNotice(snap, "ru")!.staffTitle).toContain("Закир");
    expect(riskNotice(snap, "en")!.params.trader).toBe("Закир");
    const items = [{ ruleName: "Стоп", message: "m", severity: "medium" as const }];
    expect(violationNotice("Закир", items, true, "en")!.title).toContain("Zakir");
    expect(violationNotice("Закир", items, true, "ru")!.title).toContain("Закир");
  });

  it("Telegram idea card", () => {
    const idea = { id: 7, ticker: "NVDA", trader: "Закир" };
    expect(buildIdeaHtml(idea, "https://x", { lang: "en" })).toContain("<b>Zakir</b>");
    expect(buildIdeaHtml(idea, "https://x", { lang: "ru" })).toContain("<b>Закир</b>");
  });
});
