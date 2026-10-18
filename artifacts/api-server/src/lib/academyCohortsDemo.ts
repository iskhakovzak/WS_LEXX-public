/**
 * Demo seed for «Академия → Когорты» (POST /academy/cohorts/seed-demo, routes/academy-cohorts.ts seedDemo).
 * Seed data, not UI text: the rows it writes are user content afterwards (names of real local members, cohort /
 * session / goal titles written as a mentor would). Allowlisted in src/i18n/allowlist.json.
 */
import type { AttendanceStatus, Comparator, MetricKey, Stage } from "./academyCohorts";

export const DEMO_URL = "https://meet.example.com/ws-lexx-demo"; // reserved demo domain; replace with a real Zoom/Meet link

type DemoSession = {
  key: string; cohort: "office" | "remote"; title: string; kind: string; recurrence: string; weekdays?: number[]; startDate: string; startTime: string;
  durationMin: number; mode: string; room?: string | null; url?: string | null; description: string;
};

const ROOM = "Переговорная «Уолл-стрит», 3 этаж";

export const DEMO = {
  mentors: { office: "Антон", remote: "Ориф" },
  cohorts: {
    office: { name: "Офис — осень 2026", format: "office", room: ROOM, url: null as string | null, description: "Очная группа в офисе: премаркет-брифинг каждый торговый день, разбор недели по пятницам, лекции по риску и плейбуку." },
    remote: { name: "Удалённо — осень 2026", format: "remote", room: null as string | null, url: DEMO_URL as string | null, description: "Удалённая группа (разные часовые пояса): все занятия онлайн, самоотметка в окне −10…+15 мин от начала." },
  },
  enrollments: [
    { cohort: "office", user: "Закир", stage: "trainee", joinedOn: "2026-09-01" },
    { cohort: "office", user: "Артур", stage: "junior", joinedOn: "2026-09-01" },
    { cohort: "office", user: "Рахматулло", stage: "trainee", joinedOn: "2026-09-15" },
    { cohort: "office", user: "Ориф", stage: "trader", joinedOn: "2026-09-01" },
    { cohort: "remote", user: "Умид", stage: "trainee", joinedOn: "2026-09-01" },
    { cohort: "remote", user: "Максат", stage: "junior", joinedOn: "2026-09-08" },
  ] as { cohort: "office" | "remote"; user: string; stage: Stage; joinedOn: string }[],
  sessions: [
    { key: "oBrief", cohort: "office", title: "Премаркет-брифинг", kind: "briefing", recurrence: "weekdays", startDate: "2026-09-01", startTime: "09:00", durationMin: 25, mode: "office", room: ROOM, description: "Гэпы, катализаторы дня, план на открытие, уровни по Big 7." },
    { key: "oReview", cohort: "office", title: "Разбор недели", kind: "review", recurrence: "weekly", weekdays: [5], startDate: "2026-09-04", startTime: "16:30", durationMin: 60, mode: "office", room: ROOM, description: "Лучшие и худшие сделки недели, статистика по комиссиям и дисциплине." },
    { key: "oLecture", cohort: "office", title: "Лекция: риск и размер позиции", kind: "lecture", recurrence: "none", startDate: "2026-10-21", startTime: "17:00", durationMin: 90, mode: "hybrid", room: ROOM, url: DEMO_URL, description: "Риск на сделку, дневной стоп, расчёт размера от стопа; разбор реальных примеров." },
    { key: "rBrief", cohort: "remote", title: "Премаркет-брифинг (онлайн)", kind: "briefing", recurrence: "weekdays", startDate: "2026-09-01", startTime: "09:00", durationMin: 25, mode: "online", url: DEMO_URL, description: "Тот же брифинг для удалённой группы. Отметьтесь кнопкой в «Моё обучение» за 10 мин до начала." },
    { key: "rReview", cohort: "remote", title: "Разбор недели (онлайн)", kind: "review", recurrence: "weekly", weekdays: [5], startDate: "2026-09-04", startTime: "16:30", durationMin: 60, mode: "online", url: DEMO_URL, description: "Скриншоты сделок недели — в обсуждения до 16:00 ET." },
    { key: "rQa", cohort: "remote", title: "Q&A с наставником", kind: "workshop", recurrence: "none", startDate: "2026-10-22", startTime: "12:00", durationMin: 45, mode: "online", url: DEMO_URL, description: "Вопросы по платформе, хоткеям и плейбуку." },
  ] as DemoSession[],
  marks: [
    { session: "oBrief", mentor: "office", pattern: { "Закир": ["present", "present", "late", "present", "present"], "Артур": ["present"], "Рахматулло": ["absent", "absent", "present", "late", "absent"], "Ориф": ["present", "late"] } },
    { session: "oReview", mentor: "office", pattern: { "Закир": ["present"], "Артур": ["present"], "Рахматулло": ["absent"], "Ориф": ["present"] } },
    { session: "rBrief", mentor: "remote", pattern: { "Умид": ["present", "late", "present"], "Максат": ["excused", "present", "absent", "present"] } },
  ] as { session: string; mentor: "office" | "remote"; pattern: Record<string, AttendanceStatus[]> }[],
  goals: [
    { student: "Ориф", title: "Комиссии меньше половины брутто", metric: "fee_share", target: 50, comparator: "lt", window: 10, startDate: "2026-10-01", dueOn: "2026-11-27" },
    { student: "Ориф", title: "Не больше 3 убыточных сделок подряд", metric: "loss_streak", target: 3, comparator: "lte", window: 10, startDate: "2026-10-01", dueOn: "2026-11-27" },
    { student: "Ориф", title: "Винрейт ≥ 50 % на 100 сделках", metric: "win_rate", target: 50, comparator: "gte", window: 100, startDate: "2026-10-01", dueOn: "2026-12-18" },
    { student: "Ориф", title: "10 дней дневника с разбором", metric: "journal_days", target: 10, comparator: "gte", window: null, startDate: "2026-10-01", dueOn: "2026-11-13" },
    { student: "Ориф", title: "Конспект по своему лучшему сетапу в плейбук", metric: "manual", target: 100, comparator: "gte", window: null, startDate: "2026-10-01", dueOn: "2026-11-06", manualProgress: 40 },
    { student: "Закир", title: "20 торговых дней на симуляторе", metric: "trading_days", target: 20, comparator: "gte", window: null, startDate: "2026-09-01", dueOn: "2026-11-30" },
    { student: "Закир", title: "10 дней дневника с разбором", metric: "journal_days", target: 10, comparator: "gte", window: null, startDate: "2026-10-01", dueOn: "2026-11-13" },
    { student: "Умид", title: "Не больше 3 убыточных сделок подряд", metric: "loss_streak", target: 3, comparator: "lte", window: 10, startDate: "2026-10-01", dueOn: "2026-12-01" },
  ] as { student: string; title: string; metric: MetricKey; target: number; comparator: Comparator; window: number | null; startDate: string; dueOn: string | null; manualProgress?: number }[],
  meetings: [
    {
      student: "Ориф", mentor: "office", metAt: "2026-10-12T21:00:00.000Z", format: "office",
      agenda: "Итоги сентября; комиссии съедают прибыль на мелких тикерах; план на октябрь.",
      notes: "Доля комиссий за последние недели высокая — много сделок с маленьким ходом. Договорились резать сделки с ожидаемым ходом < 10 центов.",
      privateNotes: "Готов к увеличению лимита, если комиссии < 50 % брутто 2 недели подряд.",
      actions: [
        { title: "Не открывать сделки с ожидаемым ходом меньше 10 центов", dueOn: "2026-10-30", owner: "student" },
        { title: "Заполнять дневник каждый торговый день", dueOn: "2026-10-16", owner: "student" },
        { title: "Подготовить сравнение тарифов ECN для Орифа", dueOn: "2026-10-23", owner: "mentor" },
      ],
    },
    {
      student: "Рахматулло", mentor: "office", metAt: "2026-10-09T20:30:00.000Z", format: "office",
      agenda: "Пропуски брифингов; режим дня.",
      notes: "Пропускает утренние брифинги. Договорились приходить к 08:50 ET.",
      privateNotes: "",
      actions: [{ title: "Быть на брифинге к 08:50 ET всю неделю", dueOn: "2026-10-16", owner: "student" }],
    },
    {
      student: "Умид", mentor: "remote", metAt: "2026-10-14T13:45:00.000Z", format: "online",
      agenda: "Онлайн-созвон: настройка платформы, хоткеи.",
      notes: "Хоткеи настроены, первая неделя на симуляторе без серий убытков > 3.",
      privateNotes: "",
      actions: [{ title: "Пройти урок по хоткеям и сдать тест", dueOn: "2026-10-24", owner: "student", status: "done" }],
    },
  ] as { student: string; mentor: "office" | "remote"; metAt: string; format: string; agenda: string; notes: string; privateNotes: string; actions: { title: string; dueOn: string; owner: "student" | "mentor"; status?: "open" | "done" | "dropped" }[] }[],
  historyNote: "Зачисление (демо)",
};
