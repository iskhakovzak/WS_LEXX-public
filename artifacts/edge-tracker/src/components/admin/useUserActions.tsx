import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { ApiError, http } from "@/lib/api/http";
import { ReasonDialog, type ReasonDialogState } from "./ReasonDialog";
import { adminUrl, roleLabel } from "./api";
import { secretMinFor } from "@/lib/secret-policy";
import { authI18n } from "@/i18n/ns/auth";
import { adminI18n } from "@/i18n/ns/admin";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

/** Quick-pick ban reasons in the UI language (the chosen text is stored as the reason). Call at render time. */
export function banPresets(): string[] {
  return adminI18n.t("userActions.banPresets").split("|");
}

type Target = { id: number; name: string; role: string };

/**
 * Ban / unban / role / password actions with a reason dialog, shared by the traders table,
 * the trader sheet and the overview. Render `dialog` once in the owning component.
 */
export function useUserActions(actor: string, onChange?: () => void) {
  const { toast } = useToast();
  const { t } = adminI18n.useT();
  const qc = useQueryClient();
  const [state, setState] = useState<ReasonDialogState>(null);

  const invalidate = () => {
    for (const k of ["admin-users", "admin-overview", "admin-audit", "admin-desk-pulse", "admin-reports"]) {
      qc.invalidateQueries({ queryKey: [k] });
    }
    onChange?.();
  };
  const onError = (e: Error) => toast({ title: commonI18n.t("states.error"), description: e.message, variant: "destructive" });

  const banMut = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      http.post<{ name?: string }>(adminUrl(`/admin/users/${id}/ban`, actor), { actor, reason }),
    onSuccess: (u) => { invalidate(); setState(null); toast({ title: t("userActions.banned", { name: u?.name ? personName(u.name) : t("userActions.user") }), description: t("userActions.bannedHint") }); },
    onError,
  });
  const unbanMut = useMutation({
    mutationFn: ({ id }: { id: number; reason: string }) =>
      http.post<{ name?: string }>(adminUrl(`/admin/users/${id}/unban`, actor), { actor }),
    onSuccess: (u) => { invalidate(); setState(null); toast({ title: t("userActions.unbanned", { name: u?.name ? personName(u.name) : t("userActions.user") }) }); },
    onError,
  });
  const roleMut = useMutation({
    mutationFn: async ({ id, role, reason }: { id: number; role: string; reason: string }) => {
      // New audited route (curators may switch trader <-> curator; admin role needs users.manage.admins).
      try {
        return await http.post<{ name?: string; role?: string }>(`/api/admin/console/people/${id}/role`, { role, reason });
      } catch (e) {
        // API not rebuilt yet (route-missing 404: no `code`): legacy route (admins only).
        if (e instanceof ApiError && e.status === 404 && !e.code) {
          return http.post<{ name?: string; role?: string }>(adminUrl(`/admin/users/${id}/role`, actor), { actor, role });
        }
        throw e;
      }
    },
    onSuccess: (u) => {
      invalidate();
      setState(null);
      toast({ title: t("userActions.roleUpdated"), description: u?.name ? t("userActions.roleUpdatedHint", { name: personName(u.name), role: roleLabel(u.role) }) : undefined });
    },
    onError,
  });
  const passwordMut = useMutation({
    mutationFn: async ({ id, password }: { id: number; name: string; password: string }) => {
      return http.patch(`/api/users/${id}`, { password });
    },
    onSuccess: (_d, v) => { setState(null); toast({ title: t("userActions.passwordUpdated", { name: personName(v.name) }), description: t("userActions.passwordUpdatedHint") }); },
    onError,
  });

  const busy = banMut.isPending || unbanMut.isPending || roleMut.isPending || passwordMut.isPending;

  return {
    busy,
    dialog: <ReasonDialog state={state} onClose={() => setState(null)} busy={busy} />,
    ban: (u: Target) => setState({
      title: t("userActions.ban.title", { name: personName(u.name) }),
      description: t("userActions.ban.text"),
      confirmLabel: t("userActions.ban.confirm"),
      destructive: true,
      input: { label: t("userActions.ban.reason"), kind: "textarea", required: true, presets: banPresets(), placeholder: t("userActions.ban.placeholder") },
      onConfirm: (reason) => banMut.mutate({ id: u.id, reason }),
    }),
    unban: (u: Target) => setState({
      title: t("userActions.unban.title", { name: personName(u.name) }),
      description: t("userActions.unban.text"),
      confirmLabel: t("userActions.unban.confirm"),
      onConfirm: (reason) => unbanMut.mutate({ id: u.id, reason }),
    }),
    changeRole: (u: Target, role: string) => setState({
      title: t("userActions.role.title", { name: personName(u.name) }),
      description: t("userActions.role.text", { from: roleLabel(u.role), to: roleLabel(role) }),
      confirmLabel: t("userActions.role.confirm"),
      input: { label: t("people.reasonLabel"), kind: "textarea", required: true, minLength: 3, presets: t("people.presets.role").split("|"), placeholder: t("people.reasonPlaceholder") },
      onConfirm: (reason) => roleMut.mutate({ id: u.id, role, reason }),
    }),
    setPassword: (u: Target) => setState({
      title: t("userActions.password.title", { name: personName(u.name) }),
      description: t("userActions.password.text"),
      confirmLabel: t("userActions.password.confirm"),
      input: { label: t("userActions.password.label"), kind: "password", minLength: secretMinFor(u.role), required: true, placeholder: authI18n.t("forced.tooShort", { min: secretMinFor(u.role) }) },
      onConfirm: (password) => passwordMut.mutate({ id: u.id, name: u.name, password }),
    }),
  };
}
