import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../../../../lib/db/drizzle/0008_retire_lab_authorization_signing.sql", import.meta.url),
);

describe("retired lab authorization migration", () => {
  it("locks writes and archives evidence before dropping signing tables", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const backfill = sql.indexOf('INSERT INTO "practice_authorization_documents"');
    const parityCheck = sql.indexOf("Legacy authorization document migration count mismatch");
    const dropAudit = sql.indexOf('DROP TABLE "lab_authorization_audit_events"');
    const dropCompleted = sql.indexOf('DROP TABLE "lab_authorizations"');
    const dropDrafts = sql.indexOf('DROP TABLE "lab_authorization_drafts"');

    expect(sql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(sql).toContain("IN ACCESS EXCLUSIVE MODE");
    expect(backfill).toBeGreaterThan(-1);
    expect(sql).toContain('legacy_authorization."document_object_key"');
    expect(sql).toContain('legacy_authorization."document_hash"');
    expect(sql).toContain("'signatureObjectKey'");
    expect(sql).toContain("'auditEvents'");
    expect(sql).toContain('event."draft_id" = legacy_authorization."draft_id"');
    expect(sql).toContain("CREATE TRIGGER practice_authorization_documents_immutable");
    expect(parityCheck).toBeGreaterThan(backfill);
    expect(dropAudit).toBeGreaterThan(parityCheck);
    expect(dropCompleted).toBeGreaterThan(dropAudit);
    expect(dropDrafts).toBeGreaterThan(dropCompleted);
  });

  const integration = process.env.DATABASE_URL ? it : it.skip;
  integration("executes without losing completed PDF evidence", async () => {
    const migrationSql = await readFile(migrationPath, "utf8");
    const schema = `authorization_retirement_${randomUUID().replaceAll("-", "")}`;
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE practice_authorization_documents (
          id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
          lab_organization_id varchar NOT NULL,
          practice_organization_id varchar NOT NULL,
          authorization_type text NOT NULL,
          original_filename text NOT NULL,
          byte_size integer NOT NULL,
          checksum text NOT NULL,
          uploader_user_id varchar NOT NULL,
          object_key text NOT NULL,
          created_at timestamptz DEFAULT now() NOT NULL,
          CONSTRAINT practice_auth_docs_size_check CHECK (byte_size > 0)
        );
        CREATE TABLE lab_authorization_drafts (
          id varchar PRIMARY KEY, lab_organization_id varchar NOT NULL,
          practice_organization_id varchar NOT NULL, template_version text NOT NULL,
          template_type text NOT NULL, field_values jsonb NOT NULL, signature_data text,
          signature_method text, signer_legal_name text, consent boolean NOT NULL,
          created_by_user_id varchar NOT NULL, updated_by_user_id varchar NOT NULL,
          created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
        );
        CREATE TABLE lab_authorizations (
          id varchar PRIMARY KEY, draft_id varchar NOT NULL, lab_organization_id varchar NOT NULL,
          practice_organization_id varchar NOT NULL, template_version text NOT NULL,
          template_type text NOT NULL, template_hash text NOT NULL, field_values jsonb NOT NULL,
          signature_object_key text NOT NULL, signature_method text NOT NULL,
          signature_hash text NOT NULL, signer_legal_name text NOT NULL,
          signer_user_id varchar NOT NULL, signer_ip text NOT NULL, signer_user_agent text NOT NULL,
          consent boolean NOT NULL, signed_at timestamptz NOT NULL,
          document_object_key text NOT NULL, document_hash text NOT NULL,
          created_at timestamptz NOT NULL
        );
        CREATE TABLE lab_authorization_audit_events (
          id varchar PRIMARY KEY, authorization_id varchar, draft_id varchar,
          lab_organization_id varchar NOT NULL, action text NOT NULL,
          actor_user_id varchar NOT NULL, metadata_json jsonb NOT NULL,
          created_at timestamptz NOT NULL
        );
      `);

      const signedAt = "2026-01-02T03:04:05.000Z";
      const documentHash = "a".repeat(64);
      await client.query(
        `INSERT INTO lab_authorization_drafts VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$10,$11,$11)`,
        [
          "draft-1", "lab-1", "practice-1", "card-on-file-v1", "card_on_file",
          { legalName: "Ada Lovelace" }, "Ada Lovelace", "typed", "Ada Lovelace",
          "user-1", signedAt,
        ],
      );
      await client.query(
        `INSERT INTO lab_authorizations VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true,$16,$17,$18,$16)`,
        [
          "authorization-1", "draft-1", "lab-1", "practice-1", "card-on-file-v1",
          "card_on_file", "b".repeat(64), { legalName: "Ada Lovelace" },
          "lab-authorizations/lab-1/authorization-1/signature", "typed", "c".repeat(64),
          "Ada Lovelace", "user-1", "127.0.0.1", "migration-test", signedAt,
          "lab-authorizations/lab-1/authorization-1/authorization.pdf", documentHash,
        ],
      );
      await client.query(
        `INSERT INTO lab_authorization_audit_events VALUES
          ($1,$2,$3,$4,'completed',$5,$6,$7)`,
        ["audit-1", "authorization-1", "draft-1", "lab-1", "user-1", { documentHash }, signedAt],
      );

      await client.query(migrationSql);

      const migrated = await client.query(
        `SELECT * FROM practice_authorization_documents WHERE legacy_authorization_id = $1`,
        ["authorization-1"],
      );
      expect(migrated.rows).toHaveLength(1);
      expect(migrated.rows[0]).toMatchObject({
        lab_organization_id: "lab-1",
        practice_organization_id: "practice-1",
        authorization_type: "card_on_file",
        byte_size: null,
        checksum: documentHash,
        object_key: "lab-authorizations/lab-1/authorization-1/authorization.pdf",
      });
      expect(migrated.rows[0].legacy_evidence).toMatchObject({
        draftId: "draft-1",
        signerLegalName: "Ada Lovelace",
        signatureObjectKey: "lab-authorizations/lab-1/authorization-1/signature",
      });
      expect(migrated.rows[0].legacy_evidence.auditEvents).toHaveLength(1);
      await expect(client.query(
        `UPDATE practice_authorization_documents SET original_filename = 'tampered.pdf'
         WHERE legacy_authorization_id = $1`,
        ["authorization-1"],
      )).rejects.toThrow(/immutable/);
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await expect(client.query(
        `DELETE FROM practice_authorization_documents WHERE legacy_authorization_id = $1`,
        ["authorization-1"],
      )).rejects.toThrow(/immutable/);
      await client.query("ROLLBACK");

      const removed = await client.query(
        `SELECT to_regclass('lab_authorizations') AS completed,
                to_regclass('lab_authorization_drafts') AS drafts,
                to_regclass('lab_authorization_audit_events') AS audit`,
      );
      expect(removed.rows[0]).toEqual({ completed: null, drafts: null, audit: null });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });
});