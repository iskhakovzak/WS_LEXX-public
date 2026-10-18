/**
 * «Поделиться» — a senior (or curator) opens their personal setup to everyone, to specific people or to a cohort.
 * Readers see the author and can copy it into «Мой». «Только я» revokes access. POST /api/playbook/:id/share.
 */
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Globe2, Loader2, Lock, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { invalidatePlaybook, notLiveMessage, useShareTargets } from "./api";
import { http } from "@/lib/api/http";
import type { PlaybookEntry, Visibility } from "./model";
import { fmtDate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { playbookDialogsI18n } from "@/i18n/ns/playbookDialogs";

import { personName } from "@/i18n";
const OPTIONS: { value: Visibility; icon: typeof Lock }[] = [
  { value: "private", icon: Lock },
  { value: "all", icon: Globe2 },
  { value: "custom", icon: Users },
];

export function ShareDialog({ open, onOpenChange, entry }: { open: boolean; onOpenChange: (v: boolean) => void; entry: PlaybookEntry }) {
  const { t } = playbookDialogsI18n.useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const targets = useShareTargets(open);
  const [vis, setVis] = React.useState<Visibility>("private");
  const [users, setUsers] = React.useState<Set<string>>(new Set());
  const [cohorts, setCohorts] = React.useState<Set<number>>(new Set());
  const [filter, setFilter] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setVis((entry.visibility as Visibility) ?? "private");
    setUsers(new Set(entry.sharedWith?.users ?? []));
    setCohorts(new Set(entry.sharedWith?.cohorts ?? []));
    setFilter("");
  }, [open, entry]);

  const toggle = <T,>(set: Set<T>, v: T) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };
  const nothingPicked = vis === "custom" && users.size === 0 && cohorts.size === 0;

  async function save() {
    setSaving(true);
    try {
      await http.post(`/api/playbook/${entry.id}/share`, { visibility: nothingPicked ? "private" : vis, users: [...users], cohorts: [...cohorts] });
      invalidatePlaybook(qc, entry.id);
      toast({ title: vis === "private" || nothingPicked ? t("share.closed") : vis === "all" ? t("share.openedAll") : t("share.openedCustom") });
      onOpenChange(false);
    } catch (e) {
      toast({ title: t("share.failed"), description: notLiveMessage(e) ?? (e as Error)?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const people = (targets.data?.users ?? []).filter((u) => !filter.trim() || [u.name, personName(u.name)].some((n) => n.toLowerCase().includes(filter.trim().toLowerCase())));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] max-w-xl flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("share.title", { name: entry.name })}</DialogTitle>
          <DialogDescription>{t("share.description")}</DialogDescription>
        </DialogHeader>

        <div role="radiogroup" aria-label={t("share.whoSees")} className="grid gap-2">
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={vis === o.value}
              onClick={() => setVis(o.value)}
              className={cn(
                "flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors duration-[var(--dur-1)]",
                vis === o.value ? "border-primary/60 bg-primary/5" : "border-border/60 hover:bg-[var(--glass-hover-bg)]",
              )}
            >
              <o.icon className={cn("mt-0.5 h-4 w-4 shrink-0", vis === o.value ? "text-primary" : "text-muted-foreground")} aria-hidden="true" />
              <span>
                <span className="block text-sm font-medium text-foreground">{t(`share.option.${o.value}.label`)}</span>
                <span className="block text-xs text-muted-foreground">{t(`share.option.${o.value}.hint`)}</span>
              </span>
            </button>
          ))}
        </div>

        {vis === "custom" && (
          <div className="flex flex-col gap-3">
            {targets.isLoading ? (
              <div className="h-32 animate-pulse rounded-xl bg-[var(--glass-bg)] motion-reduce:animate-none" />
            ) : targets.isError ? (
              <p className="text-sm text-down">{notLiveMessage(targets.error) ?? (targets.error as Error)?.message}</p>
            ) : (
              <>
                {(targets.data?.cohorts.length ?? 0) > 0 && (
                  <fieldset>
                    <legend className="mb-1.5 text-xs text-muted-foreground">{t("share.cohorts")}</legend>
                    <div className="flex flex-wrap gap-1.5">
                      {targets.data!.cohorts.map((c) => (
                        <button key={c.id} type="button" aria-pressed={cohorts.has(c.id)} onClick={() => setCohorts((s) => toggle(s, c.id))} className="chip min-h-8 px-3 text-xs">
                          {c.name} <span className="tabular-nums text-muted-foreground">{c.members}</span>
                        </button>
                      ))}
                    </div>
                  </fieldset>
                )}
                <fieldset>
                  <legend className="mb-1.5 text-xs text-muted-foreground">{users.size > 0 ? t("share.peopleSelected", { count: users.size }) : t("share.people")}</legend>
                  <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("share.findByName")} aria-label={t("share.findByName")} className="mb-2 h-9" />
                  <ul className="flex max-h-[min(45dvh,360px)] flex-col gap-1 overflow-y-auto">
                    {people.map((u) => (
                      <li key={u.name} className="flex min-h-9 items-center gap-2 rounded-lg px-1 text-sm hover:bg-[var(--glass-hover-bg)]">
                        <Checkbox id={`sh-${u.name}`} checked={users.has(u.name)} onCheckedChange={() => setUsers((s) => toggle(s, u.name))} />
                        <label htmlFor={`sh-${u.name}`} className="flex min-h-9 flex-1 cursor-pointer items-center">{personName(u.name)}</label>
                        <span className="text-xs text-muted-foreground">{u.role === "curator" ? commonI18n.t("roles.curator") : u.role === "admin" ? commonI18n.t("roles.admin") : ""}</span>
                      </li>
                    ))}
                    {people.length === 0 && <li className="px-1 py-3 text-sm text-muted-foreground">{t("share.nobody")}</li>}
                  </ul>
                </fieldset>
                {nothingPicked && <p className="text-xs text-[hsl(var(--chart-3))]">{t("share.pickHint")}</p>}
              </>
            )}
          </div>
        )}

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {entry.sharedAt && entry.visibility !== "private" ? t("share.openedOn", { date: fmtDate(entry.sharedAt, "short") }) : ""}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>{commonI18n.t("actions.cancel")}</Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {vis === "private" || nothingPicked ? t("share.makePrivate") : t("share.open")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
