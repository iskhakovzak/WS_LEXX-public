import type { Messages } from "../core";
import type ru from "../ru/common";

export default {
  errors: {
    authRequired: "Tizimga kirish talab qilinadi",
    guestReadOnly: "Mehmon rejimi: faqat koʻrish",
    forbidden: "Bu amal uchun huquqingiz yetarli emas",
    notFound: "Topilmadi",
    validation: "Notoʻgʻri soʻrov",
    invalidJson: "Soʻrov tanasida notoʻgʻri JSON",
    internal: "Serverning ichki xatosi",
    rateLimited: "Soʻrovlar juda koʻp, keyinroq urinib koʻring",
    loginRateLimited: "Kirish urinishlari juda koʻp, keyinroq urinib koʻring",
    invalidCredentials: "Ism yoki parol notoʻgʻri",
    banned: "Kirish bloklangan. Kuratoringizga murojaat qiling",
    invalidLocale: "Nomaʼlum til: {value}",
  },
  roles: {
    trader: "Treyder",
    curator: "Kurator",
    admin: "Administrator",
    guest: "Mehmon",
  },
  units: {
    trades: { one: "{count} ta savdo", other: "{count} ta savdo" },
    days: { one: "{count} kun", other: "{count} kun" },
  },
} satisfies Messages<typeof ru>;
