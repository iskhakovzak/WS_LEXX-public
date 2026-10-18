/**
 * Connection status hero: configured (domain, auth mode, scheduler, last/next sync) or
 * "not configured" with the exact env var names for .env.local. Never shows or asks for secrets.
 */
import { Clock, KeyRound, Plug, PlugZap, Server } from "lucide-react";
import { Pill, StatCard, StatGrid } from "@/components/ds";
import { Kbd } from "@/components/ds";
import { agoText, runStatusLabel, untilText, type Status } from "./api";
import { fmtCount } from "@/lib/format";
import { propreportsI18n } from "@/i18n/ns/propreports";

export function StatusHero({ status, actions }: { status: Status; actions?: React.ReactNode }) {
  const { t } = propreportsI18n.useT();
  const { config, scheduler, accounts, trades, lastRun, connection } = status;
  const lastSync = trades.lastSyncedAt ?? accounts.lastSyncedAt ?? lastRun?.finishedAt ?? null;
  return (
    <section className="glass-panel rounded-2xl p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className={`glass-panel grid h-11 w-11 shrink-0 place-items-center rounded-xl ${config.configured ? "text-up" : "text-muted-foreground"}`}>
            {config.configured ? <PlugZap className="h-5 w-5" aria-hidden="true" /> : <Plug className="h-5 w-5" aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">PropReports</h2>
              {config.configured ? <Pill tone="up" dot>{t("hero.apiConfigured")}</Pill> : <Pill tone="warn" dot>{t("hero.apiNotConfigured")}</Pill>}
              {config.configured && (connection.ok === true
                ? <Pill tone="accent">{connection.mode === "v2" ? t("hero.modeV2") : t("hero.modeLegacy")}{connection.version ? ` · v${connection.version}` : ""}</Pill>
                : connection.ok === false ? <Pill tone="down" dot>{t("hero.connError")}</Pill> : <Pill tone="neutral">{t("hero.connUnchecked")}</Pill>)}
              {scheduler.enabled && <Pill tone="accent">{t("hero.autoEvery", { minutes: scheduler.minutes ?? 0 })}</Pill>}
              {scheduler.running && <Pill tone="accent">{t("hero.running")}</Pill>}
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {config.configured
                ? <>{t("hero.host")} <span className="font-mono text-foreground">{config.domain}</span> · {config.authMode === "token" ? t("hero.authToken") : t("hero.authLogin")}{config.groupId ? <> · {t("hero.group", { id: config.groupId })}</> : null}{config.accountIds.length ? <> · {t("hero.accountsList", { list: config.accountIds.join(", ") })}</> : null}</>
                : t("hero.notConfiguredText")}
            </p>
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>

      {!config.configured && (
        <div className="mt-4 rounded-xl border border-dashed border-[var(--glass-border)] p-3 text-sm">
          <div className="mb-2 flex items-center gap-2 text-muted-foreground"><KeyRound className="h-4 w-4" aria-hidden="true" /> {t("hero.envTitle")}</div>
          <ul className="grid gap-1 font-mono text-xs sm:grid-cols-2">
            <li><Kbd>PROPREPORTS_DOMAIN</Kbd> <span className="font-sans text-muted-foreground">{t("hero.env.domain")}</span></li>
            <li><Kbd>PROPREPORTS_TOKEN</Kbd> <span className="font-sans text-muted-foreground">{t("hero.env.token")}</span></li>
            <li><Kbd>PROPREPORTS_USER</Kbd> + <Kbd>PROPREPORTS_PASSWORD</Kbd> <span className="font-sans text-muted-foreground">{t("hero.env.login")}</span></li>
            <li><Kbd>PROPREPORTS_GROUP_ID</Kbd> / <Kbd>PROPREPORTS_ACCOUNT_IDS</Kbd> <span className="font-sans text-muted-foreground">{t("hero.env.scope")}</span></li>
            <li><Kbd>PROPREPORTS_SYNC_MINUTES</Kbd> <span className="font-sans text-muted-foreground">{t("hero.env.sync")}</span></li>
          </ul>
          {!!config.missing.length && <p className="mt-2 text-xs text-[hsl(var(--chart-3))]">{t("hero.missing", { list: config.missing.join(", ") })}</p>}
        </div>
      )}

      <StatGrid className="mt-4">
        <StatCard icon={Clock} label={t("hero.lastSync")} value={lastSync ? agoText(lastSync) : t("never")} hint={lastRun ? t("hero.lastRunHint", { source: lastRun.source === "api" ? "API" : t("file"), status: runStatusLabel(lastRun.status) }) : undefined} tone={lastRun?.status === "error" ? "down" : "neutral"} />
        <StatCard icon={Server} label={t("hero.nextAuto")} value={scheduler.enabled ? untilText(scheduler.nextRunAt) : t("hero.off")} hint={scheduler.enabled ? t("hero.every", { minutes: scheduler.minutes ?? 0 }) : t("hero.notSet")} />
        <StatCard label={t("hero.accountsTitle")} value={`${accounts.mapped} / ${accounts.total}`} hint={accounts.unmapped.length ? t("hero.unmapped", { list: accounts.unmapped.join(", ") }) : t("hero.allMapped")} tone={accounts.unmapped.length ? "warn" : "neutral"} />
        <StatCard label={t("hero.imported")} value={fmtCount(Number(trades.imported))} hint={trades.legacyWithoutId ? t("hero.legacy", { count: trades.legacyWithoutId }) : status.pendingCount ? t("hero.pending", { count: status.pendingCount }) : t("hero.synced")} tone={status.pendingCount ? "warn" : "neutral"} />
      </StatGrid>
    </section>
  );
}
