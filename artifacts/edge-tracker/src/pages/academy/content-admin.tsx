import { useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { Archive, ArrowLeft, Database, Eye, GraduationCap, Loader2, PencilRuler, Plus, ShieldAlert } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, Page, PageHeader, Panel, Pill, Toolbar } from "@/components/ds";
import { api, invalidateAcademy, stageLabel, useAcademyMeta, useAdminTree, type ItemKind } from "@/components/academy/content/api";
import { ContentTree, type Selection } from "@/components/academy/content/content-tree";
import { ItemEditor, ModuleForm, ProgramForm } from "@/components/academy/content/editors";
import { academyLinks } from "@/components/academy/content/links";
import { academyI18n } from "@/i18n/ns/academy";
import { commonI18n } from "@/i18n/ns/common";
import { shellI18n } from "@/i18n/ns/shell";

/**
 * /academy/content-admin — «Редактор курсов» (наставники / staff).
 * Слева — программа и дерево модулей с перетаскиванием (и клавиатурой), справа — редактор выбранного элемента
 * с живым предпросмотром. Удаления нет — только архив (archived_at) и восстановление.
 */

const NEW = "__new__";

export default function AcademyContentAdmin() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const { isCurator } = useAuth();
  const meta = useAcademyMeta();
  const staff = isCurator || !!meta.data?.staff;
  const { toast } = useToast();
  const qc = useQueryClient();
  const { t } = academyI18n.useT();

  const [showArchived, setShowArchived] = useState(false);
  const programParam = params.get("program");
  const creatingProgram = programParam === NEW;
  const programId = Number(programParam) || null;
  const tree = useAdminTree(creatingProgram ? null : programId, showArchived);
  const [selection, setSelection] = useState<Selection>({ type: "program" });
  const [seeding, setSeeding] = useState(false);

  const setProgram = (id: number | typeof NEW) => {
    setSelection({ type: "program" });
    navigate(academyLinks.admin({ program: id }), { replace: true });
  };

  const seed = async () => {
    setSeeding(true);
    try {
      const r = await api.seedDemo();
      const created = Object.values(r.created).reduce((a, n) => a + n, 0);
      toast({ title: r.alreadySeeded && !created ? t("learn.demoAlready") : t("learn.demoLoaded"), description: created ? t("admin.demoCreated", { count: created }) : t("admin.demoNothing") });
      await invalidateAcademy(qc);
      setProgram(r.programId);
    } catch (e) {
      toast({ title: t("learn.demoFailed"), description: (e as Error).message, variant: "destructive" });
    } finally {
      setSeeding(false);
    }
  };

  if (meta.isSuccess && !staff) {
    return (
      <Page>
        <Panel>
          <EmptyState icon={ShieldAlert} title={t("admin.mentorsOnly")} description={t("admin.mentorsOnlyDesc")} action={<Button asChild><Link href={academyLinks.learn()}>{t("admin.toLearning")}</Link></Button>} />
        </Panel>
      </Page>
    );
  }

  const d = tree.data;
  const program = creatingProgram ? null : d?.program ?? null;
  const modules = d?.modules ?? [];
  const itemCount = modules.reduce((a, m) => a + m.items.length, 0);
  const programs = d?.programs ?? [];
  const onItemCreated = (kind: ItemKind, id: number) => setSelection({ type: "item", kind, id });

  let editor: React.ReactNode = null;
  if (creatingProgram || !program) {
    editor = <ProgramForm key="new-program" program={null} onCreated={(id) => setProgram(id)} />;
  } else if (selection.type === "program") {
    editor = <ProgramForm key={`p-${program.id}-${program.updatedAt}`} program={program} />;
  } else if (selection.type === "new-module") {
    editor = <ModuleForm key="new-module" module={null} programId={program.id} onCreated={(id) => setSelection({ type: "module", id })} />;
  } else if (selection.type === "module") {
    const m = modules.find((x) => x.id === selection.id);
    editor = m ? <ModuleForm key={`m-${m.id}-${m.title}-${m.archivedAt}`} module={m} programId={program.id} /> : null;
  } else if (selection.type === "new-item") {
    editor = <ItemEditor key={`new-${selection.kind}-${selection.moduleId}`} item={null} newKind={selection.kind} moduleId={selection.moduleId} modules={modules} onCreated={onItemCreated} />;
  } else if (selection.type === "item") {
    const item = modules.flatMap((m) => m.items).find((x) => x.kind === selection.kind && x.id === selection.id);
    editor = item
      ? <ItemEditor key={`${item.kind}-${item.id}-${item.updatedAt}-${item.archivedAt}-${item.moduleId}`} item={item} moduleId={item.moduleId} modules={modules} onCreated={onItemCreated} />
      : null;
  }
  if (!editor && program) {
    editor = <Panel><EmptyState icon={PencilRuler} title={t("admin.notFound")} description={t("admin.notFoundDesc")} /></Panel>;
  }

  return (
    <Page>
      <PageHeader
        title={shellI18n.t("nav.academyContent")}
        icon={PencilRuler}
        description={t("admin.description")}
        actions={
          <>
            <Button variant="ghost" asChild><Link href={academyLinks.learn({ program: program?.id })}><ArrowLeft aria-hidden="true" />{t("admin.toLearning")}</Link></Button>
            <Button variant="outline" onClick={seed} disabled={seeding}>{seeding ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Database aria-hidden="true" />}{t("admin.demoCourse")}</Button>
          </>
        }
      />

      <Toolbar>
        <span className="px-2 text-sm text-muted-foreground">{t("learn.program")}</span>
        <Select value={creatingProgram ? NEW : program ? String(program.id) : ""} onValueChange={(v) => setProgram(v === NEW ? NEW : Number(v))}>
          <SelectTrigger className="h-9 w-full rounded-full sm:w-[320px]" aria-label={t("learn.program")}><SelectValue placeholder={t("learn.pickProgram")} /></SelectTrigger>
          <SelectContent>
            {programs.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {[p.title, p.stage ? stageLabel(p.stage) : null, !p.published ? t("admin.draftLower") : null, p.archivedAt ? t("admin.archiveLower") : null].filter(Boolean).join(" · ")}
              </SelectItem>
            ))}
            <SelectItem value={NEW}>{t("admin.newProgramOption")}</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 px-2">
          <Switch id="show-archived" checked={showArchived} onCheckedChange={setShowArchived} />
          <Label htmlFor="show-archived" className="flex items-center gap-1 text-sm"><Archive className="h-3.5 w-3.5" aria-hidden="true" />{t("admin.showArchive")}</Label>
        </div>
        {program && (
          <Button variant="ghost" size="sm" asChild className="ml-auto"><Link href={academyLinks.learn({ program: program.id })}><Eye aria-hidden="true" />{t("admin.previewProgram")}</Link></Button>
        )}
      </Toolbar>

      {tree.isLoading || meta.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]"><Skeleton className="h-96 rounded-2xl" /><Skeleton className="h-[32rem] rounded-2xl" /></div>
      ) : tree.isError ? (
        <Panel><p className="text-sm text-down">{t("admin.contentFailed", { message: (tree.error as Error).message })}</p></Panel>
      ) : !programs.length && !creatingProgram ? (
        <Panel>
          <EmptyState
            icon={GraduationCap}
            title={t("matrix.noPrograms")}
            description={t("admin.noProgramsDemo")}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={seed} disabled={seeding}>{seeding ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Database aria-hidden="true" />}{t("learn.loadDemo")}</Button>
                <Button variant="outline" onClick={() => setProgram(NEW)}><Plus aria-hidden="true" />{t("editor.program.new")}</Button>
              </div>
            }
          />
        </Panel>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="flex flex-col gap-3 lg:sticky lg:top-[var(--sticky-top)] lg:max-h-[calc(100dvh-var(--header-h)-0.75rem-2*var(--sticky-top))] lg:overflow-y-auto lg:pr-0.5" aria-label={t("admin.structureAria")}>
            {program && (
              <>
                <button
                  type="button"
                  onClick={() => setSelection({ type: "program" })}
                  aria-current={selection.type === "program" ? "true" : undefined}
                  className="glass-panel flex flex-col gap-1 rounded-xl p-3 text-left hover:bg-[var(--glass-hover-bg)] aria-[current=true]:ring-1 aria-[current=true]:ring-primary/60"
                >
                  <span className="font-semibold">{program.title}</span>
                  <span className="flex flex-wrap gap-1.5">
                    {program.stage && <Pill tone="purple">{stageLabel(program.stage)}</Pill>}
                    {program.published ? <Pill tone="up">{t("editor.program.published")}</Pill> : <Pill tone="warn">{commonI18n.t("states.draft")}</Pill>}
                    {program.archivedAt && <Pill tone="neutral">{t("admin.archive")}</Pill>}
                    <span className="text-xs text-muted-foreground tabular-nums">{t("units.modules", { count: modules.length })} · {t("units.items", { count: itemCount })}</span>
                  </span>
                </button>
                <ContentTree programId={program.id} modules={modules} selection={selection} onSelect={setSelection} />
              </>
            )}
          </aside>
          <div className="min-w-0">{editor}</div>
        </div>
      )}
    </Page>
  );
}
