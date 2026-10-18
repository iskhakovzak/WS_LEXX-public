import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookmarkPlus, LayoutTemplate, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/auth-context";
import { gpApi, gpKeys, type PlanDoc } from "./types";
import { BUILTIN_TEMPLATES } from "./plan-draft";
import { gpI18n } from "@/i18n/ns/gamePlan";
import { personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";

/**
 * Templates menu: built-in skeletons + saved templates (mine and shared). Applying a template only fills
 * blocks that are still empty and adds missing tickers — never overwrites what's written.
 */
export function TemplateMenu({
  kind,
  onApply,
  currentDoc,
}: {
  kind: "desk" | "personal";
  onApply: (doc: Partial<PlanDoc>, name: string) => void;
  /** Lazily built document for «Сохранить как шаблон». */
  currentDoc: () => PlanDoc;
}) {
  const { t: tr } = gpI18n.useT();
  const { user, can } = useAuth();
  const me = user?.traderName ?? "";
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const canShare = kind === "desk" || can("gameplan.publish");

  const q = useQuery({
    queryKey: gpKeys.templates(kind),
    queryFn: () => gpApi.templates(kind),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  const save = useMutation({
    mutationFn: () => gpApi.saveTemplate({ name: name.trim(), kind, shared: kind === "desk" ? true : shared, doc: currentDoc() }),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: gpKeys.templates(kind) });
      setName("");
      toast({ title: tr("templates.savedToast"), description: tr("templates.savedDesc", { name: t.name }) });
    },
    onError: (e) => toast({ title: tr("templates.saveFailed"), description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => gpApi.removeTemplate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: gpKeys.templates(kind) }),
    onError: (e) => toast({ title: tr("templates.removeFailed"), description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });

  const apply = (doc: Partial<PlanDoc>, n: string) => {
    onApply(doc, n);
    setOpen(false);
  };
  const saved = Array.isArray(q.data) ? q.data : [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <LayoutTemplate aria-hidden="true" />
          {tr("templates.button")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <p className="micro-label px-2 pb-1 pt-1">{tr("templates.builtin")}</p>
        <ul className="flex flex-col">
          {BUILTIN_TEMPLATES.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => apply(t.doc, t.name)}
                className="flex w-full flex-col rounded-lg px-2 py-1.5 text-left hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="text-sm font-medium">{t.name}</span>
                <span className="text-xs text-muted-foreground">{t.hint}</span>
              </button>
            </li>
          ))}
        </ul>

        <p className="micro-label px-2 pb-1 pt-3">{tr("templates.saved")}</p>
        {q.isLoading ? (
          <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> {commonI18n.t("states.loading")}
          </div>
        ) : q.isError ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">{tr("templates.unavailable")}</p>
        ) : saved.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">{tr("templates.none")}</p>
        ) : (
          <ul className="flex max-h-[min(50dvh,420px)] flex-col overflow-y-auto">
            {saved.map((t) => (
              <li key={t.id} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => apply(t.doc, t.name)}
                  className="flex min-w-0 flex-1 flex-col rounded-lg px-2 py-1.5 text-left hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="truncate text-sm font-medium">{t.name}</span>
                  <span className="text-xs text-muted-foreground">{t.author === me ? (t.shared ? tr("templates.mineShared") : tr("templates.mine")) : personName(t.author)}</span>
                </button>
                {t.author === me && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    aria-label={tr("templates.remove", { name: t.name })}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(t.id)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        <form
          className="mt-2 flex flex-col gap-2 border-t border-[var(--field-border)] px-1 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          <div className="flex gap-1.5">
            <Input
              aria-label={tr("templates.nameAria")}
              placeholder={tr("templates.namePlaceholder")}
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8"
            />
            <Button type="submit" size="sm" className="h-8 shrink-0" disabled={!name.trim() || save.isPending} aria-label={tr("templates.save")} title={tr("templates.save")}>
              {save.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <BookmarkPlus aria-hidden="true" />}
            </Button>
          </div>
          {kind === "personal" && canShare && (
            <label className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
              <Checkbox checked={shared} onCheckedChange={(v) => setShared(v === true)} />
              {tr("templates.shareTeam")}
            </label>
          )}
        </form>
      </PopoverContent>
    </Popover>
  );
}
