import { getLang } from "@/i18n/state";

const TOKEN_KEY = "ws_lexx_token";
const ORIG_FETCH = globalThis.fetch.bind(globalThis);

/** Fired on window when an authenticated API call comes back 401 (token expired / revoked). */
export const AUTH_EXPIRED_EVENT = "ws-auth-expired";

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
}

function isApiCall(input: RequestInfo | URL): boolean {
  try {
    const url = requestUrl(input);
    if (!url) return false;
    if (url.startsWith("/api/")) return true;
    const u = new URL(url, window.location.origin);
    if (u.origin !== window.location.origin) return false;
    return u.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function isAuthEndpoint(input: RequestInfo | URL): boolean {
  try {
    const u = new URL(requestUrl(input), window.location.origin);
    return /\/api\/auth\/(login|logout|me|guest)$/.test(u.pathname);
  } catch {
    return false;
  }
}

function readToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

/**
 * Every same-origin /api/* fetch carries the stored bearer token (members and guests alike) and `X-Lang` with the
 * current UI language (server texts — errors, labels, insights — come back in that language).
 * A 401 on a request that carried a token means the session is gone: the auth context then
 * re-checks /api/auth/me once and logs out with a toast. Anonymous 401s (no token at all,
 * e.g. the login screen) are expected and never trigger that.
 */
export function installFetchAuth(): void {
  globalThis.fetch = async (input, init) => {
    if (!isApiCall(input)) return ORIG_FETCH(input, init);
    const headers = input instanceof Request ? new Headers(input.headers) : new Headers();
    if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    const token = readToken();
    if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("X-Lang")) headers.set("X-Lang", getLang());
    const sentAuth = headers.has("Authorization");
    const res = await ORIG_FETCH(input, { ...init, headers });
    if (res.status === 401 && sentAuth && !isAuthEndpoint(input)) {
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
    }
    return res;
  };
}
