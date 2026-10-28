import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { pool } from "@workspace/db";
import type { PoolClient } from "pg";

/** This lock coordinates source mutation, not the separately locked backup job. */
export const MEDIA_CHECKPOINT_LOCK = [1279349848, 1296385097] as const;
export const MEDIA_WRITERS = [
  "case-media", "private-recovery", "lab-logo", "invoice-template", "case-print-template",
  "support-report", "legacy-case-data", "legacy-media", "case-upload", "case-import",
  "lab-inbox", "invoice-attachment", "profile-photo", "resumable-upload", "legacy-chat", "provider-messenger",
] as const;
export type MediaWriter = typeof MEDIA_WRITERS[number];
const recoveryReceipts = new AsyncLocalStorage<string[]>();
export async function collectMediaMutationReceipts<T>(work: () => Promise<T>) {
  const ids: string[] = [];
  const value = await recoveryReceipts.run(ids, work);
  return { value, ids };
}
export async function validateRecoveryMediaReceipts(ids: string[]): Promise<void> {
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate recovery media write receipts.");
  if (!ids.length) return;
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM labtrax_production_media_write_intents
     WHERE id = ANY($1::uuid[]) AND writer = 'private-recovery' AND state = 'complete'`, [ids]);
  if (Number(result.rows[0]?.count) !== ids.length) throw new Error("Recovery media write receipt verification failed.");
}

export const MEDIA_MUTATION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS labtrax_production_media_write_intents (
    id uuid PRIMARY KEY,
    object_key text NOT NULL,
    writer text NOT NULL,
    state text NOT NULL CHECK (state IN ('started', 'complete', 'failed', 'superseded')),
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    generation text,
    bytes bigint CHECK (bytes >= 0),
    operation text NOT NULL DEFAULT 'replace',
    journal_position bigint UNIQUE
  );
  ALTER TABLE labtrax_production_media_write_intents ADD COLUMN IF NOT EXISTS operation text NOT NULL DEFAULT 'replace';
  ALTER TABLE labtrax_production_media_write_intents ADD COLUMN IF NOT EXISTS journal_position bigint;
  CREATE UNIQUE INDEX IF NOT EXISTS labtrax_media_intent_journal_position
    ON labtrax_production_media_write_intents(journal_position) WHERE journal_position IS NOT NULL;
  CREATE INDEX IF NOT EXISTS labtrax_media_unresolved_intents
    ON labtrax_production_media_write_intents(object_key)
    WHERE state IN ('started', 'failed');
`;

export async function lockMediaCheckpoint(client: Pick<PoolClient, "query">): Promise<void> {
  await client.query("SELECT pg_advisory_lock($1::int, $2::int)", [...MEDIA_CHECKPOINT_LOCK]);
  try {
    // Do not let a body writer wait on a counter held by its calling record transaction.
    await client.query("BEGIN");
    const pending = await client.query<{ id: string; operation: string; object_key: string; writer: string }>(
      `SELECT id, operation, object_key, writer FROM labtrax_production_media_write_intents
       WHERE state = 'complete' AND journal_position IS NULL ORDER BY created_at, id FOR UPDATE`);
    for (const intent of pending.rows) {
      await client.query("SELECT labtrax_production_media_journal_append($1, $2, $3)",
        [intent.operation, intent.object_key, `writer:${intent.writer}`]);
      await client.query(`UPDATE labtrax_production_media_write_intents SET journal_position =
        (SELECT high_water FROM labtrax_production_media_journal_counter WHERE singleton) WHERE id = $1`, [intent.id]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await unlockMediaCheckpoint(client);
    throw error;
  }
}
export async function unlockMediaCheckpoint(client: Pick<PoolClient, "query">): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1::int, $2::int)", [...MEDIA_CHECKPOINT_LOCK]);
}

/** Durable intent precedes all I/O. Failed bodies never produce a success event. */
export async function mutateProductionMedia<T>(
  objectKey: string, writer: MediaWriter, operation: "add" | "replace" | "remove",
  perform: () => Promise<{ value: T; generation: string; bytes: number }>,
): Promise<T> {
  if (!MEDIA_WRITERS.includes(writer) || !objectKey || objectKey.startsWith("/") ||
      objectKey.includes("\\") || objectKey.includes("\0") ||
      objectKey.split("/").some(p => !p || p === "." || p === "..")) {
    throw new Error("Unregistered or unsafe production media writer.");
  }
  const client = await pool.connect();
  const id = randomUUID();
  let locked = false, objectLocked = false, inserted = false;
  try {
    await client.query("SELECT pg_advisory_lock_shared($1::int, $2::int)", [...MEDIA_CHECKPOINT_LOCK]);
    locked = true;
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 1296385097))", [objectKey]);
    objectLocked = true;
    // Auto-commit before touching bytes, surviving both process and DB rollback.
    await client.query(`INSERT INTO labtrax_production_media_write_intents
      (id, object_key, writer, operation, state) VALUES ($1, $2, $3, $4, 'started')`, [id, objectKey, writer, operation]);
    inserted = true;
    recoveryReceipts.getStore()?.push(id);
    const result = await perform();
    if (!result.generation || !Number.isSafeInteger(result.bytes) || result.bytes < 0) {
      throw new Error("Production media finalization evidence is invalid.");
    }
    await client.query("BEGIN");
    await client.query(`UPDATE labtrax_production_media_write_intents
      SET state = 'superseded', completed_at = now()
      WHERE object_key = $1 AND id <> $2 AND state IN ('started','failed')`, [objectKey, id]);
    await client.query(`UPDATE labtrax_production_media_write_intents
      SET state = 'complete', completed_at = now(), generation = $2, bytes = $3 WHERE id = $1`,
    [id, result.generation, result.bytes]);
    await client.query("COMMIT");
    return result.value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (inserted) await client.query(`UPDATE labtrax_production_media_write_intents
      SET state = 'failed' WHERE id = $1 AND state = 'started'`, [id]).catch(() => undefined);
    throw error;
  } finally {
    if (objectLocked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 1296385097))",
      [objectKey]).catch(() => undefined);
    if (locked) await client.query("SELECT pg_advisory_unlock_shared($1::int, $2::int)",
      [...MEDIA_CHECKPOINT_LOCK]).catch(() => undefined);
    client.release();
  }
}

export async function unresolvedMediaWrites(client: Pick<PoolClient, "query">): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM labtrax_production_media_write_intents
     WHERE state IN ('started','failed') AND object_key NOT LIKE 'private-objects/desktop-installer/%'`);
  return Number(result.rows[0]!.count);
}
