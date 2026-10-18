/** Server namespaces. Add one per area: `export const <area>T = defineNamespace(ru<Area>, { en: en<Area>, uz: uz<Area> });` */
import { defineNamespace } from ".";
import ruCommon from "./ru/common";
import enCommon from "./en/common";
import uzCommon from "./uz/common";
import ruErrors from "./ru/errors";
import enErrors from "./en/errors";
import uzErrors from "./uz/errors";
import ruNotifications from "./ru/notifications";
import enNotifications from "./en/notifications";
import uzNotifications from "./uz/notifications";
import ruAdmin from "./ru/admin";
import enAdmin from "./en/admin";
import uzAdmin from "./uz/admin";
import ruRisk from "./ru/risk";
import enRisk from "./en/risk";
import uzRisk from "./uz/risk";
import ruPropreports from "./ru/propreports";
import enPropreports from "./en/propreports";
import uzPropreports from "./uz/propreports";
import ruScaling from "./ru/scaling";
import enScaling from "./en/scaling";
import uzScaling from "./uz/scaling";
import ruTradeStructure from "./ru/tradeStructure";
import enTradeStructure from "./en/tradeStructure";
import uzTradeStructure from "./uz/tradeStructure";
import ruDiscussions from "./ru/discussions";
import enDiscussions from "./en/discussions";
import uzDiscussions from "./uz/discussions";
import ruReview from "./ru/review";
import enReview from "./en/review";
import uzReview from "./uz/review";
import ruTelegram from "./ru/telegram";
import enTelegram from "./en/telegram";
import uzTelegram from "./uz/telegram";
import ruFeed from "./ru/feed";
import enFeed from "./en/feed";
import uzFeed from "./uz/feed";
import ruInsights from "./ru/insights";
import enInsights from "./en/insights";
import uzInsights from "./uz/insights";
import ruWhatif from "./ru/whatif";
import enWhatif from "./en/whatif";
import uzWhatif from "./uz/whatif";
import ruDayReport from "./ru/dayReport";
import enDayReport from "./en/dayReport";
import uzDayReport from "./uz/dayReport";
import ruDigest from "./ru/digest";
import enDigest from "./en/digest";
import uzDigest from "./uz/digest";
import ruBenchmark from "./ru/benchmark";
import enBenchmark from "./en/benchmark";
import uzBenchmark from "./uz/benchmark";
import ruOfferings from "./ru/offerings";
import enOfferings from "./en/offerings";
import uzOfferings from "./uz/offerings";
import ruReconcile from "./ru/reconcile";
import enReconcile from "./en/reconcile";
import uzReconcile from "./uz/reconcile";
import ruJuniorReview from "./ru/juniorReview";
import enJuniorReview from "./en/juniorReview";
import uzJuniorReview from "./uz/juniorReview";
import ruMarketbrief from "./ru/marketbrief";
import enMarketbrief from "./en/marketbrief";
import uzMarketbrief from "./uz/marketbrief";
import ruActivity from "./ru/activity";
import enActivity from "./en/activity";
import uzActivity from "./uz/activity";
import ruEvents from "./ru/events";
import enEvents from "./en/events";
import uzEvents from "./uz/events";
import ruPlaybook from "./ru/playbook";
import enPlaybook from "./en/playbook";
import uzPlaybook from "./uz/playbook";
import ruCalendar from "./ru/calendar";
import enCalendar from "./en/calendar";
import uzCalendar from "./uz/calendar";
import ruDaily from "./ru/daily";
import enDaily from "./en/daily";
import uzDaily from "./uz/daily";

export const commonT = defineNamespace(ruCommon, { en: enCommon, uz: uzCommon });

/** `errors`: one text per API error code (src/lib/http/errors.ts ERROR_CODES). Used by the error middleware. */
export const errorsT = defineNamespace(ruErrors, { en: enErrors, uz: uzErrors });

/** `notifications`: notification texts stored as type + params (lib/notificationText.ts renderNotification). */
export const notificationsT = defineNamespace(ruNotifications, { en: enNotifications, uz: uzNotifications });

/** `admin` (server-b). */
export const adminT = defineNamespace(ruAdmin, { en: enAdmin, uz: uzAdmin });

/** `risk` (server-b). */
export const riskT = defineNamespace(ruRisk, { en: enRisk, uz: uzRisk });

/** `propreports` (server-b). */
export const propreportsT = defineNamespace(ruPropreports, { en: enPropreports, uz: uzPropreports });

/** `scaling` (server-b). */
export const scalingT = defineNamespace(ruScaling, { en: enScaling, uz: uzScaling });

/** `tradeStructure` (server-b). */
export const tradeStructureT = defineNamespace(ruTradeStructure, { en: enTradeStructure, uz: uzTradeStructure });

/** `discussions` (server-b). */
export const discussionsT = defineNamespace(ruDiscussions, { en: enDiscussions, uz: uzDiscussions });

/** `review` (server-b). */
export const reviewT = defineNamespace(ruReview, { en: enReview, uz: uzReview });

/** `telegram` (server-b). */
export const telegramT = defineNamespace(ruTelegram, { en: enTelegram, uz: uzTelegram });

/** `feed` (server-b). */
export const feedT = defineNamespace(ruFeed, { en: enFeed, uz: uzFeed });

/** `insights` (server-b). */
export const insightsT = defineNamespace(ruInsights, { en: enInsights, uz: uzInsights });

/** `whatif` (server-b). */
export const whatifT = defineNamespace(ruWhatif, { en: enWhatif, uz: uzWhatif });

/** `dayReport` (server-b). */
export const dayReportT = defineNamespace(ruDayReport, { en: enDayReport, uz: uzDayReport });

/** `digest` (server-b). */
export const digestT = defineNamespace(ruDigest, { en: enDigest, uz: uzDigest });

/** `benchmark` (server-b). */
export const benchmarkT = defineNamespace(ruBenchmark, { en: enBenchmark, uz: uzBenchmark });

/** `offerings` (server-b). */
export const offeringsT = defineNamespace(ruOfferings, { en: enOfferings, uz: uzOfferings });

/** `reconcile` (server-b). */
export const reconcileT = defineNamespace(ruReconcile, { en: enReconcile, uz: uzReconcile });

/** `juniorReview` (server-b). */
export const juniorReviewT = defineNamespace(ruJuniorReview, { en: enJuniorReview, uz: uzJuniorReview });

/** `marketbrief` (server-b). */
export const marketbriefT = defineNamespace(ruMarketbrief, { en: enMarketbrief, uz: uzMarketbrief });

/** `activity` (server-b). */
export const activityT = defineNamespace(ruActivity, { en: enActivity, uz: uzActivity });

/** `events` (server-b). */
export const eventsT = defineNamespace(ruEvents, { en: enEvents, uz: uzEvents });

/** `playbook` (server-b). */
export const playbookT = defineNamespace(ruPlaybook, { en: enPlaybook, uz: uzPlaybook });

/** `calendar` (server-b). */
export const calendarT = defineNamespace(ruCalendar, { en: enCalendar, uz: uzCalendar });

/** `daily`: daily loop (lib/daily/*): mistake names, focus lines, verdicts, own contract, Telegram cards. */
export const dailyT = defineNamespace(ruDaily, { en: enDaily, uz: uzDaily });
