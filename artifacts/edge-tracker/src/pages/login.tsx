import { useState, useEffect, useRef } from "react";
import { useReducedMotion, motion } from "framer-motion";
import { useAuth, type LoginError } from "@/contexts/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Pill } from "@/components/ds";
import { cn } from "@/lib/utils";
import { AlertCircle, ArrowRight, Check, Eye, EyeOff, Loader2, ArrowUpFromLine, UserRound, Lock } from "lucide-react";
import { LanguageSegmented } from "@/i18n/language-switcher";
import { authI18n } from "@/i18n/ns/auth";
import { ForcedPasswordChange } from "@/components/auth/forced-password-change";

/**
 * Sign-in (owner decision 2026-10-17): no roster before sign-in — the name is TYPED (the API resolves it across
 * RU / EN / UZ spellings) and the secret is a PIN (traders) or a password (staff). Step 2 «Новый пароль» appears
 * right here when a curator/admin still has a password shorter than 10 characters.
 */

const LAST_NAME_KEY = "ws_lexx_last_trader";
const SECRET_KIND_KEY = "ws_lexx_secret_kind";
const LOCKOUT_KEY = "ws_lexx_login_lockout";

type SecretKind = "pin" | "password";
type Lockout = { name: string; until: number; kind: "locked" | "rate_limited" };

function readLS(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLS(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage blocked */ }
}
const nameKey = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

function readLockout(): Lockout | null {
  try {
    const v = JSON.parse(readLS(LOCKOUT_KEY) ?? "null") as Lockout | null;
    return v && typeof v.until === "number" && v.until > Date.now() ? v : null;
  } catch { return null; }
}

const fmtCountdown = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

/* ---------- US market session clock (New York) ---------- */

type SessionKey = "weekend" | "premarket" | "regular" | "postmarket" | "closed";
const SESSION_TONE: Record<SessionKey, "up" | "warn" | "purple" | "neutral"> = {
  weekend: "neutral", premarket: "warn", regular: "up", postmarket: "purple", closed: "neutral",
};

function nyParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const h = Number(get("hour")) % 24;
  return { weekday: get("weekday"), h, m: Number(get("minute")), s: Number(get("second")) };
}

function sessionOf(weekday: string, h: number, m: number): SessionKey {
  if (weekday === "Sat" || weekday === "Sun") return "weekend";
  const t = h * 60 + m;
  if (t >= 4 * 60 && t < 9 * 60 + 30) return "premarket";
  if (t >= 9 * 60 + 30 && t < 16 * 60) return "regular";
  if (t >= 16 * 60 && t < 20 * 60) return "postmarket";
  return "closed";
}

function MarketClock() {
  const { t } = authI18n.useT();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(i);
  }, []);
  const { weekday, h, m, s } = nyParts(now);
  const session = sessionOf(weekday, h, m);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <div className="glass-field inline-flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground tabular-nums">
      <span className="font-medium text-foreground">NY {pad(h)}:{pad(m)}:{pad(s)}</span>
      <span aria-hidden="true">·</span>
      <Pill tone={SESSION_TONE[session]} dot className="px-1.5 py-0 text-2xs">{t(`clock.${session}`)}</Pill>
    </div>
  );
}

/** «Вход → Новый пароль»: shown while the second step is active, so it reads as one process. */
function SignInSteps({ step }: { step: 1 | 2 }) {
  const { t } = authI18n.useT();
  const { user } = useAuth();
  const pin = user?.role !== "curator" && user?.role !== "admin";
  const items = [t("steps.signIn"), t(pin ? "steps.newPin" : "steps.newPassword")];
  return (
    <ol aria-label={t("steps.aria")} className="mt-5 flex items-center justify-center gap-2 text-xs">
      {items.map((label, i) => {
        const n = (i + 1) as 1 | 2;
        const done = n < step;
        const active = n === step;
        return (
          <li key={label} className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
            {i > 0 && <span aria-hidden="true" className={cn("h-px w-6", done || active ? "bg-primary/60" : "bg-border")} />}
            <span
              className={cn(
                "grid h-5 w-5 place-items-center rounded-full text-2xs font-semibold",
                done ? "bg-up/15 text-up" : active ? "bg-primary-solid text-primary-foreground" : "bg-muted text-muted-foreground",
              )}
              aria-hidden="true"
            >
              {done ? <Check className="h-3 w-3" /> : n}
            </span>
            <span className={cn(active ? "font-medium text-foreground" : "text-muted-foreground")}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/* ---------- page ---------- */

export default function LoginPage() {
  const { t } = authI18n.useT();
  const { loginAsTrader, loginAsGuest, passwordChangePending } = useAuth();
  const reduceMotion = useReducedMotion();

  const [name, setName] = useState<string>(() => readLS(LAST_NAME_KEY) ?? "");
  const [password, setPassword] = useState("");
  const [kind, setKind] = useState<SecretKind>(() => (readLS(SECRET_KIND_KEY) === "password" ? "password" : "pin"));
  const [error, setError] = useState<LoginError | null>(null);
  const [shake, setShake] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [lockout, setLockout] = useState<Lockout | null>(readLockout);
  const [now, setNow] = useState(() => Date.now());
  const nameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  // The secret typed in step 1, kept in memory only, so step 2 doesn't ask for the current password again.
  const typedSecret = useRef<string | null>(null);

  // A lock is per account: it applies only while the same name is typed.
  const locked = !!lockout && lockout.until > now && nameKey(lockout.name) === nameKey(name);
  useEffect(() => {
    if (!lockout) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [lockout]);
  useEffect(() => {
    if (lockout && lockout.until <= now) {
      writeLS(LOCKOUT_KEY, null);
      setLockout(null);
      if (error === "locked" || error === "rate_limited") setError(null);
    }
  }, [lockout, now, error]);

  // Focus lands on the first empty field: the secret when the name is remembered, else the name.
  useEffect(() => {
    if (passwordChangePending) return;
    (name.trim() ? passwordRef : nameRef).current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remainingText = fmtCountdown(Math.max(0, (lockout?.until ?? 0) - now));

  function trackCaps(e: React.KeyboardEvent<HTMLInputElement>) {
    if (typeof e.getModifierState === "function") setCapsLock(e.getModifierState("CapsLock"));
  }

  function switchKind() {
    const next: SecretKind = kind === "pin" ? "password" : "pin";
    setKind(next);
    writeLS(SECRET_KIND_KEY, next);
    requestAnimationFrame(() => passwordRef.current?.focus());
  }

  async function handleLogin(e?: React.FormEvent) {
    e?.preventDefault();
    const typedName = name.trim();
    if (!typedName) { nameRef.current?.focus(); return; }
    if (!password) { passwordRef.current?.focus(); return; }
    if (submitting || locked) return;
    setSubmitting(true);
    const failure = await loginAsTrader(typedName, password);
    setSubmitting(false);
    if (!failure) {
      typedSecret.current = password;
      writeLS(LAST_NAME_KEY, typedName);
      writeLS(LOCKOUT_KEY, null);
      // Remember the keyboard: a password (letters) vs a PIN (digits only).
      writeLS(SECRET_KIND_KEY, /^\d+$/.test(password) ? "pin" : "password");
      return;
    }
    setError(failure.error);
    if (failure.error === "locked" || failure.error === "rate_limited") {
      const lock: Lockout = { name: typedName, until: Date.now() + (failure.retryAfterSec ?? 900) * 1000, kind: failure.error };
      writeLS(LOCKOUT_KEY, JSON.stringify(lock));
      setLockout(lock);
      setNow(Date.now());
    }
    if (failure.error === "invalid") setPassword("");
    if (!reduceMotion) {
      setShake(true);
      setTimeout(() => setShake(false), 450);
    }
    passwordRef.current?.focus();
  }

  const [guestBusy, setGuestBusy] = useState(false);
  const [guestError, setGuestError] = useState<LoginError | null>(null);
  async function handleGuest() {
    if (guestBusy || submitting) return;
    setGuestBusy(true);
    setGuestError(null);
    const err = await loginAsGuest();
    setGuestBusy(false);
    if (err) setGuestError(err === "invalid" ? "network" : err);
  }

  const errorText = (err: LoginError): string => {
    switch (err) {
      case "invalid": return t("errors.invalid");
      case "locked": return t("errors.locked", { time: remainingText });
      case "rate_limited": return t("errors.rateLimited", { time: remainingText });
      case "banned": return t("errors.banned");
      case "guest_disabled": return t("errors.guestDisabled");
      default: return t("errors.network");
    }
  };
  // While locked the message stays visible even if the error state was cleared by typing.
  const shownError: LoginError | null = locked ? lockout!.kind : error;
  const isPin = kind === "pin";
  const canSubmit = !!name.trim() && password.length > 0 && !submitting && !locked;

  return (
    <div className="relative flex min-h-[100dvh] w-full items-center justify-center overflow-hidden bg-background px-4 py-10">
      {/* Ambient colour behind the glass */}
      <div aria-hidden="true" className="pointer-events-none fixed inset-0">
        <div className="absolute left-1/2 top-[-18%] h-[520px] w-[820px] max-w-[160vw] -translate-x-1/2 rounded-full bg-primary/15 blur-[120px]" />
        <div className="absolute bottom-[-20%] right-[-10%] h-[480px] w-[560px] max-w-[120vw] rounded-full bg-chart-2/10 blur-[110px]" />
        <div className="absolute bottom-[10%] left-[-12%] h-[360px] w-[420px] max-w-[100vw] rounded-full bg-chart-5/10 blur-[100px]" />
      </div>

      {/* Language before sign-in (saved locally, then to the profile after login: i18n/locale-sync.tsx). */}
      <div className="absolute right-4 top-[calc(1rem+env(safe-area-inset-top))] z-raised">
        <LanguageSegmented />
      </div>

      <motion.main
        initial={reduceMotion ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
        className="relative z-raised flex w-full max-w-[400px] flex-col items-center gap-5"
      >
        <div className={cn("glass-thick w-full rounded-3xl p-6 sm:p-7", shake && "animate-[shake_0.4s_ease-in-out]")}>
          {/* Brand */}
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-[14px] bg-primary-solid text-base font-bold tracking-tight text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_10px_30px_-10px_hsl(var(--primary)/0.7)]">
              WS
            </span>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">WS_LEXX</h1>
              <p className="mt-1 text-sm text-muted-foreground">{t("tagline")}</p>
            </div>
          </div>

          {passwordChangePending ? (
            <>
              <SignInSteps step={2} />
              <ForcedPasswordChange knownCurrent={typedSecret.current} />
            </>
          ) : (
            <form className="mt-6 flex flex-col gap-4" onSubmit={handleLogin} noValidate>
              {/* Name — typed, never picked from a list (no roster before sign-in). */}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="login-name" className="text-xs text-muted-foreground">{t("name.label")}</label>
                <Input
                  ref={nameRef}
                  id="login-name"
                  name="username"
                  autoComplete="username"
                  autoCapitalize="words"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="next"
                  maxLength={100}
                  value={name}
                  onChange={(e) => { setName(e.target.value); if (error && error !== "locked" && error !== "rate_limited") setError(null); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && name.trim() && !password) { e.preventDefault(); passwordRef.current?.focus(); }
                  }}
                  placeholder={t("name.placeholder")}
                  className="h-11 text-base sm:text-sm"
                />
              </div>

              {/* Secret: PIN (digits keyboard) or password */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <label htmlFor="login-password" className="text-xs text-muted-foreground">
                    {isPin ? t("secret.pin") : t("secret.password")}
                  </label>
                  <button
                    type="button"
                    onClick={switchKind}
                    className="rounded text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {isPin ? t("secret.usePassword") : t("secret.usePin")}
                  </button>
                </div>
                <div className="relative">
                  <Input
                    ref={passwordRef}
                    id="login-password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    inputMode={isPin ? "numeric" : "text"}
                    autoComplete="current-password"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="go"
                    maxLength={200}
                    value={password}
                    disabled={locked}
                    onChange={(e) => { setPassword(e.target.value); if (error && error !== "locked" && error !== "rate_limited") setError(null); }}
                    onKeyDown={trackCaps}
                    onKeyUp={trackCaps}
                    onBlur={() => setCapsLock(false)}
                    placeholder={isPin ? t("secret.pinPlaceholder") : t("secret.passwordPlaceholder")}
                    aria-invalid={shownError === "invalid" || undefined}
                    aria-describedby={[shownError ? "login-error" : "", capsLock ? "login-caps" : ""].filter(Boolean).join(" ") || undefined}
                    className={cn(
                      "h-11 pr-12 text-base tracking-wide sm:text-sm",
                      shownError === "invalid" && "border-down/60 ring-2 ring-down/20",
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? t("secret.hide") : t("secret.show")}
                    aria-pressed={showPassword}
                    className="absolute right-1 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                  </button>
                </div>
                {capsLock && (
                  <p id="login-caps" className="flex items-center gap-1.5 text-xs text-[hsl(var(--chart-3))]" role="status">
                    <ArrowUpFromLine className="h-3.5 w-3.5" aria-hidden="true" />
                    {t("secret.capsLock")}
                  </p>
                )}
                {/* Errors and locks sit right under the field they concern (semantic colour + icon, not a banner). */}
                {shownError && (
                  <p id="login-error" role="alert" className="flex items-start gap-1.5 text-xs text-down">
                    {locked ? <Lock className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                    <span className={cn(locked && "tabular-nums")}>{errorText(shownError)}</span>
                  </p>
                )}
              </div>

              <Button type="submit" size="lg" disabled={!canSubmit} aria-busy={submitting} className="h-11 w-full text-sm">
                {submitting ? (
                  <>
                    <Loader2 className="animate-spin" aria-hidden="true" />
                    {t("submitting")}
                  </>
                ) : locked ? (
                  <span className="tabular-nums">{t("lockedButton", { time: remainingText })}</span>
                ) : (
                  <>
                    {t("submit")}
                    <ArrowRight aria-hidden="true" />
                  </>
                )}
              </Button>
              <p className="-mt-1 hidden items-center justify-center gap-1.5 text-xs text-muted-foreground sm:flex">
                <Kbd>Enter</Kbd> {t("enterHint")}
              </p>
            </form>
          )}
        </div>

        {!passwordChangePending && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleGuest}
            disabled={guestBusy}
            aria-busy={guestBusy}
            className="text-muted-foreground"
          >
            {guestBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <UserRound aria-hidden="true" />}
            {t("guest")}
          </Button>
        )}
        {guestError && !passwordChangePending && (
          <p role="alert" className="-mt-3 flex items-start gap-1.5 text-xs text-down">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {errorText(guestError)}
          </p>
        )}

        <MarketClock />
      </motion.main>
    </div>
  );
}
