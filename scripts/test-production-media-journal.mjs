import assert from "node:assert/strict";
import path from "node:path";

const scratch = process.env.LABTRAX_ISOLATED_RESTORE_ROOT;
const configuredUrl = process.env.DATABASE_URL;
if (!scratch || !configuredUrl ||
    !path.resolve(process.cwd()).startsWith(`${path.resolve(scratch)}${path.sep}`)) {
  throw new Error("Media-journal integration checks require the owned isolated restore workspace.");
}
const host = new URL(configuredUrl).hostname.replace(/^\[|\]$/g, "");
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  throw new Error("Media-journal integration checks refuse a non-local database.");
}

const { pool } = await import("@workspace/db");
const {
  assertProductionMediaJournalCoverage,
  ensureProductionMediaJournalSchema,
  recordProductionMediaReplacement,
  readProductionMediaJournalRange,
} = await import("../artifacts/api-server/src/lib/production-media-journal.ts");

const client = await pool.connect();
const tableName = "labtrax_media_journal_synthetic_refs";
const table = `"public"."${tableName}"`;
async function highWater() {
  const result = await client.query(
    "SELECT high_water::text FROM labtrax_production_media_journal_counter WHERE singleton = true",
  );
  return result.rows[0].high_water;
}

try {
  await client.query(`DROP TABLE IF EXISTS ${table}`);
  await client.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, storage_key text, data_json jsonb)`);
  await ensureProductionMediaJournalSchema();
  await assertProductionMediaJournalCoverage(client);
  const invoiceReference = await client.query(
    "SELECT DISTINCT labtrax_production_media_journal_collect_refs($1::jsonb, 'invoice_attachments') AS ref",
    [JSON.stringify({ storage_key: "/uploads/invoice-attachments/synthetic.pdf" })],
  );
  assert.deepEqual(invoiceReference.rows.map(row => row.ref), ["invoice-attachments/synthetic.pdf"]);
  const baseline = await highWater();

  await client.query(
    `INSERT INTO ${table} (id, storage_key, data_json) VALUES ($1, $2, $3::jsonb)`,
    [1, "case-media/synthetic-journal-a.bin", JSON.stringify({ photo: "/uploads/case-media/synthetic-journal-a.bin" })],
  );
  const added = await readProductionMediaJournalRange(client, baseline);
  assert.equal(added.events.length, 1);
  assert.equal(added.events[0]?.operation, "add");
  assert.equal(added.events[0]?.objectKey, "case-media/synthetic-journal-a.bin");

  const afterInsert = added.throughPosition;
  await client.query(`UPDATE ${table} SET data_json = $1::jsonb WHERE id = 1`, [
    JSON.stringify({ note: "unrelated synthetic edit", photo: "/uploads/case-media/synthetic-journal-a.bin" }),
  ]);
  const unchanged = await readProductionMediaJournalRange(client, afterInsert);
  assert.equal(unchanged.events.length, 0);
  assert.equal(unchanged.throughPosition, afterInsert);

  await recordProductionMediaReplacement(client, "case-media/synthetic-journal-a.bin", tableName);
  const sameKeyReplacement = await readProductionMediaJournalRange(client, afterInsert);
  assert.deepEqual(sameKeyReplacement.events.map(event => [event.operation, event.objectKey]), [
    ["replace", "case-media/synthetic-journal-a.bin"],
  ]);

  await client.query(`UPDATE ${table} SET storage_key = $1, data_json = $2::jsonb WHERE id = 1`, [
    "case-media/synthetic-journal-b.bin",
    JSON.stringify({ photo: "/uploads/case-media/synthetic-journal-b.bin" }),
  ]);
  const replaced = await readProductionMediaJournalRange(client, sameKeyReplacement.throughPosition);
  assert.deepEqual(replaced.events.map(event => [event.operation, event.objectKey]), [
    ["remove", "case-media/synthetic-journal-a.bin"],
    ["add", "case-media/synthetic-journal-b.bin"],
  ]);

  const beforeRollback = replaced.throughPosition;
  await client.query("BEGIN");
  await client.query(`INSERT INTO ${table} (id, storage_key) VALUES (2, $1)`, [
    "case-media/synthetic-rolled-back.bin",
  ]);
  await client.query("ROLLBACK");
  const rolledBack = await readProductionMediaJournalRange(client, beforeRollback);
  assert.equal(rolledBack.events.length, 0);

  await client.query(`DELETE FROM ${table} WHERE id = 1`);
  const removed = await readProductionMediaJournalRange(client, beforeRollback);
  assert.deepEqual(removed.events.map(event => [event.operation, event.objectKey]), [
    ["remove", "case-media/synthetic-journal-b.bin"],
  ]);
  await assert.rejects(
    client.query("DELETE FROM labtrax_production_media_journal"),
    /append-only/,
  );
  await assert.rejects(
    client.query("TRUNCATE labtrax_production_media_journal"),
    /append-only/,
  );
  await assertProductionMediaJournalCoverage(client);
  console.log("Production media journal isolated checks passed: add, explicit same-key replace, remove, no-op, rollback, gap-free order, append-only.");
} finally {
  await client.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
  client.release();
  await pool.end();
}
