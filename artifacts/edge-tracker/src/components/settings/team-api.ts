import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError, http } from "@/lib/api/http";
import { isNotFound } from "@/lib/api/errors";
import { STALE } from "@/lib/api/keys";
import { commonI18n } from "@/i18n/ns/common";
import { settingsI18n } from "@/i18n/ns/settings";

export type TeamMember = {
  id: number;
  name: string;
  role: string;
  active: boolean;
  banned: boolean;
  createdAt: string | null;
  telegramLinked: boolean;
  tgNotificationsEnabled: boolean;
  assignedCurator: string | null;
  assignedRiskManager: string | null;
  assignedMentor: string | null;
  /** null when the server doesn't provide activity (older API). */
  trades30: number | null;
  lastTrade: string | null;
  riskTier: string | null;
};

export type AssignmentField = "assignedCurator" | "assignedRiskManager" | "assignedMentor";

/** Assignment columns; labels follow the UI language (getters). */
export const ASSIGNMENT_FIELDS: { key: AssignmentField; readonly label: string; readonly short: string }[] = [
  { key: "assignedCurator", get label() { return commonI18n.t("roles.curator"); }, get short() { return settingsI18n.t("team.curatorShort"); } },
  { key: "assignedRiskManager", get label() { return commonI18n.t("roles.riskManager"); }, get short() { return settingsI18n.t("team.riskShort"); } },
  { key: "assignedMentor", get label() { return commonI18n.t("roles.mentor"); }, get short() { return settingsI18n.t("team.mentorShort"); } },
];

export const TEAM_QUERY_KEY = ["users", "team"] as const;

type LegacyUser = { id: number; name: string; role: string; active: boolean; banned?: boolean; createdAt?: string };
type LegacyAssignment = {
  name: string; telegram_chat_id: string | null;
  assigned_curator: string | null; assigned_risk_manager: string | null; assigned_mentor: string | null;
};

/** Old API (before /users/team): merge /users/all + /telegram/assignments client-side. */
async function loadLegacyTeam(): Promise<TeamMember[]> {
  const [users, assignments] = await Promise.all([
    http.get<LegacyUser[]>("/api/users/all"),
    http.get<LegacyAssignment[]>("/api/telegram/assignments").catch(() => [] as LegacyAssignment[]),
  ]);
  const byName = new Map(assignments.map((a) => [a.name, a]));
  return users.map((u) => {
    const a = byName.get(u.name);
    return {
      id: u.id, name: u.name, role: u.role, active: u.active, banned: !!u.banned, createdAt: u.createdAt ?? null,
      telegramLinked: !!a?.telegram_chat_id, tgNotificationsEnabled: true,
      assignedCurator: a?.assigned_curator ?? null, assignedRiskManager: a?.assigned_risk_manager ?? null, assignedMentor: a?.assigned_mentor ?? null,
      trades30: null, lastTrade: null, riskTier: null,
    };
  });
}

export function useTeam(enabled: boolean) {
  return useQuery<TeamMember[]>({
    queryKey: TEAM_QUERY_KEY,
    queryFn: async ({ signal }) => {
      try {
        return await http.get<TeamMember[]>("/api/users/team", { signal });
      } catch (e) {
        if (isNotFound(e)) return loadLegacyTeam();
        throw e;
      }
    },
    enabled,
    staleTime: STALE.default,
  });
}

export function useInvalidateTeam() {
  const qc = useQueryClient();
  return () => invalidateTeam(qc);
}

export function invalidateTeam(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: TEAM_QUERY_KEY });
  qc.invalidateQueries({ queryKey: ["users", "me", "profile"] });
}

/** PATCH all three assignments for a trader (the endpoint replaces all three). */
export async function saveAssignments(m: Pick<TeamMember, "name" | AssignmentField>): Promise<void> {
  await http.patch(`/api/telegram/assignments/${encodeURIComponent(m.name)}`, {
    assigned_curator: m.assignedCurator,
    assigned_risk_manager: m.assignedRiskManager,
    assigned_mentor: m.assignedMentor,
  });
}

export async function setUserActive(id: number, active: boolean): Promise<void> {
  try {
    if (active) await http.patch(`/api/users/${id}`, { active: true });
    else await http.del(`/api/users/${id}`, {});
  } catch (e) {
    if (active && e instanceof ApiError && /no fields/i.test(e.message)) throw new Error(settingsI18n.t("team.reactivateUnsupported"));
    throw e;
  }
}

export async function unlinkTelegram(name: string): Promise<void> {
  await http.del(`/api/telegram/admin/disconnect/${encodeURIComponent(name)}`);
}

/** Random temporary password (no ambiguous characters). */
export function generatePassword(len = 10): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint32Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
