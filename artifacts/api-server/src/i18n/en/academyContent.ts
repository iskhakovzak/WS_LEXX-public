import type { Messages } from "../core";
import type ru from "../ru/academyContent";

export default {
  validation: {
    questionsList: "Questions must be a list",
    questionsMax: "No more than 100 questions in a quiz",
    questionEmpty: "Question {n}: empty",
    questionNoText: "Question {n}: no text",
    optionsMin: "Question {n}: at least 2 answer options are needed",
    optionsMax: "Question {n}: no more than 12 options",
    singleCorrect: "Question {n}: mark exactly one correct option",
    multipleCorrect: "Question {n}: mark at least one correct option",
    numericAnswer: "Question {n}: enter the numeric answer",
    unknownKind: "Question {n}: unknown type “{kind}”",
    questionsNone: "Add at least one question",
    rubricList: "The rubric must be a list of criteria",
    criterionNoLabel: "Criterion {n}: no name",
    criterionPoints: "Criterion {n}: points 1–100",
    rubricMax: "No more than 20 criteria",
    rubricNone: "Add at least one criterion",
  },
  defaultRubric: "Quality of work",
  notify: {
    submittedTitle: "Assignment to review: {title}",
    submittedBody: "{user}: assignment “{title}” submitted for review.",
    submittedBodyTrades: "{user}: assignment “{title}” submitted for review (trades: {n}).",
    returnedTitle: "Assignment returned for revision: {title}",
    passedTitle: "Assignment passed: {title}",
    failedTitle: "Assignment graded (not passed): {title}",
    returnedBody: "{mentor}: {comment}",
    gradedBody: "Score {total} of {max} ({pct}%).",
    gradedBodyComment: "Score {total} of {max} ({pct}%). {mentor}: {comment}",
  },
} satisfies Messages<typeof ru>;
