/**
 * Capability texts (label, description, group) in the reader's language for Settings → Permissions
 * (GET /permissions/matrix → `capabilities`).
 *
 * The Russian texts stay in lib/permissionsMatrix.ts: that file is imported raw by scripts/check-permissions.mjs
 * (Node type stripping, no bundler, so it cannot import dictionaries) and mirrored by the frontend
 * (edge-tracker/src/lib/permissions.ts, same groups). EN/UZ live in src/i18n/{en,uz}/permissions.ts, keyed by
 * capability (tsc rejects a missing capability). Keys and flags never change with the language.
 */
import { isLang, type Lang } from "../i18n";
import { CAPABILITY_DEFS, capabilityDef, type Capability, type CapabilityDef } from "./permissionsMatrix";
import en from "../i18n/en/permissions";
import uz from "../i18n/uz/permissions";

export type CapabilityGroupCode = "desk" | "trades" | "journal" | "risk" | "propreports" | "ratings" | "content" | "admin";

export type CapabilityTexts = {
  groups: Record<CapabilityGroupCode, string>;
  caps: Record<Capability, { label: string; description: string }>;
};

/** A capability that sits in each group (the RU group title is read from it, so no Russian is repeated here). */
const GROUP_ANCHOR: Record<CapabilityGroupCode, Capability> = {
  desk: "team.read",
  trades: "trades.read.own",
  journal: "journal.write.own",
  risk: "risk.read.own",
  propreports: "propreports.import",
  ratings: "ratings.read.team",
  content: "playbook.edit",
  admin: "users.manage",
};

const GROUP_CODE = new Map<string, CapabilityGroupCode>(
  (Object.entries(GROUP_ANCHOR) as [CapabilityGroupCode, Capability][]).map(([code, cap]) => [capabilityDef(cap)!.group, code]),
);

/** Stable group code of a capability (for clients that want to group without relying on the title). */
export function capabilityGroupCode(def: CapabilityDef): CapabilityGroupCode | null {
  return GROUP_CODE.get(def.group) ?? null;
}

const TEXTS: Partial<Record<Lang, CapabilityTexts>> = { en, uz };
const cache = new Map<Lang, (CapabilityDef & { groupCode: CapabilityGroupCode | null })[]>();

/** CAPABILITY_DEFS with texts in `lang` (+ `groupCode`). Russian = the matrix itself. */
export function localizedCapabilityDefs(lang: Lang | null | undefined): (CapabilityDef & { groupCode: CapabilityGroupCode | null })[] {
  const l: Lang = isLang(lang) ? lang : "ru";
  const hit = cache.get(l);
  if (hit) return hit;
  const texts = TEXTS[l];
  const out = CAPABILITY_DEFS.map((d) => {
    const groupCode = capabilityGroupCode(d);
    if (!texts) return { ...d, groupCode };
    const t = texts.caps[d.key];
    return {
      ...d,
      label: t?.label ?? d.label,
      description: t?.description ?? d.description,
      group: groupCode ? texts.groups[groupCode] : d.group,
      groupCode,
    };
  });
  cache.set(l, out);
  return out;
}

/** Label of one capability in `lang` (error details, audit texts). */
export function capabilityLabel(cap: string, lang: Lang | null | undefined): string {
  return localizedCapabilityDefs(lang).find((d) => d.key === cap)?.label ?? cap;
}
