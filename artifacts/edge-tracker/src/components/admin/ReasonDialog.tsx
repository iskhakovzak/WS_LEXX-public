import { useEffect, useId, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Kbd } from "@/components/ds";
import { cn } from "@/lib/utils";
import { adminI18n } from "@/i18n/ns/admin";
import { commonI18n } from "@/i18n/ns/common";

/**
 * One dialog for every admin action that needs confirmation and (usually) a reason.
 * Replaces window.prompt/confirm: works on mobile, Esc cancels, Ctrl+Enter confirms.
 */
export type ReasonDialogState = {
  title: string;
  description?: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  /** When set, the dialog shows a field. */
  input?: {
    label: string;
    placeholder?: string;
    initial?: string;
    kind?: "text" | "textarea" | "password";
    minLength?: number;
    required?: boolean;
    /** Quick-pick chips that fill the field. */
    presets?: string[];
  };
  onConfirm: (value: string) => void;
} | null;

export function ReasonDialog({ state, onClose, busy }: { state: ReasonDialogState; onClose: () => void; busy?: boolean }) {
  const { t } = adminI18n.useT();
  const [value, setValue] = useState("");
  const fieldId = useId();
  useEffect(() => { setValue(state?.input?.initial ?? ""); }, [state]);
  const input = state?.input;
  const trimmed = value.trim();
  const tooShort = !!input?.minLength && value.length > 0 && value.length < input.minLength;
  const invalid = !!input && ((input.required && !trimmed) || tooShort);
  const submit = () => { if (state && !invalid && !busy) state.onConfirm(input?.kind === "password" ? value : trimmed); };

  return (
    <Dialog open={!!state} onOpenChange={(v) => { if (!v && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e) => { e.preventDefault(); submit(); }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}
          className="flex flex-col gap-4"
          autoComplete="off"
        >
          <DialogHeader>
            <DialogTitle>{state?.title}</DialogTitle>
            {state?.description && <DialogDescription>{state.description}</DialogDescription>}
          </DialogHeader>
          {input && (
            <div className="flex flex-col gap-2">
              <Label htmlFor={fieldId} className="text-xs text-muted-foreground">
                {input.label}{input.required && <span className="text-down"> *</span>}
              </Label>
              {input.presets && input.presets.length > 0 && (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("reason.presetsAria")}>
                  {input.presets.map((p) => (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={trimmed === p}
                      onClick={() => setValue(p)}
                      className="chip inline-flex min-h-7 items-center px-2.5 text-xs font-medium"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}
              {input.kind === "textarea" ? (
                <Textarea
                  id={fieldId}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={input.placeholder}
                  rows={3}
                  maxLength={2000}
                  autoFocus
                  className="rounded-xl"
                />
              ) : (
                <Input
                  id={fieldId}
                  type={input.kind === "password" ? "password" : "text"}
                  autoComplete={input.kind === "password" ? "new-password" : "off"}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={input.placeholder}
                  aria-invalid={tooShort}
                  aria-describedby={tooShort ? `${fieldId}-err` : undefined}
                  maxLength={2000}
                  autoFocus
                />
              )}
              {tooShort && <p id={`${fieldId}-err`} className="text-xs text-down">{t("reason.minLength", { count: input.minLength ?? 0 })}</p>}
            </div>
          )}
          <DialogFooter className="items-center gap-2 sm:justify-between">
            <span className="hidden items-center gap-1 text-2xs text-muted-foreground sm:inline-flex">
              <Kbd keys={["Ctrl", "Enter"]} /> {t("reason.confirmHint")} · <Kbd>Esc</Kbd> {t("reason.cancelHint")}
            </span>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{commonI18n.t("actions.cancel")}</Button>
              <Button
                type="submit"
                variant={state?.destructive ? "destructive" : "default"}
                disabled={busy || invalid}
                className={cn(state?.destructive && "font-semibold")}
              >
                {busy ? t("reason.saving") : state?.confirmLabel}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
