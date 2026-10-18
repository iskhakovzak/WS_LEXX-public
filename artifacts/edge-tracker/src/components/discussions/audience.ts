/**
 * Discussions audience («Кому видна тема») — client mirror of api-server lib/discussionAudience.ts.
 *
 * A thread's `audience` is [] (everyone) or a union of tokens: trainee | junior | trader | senior (academy stage),
 * "staff" (curators/admins), "cohort:<id>". The server decides who reads what; this file only labels, counts and
 * filters what the server already returned.
 */
import { useQuery } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { discussionsI18n } from "@/i18n/ns/discussions";
import { comparePersonNames } from "@/i18n";

export type AudienceGroup = { token: string; label: string; kind: "stage" | "staff" | "cohort"; members: string[] };
export type AudienceViewerInfo = { name: string | null; stage: string | null; staff: boolean; moderator: boolean; cohorts: number[]; tokens: string[] };
export type AudienceOptions = {
  everyone: string[];
  moderators: string[];
  groups: AudienceGroup[];
  cohortLabels: Record<string, string>;
  viewer: AudienceViewerInfo;
};

export const STAGE_TOKENS = ["trainee", "junior", "trader", "senior"] as const;

export const AUDIENCE_QUERY_KEY = ["discussions-audience"] as const;

export function useAudienceOptions(enabled = true) {
  return useQuery<AudienceOptions | null>({
    queryKey: AUDIENCE_QUERY_KEY,
    queryFn: () => http.get<AudienceOptions>("/api/discussions/audience").catch(() => null),
    enabled,
    staleTime: STALE.long,
    retry: false,
  });
}

export function isRestricted(audience: readonly string[] | null | undefined): boolean {
  return !!audience && audience.length > 0;
}

export function tokenLabel(token: string, opts?: AudienceOptions | null): string {
  const m = /^cohort:(\d+)$/.exec(token);
  if (m) return opts?.cohortLabels?.[m[1]] ?? discussionsI18n.t("audience.cohort", { id: m[1] });
  return discussionsI18n.tryT(`audience.token.${token}`) ?? token;
}

export function audienceText(audience: readonly string[] | null | undefined, opts?: AudienceOptions | null): string {
  if (!isRestricted(audience)) return discussionsI18n.t("audience.everyone");
  return audience!.map((t) => tokenLabel(t, opts)).join(", ");
}

/** Canonical order (stages → curators → cohorts), like the server. */
export function sortTokens(tokens: Iterable<string>): string[] {
  const rank = (t: string) => {
    const i = (STAGE_TOKENS as readonly string[]).indexOf(t);
    if (i >= 0) return i;
    if (t === "staff") return 10;
    const m = /^cohort:(\d+)$/.exec(t);
    return m ? 100 + Number(m[1]) : 1000;
  };
  return [...new Set(tokens)].sort((a, b) => rank(a) - rank(b));
}

/**
 * Who will read a thread with this audience, besides the author: members of the chosen groups and, for a
 * restricted thread, moderators (they see every thread). `names` = members only (moderators are shown apart).
 */
export function audienceReach(audience: readonly string[], opts: AudienceOptions | null | undefined, me: string | null): { count: number; names: string[]; moderators: string[] } | null {
  if (!opts) return null;
  if (!isRestricted(audience)) {
    const names = opts.everyone.filter((n) => n !== me);
    return { count: names.length, names, moderators: [] };
  }
  const names = new Set<string>();
  for (const g of opts.groups) if (audience.includes(g.token)) g.members.forEach((n) => names.add(n));
  names.delete(me ?? "");
  const moderators = opts.moderators.filter((n) => n !== me && !names.has(n));
  return { count: names.size + moderators.length, names: [...names].sort(comparePersonNames), moderators };
}

/** Restricted thread addressed to the viewer (their stage / curators / their cohort) — the «Для меня» tab. */
export function addressedToMe(audience: readonly string[] | null | undefined, opts: AudienceOptions | null | undefined): boolean {
  if (!isRestricted(audience) || !opts) return false;
  return opts.viewer.tokens.some((t) => audience!.includes(t));
}

