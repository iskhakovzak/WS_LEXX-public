import { Lock, Users } from "lucide-react";
import { FilterChip } from "@/components/ds";
import { cn } from "@/lib/utils";
import { discussionsI18n } from "@/i18n/ns/discussions";
import { type AudienceOptions, audienceReach, isRestricted, sortTokens, tokenLabel } from "./audience";
import { personName } from "@/i18n";

/**
 * «Кому видна тема»: «Всем» or any union of stages / curators / cohorts, with a live «увидят N человек» hint.
 * `value` [] = everyone. Toggle buttons (aria-pressed) in a labelled group — keyboard and screen-reader friendly.
 */
export function AudiencePicker({ value, onChange, options, me, loading }: {
  value: string[];
  onChange: (next: string[]) => void;
  options: AudienceOptions | null | undefined;
  me: string | null;
  loading?: boolean;
}) {
  const { t } = discussionsI18n.useT();
  const restricted = isRestricted(value);
  const reach = audienceReach(value, options, me);
  const groups = options?.groups ?? [];
  // A thread being edited may carry a token the viewer cannot address any more — keep it visible and removable.
  const extra = value.filter((t) => !groups.some((g) => g.token === t));

  function toggle(token: string) {
    const next = value.includes(token) ? value.filter((t) => t !== token) : [...value, token];
    onChange(sortTokens(next));
  }

  const shown = (reach?.names.slice(0, 6) ?? []).map(personName);
  const more = (reach?.names.length ?? 0) - shown.length;

  return (
    <div className="space-y-1.5">
      <span id="disc-audience-label" className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {restricted ? <Lock className="h-3 w-3" aria-hidden="true" /> : <Users className="h-3 w-3" aria-hidden="true" />}
        {t("audience.label")}
      </span>
      <div role="group" aria-labelledby="disc-audience-label" className="flex flex-wrap gap-1.5">
        <FilterChip active={!restricted} onClick={() => onChange([])} className="min-h-8 px-2.5 text-xs">{t("audience.everyone")}</FilterChip>
        {groups.map((g) => (
          <FilterChip
            key={g.token}
            active={value.includes(g.token)}
            onClick={() => toggle(g.token)}
            count={g.members.length}
            className={cn("min-h-8 px-2.5 text-xs", g.kind === "cohort" && "max-w-full")}
          >
            {/* Stage / curator groups are labelled here (UI language); cohort names are user content from the server. */}
            <span className="truncate">{g.kind === "cohort" ? g.label : tokenLabel(g.token, options)}</span>
          </FilterChip>
        ))}
        {extra.map((t) => (
          <FilterChip key={t} active onClick={() => toggle(t)} className="min-h-8 px-2.5 text-xs">{tokenLabel(t, options)}</FilterChip>
        ))}
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {loading && !options ? t("audience.counting") : !reach ? (restricted ? t("audience.onlyGroups") : t("audience.allDesk")) : restricted ? (
          <>
            <span className="text-foreground">{t("audience.restrictedSee", { people: t("audience.people", { count: reach.count }) })}</span>
            {shown.length > 0 && <>: {more > 0 ? t("audience.andMore", { list: shown.join(", "), count: more }) : shown.join(", ")}</>}
            {reach.moderators.length > 0 && <>{shown.length > 0 ? " + " : ": "}{t("audience.moderators")}</>}
            {t("audience.restrictedTail")}
          </>
        ) : (
          t("audience.publicSee", { people: t("audience.people", { count: reach.count }) })
        )}
      </p>
    </div>
  );
}
