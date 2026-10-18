/**
 * Интеграции: PropReports ↔ журнал сделок. Только для куратора/админа — единое место для операций PropReports
 * (синк по API, импорт файлов, привязка счетов, сверка, история). Трейдерам сделки приходят автоматически,
 * поэтому для них страница показывает пояснение. Пульт деска (/admin → «Данные») показывает только статус и ведёт сюда.
 * Глубокие ссылки: /integrations?tab=setup|import|performance|accounts|reconcile|history.
 */
import * as React from "react";
import { useQueryClient, useIsFetching } from "@tanstack/react-query";
import { PlayCircle, Plug, RefreshCw, ShieldAlert } from "lucide-react";
import { EmptyState, Page, PageHeader, Panel, SectionTabs } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/auth-context";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api/http";
import { prKeys, useAccounts, usePending, useRuns, useStatus, type IntegrationsTab } from "@/components/propreports/api";
import { StatusHero } from "@/components/propreports/status-hero";
import { ImportZone } from "@/components/propreports/import-zone";
import { AccountsEditor } from "@/components/propreports/accounts-editor";
import { ReconcileInbox } from "@/components/propreports/reconcile-inbox";
import { SyncHistory } from "@/components/propreports/sync-history";
import { RunSyncDialog } from "@/components/propreports/run-sync-dialog";
import { PerformanceReportPanel } from "@/components/propreports/PerformanceReportPanel";
import { ReconcilePanel } from "@/components/propreports/ReconcilePanel";
import { SetupPanel } from "@/components/propreports/setup-panel";
import { propreportsI18n } from "@/i18n/ns/propreports";
import { shellI18n } from "@/i18n/ns/shell";
import { commonI18n } from "@/i18n/ns/common";

type Tab = IntegrationsTab;
const TABS: readonly Tab[] = ["setup", "import", "performance", "accounts", "reconcile", "history"];

function initialTab(): Tab {
  try {
    const t = new URLSearchParams(window.location.search).get("tab") as Tab | null;
    if (t && TABS.includes(t)) return t;
  } catch { /* ignore */ }
  return "import";
}

export default function IntegrationsPage() {
  const { user, isCurator } = useAuth();
  const { t } = propreportsI18n.useT();
  const signedIn = !!user && user.role !== "guest";
  if (signedIn && !isCurator) {
    return (
      <Page>
        <PageHeader title={shellI18n.t("nav.integrations")} description={t("page.descriptionTrader")} icon={Plug} />
        <Panel>
          <EmptyState
            icon={ShieldAlert}
            title={t("page.traderTitle")}
            description={t("page.traderText")}
          />
        </Panel>
      </Page>
    );
  }
  return <IntegrationsConsole signedIn={signedIn} />;
}

function IntegrationsConsole({ signedIn }: { signedIn: boolean }) {
  const { t } = propreportsI18n.useT();
  const qc = useQueryClient();
  const status = useStatus();
  const accounts = useAccounts();
  const pending = usePending();
  const runs = useRuns(50);
  const fetching = useIsFetching({ queryKey: prKeys.all }) > 0;
  const [tab, setTabState] = React.useState<Tab>(initialTab);
  const setTab = React.useCallback((t: Tab) => {
    setTabState(t);
    try {
      const url = new URL(window.location.href);
      if (t === "import") url.searchParams.delete("tab"); else url.searchParams.set("tab", t);
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    } catch { /* ignore */ }
  }, []);
  const wizardTodo = status.data ? Object.values(status.data.wizard).filter((w) => !w.ok).length : 0;
  const [runOpen, setRunOpen] = React.useState(false);
  const staff = status.data?.viewer.staff ?? false;

  if (!signedIn) {
    return (
      <Page>
        <PageHeader title={shellI18n.t("nav.integrations")} description={t("page.descriptionGuest")} icon={Plug} />
        <Panel><EmptyState icon={Plug} title={t("page.signInTitle")} description={t("page.signInText")} /></Panel>
      </Page>
    );
  }

  const err = status.error instanceof ApiError ? status.error : null;

  return (
    <Page>
      <PageHeader
        title={shellI18n.t("nav.integrations")}
        description={t("page.description")}
        icon={Plug}
        actions={
          <>
            <Button variant="outline" size="icon" onClick={() => qc.invalidateQueries({ queryKey: prKeys.all })} aria-label={commonI18n.t("actions.refresh")} disabled={fetching}>
              <RefreshCw className={cn("h-4 w-4", fetching && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
            </Button>
            {staff && (
              <Button onClick={() => setRunOpen(true)} disabled={!status.data}>
                <PlayCircle className="mr-2 h-4 w-4" aria-hidden="true" />{t("page.syncNow")}
              </Button>
            )}
          </>
        }
      />

      {status.isLoading ? (
        <Skeleton className="h-48 w-full rounded-2xl" />
      ) : err ? (
        <Panel><EmptyState icon={Plug} title={err.status === 401 ? t("page.sessionExpired") : t("page.statusFailed")} description={err.message} /></Panel>
      ) : status.data ? (
        <StatusHero status={status.data} />
      ) : null}

      <SectionTabs
        ariaLabel={t("page.tabsAria")}
        value={tab}
        onChange={setTab}
        tabs={[
          ...(staff ? [{ value: "setup" as const, label: t("page.tabs.setup"), count: wizardTodo || undefined }] : []),
          { value: "import", label: t("page.tabs.import") },
          { value: "performance", label: t("page.tabs.performance") },
          { value: "accounts", label: t("page.tabs.accounts"), count: status.data?.accounts.unmapped.length || undefined },
          { value: "reconcile", label: t("page.tabs.reconcile"), count: pending.data?.length || undefined },
          { value: "history", label: t("page.tabs.history"), count: runs.data?.length || undefined },
        ]}
      />

      {tab === "setup" && staff && status.data && <SetupPanel status={status.data} accounts={accounts.data ?? []} onGoTab={setTab} />}
      {tab === "import" && <ImportZone accounts={accounts.data ?? []} staff={staff} viewerName={status.data?.viewer.name} onGoTab={setTab} />}
      {tab === "performance" && (
        <div className="space-y-4">
          <PerformanceReportPanel staff={staff} trader={staff ? undefined : status.data?.viewer.name} />
          <ReconcilePanel trader={staff ? undefined : status.data?.viewer.name} />
        </div>
      )}
      {tab === "accounts" && <AccountsEditor accounts={accounts.data ?? []} staff={staff} apiConfigured={status.data?.config.configured ?? false} />}
      {tab === "reconcile" && <ReconcileInbox pending={pending.data ?? []} staff={staff} loading={pending.isLoading} />}
      {tab === "history" && <SyncHistory runs={runs.data ?? []} loading={runs.isLoading} />}

      {staff && <RunSyncDialog open={runOpen} onOpenChange={setRunOpen} configured={status.data?.config.configured ?? false} onGoTab={(x) => { setRunOpen(false); setTab(x); }} />}
    </Page>
  );
}
