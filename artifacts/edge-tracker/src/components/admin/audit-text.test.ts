import { afterAll, describe, expect, it } from "vitest";
import { setLang } from "@/i18n";
import { adminAuditI18n } from "@/i18n/ns/adminAudit";
import { clearLatinNames, setLatinNames } from "@/lib/people/latin-names";
import { actorName, auditSentence, describeAudit, objectLabel, type AuditLike } from "./audit-text";

const entry = (action: string, details: Record<string, unknown> | string | null = null, extra: Partial<AuditLike> = {}): AuditLike => ({
  actor: "Ориф",
  action,
  targetType: "user",
  targetId: "12",
  details: details == null ? null : typeof details === "string" ? details : JSON.stringify(details),
  ...extra,
});

describe("describeAudit", () => {
  it("names the person and keeps the reason as detail", () => {
    const t = describeAudit(entry("user.freeze", { name: "Умид", reason: "нарушение лимита" }));
    expect(t.text).toBe("заморозил учётку Умид");
    expect(t.detail).toBe("нарушение лимита");
    expect(t.tone).toBe("down");
  });

  it("describes desk settings changes with the label and formatted values", () => {
    const x = describeAudit(entry("settings.update", { from: 0.5, to: 0.35, unit: "ratio" }, { targetType: "setting", targetId: "daily.feesShare" }));
    expect(x.text).toBe("изменил настройку деска «Комиссии: порог ошибки»");
    expect(x.detail).toBe("50% → 35%");
    const r = describeAudit(entry("settings.update", { from: false, to: true, reset: true }, { targetType: "setting", targetId: "no.label.yet" }));
    expect(r.text).toBe("вернул настройку деска «no.label.yet» к значению по умолчанию");
    expect(r.detail).toBe("Выкл → Вкл");
    expect(objectLabel("setting", "telegram.morningTime")).toBe("Настройка «Время утреннего фокуса»");
  });

  it("marks bulk actions", () => {
    expect(describeAudit(entry("user.archive", { name: "Умид", reason: "ушёл", bulk: true })).text).toContain("(массово)");
  });

  it("falls back to #id when the name is missing", () => {
    expect(describeAudit(entry("user.unfreeze", {})).text).toBe("разморозил учётку #12");
  });

  it("describes role changes with Russian role names", () => {
    const t = describeAudit(entry("user.role.change", { name: "Умид", from: "trader", role: "curator", reason: "повышение" }));
    expect(t.text).toBe("сменил роль Умид: трейдер → куратор");
  });

  it("summarises PropReports sync counters instead of raw JSON", () => {
    const t = describeAudit(entry("propreports.sync", { source: "file", fileName: "fills.csv", inserted: 3, updated: 536, unchanged: 10 }, { targetType: null, targetId: null }));
    expect(t.text).toBe("синхронизировал PropReports из файла fills.csv");
    expect(t.detail).toBe("добавлено 3, обновлено 536, без изменений 10");
    expect(t.tone).toBe("accent");
  });

  it("uses tier names from config, then the built-in ladder", () => {
    const e = entry("scaling.assign", { toTier: "junior", fromTier: "trainee" }, { targetType: "trader", targetId: "Умид" });
    expect(describeAudit(e, { junior: "Джун" }).text).toBe("назначил тир Джун трейдеру Умид");
    expect(describeAudit(e).detail).toBe("был: Стажёр");
  });

  it("has a readable fallback for unknown actions and never throws on bad JSON", () => {
    const t = describeAudit(entry("widget.delete", "{not json", { targetType: null, targetId: null }));
    expect(t.text).toBe("удалил: widget");
    expect(t.tone).toBe("down");
    const u = describeAudit(entry("widget.sync", { historyId: 5, resync: false, tierKey: "trainee" }, { targetType: "curator_notes", targetId: "7" }));
    expect(u.text).toBe("widget sync · Заметка #7");
    expect(u.detail).toBe("тир: Стажёр");
  });

  it("describes risk-limit templates in Russian without technical ids", () => {
    const e = entry("risk.limits.template", { tierKey: "trainee", fromTier: null, resync: false, historyId: 5, changes: ["дневной нет → $150", "недельный нет → $400"] }, { targetType: "trader_risk_limits", targetId: "Умид" });
    const t = describeAudit(e);
    expect(t.text).toBe("применил шаблон лимитов тира Стажёр к Умид");
    expect(t.detail).toBe("дневной нет → $150, недельный нет → $400");
    expect(`${t.text} ${t.detail}`).not.toMatch(/tierKey|resync|historyId/);
    const r = describeAudit(entry("risk.limits.template", { tierKey: "junior", fromTier: "junior", resync: true, changes: [] }, { targetType: "trader_risk_limits", targetId: "Умид" }));
    expect(r.text).toBe("сверил лимиты Умид с шаблоном тира Джун");
    expect(r.detail).toBe("лимиты уже совпадали");
    const k = describeAudit(entry("risk.limits.template", { tierKey: "trainee", changes: ["позиций нет → 2", "тир нет → trainee"] }, { targetType: "trader_risk_limits", targetId: "Умид" }));
    expect(k.detail).toBe("позиций нет → 2, тир нет → Стажёр");
  });

  it("describes the soft queue archive and stage changes", () => {
    const q = describeAudit(entry("curator.queue.archive_old", { olderThanDays: 14, archived: 249, byKind: { eod: 240, weekly: 9 } }, { targetType: "curator_queue_acks", targetId: null }));
    expect(q.text).toBe("убрал из очереди разборов 249 старых элементов");
    expect(q.detail).toBe("старше 14 дн. · дни 240, недели 9");
    const st = describeAudit(entry("academy.stage.promote", { from: "trainee", to: "junior" }, { targetType: "academy_trader_stage", targetId: "Умид" }));
    expect(st.text).toBe("повысил Умид до ступени Джун");
    expect(st.detail).toBe("была: Стажёр");
  });
});

describe("actors and sentences", () => {
  it("translates service actors", () => {
    expect(actorName("import-script")).toBe("Скрипт импорта");
    expect(actorName("Ориф")).toBe("Ориф");
  });

  it("builds a full sentence for CSV", () => {
    expect(auditSentence(entry("user.sessions.reset", { name: "Умид", reason: "смена пароля" }))).toBe("Ориф сбросил сессии Умид (смена пароля)");
  });
});

describe("describeAudit in EN / UZ", () => {
  afterAll(async () => { await setLang("ru"); });

  it("renders actions, counters and stored Russian limit diffs in the UI language; user content stays", async () => {
    await setLang("en");
    await adminAuditI18n.ready();
    expect(describeAudit(entry("user.freeze", { name: "Умид", reason: "нарушение лимита", bulk: true })).text).toBe("froze account Умид (bulk)");
    expect(describeAudit(entry("user.freeze", { name: "Умид", reason: "нарушение лимита" })).detail).toBe("нарушение лимита");
    const sync = describeAudit(entry("propreports.sync", { source: "file", fileName: "fills.csv", inserted: 3, updated: 536, unchanged: 10 }, { targetType: null, targetId: null }));
    expect(sync.text).toBe("synced PropReports from file fills.csv");
    expect(sync.detail).toBe("added 3, updated 536, unchanged 10");
    const lim = describeAudit(entry("risk.limits.template", { tierKey: "trainee", changes: ["дневной нет → $150", "тир нет → trainee", "тир Стажёр → Джун"] }, { targetType: "trader_risk_limits", targetId: "Умид" }));
    expect(lim.text).toBe("applied the Intern tier limit template to Умид");
    expect(lim.detail).toBe("daily none → $150, tier none → Intern, tier Intern → Junior");
    expect(actorName("system")).toBe("System");
    expect(auditSentence(entry("user.sessions.reset", { name: "Умид", reason: "смена пароля" }))).toBe("Ориф reset sessions for Умид (смена пароля)");
    expect(objectLabel("report", "4")).toBe("Report #4");
    // A tier still named by its seeded Russian default is translated; a renamed tier stays as written.
    const tierEntry = entry("scaling.assign", { toTier: "junior" }, { targetType: "trader", targetId: "Умид" });
    expect(describeAudit(tierEntry, { junior: "Джун" }).text).toBe("assigned tier Junior to trader Умид");
    expect(describeAudit(tierEntry, { junior: "Джун+" }).text).toBe("assigned tier Джун+ to trader Умид");

    await setLang("uz");
    await adminAuditI18n.ready();
    expect(describeAudit(entry("user.freeze", { name: "Umid" })).text).toBe("Umid akkauntini muzlatdi");
    expect(describeAudit(entry("curator.queue.archive_old", { archived: 5, byKind: { eod: 5 } }, { targetType: "curator_queue_acks", targetId: null })).detail).toBe("kunlar 5");

    // People's names show their Latin name in EN / UZ when one is set; the stored name stays in RU.
    setLatinNames([["Умид", "Umid"], ["Ориф", "Orif"], ["Антон", "Anton"]]);
    try {
      expect(describeAudit(entry("user.freeze", { name: "Умид" })).text).toBe("Umid akkauntini muzlatdi");
      await setLang("en");
      await adminAuditI18n.ready();
      expect(auditSentence(entry("user.curator.assign", { name: "Умид", to: "Антон", from: "Ориф" }))).toContain("Orif");
      expect(describeAudit(entry("user.curator.assign", { name: "Умид", to: "Антон" })).text).toContain("Anton");
      expect(actorName("Ориф")).toBe("Orif");
      expect(objectLabel("trader_risk_limits", "Умид")).toContain("Umid");
      await setLang("ru");
      expect(actorName("Ориф")).toBe("Ориф");
    } finally {
      clearLatinNames();
    }
  });
});
