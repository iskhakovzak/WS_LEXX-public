import { describe, expect, it } from "vitest";
import {
  canModifyOwnedRow, canReadPersonal, canReadTradeExecutions, guestModeEnabled, isStaffRoleName, type RuleActor,
} from "../accessRules";

const trader: RuleActor = { name: "Закир", role: "trader", guest: false };
const otherTrader: RuleActor = { name: "Артур", role: "trader", guest: false };
const curator: RuleActor = { name: "Ориф", role: "curator", guest: false };
const admin: RuleActor = { name: "Тимур", role: "admin", guest: false };
// A guest token is a synthetic identity; even if its name collides with a member's, it must never pass.
const guest: RuleActor = { name: "Закир", role: "guest", guest: true };

describe("isStaffRoleName", () => {
  it("curator and admin are staff, trader / guest / missing are not", () => {
    expect(isStaffRoleName("curator")).toBe(true);
    expect(isStaffRoleName("admin")).toBe(true);
    expect(isStaffRoleName("trader")).toBe(false);
    expect(isStaffRoleName("guest")).toBe(false);
    expect(isStaffRoleName(null)).toBe(false);
  });
});

describe("canModifyOwnedRow (big7 levels / catalysts / tickers, watchlist content)", () => {
  it("the author may edit/delete their own row", () => {
    expect(canModifyOwnedRow(trader, "Закир")).toBe(true);
    expect(canModifyOwnedRow(trader, " Закир ")).toBe(true);
  });
  it("another member may not", () => {
    expect(canModifyOwnedRow(otherTrader, "Закир")).toBe(false);
  });
  it("staff may edit/delete any row", () => {
    expect(canModifyOwnedRow(curator, "Закир")).toBe(true);
    expect(canModifyOwnedRow(admin, "Закир")).toBe(true);
  });
  it("rows without an author (legacy / seeded, created_by NULL) are staff-only", () => {
    expect(canModifyOwnedRow(trader, null)).toBe(false);
    expect(canModifyOwnedRow(trader, undefined)).toBe(false);
    expect(canModifyOwnedRow(trader, "")).toBe(false);
    expect(canModifyOwnedRow(curator, null)).toBe(true);
  });
  it("guests and anonymous callers never, even a guest whose name matches the author", () => {
    expect(canModifyOwnedRow(guest, "Закир")).toBe(false);
    expect(canModifyOwnedRow({ name: "Ориф", role: "curator", guest: true }, null)).toBe(false);
    expect(canModifyOwnedRow(null, "Закир")).toBe(false);
    expect(canModifyOwnedRow(undefined, null)).toBe(false);
  });
});

describe("canReadPersonal (emotional state, weekly psychology report)", () => {
  it("the owner always reads their own data", () => {
    expect(canReadPersonal(trader, "Закир", false)).toBe(true);
  });
  it("another trader without the team capability is denied", () => {
    expect(canReadPersonal(otherTrader, "Закир", false)).toBe(false);
  });
  it("a member whose team capability covers the owner may read", () => {
    expect(canReadPersonal(curator, "Закир", true)).toBe(true);
    expect(canReadPersonal(otherTrader, "Закир", true)).toBe(true);
  });
  it("staff without the grant for that trader (assigned-scope desk) is denied", () => {
    expect(canReadPersonal(curator, "Закир", false)).toBe(false);
  });
  it("guests never, regardless of name or grant", () => {
    expect(canReadPersonal(guest, "Закир", true)).toBe(false);
    expect(canReadPersonal(null, "Закир", true)).toBe(false);
  });
});

describe("canReadTradeExecutions", () => {
  it("own trade or team grant", () => {
    expect(canReadTradeExecutions(trader, "Закир", { teamAllowed: false, readableExample: false })).toBe(true);
    expect(canReadTradeExecutions(curator, "Закир", { teamAllowed: true, readableExample: false })).toBe(true);
  });
  it("a member may read executions of a playbook-example trade they can see (redacted to R later)", () => {
    expect(canReadTradeExecutions(otherTrader, "Закир", { teamAllowed: false, readableExample: true })).toBe(true);
  });
  it("someone else's non-example trade is denied", () => {
    expect(canReadTradeExecutions(otherTrader, "Закир", { teamAllowed: false, readableExample: false })).toBe(false);
  });
  it("guests are denied even for example trades", () => {
    expect(canReadTradeExecutions(guest, "Артур", { teamAllowed: true, readableExample: true })).toBe(false);
    expect(canReadTradeExecutions(undefined, "Артур", { teamAllowed: false, readableExample: true })).toBe(false);
  });
});

describe("guestModeEnabled (GUEST_MODE)", () => {
  it("unset: enabled outside production, disabled in production", () => {
    expect(guestModeEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(guestModeEnabled({})).toBe(true);
    expect(guestModeEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(guestModeEnabled({ NODE_ENV: "production", GUEST_MODE: "" })).toBe(false);
  });
  it("explicit on values enable it even in production", () => {
    for (const v of ["1", "true", "TRUE", " on ", "yes"]) {
      expect(guestModeEnabled({ NODE_ENV: "production", GUEST_MODE: v })).toBe(true);
    }
  });
  it("explicit off values disable it even in development", () => {
    for (const v of ["0", "false", "Off", "no"]) {
      expect(guestModeEnabled({ NODE_ENV: "development", GUEST_MODE: v })).toBe(false);
    }
  });
  it("unrecognised values fall back to the NODE_ENV default", () => {
    expect(guestModeEnabled({ NODE_ENV: "development", GUEST_MODE: "maybe" })).toBe(true);
    expect(guestModeEnabled({ NODE_ENV: "production", GUEST_MODE: "maybe" })).toBe(false);
  });
});
