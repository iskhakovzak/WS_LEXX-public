/**
 * Latin display names in «People» (users.name_latin: shown instead of the Cyrillic name in EN / UZ, found by search).
 * Most people don't have one yet, so the panel suggests it (UX law «prefill», lib/people/latin-suggest.ts):
 *   • LatinSuggestion — under a name without a Latin name: the suggestion as a chip, one click saves it, the pencil
 *     opens the editor already filled in;
 *   • FillLatinButton — «Latin names · N» opens a confirm dialog listing every change (name → suggestion, each
 *     editable or unticked) and saves them in one call;
 *   • NameLatinDialog — the single editor (prefilled with the suggestion when the person has no Latin name).
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, Languages, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Pill } from "@/components/ds";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { personName } from "@/i18n";
import { adminI18n } from "@/i18n/ns/admin";
import { commonI18n } from "@/i18n/ns/common";
import { NotDeployedError, useSetNameLatin, useSetNamesLatinBulk, type Person } from "./console-api";
import { NAME_LATIN_MAX, isValidLatin, latinSuggestion, tidyLatin } from "@/lib/people/latin-suggest";

function useErrorToast() {
  const { toast } = useToast();
  const { t } = adminI18n.useT();
  return (e: Error) => toast({ title: e instanceof NotDeployedError ? t("needRestart") : commonI18n.t("states.error"), description: e.message, variant: "destructive" });
}

/** The suggested Latin name under a person's name: click saves it, the pencil edits it first. */
export function LatinSuggestion({ person, onEdit }: { person: Person; onEdit: () => void }) {
  const { t } = adminI18n.useT();
  const { refreshUsers } = useAuth();
  const { toast } = useToast();
  const onError = useErrorToast();
  const save = useSetNameLatin();
  const suggestion = latinSuggestion(person);
  if (!suggestion) return null;
  const name = personName(person.name);
  return (
    <div className="mt-0.5 flex items-center gap-1">
      <button
        type="button"
        disabled={save.isPending}
        title={t("people.latin.suggestTitle")}
        aria-label={t("people.latin.suggestAria", { latin: suggestion, name })}
        onClick={() => save.mutate({ id: person.id, nameLatin: suggestion }, {
          onSuccess: (r) => { refreshUsers(); toast({ title: t("people.latin.saved", { name: personName(r.name) }), description: r.nameLatin ?? undefined }); },
          onError,
        })}
        className="inline-flex h-6 max-w-[12rem] items-center gap-1 rounded-full border border-dashed border-[var(--glass-border)] px-2 text-2xs text-muted-foreground transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{suggestion}</span>
      </button>
      <button
        type="button"
        onClick={onEdit}
        aria-label={t("people.latin.editAria", { name })}
        title={t("people.latin.editAria", { name })}
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--glass-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Pencil className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  );
}

type Draft = { checked: boolean; value: string };

/** «Latin names · N» + the confirm dialog. `people`: the rows the viewer may edit. Hidden when nothing to suggest. */
export function FillLatinButton({ people }: { people: readonly Person[] }) {
  const { t } = adminI18n.useT();
  const { refreshUsers } = useAuth();
  const { toast } = useToast();
  const onError = useErrorToast();
  const save = useSetNamesLatinBulk();
  const [open, setOpen] = useState(false);
  const rows = useMemo(
    () => people.flatMap((p) => { const s = latinSuggestion(p); return s ? [{ person: p, suggestion: s }] : []; }),
    [people],
  );
  const [drafts, setDrafts] = useState<Map<number, Draft>>(new Map());
  // Fresh drafts each time the dialog opens: every suggestion ticked, archived people left out.
  useEffect(() => {
    if (open) setDrafts(new Map(rows.map((r) => [r.person.id, { checked: r.person.status !== "archived", value: r.suggestion }])));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the dialog opens
  }, [open]);
  if (!rows.length && !open) return null;

  const picked = rows.filter((r) => drafts.get(r.person.id)?.checked);
  const invalid = picked.some((r) => { const v = drafts.get(r.person.id)?.value ?? ""; return !tidyLatin(v) || !isValidLatin(v); });
  const allChecked = picked.length === rows.length && rows.length > 0;
  const patch = (id: number, d: Partial<Draft>) => setDrafts((m) => new Map(m).set(id, { ...(m.get(id) ?? { checked: true, value: "" }), ...d }));
  const submit = () => {
    if (!picked.length || invalid || save.isPending) return;
    save.mutate(picked.map((r) => ({ id: r.person.id, nameLatin: tidyLatin(drafts.get(r.person.id)?.value ?? "") })), {
      onSuccess: (r) => { setOpen(false); refreshUsers(); toast({ title: t("people.latin.done", { count: r.changed.length }) }); },
      onError,
    });
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Languages /> {t("people.latin.fill", { count: rows.length })}
      </Button>
      <Dialog open={open} onOpenChange={(v) => { if (!save.isPending) setOpen(v); }}>
        <DialogContent className="sm:max-w-xl">
          <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex min-h-0 flex-col gap-4" autoComplete="off">
            <DialogHeader>
              <DialogTitle>{t("people.latin.fillTitle")}</DialogTitle>
              <DialogDescription>{t("people.latin.fillDescription")}</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-3 border-b border-[var(--glass-border)] pb-2 text-xs text-muted-foreground">
              <Checkbox
                checked={allChecked ? true : picked.length ? "indeterminate" : false}
                onCheckedChange={(v) => setDrafts((m) => new Map([...m].map(([id, d]) => [id, { ...d, checked: !!v }])))}
                aria-label={t("people.latin.fillAll")}
              />
              <span className="w-[38%] shrink-0">{t("people.latin.colName")}</span>
              <span className="min-w-0 flex-1">{t("people.latin.colLatin")}</span>
            </div>
            <ul className="-mx-1 flex max-h-[min(55vh,28rem)] flex-col gap-1 overflow-y-auto overscroll-contain px-1">
              {rows.map(({ person: p }) => {
                const d = drafts.get(p.id) ?? { checked: false, value: "" };
                const bad = d.checked && (!tidyLatin(d.value) || !isValidLatin(d.value));
                return (
                  <li key={p.id} className={cn("flex items-center gap-3 rounded-lg px-1 py-1", !d.checked && "opacity-60")}>
                    <Checkbox checked={d.checked} onCheckedChange={(v) => patch(p.id, { checked: !!v })} aria-label={t("people.latin.rowAria", { name: p.name })} />
                    <span className="flex w-[38%] shrink-0 items-center gap-1.5 truncate text-sm" title={p.name}>
                      <span className="truncate">{p.name}</span>
                      {p.status === "archived" && <Pill tone="neutral">{adminI18n.t("people.status.archived")}</Pill>}
                    </span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <Input
                      value={d.value}
                      onChange={(e) => patch(p.id, { value: e.target.value, checked: true })}
                      maxLength={NAME_LATIN_MAX}
                      spellCheck={false}
                      aria-label={t("people.latin.title", { name: p.name })}
                      aria-invalid={bad || undefined}
                      title={bad ? t("people.latin.invalid") : undefined}
                      className={cn("h-8 min-w-0 flex-1", bad && "border-down ring-1 ring-down/60 focus-visible:ring-down/60")}
                    />
                  </li>
                );
              })}
            </ul>
            {invalid && <p role="alert" className="text-xs text-down">{t("people.latin.invalid")}</p>}
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={save.isPending}>{commonI18n.t("actions.cancel")}</Button>
              <Button type="submit" disabled={!picked.length || invalid || save.isPending}>
                {save.isPending ? t("reason.saving") : t("people.latin.save", { count: picked.length })}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Edit one Latin name; a person without one gets the suggestion filled in. */
export function NameLatinDialog({ person, busy, onClose, onSave }: { person: Person | null; busy: boolean; onClose: () => void; onSave: (value: string | null) => void }) {
  const { t } = adminI18n.useT();
  const [value, setValue] = useState("");
  useEffect(() => { if (person) setValue(person.nameLatin ?? latinSuggestion(person) ?? ""); }, [person]);
  const trimmed = tidyLatin(value);
  const changed = trimmed !== (person?.nameLatin ?? "");
  const valid = isValidLatin(value);
  return (
    <Dialog open={!!person} onOpenChange={(v) => { if (!v && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(e) => { e.preventDefault(); if (changed && valid && !busy) onSave(trimmed || null); }} className="flex flex-col gap-4" autoComplete="off">
          <DialogHeader>
            <DialogTitle>{person ? t("people.latin.title", { name: person.name }) : ""}</DialogTitle>
            <DialogDescription>{t("people.latin.description")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="nl-value" className="text-xs text-muted-foreground">{t("people.latin.label")}</Label>
            <Input id="nl-value" value={value} onChange={(e) => setValue(e.target.value)} maxLength={NAME_LATIN_MAX} placeholder={t("people.latin.placeholder")} autoFocus spellCheck={false} aria-invalid={!valid || undefined} />
            {!valid && <p role="alert" className="text-xs text-down">{t("people.latin.invalid")}</p>}
          </div>
          <DialogFooter className="gap-2">
            {person?.nameLatin && <Button type="button" variant="ghost" className="mr-auto" disabled={busy} onClick={() => onSave(null)}>{t("people.latin.clear")}</Button>}
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{commonI18n.t("actions.cancel")}</Button>
            <Button type="submit" disabled={!changed || !valid || busy}>{busy ? t("reason.saving") : commonI18n.t("actions.save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
