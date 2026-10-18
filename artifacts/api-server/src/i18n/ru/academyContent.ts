/**
 * Server `academyContent`: course editor validation, submission notifications and new-item defaults
 * (lib/academyContent, routes/academy-content.ts). Course / lesson / quiz content is user content.
 */
export default {
  validation: {
    questionsList: "Вопросы должны быть списком",
    questionsMax: "Не больше 100 вопросов в тесте",
    questionEmpty: "Вопрос {n}: пустой",
    questionNoText: "Вопрос {n}: нет текста",
    optionsMin: "Вопрос {n}: нужно минимум 2 варианта ответа",
    optionsMax: "Вопрос {n}: не больше 12 вариантов",
    singleCorrect: "Вопрос {n}: отметьте ровно один верный вариант",
    multipleCorrect: "Вопрос {n}: отметьте хотя бы один верный вариант",
    numericAnswer: "Вопрос {n}: укажите числовой ответ",
    unknownKind: "Вопрос {n}: неизвестный тип «{kind}»",
    questionsNone: "Добавьте хотя бы один вопрос",
    rubricList: "Рубрика должна быть списком критериев",
    criterionNoLabel: "Критерий {n}: нет названия",
    criterionPoints: "Критерий {n}: баллы 1–100",
    rubricMax: "Не больше 20 критериев",
    rubricNone: "Добавьте хотя бы один критерий",
  },
  /** Default rubric of a new assignment (stored as data, editable). */
  defaultRubric: "Качество выполнения",
  notify: {
    submittedTitle: "Задание на проверку: {title}",
    submittedBody: "{user}: задание «{title}» сдано на проверку.",
    submittedBodyTrades: "{user}: задание «{title}» сдано на проверку (сделок: {n}).",
    returnedTitle: "Задание возвращено на доработку: {title}",
    passedTitle: "Задание зачтено: {title}",
    failedTitle: "Задание проверено (не зачтено): {title}",
    returnedBody: "{mentor}: {comment}",
    gradedBody: "Оценка {total} из {max} ({pct}%).",
    gradedBodyComment: "Оценка {total} из {max} ({pct}%). {mentor}: {comment}",
  },
} as const;
