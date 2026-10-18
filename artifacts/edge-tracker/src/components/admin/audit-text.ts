/**
 * Human-readable audit entries: «Ориф синхронизировал PropReports: файл …, обновлено 536» instead of
 * `propreports.sync {"runId":3,…}`. Pure functions — unit-tested in audit-text.test.ts.
 * Language-aware: actions, objects, counters and diffs come from the `adminAudit` namespace (current UI language);
 * user content (reasons, file names, topics) passes through untouched; people's names go through personName (Latin in
 * EN / UZ when set), the stored name stays in the data.
 */
import type { Tone } from "@/components/ds";
import { fmtCount, fmtNum, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";
import { adminAuditI18n } from "@/i18n/ns/adminAudit";
import { adminJobsI18n } from "@/i18n/ns/adminJobs";
import { auditValueText, settingLabel } from "./desk-settings-text";
import type { SettingUnit } from "./desk-settings-model";
import RU from "@/i18n/locales/ru/adminAudit";

export interface AuditLike {
  actor: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: string | null;
}

export interface AuditText {
  /** One sentence without the actor, e.g. «заморозил учётку Умид». */
  text: string;
  /** Secondary line: reason / counters / file. */
  detail?: string;
  tone: Tone;
  /** Short category label for the pill. */
  label: string;
}

type Dict = typeof RU;
type ActorKey = keyof Dict["actor"];
type RoleKey = keyof Dict["role"];
type TierKey = Exclude<keyof Dict["tier"], "none">;
type ObjectTypeKey = keyof Dict["objectType"];
type DetailKey = keyof Dict["detailKey"];
type VerbKey = keyof Dict["verb"];
type QueueKindKey = keyof Dict["queueKind"];
type ConsequenceKey = keyof Dict["consequence"];
type LimitFieldKey = keyof Dict["limitField"];

// The function is read at call time (current language); never call it at module scope.
const t = adminAuditI18n.t;
const has = <O extends object>(o: O, k: string): k is Extract<keyof O, string> => Object.prototype.hasOwnProperty.call(o, k);

/** Service actors («import-script», «system», «cron») get a translated name; people get their display name. */
export function actorName(a: string): string {
  return has(RU.actor, a) ? t(`actor.${a as ActorKey}`) : personName(a);
}

/** Object type label for the filter / pill; unknown codes show as is. */
export function objectTypeLabel(type: string): string {
  return has(RU.objectType, type) ? t(`objectType.${type as ObjectTypeKey}`) : type;
}

function roleName(r: unknown): string {
  const k = s(r);
  return has(RU.role, k) ? t(`role.${k as RoleKey}`) : k;
}

function parse(raw: string | null): Record<string, any> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { value: raw };
  }
}

const s = (v: unknown): string => (v == null ? "" : String(v));
/** A person's stored name → display name (empty stays empty). */
const pn = (v: unknown): string => personName(s(v));
const n = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
const reasonOf = (d: Record<string, any>) => s(d.reason || d.comment || d.resolution).trim() || undefined;
const joinDetail = (parts: (string | undefined | null | false)[]) => parts.filter(Boolean).join(" · ") || undefined;

function syncCounters(d: Record<string, any>): string {
  const parts: string[] = [];
  parts.push(t("counters.inserted", { count: n(d.inserted) }));
  parts.push(t("counters.updated", { count: n(d.updated) }));
  if (d.unchanged != null) parts.push(t("counters.unchanged", { count: n(d.unchanged) }));
  if (n(d.skipped)) parts.push(t("counters.skipped", { count: n(d.skipped) }));
  if (n(d.conflicts)) parts.push(t("counters.conflicts", { count: n(d.conflicts) }));
  if (n(d.errors)) parts.push(t("counters.errors", { count: n(d.errors) }));
  return parts.join(", ");
}

/** Object the entry is about, for the «Объект» column / filter. */
export function objectLabel(targetType: string | null, targetId: string | null, d?: Record<string, any>): string {
  if (!targetType) return "";
  const id = targetId ?? "";
  switch (targetType) {
    case "user": return d?.name ? t("object.user", { name: pn(d.name) }) : t("object.userId", { id });
    case "trader_risk_limits": return t("object.trader", { id: personName(id) });
    case "propreports_sync_runs": return id ? t("object.syncRun", { id }) : t("object.syncRuns");
    case "propreports_accounts": return id ? t("object.account", { id }) : t("object.accounts");
    case "propreports_performance_report": return t("object.perfReport", { id });
    case "discussion": return t("object.discussion", { id });
    case "comment": return t("object.comment", { id });
    case "report": return t("object.report", { id });
    case "db": return t("object.db");
    case "backup": return id ? t("object.backupId", { id }) : t("object.backup");
    case "permissions": return t("object.permissions");
    case "setting": return t("object.setting", { name: settingLabel(id) });
    case "risk_alert_log": return t("object.riskAlert", { id });
    case "risk_breach_reviews": return t("object.breachReview", { id });
    case "curator_notes": return t("object.curatorNote", { id });
    case "curator_queue_acks": return t("object.queue");
    case "office_capital": return t("object.officeCapital", { id });
    case "scaling_proposal": return t("object.scalingProposal", { id });
    case "academy_trader_stage": return t("object.stage", { id: personName(id) });
    case "academy_challenge":
    case "academy_challenges": return id ? t("object.challenge", { id }) : t("object.challenges");
    default: return id ? t("object.generic", { type: objectTypeLabel(targetType), id }) : objectTypeLabel(targetType);
  }
}

const HIDDEN_KEYS = new Set(["historyId", "runId", "id", "reportId", "objectName", "closedReports", "changes", "summary", "byKind", "reason", "resync"]);

/**
 * Limits diff parts. The server stores Russian text («дневной нет → $150», «тир нет → trainee»; lib/notifyEventsCore
 * limitsDiff) — parsed here and re-rendered in the UI language; a structured `{ field, from, to }` is accepted too.
 */
// i18n-ignore — parser for the Russian text stored in audit details, not UI copy.
const LEGACY_FIELD: Record<string, LimitFieldKey> = { дневной: "daily", недельный: "weekly", просадка: "drawdown", "риск/сделка": "riskPerTrade", позиция: "position", позиций: "openPositions", тир: "tier" };
// i18n-ignore — Russian tier names the server wrote before tiers were stored as keys.
const LEGACY_TIER: Record<string, TierKey> = { Стажёр: "trainee", Джун: "junior", Трейдер: "trader", Сеньор: "senior", Лид: "lead" };
const LEGACY_NONE = "нет"; // i18n-ignore — «нет» = empty value in stored Russian diffs
const LEGACY_CHANGE = /^(\S+) (.+?) → (.+)$/;

function limitChanges(raw: unknown, tier: (k: unknown) => string): string[] {
  if (!Array.isArray(raw)) return [];
  const value = (field: LimitFieldKey | null, v: unknown): string => {
    const str = s(v);
    if (v == null || str === "" || str === LEGACY_NONE) return t("none");
    if (field === "tier") return tier(LEGACY_TIER[str] ?? str);
    return str;
  };
  return raw.map((c) => {
    if (c && typeof c === "object") {
      const o = c as { field?: string; from?: unknown; to?: unknown };
      const field = o.field && has(RU.limitField, o.field) ? (o.field as LimitFieldKey) : null;
      const money = field != null && field !== "tier" && field !== "openPositions";
      const show = (v: unknown) => (money && v != null && v !== "" && Number.isFinite(Number(v)) ? fmtUsd(Number(v)) : value(field, v));
      return t("limitChange", { field: field ? t(`limitField.${field}`) : s(o.field), from: show(o.from), to: show(o.to) });
    }
    const str = s(c);
    const m = LEGACY_CHANGE.exec(str);
    const field = m ? LEGACY_FIELD[m[1]!] ?? null : null;
    if (!m || !field) return str;
    return t("limitChange", { field: t(`limitField.${field}`), from: value(field, m[2]), to: value(field, m[3]) });
  });
}

export function describeAudit(e: AuditLike, tierNames?: Record<string, string>): AuditText {
  const d = parse(e.details);
  const reason = reasonOf(d);
  const who = pn(d.name) || (e.targetType === "user" ? `#${s(e.targetId)}` : pn(e.targetId));
  const tier = (k: unknown): string => {
    if (!k) return t("tier.none");
    const key = s(k);
    const builtIn = has(RU.tier, key) && key !== "none" ? key as TierKey : null;
    const configured = tierNames?.[key];
    // A tier still named by its seeded Russian default shows the translation; a renamed tier is user content.
    if (configured && !(builtIn && configured === RU.tier[builtIn])) return configured;
    return builtIn ? t(`tier.${builtIn}`) : configured ?? key;
  };
  const bulk = d.bulk ? t("bulk") : "";
  const L = (k: keyof Dict["label"]) => t(`label.${k}`);
  // Previous value of a person field (curator, trader).
  const wasPerson = (v: unknown) => (v ? t("detail.was", { value: pn(v) }) : "");

  switch (e.action) {
    case "user.ban": return { label: L("ban"), tone: "down", text: t("text.ban", { who }), detail: reason };
    case "user.unban": return { label: L("unban"), tone: "up", text: t("text.unban", { who }), detail: reason };
    case "user.freeze": return { label: L("freeze"), tone: "down", text: t("text.freeze", { who, bulk }), detail: reason };
    case "user.unfreeze": return { label: L("unfreeze"), tone: "up", text: t("text.unfreeze", { who, bulk }), detail: reason };
    case "user.archive": return { label: L("archive"), tone: "warn", text: t("text.archive", { who, bulk }), detail: reason };
    case "user.restore": return { label: L("restore"), tone: "up", text: t("text.restore", { who, bulk }), detail: reason };
    case "user.sessions.reset": return { label: L("sessions"), tone: "neutral", text: t("text.sessionsReset", { who, bulk }), detail: reason };
    case "user.create": return {
      label: L("newAccount"), tone: "accent",
      text: t("text.create", { who, role: roleName(d.role || "trader") }),
      detail: joinDetail([d.curator ? t("detail.curator", { name: pn(d.curator) }) : "", reason]),
    };
    case "user.role.change": return {
      label: L("role"), tone: "purple",
      text: d.from ? t("text.roleChange", { who, from: roleName(d.from), to: roleName(d.role) }) : t("text.roleSet", { who, to: roleName(d.role) }),
      detail: reason,
    };
    case "user.curator.assign":
      return d.to
        ? { label: L("curator"), tone: "accent", text: t("text.curatorAssign", { curator: pn(d.to), who, bulk }), detail: joinDetail([wasPerson(d.from), reason]) }
        : { label: L("curator"), tone: "neutral", text: t("text.curatorRemove", { who, bulk }), detail: reason };

    case "report.resolve": {
      const id = s(d.reportId) || s(e.targetId);
      return { label: L("report"), tone: "up", text: id ? t("text.reportResolve", { id }) : t("text.reportResolveNoId"), detail: reason };
    }
    case "report.dismiss": return { label: L("report"), tone: "neutral", text: e.targetId ? t("text.reportDismiss", { id: e.targetId }) : t("text.reportDismissNoId"), detail: reason };
    case "report.ban_author": return { label: L("banByReport"), tone: "down", text: d.author ? t("text.banAuthor", { author: pn(d.author) }) : t("text.banAuthorNoName"), detail: reason };
    case "discussion.delete": {
      const topic = s(d.topic), author = pn(d.author);
      const text = topic && author ? t("text.discussionDeleteTopicAuthor", { topic, author })
        : topic ? t("text.discussionDeleteTopic", { topic })
        : author ? t("text.discussionDeleteAuthor", { author })
        : t("text.discussionDelete");
      return { label: L("moderation"), tone: "down", text };
    }
    case "comment.delete": return { label: L("moderation"), tone: "down", text: d.author ? t("text.commentDeleteAuthor", { author: pn(d.author) }) : t("text.commentDelete") };

    case "propreports.sync": {
      const text = d.source === "file" ? (d.fileName ? t("text.syncFile", { file: s(d.fileName) }) : t("text.syncFileNoName"))
        : d.source === "api" ? t("text.syncApi") : t("text.sync");
      return { label: "PropReports", tone: n(d.errors) ? "down" : "accent", text, detail: syncCounters(d) + (d.errorText ? ` · ${d.errorText}` : "") };
    }
    case "propreports.import": return { label: "PropReports", tone: "accent", text: t("text.import"), detail: syncCounters(d) };
    case "propreports.account.map": return { label: L("accounts"), tone: "accent", text: t("text.accountMap", { account: s(d.account) || s(e.targetId), trader: pn(d.trader) }), detail: joinDetail([wasPerson(d.from), reason]) };
    case "propreports.accounts.update": {
      const list: string[] = Array.isArray(d.accounts) ? d.accounts.map(String) : [];
      return { label: L("accounts"), tone: "accent", text: t("text.accountsUpdate", { count: list.length }), detail: list.slice(0, 6).join(", ") || undefined };
    }
    case "propreports.accounts.delete": return { label: L("accounts"), tone: "warn", text: t("text.accountDelete", { id: s(e.targetId) }) };
    case "propreports.accounts.refresh": return { label: L("accounts"), tone: "neutral", text: t("text.accountsRefresh") };
    case "propreports.settings.update": return { label: "PropReports", tone: "neutral", text: t("text.settingsUpdate") };
    case "propreports.check": return { label: "PropReports", tone: "neutral", text: t("text.check") };
    case "propreports.merge": return { label: L("reconcile"), tone: "accent", text: t("text.merge") };
    case "propreports.keep_separate": return { label: L("reconcile"), tone: "neutral", text: t("text.keepSeparate") };
    case "propreports.dismiss": return { label: L("reconcile"), tone: "neutral", text: t("text.dismiss") };
    case "propreports.performance.replace":
    case "propreports.performance.import":
    case "propreports.performance.upload": {
      const sum = d.summary ?? {};
      const trader = pn(d.trader);
      const period = d.periodFrom ? { from: s(d.periodFrom), to: s(d.periodTo) } : null;
      const text = trader && period ? t("text.perfUploadTraderPeriod", { trader, ...period })
        : trader ? t("text.perfUploadTrader", { trader })
        : period ? t("text.perfUploadPeriod", period)
        : t("text.perfUpload");
      const trades = sum.trades != null ? commonI18n.t("units.trades", { count: Number(sum.trades) }) : null;
      return {
        label: L("perfReport"), tone: "accent", text,
        detail: trades == null ? undefined : sum.net != null ? t("detail.tradesNet", { trades, net: fmtNum(Number(sum.net)) }) : trades,
      };
    }
    case "propreports.performance.delete": return { label: L("perfReport"), tone: "warn", text: t("text.perfDelete", { id: s(e.targetId) }) };

    case "db.export": {
      const count = Array.isArray(d.tables) ? d.tables.length : 0;
      return { label: L("export"), tone: "accent", text: count ? t("text.dbExportTables", { count }) : t("text.dbExport"), detail: d.partial ? t("detail.partialExport") : undefined };
    }
    case "db.backup": return { label: L("backup"), tone: "accent", text: e.actor === "system" ? t("text.backupSystem") : t("text.backupManual"), detail: d.sizeKb ? t("detail.sizeKb", { size: fmtCount(n(d.sizeKb)) }) : undefined };

    case "scaling.assign": return { label: L("tier"), tone: "purple", text: t("text.tierAssign", { tier: tier(d.toTier), trader: pn(e.targetId) }), detail: joinDetail([d.fromTier ? t("detail.wasTier", { tier: tier(d.fromTier) }) : "", reason]) };
    case "scaling.proposal.create": return { label: L("tier"), tone: "neutral", text: d.trader ? t("text.proposalCreateFor", { trader: pn(d.trader) }) : t("text.proposalCreate"), detail: d.toTier ? `→ ${tier(d.toTier)}` : undefined };
    case "scaling.proposal.auto": return { label: L("tier"), tone: "neutral", text: d.trader ? t("text.proposalAutoFor", { trader: pn(d.trader) }) : t("text.proposalAuto"), detail: d.toTier ? `→ ${tier(d.toTier)}` : undefined };
    case "scaling.proposal.approve": return { label: L("tier"), tone: "up", text: d.trader ? t("text.proposalApproveFor", { trader: pn(d.trader) }) : t("text.proposalApprove"), detail: d.toTier ? `→ ${tier(d.toTier)}` : reason };
    case "scaling.proposal.reject": return { label: L("tier"), tone: "neutral", text: d.trader ? t("text.proposalRejectFor", { trader: pn(d.trader) }) : t("text.proposalReject"), detail: reason };
    case "scaling.tiers.update": return { label: L("tiers"), tone: "neutral", text: t("text.tiersUpdate") };
    case "scaling.rules.update": return { label: L("tiers"), tone: "neutral", text: t("text.rulesUpdate") };

    case "permissions.matrix.update": return { label: L("permissions"), tone: "purple", text: t("text.permissionsUpdate"), detail: reason };
    case "settings.update": {
      const setting = settingLabel(s(e.targetId));
      const unit = (d.unit ?? null) as SettingUnit | null;
      return {
        label: L("settings"), tone: "purple",
        text: d.reset ? t("text.deskSettingReset", { setting }) : t("text.deskSettingUpdate", { setting }),
        detail: `${auditValueText(d.from, unit)} → ${auditValueText(d.to, unit)}`,
      };
    }

    case "academy.path.seed_demo": {
      const count = Array.isArray(d.created) ? d.created.length : 0;
      return { label: L("academy"), tone: "neutral", text: count ? t("text.seedDemoCount", { count }) : t("text.seedDemo") };
    }
    case "academy.challenge.create": return { label: L("academy"), tone: "neutral", text: d.user ? t("text.challengeCreateFor", { user: pn(d.user) }) : t("text.challengeCreate"), detail: d.startsOn ? t("detail.startsOn", { date: s(d.startsOn) }) : undefined };
    case "academy.challenge.archive": return { label: L("academy"), tone: "neutral", text: t("text.challengeArchive") };
    case "academy.promotion.request": return { label: L("academy"), tone: "neutral", text: t("text.promotionRequest") };
    case "academy.promotion.approve": return { label: L("academy"), tone: "up", text: t("text.promotionApprove"), detail: reason };
    case "academy.promotion.reject": return { label: L("academy"), tone: "neutral", text: t("text.promotionReject"), detail: reason };
    case "academy.stages.update": return { label: L("academy"), tone: "neutral", text: t("text.stagesUpdate") };
    case "academy.criteria.update": return { label: L("academy"), tone: "neutral", text: t("text.criteriaUpdate") };

    case "risk.limits.template": {
      const changes = limitChanges(d.changes, tier);
      const target = pn(e.targetId) || pn(d.trader);
      return {
        label: L("limits"), tone: "purple",
        text: d.resync ? t("text.limitsResync", { target, tier: tier(d.tierKey) }) : t("text.limitsApply", { tier: tier(d.tierKey), target }),
        detail: joinDetail([
          d.fromTier && d.fromTier !== d.tierKey ? t("detail.wasTierLong", { tier: tier(d.fromTier) }) : "",
          changes.length ? changes.join(", ") : d.resync ? t("detail.limitsMatched") : "",
          reason,
        ]),
      };
    }
    case "risk.breach.review":
    case "risk.breach.review.update": {
      const update = e.action !== "risk.breach.review";
      const trader = pn(d.trader);
      const text = update
        ? (trader ? t("text.breachReviewUpdateFor", { trader }) : t("text.breachReviewUpdate"))
        : (trader ? t("text.breachReviewFor", { trader }) : t("text.breachReview"));
      const cons = s(d.consequence);
      return {
        label: L("breachReview"), tone: "accent", text,
        detail: joinDetail([
          cons ? (has(RU.consequence, cons) ? t(`consequence.${cons as ConsequenceKey}`) : cons) : "",
          n(d.actions) ? t("detail.agreements", { count: n(d.actions) }) : "",
        ]),
      };
    }
    case "risk.breach.review.archive": return { label: L("breachReview"), tone: "neutral", text: d.trader ? t("text.breachReviewArchiveFor", { trader: pn(d.trader) }) : t("text.breachReviewArchive") };
    case "curator.note.archive": return { label: L("note"), tone: "neutral", text: d.trader ? t("text.noteArchiveFor", { trader: pn(d.trader) }) : t("text.noteArchive"), detail: d.author ? t("detail.author", { name: pn(d.author) }) : undefined };
    case "curator.queue.archive_old": {
      const by = d.byKind && typeof d.byKind === "object"
        ? Object.entries(d.byKind as Record<string, unknown>).map(([k, v]) => `${has(RU.queueKind, k) ? t(`queueKind.${k as QueueKindKey}`) : k} ${n(v)}`)
        : [];
      return {
        label: L("queue"), tone: "neutral",
        text: t("text.queueArchive", { count: n(d.archived) }),
        detail: joinDetail([d.olderThanDays ? t("detail.olderThan", { days: n(d.olderThanDays) }) : "", by.join(", ")]),
      };
    }
    case "office_capital.set": return {
      label: L("capital"), tone: "neutral", text: t("text.capitalSet", { date: s(e.targetId) }),
      detail: joinDetail([
        d.capital != null ? t("detail.capital", { value: fmtUsd(n(d.capital), { decimals: "trim" }) }) : "",
        d.goalPct != null ? t("detail.goal", { value: n(d.goalPct) }) : "",
      ]),
    };
    case "academy.stage.assign":
    case "academy.stage.promote":
    case "academy.stage.demote": {
      const kind = e.action.endsWith("promote") ? "promote" : e.action.endsWith("demote") ? "demote" : "assign";
      const params = { who: pn(e.targetId), stage: tier(d.to) };
      const text = kind === "promote" ? t("text.stagePromote", params) : kind === "demote" ? t("text.stageDemote", params) : t("text.stageAssign", params);
      return {
        label: L("stage"), tone: kind === "demote" ? "warn" : kind === "promote" ? "up" : "accent",
        text: text.replace(/\s+/g, " ").trim(),
        detail: d.from ? t("detail.wasStage", { stage: tier(d.from) }) : undefined,
      };
    }

    case "user.name_latin": return d.to
      ? { label: L("latin"), tone: "neutral", text: t("text.latinSet", { who, to: s(d.to) }), detail: d.from ? t("detail.was", { value: s(d.from) }) : undefined }
      : { label: L("latin"), tone: "neutral", text: t("text.latinRemove", { who }), detail: d.from ? t("detail.was", { value: s(d.from) }) : undefined };
    case "jobs.run": {
      const id = s(e.targetId);
      return { label: L("jobs"), tone: "neutral", text: t("text.jobRun", { job: adminJobsI18n.tryT(`names.${id}`) ?? id }) };
    }
    case "curator.queue.restore": return { label: L("queue"), tone: "neutral", text: t("text.queueRestore", { count: n(d.restored) }) };
    case "curator.note.restore": return { label: L("note"), tone: "neutral", text: d.trader ? t("text.noteRestoreFor", { trader: pn(d.trader) }) : t("text.noteRestore") };
    case "auth.lockout": return { label: L("login"), tone: "warn", text: t("text.lockout", { minutes: n(d.minutes) }), detail: e.targetType === "user" ? undefined : s(e.targetId) || undefined };

    case "daily_quote.regenerate": return { label: L("dailyQuote"), tone: "neutral", text: t("text.quoteRegenerate") };
    case "daily_quote.cron": return { label: L("dailyQuote"), tone: "neutral", text: t("text.quoteCron") };
  }

  // Unknown action: readable fallback — translated object + up to three details with translated keys, technical ids hidden.
  const label = (e.targetType && has(RU.objectType, e.targetType) ? objectTypeLabel(e.targetType) : "") || e.action.split(".")[0] || e.action;
  const extras = Object.entries(d)
    .filter(([k, v]) => v != null && v !== "" && typeof v !== "object" && !HIDDEN_KEYS.has(k))
    .slice(0, 3)
    .map(([k, v]) => t("detail.kv", {
      key: has(RU.detailKey, k) ? t(`detailKey.${k as DetailKey}`) : k,
      value: typeof v === "boolean" ? commonI18n.t(v ? "yes" : "no").toLowerCase() : /tier/i.test(k) ? tier(v) : String(v),
    }));
  const obj = e.targetType ? objectLabel(e.targetType, e.targetId, d) : "";
  const parts = e.action.split(".");
  const last = parts[parts.length - 1] ?? "";
  const verb = has(RU.verb, last) ? t(`verb.${last as VerbKey}`) : null;
  const subject = obj || parts.slice(0, -1).join(" ").replace(/_/g, " ");
  return {
    label,
    tone: /delete|ban|fail|error/.test(e.action) ? "down" : "neutral",
    text: verb ? t("text.fallbackVerb", { verb, subject }) : `${parts.join(" ").replace(/_/g, " ")}${obj ? ` · ${obj}` : ""}`,
    detail: joinDetail([reason, ...extras]),
  };
}

/** Full sentence with the actor, used for CSV and screen readers. */
export function auditSentence(e: AuditLike, tierNames?: Record<string, string>): string {
  const x = describeAudit(e, tierNames);
  const actor = actorName(e.actor);
  return x.detail ? t("sentenceDetail", { actor, text: x.text, detail: x.detail }) : t("sentence", { actor, text: x.text });
}
