import type { Messages } from "../core";
import type ru from "../ru/review";

export default {
  quote: "«{text}»",
  eod: {
    closedTitle: "Kun yopildi: {trader}, {date}",
    closedBody: "{parts} — tahlil kutilmoqda",
    trades: { one: "{count} ta savdo", other: "{count} ta savdo" },
    net: "sof {net}",
    discipline: "intizom {value}/5",
    overdueTitle: "Tahlil kechikdi: {trader}, {date}",
    overdueBody: "Kun {hours} soatdan beri tahlil kutmoqda (SLA {sla} soat)",
    reviewedTitle: "Kun tahlili {date}: {score}/5",
    reviewedBy: "{reviewer} bahosi",
    reviewedComment: "{reviewer}: «{comment}»",
  },
  rating: {
    newTitle: "Haftalik baho {week}: {overall}/10",
    updatedTitle: "Baho yangilandi {week}: {overall}/10",
    focus: " · fokus: «{focus}»",
    comment: " · «{comment}»",
    ackTitle: "Baho tasdiqlandi: {trader}",
    ackBody: "Hafta {week}: {overall}/10",
    ackBy: " ({acker} belgiladi)",
  },
  weekly: {
    submittedTitle: "Haftalik hisobot {week}: {trader}",
    mood: "Kayfiyat {mood}/5. ",
    focus: "Fokus: «{focus}»",
    awaiting: "Oʻz-oʻzini baholash tahlil kutmoqda",
    readyTitle: "Hafta tahlili tayyor {week}",
    updatedTitle: "Hafta tahlili yangilandi {week}",
    score: ": {score}/10",
    goals: { one: " · haftaga {count} ta maqsad", other: " · haftaga {count} ta maqsad" },
    comment: " · «{comment}»",
  },
  rubric: {
    discipline: {
      label: "Intizom",
      hint: "Kun rejasi, stopga rioya, tiltsiz",
    },
    riskManagement: {
      label: "Risk-menejment",
      hint: "Savdo boshiga risk, kunlik limit, oʻlcham",
    },
    execution: {
      label: "Ijro",
      hint: "Reja boʻyicha kirish, R-profil, slippage",
    },
    journaling: {
      label: "Jurnal",
      hint: "Yozuvli kunlar, gʻoyalar, xatolar tahlili",
    },
    improvement: {
      label: "Rivojlanish",
      hint: "Oʻtgan haftaga nisbatan oʻzgarish, fokus ustida ishlash",
    },
  },
  formula: {
    winRate: "W / (W + L), nolda yopilganlar hisobga olinmaydi",
    avgRRubric: "ΣR / yopilgan savdolar soni (ishorali R, ±20 cheklov)",
    profitFactorRubric: "ΣR⁺ / |ΣR⁻| (zarar boʻlmasa null)",
    netRubric: "Sof P&L = yalpi − |komissiyalar|; sana = exit_date ?? date (NY)",
    avgR: "ΣR / yopilganlar (win+loss+be)",
    profitFactor: "ΣR⁺ / |ΣR⁻|",
    net: "sof = yalpi − |komissiyalar|; hafta yopilish sanasi boʻyicha (NY)",
  },
  breach: {
    avgRisk: "Savdo boshiga oʻrtacha risk limitdan yuqori",
    dailyLimit: "Kunlik zarar limiti oshib ketdi",
    bigLoss: "{r}R zarar — stopga rioya qilinmagan",
  },
  archive: {
    rule_disabled: "qoida oʻchirilgan",
    rule_deleted: "qoida oʻchirib tashlangan",
    stale: "dolzarb emas",
  },
  hours: {
    pre: "9:30 gacha",
    post: "16 dan keyin",
  },
  ideas: {
    noTrader: "(koʻrsatilmagan)",
    formulaWinRate: "W/(W+L), nolda yopilganlar hisobga olinmaydi",
    formulaNet: "sof = yalpi − komissiyalar",
  },
} satisfies Messages<typeof ru>;
