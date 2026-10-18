import { useToast } from "@/hooks/use-toast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"
import { shellI18n } from "@/i18n/ns/shell"

export function Toaster() {
  const { toasts } = useToast()
  // Outside the I18nProvider remount: subscribe so labels follow a language switch.
  const { t } = shellI18n.useT()

  return (
    <ToastProvider label={t("ui.notification")}>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        return (
          <Toast key={id} {...props}>
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport label={t("ui.notificationsRegion", { hotkey: "{hotkey}" })} />
    </ToastProvider>
  )
}
