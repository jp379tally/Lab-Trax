import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

// Development-only additive migration. Production uses the reviewed publish
// schema preflight; this script must never select a production connection.
if (process.env.SCHEMA_COLUMN_CHECK_TARGET === "production") {
  throw new Error("Use the reviewed production schema migration process.");
}
try {
  await db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_onboarding_json jsonb`);
    await tx.execute(sql`ALTER TABLE provider_payment_customers ADD COLUMN IF NOT EXISTS authorized_payment_method_id text`);
  });
  console.log("Provider signup columns installed (additive only).");
} finally { await pool.end(); }
