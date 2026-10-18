export const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

export function apiUrl(path: string): string {
  return `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
}
