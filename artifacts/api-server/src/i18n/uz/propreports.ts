import type { Messages } from "../core";
import type ru from "../ru/propreports";

export default {
  notify: {
    kind: {
      import: "Import",
      sync: "Sinxronlash",
    },
    title: "PropReports {kindLower}: {head}",
    inserted: { one: "+{count} ta yangi", other: "+{count} ta yangi" },
    noneNew: "yangilari yoʻq",
    updated: "{count} ta yangilandi",
    unchanged: "{count} ta oʻzgarishsiz",
    skipped: "{count} ta oʻtkazib yuborildi",
    conflicts: "{count} ta solishtirishga",
    errors: "{count} ta xato",
    errorsWithText: "{count} ta xato ({text})",
    listSep: ", ",
    bodySep: " · ",
    done: "Savdolar sinxronlandi",
    unmatchedTitle: { one: "Treydersiz {count} ta hisob", other: "Treydersiz {count} ta hisob" },
    unmatchedBody: "{accounts} — savdolar import qilinmadi, hisoblarni «Integratsiyalar»da bogʻlang",
    unmatchedMore: "{accounts} va yana {more} ta",
  },
  wizard: {
    env: {
      ok: "{domain} · {auth}",
      token: "API tokeni",
      login: "login/parol",
      missing: ".env.local da berilmagan: {vars}",
      or: "{token} (yoki {user} + {password})",
    },
    connection: {
      v2: "API v2 (token)",
      legacy: "legacy login",
      version: " · versiya {version}",
      error: "Xato: {error}",
      unknown: "nomaʼlum",
      unchecked: "Tekshirilmagan",
    },
    accounts: {
      none: "Hisoblar hali qoʻshilmagan",
      linked: "{linked}/{total} bogʻlangan",
      noTrader: " · treydersiz: {n}",
      unmatched: " · moslanmagan: {n}",
    },
    fees: {
      columns: { one: "{count} ta ustun, {included} tasi hisoblanadi", other: "{count} ta ustun, {included} tasi hisoblanadi" },
      confirmed: " · tasdiqlangan",
      unconfirmed: " · tasdiqlanmagan",
      empty: "Ustunlar birinchi import/sinxronlashdan keyin paydo boʻladi",
    },
    firstSync: {
      trades: { one: "Brokerdan {count} ta savdo", other: "Brokerdan {count} ta savdo" },
      none: "Hali birorta import boʻlmagan",
    },
  },
  perfNote: "Bu umumlashgan hisobot: undan jurnalga savdolar yaratilmaydi. Savdolar uchun Trades yoki Fills eksporti kerak.",
  fee: {
    comm: "Komissiya",
    clr: "Kliring",
    misc: "Boshqa",
  },
  conn: {
    domainInvalid: "{name} da yaroqsiz belgilar bor",
    noCredentials: "PropReports tokeni ham, login/paroli ham yoʻq",
    loginUnexpected: "PropReports login: kutilmagan javob",
    tokenRejected: "Token rad etildi ({status}). Agar firma hali legacy API da boʻlsa — {user} va {password} ni qoʻshing.",
    authRejected: "Avtorizatsiya rad etildi ({status}): {error}",
  },
  parse: {
    fillsColumns: "Ustunlar topilmadi: {cols}. PropReports dan Fills CSV kutilmoqda (Date/Time, Account, B/S, Qty, Symbol, Price…)",
    badDate: "Tushunarsiz sana/vaqt: \"{value}\"",
    badSide: "Nomaʼlum B/S yoʻnalishi: \"{value}\"",
    badQty: "Notoʻgʻri miqdor: \"{value}\"",
    badPrice: "Notoʻgʻri narx: \"{value}\"",
    emptySymbol: "Simvol boʻsh",
  },
  perf: {
    noAverages: "«Per Trade Averages» bloki topilmadi",
    noHeader: "Wins/Losses/Totals jadval sarlavhasi topilmadi",
    rowSkipped: "{n}-qator oʻtkazib yuborildi: «{text}»",
    noTotal: "Jami qatori yoʻq — summalar tikerlar boʻyicha hisoblandi",
    empty: "Faylda birorta statistika qatori yoʻq",
  },
} satisfies Messages<typeof ru>;
