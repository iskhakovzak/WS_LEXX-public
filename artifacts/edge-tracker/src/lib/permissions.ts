/**
 * Permissions matrix — frontend mirror of api-server/src/lib/permissionsMatrix.ts.
 * Keys, groups and DEFAULT_MATRIX must stay identical (scripts/check-permissions.mjs in api-server compares
 * both files). Pure module: no React, no "@/..." imports, so the offline check can load it under Node.
 *
 * At runtime the effective capabilities come from GET /api/permissions/me (desk overrides applied); the
 * defaults here are only the fallback while that request is in flight or failed.
 */

export const ROLES = ["trader", "curator", "admin", "guest"] as const;
export type Role = (typeof ROLES)[number];
export type Scope = "desk" | "assigned";

export type CapabilityDef = {
  key: Capability;
  group: string;
  /** Server payloads carry a Russian label/description; the UI shows settings `permissions.caps.*` by key. */
  label?: string;
  description?: string;
  team?: boolean;
  own?: boolean;
  adminOnly?: boolean;
};

/**
 * Group names exactly as the API matrix spells them: they are compared by scripts/check-permissions.mjs, so they act
 * as codes here. Display names: settings namespace `permissions.groups.<code>` (see PERM_GROUP_CODE).
 */
const G = {
  desk: "Деск", // i18n-ignore (code shared with the API)
  trades: "Сделки", // i18n-ignore
  journal: "Дневник", // i18n-ignore
  risk: "Риск", // i18n-ignore
  propreports: "PropReports",
  ratings: "Оценки", // i18n-ignore
  content: "Контент", // i18n-ignore
  admin: "Администрирование", // i18n-ignore
} as const;
export type PermGroupCode = keyof typeof G;
/** API group name → group code (for the translated header). */
export const PERM_GROUP_CODE: Readonly<Record<string, PermGroupCode>> = Object.fromEntries(
  (Object.entries(G) as [PermGroupCode, string][]).map(([code, name]) => [name, code]),
);

export const CAPABILITIES = [
  { key: "team.read", group: G.desk, team: true },
  { key: "users.read.team", group: G.desk, team: true },

  { key: "trades.read.own", group: G.trades, own: true },
  { key: "trades.read.team", group: G.trades, team: true },
  { key: "trades.write.own", group: G.trades, own: true },
  { key: "trades.write.any", group: G.trades, team: true },
  { key: "trades.review", group: G.trades, team: true },
  { key: "trades.review.delete.any", group: G.trades, adminOnly: true },

  { key: "journal.write.own", group: G.journal, own: true },
  { key: "journal.read.team", group: G.journal, team: true },
  { key: "journal.review", group: G.journal, team: true },
  { key: "gameplan.publish", group: G.journal },
  { key: "dailyfeed.manage", group: G.journal, team: true },
  { key: "errors.manage.team", group: G.journal, team: true },

  { key: "risk.read.own", group: G.risk, own: true },
  { key: "risk.read.team", group: G.risk, team: true },
  { key: "risk.limits.edit", group: G.risk, team: true },
  { key: "scaling.read.team", group: G.risk, team: true },
  { key: "scaling.configure", group: G.risk },
  { key: "scaling.approve", group: G.risk, team: true },
  { key: "rules.manage.team", group: G.risk, team: true },
  { key: "rules.violations.delete", group: G.risk },

  { key: "propreports.import", group: G.propreports, own: true },
  { key: "propreports.read.team", group: G.propreports, team: true },
  { key: "propreports.configure", group: G.propreports },
  { key: "propreports.sync", group: G.propreports },

  { key: "ratings.read.team", group: G.ratings, team: true },
  { key: "ratings.write", group: G.ratings, team: true },
  { key: "ratings.manage.any", group: G.ratings, adminOnly: true },

  { key: "playbook.edit", group: G.content },
  { key: "playbook.edit.any", group: G.content, team: true },
  { key: "playbook.review", group: G.content },
  { key: "ideas.publish", group: G.content, own: true },
  { key: "ideas.review", group: G.content, team: true },
  { key: "discussions.moderate", group: G.content },
  { key: "discussions.edit.any", group: G.content, adminOnly: true },
  { key: "checklist.template.edit", group: G.content },
  { key: "watchlist.manage", group: G.content },

  { key: "users.manage", group: G.admin },
  { key: "users.manage.admins", group: G.admin, adminOnly: true },
  { key: "admin.reports", group: G.admin },
  { key: "admin.audit", group: G.admin },
  { key: "admin.backups.read", group: G.admin },
  { key: "admin.backups.run", group: G.admin, adminOnly: true },
  { key: "telegram.broadcast", group: G.admin },
  { key: "digest.manage.any", group: G.admin, team: true },
  { key: "permissions.manage", group: G.admin, adminOnly: true },
  { key: "admin.errors", group: G.admin, adminOnly: true },
  { key: "settings.manage", group: G.admin, adminOnly: true },
] as const;

export type Capability = (typeof CAPABILITIES)[number]["key"];

export const CAPABILITY_KEYS: readonly Capability[] = CAPABILITIES.map((c) => c.key);
export const CAPABILITY_DEFS: readonly CapabilityDef[] = CAPABILITIES as unknown as readonly CapabilityDef[];
const CAP_BY_KEY = new Map<string, CapabilityDef>(CAPABILITY_DEFS.map((c) => [c.key, c]));

export function capabilityDef(cap: string): CapabilityDef | undefined {
  return CAP_BY_KEY.get(cap);
}

const MEMBER_CAPS: readonly Capability[] = [
  "trades.read.own", "trades.write.own", "journal.write.own", "risk.read.own", "propreports.import",
  "playbook.edit", "ideas.publish", "watchlist.manage",
];

const CURATOR_CAPS: readonly Capability[] = [
  ...MEMBER_CAPS,
  "team.read", "users.read.team",
  "trades.read.team", "trades.write.any", "trades.review",
  "journal.read.team", "journal.review", "gameplan.publish", "dailyfeed.manage", "errors.manage.team",
  "risk.read.team", "risk.limits.edit", "scaling.read.team", "scaling.configure", "scaling.approve",
  "rules.manage.team", "rules.violations.delete",
  "propreports.read.team", "propreports.configure", "propreports.sync",
  "ratings.read.team", "ratings.write",
  "playbook.edit.any", "playbook.review", "ideas.review", "discussions.moderate", "checklist.template.edit",
  "users.manage", "admin.reports", "admin.audit", "admin.backups.read", "telegram.broadcast", "digest.manage.any",
];

export const DEFAULT_MATRIX: Readonly<Record<Role, readonly Capability[]>> = {
  guest: [],
  trader: MEMBER_CAPS,
  curator: CURATOR_CAPS,
  admin: CAPABILITY_KEYS,
};

export const DEFAULT_SCOPE: Scope = "desk";

export function normalizeRole(role: string | null | undefined): Role {
  return role === "admin" || role === "curator" || role === "guest" ? role : "trader";
}

// ─── What GET /api/permissions/me returns ────────────────────────────────────

export type PermissionsMe = {
  name: string | null;
  role: Role;
  guest: boolean;
  capabilities: Capability[];
  /** Scope of every team capability the role holds. */
  scopes: Partial<Record<Capability, Scope>>;
  /** Traders assigned to this actor (curator / risk manager / mentor) — matter only under "assigned" scope. */
  wards: string[];
  /** True when the desk has overrides on top of the defaults. */
  customized: boolean;
  updatedAt: string | null;
};

export type Target = { trader?: string | null };

/** Defaults for a role — the fallback while /api/permissions/me is loading (or failed). */
export function defaultPermissions(role: string | null | undefined, name: string | null): PermissionsMe {
  const r = normalizeRole(role);
  return {
    name,
    role: r,
    guest: r === "guest",
    capabilities: [...DEFAULT_MATRIX[r]],
    scopes: {},
    wards: [],
    customized: false,
    updatedAt: null,
  };
}

/**
 * Client-side evaluation — mirrors `evaluate` in the API:
 *  - the capability must be held;
 *  - own caps: target.trader (when given) must be me;
 *  - team caps under "assigned" scope: target must be me or one of my wards.
 * Only a UI hint — the API re-checks every request.
 */
export function canWith(me: PermissionsMe | null | undefined, cap: Capability, target?: Target | null): boolean {
  if (!me || me.guest) return false;
  if (!me.capabilities.includes(cap)) return false;
  const def = CAP_BY_KEY.get(cap);
  if (!def) return false;
  const t = target?.trader?.trim() || null;
  if (def.own) return t === null || t === me.name;
  if (def.team && t !== null && t !== me.name && (me.scopes[cap] ?? DEFAULT_SCOPE) === "assigned") return me.wards.includes(t);
  return true;
}

/** Group capabilities for the Settings matrix, preserving the declaration order. */
export function groupedCapabilities(defs: readonly CapabilityDef[] = CAPABILITY_DEFS): { group: string; items: CapabilityDef[] }[] {
  const out: { group: string; items: CapabilityDef[] }[] = [];
  for (const d of defs) {
    let g = out.find((x) => x.group === d.group);
    if (!g) { g = { group: d.group, items: [] }; out.push(g); }
    g.items.push(d);
  }
  return out;
}
