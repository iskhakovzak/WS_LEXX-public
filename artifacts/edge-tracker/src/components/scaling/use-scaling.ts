import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { POLL } from "@/lib/api/keys";
import { nyDate } from "@/lib/trading-date";

// ─── types (mirror api-server/src/lib/scalingEngine.ts) ─────────────────────

export type RuleKind = "promote" | "demote";
export type Op = ">=" | ">" | "<=" | "<" | "=";
export type Unit = "abs" | "x_daily_limit" | "pct_account";
export type MetricUnit = "usd" | "r" | "pct" | "count" | "x" | "score" | "weeks" | "days";
export type Action = "promote" | "hold" | "demote" | "assign";
export type RuleStatus = "pass" | "fail" | "na";

export type MetricMeta = { key: string; label: string; unit: MetricUnit; higherIsBetter: boolean; hint: string };
export type Meta = { metrics: MetricMeta[]; ops: Op[]; units: { key: Unit; label: string }[] };

export type Tier = {
  key: string;
  name: string;
  order: number;
  accountSize: number | null;
  dailyLossLimit: number | null;
  weeklyLossLimit: number | null;
  maxDrawdown: number | null;
  maxRiskPerTrade: number | null;
  maxPositionUsd: number | null;
  maxOvernightExposure: number | null;
  maxOpenPositions: number | null;
  allowOvernight: boolean;
  allowSwing: boolean;
  description?: string | null;
};

export type Rule = {
  id: number;
  kind: RuleKind;
  metric: string;
  op: Op;
  value: number;
  unit: Unit;
  windowDays: number;
  tierKey: string | null;
  label: string | null;
  enabled: boolean;
};

export type MetricValue = { key: string; value: number | null; basis?: "usd" | "r"; note?: string };
export type WindowMetrics = {
  windowDays: number;
  from: string;
  to: string;
  moneySource: "propreports" | "journal";
  hasMoney: boolean;
  values: Record<string, MetricValue>;
};

export type RuleResult = {
  ruleId: number;
  kind: RuleKind;
  metric: string;
  label: string;
  op: Op;
  threshold: number | null;
  rawValue: number;
  unit: Unit;
  windowDays: number;
  actual: number | null;
  basis?: "usd" | "r";
  status: RuleStatus;
  progress: number;
  text: string;
};

export type Limits = {
  trader: string;
  tier: string | null;
  accountSize: number | null;
  dailyLossLimit: number | null;
  weeklyLossLimit: number | null;
  maxDrawdown: number | null;
  maxRiskPerTrade: number | null;
  maxPositionUsd: number | null;
  maxOvernightExposure: number | null;
  maxOpenPositions: number | null;
  allowOvernight: boolean;
  allowSwing: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
};

export type Proposal = {
  id: number;
  trader: string;
  action: Action;
  fromTier: string | null;
  toTier: string;
  status: "pending" | "approved" | "rejected";
  source: "auto" | "manual";
  reasons: string[];
  comment: string | null;
  createdBy: string;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionComment: string | null;
};

export type HistoryEntry = {
  id: number;
  trader: string;
  action: string;
  fromTier: string | null;
  toTier: string;
  proposalId: number | null;
  actor: string;
  comment: string | null;
  limits: Partial<Tier> | null;
  createdAt: string;
};

export type TraderEval = {
  trader: string;
  today: string;
  tierKey: string | null;
  tier: Tier | null;
  nextTier: Tier | null;
  prevTier: Tier | null;
  rules: RuleResult[];
  windows: WindowMetrics[];
  recommendation: { action: Action; toTier: Tier | null; reasons: string[]; warning: boolean };
  progress: number | null;
  promotePassed: number;
  promoteTotal: number;
  missing: RuleResult[];
  triggered: RuleResult[];
  limits: Limits | null;
  pendingProposal: Proposal | null;
  role: string | null;
};

export type Evaluation = {
  date: string;
  tiers: Tier[];
  rules: Rule[];
  meta: Meta;
  summary: { traders: number; promote: number; demote: number; assign: number; hold: number; warnings: number; pending: number };
  traders: TraderEval[];
  canEdit: boolean;
};

export type Config = { tiers: Tier[]; rules: Rule[]; meta: Meta; canEdit: boolean };

export const scalingKeys = {
  all: ["scaling"] as const,
  evaluate: (trader: string | null) => ["scaling", "evaluate", trader ?? "*"] as const,
  config: () => ["scaling", "config"] as const,
  proposals: (status: string, trader: string | null) => ["scaling", "proposals", status, trader ?? "*"] as const,
  history: (trader: string | null) => ["scaling", "history", trader ?? "*"] as const,
};

export function useEvaluation(trader: string | null, enabled = true) {
  const q = trader ? `trader=${encodeURIComponent(trader)}&` : "";
  return useQuery({
    queryKey: scalingKeys.evaluate(trader),
    queryFn: () => http.get<Evaluation>(`/api/scaling/evaluate?${q}date=${nyDate()}`),
    enabled,
    refetchInterval: POLL.twoMinutes,
    placeholderData: keepPreviousData,
  });
}

export function useScalingConfig(enabled = true) {
  return useQuery({ queryKey: scalingKeys.config(), queryFn: () => http.get<Config>("/api/scaling/config"), enabled });
}

export function useProposals(status: "pending" | "approved" | "rejected" | "all", trader: string | null, enabled = true) {
  const q = trader ? `&trader=${encodeURIComponent(trader)}` : "";
  return useQuery({
    queryKey: scalingKeys.proposals(status, trader),
    queryFn: () => http.get<{ proposals: Proposal[] }>(`/api/scaling/proposals?status=${status}${q}&limit=100`),
    enabled,
  });
}

export function useHistory(trader: string | null, enabled = true) {
  const q = trader ? `?trader=${encodeURIComponent(trader)}` : "";
  return useQuery({
    queryKey: scalingKeys.history(trader),
    queryFn: () => http.get<{ trader: string | null; history: HistoryEntry[] }>(`/api/scaling/history${q}`),
    enabled,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: scalingKeys.all });
    qc.invalidateQueries({ queryKey: ["risk"] }); // limits changed ⇒ risk desk should refetch too
  };
}

export type TierInput = Omit<Tier, "order"> & { order?: number };
export type RuleInput = Omit<Rule, "id"> & { id?: number };

export function useSaveTiers() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: (tiers: TierInput[]) => http.put<{ tiers: Tier[] }>("/api/scaling/tiers", tiers), onSuccess: inv });
}
export function useSaveRules() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: (rules: RuleInput[]) => http.put<{ rules: Rule[] }>("/api/scaling/rules", rules), onSuccess: inv });
}
export function useCreateProposal() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (body: { trader: string; action?: Action; toTier?: string; comment?: string }) => http.post<Proposal>("/api/scaling/proposals", body),
    onSuccess: inv,
  });
}
export function useAutoProposals() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: () => http.post<{ created: number; proposals: Proposal[] }>("/api/scaling/proposals/auto", { date: nyDate() }), onSuccess: inv });
}
export function useDecideProposal() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, decision, comment }: { id: number; decision: "approve" | "reject"; comment?: string }) =>
      http.post<{ proposal: Proposal }>(`/api/scaling/proposals/${id}/${decision}`, { comment }),
    onSuccess: inv,
  });
}
export function useAssignTier() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (body: { trader: string; tierKey: string; comment?: string }) => http.post<{ trader: string; fromTier: string | null; tier: Tier }>("/api/scaling/assign", body),
    onSuccess: inv,
  });
}
