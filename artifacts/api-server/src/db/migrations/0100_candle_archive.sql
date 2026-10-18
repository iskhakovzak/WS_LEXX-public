-- Candle archive (lib/candleArchive): PERMANENT intraday bars, one row per (symbol, New York trading day, bar size).
-- Not a cache: never pruned, included in backups (hence no _cache suffix). Written once per symbol-day for the whole
-- desk by the candles.archive job / on first chart open of a finished day; read by every chart, replay, training and
-- the simulator. payload = lib/candleArchive/codec.ts (enc = codec version), ≈3 KB for a full 04:00–20:00 1-minute day.
CREATE TABLE IF NOT EXISTS candle_archive (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  symbol text NOT NULL CHECK (symbol ~ '^[A-Z][-A-Z0-9.]{0,10}$'),
  day date NOT NULL,
  tf text NOT NULL CHECK (tf IN ('1m', '5m', '15m', '30m', '60m')),
  enc smallint NOT NULL CHECK (enc > 0),
  extended boolean NOT NULL,                 -- true: 04:00–20:00 ET; false: regular session only
  bar_count integer NOT NULL CHECK (bar_count > 0),
  payload bytea NOT NULL,
  source text NOT NULL CHECK (source IN ('yahoo', 'cache')),
  fetched_at timestamptz NOT NULL,           -- when the provider served these bars
  rth_open numeric(16, 4),                   -- regular-session stats (simulator scenario picking, listings)
  rth_high numeric(16, 4),
  rth_low numeric(16, 4),
  rth_close numeric(16, 4),
  volume bigint NOT NULL DEFAULT 0,          -- whole day
  prev_close numeric(16, 4),                 -- previous session close when known (PDC without a provider call)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS candle_archive_key_uidx ON candle_archive (symbol, day, tf);
CREATE INDEX IF NOT EXISTS candle_archive_day_idx ON candle_archive (day);
-- The payload is already compressed and small (≤ ~6 KB): keep it inline in the heap row (one page read per day);
-- MAIN moves it to TOAST only if a row could not fit a page. pglz gives up early on incompressible input.
ALTER TABLE candle_archive ALTER COLUMN payload SET STORAGE MAIN;

-- Symbol-days the provider had nothing for (holiday, halted all day, not listed yet, too old). Lets the nightly job
-- skip them instead of asking again every night; retried after `retry_after`.
CREATE TABLE IF NOT EXISTS candle_archive_misses (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  symbol text NOT NULL,
  day date NOT NULL,
  reason text NOT NULL CHECK (reason IN ('empty', 'too_old')),
  attempts integer NOT NULL DEFAULT 1,
  retry_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS candle_archive_misses_key_uidx ON candle_archive_misses (symbol, day);
