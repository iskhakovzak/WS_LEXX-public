/**
 * People search on the client — the same cross-script matcher as the API (@workspace/text-search):
 * a name typed in Russian, English or Uzbek Latin finds the person («Zakir» / «zokir» → «Закир»,
 * «Rakhmatullo» → «Рахматулло», «Pfrbh» typed on the EN layout → «Закир»), with typos tolerated.
 *
 *   usePeopleAliases()             name → Latin alias (users.name_latin) from the shared /api/users list
 *   matchPerson(q, name, aliases)  boolean filter for tables / pickers
 *   rankPeople(list, q, …)         ranked hits with highlight ranges
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { matchText, prepareQuery, searchItems, type PreparedQuery, type SearchField, type SearchHit } from "@workspace/text-search";
import { useAuth } from "@/contexts/auth-context";
import { http } from "@/lib/api/http";
import { isNotFound } from "@/lib/api/errors";
import { STALE } from "@/lib/api/keys";

export { highlightSegments, matchText, matchesAny, prepareQuery, searchItems } from "@workspace/text-search";
export type { MatchResult, PreparedQuery, SearchHit } from "@workspace/text-search";

export type Aliases = ReadonlyMap<string, string>;
const EMPTY: Aliases = new Map();

/** name → Latin alias, from the user list the app already loads (no extra request). */
export function usePeopleAliases(): Aliases {
  const { dbUsers } = useAuth();
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const u of dbUsers) if (u.nameLatin) m.set(u.name, u.nameLatin);
    return m.size ? m : EMPTY;
  }, [dbUsers]);
}

/** Does `name` (or its Latin alias, or any extra text) match the query? Empty query → true. */
export function matchPerson(query: PreparedQuery | string, name: string | null | undefined, aliases: Aliases = EMPTY, ...extra: (string | null | undefined)[]): boolean {
  const q = typeof query === "string" ? prepareQuery(query) : query;
  if (q.empty) return true;
  if (matchText(q, name)) return true;
  if (name && aliases.has(name) && matchText(q, aliases.get(name))) return true;
  return extra.some((t) => !!matchText(q, t));
}

/** Rank names (or objects) by the person's name, Latin alias and optional secondary texts (weight 0.5). */
export function rankPeople<T>(
  items: readonly T[],
  query: PreparedQuery | string,
  nameOf: (item: T) => string,
  aliases: Aliases = EMPTY,
  secondary?: (item: T) => (string | null | undefined)[],
  limit?: number,
): SearchHit<T>[] {
  return searchItems(items, query, (it) => {
    const name = nameOf(it);
    const f: SearchField[] = [name, aliases.get(name) ?? null];
    for (const s of secondary?.(it) ?? []) f.push({ text: s, weight: 0.5 });
    return f;
  }, { limit });
}

export type DirectoryPerson = { id: number; name: string; nameLatin: string | null; role: string; curator: string | null; active: boolean; banned: boolean };

/**
 * People the caller may see (GET /api/users/directory — staff: everyone, a trader: themselves, wards, staff).
 * Falls back to the public /api/users list on an API build without the endpoint.
 */
export function usePeopleDirectory(enabled = true) {
  const { dbUsers, user } = useAuth();
  const q = useQuery({
    queryKey: ["people-directory", user?.traderName ?? ""],
    queryFn: async ({ signal }): Promise<DirectoryPerson[] | null> => {
      const body = await http.get<{ people?: DirectoryPerson[] } | null>("/api/users/directory", { signal }).catch((e: unknown) => {
        if (isNotFound(e)) return null;
        throw e;
      });
      return Array.isArray(body?.people) ? body.people : null;
    },
    enabled: enabled && !!user && user.role !== "guest",
    staleTime: STALE.long,
    retry: false,
  });
  const fallback = useMemo<DirectoryPerson[]>(
    () => dbUsers.filter((u) => u.active).map((u) => ({ id: u.id, name: u.name, nameLatin: u.nameLatin ?? null, role: u.role, curator: null, active: u.active, banned: !!u.banned })),
    [dbUsers],
  );
  return { people: q.data ?? fallback, isLoading: q.isLoading, fromServer: !!q.data };
}
