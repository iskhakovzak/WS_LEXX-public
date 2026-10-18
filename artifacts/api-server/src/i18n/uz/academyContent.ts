import type { Messages } from "../core";
import type ru from "../ru/academyContent";

export default {
  validation: {
    questionsList: "Savollar roʻyxat boʻlishi kerak",
    questionsMax: "Testda 100 tadan ortiq savol boʻlmasligi kerak",
    questionEmpty: "{n}-savol: boʻsh",
    questionNoText: "{n}-savol: matn yoʻq",
    optionsMin: "{n}-savol: kamida 2 ta javob varianti kerak",
    optionsMax: "{n}-savol: 12 tadan ortiq variant boʻlmasligi kerak",
    singleCorrect: "{n}-savol: aynan bitta toʻgʻri variantni belgilang",
    multipleCorrect: "{n}-savol: kamida bitta toʻgʻri variantni belgilang",
    numericAnswer: "{n}-savol: sonli javobni kiriting",
    unknownKind: "{n}-savol: nomaʼlum tur «{kind}»",
    questionsNone: "Kamida bitta savol qoʻshing",
    rubricList: "Baholash mezonlari roʻyxat boʻlishi kerak",
    criterionNoLabel: "{n}-mezon: nomi yoʻq",
    criterionPoints: "{n}-mezon: ball 1–100",
    rubricMax: "20 tadan ortiq mezon boʻlmasligi kerak",
    rubricNone: "Kamida bitta mezon qoʻshing",
  },
  defaultRubric: "Bajarilish sifati",
  notify: {
    submittedTitle: "Tekshirishga topshiriq: {title}",
    submittedBody: "{user}: «{title}» topshirigʻi tekshirishga topshirildi.",
    submittedBodyTrades: "{user}: «{title}» topshirigʻi tekshirishga topshirildi (savdolar: {n}).",
    returnedTitle: "Topshiriq qayta ishlashga qaytarildi: {title}",
    passedTitle: "Topshiriq qabul qilindi: {title}",
    failedTitle: "Topshiriq tekshirildi (oʻtmadi): {title}",
    returnedBody: "{mentor}: {comment}",
    gradedBody: "Baho: {max} dan {total} ({pct}%).",
    gradedBodyComment: "Baho: {max} dan {total} ({pct}%). {mentor}: {comment}",
  },
} satisfies Messages<typeof ru>;
