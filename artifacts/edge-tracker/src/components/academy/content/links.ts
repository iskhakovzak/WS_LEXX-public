/**
 * In-app hrefs of the academy learning pages. TODO(lead): fold into `@/lib/links` as links.learn / links.lesson.
 * Targets read these params: /academy/learn ?program&tab&user ; /academy/lesson ?id | ?quiz | ?assignment (&submission&user).
 */
import type { ItemKind } from "./api";

type Params = Record<string, string | number | null | undefined | false>;
function href(path: string, params: Params = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== false && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export const academyLinks = {
  learn: (p: { program?: number; tab?: "catalog" | "review" | "progress"; user?: string } = {}) => href("/academy/learn", p),
  item: (kind: ItemKind, id: number, p: { user?: string; submission?: number } = {}) =>
    href("/academy/lesson", { [kind === "lesson" ? "id" : kind]: id, ...p }),
  admin: (p: { program?: number | string } = {}) => href("/academy/content-admin", p),
};
