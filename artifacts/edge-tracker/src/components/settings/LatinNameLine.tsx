/**
 * Settings → Profile: the user's own Latin name (users.name_latin), shown instead of the Cyrillic name in the English
 * and Uzbek interface. People know their own spelling, so they set it themselves (PATCH /api/users/me/name-latin).
 * Without one, the suggestion from the name is one click away (UX law «prefill»); «Change» edits it inline
 * (Enter saves, Esc cancels). After saving, the user list is reloaded so every name on screen follows.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Languages, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { http } from "@/lib/api/http";
import { cn } from "@/lib/utils";
import { NAME_LATIN_MAX, isValidLatin, latinSuggestion, tidyLatin } from "@/lib/people/latin-suggest";
import { commonI18n } from "@/i18n/ns/common";
import { settingsI18n } from "@/i18n/ns/settings";

export function LatinNameLine({ name, fallback }: { name: string; fallback?: string | null }) {
  const { t } = settingsI18n.useT();
  const { dbUsers, refreshUsers } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const current = dbUsers.find((u) => u.name === name)?.nameLatin ?? fallback ?? null;
  const suggestion = latinSuggestion({ name, nameLatin: current });
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  const save = useMutation({
    mutationFn: (nameLatin: string | null) => http.patch<{ ok: true; nameLatin: string | null }>("/api/users/me/name-latin", { nameLatin }),
    onSuccess: (r) => {
      setEditing(false);
      refreshUsers();
      for (const k of [["users", "me", "profile"], ["people-directory"]]) void qc.invalidateQueries({ queryKey: k });
      toast({ title: r.nameLatin ? t("profile.latin.saved") : t("profile.latin.removed"), description: r.nameLatin ?? undefined });
    },
    onError: (e: Error) => toast({ title: commonI18n.t("states.error"), description: e.message, variant: "destructive" }),
  });

  const start = () => { setValue(current ?? suggestion ?? ""); setEditing(true); };
  const valid = isValidLatin(value);
  const submit = () => {
    const v = tidyLatin(value);
    if (!valid || save.isPending) return;
    if (v === (current ?? "")) { setEditing(false); return; }
    save.mutate(v || null);
  };

  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Languages className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-muted-foreground" title={t("profile.latin.hint")}>{t("profile.latin.label")}:</span>
        {editing ? (
          <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex min-w-0 flex-wrap items-center gap-2" autoComplete="off">
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setEditing(false); } }}
              maxLength={NAME_LATIN_MAX}
              placeholder={t("profile.latin.placeholder")}
              aria-label={t("profile.latin.label")}
              aria-invalid={!valid || undefined}
              spellCheck={false}
              autoFocus
              className={cn("h-8 w-56", !valid && "border-down ring-1 ring-down/60")}
            />
            <Button type="submit" size="sm" disabled={!valid || save.isPending}>{commonI18n.t("actions.save")}</Button>
            {current && (
              <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>{t("profile.latin.clear")}</Button>
            )}
            <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => setEditing(false)}>{commonI18n.t("actions.cancel")}</Button>
          </form>
        ) : current ? (
          <>
            <span className="truncate font-medium text-foreground">{current}</span>
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={start}><Pencil /> {t("profile.latin.edit")}</Button>
          </>
        ) : (
          <>
            <span className="text-muted-foreground">{t("profile.latin.none")}</span>
            {suggestion && (
              <Button
                type="button" size="sm" variant="outline" className="h-7 px-2.5"
                disabled={save.isPending}
                aria-label={t("profile.latin.useAria", { latin: suggestion })}
                onClick={() => save.mutate(suggestion)}
              >
                <Check /> {t("profile.latin.use", { latin: suggestion })}
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={start}><Pencil /> {suggestion ? t("profile.latin.edit") : t("profile.latin.set")}</Button>
          </>
        )}
      </div>
      {editing && !valid && <p role="alert" className="text-xs text-down">{t("profile.latin.invalid")}</p>}
      {editing && valid && <p className="text-xs text-muted-foreground">{t("profile.latin.hint")}</p>}
    </div>
  );
}
