import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, ShieldCheck } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { ErrorState, Page, PageHeader, PanelSkeleton, SectionTabs, Segmented, StatGridSkeleton } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useArchivedViolations, useDiscipline, useInvalidateRules, useMistakes, useRuleKinds, useRulesReport, useViolations } from "@/components/rules/api";
import { RulesOnboarding, RulesOverview } from "@/components/rules/RulesOverview";
import { RuleDetailSheet } from "@/components/rules/RuleDetailSheet";
import { RuleDialog } from "@/components/rules/RuleDialog";
import { MistakesTab } from "@/components/rules/MistakesTab";
import { MistakeDialog } from "@/components/rules/MistakeDialog";
import { ViolationsList } from "@/components/rules/ViolationsList";
import { LS_KEYS, PERIODS, type PeriodValue, lsGet, lsSet } from "@/components/rules/constants";
import type { RuleDraft } from "@/components/rules/templates";
import type { Mistake, MistakePrefill, Rule, RuleReport } from "@/components/rules/types";
import { PersonSelect } from "@/components/people/person-select";
import { rulesI18n } from "@/i18n/ns/rules";
import { shellI18n } from "@/i18n/ns/shell";
import { personName } from "@/i18n";

type Tab = "overview" | "mistakes" | "violations";
const TABS: Tab[] = ["overview", "mistakes", "violations"];
const EMPTY: never[] = [];

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || !!el.closest("[role=dialog],[role=alertdialog],[role=listbox],[role=menu]");
}

function urlParam(key: string): string | null {
  try { return new URLSearchParams(window.location.search).get(key) || null; } catch { return null; }
}

/** RuleReport → the Rule shape used by the list / mistake dialog. */
function asRule(r: RuleReport): Rule {
  return { id: r.id, trader: r.trader, name: r.name, kind: r.kind, threshold: r.threshold, enabled: r.enabled, createdAt: "", origin: r.origin, desk: r.desk, note: r.note, auto: r.auto, kindLabel: r.kindLabel, summary: r.summary };
}

export default function RulesTracker() {
  const { t } = rulesI18n.useT();
  const { user, dbUsers } = useAuth();
  const { toast } = useToast();
  const isStaff = user?.role === "curator" || user?.role === "admin";
  const self = user?.role !== "guest" ? (user?.traderName ?? "") : "";

  // Traders work on their own data (the API enforces it). Staff pick: themselves (curators trade too) + active traders.
  const traderOptions = useMemo(() => {
    const names = dbUsers.filter((u) => u.role === "trader" && u.active !== false).map((u) => u.name);
    return self && !names.includes(self) ? [self, ...names] : names;
  }, [dbUsers, self]);
  // ?tab= / ?trader= (notification links) win over the remembered choice.
  const [pickedTrader, setPickedTrader] = useState<string>(() => urlParam("trader") ?? lsGet(LS_KEYS.trader) ?? "");
  const traderName = !isStaff ? self : traderOptions.includes(pickedTrader) ? pickedTrader : traderOptions[0] ?? "";

  const [tab, setTabState] = useState<Tab>(() => {
    const t = (urlParam("tab") ?? lsGet(LS_KEYS.tab)) as Tab | null;
    return t && TABS.includes(t) ? t : "overview";
  });
  const setTab = useCallback((t: Tab) => { setTabState(t); lsSet(LS_KEYS.tab, t); }, []);
  const [period, setPeriodState] = useState<PeriodValue>(() => {
    const p = lsGet(LS_KEYS.period);
    return (PERIODS.find((x) => x.value === p)?.value ?? "90") as PeriodValue;
  });
  const setPeriod = (p: PeriodValue) => { setPeriodState(p); lsSet(LS_KEYS.period, p); };
  const days = Number(period);

  const kindsQ = useRuleKinds();
  const reportQ = useRulesReport(traderName, days);
  const violationsQ = useViolations(traderName);
  // «Показать архив»: violations of disabled / deleted rules and stale ones with comments (kept, not counted).
  const [showArchive, setShowArchiveState] = useState<boolean>(() => lsGet(LS_KEYS.showArchive) === "1");
  const setShowArchive = (v: boolean) => { setShowArchiveState(v); lsSet(LS_KEYS.showArchive, v ? "1" : "0"); };
  const archivedQ = useArchivedViolations(traderName, showArchive && tab === "violations");
  const mistakesQ = useMistakes(traderName);
  const tradesQ = useDiscipline(traderName, 30); // recent trades for the mistake dialog picker
  const invalidate = useInvalidateRules();

  const report = reportQ.data;
  const kinds = kindsQ.data ?? EMPTY;
  const ruleReports = report?.rules ?? EMPTY;
  const rules = useMemo(() => ruleReports.map(asRule), [ruleReports]);
  const violations = violationsQ.data ?? EMPTY;
  const archivedViolations = archivedQ.data ?? EMPTY;
  const mistakes = mistakesQ.data ?? EMPTY;
  const canMark = user?.role !== "guest" && (traderName === self || isStaff);
  const canManageTeam = !!report?.canManageTeam && traderName !== self;
  const canManageDesk = !!report?.canManageDesk;

  // ─── Dialogs / sheet ───────────────────────────────────────────────────────
  const [mistakeOpen, setMistakeOpen] = useState(false);
  const [mistakeEditing, setMistakeEditing] = useState<Mistake | null>(null);
  const [mistakePrefill, setMistakePrefill] = useState<MistakePrefill | null>(null);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [ruleEditing, setRuleEditing] = useState<RuleReport | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const detail = detailId != null ? ruleReports.find((r) => r.id === detailId) ?? null : null;
  const searchRef = useRef<HTMLInputElement>(null);

  const openMistake = useCallback((prefill?: MistakePrefill) => {
    if (!traderName) return;
    setMistakeEditing(null);
    setMistakePrefill(prefill ?? null);
    setMistakeOpen(true);
  }, [traderName]);
  const editMistake = (m: Mistake) => { setMistakeEditing(m); setMistakePrefill(null); setMistakeOpen(true); };

  const openRule = (draft?: RuleDraft) => {
    if (!kinds.length) {
      toast({ title: t("page.kindsLoading"), description: t("page.kindsLoadingHint"), variant: "destructive" });
      kindsQ.refetch();
      return;
    }
    setRuleEditing(null);
    setRuleDraft(draft ?? null);
    setRuleOpen(true);
  };
  const editRule = (r: RuleReport) => { setDetailOpen(false); setRuleEditing(r); setRuleDraft(null); setRuleOpen(true); };
  const openDetail = (r: RuleReport) => { setDetailId(r.id); setDetailOpen(true); };

  // The server re-scans persisted violations in the background after a rule change: refresh now and once more shortly after.
  const refreshTimer = useRef<number | null>(null);
  const refreshAfterRuleChange = useCallback(() => {
    invalidate();
    if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => { refreshTimer.current = null; invalidate(); }, 1500);
  }, [invalidate]);
  useEffect(() => () => { if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current); }, []);

  // ─── Keyboard: N — record a mistake, R — new rule, / — search the log ─────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (mistakeOpen || ruleOpen || detailOpen) return;
      // «т» / «Т» — the same physical key as N on a Russian keyboard layout (input, not display).
      if (e.key === "n" || e.key === "N" || e.key === "т" || e.key === "Т") { // i18n-ignore
        e.preventDefault();
        openMistake();
      } else if (e.key === "/") {
        e.preventDefault();
        setTab("mistakes");
        window.setTimeout(() => searchRef.current?.focus(), 30);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mistakeOpen, ruleOpen, detailOpen, openMistake, setTab]);

  const openViolations = violations.filter((v) => v.status === "open").length;
  const hasRules = ruleReports.length > 0;

  return (
    <Page>
      <PageHeader
        title={shellI18n.t("nav.rules")}
        description={isStaff && traderName && traderName !== self
          ? t("page.descTrader", { name: personName(traderName) })
          : t("page.descSelf")}
        icon={ShieldCheck}
        actions={
          <>
            {isStaff && traderOptions.length > 1 && (
              <PersonSelect
                value={traderName}
                onValueChange={(v) => { setPickedTrader(v); lsSet(LS_KEYS.trader, v); }}
                options={traderOptions}
                self={self}
                selfSuffix={t("page.selfSuffix")}
                ariaLabel={t("page.traderAria")}
                className="w-full sm:w-[180px]"
              />
            )}
            <Segmented<PeriodValue> ariaLabel={t("page.periodAria")} value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p.value, label: p.label }))} />
            {user?.role !== "guest" && !(tab === "overview" && report && !hasRules) && (
              <Button onClick={() => openRule()} disabled={!traderName}><Plus /> {t("page.addRule")}</Button>
            )}
          </>
        }
      >
        {traderName && (
          <SectionTabs<Tab>
            ariaLabel={t("page.sectionAria")}
            value={tab}
            onChange={setTab}
            tabs={[
              { value: "overview", label: t("page.tabs.overview") },
              { value: "mistakes", label: t("page.tabs.mistakes"), count: mistakes.filter((m) => m.resolved !== "yes").length || undefined },
              { value: "violations", label: t("page.tabs.violations"), count: openViolations || undefined },
            ]}
          />
        )}
      </PageHeader>

      {!traderName ? (
        <ErrorState title={isStaff ? t("page.noTraders") : t("page.noTrader")} message={isStaff ? undefined : t("page.signInAgain")} />
      ) : reportQ.error && !report ? (
        <ErrorState error={reportQ.error} onRetry={() => reportQ.refetch()} />
      ) : !report ? (
        <div className="flex flex-col gap-[var(--grid-gap)]" aria-busy="true">
          <StatGridSkeleton count={4} min="13rem" />
          <PanelSkeleton height={360} />
        </div>
      ) : tab === "overview" ? (
        hasRules
          ? <RulesOverview report={report} trader={traderName} canMark={canMark} onOpenRule={openDetail} onAddRule={() => openRule()} onLogMistake={openMistake} />
          : <RulesOnboarding report={report} trader={traderName} days={days} onUseTemplate={(d) => openRule(d)} onCustom={() => openRule()} />
      ) : tab === "mistakes" ? (
        <MistakesTab
          ref={searchRef}
          trader={traderName}
          days={days}
          report={report}
          mistakes={mistakes}
          onNewMistake={() => openMistake()}
          onEditMistake={editMistake}
          onCreateRule={(d) => openRule(d)}
          onChanged={invalidate}
        />
      ) : violationsQ.isLoading ? (
        <PanelSkeleton height={320} />
      ) : (
        <ViolationsList
          violations={violations}
          archived={archivedViolations}
          showArchive={showArchive}
          archiveLoading={showArchive && archivedQ.isLoading}
          onToggleArchive={setShowArchive}
          hasRules={hasRules}
          trader={traderName}
          viewerName={user?.role === "guest" ? null : (user?.traderName ?? null)}
          isStaff={isStaff}
          onLogMistake={openMistake}
          onOpenRules={() => setTab("overview")}
          onChanged={invalidate}
        />
      )}

      <RuleDetailSheet
        rule={detail}
        open={detailOpen && !!detail}
        onOpenChange={setDetailOpen}
        trader={traderName}
        canMark={canMark}
        onEdit={editRule}
        onChanged={refreshAfterRuleChange}
      />
      <MistakeDialog
        open={mistakeOpen}
        onOpenChange={setMistakeOpen}
        trader={traderName}
        editing={mistakeEditing}
        prefill={mistakePrefill}
        rules={rules}
        trades={tradesQ.data?.trades ?? EMPTY}
        onSaved={invalidate}
      />
      <RuleDialog
        open={ruleOpen}
        onOpenChange={setRuleOpen}
        trader={traderName}
        kinds={kinds}
        editing={ruleEditing}
        draft={ruleDraft}
        days={days}
        canManageTeam={canManageTeam}
        canManageDesk={canManageDesk}
        onSaved={refreshAfterRuleChange}
      />
    </Page>
  );
}
