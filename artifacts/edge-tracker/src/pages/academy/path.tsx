/**
 * «Путь трейдера»: ladder Стажёр → Джун → Трейдер → Сеньор with objective, staff-configurable promotion criteria.
 * Trader: own readiness report («Готов к переводу: X из Y»), advice per criterion, promotion request, history.
 * Mentor (curator/admin): funnel by stage, any trader's report, request queue with approve/reject, criteria editor.
 */
import * as React from "react";
import { useSearch } from "wouter";
import { RefreshCw, Route as RouteIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Page, PageHeader, Segmented } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/auth-context";
import { academyPathI18n } from "@/i18n/ns/academyPath";
import { shellI18n } from "@/i18n/ns/shell";
import { comparePersonNames, personName } from "@/i18n";
import { pathKeys, usePathConfig, useRequests } from "@/components/academy/path/api";
import { ladderText } from "@/components/academy/path/labels";
import { PersonView } from "@/components/academy/path/person-view";
import { CriteriaEditor, FunnelView, RequestsView } from "@/components/academy/path/staff-views";
import { PersonSelect } from "@/components/people/person-select";

type View = "person" | "funnel" | "requests" | "criteria";

export default function AcademyPathPage() {
  const { t } = academyPathI18n.useT();
  const { user, isCurator, dbUsers } = useAuth();
  const me = user && user.role !== "guest" ? user.traderName : null;
  const search = useSearch();
  const qc = useQueryClient();
  const initialUser = React.useMemo(() => new URLSearchParams(search).get("user"), [search]);
  const [target, setTarget] = React.useState<string | null>(initialUser);
  const [view, setView] = React.useState<View>(isCurator && !initialUser ? "funnel" : "person");
  React.useEffect(() => { if (initialUser) { setTarget(initialUser); setView("person"); } }, [initialUser]);

  const config = usePathConfig();
  const pending = useRequests("pending", isCurator);
  const people = React.useMemo(() => {
    const names = dbUsers.filter((u) => u.active && !u.banned && u.role !== "guest").map((u) => u.name).sort(comparePersonNames);
    return (me ? [me, ...names.filter((n) => n !== me)] : names).map((n) => ({ value: n, label: personName(n) }));
  }, [dbUsers, me]);
  const open = (u: string) => { setTarget(u); setView("person"); };

  return (
    <Page>
      <PageHeader
        title={shellI18n.t("nav.academyPath")}
        icon={RouteIcon}
        description={t("page.pathDescription", { ladder: ladderText() })}
        actions={
          <Button variant="ghost" size="sm" onClick={() => void qc.invalidateQueries({ queryKey: pathKeys.all })} aria-label={t("page.refreshData")} title={t("page.refreshData")}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          </Button>
        }
      >
        {isCurator && (
          <div className="flex flex-wrap items-center gap-2">
            <Segmented<View>
              ariaLabel={t("page.sectionAria")}
              value={view}
              onChange={setView}
              options={[
                { value: "funnel", label: t("page.views.funnel") },
                { value: "person", label: t("page.views.person") },
                { value: "requests", label: t("page.views.requests"), count: pending.data?.requests.length || undefined },
                { value: "criteria", label: t("page.views.criteria") },
              ]}
            />
            {view === "person" && (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>{t("page.student")}</span>
                <PersonSelect value={target ?? me ?? ""} onValueChange={(v) => setTarget(v || null)} options={people} self={me}
                  placeholder={t("page.student")} ariaLabel={t("page.student")} className="h-9 w-56" />
              </label>
            )}
          </div>
        )}
      </PageHeader>

      {view === "person" && <PersonView user={isCurator ? target ?? me : null} config={config.data} isStaff={isCurator} me={me} />}
      {view === "funnel" && isCurator && <FunnelView onOpen={open} />}
      {view === "requests" && isCurator && <RequestsView config={config.data} me={me} onOpen={open} />}
      {view === "criteria" && isCurator && config.data && <CriteriaEditor config={config.data} />}
    </Page>
  );
}
