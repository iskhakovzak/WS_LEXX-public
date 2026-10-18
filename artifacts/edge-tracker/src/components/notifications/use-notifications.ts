/**
 * React-query hooks for the notification center. One polling source for the unread badge
 * (45 s, paused while the tab is hidden / window unfocused); lists are fetched on demand.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/auth-context";
import {
  NOTIF_KEYS, filterParams, notificationsApi,
  type ListFilters, type Notification, type NotificationPage, type Prefs, type UnreadCount,
} from "./model";

export const COUNT_POLL_MS = 45_000;

/** Signed-in member name (guests have no inbox). */
export function useMe(): string | null {
  const { user } = useAuth();
  return user && user.role !== "guest" && user.traderName ? user.traderName : null;
}

/** True while the document is visible — polling pauses in background tabs. */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  return visible;
}

export function useUnreadCount() {
  const me = useMe();
  const visible = useDocumentVisible();
  return useQuery<UnreadCount>({
    queryKey: NOTIF_KEYS.count(me),
    queryFn: notificationsApi.count,
    enabled: !!me,
    refetchInterval: visible ? COUNT_POLL_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
    retry: 1,
  });
}

export function useNotificationList(filters: ListFilters, enabled = true) {
  const me = useMe();
  const params = useMemo(() => filterParams(filters), [filters]);
  const query = useInfiniteQuery<NotificationPage>({
    queryKey: NOTIF_KEYS.list(me, params),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => notificationsApi.list(params, pageParam as string | null),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && !!me,
    staleTime: 15_000,
  });
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  return { ...query, items, params };
}

/** Invalidate every notification query (count, lists, prefs) for the current user. */
export function useInvalidateNotifications() {
  const qc = useQueryClient();
  const me = useMe();
  return useCallback(() => {
    qc.invalidateQueries({ queryKey: ["notifications-count", me] });
    qc.invalidateQueries({ queryKey: ["notifications", me] });
  }, [qc, me]);
}

/** Optimistically flip `isRead` / `archivedAt` on every cached list page so the UI reacts instantly. */
function usePatchCached() {
  const qc = useQueryClient();
  const me = useMe();
  return useCallback(
    (ids: Set<number> | "all", patch: Partial<Notification> | ((n: Notification) => Notification), dropArchived = false) => {
      qc.setQueriesData<{ pages: NotificationPage[]; pageParams: unknown[] }>({ queryKey: ["notifications", me] }, (old) => {
        if (!old?.pages) return old;
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            items: p.items
              .map((n) => (ids === "all" || ids.has(n.id) ? (typeof patch === "function" ? patch(n) : { ...n, ...patch }) : n))
              .filter((n) => !(dropArchived && (ids === "all" || ids.has(n.id)))),
          })),
        };
      });
    },
    [qc, me],
  );
}

export function useNotificationActions() {
  const invalidate = useInvalidateNotifications();
  const patch = usePatchCached();
  const now = () => new Date().toISOString();

  const readMany = useMutation({
    mutationFn: (ids: number[]) => notificationsApi.readMany(ids),
    onMutate: (ids) => patch(new Set(ids), { isRead: true, readAt: now() }),
    onSettled: invalidate,
  });
  const unreadMany = useMutation({
    mutationFn: (ids: number[]) => notificationsApi.unreadMany(ids),
    onMutate: (ids) => patch(new Set(ids), { isRead: false, readAt: null }),
    onSettled: invalidate,
  });
  const readAll = useMutation({
    mutationFn: (type?: string) => notificationsApi.readAll(type),
    onMutate: (type) => patch("all", (n) => (!type || n.type === type ? { ...n, isRead: true, readAt: now() } : n)),
    onSettled: invalidate,
  });
  const archive = useMutation({
    mutationFn: (ids: number[]) => notificationsApi.archive(ids),
    onMutate: (ids) => patch(new Set(ids), { isRead: true, archivedAt: now() }, true),
    onSettled: invalidate,
  });
  const archiveRead = useMutation({
    mutationFn: () => notificationsApi.archiveRead(),
    onSettled: invalidate,
  });
  const unarchive = useMutation({
    mutationFn: (ids: number[]) => notificationsApi.unarchive(ids),
    onMutate: (ids) => patch(new Set(ids), { archivedAt: null }, true),
    onSettled: invalidate,
  });

  return { readMany, unreadMany, readAll, archive, archiveRead, unarchive };
}

/** Mark read (fire-and-forget) and go to the notification's link. */
export function useOpenNotification(onBeforeNavigate?: () => void) {
  const [, navigate] = useLocation();
  const { readMany } = useNotificationActions();
  return useCallback(
    (n: Notification) => {
      if (!n.isRead) readMany.mutate([n.id]);
      if (!n.link) return false;
      onBeforeNavigate?.();
      navigate(n.link);
      return true;
    },
    [navigate, readMany, onBeforeNavigate],
  );
}

export function useNotificationPrefs() {
  const me = useMe();
  const qc = useQueryClient();
  const query = useQuery<Prefs>({ queryKey: NOTIF_KEYS.prefs(me), queryFn: notificationsApi.prefs, enabled: !!me, staleTime: 60_000 });
  const save = useMutation({
    mutationFn: (p: Prefs) => notificationsApi.savePrefs(p),
    onSuccess: (saved) => qc.setQueryData(NOTIF_KEYS.prefs(me), saved),
  });
  return { ...query, save };
}
