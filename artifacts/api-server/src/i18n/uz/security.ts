import type { Messages } from "../core";
import type ru from "../ru/security";

export default {
  login: {
    invalid: "Ism yoki PIN notoʻgʻri",
    locked: "Muvaffaqiyatsiz urinishlar juda koʻp. Kirish vaqtincha bloklandi",
    rateLimited: "Kirish urinishlari juda koʻp, keyinroq urinib koʻring",
    banned: "Kirish bloklangan. Kuratoringizga murojaat qiling",
  },
  password: {
    changeRequired: "Avval yangi parol oʻrnating",
    tooShort: "Kamida {min} ta belgi",
    tooLong: "Koʻpi bilan {max} ta belgi",
    sameAsOld: "Yangi parol joriy paroldan farq qilishi kerak",
    sameAsName: "Parol ismingiz bilan bir xil boʻlmasligi kerak",
    currentWrong: "Joriy parol notoʻgʻri",
    required: "Joriy va yangi parolni kiriting",
    tooManyAttempts: "Urinishlar juda koʻp, keyinroq urinib koʻring",
  },
  body: {
    tooManyRequests: "Soʻrovlar juda koʻp, keyinroq urinib koʻring",
    tooLarge: "Soʻrov juda katta ({limit} dan ortiq)",
  },
  alert: {
    title: "WS_LEXX: serverda yangi xato",
    titleClient: "WS_LEXX: ilovada yangi xato",
    route: "Yoʻnalish: {route}",
    count: "Takrorlar: {count}",
    open: "Ochish: {url}",
  },
} satisfies Messages<typeof ru>;
