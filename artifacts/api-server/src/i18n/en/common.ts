import type { Messages } from "../core";
import type ru from "../ru/common";

export default {
  errors: {
    authRequired: "Sign-in required",
    guestReadOnly: "Guest mode: view only",
    forbidden: "You don’t have permission to do this",
    notFound: "Not found",
    validation: "Invalid request",
    invalidJson: "Invalid JSON in the request body",
    internal: "Internal server error",
    rateLimited: "Too many requests, try again later",
    loginRateLimited: "Too many sign-in attempts, try again later",
    invalidCredentials: "Wrong name or password",
    banned: "Access blocked. Contact your curator",
    invalidLocale: "Unknown language: {value}",
  },
  roles: {
    trader: "Trader",
    curator: "Curator",
    admin: "Administrator",
    guest: "Guest",
  },
  units: {
    trades: { one: "{count} trade", other: "{count} trades" },
    days: { one: "{count} day", other: "{count} days" },
  },
} satisfies Messages<typeof ru>;
