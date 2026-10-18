import { afterEach, describe, expect, it } from "vitest";
import { i18nReady, setLang } from "./index";
import { capabilityText } from "./ns/settings";
import { notificationsI18n } from "./ns/notifications";
import { CAPABILITY_KEYS, CAPABILITIES, PERM_GROUP_CODE } from "@/lib/permissions";
import { TYPES, notificationTitle, typeLabelOf, normalizeNotification, timeAgo } from "@/components/notifications/model";
import { GLOSSARY } from "@/components/ds/term-tooltip";
import { KPI_FORMULAS } from "@/lib/trade-math";
import { PERIOD_HINT } from "@/lib/period-links";
import { resultLabelRu } from "@/lib/trade-result";
import { TRADE_TAGS } from "@/lib/tags";
import { PHASE_LABEL, getSessionState } from "@/components/dashboard/market-session";

async function inLang(lang: "ru" | "en" | "uz") {
  await setLang(lang, { source: "init" });
  await i18nReady();
}

afterEach(async () => {
  await setLang("ru", { source: "init" });
});

describe("shared registries follow the UI language", () => {
  it("every capability and permission group has a name in all languages", async () => {
    for (const lang of ["ru", "en", "uz"] as const) {
      await inLang(lang);
      for (const k of CAPABILITY_KEYS) {
        expect(capabilityText(k, "label"), `${lang} ${k}`).toBeTruthy();
        expect(capabilityText(k, "description"), `${lang} ${k}`).toBeTruthy();
      }
    }
    for (const c of CAPABILITIES) expect(PERM_GROUP_CODE[c.group], c.key).toBeTruthy();
  });

  it("notification types, titles and ages", async () => {
    for (const t of TYPES) expect(notificationsI18n.tryT(`types.${t.type}.label`), t.type).toBeTruthy();
    await inLang("en");
    expect(typeLabelOf("risk_breach")).toBe("Limit exceeded");
    expect(TYPES.find((t) => t.type === "mention")!.label).toBe("Mention");
    // A row whose title is just the server's (Russian) type label shows the label in the UI language.
    const n = normalizeNotification({ id: 1, type: "limit_change", typeLabel: "Изменение лимитов", title: "Изменение лимитов", body: "x" })!;
    expect(notificationTitle(n)).toBe("Limits changed");
    // Own titles (server-rendered or legacy stored text) are kept.
    const own = normalizeNotification({ id: 2, type: "mention", typeLabel: "Упоминание", title: "Mentioned in “NVDA”", body: "" })!;
    expect(notificationTitle(own)).toBe("Mentioned in “NVDA”");
    expect(timeAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5 min");
    await inLang("uz");
    expect(timeAgo(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe("3 soat");
  });

  it("glossary tooltips, KPI formulas, period hints, results, tag categories, market phases", async () => {
    expect(GLOSSARY.drawdown.label).toBe("Просадка");
    await inLang("en");
    expect(GLOSSARY.pf.title).toBe("Profit factor");
    expect(GLOSSARY.pf.label).toBe("PF");
    expect(GLOSSARY.gross.formula).toBeUndefined();
    expect(KPI_FORMULAS.netPnl).toBe("Net P&L = gross − fees");
    expect(PERIOD_HINT.week).toBe("Open the week");
    expect(resultLabelRu("прибыль")).toBe("Profit");
    expect(TRADE_TAGS.mistakes.name).toBe("Mistakes / lessons");
    expect(PHASE_LABEL.regular).toBe("Regular session");
    await inLang("uz");
    expect(GLOSSARY.drawdown.label).toBe("Pasayish");
    const s = getSessionState(new Date(Date.UTC(2026, 9, 16, 15, 0)), []); // Fri 11:00 ET
    expect(s.nextKey).toBe("toClose");
    expect(s.nextLabel).toBe("yopilishigacha");
  });
});
