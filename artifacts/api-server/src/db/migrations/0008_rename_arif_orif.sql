-- Former boot one-off (lib/migrate.ts, ran on every start): UPDATE users SET name = 'Ориф' WHERE name = 'Ариф'.
-- Runs once now. No-op when already applied (no 'Ариф' row) or when 'Ориф' already exists (users.name is unique).
DO $$
DECLARE n integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE name = 'Ориф') THEN
    UPDATE users SET name = 'Ориф' WHERE name = 'Ариф';
    GET DIAGNOSTICS n = ROW_COUNT;
  END IF;
  RAISE NOTICE 'users Ариф -> Ориф: % rows', n;
END $$;
