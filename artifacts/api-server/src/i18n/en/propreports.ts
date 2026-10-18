import type { Messages } from "../core";
import type ru from "../ru/propreports";

export default {
  notify: {
    kind: {
      import: "Import",
      sync: "Sync",
    },
    title: "PropReports {kindLower}: {head}",
    inserted: { one: "+{count} new", other: "+{count} new" },
    noneNew: "nothing new",
    updated: "{count} updated",
    unchanged: "{count} unchanged",
    skipped: "{count} skipped",
    conflicts: "{count} to reconciliation",
    errors: "{count} errors",
    errorsWithText: "{count} errors ({text})",
    listSep: ", ",
    bodySep: " · ",
    done: "Trades synced",
    unmatchedTitle: { one: "{count} account without a trader", other: "{count} accounts without a trader" },
    unmatchedBody: "{accounts} — trades weren't imported; link the accounts in Integrations",
    unmatchedMore: "{accounts} and {more} more",
  },
  wizard: {
    env: {
      ok: "{domain} · {auth}",
      token: "API token",
      login: "login/password",
      missing: "Not set in .env.local: {vars}",
      or: "{token} (or {user} + {password})",
    },
    connection: {
      v2: "API v2 (token)",
      legacy: "legacy login",
      version: " · version {version}",
      error: "Error: {error}",
      unknown: "unknown",
      unchecked: "Not checked",
    },
    accounts: {
      none: "No accounts added yet",
      linked: "{linked}/{total} linked",
      noTrader: " · no trader: {n}",
      unmatched: " · unmatched: {n}",
    },
    fees: {
      columns: { one: "{count} column, {included} counted", other: "{count} columns, {included} counted" },
      confirmed: " · confirmed",
      unconfirmed: " · not confirmed",
      empty: "Columns appear after the first import/sync",
    },
    firstSync: {
      trades: { one: "{count} trade from the broker", other: "{count} trades from the broker" },
      none: "No imports yet",
    },
  },
  perfNote: "This is an aggregate report: it doesn't create journal trades. Trades need a Trades or Fills export.",
  fee: {
    comm: "Commission",
    clr: "Clearing",
    misc: "Other",
  },
  conn: {
    domainInvalid: "{name} contains invalid characters",
    noCredentials: "No PropReports token and no login/password",
    loginUnexpected: "PropReports login: unexpected response",
    tokenRejected: "Token rejected ({status}). If the firm is still on the legacy API, add {user} and {password}.",
    authRejected: "Authorization rejected ({status}): {error}",
  },
  parse: {
    fillsColumns: "Columns not found: {cols}. Expected a Fills CSV from PropReports (Date/Time, Account, B/S, Qty, Symbol, Price…)",
    badDate: "Unrecognized date/time: \"{value}\"",
    badSide: "Unknown B/S side: \"{value}\"",
    badQty: "Invalid quantity: \"{value}\"",
    badPrice: "Invalid price: \"{value}\"",
    emptySymbol: "Empty symbol",
  },
  perf: {
    noAverages: "“Per Trade Averages” block not found",
    noHeader: "Wins/Losses/Totals table header not found",
    rowSkipped: "Row {n} skipped: “{text}”",
    noTotal: "No totals row — sums were computed from tickers",
    empty: "The file has no statistics rows",
  },
} satisfies Messages<typeof ru>;
