import type { Messages } from "../../core";
import type ru from "../ru/indicatorLibrary";

export default {
  vwap: {
    name: "Hajm boʻyicha oʻrtacha tortilgan narx",
    timeframe: "1–5 daqiqa, faqat joriy sessiya",
    summary: "Kunning «adolatli narx» chizigʻi — algoritmlar va institutsionallar ijroni shunga qarab baholaydi.",
    deskUse: "Intradayning asosiy moʻljali: Long pozitsiyalar VWAP ustida, Short pozitsiyalar ostida ushlanadi. In play aksiyada kuchli ochilishdan keyin VWAPga birinchi chekinish — chiziq ortida qisqa stop bilan klassik A+ kirish. Hajm bilan VWAP flipi nazorat almashganini bildiradi.",
    settings: {
      s1: { label: "Manba", value: "HLC3" },
      s2: { label: "Langar", value: "sessiya, premarket bilan va premarketsiz" },
      s3: { label: "Polosalar", value: "±1σ / ±2σ" },
    },
    signals: {
      long: "Chekinishda VWAP ushlanadi + qaytishda hajm oshadi",
      short: "Zaif ochilishdan keyin VWAP pastdan rad etiladi",
      avoid: "Narx VWAPni u yoqqa-bu yoqqa kesib oʻtadi — chop: oʻlchamni kamaytiring yoki bozordan tashqarida turing",
    },
    pitfalls: {
      p1: "VWAPni kunlik grafikda va swingda ishlatish — u har sessiyada nolga tushadi",
      p2: "Lenta/hajm tasdigʻisiz birinchi tegishda kirish",
      p3: "Stopni aynan chiziqqa qoʻyish — shovqin urib chiqaradi",
    },
  },
  avwap: {
    name: "Anchored VWAP",
    timeframe: "5 daqiqadan kunlikkacha, langar voqeadan",
    summary: "Tanlangan nuqtadan VWAP: earnings, gap, hay/lou — voqea ishtirokchilarining oʻrtacha narxini koʻrsatadi.",
    deskUse: "Pozitsiyani olib oʻtish uchun: earnings yoki gap kunidan langar qoʻyamiz va narx AVWAP ustida ekan ushlaymiz. Overnight va swing uchun yaxshi trailing-stop — yangilikda sotib olganlar «oʻrtacha nolda» boʻlgan aniq sath.",
    settings: {
      s1: { label: "Langar", value: "earnings kuni / gap / swing low" },
      s2: { label: "Taymfreym", value: "intraday uchun 5 daqiqa, swing uchun kunlik" },
    },
    signals: {
      long: "Katalizator AVWAP iga chekinish va ushlanish",
      short: "Yuqoriga gapning AVWAPi yoʻqotiladi — gap yopilmoqda",
      avoid: "Bir vaqtda koʻp langar — chiziqlar aralashib ketadi",
    },
    pitfalls: {
      p1: "Voqeasiz tasodifiy shamdan langar qoʻyish",
      p2: "Uzoq langardan olingan AVWAP deyarli tekis va hech narsani anglatmasligini eʼtiborsiz qoldirish",
    },
  },
  rvol: {
    name: "Nisbiy hajm",
    timeframe: "Premarket va birinchi 30 daqiqa",
    summary: "Joriy hajm kunning shu vaqtidagi oʻrtachaga nisbatan — aksiya «oʻyinda»mi yoki yoʻqmi, shuni aniqlovchi filtr.",
    deskUse: "Ertalabki kun rejasining birinchi filtri: in play roʻyxatiga faqat RVOL ≥ 2 va katalizatori bor aksiyalar kiradi. Nisbiy hajmsiz eng ideal setap ham likvidlik tuzogʻi. Oʻlchamni oshirish — faqat RVOL ≥ 3 da.",
    settings: {
      s1: { label: "Baza", value: "10–20 kunlik oʻrtacha" },
      s2: { label: "Taqqoslash", value: "kun vaqti boʻyicha (time-of-day)" },
      s3: { label: "In play chegarasi", value: "≥ 2× (A+ — ≥ 3×)" },
    },
    signals: {
      long: "RVOL ≥ 3 + katalizator + premarket hayi ushlanadi",
      short: "RVOL yuqori, lekin narx yangi hay qila olmaydi — distribution",
      avoid: "RVOL < 1.5 — aksiya oʻyinda emas, oʻtkazib yuboring",
    },
    pitfalls: {
      p1: "RVOLni vaqtga tuzatishsiz kunlik oʻrtachadan hisoblash",
      p2: "Likvidsiz aksiyadagi yuqori RVOLni haqiqiy qiziqish deb oʻylash",
    },
  },
  pm: {
    name: "Premarket hayi va lousi",
    timeframe: "1–5 daqiqa, birinchi 60 daqiqa",
    summary: "Ertalabning asosiy sathlari: hajm bilan PMH yorib oʻtilishi — gap davomi, PML yoʻqotilishi — zaiflik.",
    deskUse: "Gap & go asosi: PMH/PMLni ochilishdan oldin kun rejasida belgilaymiz. PMH yorib oʻtilib, hajm bilan retest qilinganda Long, stop sath ostida. Gaper birinchi daqiqalarda PMLni yoʻqotsa — sathga qaytishda Short.",
    settings: {
      s1: { label: "Oyna", value: "04:00–09:30 ET" },
      s2: { label: "Tasdiq", value: "1–2 daqiqalik sham sath ortida yopiladi" },
    },
    signals: {
      long: "PMH yorib oʻtiladi + retest + RVOL > 3",
      short: "PMHdan rad etilish va VWAP yoʻqotiladi",
      avoid: "Yupqa premarket (< 100k aksiya) — sathlar ishonchsiz",
    },
    pitfalls: {
      p1: "Spredi keng aksiyada birinchi yorib oʻtishni retestsiz sotib olish",
      p2: "PMH ustidagi kunlik sathlarni hisobga olmaslik",
    },
  },
  orb: {
    name: "Ochilish diapazonini yorib oʻtish",
    timeframe: "1/5/15 daqiqalik diapazon",
    summary: "Birinchi N daqiqaning hay/lousi — yorib oʻtish in play aksiyalarda kun yoʻnalishini belgilaydi.",
    deskUse: "Ertalabki aksiyalar uchun mexanik kirish: 5 daqiqalik diapazon shakllanishini kutamiz, gap yoʻnalishida yorib oʻtishda kiramiz, stop oʻrtadan yoki qarama-qarshi chegaradan narida. R dagi risk diapazon kengligi bilan belgilanadi — oʻlchamni rejalash qulay.",
    settings: {
      s1: { label: "Diapazon", value: "5 daqiqa (agressiv — 1 daqiqa, konservativ — 15)" },
      s2: { label: "Stop", value: "diapazon oʻrtasi" },
      s3: { label: "Maqsad", value: "2R yoki keyingi sathgacha" },
    },
    signals: {
      long: "Gap yoʻnalishida diapazon hayi yorib oʻtiladi + VWAP ustida",
      short: "Gapga qarshi diapazon lousi yorib oʻtiladi (gap fade)",
      avoid: "Diapazon kunlik ATR × 0.5 dan keng — R juda qimmat",
    },
    pitfalls: {
      p1: "Katalizatorsiz aksiyalarda ORB savdo qilish",
      p2: "Keng diapazon Rni yeb qoʻyishini eʼtiborsiz qoldirish",
    },
  },
  rs: {
    name: "SPY/QQQga nisbatan nisbiy kuch",
    timeframe: "Intraday uchun 5 daqiqa, swing uchun kunlik",
    summary: "Aksiya bozordan kuchli yoki zaif — liderlarni Long, ortda qolganlarni Short qilamiz.",
    deskUse: "Bozor chekinganda kim ushlab turganini koʻramiz: SPY lou qilayotganda hay yangilayotgan aksiya — indeks burilganda birinchi Long nomzodi. Swing uchun — 1–3 oy davomida sektor (XLK, XLF…) bilan taqqoslash.",
    settings: {
      s1: { label: "Benchmark", value: "SPY / QQQ / sektor ETF" },
      s2: { label: "Hisoblash", value: "aksiya oʻzgarishi % − benchmark %" },
      s3: { label: "Oyna", value: "ochilishdan / 20 kun" },
    },
    signals: {
      long: "SPY chekinganda hayni ushlab turadi + VWAP ustida",
      short: "Indeks qaytganda bozordan zaif",
      avoid: "Aksiya indeks bilan 1:1 harakatlanadi — oʻz tarixi yoʻq",
    },
    pitfalls: {
      p1: "Oʻz sektoriga ergashadigan aksiyani SPY bilan taqqoslash",
      p2: "RS indikatorini RSI bilan adashtirish",
    },
  },
  ema: {
    name: "Eksponensial oʻrtacha",
    timeframe: "Intraday uchun 1–15 daqiqa, swing uchun kunlik",
    summary: "Tez oʻrtacha: 9/20 EMA — trend kunining «relslari».",
    deskUse: "Trend kunida in play aksiya 1–2 daqiqalik grafikda 9 EMAga chekinadi — bu qoʻshimcha kirish nuqtalari. 5 daqiqalikda 20 EMA ostida yopilish — oʻlchamni qisqartirish signali. Swingda kunlik 10/21 EMA impuls liderlarini ushlab turadi.",
    settings: {
      s1: { label: "Intraday", value: "9 va 20 EMA (1–5 daqiqa)" },
      s2: { label: "Swing", value: "10 va 21 EMA (kunlik)" },
      s3: { label: "Manba", value: "Close" },
    },
    signals: {
      long: "9 > 20, ikkalasi oʻsmoqda, 9 EMAga chekinish ushlandi",
      short: "9 < 20, 20 EMAga qaytish rad etildi",
      avoid: "Oʻrtachalar chigallashgan va tekis — yon harakat",
    },
    pitfalls: {
      p1: "Chopda har bir kesishishda kirish",
      p2: "1 daqiqalik EMA kontekstsiz shovqin ekanini hisobga olmaslik",
    },
  },
  ma: {
    name: "Oddiy sirpanuvchi oʻrtacha",
    timeframe: "Kunlik va 4H; 50/200 — swing uchun",
    summary: "Kunlik grafikdagi 50/200 SMA — butun bozor koʻradigan sathlar.",
    deskUse: "Swing va olib oʻtish uchun: oʻsayotgan 50 SMA ustidagi aksiyalar — Long nomzodlari, 50/200 SMAga chekinishlar aniq stop beradi. Intradayda narx yaqinidagi kunlik 200 SMA muhim — koʻpincha magnit va reaksiya sathi.",
    settings: {
      s1: { label: "Davrlar", value: "20 / 50 / 200" },
      s2: { label: "Taymfreym", value: "Daily" },
    },
    signals: {
      long: "Narx 50 SMA ustida, 50 > 200, 20/50 ga chekinish ushlandi",
      short: "Narx 200 SMA ostida, unga qaytish rad etildi",
      avoid: "Narx tekis 50 SMA atrofida aylanadi",
    },
    pitfalls: {
      p1: "Golden cross ni kirish sifatida kutish — signal kechikadi",
      p2: "Daqiqalik grafiklarda EMA oʻrniga SMA ishlatish",
    },
  },
  rsi: {
    name: "Nisbiy kuch indeksi",
    timeframe: "Intraday uchun 5–60 daqiqa, swing uchun kunlik",
    summary: "Haddan tashqari sotib olinganlik/sotilganlik va divergensiyalar ostsillyatori.",
    deskUse: "Deskda RSI kirish signali emas, choʻzilish filtri: 3+ kunlik tushishdan keyin RSI(2) < 5 boʻlgan aksiyada sathga mean-reversion qaytishini qidiramiz. Kun hayida 5 daqiqalik divergensiya — bir qismini qayd etish uchun sabab.",
    settings: {
      s1: { label: "Davr", value: "14 (swing), 2–5 (mean reversion)" },
      s2: { label: "Sathlar", value: "30 / 70, trendda 40 / 80" },
    },
    signals: {
      long: "RSI < 30 va qoʻllab-quvvatlash sathida yuqoriga burilish",
      short: "HODda ayiq divergensiyasi + VWAP yoʻqotiladi",
      avoid: "RSI 40–60 — choʻzilish yoʻq, ustunlik yoʻq",
    },
    pitfalls: {
      p1: "Kuchli trendda «haddan tashqari sotib olinganlik»ni Short qilish — RSI kunlab > 70 da turadi",
      p2: "Divergensiyani struktura tasdigʻisiz savdo qilish",
    },
  },
  macd: {
    name: "Oʻrtachalarning yaqinlashishi–uzoqlashishi",
    timeframe: "Swing uchun 1H–4H, intraday uchun 5–15 daqiqa",
    summary: "Trend impulsi: gistogramma tezlashish va soʻnishni koʻrsatadi.",
    deskUse: "Trigger emas, tasdiq sifatida ishlatamiz: maqsad yaqinida 15 daqiqalik gistogramma soʻnishi — qisman chiqish uchun sabab. Kunlik grafikda bazadan keyin noldan yuqorida kesishish — swing kuzatuv roʻyxatiga nomzod.",
    settings: {
      s1: { label: "Parametrlar", value: "12 / 26 / 9" },
      s2: { label: "Rejim", value: "gistogramma + chiziqlar" },
    },
    signals: {
      long: "Konsolidatsiyadan keyin noldan yuqorida yuqoriga kesishish",
      short: "Qaytishda noldan pastda pastga kesishish",
      avoid: "Chiziqlar nol atrofida va chigallashgan",
    },
    pitfalls: {
      p1: "Daqiqalik grafiklarda kesishish boʻyicha kirish — kuchli kechikish",
      p2: "Narx strukturasiga qaramaslik",
    },
  },
  bollinger: {
    name: "Bollinger polosalari",
    timeframe: "15 daqiqadan kunlikkacha",
    summary: "±2σ kanal: siqilish volatillik chiqishidan ogohlantiradi.",
    deskUse: "Kunlik grafikda squeeze (6 oydagi eng tor kenglik) — aksiya earnings yoki katalizatordan oldin swing kuzatuv roʻyxatiga. Intraday: RVOL bilan polosadan oʻtish — burilish emas, davom.",
    settings: {
      s1: { label: "Davr", value: "20" },
      s2: { label: "Ogʻish", value: "2σ" },
      s3: { label: "Squeeze", value: "BB Keltner 1.5 ATR ichida" },
    },
    signals: {
      long: "Hajm bilan siqilishdan yuqoriga chiqish",
      short: "Yuqori polosadan rad etilish + RSI divergensiyasi",
      avoid: "Impulsdan keyin keng polosalar — volatillik allaqachon chiqqan",
    },
    pitfalls: {
      p1: "Trendda yuqori polosaga har bir tegishni sotish",
      p2: "Siqilishdan chiqish yoʻnalishini oldindan taxmin qilish",
    },
  },
  atr: {
    name: "Oʻrtacha haqiqiy diapazon",
    timeframe: "Oʻlcham uchun kunlik, stoplar uchun 5 daqiqa",
    summary: "Aksiya harakatining oʻlchovi — pozitsiya oʻlchami, stoplar va gap-riskning asosi.",
    deskUse: "Desk risk-menejmenti: stop = intraday uchun 0.5–1 ATR (5 daqiqa), swing uchun 1–2 ATR (kunlik). Oʻlcham = $ dagi risk / stop masofasi. Overnight uchun: kunlik ATR × pozitsiya overnight ekspozitsiya limitidan oshsa — olib oʻtishdan oldin qisqartiramiz.",
    settings: {
      s1: { label: "Davr", value: "14" },
      s2: { label: "Kunlik", value: "swing oʻlchami va gap-risk" },
      s3: { label: "5 daqiqa", value: "intraday stoplari va maqsadlari" },
    },
    signals: {
      long: "Yorib oʻtishda ATR kengayadi — trend kuch yigʻmoqda",
      short: "Sotuvlarda ATR kengayadi",
      avoid: "Aksiya bugun allaqachon > 1.5 ATR yurgan — yoʻl kam qolgan, quvish kech",
    },
    pitfalls: {
      p1: "ATRi turlicha aksiyalarda bir xil pozitsiya oʻlchami",
      p2: "Earningsdan keyin stopni qayta hisoblashni unutish — ATR oshgan",
    },
  },
  "volume-profile": {
    name: "Hajm profili",
    timeframe: "Intraday uchun sessiya, swing uchun hafta/oy",
    summary: "Hajm qayerda savdo qilingan: POC, value area, tez oʻtishlar uchun «boʻshliqlar».",
    deskUse: "Hajm boʻyicha maqsad va stoplar: low-volume node orqali narx tez oʻtadi — maqsadlarni oʻsha yerga, stoplarni high-volume node ortiga qoʻyamiz. Olib oʻtish uchun oldingi kunlar value area si ustidagi pozitsiya xavfsizroq.",
    settings: {
      s1: { label: "Turi", value: "sessiyaviy / qatʼiy diapazon" },
      s2: { label: "Value area", value: "70%" },
      s3: { label: "Qadam", value: "tik boʻyicha avto" },
    },
    signals: {
      long: "VAH ustida qabul qilinish + retestda POC ushlanadi",
      short: "VAHdan rad etilish va value area ga qaytish",
      avoid: "Narx value area ichida — rotatsiya",
    },
    pitfalls: {
      p1: "Profilni juda qisqa diapazon boʻyicha qurish",
      p2: "Premarket hajmini eʼtiborsiz qoldirish",
    },
  },
  stochastic: {
    name: "Stoxastik",
    timeframe: "15 daqiqadan kunlikkacha",
    summary: "Yopilishning diapazondagi oʻrni — trenddagi chekinishlar vaqtini topish.",
    deskUse: "Ikkinchi darajali vosita: kunlik grafikdagi barqaror trendda %Kning < 20 zonasidan chiqishi swing pozitsiyaga qoʻshish vaqtini beradi. Daqiqalik grafiklarda desk uni deyarli ishlatmaydi — juda shovqinli.",
    settings: {
      s1: { label: "Parametrlar", value: "14 / 3 / 3" },
      s2: { label: "Sathlar", value: "20 / 80" },
    },
    signals: {
      long: "Aptrendda %K < 20 zonasidan %Dni yuqoriga kesadi",
      short: "Dauntrendda %K > 80 zonasidan %Dni pastga kesadi",
      avoid: "40–60 zonasi va yon harakat",
    },
    pitfalls: {
      p1: "«Haddan tashqari sotib olinganlik» boʻyicha trendga qarshi savdo qilish",
      p2: "1 daqiqalikda ishlatish",
    },
  },
  fibonacci: {
    name: "Fibonachchi sathlari",
    timeframe: "Swing uchun 4H–kunlik, intraday uchun 5–15 daqiqa",
    summary: "Impulsdan chekinish chuqurligi: 38.2 / 50 / 61.8%.",
    deskUse: "Faqat boshqa sathlar bilan birga: ertalabki impulsning 50–61.8% iga chekinish VWAP yoki kunlik sath bilan mos tushsa — kirish zonasi. Deskda Fib yolgʻiz oʻzi savdo sababi hisoblanmaydi.",
    settings: {
      s1: { label: "Sathlar", value: "38.2 / 50 / 61.8 / 78.6" },
      s2: { label: "Kengaytmalar", value: "maqsadlar uchun 127.2 / 161.8" },
    },
    signals: {
      long: "Hajm bilan 50–61.8%dan qaytish, VWAP bilan mos tushadi",
      short: "Dauntrendda qaytishda 38.2–50%dan rad etilish",
      avoid: "Noaniq impuls boʻyicha chizilgan toʻr",
    },
    pitfalls: {
      p1: "Impulsni kerakli sathga moslashtirish",
      p2: "Stopni aynan sathga qoʻyish",
    },
  },
  "support-resistance": {
    name: "Qoʻllab-quvvatlash va qarshilik",
    timeframe: "Barcha taymfreymlar, kattalari salmoqliroq",
    summary: "Narx avval burilgan sathlar: kunlik hay/loular, yaxlit sonlar.",
    deskUse: "Kun rejasining karkasi: har bir in play aksiya uchun kunlik grafikdan 2–4 sath + PDH/PDL. Sath yonida kirish qisqa stop va aniq R beradi. Olib oʻtishda stopni daqiqalik emas, kunlik sath ortiga qoʻyamiz.",
    settings: {
      s1: { label: "Manba", value: "PDH/PDL, 20–60 kunlik hay/loular, yaxlit sonlar" },
      s2: { label: "Zona", value: "sath atrofida ±0.1–0.2 ATR" },
    },
    signals: {
      long: "Yorib oʻtilgan qarshilikni qoʻllab-quvvatlash sifatida retest qilish",
      short: "Hayni soxta yorib oʻtish va sath ostiga qaytish",
      avoid: "Narx sathlar oʻrtasida — yomon R",
    },
    pitfalls: {
      p1: "Juda koʻp sath chizish",
      p2: "Sathni zona emas, chiziq deb hisoblash",
    },
  },
  volume: {
    name: "Hajm",
    timeframe: "Barcha taymfreymlar",
    summary: "Har qanday harakatning tasdigʻi: hajmsiz yorib oʻtish shubhali.",
    deskUse: "Yorib oʻtishdagi hajm shamlar oʻrtachasidan ≥ 2× — A+ setap sharti. Chekinishda hajm soʻnishi va davom etishda oshishi — klassik davom. Ekstremumdagi klimaktik hajm — tugash belgisi.",
    settings: {
      s1: { label: "Oʻrtacha", value: "20 sham" },
      s2: { label: "Ajratish", value: "> oʻrtachadan 2×" },
    },
    signals: {
      long: "Oʻsishda hajm oshadi, chekinishda soʻnadi",
      short: "Hayda klimaktik hajm + uzun soya",
      avoid: "Hajm oʻrtachadan past — qiziqish yoʻq",
    },
    pitfalls: {
      p1: "Ertalabki shamlar hajmini kun oʻrtasidagilar bilan taqqoslash",
      p2: "Ochilishdagi hajmni haqiqiy qiziqishdan farqlamaslik",
    },
  },
  obv: {
    name: "Balans hajmi",
    timeframe: "Swing uchun kunlik, intraday uchun 1H",
    summary: "Toʻplangan hajm: narx bilan divergensiya — erta signal.",
    deskUse: "Swing filtri: OBV narxdan oldin yangi hayda — toʻplanish, aksiyani kuzatuv roʻyxatiga. Intraday uchun foydasi kam.",
    settings: {
      s1: { label: "Taymfreym", value: "Daily" },
      s2: { label: "Silliqlash", value: "OBV boʻyicha 20 EMA" },
    },
    signals: {
      long: "OBV hayni narxdan oldin yangilaydi",
      short: "Narx oʻsadi, OBV tushadi",
      avoid: "OBV tekis",
    },
    pitfalls: {
      p1: "OBVning mutlaq qiymatiga qarash",
      p2: "Daqiqalik grafiklarda ishlatish",
    },
  },
  gap: {
    name: "Gap",
    timeframe: "Ochilishda 1–5 daqiqa, kontekst uchun kunlik",
    summary: "Ochilishdagi narx uzilishi: gap & go yoki gap fill — ertalabning asosiy voqeasi.",
    deskUse: "Ertalabki skaner: gap ≥ 4% + katalizator + RVOL. Gap & go — PMH va VWAP ushlanadi; gap fade — kunlik qarshilikda rad etilish. Overnight uchun gap — bu risk: olib oʻtiladigan pozitsiya oʻlchamini gap-risk limitigacha qisqartiramiz.",
    settings: {
      s1: { label: "Chegara", value: "≥ 4% (yirik kompaniyalar ≥ 2%)" },
      s2: { label: "Filtr", value: "katalizator + RVOL ≥ 2" },
      s3: { label: "Gap-risk", value: "earningsda ≈ 1–2 kunlik ATR" },
    },
    signals: {
      long: "Yangilikda yuqoriga gap, PMH va VWAP ushlanadi",
      short: "Kunlik qarshilikka gap, VWAP yoʻqotiladi — fade",
      avoid: "Yangiliksiz va hajmsiz gap",
    },
    pitfalls: {
      p1: "Kuchli katalizatorli gapni birinchi daqiqalarda Short qilish",
      p2: "Earnings orqali toʻliq oʻlchamni olib oʻtish",
    },
  },
  "flag-pennant": {
    name: "Bayroq va vimpel",
    timeframe: "Intraday uchun 1–5 daqiqa, swing uchun kunlik",
    summary: "Impulsdan keyingi pauza — bayroq dastasi yoʻnalishida davom.",
    deskUse: "Ertalabki impulsdan keyin 1–2 daqiqalik bull flag — eng koʻp uchraydigan impuls kirishi: stop bayroq ostida, maqsad — dasta uzunligi. Swingda — oʻsish liderlaridagi high tight flag.",
    settings: {
      s1: { label: "Dasta", value: "≥ 2 ATR (5 daqiqa)" },
      s2: { label: "Chekinish", value: "dastaning ≤ 50%i" },
      s3: { label: "Hajm", value: "bayroqda soʻnadi" },
    },
    signals: {
      long: "Bayroqning yuqori chegarasi hajm bilan VWAP ustida yorib oʻtiladi",
      short: "VWAP ostida bear flag, pastga yorib oʻtish",
      avoid: "Chekinish 50%dan chuqur — bayroq buzilgan",
    },
    pitfalls: {
      p1: "Impulssiz har qanday pauzani bayroq deb qabul qilish",
      p2: "Yorib oʻtishdan oldin kirish",
    },
  },
  hammer: {
    name: "Bolgʻa / tushayotgan yulduz",
    timeframe: "Intraday uchun 5–15 daqiqa, swing uchun kunlik",
    summary: "Sathda uzun pastki soya — sotuvchilar rad etildi.",
    deskUse: "Signal faqat sath yonida: kunlik qoʻllab-quvvatlash yoki VWAPda hajm bilan bolgʻa — sham hayi ustida kirish, stop soya ostida. Sathsiz — shunchaki sham.",
    settings: {
      s1: { label: "Soya", value: "≥ tanadan 2×" },
      s2: { label: "Kontekst", value: "pasayishdan keyin, sath yonida" },
    },
    signals: {
      long: "Qoʻllab-quvvatlashda bolgʻa + sham hayi yorib oʻtiladi",
      short: "Qarshilikda tushayotgan yulduz + lou yorib oʻtiladi",
      avoid: "Diapazon oʻrtasidagi sham",
    },
    pitfalls: {
      p1: "Shamni sath va hajmsiz savdo qilish",
      p2: "Stop soya ichida",
    },
  },
  engulfing: {
    name: "Yutish",
    timeframe: "15 daqiqadan kunlikkacha",
    summary: "Sham tanasi oldingisini qoplaydi — nazorat almashadi.",
    deskUse: "Kunlik grafikda chekinishdan keyin 50 SMA yonidagi buqa yutishi — pattern ostida stop bilan swing kirish. Intradayda HOD/LODda 15 daqiqalikda foydali.",
    settings: {
      s1: { label: "Shart", value: "tana oldingi tanani qoplaydi" },
      s2: { label: "Hajm", value: "oʻrtachadan yuqori" },
    },
    signals: {
      long: "LOD/qoʻllab-quvvatlashda buqa yutishi",
      short: "HOD/qarshilikda ayiq yutishi",
      avoid: "Yon harakat ichidagi yutish",
    },
    pitfalls: {
      p1: "Sham oʻlchamini ATRga nisbatan eʼtiborsiz qoldirish",
      p2: "Sham yopilishidan oldin kirish",
    },
  },
  doji: {
    name: "Doji",
    timeframe: "5 daqiqadan kunlikkacha",
    summary: "Qatʼiyatsizlik: ochilish ≈ yopilish.",
    deskUse: "Deskda bu kirish emas, ogohlantirish: choʻzilishdan keyin ekstremumdagi doji — stopni yaqinlashtirish yoki qisman foyda olish uchun sabab.",
    settings: {
      s1: { label: "Tana", value: "diapazonning ≤ 10%i" },
    },
    signals: {
      long: "Qoʻllab-quvvatlashda doji + ortidan buqa shami",
      short: "Qarshilikda doji + ortidan ayiq shami",
      avoid: "Harakat oʻrtasidagi doji",
    },
    pitfalls: {
      p1: "Dojini mustaqil signal sifatida savdo qilish",
    },
  },
  "head-shoulders": {
    name: "Bosh va yelkalar",
    timeframe: "1Hdan kunlikkacha",
    summary: "Trenddan keyingi burilish: boʻyin chizigʻi yorib oʻtiladi.",
    deskUse: "Boʻyin yorib oʻtilib, retest muvaffaqiyatsiz boʻlgandan keyin swing Short. Intradayda choʻzilgan kundan keyin 5 daqiqalikda uchraydi, lekin ishonchliligi pastroq.",
    settings: {
      s1: { label: "Maqsad", value: "boshning boʻyindan balandligi" },
      s2: { label: "Tasdiq", value: "hajm bilan boʻyin ostida yopilish" },
    },
    signals: {
      long: "Teskari H&S + boʻyin yorib oʻtiladi",
      short: "H&S + boʻyin pastga yorib oʻtiladi va retest",
      avoid: "Shakllanish tugallanmagan",
    },
    pitfalls: {
      p1: "Boʻyin yorib oʻtilishidan oldin kirish",
      p2: "Patternni hamma joyda koʻrish",
    },
  },
  "double-top-bottom": {
    name: "Ikki choʻqqi / ikki tub",
    timeframe: "15 daqiqadan kunlikkacha",
    summary: "Ekstremumning ikki testi — trendni davom ettira olmaslik.",
    deskUse: "Intraday: HODning kamroq hajmdagi ikkinchi testi + VWAP yoʻqotiladi — Short. Kunlik grafikda sath yonidagi ikki tub — swing Long.",
    settings: {
      s1: { label: "Ruxsat", value: "choʻqqilar 0.2 ATR doirasida" },
      s2: { label: "Tasdiq", value: "oʻrta yorib oʻtiladi" },
    },
    signals: {
      long: "Ikki tub + oʻrta yorib oʻtiladi",
      short: "Ikki choʻqqi + VWAP yoʻqotiladi",
      avoid: "Ikkinchi test kattaroq hajmda — yorib oʻtishi mumkin",
    },
    pitfalls: {
      p1: "Ikkinchi testni tasdiqdan oldin Short qilish",
    },
  },
} satisfies Messages<typeof ru>;
