import type { Messages } from "../../core";
import type ru from "../ru/terms";

export default {
  r: { label: "R", title: "R — risk birligi", text: "Savdo natijasi risk ulushlarida: +2R — ikkita rejalashtirilgan risk miqdorida topdingiz, −1R — bittasini yoʻqotdingiz.", formula: "R = P&L / savdo uchun risk" },
  avgR: { label: "Oʻrt. R", title: "Oʻrtacha R", text: "Bitta yopilgan savdoning R dagi oʻrtacha natijasi.", formula: "ΣR / savdolar soni" },
  expectancy: { label: "Kutilma", title: "Matematik kutilma", text: "Win rate va foyda/zarar hajmini hisobga olganda bitta savdo oʻrtacha necha R keltiradi. > 0 — tizim foydada.", formula: "WR × oʻrt. foyda − (1 − WR) × oʻrt. zarar" },
  pf: { label: "PF", title: "Profit factor", text: "Foydali savdolar yigʻindisi zararlilar yigʻindisidan necha marta katta. > 1 — foydada, ≥ 2 — kuchli natija.", formula: "ΣR⁺ / |ΣR⁻|" },
  winrate: { label: "Win rate", title: "Win rate (WR)", text: "Natijasi aniq savdolar ichida foydalilari ulushi; noldagi savdolar hisobga olinmaydi.", formula: "W / (W + L)" },
  payoff: { label: "Payoff", title: "Payoff ratio", text: "Oʻrtacha foydali savdoning oʻrtacha zararli savdoga nisbati. Joriy win rate bilan foydalar hajmi yetarlimi — shuni koʻrsatadi.", formula: "oʻrt. foyda / |oʻrt. zarar|" },
  mfe: { label: "MFE", title: "MFE — eng katta qulay harakat", text: "Savdo davomida narx siz tomonga eng koʻpi bilan qancha yurdi. Qancha foyda mavjud boʻlganini koʻrsatadi.", formula: "kirishdan R yoki $ da" },
  mae: { label: "MAE", title: "MAE — eng katta noqulay harakat", text: "Chiqishgacha narx pozitsiyaga qarshi qanchalik chuqur ketdi. Stop juda keng yoki tor emasligini tekshirishga yordam beradi.", formula: "kirishdan R yoki $ da" },
  drawdown: { label: "Pasayish", title: "Maksimal pasayish", text: "Kapital egri chizigʻining oldingi choʻqqidan eng past nuqtagacha eng chuqur tushishi.", formula: "min(kapital − choʻqqi)" },
  net: { label: "Sof", title: "Sof P&L", text: "Brokerning barcha komissiya va yigʻimlaridan (comm, ECN, SEC, TAF) keyingi natija. Standart boʻyicha barcha pul KPI lari sof.", formula: "yalpi − komissiyalar" },
  gross: { label: "Yalpi", title: "Yalpi P&L", text: "Komissiya va yigʻimlar ayirilishidan oldin kirish va chiqish narxi boʻyicha natija." },
  fees: { label: "Komissiyalar", title: "Komissiyalar va yigʻimlar", text: "Broker yechgan hamma narsa: komissiya, ECN, SEC, TAF va boshqa yigʻimlar." },
  openRisk: { label: "Ochiq risk", title: "Ochiq risk", text: "Barcha ochiq pozitsiyalar stop boʻyicha yopilsa, hozir qancha yoʻqotish mumkin." },
  bp: { label: "BP", title: "Buying power", text: "Xarid qobiliyati: firma bir vaqtda ushlab turishga ruxsat beradigan pozitsiyalarning maksimal hajmi." },
  dailyLoss: { label: "Kunlik limit", title: "Kunlik zarar limiti", text: "Kun uchun maksimal zarar. Unga yetilganda keyingi sessiyagacha savdo toʻxtatiladi (red day stop)." },
  gapRisk: { label: "Gap riski", title: "Gap riski", text: "Tun yoki dam olish kunlaridan keyin narx stopdan narida ochilishi va zarar rejalashtirilgan 1R dan oshib ketishi xavfi." },
  inPlay: { label: "In play", title: "Oʻyindagi aksiya", text: "Bugun katalizatori va yuqori hajmi bor tiker — savdo uchun nomzod." },
  catalyst: { label: "Katalizator", title: "Katalizator", text: "Aksiyani harakatga keltiradigan voqea: hisobot, guidance, upgrade, FDA, joylashtirish, yangilik." },
  aPlus: { label: "A+", title: "A+ setap", text: "Pleybuk chek-listining barcha bandlari mos kelgan setap. Unda toʻliq yoki kattalashtirilgan oʻlcham joiz." },
  rvol: { label: "RVOL", title: "Nisbiy hajm", text: "Bugungi hajmning xuddi shu vaqt oraligʻidagi oʻrtacha hajmga nisbati. > 2 — aksiya odatdagidan sezilarli faolroq.", formula: "hajm / oʻrtacha hajm" },
  atr: { label: "ATR", title: "ATR — oʻrtacha haqiqiy diapazon", text: "Aksiyaning odatiy kunlik harakati. Stop va maqsadlarni volatillik koʻlamida qoʻyishga yordam beradi." },
  vwap: { label: "VWAP", title: "VWAP", text: "Hajm boʻyicha tortilgan kunning oʻrtacha narxi. Sessiya ichidagi «adolatli» narx uchun moʻljal." },
  float: { label: "Float", title: "Free float", text: "Erkin muomaladagi aksiyalar soni. Kichik float — keskin harakatlar va keng spred." },
  si: { label: "SI", title: "Short interest", text: "Floatning qisqa pozitsiyalardagi ulushi. Yuqori SI short-squeeze ehtimolini oshiradi." },
  premarket: { label: "Premarket", title: "Premarket", text: "Ochilishgacha savdolar: 4:00–9:30 ET. Likvidlik pastroq, spredlar kengroq." },
  horizon: { label: "Gorizont", title: "Ushlab turish gorizonti", text: "Intraday — kun oxirigacha yopiladi; overnight — tundan oʻtkaziladi; swing — bir necha kundan boshlab." },
  streak: { label: "Seriya", title: "Seriya", text: "Ketma-ket nechta savdo yoki kun foydada yoki zararda boʻldi." },
  sqn: { label: "SQN", title: "System Quality Number", text: "Van Tarp boʻyicha tizim sifati: kutilma natijalar tarqoqligiga boʻlingan, savdolar soniga tuzatilgan. > 2 — yaxshi.", formula: "√N × oʻrt. R / σR" },
  rr: { label: "R:R", title: "Risk / foyda", text: "Savdoga kirishdan oldin risk birligi uchun qancha topishni rejalashtiryapsiz.", formula: "(maqsad − kirish) / (kirish − stop)" },
  slippage: { label: "Slippage", title: "Slippage", text: "Rejalashtirilgan va haqiqiy ijro narxi oʻrtasidagi farq." },
  beta: { label: "Beta", title: "Beta", text: "Aksiya oʻrtacha bozor bilan birga qanchalik kuchli harakatlanadi: 1 — S&P 500 kabi, 2 — ikki barobar kuchli, < 1 — bozordan sokinroq." },

  // Market regime
  vix: { label: "VIX", title: "VIX — qoʻrquv indeksi", text: "S&P 500 ning keyingi 30 kunlik kutilayotgan volatilligi. 15 dan past — sokin bozor va tor diapazonlar, 15–20 — meʼyor, 25 dan yuqori — asabiy lenta va keskin burilishlar." },
  vixTerm: { label: "VIX / VIX3M", title: "VIX tuzilmasi", text: "30 kunlik volatillikning 3 oylikka nisbati. 1 dan past — qoʻrquv kelajakka surilgan, bozor sokin. 1 dan yuqori — qoʻrquv «shu yerda va hozir»: sotuvlar va vahima.", formula: "VIX / VIX3M" },
  breadth: { label: "Kenglik", title: "Bozor kengligi", text: "Bozor qanchalik keng ishtirok etmoqda: aksiyalarning koʻpchiligi oʻsyaptimi yoki oʻsish bir nechta megakapga tayanyaptimi. Tor bozor kichik va oʻrta aksiyalar uchun yomonroq.", formula: "20 kunda RSP ga nisbatan SPY yoki oʻsuvchi / tushuvchi" },

  // Dilution / offerings
  dilutionScore: { label: "Suyultirish skori", title: "Suyultirish skori", text: "Joylashtirish narxga qanchalik kuchli bosim qilishi mumkinligining 0–100 bahosi: kapitalizatsiya va floatga nisbatan hajm, chegirma, varrantlar, pul pozitsiyasi va joylashtirishlar tarixi." },
  dilution: { label: "Suyultirish", title: "Suyultirish", text: "Yangi aksiyalar chiqarish: har bir aksiyadorning ulushi kamayadi, qoʻshimcha taklif esa odatda narxga bosim qiladi." },
  atm: { label: "ATM", title: "ATM dasturi (at-the-market)", text: "Kompaniya aksiyalarni kichik qismlarda toʻgʻridan-toʻgʻri bozorga joriy narxda sotadi. Chegirmasiz, lekin oʻsishda doimiy taklif bosimini yaratadi." },
  shelf: { label: "Shelf", title: "Shelf (S-3 / F-3)", text: "3 yil ichida aksiya chiqarish uchun oldindan roʻyxatdan oʻtkazilgan huquq. Oʻzi sotuv emas, lekin bosim: shelfdan bitim istalgan kuni chiqishi mumkin." },
  offerDiscount: { label: "Chegirma", title: "Joylashtirish chegirmasi", text: "Offer narxi bitimdan oldingi yopilishdan qancha past. Chuqur chegirma (−15% va undan past) koʻpincha narxni offerga tortadi.", formula: "offer / yopilish − 1" },
  warrants: { label: "Varrantlar", title: "Varrantlar", text: "Kelajakda aksiyalarni belgilangan narxda sotib olish huquqlari. Yashirin suyultirish qoʻshadi va koʻpincha narx shiftiga aylanadi." },
  runway: { label: "Pul zaxirasi", title: "Pul zaxirasi (runway)", text: "Joriy sarf bilan kompaniyaga kesh necha oyga yetadi. 6 oydan kam — yangi joylashtirish ehtimoli yuqori.", formula: "kesh / oylik sarf" },

  // Analyst actions
  pt: { label: "PT", title: "Maqsadli narx (price target)", text: "Tahlilchi aksiyani 12 oydan keyin kutayotgan narx. Maqsadning katta oʻzgarishi oʻzi katalizator boʻlishi mumkin.", formula: "Δ PT = yangi / eski − 1" },
  firmWeight: { label: "Vazn", title: "Firma vazni", text: "Shu firma reytingni oʻzgartirgandan keyin reaksiya kunidagi harakat aksiyaning odatiy kunidan oʻrtacha necha marta katta. ×1 — bozor eʼtibor bermaydi, ×2 va undan yuqori — firma aksiyalarni harakatlantiradi. 5 ta voqeadan boshlab koʻrsatiladi.", formula: "oʻrtacha |kun harakati| / oldingi 20 sessiyadagi |harakat| medianasi" },
  reaction: { label: "Reaksiya", title: "Tarixiy reaksiya", text: "2 yil ichida tahlilchilarning xuddi shunday harakatlariga reaksiya kunida aksiya oʻrtacha qanday harakatlangan: ochilishdagi gap va kun yakunining oldingi yopilishga nisbati.", formula: "kun = close / prevClose − 1" },
  reactionDay: { label: "Reaksiya kuni", title: "Reaksiya kuni", text: "Bozor eʼlonni hisobga olishi mumkin boʻlgan birinchi sessiya: 16:00 ET gacha — shu kun, yopilishdan keyin — keyingi savdo kuni." },
  ratingHit: { label: "Reyting tomon", title: "Reyting yoʻnalishida", text: "Kun harakat yoʻnalishida yopilgan holatlar ulushi: upgrade dan keyin oʻsish, downgrade dan keyin tushish.", formula: "sign(kun harakati) = yoʻnalish" },
  topFirm: { label: "Top firma", title: "Top firma", text: "Yirik bank yoki tadqiqot uyi (Goldman, Morgan Stanley, JPM, BofA va boshqalar) yoki 8+ voqeada ×1.8+ vaznli firma." },
  analystScore: { label: "Muhimlik", title: "Sessiya uchun muhimlik", text: "Reyting oʻzgarishi yangi qamrovdan muhimroq, qamrov esa maqsaddan. Koʻtaradi: jamoa pozitsiyasi, kuzatuv roʻyxatingiz va siz savdo qilgan tikerlar, top firma, yuqori vazn, PT ning katta siljishi, allaqachon koʻrinayotgan gap." },
} satisfies Messages<typeof ru>;
