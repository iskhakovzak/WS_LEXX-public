import type { Messages } from "../core";
import type ru from "../ru/benchmark";

export default {
  metric: {
    net: {
      label: "Sof",
      hint: "Σ (pnl − |komissiyalar|)",
    },
    expectancy: {
      label: "Kutilma $",
      hint: "Sof / $ li savdolar",
    },
    winRate: {
      label: "Win rate",
      hint: "W / (W + L), nolda yopilganlar hisobga olinmaydi",
    },
    profitFactor: {
      label: "PF",
      hint: "Σ sof⁺ / |Σ sof⁻|; zarar yoʻq → —",
    },
    payoff: {
      label: "Foyda / zarar",
      hint: "Oʻrtacha foyda / |oʻrtacha zarar|",
    },
    sharpe: {
      label: "Sharpe",
      hint: "Oʻrtacha / kunlik sofning σ × √252 (≥ 5 kun)",
    },
    sortino: {
      label: "Sortino",
      hint: "Oʻrtacha / pastga σ × √252 (≥ 5 kun)",
    },
    dailyVol: {
      label: "Kunlik volatillik",
      hint: "Kunlik sofning σ",
    },
    maxDd: {
      label: "Maks. pasayish",
      hint: "Kunlik sof egri chizigʻining choʻqqisi → tubi",
    },
    recoveryDays: {
      label: "Tiklanish",
      hint: "Tubdan oldingi choʻqqigacha savdo kunlari",
    },
    greenShare: {
      label: "Yashil kunlar",
      hint: "Sof > 0 boʻlgan kunlar ulushi",
    },
    bestDayShare: {
      label: "Eng yaxshi kun / foyda",
      hint: "Barqarorlik qoidasi: > 30% — diqqat, > 40% — buzilish",
    },
    feeShare: {
      label: "Komissiyalar / yalpi",
      hint: "Komissiyaga ketgan yalpi foyda ulushi",
    },
    tradesPerDay: {
      label: "Kuniga savdolar",
      hint: "Savdolar / savdo kunlari (neytral: faollik)",
    },
    maxLossStreak: {
      label: "Zararlar seriyasi",
      hint: "Zararli savdolarning eng uzun seriyasi",
    },
    avgHoldMin: {
      label: "Ushlab turish",
      hint: "Pozitsiyadagi oʻrtacha vaqt (neytral)",
    },
    first15Share: {
      label: "Birinchi 15 daqiqa",
      hint: "9:30–9:45 ET kirishlar ulushi (neytral)",
    },
    expectancyR: {
      label: "Kutilma R",
      hint: "Faqat stop / riskli savdolar",
    },
  },
  badge: {
    consistencyBreach: "Bitta kun butun davrni belgilaydi",
    consistencyBreachDetail: "Eng yaxshi kun {day} = foydaning {share} i (> 40%)",
    consistencyWarn: "Barqarorlik chegarada",
    consistencyWarnDetail: "Eng yaxshi kun = foydaning {share} i (> 30%)",
    consistencyOk: "Barqaror foyda",
    consistencyOkDetail: "Eng yaxshi kun = foydaning {share} i",
    fees: "Komissiyalar yeb qoʻyadi",
    feesDetail: "Yalpining {share} i komissiyaga ketadi",
    pfHigh: "Yuqori PF",
    pfLow: "PF < 1",
    pfLowDetail: "PF {pf} — tizim yoʻqotmoqda",
    payoff: "Foydani kesadi, zararni ushlaydi",
    payoffDetail: "Oʻrtacha foyda / oʻrtacha zarar {value}",
    streak: "Uzun zararlar seriyalari",
    streakDetail: "Ketma-ket {n} ta zarar",
    open: "Ochilishda zarar",
    openDetail: "9:30–9:45 da {n} ta kirish, sof {net} $",
    dd: "Hali pasayishda",
    ddDetail: "{value} $ choʻqqi tiklanmagan",
    hold: "Zararlarni uzoq ushlaydi",
    holdDetail: "Zararni {loss} daq, foydani {win} daq ushlaydi",
    top: "{metric}: desk yetakchisi",
    bottom: "{metric}: desk quyi qismi",
    percentile: "Persentil {p}",
  },
} satisfies Messages<typeof ru>;
