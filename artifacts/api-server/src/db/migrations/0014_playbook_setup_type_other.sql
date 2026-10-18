-- Codes, not labels, in data (ARCHITECTURE.md §3.5): the Russian sentinel setup_type 'Другой' becomes the code 'other'.
-- The UI shows it through i18n (edge-tracker dataCodes namespace, setupType.other). Historic playbook_revisions
-- snapshots are left as they were written.
DO $$
DECLARE n integer;
BEGIN
  UPDATE playbook SET setup_type = 'other' WHERE setup_type = 'Другой';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'playbook.setup_type Другой -> other: % rows', n;
END $$;
