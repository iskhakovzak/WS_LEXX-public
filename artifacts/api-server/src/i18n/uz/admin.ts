import type { Messages } from "../core";
import type ru from "../ru/admin";

export default {
  reports: {
    authorBanned: "Muallif bloklandi: {reason}",
  },
  health: {
    syncRun: "Sinxronlash #{id} ({source}): {status}",
    syncErrors: ", xatolar {count}",
    sourceFile: "fayl",
    scheduler: "Rejalashtiruvchi: {error}",
  },
  quality: {
    no_trader: {
      label: "Treydersiz savdolar",
      hint: "Savdo hech kimning jurnali va statistikasiga tushmaydi. Hisobni «Integratsiyalar → Hisoblar» boʻlimida treyderga bogʻlang.",
    },
    unknown_trader: {
      label: "Treyder foydalanuvchilar orasida topilmadi",
      hint: "Savdodagi ism hech bir hisobga mos kelmaydi (nom oʻzgargan yoki hisob bogʻlanishida xato).",
    },
    unmapped_account: {
      label: "Bogʻlanmagan hisoblardan savdolar",
      hint: "Broker hisobi savdolarda bor, lekin treyderga bogʻlanmagan.",
    },
    duplicates: {
      label: "Ehtimoliy dublikatlar",
      hint: "Treyder, tiker, sana, yoʻnalish, kirish, chiqish va P&L bir xil. «Integratsiyalar → Solishtirish»da hal qiling.",
    },
    ny_date_mismatch: {
      label: "Savdo sanasi ≠ ochilish sanasi (NY)",
      hint: "Savdo sanasi Nyu-York boʻyicha ochilish sanasiga mos boʻlishi kerak. Odatda bu qoʻlda tahrir yoki eski import.",
    },
    weekend: {
      label: "Dam olish kunidagi savdolar",
      hint: "AQSh bozori shanba va yakshanba yopiq — sana NY vaqti boʻyicha yozilmagan boʻlishi mumkin.",
    },
    future: {
      label: "Kelajak sanali savdolar",
      hint: "NY boʻyicha bugun: {today}.",
    },
    exit_before_entry: {
      label: "Chiqish sanasi kirish sanasidan oldin",
      hint: "Koʻp kunlik savdolarda exit_date ni tekshiring.",
    },
    pending_reconcile: {
      label: "Solishtirishni kutmoqda",
      hint: "Qoʻlda kiritilganlar bilan mos kelgan broker savdolari — «Integratsiyalar → Solishtirish»da hal qiling.",
    },
    legacy_no_id: {
      label: "Broker ID siz eski import",
      hint: "Xuddi shu davr keyingi import qilinganda ID oladi.",
    },
  },
} satisfies Messages<typeof ru>;
