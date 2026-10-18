import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Lock, Send, Trash2, MessageSquare, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Pill } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { http } from "@/lib/api/http";
import { humanizeApiError } from "@/lib/api/errors";
import { cn } from "@/lib/utils";
import { useIdeaComments, IDEAS_KEY } from "./hooks";
import { Avatar } from "./IdeaCard";
import { relTime, type TradeIdea } from "./model";
import { fmtDate } from "@/lib/format";
import { ideasI18n } from "@/i18n/ns/ideas";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

const MAX_LEN = 5000;

/** Conversation thread for one idea: chat bubbles, private replies, Ctrl+Enter to send. */
export function CommentsThread({
  idea,
  currentUser,
  isReviewer,
}: {
  idea: TradeIdea;
  currentUser: string;
  isReviewer: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = ideasI18n.useT();
  const { t: tc } = commonI18n.useT();
  const [text, setText] = React.useState("");
  const [isPrivate, setIsPrivate] = React.useState(false);
  const { data: comments = [], isLoading, isError, refetch } = useIdeaComments(idea.id);
  const listRef = React.useRef<HTMLOListElement>(null);
  const inputId = React.useId();

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["idea-comments", idea.id] });
    qc.invalidateQueries({ queryKey: IDEAS_KEY });
  };

  const add = useMutation({
    mutationFn: () => http.post(`/api/trade-ideas/${idea.id}/comments`, { text: text.trim(), is_private: isPrivate }),
    onSuccess: () => { setText(""); refresh(); },
    onError: (e: Error) => toast({ title: ideasI18n.t("comments.sendFailed"), description: humanizeApiError(e), variant: "destructive" }),
  });
  const del = useMutation({
    mutationFn: (commentId: number) => http.del(`/api/trade-ideas/${idea.id}/comments/${commentId}`),
    onSuccess: refresh,
    onError: (e: Error) => toast({ title: commonI18n.t("states.deleteFailed"), description: humanizeApiError(e), variant: "destructive" }),
  });

  React.useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [comments.length]);

  const send = () => {
    if (!text.trim() || add.isPending || text.length > MAX_LEN) return;
    add.mutate();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <MessageSquare className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t("comments.title")}
          {comments.length > 0 && <span className="text-xs font-normal tabular-nums text-muted-foreground">{comments.length}</span>}
        </h3>
      </div>

      {isLoading && (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-12 w-3/4 rounded-xl" />
          <Skeleton className="ml-auto h-10 w-2/3 rounded-xl" />
        </div>
      )}
      {isError && (
        <div className="flex items-center gap-2 text-xs text-down">
          {t("comments.loadFailed")}
          <Button size="sm" variant="ghost" onClick={() => refetch()} className="gap-1"><RotateCcw className="h-3 w-3" />{tc("actions.retry")}</Button>
        </div>
      )}
      {!isLoading && !isError && comments.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("comments.empty")}</p>
      )}

      {comments.length > 0 && (
        <ol ref={listRef} className="flex max-h-[60dvh] flex-col gap-2 overflow-y-auto pr-1">
          {comments.map((c) => {
            const mine = c.author_name === currentUser;
            const isAuthor = c.author_name === idea.trader;
            const canDelete = isReviewer || (mine && Date.now() - new Date(c.created_at).getTime() < 24 * 3600 * 1000);
            return (
              <li key={c.id} className={cn("group flex max-w-[92%] gap-2", mine ? "ml-auto flex-row-reverse" : "")}>
                <Avatar name={c.author_name} className="mt-0.5" />
                <div
                  className={cn(
                    "min-w-0 rounded-2xl px-3 py-2 text-sm",
                    c.is_private
                      ? "border border-[hsl(var(--chart-3)/0.35)] bg-[hsl(var(--chart-3)/0.10)]"
                      : mine ? "bg-primary/15" : "bg-[var(--glass-bg)] border border-[var(--field-border)]",
                  )}
                >
                  <div className="mb-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
                    <span className="font-semibold text-foreground">{personName(c.author_name)}</span>
                    {isAuthor && <Pill tone="accent" className="px-1.5 py-0 text-2xs">{t("comments.author")}</Pill>}
                    {c.is_private && <span className="flex items-center gap-0.5 text-[hsl(var(--chart-3))]"><Lock className="h-3 w-3" aria-hidden="true" />{t("comments.private")}</span>}
                    {c.source === "telegram" && <span>· Telegram</span>}
                    <time dateTime={c.created_at} title={fmtDate(c.created_at, "shortDateTime")}>· {relTime(c.created_at)}</time>
                    {canDelete && (
                      <button
                        type="button"
                        onClick={() => del.mutate(c.id)}
                        disabled={del.isPending}
                        aria-label={t("comments.delete")}
                        className="ml-1 grid h-6 w-6 place-items-center rounded-full text-muted-foreground opacity-70 hover:bg-down/15 hover:text-down focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <Trash2 className="h-3 w-3" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap break-words leading-relaxed text-foreground">{c.text}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {currentUser ? (
        <div className="glass-panel flex flex-col gap-2 rounded-2xl p-2">
          <label htmlFor={inputId} className="sr-only">{t("comments.label")}</label>
          <Textarea
            id={inputId}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }}
            rows={2}
            maxLength={MAX_LEN}
            placeholder={isPrivate ? t("comments.placeholderPrivate") : t("comments.placeholder")}
            className="min-h-[60px] resize-none border-0 bg-transparent shadow-none"
          />
          <div className="flex items-center justify-between gap-2 px-1">
            <button
              type="button"
              aria-pressed={isPrivate}
              onClick={() => setIsPrivate((v) => !v)}
              className="chip inline-flex min-h-8 items-center gap-1.5 px-3 text-xs font-medium"
              title={t("comments.privateTitle")}
            >
              <Lock className="h-3 w-3" aria-hidden="true" /> {t("comments.privateToggle")}
            </button>
            <div className="flex items-center gap-2">
              <span className="hidden text-2xs text-muted-foreground sm:inline">Ctrl+Enter</span>
              <Button size="sm" variant="secondary" onClick={send} disabled={!text.trim() || add.isPending} className="gap-1.5">
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
                {add.isPending ? t("sending") : tc("actions.send")}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("comments.signIn")}</p>
      )}
    </div>
  );
}
