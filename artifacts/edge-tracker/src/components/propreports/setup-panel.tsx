/**
 * «Мастер настройки» for the PropReports integration (curators only):
 *   env set → connection checked → accounts matched → fees confirmed → first sync.
 * Plus the three self-configuration blocks: group picker, fee columns, unmatched accounts.
 * Nothing here asks for or shows secrets — env var NAMES only; the connection check is a read-only
 * `version` call on the server.
 */
import * as React from "react";
import { AlertCircle, ArrowRight, CheckCircle2, Circle, Coins, Layers, Loader2, PlugZap, RefreshCw, Save, UserX, Wand2 } from "lucide-react";
import { DataTable, EmptyState, Kbd, Panel, Pill } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  agoText, useCheckConnection, useGroups, useSaveAccounts, useSaveSettings, useUsers,
  type AccountMapping, type FeeColumnView, type IntegrationsTab, type Status, type WizardStep,
} from "./api";
import { PersonSelect } from "@/components/people/person-select";
import { propreportsI18n } from "@/i18n/ns/propreports";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

/* ── wizard ───────────────────────────────────────────────────────────────── */

const STEPS: ReadonlyArray<{ key: keyof Status["wizard"] }> = [{ key: "env" }, { key: "connection" }, { key: "accounts" }, { key: "fees" }, { key: "firstSync" }];

function StepIcon({ step }: { step: WizardStep }) {
  if (step.ok) return <CheckCircle2 className="h-5 w-5 text-up" aria-hidden="true" />;
  return <Circle className="h-5 w-5 text-muted-foreground" aria-hidden="true" />;
}

/** Where a not-done wizard step is fixed (connectedness: the step links to its place). */
const STEP_TAB: Partial<Record<keyof Status["wizard"], IntegrationsTab>> = { accounts: "accounts", firstSync: "import" };

export function SetupWizard({ status, onGoTab }: { status: Status; onGoTab?: (tab: IntegrationsTab) => void }) {
  const { toast } = useToast();
  const { t } = propreportsI18n.useT();
  const modeLabel = (mode: string | null) => (mode === "v2" ? t("hero.modeV2") : t("hero.modeLegacy"));
  const check = useCheckConnection();
  const done = STEPS.filter((s) => status.wizard[s.key].ok).length;
  const onCheck = async () => {
    try {
      const r = await check.mutateAsync();
      toast({
        title: r.ok ? t("setup.connOk", { mode: modeLabel(r.mode) }) : t("setup.connFailed"),
        description: r.ok ? `${r.host}${r.version ? ` · ${t("setup.version", { version: r.version })}` : ""}` : r.error ?? undefined,
        variant: r.ok ? undefined : "destructive",
      });
    } catch (e) {
      toast({ title: t("setup.checkFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    }
  };
  return (
    <Panel title={t("setup.wizardTitle")} description={t("setup.wizardDone", { done, total: STEPS.length })} icon={Wand2}
      actions={<Pill tone={done === STEPS.length ? "up" : "warn"} dot>{done === STEPS.length ? t("setup.ready") : t("setup.notFinished")}</Pill>}>
      <ol className="grid gap-2">
        {STEPS.map((s, i) => {
          const step = status.wizard[s.key];
          return (
            <li key={s.key} className={cn("flex items-start gap-3 rounded-xl border p-3", step.ok ? "border-[var(--glass-border)]" : "border-dashed border-[hsl(var(--chart-3)/0.5)]")}>
              <StepIcon step={step} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span className="text-muted-foreground">{i + 1}.</span> {t(`setup.steps.${s.key}.title`)}
                  {!step.ok && s.key === "connection" && status.connection.ok === false && <AlertCircle className="h-4 w-4 text-down" aria-hidden="true" />}
                </div>
                <div className={cn("text-xs", step.ok ? "text-muted-foreground" : "text-foreground")}>{step.detail}</div>
                {!step.ok && <div className="mt-0.5 text-xs text-muted-foreground">{t(`setup.steps.${s.key}.hint`)}</div>}
                {s.key === "env" && !step.ok && (
                  <div className="mt-1 flex flex-wrap gap-1 font-mono text-[11px]">
                    {status.config.envVars.map((v) => <Kbd key={v}>{v}</Kbd>)}
                  </div>
                )}
              </div>
              {!step.ok && onGoTab && STEP_TAB[s.key] && (
                <Button size="sm" variant="outline" onClick={() => onGoTab(STEP_TAB[s.key]!)}>
                  {t(s.key === "accounts" ? "setup.go.accounts" : "setup.go.import")}<ArrowRight className="ml-1.5 h-4 w-4" aria-hidden="true" />
                </Button>
              )}
              {s.key === "connection" && status.config.configured && (
                <Button size="sm" variant={step.ok ? "outline" : "default"} onClick={onCheck} disabled={check.isPending}>
                  {check.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <PlugZap className="mr-1.5 h-4 w-4" />}{t("setup.check")}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
      {status.connection.checkedAt && (
        <p className="mt-2 text-xs text-muted-foreground">
          {status.connection.ok
            ? `${t("setup.lastCheckOk", { ago: agoText(status.connection.checkedAt), mode: modeLabel(status.connection.mode) })}${status.connection.version ? ` · ${t("setup.version", { version: status.connection.version })}` : ""}`
            : t("setup.lastCheckError", { ago: agoText(status.connection.checkedAt), error: status.connection.error ?? commonI18n.t("states.unknown").toLowerCase() })}
        </p>
      )}
    </Panel>
  );
}

/* ── group picker ─────────────────────────────────────────────────────────── */

const MY_ACCOUNTS = "-4";

export function GroupPicker({ status }: { status: Status }) {
  const { toast } = useToast();
  const { t } = propreportsI18n.useT();
  const [wanted, setWanted] = React.useState(false);
  const groups = useGroups(wanted && status.config.configured);
  const save = useSaveSettings();
  const [choice, setChoice] = React.useState<string>(status.settings.groupId ?? MY_ACCOUNTS);
  React.useEffect(() => { setChoice(status.settings.groupId ?? MY_ACCOUNTS); }, [status.settings.groupId]);
  if (!status.config.configured) return null;
  const envWins = status.settings.groupSource === "env";
  const list = groups.data?.groups ?? [];
  const onSave = async () => {
    try {
      await save.mutateAsync({ groupId: choice === MY_ACCOUNTS ? null : choice });
      toast({ title: t("setup.group.saved"), description: choice === MY_ACCOUNTS ? t("setup.group.savedDefault") : `groupId ${choice}` });
    } catch (e) {
      toast({ title: commonI18n.t("states.saveFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    }
  };
  return (
    <Panel title={t("setup.group.title")} description={t("setup.group.description")} icon={Layers}
      actions={<Pill tone="neutral">{t(envWins ? "setup.group.currentEnv" : status.settings.groupSource === "settings" ? "setup.group.currentSettings" : "setup.group.currentDefault", { id: status.settings.effectiveGroupId })}</Pill>}>
      {envWins ? (
        <p className="text-sm text-muted-foreground">{t("setup.group.envWinsBefore")} <Kbd>PROPREPORTS_GROUP_ID</Kbd> {t("setup.group.envWinsAfter")}</p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <Button variant="outline" size="sm" onClick={() => { setWanted(true); if (wanted) groups.refetch(); }} disabled={groups.isFetching}>
            {groups.isFetching ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}{t("setup.group.load")}
          </Button>
          <Select value={choice} onValueChange={setChoice}>
            <SelectTrigger className="h-9 w-72 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={MY_ACCOUNTS}>{t("setup.group.myAccounts")}</SelectItem>
              {list.map((g) => (
                <SelectItem key={`${g.groupId ?? "name"}:${g.name}`} value={g.groupId ?? `name:${g.name}`} disabled={!g.groupId}>
                  {g.groupId ? `${g.name} (${g.groupId})` : t("setup.group.noId", { name: g.name })}
                </SelectItem>
              ))}
              {status.settings.groupId && !list.some((g) => g.groupId === status.settings.groupId) && <SelectItem value={status.settings.groupId}>groupId {status.settings.groupId}</SelectItem>}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={onSave} disabled={save.isPending || choice === (status.settings.groupId ?? MY_ACCOUNTS)}>
            {save.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}{commonI18n.t("actions.save")}
          </Button>
          {groups.error ? <span className="text-xs text-down">{groups.error instanceof Error ? groups.error.message : t("setup.group.loadError")}</span> : null}
          {groups.data?.source === "accounts" && <span className="text-xs text-muted-foreground">{t("setup.group.fromAccounts")}</span>}
        </div>
      )}
    </Panel>
  );
}

/* ── fee columns ──────────────────────────────────────────────────────────── */

type FeeRow = FeeColumnView & { dirty?: boolean };

export function FeeSettings({ status }: { status: Status }) {
  const { toast } = useToast();
  const { t } = propreportsI18n.useT();
  const save = useSaveSettings();
  const [rows, setRows] = React.useState<FeeRow[]>(status.settings.feeColumns);
  const [dirty, setDirty] = React.useState(false);
  React.useEffect(() => { if (!dirty) setRows(status.settings.feeColumns); }, [status.settings.feeColumns, dirty]);
  const update = (key: string, patch: Partial<FeeRow>) => { setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch, dirty: true } : x))); setDirty(true); };
  const onSave = async (confirm: boolean) => {
    const columns: Record<string, { include: boolean; label?: string | null }> = {};
    for (const r of rows) if (r.dirty || confirm) columns[r.key] = { include: r.include, label: r.customLabel?.trim() || null };
    try {
      await save.mutateAsync({ fees: { columns, confirm } });
      setDirty(false);
      toast({ title: confirm ? t("setup.fees.confirmed") : t("setup.fees.saved"), description: t("setup.fees.appliesNext") });
    } catch (e) {
      toast({ title: commonI18n.t("states.saveFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    }
  };
  const included = rows.filter((r) => r.include).length;
  return (
    <Panel title={t("setup.fees.title")} description={t("setup.fees.description")} icon={Coins}
      actions={
        <>
          <Pill tone={status.settings.feesConfirmedAt ? "up" : "warn"} dot>{status.settings.feesConfirmedAt ? t("setup.fees.confirmedAgo", { ago: agoText(status.settings.feesConfirmedAt) }) : t("setup.fees.notConfirmed")}</Pill>
          <Button variant="outline" size="sm" onClick={() => onSave(false)} disabled={!dirty || save.isPending}>{commonI18n.t("actions.save")}</Button>
          <Button size="sm" onClick={() => onSave(true)} disabled={!rows.length || save.isPending}>
            {save.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-4 w-4" />}{t("setup.fees.confirm", { included, total: rows.length })}
          </Button>
        </>
      }
    >
      {!rows.length ? (
        <EmptyState icon={Coins} title={t("setup.fees.emptyTitle")} description={t("setup.fees.emptyHint")} />
      ) : (
        <DataTable ariaLabel={t("setup.fees.tableAria")}>
          <table>
            <thead>
              <tr><th>{t("setup.fees.col.include")}</th><th>{t("setup.fees.col.column")}</th><th>{t("setup.fees.col.label")}</th><th>{t("setup.fees.col.type")}</th><th>{t("setup.fees.col.seen")}</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={cn(!r.include && "opacity-60")}>
                  <td><Switch checked={r.include} onCheckedChange={(v) => update(r.key, { include: v })} aria-label={t("setup.fees.includeAria", { name: r.header ?? r.key })} /></td>
                  <td className="font-mono text-xs">{r.header ?? r.key}<span className="ml-1 text-muted-foreground">({r.key})</span></td>
                  <td><Input value={r.customLabel ?? ""} placeholder={r.label} onChange={(e) => update(r.key, { customLabel: e.target.value })} className="h-8 w-full min-w-[8rem] max-w-[12rem] text-xs" /></td>
                  <td>{r.known ? <Pill tone="accent">{t("setup.fees.known")}</Pill> : r.heuristic ? <Pill tone="warn">{t("setup.fees.heuristic")}</Pill> : <Pill tone="neutral">{t("setup.fees.byName")}</Pill>}</td>
                  <td className="whitespace-nowrap text-xs text-muted-foreground">{r.lastSeenAt ? agoText(r.lastSeenAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
      )}
    </Panel>
  );
}

/* ── unmatched accounts ───────────────────────────────────────────────────── */

const NONE = "__none";

export function UnmatchedAccounts({ status, accounts }: { status: Status; accounts: AccountMapping[] }) {
  const { toast } = useToast();
  const { t } = propreportsI18n.useT();
  const users = useUsers(true);
  const saveAccounts = useSaveAccounts();
  const saveSettings = useSaveSettings();
  const names = status.settings.unmatched;
  const traders = (users.data ?? []).filter((u) => u.active !== false && u.role !== "guest").map((u) => u.name);
  const [pick, setPick] = React.useState<Record<string, string>>({});
  const busy = saveAccounts.isPending || saveSettings.isPending;

  const asNew = async (name: string) => {
    const trader = pick[`t:${name}`];
    if (!trader) return;
    try { await saveAccounts.mutateAsync([{ account: name, trader, active: true, aliases: [] }]); toast({ title: t("setup.unmatched.mapped", { name, trader: personName(trader) }) }); }
    catch (e) { toast({ title: commonI18n.t("states.saveFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" }); }
  };
  const asAlias = async (name: string) => {
    const target = accounts.find((a) => a.account === pick[`a:${name}`]);
    if (!target) return;
    try {
      await saveAccounts.mutateAsync([{ account: target.account, trader: target.trader, active: target.active, notes: target.notes, aliases: [...new Set([...(target.aliases ?? []), name])] }]);
      toast({ title: t("setup.unmatched.aliased", { name, account: target.account }) });
    } catch (e) { toast({ title: commonI18n.t("states.saveFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" }); }
  };
  const dismiss = async (name: string) => {
    try { await saveSettings.mutateAsync({ unmatched: names.filter((n) => n !== name) }); }
    catch (e) { toast({ title: commonI18n.t("states.actionFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" }); }
  };

  return (
    <Panel title={t("setup.unmatched.title")} description={t("setup.unmatched.description")} icon={UserX}
      actions={names.length ? <Pill tone="warn" dot>{names.length}</Pill> : <Pill tone="up" dot>{t("setup.unmatched.allMatched")}</Pill>}>
      {!names.length ? (
        <p className="text-sm text-muted-foreground">{t("setup.unmatched.emptyText")}</p>
      ) : (
        <ul className="grid gap-2">
          {names.map((name) => (
            <li key={name} className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-[hsl(var(--chart-3)/0.5)] p-3 text-sm">
              <span className="font-mono">{name}</span>
              <span className="text-xs text-muted-foreground">{t("setup.unmatched.newFor")}</span>
              <PersonSelect
                value={pick[`t:${name}`] || NONE}
                onValueChange={(v) => setPick((p) => ({ ...p, [`t:${name}`]: v === NONE ? "" : v }))}
                allValue={NONE}
                allLabel={t("setup.unmatched.traderPick")}
                options={traders}
                ariaLabel={t("setup.unmatched.traderAria")}
                className="h-8 w-40 text-xs"
              />
              <Button size="sm" variant="outline" onClick={() => asNew(name)} disabled={busy || !pick[`t:${name}`]}>{t("setup.unmatched.map")}</Button>
              <span className="text-xs text-muted-foreground">{t("setup.unmatched.orAlias")}</span>
              <Select value={pick[`a:${name}`] ?? NONE} onValueChange={(v) => setPick((p) => ({ ...p, [`a:${name}`]: v === NONE ? "" : v }))}>
                <SelectTrigger className="h-8 w-48 text-xs"><SelectValue placeholder={t("setup.unmatched.account")} /></SelectTrigger>
                <SelectContent><SelectItem value={NONE}>{t("setup.unmatched.accountPick")}</SelectItem>{accounts.map((a) => <SelectItem key={a.id} value={a.account}>{a.account}{a.trader ? ` — ${personName(a.trader)}` : ""}</SelectItem>)}</SelectContent>
              </Select>
              <Button size="sm" variant="outline" onClick={() => asAlias(name)} disabled={busy || !pick[`a:${name}`]}>{t("setup.unmatched.addAlias")}</Button>
              <Button size="sm" variant="ghost" onClick={() => dismiss(name)} disabled={busy}>{commonI18n.t("actions.hide")}</Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ── composite ────────────────────────────────────────────────────────────── */

export function SetupPanel({ status, accounts, onGoTab }: { status: Status; accounts: AccountMapping[]; onGoTab?: (tab: IntegrationsTab) => void }) {
  return (
    <div className="grid gap-[var(--grid-gap)]">
      <SetupWizard status={status} onGoTab={onGoTab} />
      <GroupPicker status={status} />
      {/* The fee table needs the width; the unmatched list is usually one line («всё сопоставлено») — don't stretch it. */}
      <div className="grid items-start gap-[var(--grid-gap)] xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <FeeSettings status={status} />
        <UnmatchedAccounts status={status} accounts={accounts} />
      </div>
    </div>
  );
}
