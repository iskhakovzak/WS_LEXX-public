import type { Messages } from "../core";
import type ru from "../ru/security";

export default {
  login: {
    invalid: "Wrong name or PIN",
    locked: "Too many failed attempts. Sign-in is temporarily locked",
    rateLimited: "Too many sign-in attempts, try again later",
    banned: "Access blocked. Contact your curator",
  },
  password: {
    changeRequired: "Set a new password first",
    tooShort: "At least {min} characters",
    tooLong: "No more than {max} characters",
    sameAsOld: "The new password must differ from the current one",
    sameAsName: "The password must not match your name",
    currentWrong: "The current password is wrong",
    required: "Enter the current and the new password",
    tooManyAttempts: "Too many attempts, try again later",
  },
  body: {
    tooManyRequests: "Too many requests, try again later",
    tooLarge: "Request too large (over {limit})",
  },
  alert: {
    title: "WS_LEXX: new server error",
    titleClient: "WS_LEXX: new app error",
    route: "Route: {route}",
    count: "Occurrences: {count}",
    open: "Open: {url}",
  },
} satisfies Messages<typeof ru>;
