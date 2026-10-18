/**
 * Synthetic-only rehearsal, not a customer-data repair or executable migration.
 * Uses the disposable restore runner; one transaction rolls back all fixtures,
 * temporary FK changes, and the rehearsal's original-ID parent restoration.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  inspectCaseOrganizationConstraints,
  inspectCaseOrganizationRows,
} from "@workspace/db/case-organization-integrity";
import { requireIsolatedRestoreTest } from "../lib/restore-test-isolation";

describe("preservation-first case relationship repair (isolated synthetic only)", () => {
  let pool: typeof import("@workspace/db").pool;
  beforeAll(async () => {
    requireIsolatedRestoreTest();
    pool = (await import("@workspace/db")).pool;
  });
  afterAll(async () => { if (pool) await pool.end(); });

  it("restores exact original organization IDs without rewriting cases, then enforces both FKs", async () => {
    const client = await pool.connect();
    const prefix = `synthetic-link-repair-${randomUUID()}`;
    const id = (suffix: string) => `${prefix}-${suffix}`;
    const query = (sql: string) => client.query(sql);
    const before = await inspectCaseOrganizationRows(query);
    try {
      await client.query("BEGIN");
      // Current schema may already carry the intended FKs. Remove only these
      // fixture-database constraints, transactionally, to model historical drift.
      const { rows: constraints } = await client.query<{ name: string }>(`
        SELECT DISTINCT c.conname AS name
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
        WHERE c.contype='f' AND c.conrelid='public.cases'::regclass
          AND a.attname IN ('lab_organization_id','provider_organization_id')
      `);
      for (const { name } of constraints) {
        await client.query(`ALTER TABLE public.cases DROP CONSTRAINT "${name.replaceAll('"', '""')}"`);
      }
      // New-row guards from other work may be installed in the cloned schema.
      // Suspend ONLY that case guard while planting historical synthetic damage,
      // not during the repair. Rollback restores the original trigger state.
      const { rows: guards } = await client.query<{ name: string }>(`
        SELECT t.tgname AS name FROM pg_trigger t
        JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE t.tgrelid='public.cases'::regclass AND NOT t.tgisinternal
          AND p.proname=$1 AND t.tgenabled<>'D'
      `, ["assert_owning_organization_exists"]);
      for (const { name } of guards) {
        await client.query(`ALTER TABLE public.cases DISABLE TRIGGER "${name.replaceAll('"', '""')}"`);
      }
      await client.query(
        "INSERT INTO public.users (id, username, password) VALUES ($1::text, $1::text, $2)",
        [id("user"), "synthetic-not-a-login"],
      );
      for (const [suffix, type, deleted] of [
        ["existing-lab", "lab", false], ["existing-practice", "provider", false],
        ["historical-practice", "provider", true],
      ] as const) {
        await client.query(
          "INSERT INTO public.organizations (id,name,type,deleted_at) VALUES ($1::text,$1::text,$2,$3)",
          [id(suffix), type, deleted ? new Date() : null],
        );
      }
      for (const [suffix, lab, practice, deleted] of [
        ["missing-lab-case", "original-lab", "existing-practice", false],
        ["missing-practice-case", "existing-lab", "original-practice", false],
        ["deleted-case", "historical-lab", "historical-original-practice", true],
        ["valid-case", "existing-lab", "historical-practice", false],
      ] as const) {
        await client.query(`
          INSERT INTO public.cases
            (id,case_number,lab_organization_id,provider_organization_id,
             patient_first_name,patient_last_name,doctor_name,created_by_user_id,deleted_at)
          VALUES ($1::text,$1::text,$2,$3,'Synthetic','Fixture','Synthetic Doctor',$4,$5)
        `, [id(suffix), id(lab), id(practice), id("user"), deleted ? new Date() : null]);
      }
      for (const { name } of guards) {
        await client.query(`ALTER TABLE public.cases ENABLE TRIGGER "${name.replaceAll('"', '""')}"`);
      }
      const broken = await inspectCaseOrganizationRows(query);
      expect(broken).toMatchObject({
        affectedTotal: before.affectedTotal + 3,
        affectedActive: before.affectedActive + 2,
        missingLab: before.missingLab + 2,
        missingPractice: before.missingPractice + 2,
      });
      const casesBefore = (await client.query(
        "SELECT to_jsonb(c) AS data FROM public.cases c WHERE id LIKE $1 ORDER BY id", [`${prefix}%`],
      )).rows;
      const organizationsBefore = (await client.query(
        "SELECT to_jsonb(o) AS data FROM public.organizations o ORDER BY id",
      )).rows;

      // A wrong/reassigned parent cannot resolve the original ID. It is not a
      // valid repair, even if its human-readable name matches.
      await client.query(
        "INSERT INTO public.organizations (id,name,type) VALUES ($1,$2,'lab')",
        [id("wrong-lab"), id("original-lab")],
      );
      expect((await inspectCaseOrganizationRows(query)).affectedTotal).toBe(broken.affectedTotal);
      await client.query("SAVEPOINT before_early_constraint");
      await expect(client.query(`
        ALTER TABLE public.cases ADD CONSTRAINT synthetic_early_lab_fk
        FOREIGN KEY (lab_organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT
      `)).rejects.toMatchObject({ code: "23503" });
      await client.query("ROLLBACK TO SAVEPOINT before_early_constraint");

      // Rehearse insert-only restoration from an explicitly verified original
      // identity. These values are invented FIXTURES, never customer evidence.
      for (const [suffix, type] of [
        ["original-lab", "lab"], ["original-practice", "provider"],
        ["historical-lab", "lab"], ["historical-original-practice", "provider"],
      ]) {
        await client.query(
          "INSERT INTO public.organizations (id,name,type) VALUES ($1::text,$1::text,$2)",
          [id(suffix), type],
        );
      }
      expect(await inspectCaseOrganizationRows(query)).toMatchObject({
        affectedTotal: before.affectedTotal,
        affectedActive: before.affectedActive,
      });
      expect((await client.query(
        "SELECT to_jsonb(c) AS data FROM public.cases c WHERE id LIKE $1 ORDER BY id", [`${prefix}%`],
      )).rows).toEqual(casesBefore);
      const organizationsAfter = (await client.query(
        "SELECT to_jsonb(o) AS data FROM public.organizations o ORDER BY id",
      )).rows;
      for (const original of organizationsBefore) expect(organizationsAfter).toContainEqual(original);

      // A duplicate original ID must fail, never overwrite existing identity.
      await client.query("SAVEPOINT before_conflict");
      await expect(client.query(
        "INSERT INTO public.organizations (id,name,type) VALUES ($1,'Conflicting identity','lab')",
        [id("original-lab")],
      )).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT before_conflict");

      for (const [column, constraint] of [
        ["lab_organization_id", "synthetic_repaired_lab_fk"],
        ["provider_organization_id", "synthetic_repaired_practice_fk"],
      ]) {
        await client.query(`ALTER TABLE public.cases ADD CONSTRAINT ${constraint}
          FOREIGN KEY (${column}) REFERENCES public.organizations(id) ON DELETE RESTRICT NOT VALID`);
      }
      expect((await inspectCaseOrganizationConstraints(query)).map((c) => c.status))
        .toEqual(["not_validated", "not_validated"]);
      await client.query("ALTER TABLE public.cases VALIDATE CONSTRAINT synthetic_repaired_lab_fk");
      await client.query("ALTER TABLE public.cases VALIDATE CONSTRAINT synthetic_repaired_practice_fk");
      expect((await inspectCaseOrganizationConstraints(query)).map((c) => c.status))
        .toEqual(["validated", "validated"]);
      for (const column of ["lab_organization_id", "provider_organization_id"]) {
        await client.query("SAVEPOINT before_invalid_write");
        await expect(client.query(
          `UPDATE public.cases SET ${column}=$1 WHERE id=$2`,
          [id("nonexistent-parent"), id("valid-case")],
        )).rejects.toMatchObject({ code: "23503" });
        await client.query("ROLLBACK TO SAVEPOINT before_invalid_write");
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await inspectCaseOrganizationRows((sql) => pool.query(sql))).toEqual(before);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM public.cases WHERE id LIKE $1", [`${prefix}%`],
    )).rows[0].count).toBe(0);
  });
});
