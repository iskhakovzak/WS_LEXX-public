/** One notification row: severity-tinted icon tile, title/body, time, unread dot and (full variant) row actions. */
import React from "react";
import { Archive, ArchiveRestore, ArrowUpRight, Check, Mail } from "lucide-react";
import { cn } from "@/lib/utils";
import { Pill } from "@/components/ds";
import { SEVERITY_LABEL, SEVERITY_TILE, SEVERITY_TONE, iconFor, notificationTitle, timeAgo, typeLabelOf, type Notification } from "./model";
import { fmtDate } from "@/lib/format";
import { notificationsI18n } from "@/i18n/ns/notifications";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

export type NotificationItemProps = {
  n: Notification;
  /** "compact" = bell popover; "full" = inbox page (checkbox, actions, severity pill). */
  variant?: "compact" | "full";
  selected?: boolean;
  focused?: boolean;
  onOpen: (n: Notification) => void;
  onToggleSelect?: (n: Notification, shift: boolean) => void;
  onRead?: (n: Notification, read: boolean) => void;
  onArchive?: (n: Notification, archive: boolean) => void;
  id?: string;
};

export const NotificationItem = React.memo(function NotificationItem({
  n, variant = "compact", selected = false, focused = false, onOpen, onToggleSelect, onRead, onArchive, id,
}: NotificationItemProps) {
  const { t } = notificationsI18n.useT();
  const title = notificationTitle(n);
  const Icon = iconFor(n.type);
  const full = variant === "full";
  const archived = !!n.archivedAt;
  const tile = n.isRead ? "bg-[var(--glass-bg)] text-muted-foreground" : SEVERITY_TILE[n.severity];
  const critical = !n.isRead && n.severity === "critical";

  const iconBtn = "grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div
      id={id}
      data-notification-id={n.id}
      className={cn(
        "group/row relative flex items-start gap-3 rounded-xl px-2.5 py-2 transition-colors",
        full ? "border border-transparent" : "",
        focused && "border-[var(--glass-border)] bg-[var(--glass-hover-bg)]",
        selected && "bg-primary/8",
        critical && !full && "bg-down/5",
      )}
    >
      {full && onToggleSelect && (
        <label className="mt-1.5 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={() => undefined}
            onClick={(e) => onToggleSelect(n, (e as React.MouseEvent).shiftKey)}
            aria-label={t("item.selectAria", { title })}
            className="h-4 w-4 cursor-pointer accent-[hsl(var(--primary))]"
          />
        </label>
      )}
      <button
        type="button"
        onClick={() => onOpen(n)}
        className={cn("flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left focus-visible:outline-none", !n.link && "cursor-default")}
        aria-label={n.isRead ? t("item.readAria", { title, body: n.body }) : t("item.unreadPrefix", { title, body: n.body })}
      >
        <span className={cn("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg", tile)}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span title={title} className={cn("min-w-0 flex-1 text-sm leading-snug", full ? "line-clamp-2 break-words" : "truncate", n.isRead ? "font-normal text-muted-foreground" : "font-semibold text-foreground")}>
              {title}
            </span>
            <span className="shrink-0 text-2xs tabular-nums text-muted-foreground" title={fmtDate(n.createdAt, "shortDateTimeSeconds")}>
              {full ? fmtDate(n.createdAt, "time") : timeAgo(n.createdAt)}
            </span>
          </span>
          {n.body && n.body !== title && (
            <span className={cn("mt-0.5 block text-[13px] leading-snug text-muted-foreground", full ? "whitespace-pre-wrap" : "line-clamp-2")}>{n.body}</span>
          )}
          {full && (
            <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Pill tone="neutral" className="text-2xs">{typeLabelOf(n.type)}</Pill>
              {n.severity !== "info" && <Pill tone={SEVERITY_TONE[n.severity]} dot className="text-2xs">{SEVERITY_LABEL[n.severity]}</Pill>}
              {n.actor && <span className="text-2xs text-muted-foreground">{t("item.from", { name: personName(n.actor) })}</span>}
              {n.link && (
                <span className="inline-flex items-center gap-0.5 text-2xs text-primary">
                  {t("item.open")} <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                </span>
              )}
            </span>
          )}
        </span>
      </button>
      {!full && !n.isRead && <span className="mt-2.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-label={t("item.unread")} />}
      {full && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100 data-[focused=true]:opacity-100" data-focused={focused}>
          {onRead && (
            <button type="button" className={iconBtn} onClick={() => onRead(n, !n.isRead)} title={n.isRead ? t("item.markUnreadTitle") : t("item.markReadTitle")} aria-label={n.isRead ? t("item.markUnread") : t("item.markRead")}>
              {n.isRead ? <Mail className="h-3.5 w-3.5" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
          )}
          {onArchive && (
            <button type="button" className={iconBtn} onClick={() => onArchive(n, !archived)} title={archived ? t("item.unarchive") : t("item.archiveTitle")} aria-label={archived ? t("item.unarchive") : commonI18n.t("actions.archive")}>
              {archived ? <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" /> : <Archive className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
          )}
        </div>
      )}
      {full && !n.isRead && <span className="absolute left-0 top-3 h-[calc(100%-1.5rem)] w-0.5 rounded-full bg-primary" aria-hidden="true" />}
    </div>
  );
});
