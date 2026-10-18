/**
 * Small key/value settings store for the integration (table propreports_settings, JSONB values):
 *   fees        FeeSettings — include/exclude/rename of fee columns (see fees.ts)
 *   groupId     string|null — PropReports group chosen in the UI (env PROPREPORTS_GROUP_ID wins when set)
 *   unmatched   string[]    — account names seen in imports that could not be matched to a mapping
 *   connection  last connection check result (also kept in memory by client.ts; persisted for the wizard)
 */
import { pool } from "@workspace/db";
import { DEFAULT_FEE_SETTINGS, type FeeSettings } from "./fees";

export interface ConnectionState {
  checkedAt: string | null;
  ok: boolean | null;
  mode: "v2" | "v1" | null;
  version: string | null;
  error: string | null;
  /** `propreports` namespace key + params of `error` (re-rendered per reader language); absent for upstream texts. */
  errorKey?: string;
  errorParams?: Record<string, string | number>;
}

export interface IntegrationSettings {
  fees: FeeSettings;
  groupId: string | null;
  unmatched: string[];
  connection: ConnectionState;
}

const DEFAULTS: IntegrationSettings = {
  fees: DEFAULT_FEE_SETTINGS,
  groupId: null,
  unmatched: [],
  connection: { checkedAt: null, ok: null, mode: null, version: null, error: null },
};

export async function getSettings(): Promise<IntegrationSettings> {
  const { rows } = await pool.query(`SELECT key, value FROM propreports_settings`);
  const out: IntegrationSettings = { ...DEFAULTS, fees: { ...DEFAULT_FEE_SETTINGS, columns: {}, detected: [] } };
  for (const r of rows as Array<{ key: string; value: unknown }>) {
    if (r.key === "fees" && r.value && typeof r.value === "object") out.fees = { ...out.fees, ...(r.value as Partial<FeeSettings>) };
    else if (r.key === "groupId") out.groupId = typeof r.value === "string" && r.value ? r.value : null;
    else if (r.key === "unmatched" && Array.isArray(r.value)) out.unmatched = (r.value as unknown[]).map(String);
    else if (r.key === "connection" && r.value && typeof r.value === "object") out.connection = { ...out.connection, ...(r.value as Partial<ConnectionState>) };
  }
  return out;
}

export async function setSetting<K extends keyof IntegrationSettings>(key: K, value: IntegrationSettings[K]): Promise<void> {
  await pool.query(
    `INSERT INTO propreports_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}
