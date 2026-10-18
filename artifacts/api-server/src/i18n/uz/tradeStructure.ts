import type { Messages } from "../core";
import type ru from "../ru/tradeStructure";

export default {
  role: {
    entry: "Kirish",
    reentry: "Qayta kirish",
    flip: "Teskari ochish",
    add: "Qoʻshimcha kirish",
    partial_exit: "Qisman chiqish",
    exit: "Chiqish",
    stop: "Stop",
  },
  reason: {
    reentryInTrade: "Shu savdo ichida toʻliq chiqishdan keyin yangi kirish",
    markedStop: "Stop deb belgilangan",
    flipIn: "Teskari ochish: qarama-qarshi pozitsiya yopilgan soniyada ochilgan",
    reentryN: "Sessiyada tiker boʻyicha {n}-qayta kirish",
    flipOut: "Teskari ochish: shu soniyada qarama-qarshi pozitsiya ochilgan",
    atStop: "Stop darajasida chiqish {price}",
    atStopFromRisk: "Stop darajasida chiqish {price} ($ riskdan hisoblangan stop)",
    inferredAfterAdd: "Ehtimol stop: pozitsiyaga qarshi oʻrtachalashdan keyin 5 daqiqa ichida zarar bilan chiqish",
    inferredAtWorst: "Ehtimol stop: savdoning eng yomon narxi yonida zarar bilan chiqish ({price}, pasayishning {pct}% berildi)",
  },
  note: {
    averages: "Trades hisobotidagi savdo: faqat oʻrtacha kirish va chiqish narxlari maʼlum, alohida qoʻshimcha kirishlar va qisman chiqishlar koʻrinmaydi. Fills boʻyicha sinxronlash har bir ijroni koʻrsatadi.",
    scaledEntry: "Oʻrtacha kirish narxi {price} butun sentga teng emas — kirish kamida ikkita turli narxdagi ijrodan iborat (qoʻshimcha kirish yoki qismlab ijro).",
    scaledExit: "Oʻrtacha chiqish narxi {price} butun sentga teng emas — chiqish kamida ikkita turli narxdagi ijrodan iborat (qisman chiqish yoki qismlab ijro).",
    carry: "Pozitsiya oldingi sessiyadan oʻtgan: kirishlarning bir qismi yuklangan ijrolardan oldin boʻlgan.",
    unknownCarry: "Ochiq pozitsiyasiz yopuvchi ijrolar bor — kirish yuklangan davrdan oldin boʻlgan.",
    noQty: "Ayrim ijrolarda miqdor yoʻq — pozitsiya va bosqichlar boʻyicha $ hisoblanmaydi.",
    split: { one: "Bitta orderning qismlab ijrolari bitta bosqichga birlashtirildi ({count} ta qoʻshimcha ijro).", other: "Bitta orderning qismlab ijrolari bitta bosqichga birlashtirildi ({count} ta qoʻshimcha ijro)." },
  },
  summary: {
    flip: "burilish",
    reentry: "{n}-qayta kirish",
    adds: { one: "{count} ta qoʻshimcha kirish", other: "{count} ta qoʻshimcha kirish" },
    scaledEntry: "boʻlib kirish",
    partials: { one: "{count} ta qisman chiqish", other: "{count} ta qisman chiqish" },
    scaledExit: "boʻlib chiqish",
    stop: "stop",
    stopInferred: "stop?",
    flipOut: "→ burilish",
  },
} satisfies Messages<typeof ru>;
