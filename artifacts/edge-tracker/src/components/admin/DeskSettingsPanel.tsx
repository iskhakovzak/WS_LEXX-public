/**
 * Admin console → «Настройки деска» (owner 2026-10-18: «легко настраивать, всё на сайте»). The form is built from the
 * server registry (GET /api/admin/settings → lib/settings/registry.ts): one section per group, one row per key
 * (DeskSettingField). Edits stay a draft until the one «Сохранить» (PUT, the whole batch; SETTINGS_INVALID problems land
 * next to their fields); a value equal to the default is sent as «по умолчанию» (null). Admins only (settings.manage).
 */
import { useMemo, useState } from "react";
import { Save, SlidersHorizontal, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QueryError } from "@/components/query-error";
import { EmptyState, ListSkeleton, Panel } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { isApiError } from "@/lib/api/http";
import { humanizeApiError } from "@/lib/api/errors";
import { deskSettingsI18n } from "@/i18n/ns/deskSettings";
import { useDeskSettings, useSaveDeskSettings } from "./desk-settings-api";
import { DeskSettingField } from "./DeskSettingField";
import {
  changesOf, checkValue, groupRows, normalize, parseInput, shownProblem, type Problem, type SettingRow, type SettingValue,
} from "./desk-settings-model";

export function DeskSettingsPanel({ canManage }: { canManage: boolean }) {
  const { t } = deskSettingsI18n.useT();
  const q = useDeskSettings(canManage);
  if (!canManage) return <EmptyState icon={SlidersHorizontal} title={t("title")} description={t("denied")} className="py-16" />;
  if (q.isLoading) return <Panel title={t("title")} icon={SlidersHorizontal}><ListSkeleton rows={6} /></Panel>;
  if (q.isError || !q.data) return <QueryError error={q.error} title={t("loadFailed")} onRetry={() => q.refetch()} />;
  return <SettingsForm rows={q.data.settings} />;
}

function SettingsForm({ rows }: { rows: SettingRow[] }) {
  const { t } = deskSettingsI18n.useT();
  const { toast } = useToast();
  const save = useSaveDeskSettings();
  const [draft, setDraft] = useState<Record<string, SettingValue | null>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [serverProblems, setServerProblems] = useState<Record<string, Problem>>({});

  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const groups = useMemo(() => groupRows(rows), [rows]);
  const changes = useMemo(() => changesOf(rows, draft), [rows, draft]);

  const shown = (r: SettingRow): SettingValue => (r.key in draft ? (draft[r.key] ?? r.default) : r.effective);
  const localProblem = (r: SettingRow): Problem | null => {
    const text = texts[r.key];
    if (text !== undefined) {
      const p = parseInput(r.key, r.def, text);
      if (!p.ok) return p.problem;
    }
    return r.key in draft ? checkValue(r.key, r.def, shown(r)) : null;
  };
  const problems = rows.map(localProblem).filter((p): p is Problem => !!p);
  const dirtyKeys = new Set([...changes.map((c) => c.key), ...problems.map((p) => p.key)]);

  const onValue = (r: SettingRow, v: SettingValue | null, text?: string) => {
    setServerProblems(({ [r.key]: _gone, ...rest }) => rest);
    if (text !== undefined) {
      setTexts((s) => ({ ...s, [r.key]: text }));
      const p = parseInput(r.key, r.def, text);
      if (p.ok) setDraft((d) => ({ ...d, [r.key]: p.value }));
      return;
    }
    setTexts(({ [r.key]: _gone, ...rest }) => rest);
    setDraft((d) => ({ ...d, [r.key]: v === null ? null : normalize(r, v) ?? null }));
  };

  const discard = () => { setDraft({}); setTexts({}); setServerProblems({}); };

  const submit = () => {
    if (problems.length) { toast({ title: t("save.fixFields"), variant: "destructive" }); return; }
    if (!changes.length) return;
    save.mutate(changes, {
      onSuccess: (data) => {
        discard();
        const n = data.changed?.length ?? 0;
        toast(n ? { title: t("save.done"), description: t("save.doneText", { count: n }) } : { title: t("save.nothing") });
      },
      onError: (err) => {
        const list = isApiError(err) && err.code === "SETTINGS_INVALID" ? ((err.body as { details?: { problems?: Problem[] } } | null)?.details?.problems ?? []) : [];
        if (list.length) setServerProblems(Object.fromEntries(list.map((p) => [p.key, shownProblem(byKey.get(p.key)?.def, p)])));
        toast({ title: t("save.failed"), description: list.length ? t("save.fixFields") : humanizeApiError(err), variant: "destructive" });
      },
    });
  };

  const pending = dirtyKeys.size;
  return (
    <div className="flex flex-col gap-[var(--grid-gap)] pb-2">
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      {groups.map((g) => (
        <Panel
          key={g.group}
          title={deskSettingsI18n.tryT(`groups.${g.group}.title`) ?? g.group}
          description={deskSettingsI18n.tryT(`groups.${g.group}.description`)}
          bodyClassName="py-0"
        >
          <div className="divide-y divide-[var(--glass-border)]">
            {g.rows.map((r) => (
              <DeskSettingField
                key={r.key}
                row={r}
                value={shown(r)}
                text={texts[r.key]}
                dirty={dirtyKeys.has(r.key)}
                problem={serverProblems[r.key] ?? localProblem(r)}
                onValue={(v, text) => onValue(r, v, text)}
              />
            ))}
          </div>
        </Panel>
      ))}
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-2 rounded-2xl px-[var(--panel-p)] py-2.5",
          // Unsaved edits: the bar sticks to the bottom on a solid background (the one next step); clean: a quiet footer.
          pending ? "sticky bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-sticky border border-[var(--glass-border)] bg-background/95 shadow-lg backdrop-blur" : "glass-panel",
        )}
        role="region"
        aria-label={t("title")}
      >
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {pending ? t("save.pending", { count: pending }) : t("save.idle")}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={discard} disabled={!pending || save.isPending}>
            <Undo2 aria-hidden="true" />
            {t("save.discard")}
          </Button>
          <Button size="sm" onClick={submit} disabled={!pending || save.isPending}>
            <Save aria-hidden="true" />
            {save.isPending ? t("save.saving") : t("save.button")}
          </Button>
        </div>
      </div>
    </div>
  );
}
