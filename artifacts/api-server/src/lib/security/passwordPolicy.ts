/**
 * Secret policy by role (owner decision 2026-10-17): traders sign in with a PIN (6+ characters, usually 6 digits),
 * curators and admins with a password of at least 10 characters. Pure — no DB, no express.
 *
 * Staff whose current secret is shorter than the staff minimum get a token with `pwc: true` at sign-in
 * (lib/auth signToken); the API gate then allows only the password-change endpoint until they set a new one.
 */
export const TRADER_MIN_SECRET = 6;
export const STAFF_MIN_SECRET = 10;
export const MAX_SECRET = 200;

export type SecretKind = "pin" | "password";

export function isStaffRoleName(role: string | null | undefined): boolean {
  return role === "curator" || role === "admin";
}

export function secretPolicyFor(role: string | null | undefined): { kind: SecretKind; min: number; max: number } {
  return isStaffRoleName(role)
    ? { kind: "password", min: STAFF_MIN_SECRET, max: MAX_SECRET }
    : { kind: "pin", min: TRADER_MIN_SECRET, max: MAX_SECRET };
}

/** Staff signing in with a secret that no longer meets the staff minimum must change it before using the app. */
export function mustChangeSecret(role: string | null | undefined, typedSecret: string): boolean {
  return isStaffRoleName(role) && typedSecret.length < STAFF_MIN_SECRET;
}

export type SecretProblem =
  | { code: "TOO_SHORT"; min: number }
  | { code: "TOO_LONG"; max: number }
  | { code: "SAME_AS_NAME" };

/** null = acceptable for this role. Comparison with the old secret is the caller's job (it needs the hash). */
export function checkSecret(role: string | null | undefined, secret: string, name?: string | null): SecretProblem | null {
  const p = secretPolicyFor(role);
  if (secret.length < p.min) return { code: "TOO_SHORT", min: p.min };
  if (secret.length > p.max) return { code: "TOO_LONG", max: p.max };
  if (name && secret.trim().toLowerCase() === name.trim().toLowerCase()) return { code: "SAME_AS_NAME" };
  return null;
}
