/**
 * Search-highlighted person names for the curator group (table and cards). Names are shown with personName()
 * (Latin in EN / UZ when an admin set one), so the highlight must come from the search field that is displayed.
 * Field numbers follow group-model.searchTraders: 0 trader as shown, 1 the other spelling, 2 curator as shown.
 */
import { Highlight } from "@/components/people/highlight";
import { personName } from "@/i18n";
import type { TraderSignal } from "./api";
import type { SearchMark } from "./group-model";

/** The trader's display name; search field 0 holds exactly this text. */
export function TraderNameHL({ s, mark }: { s: TraderSignal; mark: SearchMark | undefined }) {
  return <Highlight text={personName(s.trader)} ranges={mark?.field === 0 ? mark.ranges : null} />;
}

/** The Latin alias under the name, only when it differs from what is shown (field 1 in Russian, else field 6). */
export function LatinHintHL({ s, mark }: { s: TraderSignal; mark: SearchMark | undefined }) {
  const shown = personName(s.trader);
  if (!s.nameLatin || s.nameLatin === shown) return null;
  const field = shown === s.trader ? 1 : 6;
  return <span className="block truncate text-2xs text-muted-foreground"><Highlight text={s.nameLatin} ranges={mark?.field === field ? mark.ranges : null} /></span>;
}

/** The curator's display name; search field 2 holds exactly this text. */
export function CuratorNameHL({ name, mark }: { name: string; mark: SearchMark | undefined }) {
  return <Highlight text={personName(name)} ranges={mark?.field === 2 ? mark.ranges : null} />;
}
