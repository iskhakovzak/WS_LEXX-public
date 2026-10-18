/** Child setups ("варианты") of a setup: reviewed toggle, open, detach, attach existing, create new. */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, Circle, GitBranch, Plus, Search, Unlink } from "lucide-react";
import { WriteOnly, useAuth } from "@/contexts/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChecklistProbabilityBadge } from "@/components/playbook-checklist-marks";
import { IconAction } from "@/components/playbook-sub/bits";
import { useToast } from "@/hooks/use-toast";
import { invalidatePlaybook } from "./api";
import { http } from "@/lib/api/http";
import { ConfidenceMeter, DocSection, EdgeMini, InlineError, SetupTypePill } from "./setup-bits";
import { searchHaystack, type PlaybookEntry, type SetupSummary } from "./model";
import { commonI18n } from "@/i18n/ns/common";
import { playbookSetupI18n } from "@/i18n/ns/playbookSetup";

export function SubSetupsSection({
  entry, allEntries, summary, onOpen, onCreateChild,
}: {
  entry: PlaybookEntry;
  allEntries: PlaybookEntry[];
  summary: Map<number, SetupSummary>;
  onOpen: (id: number) => void;
  onCreateChild: () => void;
}) {
  const { t } = playbookSetupI18n.useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user, canEdit } = useAuth();
  const trader = user?.traderName ?? "system";
  const [pickOpen, setPickOpen] = useState(false);
  const [search, setSearch] = useState("");

  const { data: children = [], isLoading, isError, refetch } = useQuery<PlaybookEntry[]>({
    queryKey: ["playbook-children", entry.id],
    queryFn: () => http.get<PlaybookEntry[]>(`/api/playbook/${entry.id}/children`),
  });

  const reviewedMut = useMutation({
    mutationFn: ({ id, reviewed }: { id: number; reviewed: boolean }) =>
      http.post(`/api/playbook/${id}/reviewed`, { reviewed, reviewer: trader }),
    onMutate: async ({ id, reviewed }) => {
      await qc.cancelQueries({ queryKey: ["playbook-children", entry.id] });
      const prev = qc.getQueryData<PlaybookEntry[]>(["playbook-children", entry.id]);
      qc.setQueryData<PlaybookEntry[]>(["playbook-children", entry.id], (old = []) => old.map((c) => (c.id === id ? { ...c, reviewed } : c)));
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["playbook-children", entry.id], ctx.prev);
      toast({ title: t("variants.reviewFailed"), variant: "destructive" });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["playbook-children", entry.id] });
      qc.invalidateQueries({ queryKey: ["playbook"] });
    },
  });

  const childIds = useMemo(() => new Set(children.map((c) => c.id)), [children]);
  const available = useMemo(() => {
    const q = search.trim().toLowerCase();
    const ids = new Set(allEntries.map((e) => e.id));
    return allEntries.filter(
      (e) => e.id !== entry.id && (!e.parentId || !ids.has(e.parentId)) && !childIds.has(e.id) && e.id !== entry.parentId && (!q || searchHaystack(e).includes(q)),
    );
  }, [allEntries, entry.id, entry.parentId, childIds, search]);

  async function setParent(child: PlaybookEntry, parentId: number | null) {
    try {
      await http.patch(`/api/playbook/${child.id}`, { parentId });
      invalidatePlaybook(qc, child.id);
      return true;
    } catch (e: any) {
      toast({ title: parentId ? t("variants.nestFailed") : t("variants.detachFailed"), description: e?.message, variant: "destructive" });
      return false;
    }
  }

  const reviewedCount = children.filter((c) => c.reviewed).length;

  return (
    <DocSection
      title={<>{t("variants.title")} {children.length > 0 && <span className="font-normal tabular-nums text-muted-foreground">{t("variants.reviewedOf", { reviewed: reviewedCount, total: children.length })}</span>}</>}
      icon={GitBranch}
      actions={
        <WriteOnly>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="h-8"><Plus className="h-4 w-4" aria-hidden="true" /> {t("variants.add")}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onCreateChild}>{t("variants.createNew")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPickOpen(true)}>{t("variants.nestExisting")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </WriteOnly>
      }
    >
      {isLoading && <Skeleton className="h-10 rounded-xl" />}
      {isError && <InlineError text={t("variants.loadFailed")} onRetry={() => refetch()} />}
      {!isLoading && !isError && children.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("variants.empty")}</p>
      )}
      {children.length > 0 && (
        <ul className="-mx-2 space-y-0.5">
          {children.map((c) => (
            <li key={c.id} className="group flex items-center gap-1 rounded-xl px-1 hover:bg-[var(--glass-hover-bg)]">
              {canEdit ? (
                <IconAction
                  aria-label={c.reviewed ? t("variants.unmark", { name: c.name }) : t("variants.mark", { name: c.name })}
                  title={c.reviewed ? t("variants.unmark", { name: c.name }) : t("variants.mark", { name: c.name })}
                  aria-pressed={c.reviewed}
                  onClick={() => reviewedMut.mutate({ id: c.id, reviewed: !c.reviewed })}
                  className={c.reviewed ? "text-up hover:text-up" : undefined}
                >
                  {c.reviewed ? <CheckCircle2 /> : <Circle />}
                </IconAction>
              ) : (
                <span className="grid h-8 w-8 shrink-0 place-items-center" role="img" aria-label={c.reviewed ? t("view.reviewed") : t("view.notReviewed")}>
                  {c.reviewed ? <CheckCircle2 className="h-4 w-4 text-up" aria-hidden="true" /> : <Circle className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
                </span>
              )}
              <button
                type="button"
                onClick={() => onOpen(c.id)}
                className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className={"min-w-0 truncate text-sm font-medium text-foreground"}>{c.name}</span>
                {c.ticker && <span className="text-xs text-muted-foreground">{c.ticker}</span>}
                <SetupTypePill type={c.setupType} />
                <EdgeMini s={summary.get(c.id)} />
                <ConfidenceMeter level={c.confidenceLevel} className="ml-auto" />
              </button>
              {(c.checklist || entry.checklist) && (
                <span className="hidden sm:inline-flex">
                  <ChecklistProbabilityBadge playbookId={c.id} items={c.checklist ? c.checklistItems : null} text={c.checklist || entry.checklist} />
                </span>
              )}
              <WriteOnly>
                <IconAction
                  aria-label={t("variants.detach", { name: c.name })}
                  title={t("variants.detach", { name: c.name })}
                  onClick={async () => { if (await setParent(c, null)) toast({ title: t("variants.detached", { name: c.name }), description: t("variants.detachedDesc") }); }}
                  className="hover:text-down md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                >
                  <Unlink />
                </IconAction>
              </WriteOnly>
              <ChevronRight className="mr-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </li>
          ))}
        </ul>
      )}

      <Dialog open={pickOpen} onOpenChange={(v) => { setPickOpen(v); if (!v) setSearch(""); }}>
        <DialogContent className="flex max-h-[85dvh] max-w-2xl flex-col">
          <DialogHeader>
            <DialogTitle>{t("variants.nestTitle")}</DialogTitle>
            <DialogDescription>{t("variants.nestDesc", { name: entry.name })}</DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t("variants.searchAria")} placeholder={t("variants.searchPlaceholder")} className="pl-9" autoFocus />
          </div>
          <div className="-mx-2 min-h-0 flex-1 overflow-y-auto">
            {available.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{search ? commonI18n.t("states.nothingFound") : t("variants.noneAvailable")}</p>}
            {available.slice(0, 200).map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={async () => { if (await setParent(e, entry.id)) { setPickOpen(false); setSearch(""); toast({ title: t("variants.nested", { name: e.name }) }); } }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{e.name}</span>
                {e.folder && <span className="max-w-[140px] truncate text-xs text-muted-foreground">{e.folder}</span>}
                <SetupTypePill type={e.setupType} />
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </DocSection>
  );
}
