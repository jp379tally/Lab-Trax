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
 *
 * assert_owning_organization_exists
 *   A case, invoice, provider profile or lab membership may not be written
 *   against an organization that does not exist.  These ownership columns
 *   never acquired the foreign key their Drizzle definitions declare, so the
 *   database silently accepted rows owned by labs that were never there.
 *   See lib/db/src/schema/owning-organizations.ts for why this is enforced by
 *   a trigger rather than a (NOT VALID) foreign key.
 */

import { buildOwningOrganizationGuardSql, pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * Baseline snapshots for invoices that predate the accounting trigger.
 *
 * This explicit maintenance statement is not run during startup. On the first
 * accounting-relevant edit after trigger installation, the trigger creates a
 * baseline from OLD before appending the edit event.
 */
export const INVOICE_ACCOUNTING_BASELINE_SQL = `
INSERT INTO invoice_accounting_events (
  lab_organization_id,
  invoice_id,
  event_type,
  occurred_at,
  effective_status,
  effective_total,
  effective_balance_due,
  effective_issued_at,
  effective_due_at,
  effective_voided_at,
  effective_deleted_at,
  effective_created_at
)
SELECT
  i.lab_organization_id,
  i.id,
  'baseline',
  COALESCE(i.issued_at, i.created_at, now()),
  i.status,
  i.total,
  -- The balance today is not evidence of the balance on the issue date this
  -- baseline is dated to: everything paid since happened after it. Dated
  -- reports replay the surviving payment records instead, so the historical
  -- balance is left unknown rather than backdated.
  NULL,
  i.issued_at,
  i.due_at,
  i.voided_at,
  i.deleted_at,
  i.created_at
FROM invoices i
WHERE NOT EXISTS (
  SELECT 1 FROM invoice_accounting_events e WHERE e.invoice_id = i.id
)
`;

/**
 * Historical repair for databases seeded by an earlier version of the
 * baseline statement. Kept as an explicit maintenance statement and never
 * executed by startup constraint installation.
 */
export const INVOICE_ACCOUNTING_BASELINE_REPAIR_SQL = `
UPDATE invoice_accounting_events
   SET effective_balance_due = NULL
 WHERE event_type = 'baseline'
   AND effective_balance_due IS NOT NULL
`;

const SETUP_SQL = `
-- Keep this trigger definition current for databases migrated before the
-- authorization hash and billing-address columns were introduced.
DO $setup$
BEGIN
  IF to_regclass('provider_autopay_authorizations') IS NOT NULL THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION prevent_provider_autopay_authorization_update()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF NEW.status = 'superseded' AND OLD.status = 'active'
           AND NEW.superseded_at IS NOT NULL
           AND NEW.id IS NOT DISTINCT FROM OLD.id
           AND NEW.provider_organization_id IS NOT DISTINCT FROM OLD.provider_organization_id
           AND NEW.agreement_version IS NOT DISTINCT FROM OLD.agreement_version
           AND NEW.agreement_text IS NOT DISTINCT FROM OLD.agreement_text
           AND NEW.agreement_sha256 IS NOT DISTINCT FROM OLD.agreement_sha256
           AND NEW.subscription_fees IS NOT DISTINCT FROM OLD.subscription_fees
           AND NEW.lab_bills IS NOT DISTINCT FROM OLD.lab_bills
           AND NEW.lab_charge_day IS NOT DISTINCT FROM OLD.lab_charge_day
           AND NEW.signer_user_id IS NOT DISTINCT FROM OLD.signer_user_id
           AND NEW.typed_legal_name IS NOT DISTINCT FROM OLD.typed_legal_name
           AND NEW.consent IS NOT DISTINCT FROM OLD.consent
           AND NEW.signer_ip IS NOT DISTINCT FROM OLD.signer_ip
           AND NEW.signer_user_agent IS NOT DISTINCT FROM OLD.signer_user_agent
           AND NEW.signed_at IS NOT DISTINCT FROM OLD.signed_at
           AND NEW.signature_object_key IS NOT DISTINCT FROM OLD.signature_object_key
           AND NEW.signature_checksum IS NOT DISTINCT FROM OLD.signature_checksum
           AND NEW.document_object_key IS NOT DISTINCT FROM OLD.document_object_key
           AND NEW.document_checksum IS NOT DISTINCT FROM OLD.document_checksum
           AND NEW.card_brand IS NOT DISTINCT FROM OLD.card_brand
           AND NEW.card_last4 IS NOT DISTINCT FROM OLD.card_last4
           AND NEW.card_exp_month IS NOT DISTINCT FROM OLD.card_exp_month
           AND NEW.card_exp_year IS NOT DISTINCT FROM OLD.card_exp_year
           AND NEW.card_status IS NOT DISTINCT FROM OLD.card_status
           AND NEW.card_billing_address_json IS NOT DISTINCT FROM OLD.card_billing_address_json
           AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN RETURN NEW;
        END IF;
        RAISE EXCEPTION 'provider auto-pay authorizations are immutable';
      END $body$;
    $fn$;
    EXECUTE 'DROP TRIGGER IF EXISTS provider_autopay_authorizations_immutable ON provider_autopay_authorizations';
    EXECUTE 'CREATE TRIGGER provider_autopay_authorizations_immutable BEFORE UPDATE ON provider_autopay_authorizations FOR EACH ROW EXECUTE FUNCTION prevent_provider_autopay_authorization_update()';
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION deny_provider_autopay_authorization_delete()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'provider auto-pay authorizations cannot be deleted'; END $body$;
    $fn$;
    EXECUTE 'DROP TRIGGER IF EXISTS provider_autopay_authorizations_no_delete ON provider_autopay_authorizations';
    EXECUTE 'CREATE TRIGGER provider_autopay_authorizations_no_delete BEFORE DELETE ON provider_autopay_authorizations FOR EACH ROW EXECUTE FUNCTION deny_provider_autopay_authorization_delete()';
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION deny_provider_autopay_authorization_lab_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'provider auto-pay authorization lab relationships are immutable'; END $body$;
    $fn$;
    EXECUTE 'DROP TRIGGER IF EXISTS provider_autopay_authorization_labs_immutable ON provider_autopay_authorization_labs';
    EXECUTE 'CREATE TRIGGER provider_autopay_authorization_labs_immutable BEFORE UPDATE OR DELETE ON provider_autopay_authorization_labs FOR EACH ROW EXECUTE FUNCTION deny_provider_autopay_authorization_lab_mutation()';
  END IF;
END
$setup$;

DO $setup$
BEGIN
  IF to_regclass('lab_authorizations') IS NOT NULL THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION deny_completed_lab_authorization_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'completed lab authorizations are immutable'; END $body$;
    $fn$;
    EXECUTE 'DROP TRIGGER IF EXISTS lab_authorizations_immutable ON lab_authorizations';
    EXECUTE 'CREATE TRIGGER lab_authorizations_immutable BEFORE UPDATE OR DELETE ON lab_authorizations FOR EACH ROW EXECUTE FUNCTION deny_completed_lab_authorization_mutation()';
  END IF;
  IF to_regclass('lab_authorization_audit_events') IS NOT NULL THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION deny_lab_authorization_audit_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'authorization audit events are append-only'; END $body$;
    $fn$;
    EXECUTE 'DROP TRIGGER IF EXISTS lab_authorization_audit_append_only ON lab_authorization_audit_events';
    EXECUTE 'CREATE TRIGGER lab_authorization_audit_append_only BEFORE UPDATE OR DELETE ON lab_authorization_audit_events FOR EACH ROW EXECUTE FUNCTION deny_lab_authorization_audit_mutation()';
  END IF;
  IF to_regclass('practice_authorization_documents') IS NOT NULL THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION deny_practice_authorization_document_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'practice authorization documents are immutable'; END $body$;
    $fn$;
    EXECUTE 'DROP TRIGGER IF EXISTS practice_authorization_documents_immutable ON practice_authorization_documents';
    EXECUTE 'CREATE TRIGGER practice_authorization_documents_immutable BEFORE UPDATE OR DELETE ON practice_authorization_documents FOR EACH ROW EXECUTE FUNCTION deny_practice_authorization_document_mutation()';
  END IF;
END
$setup$;

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

-- Immutable accounting history for invoices.
--
-- Dated financial reports must be able to say what an invoice meant to the
-- books on a past date. Invoices are written from case sync, statements,
-- payment flows, bulk tools, and the invoice routes, so recording the
-- snapshot in each writer would leave gaps the reports cannot detect. The
-- trigger records it for every writer, including raw SQL.
DO $setup$
BEGIN
  IF to_regclass('invoice_accounting_events') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION record_invoice_accounting_event()
    RETURNS TRIGGER LANGUAGE plpgsql AS $body$
    BEGIN
      -- Only accounting-relevant facts are worth a snapshot; notes and
      -- layout are not. The balance due counts: a reversal deletes the
      -- payment rows, so the balance the invoice carried at the time is the
      -- only surviving evidence that it had been settled.
      IF TG_OP = 'UPDATE'
         AND NEW.total IS NOT DISTINCT FROM OLD.total
         AND NEW.balance_due IS NOT DISTINCT FROM OLD.balance_due
         AND NEW.status IS NOT DISTINCT FROM OLD.status
         AND NEW.issued_at IS NOT DISTINCT FROM OLD.issued_at
         AND NEW.due_at IS NOT DISTINCT FROM OLD.due_at
         AND NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at
         AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN
        RETURN NEW;
      END IF;

      -- Preserve the pre-edit invoice state without rewriting every historic
      -- invoice during application startup. The row lock held by this update
      -- serializes concurrent attempts to create the first baseline.
      IF TG_OP = 'UPDATE'
         AND NOT EXISTS (
           SELECT 1 FROM invoice_accounting_events e WHERE e.invoice_id = OLD.id
         ) THEN
        INSERT INTO invoice_accounting_events (
          lab_organization_id,
          invoice_id,
          event_type,
          occurred_at,
          effective_status,
          effective_total,
          effective_balance_due,
          effective_issued_at,
          effective_due_at,
          effective_voided_at,
          effective_deleted_at,
          effective_created_at
        ) VALUES (
          OLD.lab_organization_id,
          OLD.id,
          'baseline',
          COALESCE(OLD.issued_at, OLD.created_at, now()),
          OLD.status,
          OLD.total,
          NULL,
          OLD.issued_at,
          OLD.due_at,
          OLD.voided_at,
          OLD.deleted_at,
          OLD.created_at
        );
      END IF;

      INSERT INTO invoice_accounting_events (
        lab_organization_id,
        invoice_id,
        event_type,
        occurred_at,
        effective_status,
        effective_total,
        effective_balance_due,
        effective_issued_at,
        effective_due_at,
        effective_voided_at,
        effective_deleted_at,
        effective_created_at
      ) VALUES (
        NEW.lab_organization_id,
        NEW.id,
        CASE
          WHEN TG_OP = 'INSERT' THEN 'created'
          WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN 'deleted'
          WHEN NEW.status = 'void' AND OLD.status IS DISTINCT FROM 'void' THEN 'voided'
          WHEN NEW.issued_at IS NOT NULL AND OLD.issued_at IS NULL THEN 'issued'
          ELSE 'updated'
        END,
        now(),
        NEW.status,
        NEW.total,
        NEW.balance_due,
        NEW.issued_at,
        NEW.due_at,
        NEW.voided_at,
        NEW.deleted_at,
        NEW.created_at
      );
      RETURN NEW;
    END;
    $body$;
  $fn$;

  EXECUTE 'DROP TRIGGER IF EXISTS invoices_record_accounting_event ON invoices';
  EXECUTE 'CREATE TRIGGER invoices_record_accounting_event AFTER INSERT OR UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION record_invoice_accounting_event()';
END
$setup$;

${buildOwningOrganizationGuardSql()}
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

  let discardClient = false;
  try {
    // Serialize constraint DDL across API workers. The transaction releases the
    // advisory lock on both success and rollback; the wait remains bounded.
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SELECT pg_advisory_xact_lock(1280596035, 1)");
    await client.query(SETUP_SQL);
    await client.query("COMMIT");
    logStartupSync("DB constraints installed");
    logger.info(
      "DB constraints installed (invoice_line_items_invoice_id_match, assert_owning_organization_exists)",
    );
    logger.warn(
      "Historical invoice accounting baseline/reconciliation is deferred; startup did not rewrite existing invoice history. First accounting-relevant edits capture the pre-edit invoice state.",
    );
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Never return a broken connection with an open transaction to the pool.
      discardClient = true;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logStartupSync(`DB constraint install FAILED: ${msg}`);
    logger.error({ err }, "Failed to install DB constraints — aborting startup");
    setImmediate(() => process.exit(1));
    throw err;
  } finally {
    client.release(discardClient);
  }
}
