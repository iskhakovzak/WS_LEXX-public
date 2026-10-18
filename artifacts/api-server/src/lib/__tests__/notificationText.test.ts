import { describe, expect, it } from "vitest";
import { renderNotification } from "../notificationText";

describe("renderNotification (text as data, RU / EN / UZ)", () => {
  const review = { ticker: "NVDA", status: "rejected", reason: "стоп <шире> 1R", actor: "Антон" };

  it("renders the same params in each language", () => {
    expect(renderNotification("idea_review", review, "ru")).toMatchObject({ title: "Идея NVDA — ❌ Отклонена", body: "Идея NVDA — ❌ Отклонена: стоп <шире> 1R (от Антон)" });
    expect(renderNotification("idea_review", review, "en")).toMatchObject({ title: "Idea NVDA — ❌ Rejected", body: "Idea NVDA — ❌ Rejected: стоп <шире> 1R (by Антон)" });
    expect(renderNotification("idea_review", review, "uz")).toMatchObject({ title: "NVDA gʻoyasi — ❌ Rad etildi" });
  });

  it("Telegram text is HTML with escaped params", () => {
    const tg = renderNotification("idea_review", review, "en")!.telegram;
    expect(tg).toContain("<b>NVDA</b>");
    expect(tg).toContain("стоп &lt;шире&gt; 1R");
  });

  it("plurals and variants", () => {
    const p = { name: "Challenge 1", user: "Закир", outcome: "passed", net: "$1,250.00", days: 5 };
    expect(renderNotification("academy_challenge_passed", p, "ru")).toMatchObject({ title: "Экзамен сдан: Challenge 1", body: "Итог $1,250.00 за 5 торговых дней." });
    expect(renderNotification("academy_challenge_passed", { ...p, days: 1 }, "en")!.body).toBe("Result $1,250.00 over 1 trading day.");
    expect(renderNotification("academy_challenge_passed", { ...p, variant: "staff" }, "en")!.title).toBe("Закир: Challenge passed: Challenge 1");
    const ready = { user: "Закир", total: 6, from: "Стажёр", to: "Джун" };
    expect(renderNotification("academy_promotion_ready", ready, "ru")!.body).toContain("Можно подать заявку наставнику");
    expect(renderNotification("academy_promotion_ready", { ...ready, variant: "staff" }, "uz")!.title).toBe("Oʻquvchi keyingi bosqichga tayyor");
    expect(renderNotification("mention", { actor: "Ольга", preview: "привет", subject: "NVDA" }, "en")!.title).toBe("Mentioned in the discussion “NVDA”");
    expect(renderNotification("mention", { actor: "Ольга", preview: "привет" }, "ru")!.title).toBe("Упоминание в обсуждении");
  });

  it("unknown types / missing params fall back to the stored text (null)", () => {
    expect(renderNotification("rule_violation", { x: 1 }, "en")).toBeNull();
    expect(renderNotification("idea_review", null, "en")).toBeNull();
    expect(renderNotification("idea_review", { ticker: "X", status: "weird", actor: "A" }, "en")).toBeNull();
  });
});
