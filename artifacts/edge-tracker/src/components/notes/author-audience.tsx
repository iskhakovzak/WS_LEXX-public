import * as React from "react";
import { ChevronDown, Copy, Users } from "lucide-react";
import { Panel, Pill, type Tone } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/format";
import { stageLabel, type Audience, type AudienceMember, type AudienceStage } from "./author-model";
import { commonI18n } from "@/i18n/ns/common";
import { notesI18n } from "@/i18n/ns/notes";
import { rich, slots } from "@/i18n/rich";
import { personName, personInitials } from "@/i18n";

const STAGE_TONE: Record<AudienceStage, Tone> = { trainee: "warn", junior: "accent", trader: "neutral", senior: "purple" };

function MemberBadge({ m }: { m: AudienceMember }) {
  if (m.role === "curator" || m.role === "admin") return <Pill>{commonI18n.t(m.role === "admin" ? "roles.admin" : "roles.curator")}</Pill>;
  if (!m.stage) return null;
  return <Pill tone={STAGE_TONE[m.stage]}>{stageLabel(m.stage)}</Pill>;
}

function MemberRow({ m }: { m: AudienceMember }) {
  return (
    <li className="flex min-h-9 items-center gap-2 px-2 py-1">
      <span
        className={cn(
          "grid h-6 w-6 shrink-0 place-items-center rounded-full text-2xs font-semibold",
          m.readAt ? "bg-up/15 text-up" : "bg-[var(--glass-bg)] text-muted-foreground",
        )}
        aria-hidden="true"
      >
        {personInitials(m.name).slice(0, 1)}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm" title={personName(m.name)}>{personName(m.name)}</span>
      <MemberBadge m={m} />
      {m.readAt && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {fmtDate(m.readAt, "dateTime")}
        </span>
      )}
    </li>
  );
}

/**
 * Reach of the author's note: who of the team has read it and who has not yet — trainees and juniors first,
 * because the note is written mostly for them. Read-only; «Скопировать» puts the unread names on the clipboard
 * so the author can ping them in the desk chat (nothing is sent from here).
 */
export function AuthorAudience({
  hasNote,
  data,
  loading,
  error,
}: {
  hasNote: boolean;
  data: Audience | undefined;
  loading: boolean;
  error: boolean;
}) {
  const { toast } = useToast();
  const { t } = notesI18n.useT();
  const { t: tc } = commonI18n.useT();
  const [showRead, setShowRead] = React.useState(false);
  const unread = data?.members.filter((m) => !m.readAt) ?? [];
  const read = data?.members.filter((m) => m.readAt) ?? [];
  const pct = data && data.total ? Math.round((data.read / data.total) * 100) : 0;

  const copyUnread = async () => {
    try {
      await navigator.clipboard.writeText(unread.map((m) => personName(m.name)).join(", "));
      toast({ title: t("author.audience.copied"), description: t("author.audience.copiedDesc") });
    } catch {
      toast({ title: tc("states.copyFailed"), variant: "destructive" });
    }
  };

  return (
    <Panel
      title={t("author.audience.title")}
      icon={Users}
      description={t("author.audience.description")}
      actions={
        unread.length > 0 ? (
          <Button variant="ghost" size="sm" className="gap-1" onClick={() => void copyUnread()}>
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />{t("author.audience.names")}
          </Button>
        ) : undefined
      }
    >
      {!hasNote ? (
        <p className="text-sm text-muted-foreground">{t("author.audience.noNote")}</p>
      ) : loading ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label={t("author.audience.loading")}>
          <Skeleton className="h-6 w-full rounded-full" />
          <Skeleton className="h-9 w-full rounded-xl" />
          <Skeleton className="h-9 w-full rounded-xl" />
        </div>
      ) : error || !data ? (
        <p className="text-sm text-muted-foreground">{t("author.audience.unavailable")}</p>
      ) : data.total === 0 ? (
        <p className="text-sm text-muted-foreground">{t("author.audience.empty")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                {rich(t("author.audience.readOfTotal", { ...slots("read"), total: data.total }), {
                  read: <span className="text-lg font-semibold tabular-nums text-foreground">{data.read}</span>,
                })}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
            </div>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-[var(--glass-bg)]"
              role="progressbar"
              aria-label={t("author.audience.progressAria")}
              aria-valuemin={0}
              aria-valuemax={data.total}
              aria-valuenow={data.read}
            >
              <div className="h-full w-full origin-left rounded-full bg-up motion-safe:transition-transform" style={{ transform: `scaleX(${pct / 100})` }} />
            </div>
          </div>

          {unread.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="micro-label">{t("author.audience.unreadList", { count: unread.length })}</span>
              <ul className="-mx-2 flex flex-col">
                {unread.map((m) => <MemberRow key={m.name} m={m} />)}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-up">{t("author.audience.allRead")}</p>
          )}

          {read.length > 0 && (
            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => setShowRead((v) => !v)}
                aria-expanded={showRead}
                className="inline-flex items-center gap-1 self-start text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showRead && "rotate-180")} aria-hidden="true" />
                {t("author.audience.readList", { count: read.length })}
              </button>
              {showRead && (
                <ul className="-mx-2 flex flex-col">
                  {read.map((m) => <MemberRow key={m.name} m={m} />)}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
