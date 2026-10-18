import type { Messages } from "../core";
import type ru from "../ru/admin";

export default {
  reports: {
    authorBanned: "Author banned: {reason}",
  },
  health: {
    syncRun: "Sync #{id} ({source}): {status}",
    syncErrors: ", errors {count}",
    sourceFile: "file",
    scheduler: "Scheduler: {error}",
  },
  quality: {
    no_trader: {
      label: "Trades without a trader",
      hint: "The trade won't reach anyone's journal or stats. Link the account to a trader in Integrations → Accounts.",
    },
    unknown_trader: {
      label: "Trader not found among users",
      hint: "The name on the trade matches no account (a rename or a typo in the account link).",
    },
    unmapped_account: {
      label: "Trades from unlinked accounts",
      hint: "The broker account appears in trades but isn't linked to a trader.",
    },
    duplicates: {
      label: "Possible duplicates",
      hint: "Same trader, ticker, date, side, entry, exit and P&L. Sort them out in Integrations → Reconciliation.",
    },
    ny_date_mismatch: {
      label: "Trade date ≠ open date (NY)",
      hint: "The trading date must match the New York open date. Usually a manual edit or an old import.",
    },
    weekend: {
      label: "Weekend trades",
      hint: "The US market is closed on Saturday and Sunday — the date was probably not recorded in NY time.",
    },
    future: {
      label: "Trades dated in the future",
      hint: "Today in NY: {today}.",
    },
    exit_before_entry: {
      label: "Exit date before entry date",
      hint: "Check exit_date on multi-day trades.",
    },
    pending_reconcile: {
      label: "Awaiting reconciliation",
      hint: "Broker trades that matched manual ones — decide in Integrations → Reconciliation.",
    },
    legacy_no_id: {
      label: "Old import without a broker ID",
      hint: "They get an ID on the next import of the same period.",
    },
  },
} satisfies Messages<typeof ru>;
