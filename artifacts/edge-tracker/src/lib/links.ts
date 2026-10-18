// Deep links between sections of the desk workflow (game plan → watchlist → trade → setup → journal →
// review → rating → risk). Build every cross-section href here; each target page reads these params.

type Params = Record<string, string | number | null | undefined | false>;

function href(path: string, params: Params = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === false || v === "") continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export const links = {
  trade: (id: number) => href("/trades", { highlight: id }),
  trades: (p: { ticker?: string; date?: string; from?: string; to?: string; playbookId?: number; setup?: string; horizon?: string; source?: string; ids?: number[]; side?: string; outcome?: string; trader?: string } = {}) =>
    href("/trades", { ...p, ids: p.ids?.length ? p.ids.join(",") : undefined }),
  journalDay: (date: string, trader?: string) => href("/journal", { date, trader }),
  dayReport: (date: string, trader?: string) => href("/day-report", { date, trader }),
  /** «Same ticker, same day»: every desk trader's entries / exits on one chart (pages/desk-day). */
  deskDay: (ticker: string, date: string) => href("/desk-day", { ticker, date }),
  /** Simulator «Мои худшие дни»: replay one of the viewer's own losing trades (own trades only, server-checked). */
  simOwn: (tradeId: number) => href("/simulator", { own: tradeId }),
  behavior: (p: { trader?: string; from?: string; to?: string } = {}) => href("/behavior", p),
  gamePlan: (date?: string) => href("/game-plan", { date }),
  /** The trader's own plan (daily stop, max trades, rule of the day). */
  myPlan: (date?: string) => href("/game-plan", { view: "my", date }),
  setup: (id: number) => href("/playbook", { id }),
  playbookSearch: (q: string) => href("/playbook", { q }),
  idea: (id: number) => href("/trade-ideas", { idea: id }),
  newIdea: (ticker?: string) => href("/trade-ideas", { new: 1, ticker }),
  thread: (id: number) => href("/discussions", { thread: id }),
  newThread: (p: { tradeId?: number; ticker?: string } = {}) => href("/discussions", { new: 1, ...p }),
  events: (ticker?: string) => href("/events", { ticker }),
  watchlist: (ticker?: string) => href("/watchlist", { ticker }),
  risk: (trader?: string) => href("/risk", { trader }),
  weeklyReview: (p: { trader?: string; week?: string } = {}) => href("/weekly-review", p),
  scaling: (trader?: string) => href("/scaling", { trader }),
  offerings: (ticker?: string) => href("/offerings", { ticker }),
} as const;
