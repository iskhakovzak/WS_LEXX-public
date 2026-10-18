import { afterAll, describe, expect, it } from "vitest";
import { setLang } from "@/i18n";
import { apiErrorsI18n } from "@/i18n/ns/apiErrors";
import { ApiError } from "./http";
import { describeApiError, humanizeApiError, isAiNotConfiguredError, isAuthError, isClientError, shouldRetryQuery } from "./errors";

const err = (status: number, body: unknown) =>
  new ApiError({ status, code: (body as { code?: string })?.code ?? null, message: (body as { error?: string })?.error ?? null, body });

describe("humanizeApiError (RU)", () => {
  it("the server text in the UI language wins; otherwise the code's text", () => {
    expect(humanizeApiError(err(404, { error: "Сделка не найдена", code: "TRADE_NOT_FOUND" }))).toBe("Сделка не найдена");
    expect(humanizeApiError(err(422, { error: "Pre-trade checklist required", code: "CHECKLIST_REQUIRED" }))).toBe("Сначала заполните пре-трейд чек-лист");
    expect(humanizeApiError(err(500, { code: "INTERNAL", requestId: "r1" }))).toBe("Ошибка сервера. Попробуйте ещё раз");
  });

  it("a generic code lets a Russian server text through", () => {
    expect(humanizeApiError(err(403, { error: "Только кураторы могут менять лимиты", code: "FORBIDDEN" }))).toBe("Только кураторы могут менять лимиты");
  });

  it("a generic code with an English server text falls back to the dictionary", () => {
    expect(humanizeApiError(err(403, { error: "Nope", code: "FORBIDDEN" }))).toBe("Недостаточно прав для этого действия");
  });

  it("legacy English messages are mapped", () => {
    expect(humanizeApiError(err(403, { error: "Only curators can rate ideas" }))).toBe("Ставить оценки могут только кураторы");
    expect(humanizeApiError(new Error("HTTP 404 Not Found: Trade not found"))).toBe("Не найдено — возможно, уже удалено");
  });

  it("status fallback, then generic, then caller fallback", () => {
    expect(humanizeApiError(err(404, null))).toBe("Не найдено — возможно, уже удалено");
    expect(humanizeApiError(err(418, null))).toBe("Что-то пошло не так. Попробуйте ещё раз");
    expect(humanizeApiError(err(418, null), "Не удалось сохранить")).toBe("Не удалось сохранить");
  });

  it("old error shapes still work (string, Error with JSON, generated-client-like object)", () => {
    expect(describeApiError('{"error":"x","code":"FOLDER_EXISTS"}').message).toBe("Папка с таким названием уже есть");
    expect(describeApiError({ status: 503, data: { code: "ai_not_configured" } }).message).toBe("AI не настроен");
    expect(isAiNotConfiguredError({ status: 503, data: { code: "ai_not_configured" } })).toBe(true);
    expect(isAuthError({ status: 401 })).toBe(true);
    expect(isClientError(new Error("HTTP 422: bad"))).toBe(true);
  });

  it("a serialized zod issue list is not shown", () => {
    const dump = JSON.stringify([{ code: "invalid_type", path: ["id"], message: "Expected number, received nan" }], null, 2);
    expect(humanizeApiError(err(400, { error: dump }))).toBe("Некорректный запрос — проверьте данные");
  });

  it("unknown non-API errors are retried once", () => {
    expect(shouldRetryQuery(0, new Error("boom"))).toBe(true);
    expect(shouldRetryQuery(1, new Error("boom"))).toBe(false);
  });
});

describe("humanizeApiError (EN / UZ)", () => {
  afterAll(async () => { await setLang("ru"); });

  it("translates codes and statuses, keeps an English server text for a generic code", async () => {
    await setLang("en");
    await apiErrorsI18n.ready();
    expect(humanizeApiError(err(409, { error: "Сначала заполните чек-лист", code: "CHECKLIST_REQUIRED" }))).toBe("Fill in the pre-trade checklist first");
    expect(humanizeApiError(err(403, { error: "Only admins can change limits", code: "FORBIDDEN" }))).toBe("Only admins can change limits");
    // A Russian server text (not migrated yet) is not shown to an English UI.
    expect(humanizeApiError(err(403, { error: "Только кураторы", code: "FORBIDDEN" }))).toBe("You don’t have permission to do this");
    expect(humanizeApiError(err(404, null))).toBe("Not found — it may have been deleted");
    expect(humanizeApiError(new ApiError({ status: 0, code: "NETWORK" }))).toBe("Server unreachable — check your connection");

    await setLang("uz");
    await apiErrorsI18n.ready();
    expect(humanizeApiError(err(409, { code: "CHECKLIST_REQUIRED" }))).toBe("Avval savdodan oldingi chek-listni toʻldiring");
  });
});
