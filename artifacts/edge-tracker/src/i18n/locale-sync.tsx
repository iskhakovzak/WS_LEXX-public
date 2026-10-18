/**
 * Keeps the UI language and the user profile (`users.locale`) in sync. Renders nothing; mount once inside
 * AuthProvider.
 *
 *  - The user picks a language while signed in as a member → PATCH /api/users/me/locale.
 *  - Picked before sign-in (login page), as a guest, or the save failed (offline / old API) → remembered as
 *    pending and saved on the next member session.
 *  - A member session starts with nothing pending → the profile language wins (GET /api/auth/me → locale), so a
 *    new device opens in the user's language.
 */
import { useEffect, useRef } from "react";
import { useAuth } from "@/contexts/auth-context";
import { http } from "@/lib/api/http";
import { getLang, isLang, onLangChange, setLang, LANG_PENDING_KEY, type Lang } from ".";

function setPending(on: boolean) {
  try {
    if (on) localStorage.setItem(LANG_PENDING_KEY, "1");
    else localStorage.removeItem(LANG_PENDING_KEY);
  } catch { /* storage blocked */ }
}
function isPending(): boolean {
  try { return localStorage.getItem(LANG_PENDING_KEY) === "1"; } catch { return false; }
}

async function saveProfileLang(lang: Lang): Promise<void> {
  try {
    await http.patch("/api/users/me/locale", { locale: lang });
    setPending(false);
  } catch {
    setPending(true);
  }
}

export function LocaleSync() {
  const { user } = useAuth();
  const token = user?.token ?? null;
  const member = !!token && !!user?.traderName && user.role !== "guest";
  const memberRef = useRef(member);
  memberRef.current = member;

  useEffect(
    () =>
      onLangChange((lang, source) => {
        if (source !== "user") return;
        if (memberRef.current) void saveProfileLang(lang);
        else setPending(true);
      }),
    [],
  );

  // A pending choice (picked before sign-in or while offline) is saved once a member session exists.
  useEffect(() => {
    if (member && isPending()) void saveProfileLang(getLang());
  }, [member, token]);

  // Otherwise the profile language wins. AuthProvider's session check (GET /auth/me) already carries it, so this
  // only reacts to that answer — no second request.
  const profileLocale = user?.profileLocale;
  useEffect(() => {
    if (!member || isPending()) return;
    if (isLang(profileLocale) && profileLocale !== getLang()) void setLang(profileLocale, { source: "profile" });
  }, [member, profileLocale]);

  return null;
}
