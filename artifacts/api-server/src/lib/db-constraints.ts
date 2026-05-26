/**
 * Idempotent DB constraint setup — runs once at server startup.
 *
 * Installs application-level DB constraints that cannot be expressed as simple
 * Drizzle schema declarations (e.g. cross-row CHECK constraints require
 * triggers in PostgreSQL).
 *
 * Every statement uses CREATE OR REPLACE so it is safe to run on every boot
 * and in any environment where DATABASE_URL is set.
 *
 * Current constraints
 * ───────────────────
 * invoice_line_items_invoice_id_match
 *   A sub-item (parent_line_item_id IS NOT NULL) must carry the same
 *   invoice_id as its parent row.  Without this guard, a mis-coded insert
 *   could silently attach a child to a parent from a different invoice,
 *   producing phantom line items that survive invoice deletes and corrupt
 *   totals recalculations.
 */

import { pool } from "@workspace/db";
import { logger } from "./logger";

const SETUP_SQL = `
CREATE OR REPLACE FUNCTION invoice_line_items_invoice_id_match()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  parent_invoice_id varchar;
BEGIN
  IF NEW.parent_line_item_id IS NOT NULL THEN
    SELECT invoice_id
      INTO parent_invoice_id
      FROM invoice_line_items
     WHERE id = NEW.parent_line_item_id;

    IF parent_invoice_id IS DISTINCT FROM NEW.invoice_id THEN
      RAISE EXCEPTION
        'invoice_line_items: sub-item invoice_id (%) must match parent invoice_id (%) — parent_line_item_id: %',
        NEW.invoice_id, parent_invoice_id, NEW.parent_line_item_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoice_line_items_invoice_id_match_trigger
  ON invoice_line_items;

CREATE TRIGGER invoice_line_items_invoice_id_match_trigger
  BEFORE INSERT OR UPDATE ON invoice_line_items
  FOR EACH ROW EXECUTE FUNCTION invoice_line_items_invoice_id_match();
`;

/**
 * Installs (or re-installs) all application-level DB constraints.
 * Must be awaited before the HTTP server starts accepting traffic.
 * Failures are logged and re-thrown so the process exits rather than
 * running without the safety net.
 */
export async function ensureDbConstraints(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(SETUP_SQL);
    logger.info("DB constraints installed (invoice_line_items_invoice_id_match)");
  } catch (err) {
    logger.error({ err }, "Failed to install DB constraints — aborting startup");
    throw err;
  } finally {
    client.release();
  }
}
