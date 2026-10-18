-- Simulator: 2-minute timeframe next to 1m / 5m (owner 2026-10-18: «на 1, 2 и 5 минутах»). 2m bars are aggregated from
-- archived 1-minute bars (lib/sim/scenario.ts tfSec / aggregate); the game row keeps the bar size it was built with.
ALTER TABLE sim_games DROP CONSTRAINT IF EXISTS sim_games_tf_check;
ALTER TABLE sim_games ADD CONSTRAINT sim_games_tf_check CHECK (tf IN ('1m', '2m', '5m', '1d'));
