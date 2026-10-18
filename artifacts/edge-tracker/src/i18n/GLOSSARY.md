# WS_LEXX glossary — RU → EN → UZ

Every agent follows this table: the same Russian term gets the same English and Uzbek term everywhere (UI, server texts, Telegram). If you introduce a new domain term, add it to **your own section at the bottom** (don't edit the shared tables).

## Rules

- **RU** is the source. Keep the page's existing «ты/вы».
- **EN**: US English, concise product language, sentence case («Daily limit», not «Daily Limit»).
- **UZ**: Uzbek **Latin**, modern orthography, polite «siz». Letters `oʻ gʻ` use **U+02BB «ʻ»** (not `'`, not `‘`); the glottal stop uses **U+02BC «ʼ»** (`taʼlim`, `maʼlumot`, `eʼlon`). `sh ch ng` as digraphs. Short UI labels.
  - Nouns stay **singular after numbers**: «5 ta savdo», «3 kun», «10 daqiqa». So UZ plural entries usually have identical `one`/`other`. Use `ta` with countable objects (savdo, tiker, gʻoya, setap), not with units of time/measure (kun, soat, daqiqa, ball, dona).
  - Suffixes attach to placeholders without a space: `{date}dan`, `{date}gacha`, `«{name}»ni`.
  - Buttons: verbal noun in -sh/-ish («Saqlash», «Oʻchirish», «Bekor qilish»); states: past participle / -moqda («Saqlandi», «Yuklanmoqda…»).
- Never translate user content: names, setup names, notes, comments, idea texts, folder names, tags.
- Money and prices keep the trading format in every language: `$1,234.56`, `+0.21R`, prices with a dot. Counts and dates follow the UI language (`fmtCount`, `fmtDate`).

## Do not translate (identical in RU / EN / UZ)

| Category | Items |
|---|---|
| Market data | tickers, symbols, exchange codes (NASDAQ, NYSE, ARCA), prices, `$` amounts |
| Strategy / session codes | OPG, MOC, OPGtoDAY, Day, Overnight (as a code), AfterMarket, OPT, premarket labels that are codes |
| Metrics, abbreviations | P&L, R, R:R, MAE, MFE, WR, PF, EV, VWAP, ATR, SMA, EMA, RVOL, IV, float, short interest, gap, halt, SSR, ETF, IPO, SPAC, 8-K, S-1, 10-Q, CPI, FOMC, NFP, bid/ask, spread, A+ (setup grade) |
| Earnings | «earnings» may stay as is in EN/UZ («Earnings») |
| Long / Short | RU «Лонг / Шорт» · EN «Long / Short» · UZ «Long / Short» |
| Products / brands | WS_LEXX, PropReports, Telegram, Big 7, Chart Lab, WS Chart, Whisper |
| Units kept by convention | `R`, `%`, `$`, `bp` |

## People and roles

| RU | EN | UZ | Note |
|---|---|---|---|
| Трейдер | Trader | Treyder | role and tier |
| Куратор | Curator | Kurator | |
| Админ / Администратор | Admin / Administrator | Admin / Administrator | |
| Наставник / ментор | Mentor | Mentor | |
| Риск-менеджер | Risk manager | Risk-menejer | |
| Партнёр | Partner | Hamkor | office partners |
| Гость | Guest | Mehmon | guest mode |
| Пользователь | User | Foydalanuvchi | |
| Студент / ученик | Student | Talaba | academy |
| Подопечные (куратора) | Assigned traders | Biriktirilgan treyderlar | |
| Команда | Team | Jamoa | |
| Деск / трейдинг-деск | Desk / trading desk | Desk / treyding desk | |
| Проп-трейдинг | Prop trading | Prop-treyding | |
| Офис / удалённо | Office / remote | Ofis / masofaviy | |

## Tiers and academy ladder

| RU | EN | UZ | Note |
|---|---|---|---|
| Тир | Tier | Daraja | scaling tier |
| Без тира | No tier | Darajasiz | |
| Ступень | Stage | Bosqich | step on the trader path |
| Стажёр | Intern | Stajyor | |
| Джун | Junior | Junior | |
| Трейдер (ступень) | Trader | Treyder | |
| Сеньор | Senior | Senior | |
| Путь трейдера | Trader path | Treyder yoʻli | |
| Повышение / перевод | Promotion | Koʻtarilish | moving up a stage/tier |
| Критерии перевода | Promotion criteria | Koʻtarilish mezonlari | |
| Академия | Academy | Akademiya | |
| Обучение | Learning | Taʼlim | |
| Курс | Course | Kurs | |
| Урок | Lesson | Dars | |
| Тест | Quiz | Test | |
| Задание | Assignment | Topshiriq | |
| Экзамен | Exam | Imtihon | |
| Челлендж / испытание | Challenge | Sinov | |
| Когорта | Cohort | Guruh | |
| Занятие | Session (class) | Mashgʻulot | not «Сессия» (market) |
| Посещаемость | Attendance | Davomat | |
| ИПР (индивидуальный план развития) | IDP (development plan) | Shaxsiy rivojlanish rejasi | |
| Договорённости (1:1) | Agreements | Kelishuvlar | mentor 1:1 |
| Редактор курсов | Course editor | Kurs muharriri | |
| Балл | Point | Ball | «{count} ball» |

## Trading

| RU | EN | UZ | Note |
|---|---|---|---|
| Сделка / сделки | Trade / trades | Savdo / savdolar | «{count} ta savdo» |
| Позиция | Position | Pozitsiya | |
| В позиции | In position | Pozitsiyada | |
| Сторона | Side | Yoʻnalish | Long/Short |
| Тикер | Ticker | Tiker | |
| Сетап | Setup | Setap | |
| Без сетапа | No setup | Setapsiz | |
| Вход | Entry | Kirish | |
| Выход | Exit | Chiqish | |
| Частичный выход | Partial exit | Qisman chiqish | |
| Добор / усреднение | Add / scale in | Qoʻshimcha kirish | |
| Стоп | Stop | Stop | |
| Цель / тейк | Target | Maqsad | |
| Риск | Risk | Risk | |
| Размер (позиции) | Size (position size) | Oʻlcham (pozitsiya oʻlchami) | |
| Объём | Volume | Hajm | |
| Цена | Price | Narx | |
| Исполнение / филл | Fill | Ijro | |
| Комиссии | Fees | Komissiyalar | |
| Нетто / брутто | Net / gross | Sof / yalpi | «Net P&L» = «Sof P&L» |
| P&L нетто | Net P&L | Sof P&L | |
| Прибыль | Profit | Foyda | |
| Убыток | Loss | Zarar | |
| Плюс / минус (результат) | Win / loss | Foyda / zarar | trade result badge |
| В ноль / безубыток | Breakeven | Nolda | |
| Прибыльные / убыточные | Winners / losers | Foydali / zararli | |
| Винрейт | Win rate | Win rate | |
| Средний R / Ср. R | Avg R | Oʻrt. R | |
| Сумма R | Total R | Jami R | |
| Ожидание (матожидание) | Expectancy | Kutilma | |
| Просадка | Drawdown | Pasayish | |
| Макс. просадка | Max drawdown | Maks. pasayish | |
| Просадка от пика | Drawdown from peak | Choʻqqidan pasayish | |
| Кривая капитала | Equity curve | Kapital egri chizigʻi | |
| Капитал | Capital / equity | Kapital | |
| Счёт | Account | Hisob | broker account |
| Buying power | Buying power | Buying power | keep |
| Лимит | Limit | Limit | |
| Дневной / недельный лимит | Daily / weekly limit | Kunlik / haftalik limit | |
| Лимит не задан | No limit set | Limit belgilanmagan | |
| Макс. убыток | Max loss | Maks. zarar | |
| Удержание (время в сделке) | Hold time | Ushlab turish | |
| Горизонт | Horizon | Gorizont | |
| Интрадей / овернайт / свинг | Intraday / overnight / swing | Intraday / overnight / swing | horizon codes |
| Серия | Streak | Seriya | |
| Подряд | In a row | Ketma-ket | |
| Зелёный день | Green day | Yashil kun | |
| Торговый день | Trading day | Savdo kuni | |
| Уверенность | Confidence | Ishonch | |
| Качество сделки | Trade quality | Savdo sifati | |
| Оценка | Grade / score | Baho | |
| Стратегия | Strategy | Strategiya | |
| Уровень (ценовой) | Level | Sath | support/resistance |
| Поддержка / сопротивление | Support / resistance | Qoʻllab-quvvatlash / qarshilik | |
| Пробой | Breakout | Yorib oʻtish | |
| Отскок | Bounce | Qaytish | |
| Импульс | Momentum | Impuls | |
| Ликвидность | Liquidity | Likvidlik | |
| Волатильность | Volatility | Volatillik | |
| Свеча / график | Candle / chart | Sham / grafik | |
| Таймфрейм | Timeframe | Taymfreym | |
| Реплей | Replay | Replay | Chart Lab |
| Калькулятор | Calculator | Kalkulyator | |
| Опцион / страйк / греки | Option / strike / Greeks | Opsion / strayk / greklar | |

## Market and sessions

| RU | EN | UZ | Note |
|---|---|---|---|
| Рынок | Market | Bozor | |
| Премаркет | Premarket | Premarket | |
| Основная сессия | Regular session | Asosiy sessiya | |
| Постмаркет | After-hours | Postmarket | |
| Сессия | Session | Sessiya | market session |
| Открытие / закрытие | Open / close | Ochilish / yopilish | |
| Рынок закрыт | Market closed | Bozor yopiq | |
| Выходной биржи | Market holiday | Birja dam olish kuni | |
| Выходные | Weekend | Dam olish kunlari | |
| Катализатор | Catalyst | Katalizator | |
| Событие | Event | Voqea | calendar event |
| Отчётность | Earnings | Earnings | do not translate |
| Макро | Macro | Makro | |
| Сектор | Sector | Sektor | |
| Капитализация | Market cap | Kapitalizatsiya | |
| Вотчлист | Watchlist | Kuzatuv roʻyxati | |
| Размещение (оффер) | Offering | Joylashtirish | stock offering |
| Размытие | Dilution | Suyultirish | |
| Рейтинги аналитиков | Analyst ratings | Tahlilchilar reytingi | |
| Апгрейд / даунгрейд | Upgrade / downgrade | Upgrade / downgrade | keep |
| Индикаторы | Indicators | Indikatorlar | |
| Новости / лента | News / feed | Yangiliklar / lenta | |
| Тема дня | Theme of the day | Kun mavzusi | daily feed |
| В игре (in play) | In play | In play | keep |

## Review, discipline, psychology

| RU | EN | UZ | Note |
|---|---|---|---|
| Разбор | Review | Tahlil | |
| Разбор дня | Day review | Kun tahlili | |
| Отчёт | Report | Hisobot | |
| Отчёт недели | Weekly report | Haftalik hisobot | |
| План дня | Game plan | Kun rejasi | |
| План на завтра | Plan for tomorrow | Ertangi reja | |
| Дневник | Journal | Kundalik | the journal page |
| Журнал (сделок) | Journal (trade journal) | Jurnal | «Ask the journal» |
| Спроси журнал | Ask the journal | Jurnaldan soʻrang | |
| Плейбук | Playbook | Pleybuk | |
| Вариация сетапа | Setup variation | Setap varianti | |
| Чек-лист | Checklist | Chek-list | |
| Пре-трейд чек-лист | Pre-trade checklist | Savdodan oldingi chek-list | |
| Правило | Rule | Qoida | |
| Нарушение | Violation | Qoidabuzarlik | «{count} ta qoidabuzarlik» |
| Ошибка (торговая) | Mistake | Xato | trading mistake |
| Ошибка (системная) | Error | Xato | app error |
| Дисциплина | Discipline | Intizom | |
| Тильт | Tilt | Tilt | |
| Реванш-трейдинг | Revenge trading | Revenge trading | keep |
| Овертрейдинг | Overtrading | Overtrading | keep |
| Эмоции / состояние | Emotions / state | Hissiyot / holat | |
| Стресс | Stress | Stress | |
| Пауза (торговли) | Trading pause | Savdo pauzasi | |
| Блокировка торговли | Trading lock | Savdoni bloklash | |
| Сверка | Reconciliation | Solishtirish | broker vs journal |
| Бенчмарк | Benchmark | Benchmark | |
| Перцентиль / медиана / среднее | Percentile / median / average | Persentil / mediana / oʻrtacha | |
| Статистика | Statistics | Statistika | |
| Аналитика | Analytics | Analitika | |
| Симулятор (what-if) | Simulator | Simulyator | |
| Инсайт | Insight | Xulosa | |
| Сводка | Summary / notes | Sharh | «Сводка автора» = «Author’s notes» = «Muallif sharhi» |
| Идея (трейд-идея) | Idea (trade idea) | Gʻoya | |
| Обсуждение | Discussion | Muhokama | |
| Упоминание | Mention | Eslatish | @mention |
| Рейтинг | Rating | Reyting | |
| Топ-результаты | Top results | Eng yaxshi natijalar | |
| Активность | Activity | Faollik | |
| План масштабирования | Scaling plan | Masshtablash rejasi | |

## App and admin

| RU | EN | UZ | Note |
|---|---|---|---|
| Дашборд | Dashboard | Boshqaruv paneli | |
| Настройки | Settings | Sozlamalar | |
| Профиль | Profile | Profil | |
| Интеграции | Integrations | Integratsiyalar | |
| Админка | Admin panel | Admin panel | |
| Уведомления | Notifications | Bildirishnomalar | |
| Заметка | Note | Qayd | not «Eslatma» (= reminder) |
| Напоминание | Reminder | Eslatma | |
| Тег | Tag | Teg | |
| Папка | Folder | Papka | |
| Скриншот | Screenshot | Skrinshot | |
| Голосовая заметка | Voice note | Ovozli qayd | |
| Шаблон | Template | Shablon | |
| Черновик | Draft | Qoralama | |
| Архив | Archive | Arxiv | |
| Избранное | Favorites | Sevimlilar | |
| Жалоба | Report (complaint) | Shikoyat | moderation |
| Модерация | Moderation | Moderatsiya | |
| Блокировка (бан) | Ban | Bloklash | |
| Права / доступ | Permissions / access | Huquqlar / ruxsat | |
| Импорт / экспорт | Import / export | Import / eksport | |
| Брокер / выписка | Broker / statement | Broker / koʻchirma | |
| Тема (оформления) | Theme | Mavzu | dark «Toʻq», dim «Xira», light «Yorugʻ» |
| Язык интерфейса | Interface language | Interfeys tili | |
| Поиск | Search | Qidirish / qidiruv | button «Qidirish», noun «qidiruv» |
| Сессия (вход) | Session (sign-in) | Sessiya | «Session expired» |
| Вход / выход (аккаунт) | Sign in / sign out | Kirish / chiqish | |

## Navigation section names

Canonical names live in `i18n/locales/<lang>/shell.ts` → `nav.*` (use `shellI18n.t("nav.playbook")` when you link to a section; don't retranslate).

## Area sections (add your terms below)

<!-- ## <area> (agent name)
| RU | EN | UZ | Note |
|---|---|---|---| -->

## Simulator (SIMULATOR agent)
| RU | EN | UZ | Note |
|---|---|---|---|
| Симулятор (игра на графике) | Simulator | Simulyator | /simulator; the old «Что если» page moved to /what-if |
| Бар (свеча в игре) | Bar | Sham | «{count} sham» |
| Купи и держи | Buy and hold | Sotib ol va ushla | benchmark of a game |
| Вне позиции | Flat | Pozitsiyasiz | |
| Автоигра / авто | Autoplay / auto | Avtooʻyin / avto | |
| Лёгкий / средний / сложный | Easy / medium / hard | Oson / oʻrtacha / qiyin | game level |
| Таблица недели деска | Desk week | Desk haftasi | weekly leaderboard |

<!-- merged area sections (translation wave, 2026-10-18) -->

## Academy (ACADEMY agent)

Ladder and core academy words are in GLOSSARY.md («Tiers and academy ladder»); tier names come from `commonI18n.t("tiers.*")` (stage key `trainee` = «Стажёр» = Intern / Stajyor). Course / lesson / quiz / assignment content written in the course editor is user content and is not translated.

| RU | EN | UZ | Note |
|---|---|---|---|
| Программа (обучения) | Program | Dastur | top level of a course tree |
| Модуль | Module | Modul | |
| Элемент (урок / тест / задание) | Item | Element | course tree node |
| Работа / сдача | Submission | Topshirilgan ish | assignment answer |
| Сдать работу | Submit | Topshirish | |
| Проверка (работ) | Grading / review | Tekshirish | |
| Очередь проверки | Review queue | Tekshirish navbati | |
| На проверке | Under review | Tekshiruvda | |
| На доработку | Needs revision | Qayta ishlashga | returned submission |
| Рубрика / критерий оценки | Rubric / criterion | Baholash mezoni | |
| Попытка | Attempt | Urinish | «{count} ta urinish» |
| Проходной балл | Passing score | Oʻtish bali | |
| Сдан / пройден | Passed | Oʻtdi | |
| Не сдан | Failed | Oʻtmadi | |
| Срок / дедлайн | Due date | Muddat | |
| Просрочено | Overdue | Muddati oʻtgan | |
| Опубликовать / снять с публикации | Publish / unpublish | Nashr qilish / nashrdan olish | |
| Опубликован | Published | Nashr qilingan | |
| Видео | Video | Video | |
| Вложение | Attachment | Ilova | |
| Время чтения | Reading time | Oʻqish vaqti | «{count} daqiqa» |
| Учится (статус) | Active | Oʻqimoqda | enrollment status |
| Пауза (статус) | Paused | Pauzada | enrollment status |
| Выпущен | Graduated | Bitirgan | enrollment status |
| Отчислен | Dropped | Chetlatilgan | enrollment status |
| Офис / удалённо / гибрид | Office / remote / hybrid | Ofis / masofaviy / gibrid | cohort format |
| Офлайн / онлайн | In person / online | Oflayn / onlayn | session mode |
| Брифинг / лекция / разбор / практикум | Briefing / lecture / review / workshop | Brifing / maʼruza / tahlil / amaliy mashgʻulot | session kind |
| Был / опоздал / пропуск / уважительная | Present / late / absent / excused | Keldi / kechikdi / kelmadi / sababli | attendance |
| Самоотметка | Check-in | Belgilanish | remote attendance self-mark |
| Встреча 1:1 | 1:1 meeting | 1:1 uchrashuv | |
| Цель (ИПР) | Goal | Maqsad | IDP goal |
| В работе / достигнута / сорвана / отменена | In progress / achieved / missed / cancelled | Jarayonda / erishildi / bajarilmadi / bekor qilindi | goal status |
| Состав (когорты) | Roster | Tarkib | |
| Зачислить | Enroll | Roʻyxatga olish | |
| Заявка на перевод | Promotion request | Koʻtarilish soʻrovi | |
| Воронка | Funnel | Voronka | path funnel |
| Ступень не назначена | No stage assigned | Bosqich belgilanmagan | |

### Cohorts / mentor (sub-agent)

| RU | EN | UZ | Note |
|---|---|---|---|
| Ведущий (занятия) | Host | Olib boruvchi | session host |
| Разово / ежедневно / по будням / по дням недели | Once / daily / weekdays / selected days | Bir martalik / har kuni / ish kunlari / tanlangan kunlar | session recurrence |
| Уважительная причина | Excused absence | Sababli kelmadi | full form; chip label «Уважит.» = Excused / Sababli |
| Пунктуальность | Punctuality | Punktuallik | share of on-time arrivals |
| Отстаёт / отставание | Falling behind | Ortda qolmoqda / ortda qolish | mentor dashboard |
| В графике | On track | Rejada | nobody falling behind |
| Повестка (1:1) | Agenda | Kun tartibi | |
| Приватные заметки | Private notes | Maxfiy qaydlar | mentors only |
| Кто делает (договорённость) | Owner | Kim bajaradi | student / mentor |
| Снять договорённость | Drop agreement | Kelishuvni bekor qilish | status `dropped` |
| Журнал 1:1 | 1:1 log | 1:1 jurnali | |
| Глазами студента | Student view | Talaba koʻzi bilan | mentor opens /academy/my?user= |
| Цели ИПР | IDP goals | Rivojlanish maqsadlari | UZ avoids the long «Shaxsiy rivojlanish rejasi» in headers; full name only as a panel title |
| Окно (цели) | Window | Oyna | «Окно, торговых дней» = «Window, trading days» = «Oyna, savdo kunlari» |
| Выборка | Sample | Tanlanma | goal sample size |
| Демо-когорты | Demo cohorts | Demo guruhlar | staff seed action |

### Path / challenges (sub-agent)

| RU | EN | UZ | Note |
|---|---|---|---|
| Экзамен (челлендж) | Exam | Imtihon | /academy/challenges; «Челлендж» in running text = Challenge / Sinov |
| Назначить экзамен | Assign exam | Imtihon belgilash | |
| Шаблон экзамена | Template | Shablon | |
| Перевод на капитал | Promotion to capital | Kapitalga koʻtarilish | capital exam group |
| Подать на перевод | Request promotion | Koʻtarilishga soʻrov | |
| Заявка (на перевод) | Request | Soʻrov | |
| Отозвать заявку | Withdraw request | Soʻrovni qaytarib olish | |
| Готов к переводу | Ready for promotion | Koʻtarilishga tayyor | |
| Ученик (на пути) | Student | Talaba | |
| Окно (N торговых дней) | Window | Oyna | criterion window |
| Цель по прибыли | Profit target | Foyda maqsadi | challenge rule |
| Дневной лимит убытка | Daily loss limit | Kunlik zarar limiti | |
| Статическая / трейлинг-просадка | Static / trailing drawdown | Statik / treyling pasayish | |
| Правило стабильности | Consistency rule | Barqarorlik qoidasi | best-day share |
| Торговое окно | Trading window | Savdo oynasi | entry hours NY |
| Запас DD | DD room | DD zaxirasi | room to the drawdown level |
| Запланирован / идёт / сдан / провален / время истекло | Scheduled / in progress / passed / failed / expired | Rejalashtirilgan / davom etmoqda / oʻtdi / oʻtmadi / muddati tugadi | exam status |
| Повышение / понижение / назначение | Promotion / demotion / assignment | Koʻtarilish / pasaytirish / belgilash | stage history |

## Admin console, audit, PropReports integration (ADMIN agent)

Namespaces: `admin` (/admin: overview, people, team activity, moderation, roles, data), `adminAudit` (audit-log sentences, objects, diffs — `components/admin/audit-text.ts`), `propreports` (/integrations and the PropReports widgets on /stats, /analytics, Settings). Existing: `adminJobs`, `appErrors`. Permission labels come from the server matrix. Names, reasons, resolutions, file names, discussion topics, tier names configured in Scaling are user content. Audit sentences go after the actor's name, so UZ keeps the verb last («Orif {who} akkauntini muzlatdi»). Quick-pick reason presets are «|»-separated strings in the dictionary. Broker words kept as is: Fills CSV, Trades / Trade Performance (report names), fills, Gross / Net, W / L, API, groupId, ECN / SEC / ORF… fee codes.

| RU | EN | UZ | Note |
|---|---|---|---|
| Пульт деска | Desk console | Desk pulti | same as shell glossary |
| Учётка (аккаунт пользователя) | Account | Akkaunt | user account; broker «Счёт» stays Account / Hisob |
| Заморозить / разморозить | Freeze / unfreeze | Muzlatish / muzlatishdan chiqarish | status «Заморожен» = Frozen = Muzlatilgan |
| Забанить / разбанить | Ban / unban | Bloklash / blokdan chiqarish | GLOSSARY «Блокировка (бан)» |
| Сбросить сессии | Reset sessions | Sessiyalarni yakunlash | signs out every device |
| Латинское имя | Latin name | Lotincha ism | search alias, not a rename |
| Журнал аудита | Audit log | Audit jurnali | |
| Массово (действие) | Bulk | Ommaviy | «(массово)» suffix in audit text |
| Очередь модерации | Moderation queue | Moderatsiya navbati | |
| Решить / отклонить (жалобу) | Resolve / dismiss | Hal qilish / rad etish | report statuses Resolved / Dismissed = Hal qilingan / Rad etilgan |
| Резолюция | Resolution | Qaror | |
| Синк / синхронизация | Sync | Sinxronlash | |
| Автосинк | Auto-sync | Avtosinxronlash | |
| Привязать счёт / привязка | Map account / mapping | Hisobni biriktirish / biriktiruv | |
| Псевдоним (счёта) | Alias | Taxallus | other spellings of an account name |
| Несопоставленные счета | Unmatched accounts | Moslashtirilmagan hisoblar | |
| Раунд-трип | Round trip | Raund-trip | |
| Предпросмотр (без записи) | Preview (no write) | Oldindan koʻrish (yozmasdan) | dry-run |
| Входящие на сверку | Reconciliation inbox | Solishtirishga kiruvchilar | |
| Объединить / оставить отдельно | Merge / keep separate | Birlashtirish / alohida qoldirish | broker vs manual entry |
| Расхождение | Difference | Farq | reconciliation; «серьёзное» = serious = jiddiy |
| Брокерская статистика | Broker statistics | Broker statistikasi | Trade Performance report |
| Мастер настройки | Setup wizard | Sozlash ustasi | |
| Переменные окружения | Environment variables | Muhit oʻzgaruvchilari | env var names only |
| Качество данных | Data quality | Maʼlumotlar sifati | |
| Превышение (лимита) | Breach | Oshib ketish | risk KPI; stored limit breaches = Limit breach / Limit buzilishi |
| Выключен (автосинк, расписание) | Off | Oʻchiq | not «oʻchirilgan» (= deleted); inactive account = «faol emas» |
| Понижение тира | Tier demotion | Darajani tushirish | same as scaling glossary |
| МСК | MSK | MSK | backup times in Moscow time |

## Analytics, Statistics, What if, Behavior, Benchmark (ANALYTICS agent)

Namespaces: `analytics`, `analyticsPro`, `stats`, `whatIf`, `behavior`, `benchmark`. Section names follow `shell.ts` (`nav.whatIf` = «Что если» / "What if" / «Agar shunday boʻlsa»).

| RU | EN | UZ | Note |
|---|---|---|---|
| Преимущество (edge) | Edge | Ustunlik | analytics tab; «edge» stays as is inside behavior verdicts |
| Разрез | Breakdown | Kesim | dimension of a breakdown |
| Матрица преимущества | Edge matrix | Ustunlik matritsasi | |
| Надёжность (выборки) | Reliability | Ishonchlilik | «Мало данных / Предварительно / Надёжно» = "Too few trades / Preliminary / Reliable" = «Maʼlumot kam / Dastlabki / Ishonchli» |
| ДИ (доверительный интервал) | CI (confidence interval) | IO (ishonch oraligʻi) | |
| Бутстрэп | Bootstrap | Butstrep | |
| Монте-Карло | Monte Carlo | Monte-Karlo | |
| Прогон (симуляции) | Run | Simulyatsiya | «1 000 прогонов» = "1,000 runs" = «1 000 ta simulyatsiya» |
| Зерно (seed) | Seed | Seed | |
| Разорение | Ruin | Bankrotlik | risk of ruin |
| Убеждённость (1–5★) | Conviction | Ishonch | trade field `conviction`; dimension «Уверенность» uses the same EN/UZ |
| Оценка сетапа (A+…C) | Setup grade | Setap bahosi | |
| Б/у (безубыток) | BE / breakeven | Nolda | short form in hints |
| Проскальзывание | Slippage | Slippage | |
| Флоат | Float | Float | do-not-translate list |
| Гэп вверх / вниз | Gap up / down | Yuqoriga / pastga gap | |
| Перцентиль / медиана деска | Percentile / desk median | Persentil / desk medianasi | |
| Чек-ин | Check-in | Chek-in | morning state check |
| Выспался / Фокус / Стресс / Тревога / Реванш | Slept well / Focused / Stressed / Anxious / Revenge | Yaxshi uxlagan / Diqqat / Stress / Xavotir / Revenge | psychology states |
| Сценарий (what-if) | Scenario | Ssenariy | |
| Тариф (комиссий) | Tariff | Tarif | |
| Безубыток на акцию | Breakeven per share | Bir aksiyaga zararsizlik | |
| Съедено комиссией | Eaten by fees | Komissiya yegan | |
| Как было / Как стало | Actual / Scenario | Haqiqatda / Ssenariy | what-if comparison |
| Паттерн (поведения) | Pattern | Pattern | behavior |
| Стоимость (паттерна) | Cost | Narx | money a pattern cost |
| Индекс дисциплины | Discipline index | Intizom indeksi | |
| Лента сессии | Session ribbon | Sessiya lentasi | |
| Триггер (личный порог) | Trigger | Trigger | «Мои триггеры» = "My triggers" = «Mening triggerlarim» |
| Срыв (момент) | Break | Uzilish | moment the day broke down |
| Отыгрыш (chase) | Chasing | Qaytarib olish | pattern |
| Пересиживание (убытков) | Holding losers | Zararni ushlab turish | pattern `disposition` |
| Утечка (сетапа) | Leak | Yoʻqotish | opposite of edge |
| Консистентность | Consistency | Barqarorlik | best-day rule |
| Тепловая карта | Heatmap | Issiqlik xaritasi | |
| Календарь результатов | Results calendar | Natijalar kalendari | Pro tab |
| Зелёные / красные дни | Green / red days | Yashil / qizil kunlar | stats; in Pro tab «дни в плюс» = "green days" = «foydali kunlar» |

## Ask the journal (ASK agent)

«Спроси журнал» = «Ask the journal» = «Jurnaldan soʻrang» (GLOSSARY.md). Questions are parsed in all three languages at once (RU, EN, basic UZ Latin); the question texts the app writes for you (examples, chip swaps, follow-ups) are in the UI language and must parse back — see `src/i18n/locales/*/ask.ts` header and `lib/ask/__tests__/i18n-examples.test.ts`.

| RU | EN | UZ | Note |
|---|---|---|---|
| Понял как | Understood as | Shunday tushundim | parser preview chips |
| Почему такой ответ | Why this answer | Nega bunday javob | |
| Ответ: … (чип) | Answer: … | Javob: … | what the answer computes |
| Разбивка / группировка (по …) | Breakdown (by …) | Guruhlash (… boʻyicha) | «по тикерам» = «by ticker» = «tikerlar boʻyicha» |
| Срез | Slice | Kesim | insight table first column |
| Сравнение | Comparison | Solishtirish | «vs» stays «vs» in every language |
| Нетто | Net | Sof | GLOSSARY «Нетто» |
| Брутто | Gross | Yalpi | |
| Удержание (время в сделке) | Hold time | Ushlab turish | not the scaling «Удержание» (= Oʻzgarishsiz) |
| Размер позиции | Position size | Pozitsiya oʻlchami | «акций» = shares = aksiya |
| Время входа (ET) | Entry time (ET) | Kirish vaqti (ET) | |
| После обеда | Afternoon | Tushdan keyin | 14:00–16:00 ET |
| Обед | Lunch | Tushlik | 11:00–14:00 ET |
| Утро | Morning | Ertalab | |
| На открытии | At the open | Ochilishda | |
| Серия убытков / побед | Losing / winning streak | Zarar / yutuq seriyasi | |
| Подряд | In a row | Ketma-ket | GLOSSARY |
| После убытка | After a loss | Zarardan keyin | context filter |
| Зона потерь / сильная зона | Loss zone / strong zone | Zarar zonasi / kuchli zona | insight answer |
| Закрепить вопрос / закреплённые | Pin question / pinned | Savolni mahkamlash / mahkamlanganlar | follows `common.actions.pin` («Mahkamlash»); discussions use «Qadalgan» — SHELL to pick one |
| Недавние | Recent | Soʻnggilar | shell «recent» |
| Быстрые ответы | Quick answers | Tezkor javoblar | start screen |

## Calculator (RISK & RULES wave, calculator helper)

Options calculator (/calculator: chain + advisor, Black-Scholes, strategy builder). Base row in GLOSSARY.md: «Опцион / страйк / греки» = Option / strike / Greeks = Opsion / strayk / greklar.

Kept in English in all three languages (RU UI already used them): Call / Put, Buy / Sell (leg side), ITM / ATM / OTM, IV, IV crush, B-S / Black-Scholes, mid / bid / OI, Vega/Delta… with their symbols (Δ Γ Θ ν ρ), and **strategy names** (Long Call, Long Put, Bull Call Spread, Bear Put Spread, Straddle, Strangle, Iron Condor, Butterfly, Covered Call, Protective Put, Collar, Cash-Secured Put). UZ keeps the English strategy names: there is no settled Uzbek term and Uzbek traders use the English ones. Greek names in UZ titles stay Delta / Gamma / Theta / Vega / Rho; the group noun is «greklar».

| RU | EN | UZ | Note |
|---|---|---|---|
| Опционный калькулятор | Options calculator | Opsion kalkulyatori | page title |
| Цепочка опционов | Option chain | Opsion zanjiri | |
| Советник (по стратегиям) | Advisor | Maslahatchi | rule-based; «AI-советник» = AI advisor = AI maslahatchi |
| Конструктор (стратегий) | Builder (strategy builder) | Konstruktor | |
| Нога (стратегии) | Leg | Leg | UZ keeps «leg» (literal «oyoq» reads wrong); «Leg 1», «leglar» |
| Шаблон стратегии | Strategy template | Strategiya shabloni | |
| Экспирация | Expiration | Ekspiratsiya | «Ekspiratsiyada» = at expiration |
| Дней до экспирации | Days to expiration | Ekspiratsiyagacha kunlar | short «Eksp.gacha kunlar» |
| Спот | Spot | Spot | current underlying price |
| Базовый актив | Underlying | Bazaviy aktiv | |
| Премия (опциона) | Premium | Premiya | |
| Контракт | Contract | Kontrakt | 1 contract = 100 shares |
| Безубыток / точка безубытка (опциона) | Breakeven / breakeven point | Zararsizlik / zararsizlik nuqtasi | price level; GLOSSARY «Nolda» stays for a trade-result badge |
| Внутренняя стоимость | Intrinsic value | Ichki qiymat | |
| Временная стоимость | Time value | Vaqt qiymati | |
| Распад времени | Time decay | Vaqt boʻyicha yemirilish | theta |
| Безрисковая ставка / ставка | Risk-free rate / rate | Risksiz stavka / stavka | |
| Диаграмма выплат | Payoff diagram | Payoff diagrammasi | |
| Дебет / кредит (стратегии) | Debit / credit | Debet / kredit | |
| Вероятность / шанс прибыли | Probability / chance of profit | Foyda ehtimoli | |
| Макс. прибыль / макс. убыток | Max profit / max loss | Maks. foyda / maks. zarar | |
| В деньгах / вне денег | In / out of the money | Pulda / puldan tashqarida | label stays «ITM / OTM» |
| Взгляд на рынок | Market view | Bozorga qarash | advisor goal group |
| Рост / падение (цель) | Up / down | Oʻsish / tushish | advisor goals |
| Хедж лонга / шорта | Hedge a long / a short | Long xedji / Short xedji | |
| Большой ход | Big move | Katta harakat | |
| Продажа премии | Sell premium | Premiya sotish | |
| Ход (цены, в сценариях) | Move | Harakat | scenario table column |
| Сценарии | Scenarios | Ssenariylar | |
| Теоретическая цена | Theoretical price | Nazariy narx | Black-Scholes price |
| Голые опционы | Naked options | Yalangʻoch opsionlar | AI prompt example |

## Catalysts: events, offerings, analyst ratings, research archive, feed (CATALYSTS agent)
| RU | EN | UZ | Note |
|---|---|---|---|
| Размещение | Offering | Joylashtirish | stock offering (GLOSSARY) |
| Размытие / разводнение | Dilution | Suyultirish | «Скор разводнения» = Dilution score = Suyultirish skori |
| Скор | Score | Skor | dilution / importance score |
| Шелф (S-3) | Shelf | Shelf | |
| Навес (предложения) | Overhang | Taklif yuki | shelves + S-1 not yet sold |
| Ёмкость шелфа | Shelf capacity | Shelf sigʻimi | |
| Проспект | Prospectus | Prospekt | |
| Заявка (SEC) | Filing | Ariza | SEC forms (S-1, S-3, 424B, F-1, 8-K, Form 4, 10b5-1) stay as codes |
| Подано / Оценено / Предстоит / Торгуется / Отозвано | Filed / Priced / Upcoming / Trading / Withdrawn | Topshirilgan / Narxlangan / Kutilmoqda / Savdoda / Qaytarib olingan | offering status |
| Оффер (цена размещения) | Offer (offer price) | Offer | |
| Дисконт (к закрытию) | Discount | Chegirma | |
| Андеррайтер | Underwriter | Anderrayter | |
| Инсайдеры | Insiders | Insayderlar | |
| Lock-up / разлок | Lock-up / unlock | Lock-up / ochilish | |
| Мкап / капитализация | Mcap / market cap | Kap. / kapitalizatsiya | short column label «Kap.» |
| Флоут | Float | Flout | |
| Фирма (аналитиков) | Firm | Firma | firm names never translated |
| Аналитик | Analyst | Tahlilchi | |
| Апгрейд / даунгрейд | Upgrade / downgrade | Upgrade / downgrade | keep |
| Начало покрытия / покрытие | Initiation | Qamrov boshlanishi / qamrov | |
| Подтверждение / повтор | Maintained / Reiterated | Tasdiqlandi / Takrorlandi | |
| Таргет / целевая цена | Price target / target (PT) | Maqsadli narx (PT) | PT stays |
| Рейтинг (Buy/Hold/Sell…) | Rating | Reyting | grades shown verbatim as the firm published them |
| Покупать / держать / продавать (консенсус) | Buy / hold / sell | Sotib olish / ushlab turish / sotish | our stance buckets, not firm grades |
| Топ-фирма | Top firm | Top firma | |
| Вес фирмы | Firm weight | Firma vazni | same as PREMARKET |
| Подтверждаемость | Confirmation rate | Tasdiqlanish | |
| В сторону (рейтинга) | In direction (of the rating) | Yoʻnalishda | hit rate |
| День реакции | Reaction day | Reaksiya kuni | |
| Реакция (рынка) | Reaction | Reaksiya | |
| Гэп вверх / вниз | Gap up / down | Yuqoriga gap / pastga gap | |
| Бычья / медвежья / смешанная (реакция) | Bullish / bearish / mixed | Ijobiy / salbiy / aralash | |
| Позиция команды | Desk position | Desk pozitsiyasi | |
| К сессии / до открытия | For the session / before the open | Sessiyaga / ochilishdan oldin | BMO/RTH/AMC codes stay |
| До открытия / в сессию / после закрытия | Before the open / During the session / After the close | Ochilishdan oldin / Sessiya davomida / Yopilishdan keyin | |
| Отчёт (тип события), отчётность | Earnings | Earnings | «отчёт» as filing report → «hisobot» in UZ prose |
| Катализатор | Catalyst | Katalizator | |
| Заметка дня (market_events) | Day note | Kun qaydi | |
| Макро / экономика | Macro / Economy | Makro / Iqtisodiyot | CPI/NFP/FOMC/PPI/PCE/OPEX codes stay |
| ФРС | Fed | Fed | |
| ВВП | GDP | YaIM | |
| Экспирация / квад. экспирация | Expiration / quad witching | Ekspiratsiya / quad witching | |
| Короткий день | Short day | Qisqa kun | early close |
| Устойчиво / похоже / шум | Robust / likely / within noise | Barqaror / ehtimol / shovqin doirasida | edge verdicts |
| Обычный день | Usual day | Oddiy kun | baseline |
| Лента | Feed | Lenta | |
| Объявление (в ленте) | Announcement | Eʼlon | |
| Дайджест | Digest | Dayjest | |
| Принято / Торгую это | Got it / Trading this | Qabul qilindi / Buni savdo qilaman | feed acks |
| Закладки | Bookmarks | Xatchoʻplar | |
| Архив исследований | Research archive | Tadqiqotlar arxivi | shell nav |
| Доказательная база | Evidence | Dalillar bazasi | |
| Уверенность (ручная / по сделкам) | Confidence (manual / from trades) | Ishonch (qoʻlda / savdolar boʻyicha) | |

## Charts, replay, training, equity curve (CHARTS & SIM agent)

Core trading words are in GLOSSARY.md (Вход / Выход / Стоп / Цель, Исполнение = Fill = Ijro, Свеча = Candle = Sham, Таймфрейм, Реплей = Replay, Симулятор). Simulator terms are in GLOSSARY.md («Simulator» section). Namespaces: `chart` (chart-engine, trade chart, sparkline, execution quality), `chartLab` (/chart-lab picker and random tasks), `equityChart` (equity curve), `simulator`.

| RU | EN | UZ | Note |
|---|---|---|---|
| Таймфрейм 1м / 5м / 1ч / Д | 1m / 5m / 1h / D | 1m / 5m / 1h / D | chips; EN and UZ keep the Latin codes |
| Бары {tf} (размер баров) | {tf} bars | {tf} shamlar | «1 мин / 5 мин / 1 ч» → «1m / 5m / 1h» |
| Бар | Bar | Sham | same as the simulator |
| Анализ (режим графика) | Analysis | Analiz | not «Tahlil» (= Разбор / Review) |
| Тренировка (режим графика) | Training | Mashq | |
| Задача (тренировки) / Случайная задача | Task / Random task | Vazifa / Tasodifiy vazifa | not «Topshiriq» (= academy assignment) |
| Попытка | Attempt | Urinish | same as academy |
| Сессия (серия попыток тренировки) | Session | Seans | not «Sessiya» (market session) |
| Перезаход | Re-entry | Qayta kirish | trade structure role |
| Переворот | Flip | Teskari ochish | |
| Добор (метка на графике) | Add | Qoʻshimcha | full label «Qoʻshimcha kirish» (glossary) |
| Частичный фикс / Фикс (метка) | Partial exit / Partial | Qisman chiqish / Qisman | |
| Вход частями / выход частями | Scaled entry / scaled exit | Boʻlib kirish / boʻlib chiqish | structure summary |
| Б/У (стоп в безубыток) | BE (stop to breakeven) | Nolga (stopni nolga koʻchirish) | button |
| В ноль (закрыть позицию) | Flat | Yopish | training ticket button |
| Идеальный ход | Ideal move | Ideal harakat | |
| Оставил на столе | Left on the table | Boy berildi | |
| Эффективность выхода | Exit efficiency | Chiqish samaradorligi | execution quality |
| Нагрев (до +1R / до пика) | Heat (before +1R / before the peak) | Bosim (+1R gacha / choʻqqigacha) | |
| Качество исполнения | Execution quality | Ijro sifati | |
| Слои (графика) | Layers | Qatlamlar | |
| Рисование / Курсор | Drawing / Cursor | Chizish / Kursor | |
| Уровень / Тренд / Прямоугольник / Фибо | Level / Trend line / Rectangle / Fib | Sath / Trend chizigʻi / Toʻrtburchak / Fibo | drawing tools |
| Горячие клавиши | Keyboard shortcuts | Tezkor tugmalar | |
| Профиль объёма | Volume profile | Hajm profili | |
| Дней контекста | Context days | Kontekst kunlari | |
| Навигатор | Navigator | Navigator | equity curve pane |
| Накоплено | Cumulative | Jamgʻarilgan | equity tooltip |
| Свечи / Линия (вид кривой) | Candles / Line | Shamlar / Chiziq | |
| Тикер-день | Ticker-day | Tiker-kun | training task source |
| Нед / Мес (свеча кривой) | Wk / Mo | Hafta / Oy | equity aggregation chips |
| шт. | sh. | dona | same as `common` units.shares |
| Длительность «1 ч 05 мин» | «1 h 05 min» | «1 soat 05 daq» | chart `dur.*`, aligned with `common` time.*Short |

## Curator desk, team activity, discussions (CURATOR & TEAM agent)

Namespaces: `curator` (/curator), `activity` (/activity feed), `team` (leaderboard widgets, trade cards), `discussions` (/discussions). Thread topics, comments, tags, cohort names, notes, agreements, goal titles and audit reasons are user content. Stage / tier names, next-action labels, risk labels and queue titles come from the server.

Feed phrases are gender-neutral in every language: RU short passive participles agree with the noun («добавлена сделка»), EN/UZ use the passive («trade added», «savdo qoʻshildi»); never a verb conjugated by the actor (guarded by `components/team/activity-model.test.ts`).

| RU | EN | UZ | Note |
|---|---|---|---|
| Кабинет куратора | Curator desk | Kurator kabineti | = `shell.nav.curator` |
| Группа (куратора) | Group | Guruh | traders assigned to a curator |
| Без куратора | No curator | Kuratorsiz | |
| Перевести в группу | Move to group | Guruhga oʻtkazish | |
| Риск-процессы | Risk processes | Risk jarayonlari | cabinet tab |
| Очередь разборов | Review queue | Tahlillar navbati | |
| Ждёт разбора | Waiting for review | Tahlil kutmoqda | |
| Без разбора (нарушения) | Unreviewed | Tahlilsiz | «{count} ta tahlilsiz» |
| Разбор нарушения | Violation review | Qoidabuzarlik tahlili | |
| Повторное (нарушение) | Repeat | Takroriy | within 7 days |
| Решение (по нарушению) | Decision | Qaror | the consequence picked |
| Последствие | Consequence | Oqibat | same as `rules` |
| Шаблон тира / шаблон лимитов | Tier template / limit template | Daraja shabloni / limitlar shabloni | |
| Лестница тиров | Tier ladder | Darajalar zinapoyasi | |
| Скейлинг | Scaling | Masshtablash | |
| Овернайт / свинг (лимит) | Overnight / swing | Overnight / swing | kept |
| Экспозиция | Exposure | Ekspozitsiya | |
| Эскалация | Escalation | Eskalatsiya | |
| Руководитель деска | Desk head | Desk rahbari | |
| Следующий шаг | Next step | Keyingi qadam | |
| Договорённости (1:1) | Agreements | Kelishuvlar | GLOSSARY |
| Цели развития | Development goals | Rivojlanish maqsadlari | |
| Заметка куратора | Curator note | Kurator qaydi | private staff note |
| Разговор / тревога / успех (тип заметки) | Call / concern / win | Suhbat / xavotir / yutuq | note kinds |
| Паттерны (поведения) | Behavior patterns | Xulq-atvor patternlari | |
| Лента активности | Activity feed | Faollik lentasi | |
| Дайджест дня | Daily digest | Kun dayjesti | |
| Эталон (в ленте) | Example | Namuna | = playbook glossary |
| Ревью / реакция | Review / reaction | Tahlil / reaksiya | feed |
| Тема (обсуждения) | Thread (title field: Title) | Mavzu | |
| Кому видна тема | Who can see the thread | Mavzuni kim koʻradi | audience |
| Стажёрам / Джунам / Трейдерам / Сеньорам / Кураторам | Interns / Juniors / Traders / Seniors / Curators | Stajyorlarga / Juniorlarga / Treyderlarga / Seniorlarga / Kuratorlarga | audience tokens |
| Наблюдаю / В позиции / Вышел | Watching / In position / Exited | Kuzatyapman / Pozitsiyada / Chiqdim | comment status (stored prefix stays RU) |
| Принятый ответ | Accepted answer | Qabul qilingan javob | |
| Закреплено / решено (тема) | Pinned / resolved | Qadalgan / hal qilindi | stored tags stay RU codes |
| Жалоба | Report | Shikoyat | GLOSSARY |
| Desk score | Desk score | Desk score | kept |
| Пьедестал | Podium | Shohsupa | |
| Вне зачёта | Not ranked | Hisobdan tashqari | |

## Notes, ideas & ratings (NOTES agent)

Namespaces: `notes` (Сводка автора / Сводка джунов), `ideas` (trade ideas, form, idea stats), `ratings` (ratings, scorecards, idea calibration, /top-results), `voice` (voice recorder + voice-note player). Note texts, curator feedback, quick replies the user saved, idea theses, review reasons, curator comments and focus texts are user content. Section headings stored inside author notes («## Рынок») and the junior compose headings sent to AI («Сделки — интрадей:») are storage formats and stay RU. The legacy horizon tag written into idea `tags` («Интрадей / Овернайт / Свинг») is a stored code and stays RU.

| RU | EN | UZ | Note |
|---|---|---|---|
| Сводка (дневная запись) | Note | Sharh | «Сводка автора» = Author’s notes = Muallif sharhi; «Сводка джунов» = Junior notes = Juniorlar sharhi; «Сводка дня» = Day note = Kun sharhi |
| AI-сводка (команды) | AI summary | AI-sharh | generated summary of several notes |
| Уроки (дня) | Lessons | Saboqlar | lessons learned; academy «Урок» stays Dars |
| Фокус на завтра | Focus for tomorrow | Ertangi fokus | |
| Состояние / настроение | State / mood | Holat / kayfiyat | |
| Сосредоточен / Уверен / Нейтрально / Напряжён / Раздражён | Focused / Confident / Neutral / Tense / Frustrated | Diqqatli / Ishonchli / Neytral / Tarang / Asabiy | mood scale |
| Охват (сводки) | Reach | Qamrov | who has read the note |
| Разбор сводки (ответ куратора) | Note review | Sharh tahlili | |
| Быстрые ответы | Quick replies | Tezkor javoblar | |
| Очередь (ответов) | Queue | Navbat | review queue |
| Диктовать / диктовка | Dictate / dictation | Ovozli yozish | speech recognition follows the UI language (uz-UZ → falls back to ru-RU) |
| Расшифровка | Transcript | Matn | voice note transcript |
| План vs факт | Plan vs actual | Reja va fakt | block inserted into lessons |
| Ревью (идеи) | Review | Koʻrib chiqish | «На ревью» = In review = Koʻrib chiqilmoqda |
| На доработку / Доработка | Send for rework / Rework | Qayta ishlashga / Qayta ishlash | |
| Сработала / Не сработала (идея) | Worked / Didn’t work | Ishladi / Ishlamadi | idea pipeline stage |
| Истекла (идея) | Expired | Muddati oʻtdi | |
| Одобряю / Сомневаюсь / Против | Agree / Unsure / Against | Qoʻllayman / Ikkilanaman / Qarshiman | team reactions |
| Репорт (жалоба) | Report | Shikoyat | |
| Проскальзывание | Slippage | Slippage | kept in UZ |
| Конверсия (идея → сделка) | Conversion | Konversiya | |
| Калибровка (скора) | Calibration | Kalibrlash | |
| Скор (идеи) | Score | Skor | kept; UZ prose may say «baho (score)» |
| Цель раньше стопа | Target before stop | Stopdan oldin maqsad | |
| Критерии оценки | Criteria | Mezonlar | Дисциплина / Риск-менеджмент / Исполнение / Журналирование / Прогресс = Discipline / Risk management / Execution / Journaling / Progress = Intizom / Risk-menejment / Ijro / Jurnal yuritish / Rivojlanish |
| Общая оценка | Overall score | Umumiy baho | |
| Зона роста / Сильная сторона | Growth area / Strength | Oʻsish zonasi / Kuchli tomon | |
| Лидерборд | Leaderboard | Liderbord | |
| Горячая серия | Hot streak | Issiq seriya | |
| В зачёте / вне зачёта | Qualified / not qualified | Hisobda / hisobdan tashqari | /top-results |
| Уровень риска (в оценке) | Risk tier | Risk darajasi | ladder labels come from common `tiers.*` |

## Game plan, weekly report, office stats (PLANS & REVIEWS agent)

Namespaces: `gamePlan` (/game-plan: desk briefing, my plan, trader plans, templates, screenshots), `weeklyReview` (/weekly-review + lib/weeklyInsights + dashboard widget «Психология недели»), `officeStats` (/office-stats). Market view, scenarios, notes, template names, self-reviews, curator comments and goals are user content. Office «Главное» insights, strategy rules and notes, behavior pattern titles, leak titles, day-report plan lines and psychology «Ключевые выводы» come from the server. Strategy codes OPG / OPGtoDAY / Day / MOC / AfterMarket / Overnight / OPT are never translated.

| RU | EN | UZ | Note |
|---|---|---|---|
| План деска | Desk plan | Desk rejasi | vs «Мой план» = My plan = Mening rejam |
| Премаркет-план / брифинг | Premarket plan / briefing | Premarket rejasi / brifing | |
| Настрой рынка | Market bias | Bozor kayfiyati | |
| Бычий / медвежий / нейтральный / смешанный | Bullish / bearish / neutral / mixed | Buqa / Ayiq / Neytral / Aralash | market bias |
| Оба направления | Both directions | Ikkala yoʻnalish | ticker bias; short «Оба» = Both = Ikkalasi |
| Сценарий A / B | Scenario A / B | A / B ssenariy | |
| Триггер входа | Entry trigger | Kirish triggeri | |
| Инвалидация — где неправ | Invalidation — where you’re wrong | Invalidatsiya — qayerda xato | read view «Неправ, если» = Wrong if = Xato, agar |
| Фокус дня / правило дня | Focus of the day / rule of the day | Kun fokusi / kun qoidasi | |
| Режим размера (обычный / сниженный / повышенный) | Size mode (normal / reduced / increased) | Oʻlcham rejimi (odatiy / kamaytirilgan / oshirilgan) | |
| Влияние (события) | Impact | Taʼsir | high / medium / low = Yuqori / Oʻrta / Past |
| Опубликовать / снять (план) | Publish / unpublish | Eʼlon qilish / eʼlondan olish | |
| Ознакомление / прочитали | Read status / read | Tanishuv / oʻqidi | |
| Заготовки (шаблоны) | Built-in (templates) | Tayyor shablonlar | |
| Снимок (TradingView) | Snapshot | Surat | |
| Самооценка | Self-review | Oʻz baho | weekly report |
| Разбор куратора | Curator review | Kurator tahlili | |
| Цель на неделю / цели прошлой недели | Goal for next week / last week’s goals | Keyingi hafta maqsadi / oʻtgan hafta maqsadlari | not the trade «Цель» (Target) |
| Выполнена / частично / не выполнена | Done / partly done / missed | Bajarildi / Qisman / Bajarilmadi | goal status |
| Утечка (денег) | Leak | Yoʻqotish | weekly tips |
| Трейдеру / Куратору / Партнёрам | For trader / For curator / For partners | Treyderga / Kuratorga / Hamkorlarga | report audiences |
| Чистый день | Clean day | Toza kun | no mistakes or violations |
| Готовность (чек-ин) | Readiness | Tayyorlik | psychology widget |
| Нетто (офиса) | Net | Sof / Sof natija | office KPI «Нетто 2026» = Net 2026 = Sof natija 2026 |
| Доля результата | Contribution | Natijadagi ulush | office strategy / trader tables |
| Доля объёма | Volume share | Hajm ulushi | |
| Цель (годовая, офис) | Target (annual target) | Maqsad (yillik maqsad) | fund-report wording |
| Темп к цели / опережение / отставание | Pace to target / ahead / behind | Maqsadga surʼat / oldinda / ortda | |
| Прогноз на год | Full-year projection | Yillik prognoz | |
| Месяц к месяцу | Month over month (Δ MoM) | Oyma-oy | |
| С начала года | Year to date (YTD) | Yil boshidan | |
| Главное (выводы) | Key takeaways | Asosiy xulosalar | office insights strip, partners view |
| Как считается | Methodology | Qanday hisoblanadi | office rules popover |
| Капитал и цель | Capital and target | Kapital va maqsad | |
| Пик → дно / восстановление | Peak → trough / recovery | Choʻqqi → tub / tiklanish | drawdown |
| Зелёный / красный день | Green / red day | Yashil / qizil kun | |
| п.п. (процентные пункты) | pp | f.p. | = common `units.percentPoints` |

## Playbook (PLAYBOOK agent)

Core words are in GLOSSARY.md (Плейбук = Playbook = Pleybuk, Сетап = Setup = Setap, Чек-лист = Checklist = Chek-list, Папка = Folder = Papka, Тег, Скриншот, Шаблон, Идея). Setup names, folder names, tags, notes, checklist items and structured-card texts are user content and are never translated. Structured card field labels live in `playbookI18n` → `structured.*`, tiers in `tier.*`, time of day in `timeOfDay.*`, sources in `source.*`.

| RU | EN | UZ | Note |
|---|---|---|---|
| Эталон / эталоны (пример сделки сетапа) | Example / examples | Namuna / namunalar | a trade attached to a setup as an example (any tier) |
| Эталонная сделка | Example trade | Namunaviy savdo | |
| Галерея эталонов | Example gallery | Namunalar galereyasi | |
| Tier 1 · Эталон | Tier 1 · Textbook | Tier 1 · Ideal | tier label; «Tier» stays |
| Tier 2 · Хорошая | Tier 2 · Good | Tier 2 · Yaxshi | |
| Tier 3 · На разбор | Tier 3 · To review | Tier 3 · Tahlilga | |
| Тир (эталона) | Tier | Tier | example tier, not the scaling tier |
| Офис (пространство) | Office | Ofis | office playbook space |
| Плейбук офиса | Office playbook | Ofis pleybuki | |
| Мой (пространство) / Мой плейбук | Mine / My playbook | Meniki / Mening pleybukim | |
| Общие (со мной) | Shared / Shared with me | Ulashilgan / Men bilan ulashilgan | |
| Команда (личные сетапы трейдеров) | Team | Jamoa | curator view |
| Пространство | Space | Boʻlim | office / mine / shared / team |
| В «Мой» (скопировать) | Copy to Mine | «Meniki»ga nusxalash | |
| Поделиться | Share | Ulashish | |
| Предложить в Офис / Предложено в Офис | Propose to Office / Proposed to Office | Ofisga taklif qilish / Ofisga taklif qilingan | |
| Перенести в Офис (промоут) | Move to Office | Ofisga koʻchirish | |
| Проверен / Проверено (куратором) | Reviewed | Tekshirilgan | setup review flag |
| На проверку / Не проверены | To review / Not reviewed | Tekshiruvga / Tekshirilmagan | quick filter |
| Вариация (подсетап) | Variation | Variant | child setup; «Вариация сетапа» = Setup variation = Setap varianti |
| Структурированная карточка | Structured card | Tuzilgan karta | |
| Контекст / Триггер / Вход / Стоп / Цели | Context / Trigger / Entry / Stop / Targets | Kontekst / Trigger / Kirish / Stop / Maqsadlar | field labels |
| Сопровождение | Management | Kuzatib borish | trade management field |
| Инвалидация | Invalidation | Bekor boʻlish | |
| Идеальные условия | Ideal conditions | Ideal sharoit | |
| Время дня | Time of day | Kun vaqti | |
| Edge (преимущество сетапа) | Edge | Edge | keep «edge» |
| Здоровье плейбука | Playbook health | Pleybuk holati | |
| Журнал изменений | Change log | Oʻzgarishlar jurnali | |
| Версии / ревизии | Versions | Versiyalar | revisions panel |
| Разобрать сделки (инбокс плейбука) | Sort trades | Savdolarni saralash | inbox: own trades without an example |
| Не для плейбука | Not for the playbook | Pleybuk uchun emas | inbox dismiss |
| Быстрый поиск | Quick find | Tezkor qidiruv | |
| Сравнить сетапы | Compare setups | Setaplarni solishtirish | |
| Ресёрч | Research | Tadqiqot | source type |
| Дневная лента | Daily feed | Kunlik lenta | source type |
| Масштаб | Zoom | Masshtab | |
| Корзина | Trash | Savat | deleted items |
| Библиотека / Сетка (вид) | Library / Grid | Kutubxona / Toʻr | view modes |
| Свои сделки | Own trades | Oʻz savdolari | |
| Автосетап (авто-определение) | Auto-detected setup | Avto-aniqlangan setap | |
| Примеры (раздел «Примеры»: тикер+дата) | Cases | Holatlar | playbook_ideas write-ups; not the same as «эталоны» (examples) |
| Отработал / частично / не отработал | Worked / partly / didn’t work | Ishladi / qisman / ishlamadi | case status |
| Карточка сетапа | Setup card | Setap kartasi | |
| Готовность к входу | Entry readiness | Kirishga tayyorlik | checklist marks |
| Общая / личная отметка | Shared / personal mark | Umumiy / shaxsiy belgi | |
| Режим рынка | Market regime | Bozor rejimi | edge breakdown |
| Тезис | Thesis | Tezis | legacy free-text heading |
| Шаблон (карточки) | Template | Shablon | Пробой уровня = Level breakout = Sathni yorib oʻtish |

## Premarket: indicators, watchlist, Big 7, market widgets (PREMARKET agent)

Indicator abbreviations (VWAP, AVWAP, RVOL, RSI, MACD, ATR, SMA/EMA, OBV, ORB, PMH/PML, PDH/PDL, HOD/LOD, POC/VAH), Risk-on / Risk-off, Big 7, Hot (board group), score, float, BMO/AMC, FOMC/CPI/NFP/OPEX codes stay as is.

| RU | EN | UZ | Note |
|---|---|---|---|
| Справочник (индикаторов) | Library | Qoʻllanma | /indicators tab |
| Рынок и мой эдж | Market & my edge | Bozor va mening ustunligim | /indicators tab |
| Эдж | Edge | Ustunlik | trader's edge |
| Мой набор | My set | Mening toʻplamim | favourite indicators |
| Пресет деска | Desk preset | Desk preseti | |
| Режим рынка | Market regime | Bozor rejimi | |
| Тренд вверх / вниз / боковик | Uptrend / downtrend / range | Yuqoriga trend / pastga trend / yon harakat | |
| Аппетит к риску / бегство от риска | Risk-on / risk-off | Risk ishtahasi / riskdan qochish | regime axis labels |
| Широта рынка | Market breadth | Bozor kengligi | |
| Индекс страха (VIX) | Fear index | Qoʻrquv indeksi | |
| Похожие дни | Similar days | Oʻxshash kunlar | analogue sessions |
| Перцентиль | Percentile | Persentil | |
| п.п. (процентные пункты) | pp | f.p. | via `common.units.percentPoints` |
| б.п. (базисные пункты) | bp | b.p. | |
| Откат | Pullback | Chekinish | indicator texts |
| Ретест | Retest | Retest | keep |
| Бумага (акция) | Stock | Aksiya | |
| Хай / лоу | High / low | Hay / lou | |
| Сигнал (алерт на индикаторе) | Alert | Signal | market cards bell |
| Списки вотчлиста: Сегодня / Свинги / Наблюдаю | Today / Swings / Watching | Bugun / Swinglar / Kuzatuvda | list codes today/swing/watch |
| Статусы: Наблюдаю / Пропустил / Торговал | Watching / Passed / Traded | Kuzatuvda / Oʻtkazib yuborildi / Savdo qilindi | |
| Сценарий (заметка тикера) | Plan | Ssenariy | watchlist note |
| Ближайший уровень | Nearest level | Eng yaqin sath | |
| Лесенка уровней | Level ladder | Sathlar narvoni | Big 7 |
| Мегакэпы | Megacaps | Megakaplar | |
| Тон рынка | Market tone | Bozor ohangi | Big 7 |
| Лидерство к QQQ | Leadership vs QQQ | QQQ ga nisbatan liderlik | |
| Вклад в QQQ | Contribution to QQQ | QQQ ga hissa | |
| Бриф открытия | Open brief | Ochilish brifi | widget |
| Фьючерсы | Futures | Fyucherslar | |
| Сила секторов | Sector strength | Sektorlar kuchi | widget |
| Разворот (против тренда) | Reversal | Burilish | |
| DNA рынка | Market DNA | Bozor DNA si | widget |
| Цитата дня | Quote of the day | Kun iqtibosi | widget |
| Макро-календарь | Macro calendar | Makro kalendar | |
| ФРС | Fed | Fed | |
| Размещение (новость/каталист) | Offering | Joylashtirish | = GLOSSARY |
| Гайденс | Guidance | Prognoz | |
| Экс-дивиденд | Ex-dividend | Ex-dividend | keep |

## Risk desk (RISK & RULES agent, namespace `risk`)

Follows GLOSSARY.md (Риск / Лимит / Просадка / Позиция / Овернайт / Счёт / Деск). Stop and breach messages always name the limit and give both numbers («Дневной лимит убытка исчерпан: $500 из $500»).

| RU | EN | UZ | Note |
|---|---|---|---|
| Риск-деск | Risk desk | Risk-desk | page / desk view |
| Мой риск | My risk | Mening riskim | trader view |
| Дневной / недельный стоп | Daily / weekly stop | Kunlik / haftalik stop | state when the loss limit is reached |
| Лимит убытка исчерпан | Loss limit reached | Zarar limitiga yetildi | «{used} из {limit}» = «{used} of {limit}» = «{used} / {limit}» |
| Близко к стопу / у лимита | Near stop / near limit | Stopga yaqin / limitga yaqin | ≥ 70% used |
| Нарушение (лимита) | Breach | Buzilish | limit breach (rule violation stays «Qoidabuzarlik») |
| До дневного стопа | Left to daily stop | Kunlik stopgacha | remaining room |
| Остаток дня | Day room left | Kun qoldigʻi | daily limit − today's loss |
| Экспозиция | Exposure | Ekspozitsiya | gross / net |
| Овернайт-экспозиция | Overnight exposure | Overnight ekspozitsiyasi | |
| Через закрытие / перенос | Through the close / carried | Yopilishdan keyin / koʻchirilgan | positions held past the close |
| Овернайт-книга / книга | Overnight book / book | Overnight portfeli / portfel | not «kitob» |
| Срез 15:45 ET | 15:45 ET cut-off | 15:45 ET kesimi | |
| Гэп-сценарии / шок | Gap scenarios / shock | Gap ssenariylari / shok | |
| Риск до стопов | Risk to stops | Stoplargacha risk | if every stop is hit |
| Стоп пробит | Stop hit | Narx stopdan oʻtgan | not «teshilgan» |
| Нереализованный P&L | Unrealized P&L | Realizatsiya qilinmagan P&L | short: «Realizatsiyasiz» |
| Концентрация | Concentration | Konsentratsiya | |
| Карточка трейдера | Trader card | Treyder kartasi | |
| Требует действия | Needs action | Harakat kerak | desk attention list |
| Заполнить по тиру | Fill from tier | Daraja boʻyicha toʻldirish | limits form preset |

## Rules and violations (RISK & RULES agent, namespace `rules`)

Rule kind labels / hints / field labels / summaries and violation messages come from the server rules catalog (server agent). Rule names and notes are user content (auto names are generated in the UI language when the rule is created). Built-in mistake categories are stored as their Russian label (data); only the display is translated (`mistakeLabel()` in components/rules/constants.ts).

| RU | EN | UZ | Note |
|---|---|---|---|
| Соблюдение (правила) | Compliance | Rioya | share of days without violations |
| Цена нарушений | Cost of violations | Qoidabuzarliklar narxi | net $ |
| Чистый день | Clean day | Toza kun | trading day without violations |
| Чистых дней подряд | Clean days in a row | Ketma-ket toza kunlar | |
| Календарь дисциплины | Discipline calendar | Intizom kalendari | |
| Самооценка (правило) | Self-check | Oʻz-oʻzini baholash | rule marked daily in the journal |
| Соблюдал / нарушил | Followed / broke | Rioya qildim / buzdim | self-check buttons |
| Серьёзность | Severity | Jiddiylik | |
| Низкая / средняя / высокая / критичная | Low / medium / high / critical | Past / oʻrta / yuqori / kritik | severity levels |
| Новое / принято / решено | New / acknowledged / resolved | Yangi / qabul qilindi / hal qilindi | violation status |
| Принять (нарушение) | Acknowledge | Qabul qilish | trader's action |
| Подтверждено / снято | Upheld / dismissed | Tasdiqlandi / bekor qilindi | curator's decision |
| Последствие | Consequence | Oqibat | set by the curator |
| Вернуть в работу | Reopen | Qayta ishga qaytarish | |
| Правило офиса / весь деск / моё | Office rule / whole desk / mine | Ofis qoidasi / butun desk / meniki | rule origin |
| Журнал ошибок | Mistake log | Xatolar jurnali | |
| Урок (вывод из ошибки) | Lesson | Saboq | not «Dars» (academy lesson) |
| Разобрано / не разобрано | Reviewed / not reviewed | Tahlil qilingan / tahlil qilinmagan | mistake review status |
| Паттерн (поведенческий) | Pattern | Pattern | behaviour patterns |
| Показать архив | Show archive | Arxivni koʻrsatish | archived violations |
| Предпросмотр (правила) | Preview | Oldindan koʻrish | «what if the rule had been in place» |
| Риск-деск | Risk desk | Risk-desk | limits source in the rule form |
| п.п. (процентные пункты) | pp | f.p. | compliance delta |
| Выключить / включить (правило) | Turn off / turn on | Faolsizlantirish / faollashtirish | not «Oʻchirish» — in UZ that is also «Удалить» (delete) |
| Выключено | Off | Faol emas | rule state |

## Scaling plan and pre-trade checklist (RISK & RULES wave, scaling/checklist helper)

Core words are in GLOSSARY.md: Тир = Tier = Daraja, Без тира = No tier = Darajasiz, План масштабирования = Scaling plan = Masshtablash rejasi, Повышение = Promotion = Koʻtarilish, Критерии перевода = Promotion criteria = Koʻtarilish mezonlari, Чек-лист / Пре-трейд чек-лист = Checklist / Pre-trade checklist = Chek-list / Savdodan oldingi chek-list. Tier names, tier descriptions, rule names and checklist items are written by curators (user content) and are not translated. Metric labels/hints, threshold-unit labels, rule texts and recommendation reasons come from the server (`/api/scaling/*`).

| RU | EN | UZ | Note |
|---|---|---|---|
| Понижение | Demotion | Tushirilish | pair of «Повышение / Koʻtarilish»; verb «Понизить» = Demote = Tushirish. Not «Pasayish» (= drawdown) |
| Повысить | Promote | Koʻtarish | button verb |
| Удержание (рекомендация) | Hold | Oʻzgarishsiz | tier recommendation «stay»; verb «Оставить» = Keep = Qoldirish. Not «Ushlab turish» (= hold time) |
| Назначить тир / назначение | Assign tier / assignment | Darajani tayinlash / tayinlash | not common `actions.assign` (UZ «Biriktirish» = attach) |
| Предложение (перевода) | Proposal | Taklif | «Предложить тир» = Propose tier = Darajani taklif qilish |
| Очередь на одобрение | Approval queue | Tasdiqlash navbati | |
| На рассмотрении / одобрено / отклонено | Under review / approved / rejected | Koʻrib chiqilmoqda / tasdiqlandi / rad etildi | proposal status |
| Лестница тиров | Tier ladder | Darajalar zinapoyasi | |
| Текущий / следующий / рекомендованный тир | Current / next / recommended tier | Joriy / keyingi / tavsiya etilgan daraja | ladder states |
| Верхний / нижний тир | Top / bottom tier | Eng yuqori / eng quyi daraja | |
| Условие (правила) | Condition | Shart | «{count} ta shartdan {passed} tasi» |
| Правило повышения / понижения | Promotion / demotion rule | Koʻtarilish / tushirilish qoidasi | |
| Выполнено / не выполнено | Met / not met | Bajarildi / bajarilmadi | rule status |
| Сработало / в норме | Triggered / OK | Ishga tushdi / meʼyorda | demotion rule status |
| Порог | Threshold | Chegara | |
| Окно (N торговых дней) | Window | Oyna | «{count} savdo kuni» |
| Риск-лимиты | Risk limits | Risk limitlari | |
| Дневной / недельный лимит убытка | Daily / weekly loss limit | Kunlik / haftalik zarar limiti | short form in GLOSSARY: «Дневной лимит» |
| Риск на сделку | Risk per trade | Bir savdoga risk | |
| Макс. позиция | Max position | Maks. pozitsiya | |
| Овернайт-экспозиция | Overnight exposure | Overnight ekspozitsiyasi | |
| Открытых позиций | Open positions | Ochiq pozitsiyalar | |
| Разрешён / запрещён | Allowed / not allowed | Ruxsat etilgan / taqiqlangan | |
| Нарушение лимита | Limit breach | Limit buzilishi | not «Qoidabuzarlik» (= rule violation) |
| Нужно решение | Needs a decision | Qaror kerak | desk filter |
| Пункт (чек-листа) | Item | Band | «Chek-list bandi» |
| Обязательный / дополнительный (пункт) | Required / additional | Majburiy / qoʻshimcha | |
| Н/П (не применимо) | N/A (not applicable) | Tegishli emas | answer button; UZ has no short form |
| Оценка (чек-листа) | Score | Baho | |
| Готовность / готов к сделке | Readiness / ready to trade | Tayyorlik / savdoga tayyor | |
| Чек-лист пройден / нарушен | Checklist passed / violated | Chek-list oʻtildi / buzildi | trade badge |
| Деактивировать / вернуть | Deactivate / restore | Faolsizlantirish / qaytarish | template item |

## Server texts: rules, behaviour, setups, permissions, academy (SERVER-A agent)

Server namespaces `rules`, `setups`, `behavior`, `psychology`, `academyPath`, `academyCohorts`, `academyContent`
(api-server `src/i18n/{ru,en,uz}/*.ts`) and capability texts (`en|uz/permissions.ts`). Academy EN/UZ texts reuse the
ACADEMY agent's translations (academyPath / academyCohorts) word for word.

| RU | EN | UZ | Note |
|---|---|---|---|
| Риск-деск | Risk desk | Risk-desk | limit source in rule summaries («(risk desk)») — same as risk.md / rules.md |
| Причина нарушения | Violation reason | Qoidabuzarlik sababi | stored as key + params in rule_violations.details.msg |
| Самооценка (вид правила) | Self-check | Oʻz-oʻzini baholash | rule kind marked once a day in the journal |
| «соблюдал / нарушил» | “kept / broke” | «rioya qildim / buzdim» | self-check marks |
| Окно (торговое) | Window / trading window | Oyna / savdo oynasi | |
| Нотионал | Notional | Nominal | position $ size |
| Усреднение убытка | Averaging down | Zararni oʻrtachalashtirish | |
| Добор | Add | Qoʻshimcha kirish | as GLOSSARY «Добор» |
| Удержание | Hold / hold time | Ushlab turish | as GLOSSARY |
| Множитель K | Multiplier K | Koeffitsiyent K | rule / trigger field |
| Мартингейл | Martingale | Martingeyl | behaviour pattern |
| Эйфория | Euphoria | Eyforiya | behaviour pattern |
| Отыгрыш (после красного утра) | Chasing (after a red morning) | Qaytarib olish | behaviour pattern «chase» |
| Красное утро | Red morning | Qizil ertalab | |
| Пересиживание убытков | Holding losers | Zararni ushlab oʻtirish | disposition effect |
| Индекс дисциплины | Discipline index | Intizom indeksi | |
| Мои триггеры / триггер | My triggers / trigger | Mening triggerlarim / trigger | personal behaviour triggers |
| Напоминание (триггер) | Reminder | Eslatma | custom trigger kind |
| Норма (сделок/день) | Norm | Meʼyor | |
| Скальпер / Свинг / позиционный | Scalper / Swing / position | Skalper / Swing / pozitsion | trading style |
| Чек-ин (утренний) | Check-in | Chek-in | psychology; matches trades-day.md |
| В фокусе / стресс / тревога / тильт / реванш / выспался | focused / stressed / anxious / tilt / revenge / well rested | diqqat jamlangan / stress / xavotir / tilt / revenge / yaxshi uxlagan | check-in states |
| Убеждённость | Conviction | Ishonch | 1–5★ |
| п.п. (процентные пункты) | pp | f.p. | win rate deltas |
| Авто-классификатор сетапов | Auto classifier | Avto-klassifikator | |
| Классы сетапов (ORB пробой, Momentum открытия, Fade гэпа, Возврат к VWAP, Отскок от VWAP …) | ORB breakout, Opening momentum, Gap fade, VWAP reversion, VWAP bounce … | ORB yorib oʻtish, Ochilish impulsi, Gap fade, VWAPga tortilish, VWAPdan qaytish … | display labels only; the RU name is the canonical value stored in trades.setup |
| перенос (удержание) | carried | olib oʻtilgan | hold bucket «overnight / swing» |
| Шаблон экзамена / капитал-экзамен | Exam template / capital exam | Imtihon shabloni / kapital imtihoni | |
| Статическая / трейлинг-просадка (по закрытию дня) | Static / trailing drawdown (at day close) | Statik / treyling pasayish (kun yopilishi boʻyicha) | matches academy frontend |
| Договорённость (1:1) | Agreement | Kelishuv | as academy.md |
| Отстаёт (причины) | Falling behind | Ortda qolmoqda | mentor dashboard reasons |
| Рубрика | Rubric | Baholash mezonlari | as academy.md |
| Права доступа (группы): Деск / Сделки / Дневник / Риск / Оценки / Контент / Администрирование | Desk / Trades / Journal / Risk / Ratings / Content / Administration | Desk / Savdolar / Kundalik / Risk / Baholar / Kontent / Administrlash | capability groups |

## Shell, settings, notifications, glossary tooltips (SHELL agent)

Namespaces: `common` (shared words, now also `undo`, `queryError`, `tagPicker`, `tagCategories`, `people`, `ds`, `tradeResult`, `kpiFormulas`, `periodNav`), `shell`, `settings`, `notifications`, `terms` (the desk glossary behind `<TermTooltip>`). Dates in Uzbek come from `i18n/uz-date.ts` (see «Dates» below).

| RU | EN | UZ | Note |
|---|---|---|---|
| Дайджест | Digest | Dayjest | morning / evening trade summary |
| Рассылка (Telegram) | Broadcast | Ommaviy xabar | admin message to all linked users |
| Оповещения (Telegram) | Alerts | Xabarnomalar | Telegram channel; in-app ones are «Уведомления / Bildirishnomalar» |
| Входящие | Inbox | Kiruvchilar | notification inbox tab |
| Не беспокоить | Do not disturb | Bezovta qilinmasin | |
| Заглушить | Mute | Ovozsiz qilish | |
| Колокольчик | Bell | Qoʻngʻiroqcha | header notification bell |
| Права доступа | Permissions | Kirish huquqlari | Settings → permissions matrix |
| Право (в матрице) | Permission | Huquq | one row of the matrix |
| Область (права) | Scope | Amal sohasi | «Весь деск / Подопечные» = Whole desk / Assigned = Butun desk / Biriktirilganlar |
| Закреплено (право) | Locked | Qulflangan | |
| Пульт деска | Desk console | Desk pulti | /admin |
| Бэкап | Backup | Zaxira / zaxira nusxa | |
| Снапшот | Snapshot | Snapshot | pg_dump snapshots |
| Плечо | Leverage | Leverej | |
| Горизонт по умолчанию | Default horizon | Standart gorizont | |
| Комиссия туда-обратно | Round-trip fees | Ikki tomonlama komissiya | |
| Выделенный счёт | Allocated account | Ajratilgan hisob | desk limit |
| Привязать / отвязать (Telegram) | Connect / disconnect | Ulash / uzish | |
| Тема (оформления): тёмная / сумеречная / светлая | Dark / dim / light | Toʻq / xira / yorugʻ | (already in GLOSSARY.md) |
| Матожидание (тултип) | Expectancy | Kutilma | `terms.expectancy` |
| Проскальзывание | Slippage | Slippage | |
| Широта рынка | Market breadth | Bozor kengligi | |
| Разводнение | Dilution | Suyultirish | = «Размытие» in GLOSSARY.md |
| Шелф | Shelf | Shelf | S-3 / F-3, keep |
| Варранты | Warrants | Varrantlar | |
| Дисконт размещения | Offering discount | Joylashtirish chegirmasi | |
| Запас денег (runway) | Cash runway | Pul zaxirasi | |
| Целевая цена | Price target (PT) | Maqsadli narx (PT) | |
| Вес фирмы | Firm weight | Firma vazni | analyst actions |
| День реакции | Reaction day | Reaksiya kuni | |
| Гэп | Gap | Gap | do not translate (UZ «gap», not «gep») |

### Dates (all languages via `fmtDate`; Uzbek hand-written in `i18n/uz-date.ts`)

| Style | RU | EN | UZ |
|---|---|---|---|
| short | 07.10.2026 | 10/07/2026 | 07.10.2026 |
| medium | 7 окт. 2026 г. | Oct 7, 2026 | 7-okt, 2026 |
| long | 7 октября 2026 г. | October 7, 2026 | 2026-yil 7-oktabr |
| full | среда, 7 октября 2026 г. | Wednesday, October 7, 2026 | chorshanba, 2026-yil 7-oktabr |
| monthYear | октябрь 2026 г. | October 2026 | 2026-yil oktabr |
| weekdayDayMonth | ср, 7 окт. | Wed, Oct 7 | Chor, 7-okt |

Months: yanvar, fevral, mart, aprel, may, iyun, iyul, avgust, sentabr, oktabr, noyabr, dekabr (short: yan, fev, mar, apr, may, iyn, iyl, avg, sen, okt, noy, dek). Weekdays: dushanba, seshanba, chorshanba, payshanba, juma, shanba, yakshanba (short: Dush, Sesh, Chor, Pay, Jum, Shan, Yak). Relative: «hozir», «5 daqiqa oldin», «2 soatdan keyin», «kecha», «ertaga», «oʻtgan oy». Uzbek numbers: `1 234 567,5` (CLDR uz separators).

## Trades & day (TRADES & DAY agent — trades, journal, EOD, day report, dashboard)
| RU | EN | UZ | Note |
|---|---|---|---|
| Профит (результат сделки) | Win | Foyda | result badge; code `win` |
| Открыта (сделка) | Open | Ochiq | result code `open` |
| Исполнения (вкладка) | Fills | Ijrolar | trade card tab; one fill = «Ijro» |
| Добор | Add | Qoʻshimcha kirish | execution kind |
| Частичный фикс | Partial exit | Qisman chiqish | execution kind |
| Перезаход | Re-entry | Qayta kirish | trade structure |
| Переворот | Flip | Teskari ochish | trade structure |
| Разметка (сделки) | Tags | Belgilash | setup / mistake / emotion chips |
| Умные подборки | Smart views | Aqlli tanlovlar | review presets on /trades |
| Требуют разбора | Need review | Tahlil kerak | preset |
| Захват (эффективность выхода) | Capture | Olingan | captured / MFE |
| На столе (недобор после выхода) | Left (on the table) | Stolda | quality filter |
| Сохранённый вид | Saved view | Saqlangan koʻrinish | filter preset |
| Разбор дня (страница /day-report) | Day review | Kun tahlili | nav title; link text «Отчёт дня» = Day report / Kun hisoboti |
| Отчёт дня (ссылка) | Day report | Kun hisoboti | links to /day-report |
| Дневник дня | Day journal | Kun kundaligi | journal editor panel |
| Итог дня | Day result | Kun yakuni | journal summary panel |
| Закрыть день / Закрытие дня | Close day / day close | Kunni yopish | EOD |
| Разбор по сделкам | Trade review | Savdolar tahlili | EOD deep dive |
| Очередь на проверку | Review queue | Tekshiruv navbati | curator EOD queue |
| Отзыв куратора | Curator feedback | Kurator fikri | |
| Ревью (куратора по сделке) | Review | Sharh | trade discussion tab |
| Фокус на завтра | Focus for tomorrow | Ertangi fokus | |
| Урок дня | Lesson of the day | Kun saboqi | |
| Настроение / шкала | Mood | Kayfiyat | 1–5: Tilt · Bad · Even · Good · In the flow / Tilt · Yomon · Bir tekis · Yaxshi · Oqimda |
| Дисциплина (шкала) | Discipline | Intizom | 1–5: Chaos · Weak · Fair · Good · Perfect / Tartibsiz · Zaif · Oʻrtacha · Yaxshi · Mukammal |
| Позиции на ночь | Overnight positions | Tunga qolgan pozitsiyalar | |
| Тезис в силе | Thesis valid | Tezis kuchda | |
| Гэп-риск | Gap risk | Gap riski | |
| Утечки (разбор дня) | Leaks | Yoʻqotishlar | day-report section |
| Кривая дня | Day curve | Kun egri chizigʻi | |
| Нарастающее нетто | Cumulative net | Jamlanma sof | |
| Отдано (от пика) | Given back | Qaytarildi | giveback |
| Хронология сделок | Trade timeline | Savdolar xronologiyasi | |
| Разрезы | Breakdowns | Kesimlar | |
| Утренний чек-ин | Morning check-in | Ertalabki chek-in | |
| Готовность (чек-ин) | Readiness | Tayyorlik | |
| Что важно сейчас | What matters now | Hozir nima muhim | dashboard panel |
| Следующий шаг | Next step | Keyingi qadam | |
| Деск сегодня | Desk today | Bugungi desk | |
| Серии (дашборд) | Streaks | Seriyalar | |
| Синхронизировано | Synced | Sinxronlandi | PropReports |
| Стоп по риску | Risk stop | Risk boʻyicha stop | |
| Теги-словарь (хранятся по-русски) | — | — | FOMO, Ранний вход, Страх… stay Russian codes in DB; shown via `tagLabel()` (trades `tag.*`) |

## Server texts: notifications, feed, reconciliation, PropReports, reports (SERVER-B agent)

Server dictionaries in `artifacts/api-server/src/i18n/{ru,en,uz}/*.ts`. Core terms follow GLOSSARY.md (Сверка = Reconciliation = Solishtirish, Расхождение = Difference = Farq, Переворот = Flip = Teskari ochish, Перезаход = Re-entry = Qayta kirish, Добор = Add = Qoʻshimcha kirish, Эталон = Example = Namuna, Офис / Мой = Office / Mine = Ofis / Meniki, Отыгрыш = Qaytarib olish, п.п. = pp = f.p.). Macro codes (FOMC, CPI, PPI, NFP, OPEX, SEP), ET and product names (PropReports) stay as is.

| RU | EN | UZ | note |
|---|---|---|---|
| Расхождение из-за округления комиссий | Difference caused by fee rounding | Komissiyalarni yaxlitlash sababli farq | reconciliation cause |
| Данные сходятся с брокером | Data matches the broker | Maʼlumotlar broker bilan mos | reconciliation summary |
| В пределах округления брокера | Within the broker's rounding | Broker yaxlitlashi doirasida | compare note |
| Снимок (PropReports) | Snapshot | Surat | broker snapshot of a trade |
| Исполнения (fills) | Executions (fills) | Ijrolar (fills) | |
| Итоги дня (запись ленты) | Day results | Kun yakunlari | EOD feed entry, activity title |
| Переносим через ночь | Carrying overnight | Tunga olib oʻtamiz | EOD entry |
| Автопривязка сделок | Trade auto-linking | Savdolarni avtomatik bogʻlash | playbook activity |
| Ждёт ответа / Без ответа: N | Awaiting reply / No reply: N | Javob kutmoqda / Javobsiz: N | junior review flags |
| Пропуск N дн. подряд | Missed N days in a row | Ketma-ket N kun oʻtkazildi | junior review flag |
| Передержал лосс | Held a loser | Zararni uzoq ushladi | mistake category |
| Усреднение (ошибка) | Averaging down | Zararni oʻrtachalashtirish | mistake category (≠ planned «Добор») |
| Нарушил лимит | Broke the limit | Limitni buzdi | mistake category |
| Сокращённый день | Early close | Qisqartirilgan kun | market calendar |
| Заседание FOMC (день решения) | FOMC meeting (decision day) | FOMC yigʻilishi (qaror kuni) | market calendar |
| Публикация CPI / PPI | CPI / PPI release | CPI / PPI eʼloni | market calendar |
| Ребалансировка конца месяца | Month-end rebalance | Oy oxiridagi rebalans | market calendar |
| За выходные (Пт–Вс) / За пятницу / За последний день | Over the weekend (Fri–Sun) / For Friday / For the last day | Dam olish kunlarida (Jum–Yak) / Juma uchun / Oxirgi kun uchun | market brief lookback |
| Разводнение | Dilution | Suyultirish | offerings risk factors |
| Локап | Lock-up | Lokap | offerings |
| Андеррайтер 1-го / 2-го уровня | Tier-1 / tier-2 underwriter | 1- / 2-darajali anderrayter | offerings |
| Брутто / нетто | Gross / net | Yalpi / sof | as GLOSSARY |

## Resolved conflicts (merge of the area files, 2026-10-18)

The same Russian term had different translations in two or more area files. One wins; dictionaries were aligned.

| RU | Chosen EN | Chosen UZ | Lost variant | Note |
|---|---|---|---|---|
| Проскальзывание | Slippage | Slippage | UZ «Sirpanish» (shell tooltips, journal) | kept as a trading term like gap / float |
| Гэп вверх / вниз | Gap up / down | Yuqoriga gap / pastga gap | UZ «Gap yuqoriga / pastga» (catalysts) | majority of screens (analytics, indicators, notes) |
| ФРС | Fed | Fed | UZ «FZT (Federal zaxira tizimi)» (premarket, big7) | like FOMC: an abbreviation users see in news |
| Переворот (позиции) | Flip | Teskari ochish | UZ «Burilish» (chart roles) | «Burilish» stays for reversal patterns only |
| Самооценка (правило, отмечаемое в дневнике) | Self-check | Oʻz-oʻzini baholash | UZ «Oʻzini baholash» (rules) | weekly-report «Самооценка» stays Self-review / Oʻz baho |
| Самооценка (недельный отчёт) | Self-review | Oʻz baho | EN «Self-assessment» (shell notifications/permissions) | aligned to plans |
| Отыгрыш (паттерн «chase») | Chasing | Qaytarib olish | UZ «Yutib olishga urinish» (server behaviour texts) | server dictionary still uses the lost variant — server agent to align |
| п.п. | pp | f.p. | UZ «p.p.» (server win-rate deltas) | `common.units.percentPoints`; server to align |
| Скор | Score | Skor | UZ «Score» (notes) | dilution / importance scores |

Homonyms (not conflicts, different meanings — keep both): Тир (scaling tier · Daraja / playbook example tier · Tier); Урок (academy lesson · Dars / lesson learned · Saboq); Удержание (hold time · Ushlab turish / scaling «stay» · Oʻzgarishsiz); Сессия (market · Sessiya / training session · Seans); Нарушение (rule violation · Qoidabuzarlik / limit breach · Buzilish); Тема (theme · Mavzu / discussion thread · Thread = Mavzu); Цель (IDP goal · Goal / annual target · Target); Заявка (request · Soʻrov / SEC filing · Ariza); Ревью (idea review · Koʻrib chiqish / trade discussion tab · Sharh); Быстрые ответы (Ask start screen · Quick answers / notes · Quick replies); Сценарий (Scenario / premarket watchlist note · Plan); Б/у (BE result · Nolda / stop-to-breakeven button · Nolga).
