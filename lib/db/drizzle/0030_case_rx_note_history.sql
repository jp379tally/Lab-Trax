CREATE TABLE IF NOT EXISTS case_rx_note_entries (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id varchar NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  note_text text NOT NULL,
  scanned_at timestamptz,
  provenance text NOT NULL,
  submission_id text,
  payload_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_rx_note_entries_provenance_check
    CHECK (provenance IN ('legacy', 'ai_reader', 'itero_import', 'case_intake'))
);

CREATE INDEX IF NOT EXISTS case_rx_note_entries_case_order_idx
  ON case_rx_note_entries (case_id, scanned_at, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS case_rx_note_entries_submission_unique
  ON case_rx_note_entries (case_id, submission_id)
  WHERE submission_id IS NOT NULL;

-- Preserve the current compatibility value as an undated original. No
-- received, due, created, or migration timestamp is a reliable scan date.
INSERT INTO case_rx_note_entries (case_id, note_text, scanned_at, provenance)
SELECT id, rx_notes, NULL, 'legacy'
FROM cases
WHERE NULLIF(trim(rx_notes), '') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM case_rx_note_entries e WHERE e.case_id = cases.id
  );

ALTER TABLE case_attachments ADD COLUMN IF NOT EXISTS submission_id text;
CREATE UNIQUE INDEX IF NOT EXISTS case_attachments_submission_unique
  ON case_attachments (case_id, submission_id)
  WHERE case_id IS NOT NULL AND submission_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS case_attachments_legacy_submission_unique
  ON case_attachments (lab_case_id, submission_id)
  WHERE lab_case_id IS NOT NULL AND submission_id IS NOT NULL;

-- Recover an Rx scan date only when the retained prescription entry and its
-- uploaded scan pages share the same per-scan submission identity on the same
-- case. The mobile reader names each page from that identity. Require all
-- matching pages to have been uploaded on one UTC date, before the note entry
-- was recorded, and to still be present. Using the earliest page upload keeps
-- the retained source timestamp; ambiguous or incomplete evidence stays NULL.
--
-- Historical attachments without submission_id cannot prove which Rx note
-- they belong to. In particular, do not infer from case received/due dates,
-- authored notes, remake relationships, or an attachment's proximity.
WITH proven_scan_dates AS (
  SELECT
    e.id AS entry_id,
    MIN(a.created_at) AS scanned_at
  FROM case_rx_note_entries e
  JOIN case_attachments a
    ON a.case_id = e.case_id
   AND a.submission_id LIKE e.submission_id || ':page:%'
   AND a.file_name = 'rx-rescan-' || a.submission_id || '.jpg'
   AND a.file_type = 'image/jpeg'
   AND a.category IS NULL
   AND a.deleted_at IS NULL
   AND a.created_at <= e.created_at
  WHERE e.scanned_at IS NULL
    AND e.provenance = 'ai_reader'
    AND e.submission_id ~ '^rx-[a-z0-9]+-[a-z0-9]+$'
  GROUP BY e.id
  HAVING COUNT(*) > 0
     AND COUNT(DISTINCT (a.created_at AT TIME ZONE 'UTC')::date) = 1
)
UPDATE case_rx_note_entries e
SET scanned_at = proven_scan_dates.scanned_at
FROM proven_scan_dates
WHERE e.id = proven_scan_dates.entry_id
  AND e.scanned_at IS NULL;
