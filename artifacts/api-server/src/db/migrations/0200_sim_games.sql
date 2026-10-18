-- Simulator (/simulator, lib/sim): one row per game. The full bar series stays server-side in `bars`
-- ([t, o, h, l, c, v] with real times); the player only ever receives bars up to `cursor_idx`. `events` is the
-- order / bracket log the state is recomputed from; `result` + the score columns are written when the game ends.
CREATE TABLE IF NOT EXISTS sim_games (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('intraday', 'swing')),
  difficulty text NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  ticker text NOT NULL,
  day text NOT NULL,                       -- NY trading day played (intraday) / first played bar (swing)
  day_to text,                             -- swing: last bar
  tf text NOT NULL CHECK (tf IN ('1m', '5m', '1d')),
  bars jsonb NOT NULL,
  start_idx integer NOT NULL,
  end_idx integer NOT NULL,
  cursor_idx integer NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished', 'abandoned')),
  result jsonb,
  net_pnl numeric(14, 2),
  r_total numeric(10, 2),
  pct numeric(10, 2),
  bh_pct numeric(10, 2),
  beat_bh boolean,
  trades_count integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS sim_games_user_idx ON sim_games (user_id, id DESC);
CREATE INDEX IF NOT EXISTS sim_games_finished_idx ON sim_games (finished_at) WHERE status = 'finished';
CREATE UNIQUE INDEX IF NOT EXISTS sim_games_one_active_idx ON sim_games (user_id) WHERE status = 'active';

-- Leaderboard opt-in (the weekly desk board shows only players who chose to be visible, plus the viewer).
CREATE TABLE IF NOT EXISTS sim_prefs (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  leaderboard_visible boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
