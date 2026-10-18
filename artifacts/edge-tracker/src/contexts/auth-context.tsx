import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import { clearLatinNames, setLatinNames } from "@/lib/people/latin-names";
import { BASE } from "@/lib/api";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { AUTH_EXPIRED_EVENT } from "@/lib/install-fetch-auth";
import { toast } from "@/hooks/use-toast";
import { shellI18n } from "@/i18n/ns/shell";
import { canWith, defaultPermissions, type Capability, type PermissionsMe, type Target } from "@/lib/permissions";

export type UserRole = "trader" | "curator" | "admin" | "guest";

export interface UserSession {
  role: UserRole;
  traderName: string | null;
  token?: string | null;
  /**
   * The account still has an issued secret, or is staff with a password shorter than the staff minimum: the API
   * accepts only the secret change until a new one is set (token claim `pwc`). The app stays on the login screen, step «Новый пароль».
   */
  mustChangePassword?: boolean;
  /** Why: «first» = an issued secret (first sign-in, admin reset) the owner replaces; «policy» = staff minimum. */
  mustChangeReason?: "first" | "policy";
  /** Minimum length of a new secret for this role (from the API: 6 for traders, 10 for staff). */
  secretMin?: number;
  /** UI language saved in the profile (`users.locale`), as last reported by GET /auth/me. Not persisted. */
  profileLocale?: string;
}

// Shape of GET /api/users — signed-in only (no roster before sign-in); no password/hash ever reaches the client;
// moderation fields bannedAt/bannedReason only for staff.
export type DbUser = {
  id: number;
  name: string;
  role: string;
  active: boolean;
  theme: string;
  banned?: boolean;
  bannedAt?: string | null;
  bannedReason?: string | null;
  createdAt: string;
  /** Optional Latin alias (users.name_latin) for cross-script search; absent on older API builds. */
  nameLatin?: string | null;
};

interface AuthContextType {
  user: UserSession | null;
  /** Resolves to null on success, otherwise the reason the login failed (+ seconds until a lock ends). */
  loginAsTrader: (name: string, password: string) => Promise<LoginFailure | null>;
  /** Change own secret (also the forced staff change). Resolves to null on success, else the server's message. */
  changePassword: (current: string, next: string) => Promise<string | null>;
  /** True while a signed-in staff member still has to set a new password (login screen, step 2). */
  passwordChangePending: boolean;
  /** Asks the API for a read-only guest token (12h). Resolves to null on success. */
  loginAsGuest: () => Promise<LoginError | null>;
  logout: () => void;
  isAuthenticated: boolean;
  canEdit: boolean;
  isCurator: boolean;
  isAdmin: boolean;
  isBanned: boolean;
  dbUsers: DbUser[];
  refreshUsers: () => void;
  /**
   * Effective capabilities from GET /api/permissions/me (desk overrides applied). While the request is in
   * flight — or when it fails — this is the role's default set, so gates render immediately.
   */
  permissions: PermissionsMe;
  /** True once /api/permissions/me answered for the current session. */
  permissionsLoaded: boolean;
  /** UI gate: may I exercise `cap` (optionally on `target.trader`'s data)? The API re-checks every request. */
  can: (cap: Capability, target?: Target | null) => boolean;
  refreshPermissions: () => void;
}

export type LoginError = "invalid" | "locked" | "rate_limited" | "network" | "banned" | "guest_disabled";
export type LoginFailure = { error: LoginError; retryAfterSec?: number };

const AuthContext = createContext<AuthContextType | null>(null);

const STORAGE_KEY = "ws_lexx_session";
const TOKEN_KEY = "ws_lexx_token";
/** How often an open tab re-checks the session (GET /auth/me also slides the 7-day token forward). */
const SESSION_CHECK_MS = 6 * 3600_000;

function writeToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage blocked */ }
}

let _currentToken: string | null = null;
setAuthTokenGetter(() => _currentToken);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserSession | null>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      const tok = localStorage.getItem(TOKEN_KEY);
      if (tok) _currentToken = tok;
      if (saved) {
        const parsed = JSON.parse(saved) as UserSession;
        if (tok) parsed.token = tok;
        return parsed;
      }
    } catch {}
    return null;
  });

  const [dbUsers, setDbUsers] = useState<DbUser[]>([]);
  const sessionToken = user?.token ?? null;
  const pendingChange = !!user?.mustChangePassword;

  // The team list is signed-in only (no roster before sign-in, owner decision 2026-10-17).
  const fetchUsers = useCallback(() => {
    if (!_currentToken) return;
    fetch(`${BASE}/api/users`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: DbUser[] | null) => {
        if (Array.isArray(data)) setDbUsers(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (sessionToken && !pendingChange) fetchUsers();
    else if (!sessionToken) setDbUsers([]);
  }, [sessionToken, pendingChange, fetchUsers]);

  // Latin display names for EN/UZ (i18n/person-name.ts). Kept across reloads; dropped on sign-out.
  useEffect(() => {
    if (!sessionToken) { clearLatinNames(); return; }
    if (dbUsers.length) setLatinNames(dbUsers.map((u) => [u.name, u.nameLatin] as const));
  }, [sessionToken, dbUsers]);

  // Effective permissions for the signed-in session (role defaults until the API answers).
  const [permState, setPermState] = useState<{ token: string | null; me: PermissionsMe | null }>({ token: null, me: null });
  const [permVersion, setPermVersion] = useState(0);
  const refreshPermissions = useCallback(() => setPermVersion((v) => v + 1), []);
  useEffect(() => {
    if (!sessionToken || pendingChange) { setPermState({ token: null, me: null }); return; }
    let cancelled = false;
    fetch(`${BASE}/api/permissions/me`, { headers: { Authorization: `Bearer ${sessionToken}` } })
      .then((r) => (r.ok ? (r.json() as Promise<PermissionsMe>) : null))
      .then((me) => {
        if (cancelled) return;
        if (me && Array.isArray(me.capabilities)) setPermState({ token: sessionToken, me });
        else setPermState({ token: sessionToken, me: null });
      })
      .catch(() => { if (!cancelled) setPermState({ token: sessionToken, me: null }); });
    return () => { cancelled = true; };
  }, [sessionToken, pendingChange, permVersion]);

  // A fresh sign-in (no token → token) runs the session check once, so the profile fields it carries (language,
  // password policy) arrive without a second /auth/me elsewhere.
  const verifyRef = useRef<(() => Promise<void>) | null>(null);
  const hadTokenRef = useRef(!!sessionToken);
  useEffect(() => {
    const had = hadTokenRef.current;
    hadTokenRef.current = !!sessionToken;
    if (sessionToken && !had) void verifyRef.current?.();
  }, [sessionToken]);

  // A stored token can expire or be revoked (logout elsewhere, password change, guest token >12h).
  // Every /api/* call requires a token, so a dead token means every request 401s. Validate it on start, whenever
  // any API call reports a 401, every SESSION_CHECK_MS while the tab is open and when the tab becomes visible
  // again. One check at a time; a session that was already dropped is never dropped twice.
  // Sliding session: /auth/me answers with a fresh `token` once the current one is older than 24 h (7-day TTL).
  useEffect(() => {
    let checking = false;
    let lastCheck = 0;
    const verify = async () => {
      if (checking || !_currentToken) return;
      checking = true;
      lastCheck = Date.now();
      const tok = _currentToken;
      try {
        const r = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${tok}` } });
        if (r.status === 401 && _currentToken === tok) {
          _currentToken = null;
          writeToken(null);
          setUser(null);
          toast({ title: shellI18n.t("app.sessionExpired"), description: shellI18n.t("app.sessionExpiredDesc") });
          return;
        }
        if (!r.ok || _currentToken !== tok) return;
        const me = (await r.json().catch(() => null)) as
          | { token?: string; mustChangePassword?: boolean; mustChangeReason?: "first" | "policy"; secretPolicy?: { min?: number }; locale?: unknown }
          | null;
        if (!me) return;
        const fresh = typeof me.token === "string" && me.token ? me.token : null;
        if (fresh) { _currentToken = fresh; writeToken(fresh); }
        setUser((u) => {
          if (!u) return u;
          const must = !!me.mustChangePassword;
          const min = me.secretPolicy?.min ?? u.secretMin;
          // LocaleSync reads the profile language from here instead of requesting /auth/me a second time.
          const locale = typeof me.locale === "string" ? me.locale : u.profileLocale;
          const reason = must ? me.mustChangeReason ?? u.mustChangeReason : undefined;
          if (!fresh && must === !!u.mustChangePassword && reason === u.mustChangeReason && min === u.secretMin && locale === u.profileLocale) return u;
          return { ...u, token: fresh ?? u.token, mustChangePassword: must, mustChangeReason: reason, secretMin: min, profileLocale: locale };
        });
      } catch {
        // network error — keep the session, the user may just be offline
      } finally {
        checking = false;
      }
    };
    verifyRef.current = verify;
    void verify();
    const timer = window.setInterval(() => void verify(), SESSION_CHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastCheck > 3600_000) void verify();
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, verify);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(AUTH_EXPIRED_EVENT, verify);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // A session restored from localStorage without a token (old guest mode stored token: null)
  // can't talk to the API any more — send it back to the login screen.
  useEffect(() => {
    if (user && !user.token && !_currentToken) setUser(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      if (user) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          role: user.role,
          traderName: user.traderName,
          ...(user.mustChangePassword ? { mustChangePassword: true, mustChangeReason: user.mustChangeReason, secretMin: user.secretMin } : {}),
        }));
        if (user.token) {
          writeToken(user.token);
          _currentToken = user.token;
        }
      } else {
        localStorage.removeItem(STORAGE_KEY);
        writeToken(null);
        _currentToken = null;
      }
    } catch { /* storage blocked */ }
  }, [user]);

  const loginAsTrader = useCallback(async (name: string, password: string): Promise<LoginFailure | null> => {
    try {
      const r = await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password }),
      });
      if (r.status === 429) {
        const body = (await r.json().catch(() => null)) as { code?: string; retryAfterSec?: number } | null;
        const header = Number(r.headers.get("Retry-After"));
        const retryAfterSec = body?.retryAfterSec ?? (Number.isFinite(header) && header > 0 ? header : 15 * 60);
        return { error: body?.code === "LOGIN_LOCKED" ? "locked" : "rate_limited", retryAfterSec };
      }
      if (r.status === 403) return { error: "banned" };
      if (!r.ok) return { error: r.status >= 500 ? "network" : "invalid" };
      const data = await r.json() as {
        token: string;
        user: { id: number; name: string; role: string };
        mustChangePassword?: boolean;
        mustChangeReason?: "first" | "policy";
        secretPolicy?: { min?: number };
      };
      _currentToken = data.token;
      // Persist synchronously so raw fetch() calls fired by the first authenticated render carry the token.
      writeToken(data.token);
      setUser({
        role: (data.user.role as UserRole) ?? "trader",
        traderName: data.user.name,
        token: data.token,
        mustChangePassword: !!data.mustChangePassword,
        mustChangeReason: data.mustChangePassword ? data.mustChangeReason : undefined,
        secretMin: data.secretPolicy?.min,
      });
      return null;
    } catch {
      return { error: "network" };
    }
  }, []);

  // Own secret change. The API revokes every other session and returns a fresh token for this one, so the forced
  // staff change goes straight on into the app.
  const changePassword = useCallback(async (current: string, next: string): Promise<string | null> => {
    try {
      const r = await fetch(`${BASE}/api/users/me/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const body = (await r.json().catch(() => null)) as { token?: string; error?: string } | null;
      const token = body?.token;
      if (!r.ok || !token) return body?.error ?? `HTTP ${r.status}`;
      _currentToken = token;
      writeToken(token);
      setUser((u) => (u ? { ...u, token, mustChangePassword: false, mustChangeReason: undefined } : u));
      return null;
    } catch {
      return "network";
    }
  }, []);

  // Guest = a real (read-only, 12h) token from POST /api/auth/guest, stored exactly like a
  // member token, so every request is authenticated and the server can enforce "view only".
  const loginAsGuest = useCallback(async (): Promise<LoginError | null> => {
    try {
      const r = await fetch(`${BASE}/api/auth/guest`, { method: "POST", headers: { "Content-Type": "application/json" } });
      if (r.status === 429) return "rate_limited";
      if (r.status === 403) {
        // GUEST_MODE off on this server (code GUEST_DISABLED).
        const body = await r.json().catch(() => null) as { code?: string } | null;
        return body?.code === "GUEST_DISABLED" ? "guest_disabled" : "invalid";
      }
      if (!r.ok) return "invalid";
      const data = await r.json() as { token: string };
      if (!data?.token) return "invalid";
      _currentToken = data.token;
      writeToken(data.token);
      setUser({ role: "guest", traderName: null, token: data.token });
      return null;
    } catch {
      return "network";
    }
  }, []);

  const logout = useCallback(() => {
    const tok = _currentToken;
    if (tok) {
      fetch(`${BASE}/api/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
      }).catch(() => {});
    }
    _currentToken = null;
    writeToken(null);
    setUser(null);
  }, []);

  const bannedNames = dbUsers.filter((u) => u.banned).map((u) => u.name);
  const me = (user?.role !== "guest" && user?.traderName) ? user.traderName : null;

  const permissionsLoaded = !!user && permState.token === sessionToken && permState.me !== null;
  const permissions: PermissionsMe = permissionsLoaded && permState.me ? permState.me : defaultPermissions(user?.role, me);
  const can = useCallback(
    (cap: Capability, target?: Target | null) => canWith(permissions, cap, target),
    [permissions],
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        loginAsTrader,
        changePassword,
        passwordChangePending: pendingChange,
        loginAsGuest,
        logout,
        isAuthenticated: user !== null && !pendingChange,
        canEdit: (user?.role === "trader" || user?.role === "admin" || user?.role === "curator") && !!me && !bannedNames.includes(me),
        isCurator: user?.role === "curator" || user?.role === "admin",
        isAdmin: user?.role === "admin",
        isBanned: !!me && bannedNames.includes(me),
        dbUsers,
        refreshUsers: fetchUsers,
        permissions,
        permissionsLoaded,
        can,
        refreshPermissions,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}

export function WriteOnly({ children }: { children: React.ReactNode }) {
  const { canEdit } = useAuth();
  if (!canEdit) return null;
  return <>{children}</>;
}
