import { createNamespace } from "..";
import ru from "../locales/ru/settings";

/** /settings page: sections, profile, appearance, trading defaults, digest, data, integrations, permissions. */
export const settingsI18n = createNamespace("settings", ru, {
  en: () => import("../locales/en/settings"),
  uz: () => import("../locales/uz/settings"),
});

export type SettingsSectionKey = keyof typeof ru.sections;
export type PermGroupCode = keyof typeof ru.permissions.groups;

/** Capability name in the UI language by capability key ("trades.read.own"); undefined for unknown keys. */
export function capabilityText(key: string, field: "label" | "description"): string | undefined {
  return settingsI18n.tryT(`permissions.caps.${key.replace(/\./g, "_")}.${field}`);
}
