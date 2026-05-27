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
function describeDbTarget(): { host: string; database: string } {
  const raw = process.env["DATABASE_URL"] ?? "";
  try {
    const u = new URL(raw);
    return {
      host: `${u.hostname}:${u.port || "5432"}`,
      database: u.pathname.replace(/^\//, "") || "(none)",
    };
  } catch {
    return { host: "(unparseable DATABASE_URL)", database: "(unknown)" };
  }
}

// process.stderr.write is fully synchronous on Node (file/tty) and survives
// process.exit() without buffering. Pino's default async stdio silently drops
// in-flight messages on abnormal exit, which made the original deploy hang
// undiagnosable. Use this for STARTUP-critical events only.
function logStartupSync(msg: string): void {
  try {
    process.stderr.write(`[startup] ${msg}\n`);
  } catch {
    // ignore — best-effort
  }
}

const CONNECT_TIMEOUT_MS = 10_000;

export async function ensureDbConstraints(): Promise<void> {
  const target = describeDbTarget();
  logStartupSync(
    `connecting to database host=${target.host} database=${target.database}`,
  );

  const connectPromise = pool.connect();
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new Error(
          `Timed out after ${CONNECT_TIMEOUT_MS}ms connecting to database host=${target.host} database=${target.database}. ` +
            `Most likely cause: DATABASE_URL points to a host that is not reachable from this environment (e.g. a dev-only hostname like 'helium' in a production deployment, a paused serverless DB, or a missing/wrong production secret in the Deploy → Secrets panel).`,
        ),
      );
    }, CONNECT_TIMEOUT_MS);
  });

  let client;
  try {
    client = await Promise.race([connectPromise, timeoutPromise]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
  } catch (err) {
    // If the timeout won, the connectPromise may still resolve later with a
    // client that nothing will release. Release it whenever it eventually
    // arrives so we don't leak a pooled connection on the way to exit.
    connectPromise.then((c) => c.release()).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    logStartupSync(`DB connect FAILED: ${msg}`);
    logger.error({ err, ...target }, "Failed to connect to database — aborting startup");
    // Force a hard exit. Relying on the .catch in index.ts to call
    // process.exit means we depend on pino flushing a goodbye log first; in
    // production pino is async and silently drops in-flight messages, which
    // is why the original deploy timed out at the platform's 60s SIGTERM
    // instead of exiting cleanly. A direct exit guarantees the deploy step
    // gets a real failure signal in <CONNECT_TIMEOUT_MS> seconds.
    setImmediate(() => process.exit(1));
    throw err;
  }

  try {
    await client.query(SETUP_SQL);
    logStartupSync("DB constraints installed");
    logger.info("DB constraints installed (invoice_line_items_invoice_id_match)");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logStartupSync(`DB constraint install FAILED: ${msg}`);
    logger.error({ err }, "Failed to install DB constraints — aborting startup");
    setImmediate(() => process.exit(1));
    throw err;
  } finally {
    client.release();
  }
}
