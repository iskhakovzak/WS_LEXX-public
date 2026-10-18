import type { Messages } from "../core";
import type ru from "../ru/scaling";

export default {
  metric: {
    trades: {
      label: "Yopilgan savdolar",
      hint: "Oynadagi yopilgan savdolar soni",
    },
    net_pnl: {
      label: "Sof P&L",
      hint: "Yopilgan savdolar boʻyicha Σ (pnl − komissiyalar); broker maʼlumotlari boʻlsa, shular",
    },
    net_r: {
      label: "Jami R",
      hint: "Yopilgan savdolar boʻyicha Σ signed R",
    },
    profit_factor: {
      label: "Profit factor",
      hint: "Σ foyda / |Σ zarar| ($ boʻlsa, aks holda R); zarar boʻlmasa ⇒ maʼlumot yoʻq",
    },
    win_rate: {
      label: "Win rate",
      hint: "Foydali / (foydali + zararli), nolda yopilganlar hisobga olinmaydi",
    },
    expectancy_r: {
      label: "Kutilma, R",
      hint: "Yopilgan savdo boshiga oʻrtacha signed R",
    },
    green_weeks: {
      label: "Ketma-ket yashil haftalar",
      hint: "Sof natijasi musbat boʻlgan ketma-ket haftalar (joriy toʻliq boʻlmagan hafta faqat foydada boʻlsa hisoblanadi)",
    },
    green_days_pct: {
      label: "Yashil kunlar ulushi",
      hint: "Foydali kunlar / yopilgan savdoli kunlar",
    },
    max_dd_usd: {
      label: "Maks. pasayish, $",
      hint: "Oynadagi jamlangan sof P&L choʻqqidan pastgacha (kunlar boʻyicha)",
    },
    max_dd_pct: {
      label: "Pasayish, limitdan %",
      hint: "Oyna maks. pasayishi / maks. pasayish limiti (treyder yoki daraja limitlaridan)",
    },
    limit_breaches: {
      label: "Limit buzilishlari",
      hint: "Zarari kunlik limitdan oshgan kunlar + haftalikdan oshgan haftalar",
    },
    red_streak: {
      label: "Ketma-ket qizil kunlar",
      hint: "Zararli kunlarning joriy seriyasi",
    },
    discipline: {
      label: "Intizom (baho)",
      hint: "Oyna haftalari boʻyicha kuratorning oʻrtacha «intizom» bahosi (1–10)",
    },
    rating_overall: {
      label: "Umumiy baho",
      hint: "Oyna haftalari boʻyicha kuratorning oʻrtacha umumiy bahosi (1–10)",
    },
    violations: {
      label: "Qoidabuzarliklar va xatolar",
      hint: "Oynadagi rule_violations + trading_errors yozuvlari",
    },
  },
  unit: {
    abs: "mutlaq qiymat",
    x_daily_limit: "× kunlik zarar limiti",
    pct_account: "hisob hajmidan %",
  },
  note: {
    noLimits: "limitlar belgilanmagan",
    broker: "broker maʼlumotlari boʻyicha",
    journal: "jurnal boʻyicha",
    noMoney: "$ boʻyicha maʼlumot yoʻq",
    noLosses: "zararli savdolar yoʻq",
    noTrades: "savdolar yoʻq",
    byR: "R boʻyicha",
    byUsd: "$ boʻyicha",
    noDdLimit: "pasayish limiti belgilanmagan",
    noRatings: "kurator baholari yoʻq",
    ratings: { one: "{count} ta baho", other: "{count} ta baho" },
    noData: "maʼlumot yoʻq",
  },
  rule: {
    na: "{label}: chegara aniqlanmagan ({why})",
    noDailyLimit: "kunlik limit yoʻq",
    noAccount: "hisob hajmi yoʻq",
    noValue: "{label}: {note}",
    value: "{label}: {actual} (kerak {op} {threshold})",
  },
  reason: {
    tierMissing: "«{tier}» darajasi zinapoyada topilmadi",
    noTier: "Daraja tayinlanmagan — birinchi pogʻonadan boshlang",
    noLowerTier: "Pasaytirish qoidalari ishladi, lekin pastroq daraja yoʻq — kurator bilan tahlil kerak",
    allMet: "Koʻtarilishning barcha {count} ta sharti bajarildi",
    topTier: "Barcha shartlar bajarildi — bu eng yuqori daraja",
    noPromoteRules: "Bu daraja uchun faol koʻtarilish qoidalari yoʻq",
    missing: "Koʻtarilishning {total} ta shartidan {missing} tasi bajarilmagan",
    manual: "Kuratorning qoʻlda kiritilgan taklifi",
    manualWith: "Kuratorning qoʻlda kiritilgan taklifi: {comment}",
  },
  action: {
    promote: "Koʻtarilish",
    demote: "Pasaytirish",
    assign: "Tayinlash",
  },
  noTier: "darajasiz",
  assignDecision: "Daraja qoʻlda tayinlandi",
  notify: {
    proposalTitle: "{trader}: {action} {from} → {to}",
    proposalAuto: "Qoidalar boʻyicha avtomatik taklif",
    proposalBy: "{actor} taklif qildi",
    withReasons: "{text}: {reasons}",
    change: "«{tier}»gacha {actionLower}",
    approvedBody: "{change} maʼqullandi ({actor})",
    rejectedBody: "{change} rad etildi ({actor})",
    newLimits: ". Yangi limitlar: {limits}",
    quoteAfterApproved: ". «{comment}»",
    quoteAfterRejected: ": «{comment}»",
    approvedTitle: "Masshtablash maʼqullandi",
    rejectedTitle: "Masshtablash rad etildi",
    staffApproved: "{trader}: maʼqullandi",
    staffRejected: "{trader}: rad etildi",
    assignTitle: "Daraja oʻzgardi: {from} → {to}",
    assignBody: "{actor}: «{tier}» darajasi tayinlandi",
    limits: ". Limitlar: {limits}",
  },
  templateResync: "Limitlar daraja shabloniga moslashtirildi",
  templateDecision: "Daraja shablon boʻyicha tayinlandi",
} satisfies Messages<typeof ru>;
