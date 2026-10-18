import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/auth-context";
import { http } from "@/lib/api/http";
import { HeartPulse, ChevronDown, ArrowRight, BellOff, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { FilterChip, Pill, type Tone } from "@/components/ds";
import { Ring, lsGet, lsSet } from "@/components/playbook-sub/bits";
import { playbookToolsI18n } from "@/i18n/ns/playbookTools";

type HealthRow = {
  id: number; name: string; folder: string | null; confidenceLevel: number | null;
  parentId: number | null; tradeCount: number; wins: number;
  lastTradeAt: string | null; days?: number | null; winrate?: number;
};

type HealthResponse = {
  trader: string | null;
  /** Desk win rate W / (W + L); null until the desk has decided trades. */
  globalWinrate: number | null;
  staleAfterDays?: number;
  untestedGraceDays?: number;
  stale: HealthRow[];
  /** Never traded, older than the grace period, checklist not run recently. */
  untested: (HealthRow & { ageDays?: number })[];
  lowSampleHighConf: HealthRow[];
  underperforming: HealthRow[];
  /* new API (playbook_examples): */
  noExamples?: (HealthRow & { exampleCount?: number })[];
  noTier1?: (HealthRow & { exampleCount?: number })[];
  idle?: HealthRow[];
  idleAfterDays?: number;
};

/** Minimal shape of /api/playbook entries (same query key as the page → shared cache). */
type EntryLite = {
  id: number; name: string; folder: string | null; trader?: string | null; parentId?: number | null;
  checklist?: string | null; checklistItems?: unknown[] | null;
  screenshots?: unknown[] | null; screenshotUrl?: string | null;
  conditions?: string | null;
  /* structured card (current API): any filled field counts as entry rules */
  contextText?: string | null; triggerText?: string | null; entryText?: string | null; stopText?: string | null;
  targetsText?: string | null; managementText?: string | null; invalidationText?: string | null; idealConditions?: string | null;
};
const STRUCTURED_RULE_KEYS = ["contextText", "triggerText", "entryText", "stopText", "targetsText", "managementText", "invalidationText", "idealConditions"] as const;
const hasRules = (e: EntryLite) => !!e.conditions?.trim() || STRUCTURED_RULE_KEYS.some((k) => !!e[k]?.trim());

type IssueKey = "under" | "overconf" | "noChecklist" | "noRules" | "noExamples" | "noTier1" | "idle" | "stale" | "noTrades";

/** Issue weights / tones; label and action are getters (current UI language). */
const issue = (key: IssueKey, tone: Tone, weight: number) => ({
  tone, weight,
  get label() { return playbookToolsI18n.t(`health.issue.${key}.label`); },
  get action() { return playbookToolsI18n.t(`health.issue.${key}.action`); },
});
const ISSUES: Record<IssueKey, { readonly label: string; readonly action: string; tone: Tone; weight: number }> = {
  under: issue("under", "down", 50),
  overconf: issue("overconf", "warn", 30),
  noRules: issue("noRules", "warn", 25),
  noChecklist: issue("noChecklist", "warn", 20),
  noExamples: issue("noExamples", "neutral", 10),
  noTier1: issue("noTier1", "neutral", 8),
  idle: issue("idle", "neutral", 7),
  stale: issue("stale", "neutral", 6),
  noTrades: issue("noTrades", "neutral", 4),
};
const ORDER: IssueKey[] = ["under", "overconf", "noRules", "noChecklist", "noExamples", "noTier1", "idle", "stale", "noTrades"];

type Task = {
  id: number; name: string; folder: string | null;
  issues: { key: IssueKey; detail?: string }[];
  score: number;
};

const SNOOZE_KEY = "pb-health-snooze";
const SNOOZE_DAYS = 14;
const PAGE = 6;

export function PlaybookHealthWidget({ onJump, defaultOpen }: { onJump?: (id: number) => void; defaultOpen?: boolean }) {
  const { t } = playbookToolsI18n.useT();
  const { user } = useAuth();
  // The API scopes trades by the session (traders see only their own); the key just separates caches per viewer.
  const userKey = user?.role === "trader" && user.traderName ? user.traderName : null;
  const [open, setOpen] = useState<boolean>(() => defaultOpen ?? lsGet("pb-health-open", false));
  const [filter, setFilter] = useState<IssueKey | "all">("all");
  const [limit, setLimit] = useState(PAGE);
  const [snoozed, setSnoozed] = useState<Record<string, number>>(() => lsGet(SNOOZE_KEY, {}));

  const { data } = useQuery<HealthResponse>({
    queryKey: ["playbook-health", userKey],
    queryFn: ({ signal }) => http.get<HealthResponse>("/api/playbook/health", { signal }),
  });

  const { data: entries } = useQuery<EntryLite[]>({
    queryKey: ["playbook"],
    queryFn: ({ signal }) => http.get<EntryLite[]>("/api/playbook", { signal }),
  });

  const valid = !!data && Array.isArray(data.stale) && Array.isArray(data.lowSampleHighConf) && Array.isArray(data.underperforming);

  const { tasks, totalSetups } = useMemo(() => {
    const map = new Map<number, Task>();
    const add = (id: number, name: string, folder: string | null, key: IssueKey, detail?: string) => {
      let task = map.get(id);
      if (!task) { task = { id, name, folder, issues: [], score: 0 }; map.set(id, task); }
      if (task.issues.some((i) => i.key === key)) return;
      task.issues.push({ key, detail });
      task.score += ISSUES[key].weight;
    };
    if (valid && data) {
      for (const r of data.underperforming) add(r.id, r.name, r.folder, "under", `${Math.round((r.winrate ?? 0) * 100)}% vs ${Math.round((data.globalWinrate ?? 0) * 100)}% · n=${r.tradeCount}`);
      for (const r of data.lowSampleHighConf) add(r.id, r.name, r.folder, "overconf", t("health.overconfDetail", { conf: r.confidenceLevel ?? 0, count: r.tradeCount }));
      for (const r of data.stale) {
        if (r.tradeCount === 0) add(r.id, r.name, r.folder, "noTrades");
        else add(r.id, r.name, r.folder, "stale", r.days != null ? t("health.days", { count: r.days }) : undefined);
      }
      for (const r of Array.isArray(data.untested) ? data.untested : []) add(r.id, r.name, r.folder, "noTrades", r.ageDays != null ? t("health.ageDays", { count: r.ageDays }) : undefined);
      for (const r of Array.isArray(data.noExamples) ? data.noExamples : []) add(r.id, r.name, r.folder, "noExamples");
      for (const r of Array.isArray(data.noTier1) ? data.noTier1 : []) add(r.id, r.name, r.folder, "noTier1", r.exampleCount ? t("health.examplesCount", { count: r.exampleCount }) : undefined);
      for (const r of Array.isArray(data.idle) ? data.idle : []) add(r.id, r.name, r.folder, "idle", r.days != null ? t("health.days", { count: r.days }) : undefined);
    }
    const serverExamples = valid && Array.isArray(data?.noExamples);
    const list = (Array.isArray(entries) ? entries : []).filter((e) => !userKey || !e.trader || e.trader === userKey);
    for (const e of list) {
      const hasChecklist = (Array.isArray(e.checklistItems) && e.checklistItems.length > 0) || !!e.checklist?.trim();
      const hasExamples = (Array.isArray(e.screenshots) && e.screenshots.length > 0) || !!e.screenshotUrl?.trim();
      // Children inherit checklist/conditions from parent — don't nag about them.
      if (!e.parentId) {
        if (!hasRules(e)) add(e.id, e.name, e.folder, "noRules");
        if (!hasChecklist) add(e.id, e.name, e.folder, "noChecklist");
      }
      // Older API: "examples" = screenshots on the setup.
      if (!serverExamples && !hasExamples) add(e.id, e.name, e.folder, "noExamples");
    }
    const now = Date.now();
    const all = [...map.values()]
      .filter((task) => !(snoozed[task.id] && snoozed[task.id] > now))
      .map((task) => ({ ...task, issues: task.issues.sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key)) }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ru"));
    return { tasks: all, totalSetups: list.length };
  }, [data, entries, valid, userKey, snoozed, t]);

  // Secondary widget: stay silent while loading / on error.
  if (!valid && !Array.isArray(entries)) return null;
  if (tasks.length === 0 && Object.keys(snoozed).length === 0) return null;

  const counts = ORDER.reduce((acc, k) => { acc[k] = tasks.filter((task) => task.issues.some((i) => i.key === k)).length; return acc; }, {} as Record<IssueKey, number>);
  const visible = filter === "all" ? tasks : tasks.filter((task) => task.issues.some((i) => i.key === filter));
  const critical = counts.under + counts.overconf;
  // "Needs attention" = has at least one important issue (weight ≥ 20); examples / no trades / stale are minor.
  const important = tasks.filter((task) => task.issues.some((i) => ISSUES[i.key].weight >= 20)).length;
  const minor = tasks.length - important;
  const healthy = totalSetups > 0 ? Math.max(0, totalSetups - important) : 0;
  const healthPct = totalSetups > 0 ? healthy / totalSetups : 0;
  const snoozedCount = Object.values(snoozed).filter((until) => until > Date.now()).length;

  function toggleOpen() {
    setOpen((v) => { lsSet("pb-health-open", !v); return !v; });
  }
  function snooze(id: number) {
    const next = { ...snoozed, [id]: Date.now() + SNOOZE_DAYS * 86400000 };
    setSnoozed(next);
    lsSet(SNOOZE_KEY, next);
  }
  function unsnoozeAll() {
    setSnoozed({});
    lsSet(SNOOZE_KEY, {});
  }

  return (
    <section className="glass-panel rounded-2xl" aria-label={t("health.aria")}>
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-5"
      >
        <Ring value={healthPct} size={36} stroke={4} tone={healthPct >= 0.7 ? "up" : healthPct >= 0.4 ? "warn" : "down"} label={t("health.ringLabel", { pct: Math.round(healthPct * 100) })}>
          <HeartPulse className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </Ring>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">{t("health.title")}</div>
          <div className="text-xs text-muted-foreground">
            {tasks.length === 0
              ? t("health.allGood")
              : important === 0
                ? t("health.minorOnly", { count: minor })
                : <>{t("health.needAttention", { count: important })}{totalSetups > 0 && <> {t("health.healthyOf", { healthy, total: totalSetups })}</>}</>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {critical > 0 && <Pill tone="down" dot>{t("health.important", { count: critical })}</Pill>}
          {counts.noChecklist + counts.noRules > 0 && <Pill tone="warn">{t("health.noRulesPill", { count: counts.noChecklist + counts.noRules })}</Pill>}
          {counts.noExamples > 0 && <Pill tone="neutral" className="hidden sm:inline-flex">{t("health.noExamplesPill", { count: counts.noExamples })}</Pill>}
          {counts.idle > 0 && <Pill tone="neutral" className="hidden xl:inline-flex">{t("health.idlePill", { count: counts.idle })}</Pill>}
        </div>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground motion-safe:transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>

      {open && (
        <div className="space-y-3 border-t border-[var(--glass-border)] px-4 pb-4 pt-3 sm:px-5">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("health.filterAria")}>
            <FilterChip active={filter === "all"} onClick={() => { setFilter("all"); setLimit(PAGE); }} count={tasks.length}>{t("health.all")}</FilterChip>
            {ORDER.filter((k) => counts[k] > 0).map((k) => (
              <FilterChip key={k} active={filter === k} onClick={() => { setFilter(k); setLimit(PAGE); }} count={counts[k]}>
                {ISSUES[k].label}
              </FilterChip>
            ))}
          </div>

          {visible.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t("health.empty")}</p>
          ) : (
            <ol className="space-y-1.5">
              {visible.slice(0, limit).map((task, i) => {
                const top = filter === "all" ? task.issues[0] : task.issues.find((x) => x.key === filter) ?? task.issues[0];
                return (
                  <li key={task.id} className="group flex items-start gap-3 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] px-3 py-2.5">
                    <span className="mt-0.5 w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="truncate text-sm font-medium text-foreground" title={task.name}>{task.name}</span>
                        {task.folder && <span className="truncate text-xs text-muted-foreground">{task.folder}</span>}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">→ {ISSUES[top.key].action}</div>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {task.issues.map((x) => (
                          <Pill key={x.key} tone={ISSUES[x.key].tone}>
                            {ISSUES[x.key].label}{x.detail ? ` · ${x.detail}` : ""}
                          </Pill>
                        ))}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => snooze(task.id)}
                        aria-label={t("health.snoozeAria", { name: task.name, days: SNOOZE_DAYS })}
                        title={t("health.snoozeTitle", { days: SNOOZE_DAYS })}
                        className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <BellOff className="h-4 w-4" aria-hidden="true" />
                      </button>
                      {onJump && (
                        <button
                          type="button"
                          onClick={() => onJump(task.id)}
                          className="inline-flex min-h-8 items-center gap-1 rounded-full px-3 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {t("health.open")} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            {visible.length > limit ? (
              <button
                type="button"
                onClick={() => setLimit((l) => l + PAGE * 2)}
                className="inline-flex min-h-8 items-center rounded-full px-3 text-xs font-medium text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("health.showMore", { count: Math.min(PAGE * 2, visible.length - limit), left: visible.length - limit })}
              </button>
            ) : <span />}
            {snoozedCount > 0 && (
              <button
                type="button"
                onClick={unsnoozeAll}
                className="inline-flex min-h-8 items-center gap-1 rounded-full px-3 text-xs text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> {t("health.unsnooze", { count: snoozedCount })}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
