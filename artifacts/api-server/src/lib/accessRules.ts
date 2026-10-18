/**
 * Access rules — PURE decisions (no DB, no express), unit-tested in __tests__/accessRules.test.ts.
 * Routes resolve the actor (lib/permissions resolveActor: role from the DB, guest flag) and the team capability
 * grant, then ask these helpers. Keeping the decision here means the rule is tested once and every route that
 * needs it says the same thing.
 */

/** The caller as these rules need it. null/undefined = anonymous or inactive/banned. */
export type RuleActor = { name: string; role: string; guest: boolean } | null | undefined;

/** curator / admin (same rule as lib/auth isStaffRole — not imported: auth.ts needs JWT_SECRET at import time). */
export function isStaffRoleName(role: string | null | undefined): boolean {
  return role === "curator" || role === "admin";
}

/**
 * Shared desk rows with an author (big7 levels / catalysts / tickers, watchlist content): the author or staff may
 * edit/delete. Rows without an author (created before created_by existed, or seeded) are staff-only. Guests and
 * anonymous callers never.
 */
export function canModifyOwnedRow(actor: RuleActor, createdBy: string | null | undefined): boolean {
  if (!actor || actor.guest || !actor.name) return false;
  if (isStaffRoleName(actor.role)) return true;
  const owner = typeof createdBy === "string" ? createdBy.trim() : "";
  return owner !== "" && owner === actor.name;
}

/**
 * Personal data keyed by a trader name (emotional check-ins, weekly psychology report, executions of a trade):
 * the owner, or a member whose team capability (journal.read.team, trades.read.team …) covers that trader.
 * `teamAllowed` is the result of `can(req, cap, { trader: owner })`. Guests never — not even with a forged name.
 */
export function canReadPersonal(actor: RuleActor, owner: string | null | undefined, teamAllowed: boolean): boolean {
  if (!actor || actor.guest || !actor.name) return false;
  const o = typeof owner === "string" ? owner.trim() : "";
  if (o && o === actor.name) return true;
  return teamAllowed;
}

/**
 * Executions of a trade (GET /trades/:id/executions). Same rule as GET /trades/:id: own trade, team read
 * capability, or the trade is an example of a setup the viewer may read in the playbook (shown in R only —
 * lib/playbookPrivacy redacts qty / $ for non-staff). Guests: never.
 */
export function canReadTradeExecutions(
  actor: RuleActor,
  owner: string | null | undefined,
  opts: { teamAllowed: boolean; readableExample: boolean },
): boolean {
  if (!actor || actor.guest || !actor.name) return false;
  return canReadPersonal(actor, owner, opts.teamAllowed) || opts.readableExample;
}

/**
 * Is POST /auth/guest enabled? GUEST_MODE=1|true|on|yes enables, 0|false|off|no disables. Unset: enabled outside
 * production (keeps local development unchanged), disabled in production.
 */
export function guestModeEnabled(env: { GUEST_MODE?: string; NODE_ENV?: string }): boolean {
  const raw = (env.GUEST_MODE ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  if (["0", "false", "off", "no"].includes(raw)) return false;
  return env.NODE_ENV !== "production";
}
