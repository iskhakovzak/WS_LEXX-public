import type { Messages } from "../../core";
import type ru from "../ru/deskDay";

export default {
  title: "Tikerdagi desk",
  desc: "Butun deskning shu kundagi savdolari bitta grafikda — hamkasblarning bozorning ayni paytidagi kirish va chiqishlaridan oʻrganing",
  descFor: "{ticker} · {date}: butun deskning savdolari bitta grafikda",
  form: {
    ticker: "Tiker",
    date: "Sana",
    show: "Koʻrsatish",
    hint: "Tiker va savdo kunini tanlang — desk treyderlarining barcha savdolarini bitta grafikda koʻrasiz.",
  },
  prevDay: "Oldingi kun",
  nextDay: "Keyingi kun",
  loading: "Desk savdolari yuklanmoqda…",
  noCandles: "Bu kun uchun shamlar yoʻq — grafik mavjud emas.",
  chartAria: "{ticker} grafigi, {date}, desk savdolari bilan",
  tf: "Taymfreym",
  empty: {
    title: "Bu kuni {ticker} boʻyicha desk savdolari yoʻq",
    desc: "Boshqa kun yoki tikerni tanlang.",
  },
  guest: {
    title: "Faqat desk aʼzolari uchun",
    desc: "Hamkasblar savdolarini koʻrish uchun oʻz akkauntingiz bilan kiring.",
  },
  legend: {
    title: "Treyderlar",
    count: { one: "{count} treyder", other: "{count} treyder" },
    all: "Hammasi",
    me: "men",
    focus: "{name} savdolarini ajratish",
    trades: { one: "{count} savdo", other: "{count} savdo" },
    window: "{from}–{to} ET",
    hold: "pozitsiyada {time}",
    added: "pozitsiyaga qarshi qoʻshgan",
    moneyHidden: "$ va hajmlar faqat savdo egasi va kuratorlarga koʻrinadi.",
  },
  result: { win: "Foyda", loss: "Zarar", be: "Nolda", open: "Ochiq" },
  side: { both: "Long + Short" },
  key: "Belgilar",
  tip: {
    qty: "{qty} dona",
    pieces: { one: "{count} qism", other: "{count} qism" },
    move: "aksiyaga {move}",
  },
  takeaway: {
    label: "Xulosa",
    best: "Eng yaxshi natija — {name}: {r}, {side}, kirish {time} ET ({min} daq ochilishdan keyin)",
    bestPre: "Eng yaxshi natija — {name}: {r}, {side}, kirish {time} ET, ochilishdan oldin",
    bestOpen: "Eng yaxshi natija — {name}: {r}, {side}, ochilishda kirish ({time} ET)",
    averaging: "Zarardagi {losers} treyderdan {averaged} tasi pozitsiyaga qarshi qoʻshgan",
    timing: "Foydadagilar taxminan {winners} ET da, zarardagilar — {losers} ET da kirgan",
    sides: "Short: {st} tadan {sw} tasi foydada · Long: {lt} tadan {lw} tasi",
  },
  link: {
    label: "Bu tikerdagi desk: {traders}",
    aria: "{ticker} boʻyicha {date} desk savdolarini ochish",
    chips: "Oʻsha tikerlardagi desk",
    chip: "{ticker} · {traders}",
  },
} satisfies Messages<typeof ru>;
