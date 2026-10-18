/**
 * Admin → «Роли и права». Explains the three roles and the tier ladder, then embeds the role × capability
 * matrix (GET/PUT /api/permissions/matrix). The matrix is editable only with permissions.manage (admins);
 * curators see it read-only — PermissionsSection handles both modes and every save is audited server-side.
 */
import { ChevronRight, Crown, GraduationCap, ShieldCheck, UserCog } from "lucide-react";
import { Panel, Pill } from "@/components/ds";
import { PermissionsSection } from "@/components/settings/PermissionsSection";
import { useAuth } from "@/contexts/auth-context";
import { useTiers } from "./console-api";
import { roleLabel, tierDisplayName } from "./api";
import { adminI18n } from "@/i18n/ns/admin";

const ROLES = [
  { key: "trader", icon: GraduationCap },
  { key: "curator", icon: UserCog },
  { key: "admin", icon: Crown },
] as const;

export function RolesPanel() {
  const { can } = useAuth();
  const { t } = adminI18n.useT();
  const { data: tiers } = useTiers();
  const editable = can("permissions.manage");
  const ladder = (tiers ?? []).filter((t) => t.key !== "lead");
  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      <Panel
        title={t("roles.title")}
        icon={ShieldCheck}
        description={editable ? t("roles.descriptionEdit") : t("roles.descriptionView")}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {ROLES.map((r) => (
            <div key={r.key} className="rounded-xl bg-[var(--glass-bg)] p-3">
              <div className="mb-1 flex items-center gap-2 text-sm font-medium">
                <r.icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                {roleLabel(r.key)}
              </div>
              <p className="text-xs text-muted-foreground">{t(`roles.${r.key}`)}</p>
            </div>
          ))}
        </div>
        {ladder.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="mr-1">{t("roles.ladder")}</span>
            {ladder.map((t, i) => (
              <span key={t.key} className="inline-flex items-center gap-1.5">
                {i > 0 && <ChevronRight className="h-3 w-3" aria-hidden="true" />}
                <Pill tone="neutral">{tierDisplayName(t.key, t.name)}</Pill>
              </span>
            ))}
            <span className="ml-1">{t("roles.ladderHint")}</span>
          </div>
        )}
      </Panel>
      <PermissionsSection />
    </div>
  );
}
