/**
 * The owning-organization guard, against a real database.
 *
 * `cases.lab_organization_id`, `invoices.lab_organization_id`,
 * `doctor_profiles.lab_organization_id` and `lab_memberships.lab_id` declare a
 * foreign key in Drizzle that no live database ever carried, so the database
 * silently accepted rows owned by labs that do not exist. A row trigger now
 * enforces the same rule a NOT VALID foreign key would — see
 * lib/db/src/schema/owning-organizations.ts for why it is not an actual
 * foreign key.
 *
 * What these tests hold in place:
 *  - a new case / invoice / provider profile / membership owned by a
 *    nonexistent organization is rejected with foreign_key_violation (23503)
 *  - the same write against a real organization still succeeds
 *  - rows that were ALREADY orphaned stay editable, including an update that
 *    rewrites the same orphaned id, so they can be repaired later
 *  - moving a row from one nonexistent owner to another is still rejected,
 *    and moving it to a real organization is allowed
 *  - the legacy `lab_cases` / `legacy_case_media` path is untouched: it has
 *    orphans of its own and is deliberately left unenforced
 *  - a restore (session_replication_role = 'replica') is not blocked
 *
 * Skipped when DATABASE_URL is not configured. Every row is removed in
 * afterAll so the suite is safe against the shared dev DB.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

/** The SQLSTATE a real foreign key would raise. */
const FOREIGN_KEY_VIOLATION = "23503";

maybe("owning-organization guard", () => {
  let dbMod: typeof import("@workspace/db");
  let pool: import("pg").Pool;

  const labOrgId = rid("org");
  const practiceOrgId = rid("org");
  const userId = rid("u");
  const phantomOrgId = rid("phantom");
  const otherPhantomOrgId = rid("phantom");

  const caseIds: string[] = [];
  const invoiceIds: string[] = [];
  const doctorProfileIds: string[] = [];
  const membershipIds: string[] = [];
  const labCaseIds: string[] = [];
  const legacyMediaFileNames: string[] = [];

  /** Run SQL with the row triggers off, the way pg_restore replays a dump. */
  async function withTriggersOff(
    run: (query: (sql: string, values?: unknown[]) => Promise<unknown>) => Promise<void>,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await run((sql, values) => client.query(sql, values as never));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function insertCase(
    id: string,
    orgId: string,
  ): Promise<void> {
    caseIds.push(id);
    await pool.query(
      `INSERT INTO cases (id, case_number, lab_organization_id, provider_organization_id,
                          patient_first_name, patient_last_name, doctor_name, created_by_user_id)
       VALUES ($1, $2, $3, $4, 'Guard', 'Fixture', 'Dr. Guard', $5)`,
      [id, rid("CN"), orgId, practiceOrgId, userId],
    );
  }

  /** Assert the write failed the way a real foreign key would. */
  async function expectGuardRejection(write: Promise<unknown>): Promise<void> {
    let caught: unknown;
    try {
      await write;
    } catch (error) {
      caught = error;
    }
    expect(caught, "expected the guard to reject this write").toBeDefined();
    const code = (caught as { code?: string } | null)?.code;
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(code, `expected 23503, got ${code}: ${message}`).toBe(
      FOREIGN_KEY_VIOLATION,
    );
    expect(message).toContain("no such organization exists");
  }

  beforeAll(async () => {
    dbMod = await import("@workspace/db");
    pool = dbMod.pool as unknown as import("pg").Pool;

    // The guard normally arrives with ensureDbConstraints() at server boot.
    // Installing it here keeps the suite independent of whether the dev API
    // server happens to be running, and proves the DDL is re-runnable.
    await pool.query(dbMod.buildOwningOrganizationGuardSql());

    await pool.query(
      `INSERT INTO organizations (id, type, name) VALUES ($1, 'lab', $2), ($3, 'practice', $4)`,
      [labOrgId, "Guard Test Lab", practiceOrgId, "Guard Test Practice"],
    );
    await pool.query(
      `INSERT INTO users (id, username, password) VALUES ($1, $2, 'x')`,
      [userId, rid("guard-user")],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    // Orphaned fixtures must come out with the triggers off as well: deleting
    // is unaffected, but the invoice accounting trigger would fire on none of
    // this anyway and the replica role keeps the teardown uniform.
    await pool.query(
      `DELETE FROM invoice_accounting_events WHERE invoice_id = ANY($1::text[])`,
      [invoiceIds],
    );
    await pool.query(`DELETE FROM invoices WHERE id = ANY($1::text[])`, [invoiceIds]);
    await pool.query(`DELETE FROM cases WHERE id = ANY($1::text[])`, [caseIds]);
    await pool.query(`DELETE FROM doctor_profiles WHERE id = ANY($1::text[])`, [
      doctorProfileIds,
    ]);
    await pool.query(`DELETE FROM lab_memberships WHERE id = ANY($1::text[])`, [
      membershipIds,
    ]);
    await pool.query(
      `DELETE FROM legacy_case_media WHERE file_name = ANY($1::text[])`,
      [legacyMediaFileNames],
    );
    await pool.query(`DELETE FROM lab_cases WHERE id = ANY($1::text[])`, [labCaseIds]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM organizations WHERE id = ANY($1::text[])`, [
      [labOrgId, practiceOrgId],
    ]);
  });

  it("installs a guard trigger on every enforced ownership column", async () => {
    const { rows } = await pool.query<{ trigger_name: string; table_name: string }>(
      dbMod.OWNING_ORGANIZATION_TRIGGER_SQL,
    );
    const installed = new Set(
      rows.map((row) => `${row.table_name}.${row.trigger_name}`),
    );
    for (const entry of dbMod.ENFORCED_OWNING_ORGANIZATION_COLUMNS) {
      expect(installed).toContain(`${entry.table}.${entry.triggerName}`);
    }
    // The legacy path is deliberately left alone; see the registry for why.
    for (const entry of dbMod.REPORTED_OWNING_ORGANIZATION_COLUMNS) {
      const onLegacyTable = rows.filter((row) => row.table_name === entry.table);
      expect(
        onLegacyTable.map((row) => row.trigger_name),
      ).not.toContain(`${entry.table}_organization_exists`);
    }
  });

  it("accepts a case owned by an organization that exists", async () => {
    const id = rid("case");
    await insertCase(id, labOrgId);
    const { rows } = await pool.query(`SELECT id FROM cases WHERE id = $1`, [id]);
    expect(rows).toHaveLength(1);
  });

  it("refuses a case owned by an organization that does not exist", async () => {
    const id = rid("case");
    caseIds.push(id);
    await expectGuardRejection(
      pool.query(
        `INSERT INTO cases (id, case_number, lab_organization_id, provider_organization_id,
                            patient_first_name, patient_last_name, doctor_name, created_by_user_id)
         VALUES ($1, $2, $3, $4, 'Guard', 'Fixture', 'Dr. Guard', $5)`,
        [id, rid("CN"), phantomOrgId, practiceOrgId, userId],
      ),
    );
  });

  it("refuses an invoice owned by an organization that does not exist", async () => {
    const id = rid("inv");
    invoiceIds.push(id);
    await expectGuardRejection(
      pool.query(
        `INSERT INTO invoices (id, invoice_number, lab_organization_id, created_by_user_id)
         VALUES ($1, $2, $3, $4)`,
        [id, rid("INV"), phantomOrgId, userId],
      ),
    );
  });

  it("refuses a provider profile owned by an organization that does not exist", async () => {
    const id = rid("dp");
    doctorProfileIds.push(id);
    await expectGuardRejection(
      pool.query(
        `INSERT INTO doctor_profiles (id, lab_organization_id, doctor_name)
         VALUES ($1, $2, 'Dr. Phantom')`,
        [id, phantomOrgId],
      ),
    );
  });

  it("refuses a lab membership in an organization that does not exist", async () => {
    const id = rid("mem");
    membershipIds.push(id);
    await expectGuardRejection(
      pool.query(
        `INSERT INTO lab_memberships (id, lab_id, user_id, role)
         VALUES ($1, $2, $3, 'lab_tech')`,
        [id, phantomOrgId, userId],
      ),
    );
  });

  it("names the guarded column and the missing organization in the error", async () => {
    const id = rid("dp");
    doctorProfileIds.push(id);
    let caught: unknown;
    try {
      await pool.query(
        `INSERT INTO doctor_profiles (id, lab_organization_id, doctor_name)
         VALUES ($1, $2, 'Dr. Phantom')`,
        [id, phantomOrgId],
      );
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain(phantomOrgId);
    expect(message).toContain("doctor_profiles.lab_organization_id");
    expect(message).toContain("provider profile");
  });

  describe("rows that are already orphaned", () => {
    const orphanCaseId = rid("case");

    beforeAll(async () => {
      caseIds.push(orphanCaseId);
      // Exactly how the orphans in the database got there: written while
      // nothing was checking. The replica role is also the restore path.
      await withTriggersOff(async (query) => {
        await query(
          `INSERT INTO cases (id, case_number, lab_organization_id, provider_organization_id,
                              patient_first_name, patient_last_name, doctor_name, created_by_user_id)
           VALUES ($1, $2, $3, $4, 'Guard', 'Orphan', 'Dr. Guard', $5)`,
          [orphanCaseId, rid("CN"), phantomOrgId, practiceOrgId, userId],
        );
      });
    });

    it("plants the orphan, proving a restore is not blocked by the guard", async () => {
      const { rows } = await pool.query<{ lab_organization_id: string }>(
        `SELECT lab_organization_id FROM cases WHERE id = $1`,
        [orphanCaseId],
      );
      expect(rows[0]?.lab_organization_id).toBe(phantomOrgId);
    });

    it("still allows edits that leave the owner alone", async () => {
      await pool.query(`UPDATE cases SET patient_last_name = $2 WHERE id = $1`, [
        orphanCaseId,
        "Edited",
      ]);
      const { rows } = await pool.query<{ patient_last_name: string }>(
        `SELECT patient_last_name FROM cases WHERE id = $1`,
        [orphanCaseId],
      );
      expect(rows[0]?.patient_last_name).toBe("Edited");
    });

    it("still allows an update that rewrites the same orphaned owner", async () => {
      await pool.query(
        `UPDATE cases SET lab_organization_id = $2, patient_first_name = 'Rewritten' WHERE id = $1`,
        [orphanCaseId, phantomOrgId],
      );
      const { rows } = await pool.query<{ patient_first_name: string }>(
        `SELECT patient_first_name FROM cases WHERE id = $1`,
        [orphanCaseId],
      );
      expect(rows[0]?.patient_first_name).toBe("Rewritten");
    });

    it("refuses to move it to a different organization that does not exist", async () => {
      await expectGuardRejection(
        pool.query(`UPDATE cases SET lab_organization_id = $2 WHERE id = $1`, [
          orphanCaseId,
          otherPhantomOrgId,
        ]),
      );
    });

    it("lets it be repaired onto a real organization", async () => {
      await pool.query(`UPDATE cases SET lab_organization_id = $2 WHERE id = $1`, [
        orphanCaseId,
        labOrgId,
      ]);
      const { rows } = await pool.query<{ lab_organization_id: string }>(
        `SELECT lab_organization_id FROM cases WHERE id = $1`,
        [orphanCaseId],
      );
      expect(rows[0]?.lab_organization_id).toBe(labOrgId);
    });
  });

  describe("deleting the organization itself", () => {
    it("installs the parent-side trigger on organizations", async () => {
      const { rows } = await pool.query<{ trigger_name: string; table_name: string }>(
        dbMod.OWNING_ORGANIZATION_TRIGGER_SQL,
      );
      expect(
        rows
          .filter((row) => row.table_name === "organizations")
          .map((row) => row.trigger_name),
      ).toContain(dbMod.OWNING_ORGANIZATION_PARENT_GUARD_TRIGGER);
    });

    it("deletes an organization that owns nothing", async () => {
      const emptyOrgId = rid("org");
      await pool.query(
        `INSERT INTO organizations (id, type, name) VALUES ($1, 'lab', 'Guard Empty Lab')`,
        [emptyOrgId],
      );
      await pool.query(`DELETE FROM organizations WHERE id = $1`, [emptyOrgId]);
      const { rows } = await pool.query(
        `SELECT id FROM organizations WHERE id = $1`,
        [emptyOrgId],
      );
      expect(rows).toHaveLength(0);
    });

    it("refuses to delete an organization that still owns a case", async () => {
      // Deleting the lab is the other way to manufacture an orphan: the case
      // rows stay behind pointing at an id that no longer resolves.
      const doomedOrgId = rid("org");
      const caseId = rid("case");
      await pool.query(
        `INSERT INTO organizations (id, type, name) VALUES ($1, 'lab', 'Guard Doomed Lab')`,
        [doomedOrgId],
      );
      await insertCase(caseId, doomedOrgId);

      let caught: unknown;
      try {
        await pool.query(`DELETE FROM organizations WHERE id = $1`, [doomedOrgId]);
      } catch (error) {
        caught = error;
      }
      const code = (caught as { code?: string } | null)?.code;
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(code, `expected 23503, got ${code}: ${message}`).toBe(
        FOREIGN_KEY_VIOLATION,
      );
      expect(message).toContain("cases.lab_organization_id");
      expect(message).toContain(doomedOrgId);
      expect(message).toContain("1 case row(s)");

      // The organization and its case both survived the refusal.
      const { rows } = await pool.query(
        `SELECT id FROM organizations WHERE id = $1`,
        [doomedOrgId],
      );
      expect(rows).toHaveLength(1);

      // Clearing the case out first is all it takes.
      await pool.query(`DELETE FROM cases WHERE id = $1`, [caseId]);
      await pool.query(`DELETE FROM organizations WHERE id = $1`, [doomedOrgId]);
    });

    it("takes the lab's memberships and provider profiles with it", async () => {
      // These two columns declare ON DELETE CASCADE, so the parent trigger
      // carries that out rather than refusing. They are records *of* the lab,
      // and a provider profile is created as a side effect of other writes,
      // so nothing tracks them well enough to clear them by hand.
      const doomedOrgId = rid("org");
      const membershipId = rid("mem");
      const profileId = rid("dp");
      membershipIds.push(membershipId);
      doctorProfileIds.push(profileId);
      await pool.query(
        `INSERT INTO organizations (id, type, name) VALUES ($1, 'lab', 'Guard Staffed Lab')`,
        [doomedOrgId],
      );
      await pool.query(
        `INSERT INTO lab_memberships (id, lab_id, user_id, role) VALUES ($1, $2, $3, 'lab_tech')`,
        [membershipId, doomedOrgId, userId],
      );
      await pool.query(
        `INSERT INTO doctor_profiles (id, lab_organization_id, doctor_name) VALUES ($1, $2, 'Dr. Cascade')`,
        [profileId, doomedOrgId],
      );

      await pool.query(`DELETE FROM organizations WHERE id = $1`, [doomedOrgId]);

      const membership = await pool.query(
        `SELECT id FROM lab_memberships WHERE id = $1`,
        [membershipId],
      );
      const profile = await pool.query(
        `SELECT id FROM doctor_profiles WHERE id = $1`,
        [profileId],
      );
      // Gone with the lab, not left behind pointing at an id that no longer
      // resolves — which is the orphan this whole guard exists to prevent.
      expect(membership.rows).toHaveLength(0);
      expect(profile.rows).toHaveLength(0);
    });

    it("still refuses when a restricted column is what is left behind", async () => {
      // An invoice declares ON DELETE RESTRICT, so it blocks the delete even
      // though the memberships beside it would have cascaded.
      const doomedOrgId = rid("org");
      const invoiceId = rid("inv");
      const membershipId = rid("mem");
      invoiceIds.push(invoiceId);
      membershipIds.push(membershipId);
      await pool.query(
        `INSERT INTO organizations (id, type, name) VALUES ($1, 'lab', 'Guard Billed Lab')`,
        [doomedOrgId],
      );
      await pool.query(
        `INSERT INTO invoices (id, invoice_number, lab_organization_id, created_by_user_id)
         VALUES ($1, $2, $3, $4)`,
        [invoiceId, rid("INV"), doomedOrgId, userId],
      );
      await pool.query(
        `INSERT INTO lab_memberships (id, lab_id, user_id, role) VALUES ($1, $2, $3, 'lab_tech')`,
        [membershipId, doomedOrgId, userId],
      );

      let caught: unknown;
      try {
        await pool.query(`DELETE FROM organizations WHERE id = $1`, [doomedOrgId]);
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string } | null)?.code).toBe(
        FOREIGN_KEY_VIOLATION,
      );
      expect(caught instanceof Error ? caught.message : "").toContain(
        "invoices.lab_organization_id",
      );

      // The refusal rolled the whole statement back: the membership that would
      // have cascaded is still there.
      const membership = await pool.query(
        `SELECT id FROM lab_memberships WHERE id = $1`,
        [membershipId],
      );
      expect(membership.rows).toHaveLength(1);

      await pool.query(
        `DELETE FROM invoice_accounting_events WHERE invoice_id = $1`,
        [invoiceId],
      );
      await pool.query(`DELETE FROM invoices WHERE id = $1`, [invoiceId]);
      await pool.query(`DELETE FROM organizations WHERE id = $1`, [doomedOrgId]);
    });

    it("holds off a concurrent delete until the writing transaction commits", async () => {
      // Without the FOR KEY SHARE lock the two statements interleave into an
      // orphan: the delete's trigger cannot see the uncommitted case, so the
      // organization goes, and then the case commits pointing at nothing.
      const racedOrgId = rid("org");
      const caseId = rid("case");
      caseIds.push(caseId);
      await pool.query(
        `INSERT INTO organizations (id, type, name) VALUES ($1, 'lab', 'Guard Raced Lab')`,
        [racedOrgId],
      );

      const writer = await pool.connect();
      const deleter = await pool.connect();
      try {
        await writer.query("BEGIN");
        await writer.query(
          `INSERT INTO cases (id, case_number, lab_organization_id, provider_organization_id,
                              patient_first_name, patient_last_name, doctor_name, created_by_user_id)
           VALUES ($1, $2, $3, $4, 'Guard', 'Raced', 'Dr. Guard', $5)`,
          [caseId, rid("CN"), racedOrgId, practiceOrgId, userId],
        );

        await deleter.query("BEGIN");
        let settled = false;
        const deletion = deleter
          .query(`DELETE FROM organizations WHERE id = $1`, [racedOrgId])
          .then(
            () => {
              settled = true;
              return "deleted" as const;
            },
            (error: unknown) => {
              settled = true;
              return error;
            },
          );

        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(
          settled,
          "the delete should be waiting on the writer's row lock",
        ).toBe(false);

        await writer.query("COMMIT");
        const outcome = await deletion;
        expect(
          outcome,
          "the delete should fail once the case it would orphan is visible",
        ).not.toBe("deleted");
        expect((outcome as { code?: string }).code).toBe(FOREIGN_KEY_VIOLATION);
      } finally {
        await deleter.query("ROLLBACK").catch(() => {});
        deleter.release();
        await writer.query("ROLLBACK").catch(() => {});
        writer.release();
      }

      await pool.query(`DELETE FROM cases WHERE id = $1`, [caseId]);
      await pool.query(`DELETE FROM organizations WHERE id = $1`, [racedOrgId]);
    });
  });

  describe("legacy mobile case path", () => {
    it("still saves a legacy case owned by an organization that does not exist", async () => {
      const id = rid("lc");
      labCaseIds.push(id);
      // The legacy path upserts, so an INSERT trigger would make the legacy
      // cases that are ALREADY orphaned unsaveable rather than stopping new
      // bad data. Both the insert and the conflicting re-save must work.
      await pool.query(
        `INSERT INTO lab_cases (id, owner_id, organization_id, case_data)
         VALUES ($1, $2, $3, '{}')
         ON CONFLICT (id) DO UPDATE SET case_data = EXCLUDED.case_data`,
        [id, userId, phantomOrgId],
      );
      await pool.query(
        `INSERT INTO lab_cases (id, owner_id, organization_id, case_data)
         VALUES ($1, $2, $3, '{"n":1}')
         ON CONFLICT (id) DO UPDATE SET case_data = EXCLUDED.case_data`,
        [id, userId, phantomOrgId],
      );
      const { rows } = await pool.query<{ organization_id: string }>(
        `SELECT organization_id FROM lab_cases WHERE id = $1`,
        [id],
      );
      expect(rows[0]?.organization_id).toBe(phantomOrgId);
    });

    it("still binds legacy media to an organization that does not exist", async () => {
      const labCaseId = rid("lc");
      const fileName = `${rid("media")}.jpg`;
      labCaseIds.push(labCaseId);
      legacyMediaFileNames.push(fileName);
      await pool.query(
        `INSERT INTO lab_cases (id, owner_id, organization_id, case_data) VALUES ($1, $2, $3, '{}')`,
        [labCaseId, userId, phantomOrgId],
      );
      await pool.query(
        `INSERT INTO legacy_case_media (file_name, lab_case_id, organization_id, owner_id)
         VALUES ($1, $2, $3, $4)`,
        [fileName, labCaseId, phantomOrgId, userId],
      );
      const { rows } = await pool.query<{ organization_id: string }>(
        `SELECT organization_id FROM legacy_case_media WHERE file_name = $1`,
        [fileName],
      );
      expect(rows[0]?.organization_id).toBe(phantomOrgId);
    });
  });
});
