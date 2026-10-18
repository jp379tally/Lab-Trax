import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_OWNING_ORGANIZATION_COLUMNS,
  buildOwningOrganizationGuardSql,
  buildOwningOrganizationOrphanRowsSql,
  buildOwningOrganizationOrphanSummarySql,
  ENFORCED_OWNING_ORGANIZATION_COLUMNS,
  OWNING_ORGANIZATION_PARENT_GUARD_FUNCTION,
  OWNING_ORGANIZATION_PARENT_GUARD_TRIGGER,
  REPORTED_OWNING_ORGANIZATION_COLUMNS,
} from "@workspace/db/schema";
import {
  buildOrphanCsv,
  countOrphans,
  parseOrphanRow,
  parseOrphanSummaryRow,
  selectExistingColumns,
  summarizeOrphanReport,
} from "./owning-organization-orphan-report";
import { REQUIRED_MIGRATION_SCHEMA_OBJECTS } from "./schema-object-drift";

describe("owning-organization registry", () => {
  it("guards every lab-ownership column the merge was able to orphan", () => {
    expect(
      ENFORCED_OWNING_ORGANIZATION_COLUMNS.map(
        (entry) => `${entry.table}.${entry.column}`,
      ).sort(),
    ).toEqual([
      "cases.lab_organization_id",
      "doctor_profiles.lab_organization_id",
      "invoices.lab_organization_id",
      "lab_memberships.lab_id",
    ]);
  });

  it("reports the legacy columns instead of enforcing them, with a reason", () => {
    expect(
      REPORTED_OWNING_ORGANIZATION_COLUMNS.map((entry) => entry.table).sort(),
    ).toEqual(["lab_cases", "legacy_case_media"]);
    for (const entry of REPORTED_OWNING_ORGANIZATION_COLUMNS) {
      expect(entry.unenforcedReason.length).toBeGreaterThan(0);
    }
  });

  it("keeps personal details out of the report columns", () => {
    // The report is a list of records to repair, not an export of the lab's
    // people: record identifiers and opaque ids only.
    for (const entry of ALL_OWNING_ORGANIZATION_COLUMNS) {
      for (const column of entry.identityColumns) {
        expect(column).not.toMatch(/patient|name|email|phone|address/);
      }
    }
  });

  it("registers each guard trigger as a required schema object", () => {
    const required = new Set(
      REQUIRED_MIGRATION_SCHEMA_OBJECTS.filter(
        (object) => object.kind === "trigger",
      ).map((object) => `${object.tableName}.${object.name}`),
    );
    for (const entry of ENFORCED_OWNING_ORGANIZATION_COLUMNS) {
      expect(required).toContain(`${entry.table}.${entry.triggerName}`);
    }
  });
});

describe("guard DDL", () => {
  const sql = buildOwningOrganizationGuardSql();

  it("creates one trigger per enforced column and none for the legacy ones", () => {
    for (const entry of ENFORCED_OWNING_ORGANIZATION_COLUMNS) {
      expect(sql).toContain(
        `CREATE TRIGGER "${entry.triggerName}" BEFORE INSERT OR UPDATE OF "${entry.column}" ON public."${entry.table}"`,
      );
    }
    for (const entry of REPORTED_OWNING_ORGANIZATION_COLUMNS) {
      expect(sql).not.toContain(`ON public."${entry.table}"`);
    }
  });

  it("is re-runnable: every object is dropped or replaced first", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION");
    for (const entry of ENFORCED_OWNING_ORGANIZATION_COLUMNS) {
      expect(sql).toContain(`DROP TRIGGER IF EXISTS "${entry.triggerName}"`);
    }
  });

  it("skips tables that do not exist yet", () => {
    expect(sql).toContain("to_regclass('public.organizations') IS NULL");
    for (const entry of ENFORCED_OWNING_ORGANIZATION_COLUMNS) {
      expect(sql).toContain(`to_regclass('public.${entry.table}') IS NOT NULL`);
    }
  });

  it("raises the SQLSTATE a real foreign key would", () => {
    expect(sql).toContain("ERRCODE = 'foreign_key_violation'");
  });

  it("leaves an unchanged owner alone so existing orphans stay repairable", () => {
    expect(sql).toContain("prev_owner IS NOT DISTINCT FROM next_owner");
  });

  it("locks the owning organization the way a real foreign key does", () => {
    // Without this a concurrent DELETE of the organization slips between the
    // existence check and the commit, and both statements succeed.
    expect(sql).toContain(
      "PERFORM 1 FROM organizations o WHERE o.id = next_owner FOR KEY SHARE",
    );
  });

  it("guards the parent side too, so deleting the lab cannot orphan rows", () => {
    expect(sql).toContain(
      `CREATE TRIGGER "${OWNING_ORGANIZATION_PARENT_GUARD_TRIGGER}" BEFORE DELETE ON public.organizations`,
    );
    expect(sql).toContain(
      `DROP TRIGGER IF EXISTS "${OWNING_ORGANIZATION_PARENT_GUARD_TRIGGER}"`,
    );
  });

  it("carries out the onDelete each column already declares", () => {
    for (const entry of ENFORCED_OWNING_ORGANIZATION_COLUMNS) {
      const cascade = `DELETE FROM public."${entry.table}" WHERE "${entry.column}" = $1`;
      if (entry.onDelete === "cascade") {
        expect(sql).toContain(cascade);
      } else {
        // A restricted column must never be silently emptied instead.
        expect(sql).not.toContain(cascade);
        expect(sql).toContain(
          `SELECT count(*) FROM public."${entry.table}" WHERE "${entry.column}" = $1`,
        );
      }
    }
  });

  it("refuses before it cascades, so a blocked delete removes nothing", () => {
    const restricted = ENFORCED_OWNING_ORGANIZATION_COLUMNS.filter(
      (entry) => entry.onDelete === "restrict",
    );
    const cascading = ENFORCED_OWNING_ORGANIZATION_COLUMNS.filter(
      (entry) => entry.onDelete === "cascade",
    );
    expect(restricted.length, "expected at least one restricted column").toBeGreaterThan(0);
    expect(cascading.length, "expected at least one cascading column").toBeGreaterThan(0);

    const parentBody = sql.slice(
      sql.indexOf(`FUNCTION ${OWNING_ORGANIZATION_PARENT_GUARD_FUNCTION}()`),
    );
    const lastRestrict = Math.max(
      ...restricted.map((entry) =>
        parentBody.indexOf(
          `SELECT count(*) FROM public."${entry.table}" WHERE "${entry.column}" = $1`,
        ),
      ),
    );
    const firstCascade = Math.min(
      ...cascading.map((entry) =>
        parentBody.indexOf(
          `DELETE FROM public."${entry.table}" WHERE "${entry.column}" = $1`,
        ),
      ),
    );
    expect(lastRestrict).toBeGreaterThan(-1);
    expect(firstCascade).toBeGreaterThan(lastRestrict);
  });

  it("refuses to build SQL for an identifier outside the registry", () => {
    expect(() =>
      buildOwningOrganizationGuardSql([
        {
          table: 'cases"; DROP TABLE cases; --',
          column: "lab_organization_id",
          rowIdColumn: "id",
          identityColumns: [],
          describes: "case",
          triggerName: "bad",
          onDelete: "restrict",
        },
      ]),
    ).toThrow(/unexpected identifier/);
  });
});

describe("orphan report SQL", () => {
  it("counts orphans per column across every registry entry", () => {
    const sql = buildOwningOrganizationOrphanSummarySql();
    for (const entry of ALL_OWNING_ORGANIZATION_COLUMNS) {
      expect(sql).toContain(`FROM public."${entry.table}" t`);
      expect(sql).toContain(`'${entry.column}' AS column_name`);
    }
    expect(sql.split("UNION ALL")).toHaveLength(
      ALL_OWNING_ORGANIZATION_COLUMNS.length,
    );
  });

  it("lists offending rows with their identity columns", () => {
    const entry = ENFORCED_OWNING_ORGANIZATION_COLUMNS.find(
      (candidate) => candidate.table === "lab_memberships",
    )!;
    const sql = buildOwningOrganizationOrphanRowsSql(entry);
    expect(sql).toContain(`FROM public."lab_memberships" t`);
    expect(sql).toContain(`'user_id', t."user_id"::text`);
    expect(sql).toContain(`'role', t."role"::text`);
    expect(sql).toContain("NOT EXISTS");
  });

  it("still lists rows for a column with no identity columns at all", () => {
    const entry = ENFORCED_OWNING_ORGANIZATION_COLUMNS.find(
      (candidate) => candidate.table === "doctor_profiles",
    )!;
    expect(entry.identityColumns).toEqual([]);
    const sql = buildOwningOrganizationOrphanRowsSql(entry);
    expect(sql).toContain("'{}'::jsonb AS identity");
    expect(sql).not.toContain("doctor_name");
  });

  it("only reads", () => {
    const statements = [
      buildOwningOrganizationOrphanSummarySql(),
      ...ALL_OWNING_ORGANIZATION_COLUMNS.map(
        buildOwningOrganizationOrphanRowsSql,
      ),
    ];
    for (const sql of statements) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
    }
  });
});

describe("orphan report output", () => {
  const summaries = [
    parseOrphanSummaryRow({
      table_name: "cases",
      column_name: "lab_organization_id",
      total_rows: "1200",
      orphan_rows: "298",
      phantom_organizations: "140",
    }),
    parseOrphanSummaryRow({
      table_name: "legacy_case_media",
      column_name: "organization_id",
      total_rows: "900",
      orphan_rows: "400",
      phantom_organizations: "60",
    }),
  ];

  it("reads pg's string counts as numbers", () => {
    expect(summaries[0]).toMatchObject({
      table: "cases",
      totalRows: 1200,
      orphanRows: 298,
      phantomOrganizations: 140,
      enforced: true,
    });
    expect(summaries[1]?.enforced).toBe(false);
  });

  it("separates the guarded total from the reported-only total", () => {
    expect(countOrphans(summaries)).toEqual({
      enforced: 298,
      reportedOnly: 400,
    });
  });

  it("puts guarded columns first and explains the unenforced ones", () => {
    const lines = summarizeOrphanReport(summaries);
    expect(lines[0]).toContain("cases.lab_organization_id (enforced)");
    expect(lines[0]).toContain(
      "298 of 1200 row(s) name 140 organization(s) that do not exist",
    );
    expect(lines.join("\n")).toContain(
      "legacy_case_media.organization_id (reported only)",
    );
    expect(lines.join("\n")).toContain("left unenforced because");
  });

  it("keeps the row-level export opt-in and outside the repository", () => {
    const cli = readFileSync(
      resolve(import.meta.dirname, "./report-orphaned-owning-organizations.ts"),
      "utf8",
    );
    // Against production this CSV lists the lab's live records, so it must
    // not default to anywhere inside the tracked tree.
    expect(cli).toContain("os.tmpdir()");
    expect(cli).not.toMatch(/REPO_ROOT|fileURLToPath/);
    expect(cli).toContain('process.argv.includes("--csv")');

    // ...and nothing that slips into the tree can be committed by accident.
    const gitignore = readFileSync(
      resolve(import.meta.dirname, "../../.gitignore"),
      "utf8",
    );
    expect(gitignore).toContain("support/owning-organization-orphans/*.csv");
  });

  it("writes one CSV row per offending row, flagging which are guarded", () => {
    const caseEntry = ENFORCED_OWNING_ORGANIZATION_COLUMNS[0]!;
    const legacyEntry = REPORTED_OWNING_ORGANIZATION_COLUMNS[0]!;
    const csv = buildOrphanCsv([
      parseOrphanRow(caseEntry, {
        row_id: "case-1",
        organization_id: "phantom-1",
        identity: { case_number: "CN-1" },
      }),
      parseOrphanRow(legacyEntry, {
        row_id: "legacy-1",
        organization_id: "phantom-2",
        identity: { owner_id: "u-1" },
      }),
    ]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "table,column,row_id,missing_organization_id,enforced,identity",
    );
    expect(lines[1]).toContain("cases,lab_organization_id,case-1,phantom-1,yes");
    expect(lines[2]).toContain("lab_cases,organization_id,legacy-1,phantom-2,no");
  });

  it("quotes CSV values that contain separators", () => {
    const entry = ENFORCED_OWNING_ORGANIZATION_COLUMNS[0]!;
    const csv = buildOrphanCsv([
      parseOrphanRow(entry, {
        row_id: "case,1",
        organization_id: 'phantom"1',
        identity: { case_number: "CN,1" },
      }),
    ]);
    expect(csv).toContain('"case,1"');
    expect(csv).toContain('"phantom""1"');
  });

  it("skips registry tables the connected database does not have", () => {
    const columns = selectExistingColumns(["cases", "invoices"]);
    expect(columns.map((entry) => entry.table)).toEqual(["cases", "invoices"]);
  });
});
