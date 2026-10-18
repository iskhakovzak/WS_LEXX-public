import { describe, expect, it } from "vitest";
import {
  applyFailure, lockMinutes, lockoutKey, memoryLockoutStore, normalizeLoginName, resolveLoginName,
  LOCK_THRESHOLD, FAILURE_WINDOW_MIN, LEVEL_DECAY_HOURS,
} from "../loginGuard";
import { checkSecret, mustChangeSecret, secretPolicyFor } from "../passwordPolicy";

const people = [
  { id: 1, name: "Закир", nameLatin: "Zakir Ishakov" },
  { id: 2, name: "Антон", nameLatin: null },
  { id: 3, name: "Артур", nameLatin: null },
  { id: 4, name: "Рахматулло", nameLatin: null },
  { id: 5, name: "Ориф Б.", nameLatin: null },
  { id: 6, name: "Ориф К.", nameLatin: null },
  { id: 7, name: "Дмитрий К.", nameLatin: null },
];

describe("resolveLoginName", () => {
  it("exact normalized match (case, spaces, ё)", () => {
    expect(resolveLoginName(people, "  закир ")?.id).toBe(1);
    expect(resolveLoginName(people, "ЗАКИР")?.id).toBe(1);
    expect(resolveLoginName(people, "Zakir   Ishakov")?.id).toBe(1);
  });

  it("cross-script: Latin / Uzbek spellings resolve to the Cyrillic name", () => {
    expect(resolveLoginName(people, "Zakir")?.id).toBe(1);
    expect(resolveLoginName(people, "Rakhmatullo")?.id).toBe(4);
    expect(resolveLoginName(people, "Anton")?.id).toBe(2);
  });

  it("keyboard-layout slip («Pfrbh» typed for «Закир»)", () => {
    expect(resolveLoginName(people, "Pfrbh")?.id).toBe(1);
  });

  it("ambiguous → null (two «Ориф»)", () => {
    expect(resolveLoginName(people, "Ориф")).toBeNull();
    expect(resolveLoginName(people, "Ориф Б.")?.id).toBe(5);
  });

  it("unknown or too short → null", () => {
    expect(resolveLoginName(people, "Незнакомец")).toBeNull();
    expect(resolveLoginName(people, "А")).toBeNull();
    expect(resolveLoginName(people, "   ")).toBeNull();
  });

  it("does not depend on list order", () => {
    const rev = [...people].reverse();
    for (const q of ["Zakir", "Антон", "Ориф", "Rakhmatullo", "Артур"]) {
      expect(resolveLoginName(rev, q)?.id ?? null).toBe(resolveLoginName(people, q)?.id ?? null);
    }
  });

  it("normalizeLoginName unifies apostrophes", () => {
    expect(normalizeLoginName("Oʻtkir")).toBe(normalizeLoginName("O'tkir"));
  });
});

describe("lockout policy", () => {
  it("escalates 15 → 30 → 60 … capped at 24 h", () => {
    expect([0, 1, 2, 3].map(lockMinutes)).toEqual([15, 30, 60, 120]);
    expect(lockMinutes(20)).toBe(24 * 60);
  });

  it("locks on the 5th failure, then the next lock is twice as long", async () => {
    const store = memoryLockoutStore();
    const t0 = new Date("2026-10-17T10:00:00Z");
    for (let i = 1; i < LOCK_THRESHOLD; i++) expect(await store.fail("u:1", 1, t0)).toEqual({ locked: false, failures: i });
    const first = await store.fail("u:1", 1, t0);
    expect(first.locked && first.minutes).toBe(15);
    expect((await store.check("u:1", new Date(t0.getTime() + 14 * 60_000))).locked).toBe(true);
    const after = new Date(t0.getTime() + 16 * 60_000);
    expect((await store.check("u:1", after)).locked).toBe(false);
    let r = await store.fail("u:1", 1, after);
    for (let i = 1; i < LOCK_THRESHOLD; i++) r = await store.fail("u:1", 1, after);
    expect(r.locked && r.minutes).toBe(30);
  });

  it("a different account is unaffected; success clears", async () => {
    const store = memoryLockoutStore();
    for (let i = 0; i < LOCK_THRESHOLD; i++) await store.fail("u:1", 1);
    expect((await store.check("u:1")).locked).toBe(true);
    expect((await store.check("u:2")).locked).toBe(false);
    await store.clear("u:1");
    expect((await store.check("u:1")).locked).toBe(false);
  });

  it("old failures start a fresh count; old lock levels decay", () => {
    const t0 = new Date("2026-10-17T10:00:00Z");
    const prev = { userId: 1, failures: 4, level: 2, lockedUntil: null, lastFailureAt: t0 };
    const later = new Date(t0.getTime() + (FAILURE_WINDOW_MIN + 1) * 60_000);
    expect(applyFailure(prev, 1, later).row.failures).toBe(1);
    expect(applyFailure(prev, 1, later).row.level).toBe(2);
    const muchLater = new Date(t0.getTime() + (LEVEL_DECAY_HOURS + 1) * 3600_000);
    expect(applyFailure(prev, 1, muchLater).row.level).toBe(0);
  });

  it("unknown names lock under a hashed key (the typed text is not stored)", () => {
    const k = lockoutKey(null, "  Какой-то Пароль123 ");
    expect(k).toMatch(/^n:[0-9a-f]{32}$/);
    expect(k).toBe(lockoutKey(null, "какой-то пароль123"));
    expect(lockoutKey({ id: 9 }, "x")).toBe("u:9");
  });
});

describe("secret policy", () => {
  it("traders: PIN ≥ 6; staff: password ≥ 10", () => {
    expect(secretPolicyFor("trader")).toMatchObject({ kind: "pin", min: 6 });
    expect(secretPolicyFor("curator")).toMatchObject({ kind: "password", min: 10 });
    expect(checkSecret("trader", "12345")).toEqual({ code: "TOO_SHORT", min: 6 });
    expect(checkSecret("trader", "123456")).toBeNull();
    expect(checkSecret("admin", "123456789")).toEqual({ code: "TOO_SHORT", min: 10 });
    expect(checkSecret("admin", "a-long-pass")).toBeNull();
    expect(checkSecret("curator", "Antonovich1", "antonovich1")).toEqual({ code: "SAME_AS_NAME" });
  });

  it("forced change only for staff with a short secret", () => {
    expect(mustChangeSecret("curator", "123456")).toBe(true);
    expect(mustChangeSecret("admin", "0123456789")).toBe(false);
    expect(mustChangeSecret("trader", "123456")).toBe(false);
  });
});
