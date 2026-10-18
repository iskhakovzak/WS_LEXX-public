import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Loader2, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/auth-context";
import { authI18n } from "@/i18n/ns/auth";
import { cn } from "@/lib/utils";
import { secretMinFor } from "@/lib/secret-policy";

/**
 * Sign-in, step 2: the account still has an issued secret (first sign-in, admin reset — every account sets its own,
 * owner decision 2026-10-18), or a curator/admin's password is shorter than the staff minimum. A new one is set before
 * the app opens (the API refuses everything else for this session). Traders see «PIN», staff «password». `knownCurrent` is the secret typed in step 1 (kept in
 * memory only) — when present the «current password» field is not asked again.
 */
export function ForcedPasswordChange({ knownCurrent }: { knownCurrent: string | null }) {
  const { t } = authI18n.useT();
  const { user, changePassword, logout } = useAuth();
  const min = Math.max(user?.secretMin ?? 0, secretMinFor(user?.role));
  const pin = user?.role !== "curator" && user?.role !== "admin";
  const own = user?.mustChangeReason === "first";
  // Same field, two names: traders sign in with a PIN, staff with a password.
  const k = (base: "current" | "next" | "repeat" | "mismatch" | "same" | "failed") => (pin ? (`forced.${base}Pin` as const) : (`forced.${base}` as const));
  const [current, setCurrent] = useState(knownCurrent ?? "");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => { firstRef.current?.focus(); }, []);

  const askCurrent = !knownCurrent;
  const tooShort = next.length > 0 && next.length < min;
  const mismatch = repeat.length > 0 && repeat !== next;
  const same = next.length > 0 && next === current;
  const valid = current.length > 0 && next.length >= min && next === repeat && !same;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    const err = await changePassword(current, next);
    setSaving(false);
    if (err) setError(err === "network" ? t("errors.network") : err || t(k("failed")));
  }

  return (
    <form className="mt-5 flex flex-col gap-4" onSubmit={submit} noValidate autoComplete="on">
      <div className="flex flex-col gap-1 text-center">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          {own ? t(pin ? "forced.titleOwnPin" : "forced.titleOwnPassword") : t("forced.title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {own ? t(pin ? "forced.descriptionOwnPin" : "forced.descriptionOwnPassword", { min }) : t("forced.description", { min })}
        </p>
        {user?.traderName && <p className="text-xs text-muted-foreground">{t("forced.signedInAs", { name: user.traderName })}</p>}
      </div>
      {/* Lets password managers attach the new password to the right account. */}
      <input type="text" name="username" autoComplete="username" value={user?.traderName ?? ""} readOnly hidden />

      {askCurrent && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="pwc-current" className="text-xs text-muted-foreground">{t(k("current"))}</label>
          <Input ref={firstRef} id="pwc-current" type="password" autoComplete="current-password" maxLength={200}
            value={current} onChange={(e) => { setCurrent(e.target.value); setError(null); }} className="h-11" />
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor="pwc-new" className="text-xs text-muted-foreground">{t(k("next"))}</label>
          <span className={cn("text-2xs tabular-nums", next.length >= min ? "text-up" : "text-muted-foreground")} aria-hidden="true">
            {t("forced.counter", { count: Math.min(next.length, 999), min })}
          </span>
        </div>
        <Input ref={askCurrent ? undefined : firstRef} id="pwc-new" type="password" autoComplete="new-password" maxLength={200}
          value={next} onChange={(e) => { setNext(e.target.value); setError(null); }}
          aria-invalid={tooShort || same || undefined} aria-describedby={tooShort || same ? "pwc-new-err" : undefined}
          className="h-11" />
        {(tooShort || same) && (
          <p id="pwc-new-err" className="flex items-center gap-1.5 text-xs text-down">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {same ? t(k("same")) : t("forced.tooShort", { min })}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="pwc-repeat" className="text-xs text-muted-foreground">{t(k("repeat"))}</label>
        <div className="relative">
          <Input id="pwc-repeat" type="password" autoComplete="new-password" maxLength={200}
            value={repeat} onChange={(e) => { setRepeat(e.target.value); setError(null); }}
            aria-invalid={mismatch || undefined} aria-describedby={mismatch ? "pwc-repeat-err" : error ? "pwc-error" : undefined}
            className="h-11 pr-10" />
          {repeat.length > 0 && !mismatch && next.length >= min && (
            <Check className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-up" aria-hidden="true" />
          )}
        </div>
        {mismatch && (
          <p id="pwc-repeat-err" className="flex items-center gap-1.5 text-xs text-down">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t(k("mismatch"))}
          </p>
        )}
        {error && (
          <p id="pwc-error" role="alert" className="flex items-start gap-1.5 text-xs text-down">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {error}
          </p>
        )}
      </div>

      <Button type="submit" size="lg" disabled={!valid || saving} aria-busy={saving} className="h-11 w-full text-sm">
        {saving ? <><Loader2 className="animate-spin" aria-hidden="true" />{t("forced.saving")}</> : t("forced.submit")}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={logout} disabled={saving} className="self-center text-muted-foreground">
        <LogOut aria-hidden="true" />
        {t("forced.cancel")}
      </Button>
    </form>
  );
}
