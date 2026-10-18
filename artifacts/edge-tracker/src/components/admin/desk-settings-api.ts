/**
 * Desk settings API (artifacts/api-server/src/routes/admin-settings.ts): GET/PUT /api/admin/settings, settings.manage.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import type { SettingRow, SettingValue } from "./desk-settings-model";

export interface SettingsPayload { settings: SettingRow[]; timezone: string; changed?: string[] }

export const DESK_SETTINGS_KEY = ["admin-console", "desk-settings"] as const;

export function useDeskSettings(enabled: boolean) {
  return useQuery({
    queryKey: DESK_SETTINGS_KEY,
    queryFn: ({ signal }) => http.get<SettingsPayload>("/api/admin/settings", { signal }),
    staleTime: STALE.default,
    enabled,
  });
}

export function useSaveDeskSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (changes: { key: string; value: SettingValue | null }[]) => http.put<SettingsPayload>("/api/admin/settings", { changes }),
    onSuccess: (data) => {
      qc.setQueryData(DESK_SETTINGS_KEY, data);
      void qc.invalidateQueries({ queryKey: ["admin-console", "jobs"] }); // Telegram send times move the job schedule
    },
  });
}
