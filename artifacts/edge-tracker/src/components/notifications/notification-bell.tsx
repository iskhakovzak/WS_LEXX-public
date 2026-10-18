/**
 * Header bell: unread badge (red when something critical is unread), popover with the latest
 * notifications grouped by day, «Прочитать все» and a link to the full /notifications page.
 * Unread count polls GET /notifications/count (45 s, paused in hidden tabs); the list loads on open.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Bell, Check, Inbox, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NotificationItem } from "./notification-item";
import { groupByDay } from "./model";
import { useNotificationActions, useNotificationList, useOpenNotification, useUnreadCount } from "./use-notifications";
import { notificationsI18n } from "@/i18n/ns/notifications";
import { commonI18n } from "@/i18n/ns/common";

const iconBtn = "chip relative grid h-10 w-10 shrink-0 place-items-center focus-visible:ring-2 focus-visible:ring-ring";

const POPOVER_FILTERS = { limit: 20 } as const;

export function NotificationBell({ className }: { className?: string }) {
  const { t } = notificationsI18n.useT();
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  const { data: count } = useUnreadCount();
  const list = useNotificationList(POPOVER_FILTERS, open);
  const { readAll } = useNotificationActions();
  const openNotification = useOpenNotification(() => setOpen(false));

  const unread = count?.unread ?? 0;
  const critical = (count?.critical ?? 0) > 0;
  const groups = useMemo(() => groupByDay(list.items), [list.items]);

  const goToPage = () => {
    setOpen(false);
    navigate("/notifications");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(iconBtn, className)}
          title={t("title")}
          aria-label={unread > 0 ? t(critical ? "bell.ariaUnreadCritical" : "bell.ariaUnread", { count: unread }) : t("title")}
        >
          <Bell className={cn("h-4 w-4", critical && "text-down")} aria-hidden="true" />
          {unread > 0 && (
            <span
              aria-hidden="true"
              className={cn(
                "absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-2xs font-semibold leading-none text-primary-foreground ring-2 ring-background",
                critical ? "bg-down" : "bg-primary-solid",
              )}
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[min(400px,calc(100vw-1.5rem))] overflow-hidden rounded-2xl p-0">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--glass-border)] px-4 py-3">
          <span className="text-sm font-semibold text-foreground">
            {t("title")}
            {unread > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{t("bell.newCount", { count: unread })}</span>}
          </span>
          <div className="flex items-center gap-1">
            {unread > 0 && (
              <button
                type="button"
                onClick={() => readAll.mutate(undefined)}
                disabled={readAll.isPending}
                className="chip inline-flex h-7 items-center gap-1 px-2.5 text-xs font-medium disabled:opacity-50"
              >
                <Check className="h-3 w-3" aria-hidden="true" />
                {readAll.isPending ? "…" : t("bell.readAll")}
              </button>
            )}
            <button type="button" onClick={goToPage} className="chip grid h-7 w-7 place-items-center" title={t("bell.settingsTitle")} aria-label={t("bell.settingsAria")}>
              <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
        {readAll.isError && (
          <div role="alert" className="border-b border-[var(--glass-border)] px-4 py-2 text-xs text-destructive">
            {t("bell.readAllFailed")}
          </div>
        )}
        <div className="max-h-[70vh] overflow-y-auto overscroll-contain p-1.5">
          {list.isLoading ? (
            <div role="status" className="space-y-2 p-2">
              {[0, 1, 2].map((i) => <div key={i} className="h-12 animate-pulse rounded-xl bg-[var(--glass-bg)] motion-reduce:animate-none" />)}
              <span className="sr-only">{commonI18n.t("states.loading")}</span>
            </div>
          ) : list.isError ? (
            <div className="space-y-2 py-8 text-center text-sm text-muted-foreground">
              <div>{t("bell.loadFailed")}</div>
              <button type="button" onClick={() => list.refetch()} className="chip h-8 px-3 text-xs font-medium">{commonI18n.t("actions.retry")}</button>
            </div>
          ) : list.items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Inbox className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">{t("bell.empty")}</p>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.key} aria-label={g.label}>
                <h3 className="micro-label px-2.5 pb-1 pt-2">{g.label}</h3>
                <ul className="space-y-0.5">
                  {g.items.map((n) => (
                    <li key={n.id}>
                      <NotificationItem n={n} variant="compact" onOpen={openNotification} />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
        <div className="border-t border-[var(--glass-border)] p-1.5">
          <button
            type="button"
            onClick={goToPage}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium text-primary hover:bg-[var(--glass-hover-bg)]"
          >
            {t("bell.all")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
