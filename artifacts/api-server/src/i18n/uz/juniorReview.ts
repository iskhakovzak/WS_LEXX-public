import type { Messages } from "../core";
import type ru from "../ru/juniorReview";

export default {
  mistake: {
    fomo: "FOMO / quvish",
    early_entry: "Erta kirish",
    moved_stop: "Stopni surdi",
    no_stop: "Stopsiz",
    overtrading: "Overtrading",
    size: "Hajm rejadan katta",
    revenge: "Qaytarib olish",
    off_plan: "Rejadan tashqari",
    early_exit: "Erta chiqish",
    held_loser: "Zararni uzoq ushladi",
    averaging: "Zararni oʻrtachalashtirish",
    daily_limit: "Limitni buzdi",
    emotions: "Hissiyot / tilt",
  },
  attention: {
    waiting: "Javob kutmoqda",
    unanswered: "Javobsiz: {n}",
    missed: "Ketma-ket {n} kun oʻtkazildi",
    never: "Hali birorta sharh yoʻq",
    low: "Past baholar · {score}",
    falling: "Baholar pasaymoqda · {delta}",
    repeat: "Takrorlaydi: {mistake} ×{count}",
  },
} satisfies Messages<typeof ru>;
