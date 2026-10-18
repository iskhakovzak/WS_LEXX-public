/**
 * Secret policy by role — mirror of api-server lib/security/passwordPolicy.ts (the API re-checks every change):
 * traders sign in with a PIN of 6+ characters, curators and admins with a password of 10+.
 */
export const TRADER_MIN_SECRET = 6;
export const STAFF_MIN_SECRET = 10;

export function secretMinFor(role: string | null | undefined): number {
  return role === "curator" || role === "admin" ? STAFF_MIN_SECRET : TRADER_MIN_SECRET;
}
