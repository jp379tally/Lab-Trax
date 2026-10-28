/**
 * Which columns name the organization that *owns* a row, and which of them the
 * database refuses to leave dangling.
 *
 * Background
 * ──────────
 * Several tables record an owning lab organization in a plain `varchar` column.
 * The Drizzle definitions declare `.references(() => organizations.id)` for
 * them, but no live database has ever carried those foreign keys: every
 * `drizzle-kit push` that tried to create one aborted on rows whose owner is
 * already missing. The result is a schema that *looks* constrained while the
 * database accepts a case, invoice, provider profile or membership owned by a
 * lab that does not exist — which is exactly how the October 2026 merge was
 * able to land thousands of such rows without a single foreign-key complaint.
 *
 * Why a trigger instead of a foreign key
 * ──────────────────────────────────────
 * Those pre-existing rows cannot be adopted by a validating foreign key, and
 * they cannot be deleted from here — repairing them is its own, separate piece
 * of work with its own evidence requirements. PostgreSQL's `NOT VALID` foreign
 * key is the normal answer (check new writes, leave old rows alone), but it
 * would also make the development schema differ from production, and Publish
 * computes its production migration by diffing the two databases: the diff
 * would try to add a *validating* foreign key to production and fail on the
 * same orphans.
 *
 * Row triggers give the same guarantee without appearing in that schema diff.
 * They are installed in development and production alike by the API server's
 * `ensureDbConstraints()` boot step, next to the other constraints Drizzle
 * cannot express, and they are skipped automatically while
 * `session_replication_role = 'replica'`, so restores and dump replays keep
 * working.
 *
 * Both halves of a foreign key
 * ────────────────────────────
 * A foreign key guards two directions, and so does this. Guarding only the
 * child side would still let an organization be deleted out from under its
 * rows, which is another way to manufacture exactly the orphans this exists
 * to prevent.
 *
 * On the child side (`assert_owning_organization_exists`), mirroring a
 * `NOT VALID` foreign key:
 *   - a NULL owner is allowed (the column itself decides nullability);
 *   - an UPDATE that leaves the owner unchanged is allowed, so the rows that
 *     are already orphaned stay editable and repairable;
 *   - anything that points a row at an organization that does not exist fails;
 *   - the owner row is locked `FOR KEY SHARE` for the rest of the writing
 *     transaction, exactly as a real foreign key does, so an organization
 *     cannot be deleted in the window between the check and the commit.
 *
 * On the parent side (`assert_organization_has_no_owned_rows`), deleting an
 * organization carries out the `onDelete` action each column already declares,
 * rather than a stricter rule invented here:
 *   - `cases` and `invoices` declare `restrict`, so the delete is refused
 *     while any of them still belong to the organization;
 *   - `doctor_profiles` and `lab_memberships` declare `cascade`, so they go
 *     with it. Both are records *of* the lab — its provider list and its
 *     staff roster — and a provider profile is created as a side effect of
 *     other writes, so nothing tracks them well enough to clear them by hand.
 *
 * No production code path deletes an organization today, so this changes no
 * live behaviour; it decides what happens the first time one does.
 */

export interface OwningOrganizationColumn {
  /** Physical table name. */
  table: string;
  /** Column holding the owning organization id. */
  column: string;
  /** Column that identifies a row in the orphan report. */
  rowIdColumn: string;
  /**
   * Extra columns printed next to the row id in the report.
   *
   * Record identifiers only — a case number, an invoice number, an opaque row
   * id. Deliberately excludes every personal name, so the report stays a list
   * of records to repair rather than an export of the lab's people.
   */
  identityColumns: string[];
  /** What one row of this table is, in operator language. */
  describes: string;
}

export interface EnforcedOwningOrganizationColumn
  extends OwningOrganizationColumn {
  /** Name of the row trigger that enforces the reference. */
  triggerName: string;
  /**
   * What deleting the owning organization does to these rows — the `onDelete`
   * the Drizzle definition already declares for this column, carried out by
   * the parent-side trigger because the foreign key itself never existed.
   */
  onDelete: "restrict" | "cascade";
}

export interface ReportedOwningOrganizationColumn
  extends OwningOrganizationColumn {
  /** Why this column is reported but deliberately left unenforced. */
  unenforcedReason: string;
}

/** The child-side trigger function every enforced column shares. */
export const OWNING_ORGANIZATION_GUARD_FUNCTION =
  "assert_owning_organization_exists";

/** The parent-side function: refuses to delete an organization still in use. */
export const OWNING_ORGANIZATION_PARENT_GUARD_FUNCTION =
  "assert_organization_has_no_owned_rows";

/** The parent-side trigger, on `organizations`. */
export const OWNING_ORGANIZATION_PARENT_GUARD_TRIGGER =
  "organizations_owned_rows_restrict";

/**
 * Ownership columns the database now enforces. Writing one of these rows
 * against an organization that does not exist raises `foreign_key_violation`.
 */
export const ENFORCED_OWNING_ORGANIZATION_COLUMNS: readonly EnforcedOwningOrganizationColumn[] =
  [
    {
      table: "cases",
      column: "lab_organization_id",
      rowIdColumn: "id",
      identityColumns: ["case_number"],
      describes: "case",
      triggerName: "cases_lab_organization_exists",
      onDelete: "restrict",
    },
    {
      table: "invoices",
      column: "lab_organization_id",
      rowIdColumn: "id",
      identityColumns: ["invoice_number"],
      describes: "invoice",
      triggerName: "invoices_lab_organization_exists",
      onDelete: "restrict",
    },
    {
      table: "doctor_profiles",
      column: "lab_organization_id",
      rowIdColumn: "id",
      // The profile id is enough to look the row up; the provider's name is
      // deliberately not carried out of the database by this report.
      identityColumns: [],
      describes: "provider profile",
      triggerName: "doctor_profiles_lab_organization_exists",
      // The lab's own provider list, created as a side effect of other
      // writes, so callers cannot reliably clear it themselves.
      onDelete: "cascade",
    },
    {
      table: "lab_memberships",
      column: "lab_id",
      rowIdColumn: "id",
      identityColumns: ["user_id", "role"],
      describes: "lab membership",
      triggerName: "lab_memberships_lab_exists",
      // The lab's staff roster; meaningless once the lab is gone.
      onDelete: "cascade",
    },
  ] as const;

/**
 * Ownership columns that are reported but NOT enforced.
 *
 * Both belong to the legacy mobile case path, and both already hold orphans of
 * their own. Enforcing them would not stop bad data arriving — it would stop
 * the legacy path working at all for the cases that are *already* orphaned:
 * saving such a case re-inserts it (`INSERT … ON CONFLICT DO UPDATE`, which
 * fires the INSERT trigger), and viewing one binds its photos into
 * `legacy_case_media` using the case's own organization id. Blocking either
 * would turn an ownership problem into blank thumbnails and unsaveable cases,
 * and the nightly orphan-media sweep would then treat the unbound files as
 * unreferenced.
 */
export const REPORTED_OWNING_ORGANIZATION_COLUMNS: readonly ReportedOwningOrganizationColumn[] =
  [
    {
      table: "lab_cases",
      column: "organization_id",
      rowIdColumn: "id",
      identityColumns: ["owner_id"],
      describes: "legacy mobile case",
      unenforcedReason:
        "legacy cases are saved with an upsert, so enforcing this would make the already-orphaned ones unsaveable rather than stopping new bad data",
    },
    {
      table: "legacy_case_media",
      column: "organization_id",
      rowIdColumn: "file_name",
      identityColumns: ["lab_case_id"],
      describes: "legacy case media binding",
      unenforcedReason:
        "media is bound on first view from the legacy case's own organization id, so enforcing this would leave photos of orphaned cases unbound, unservable, and exposed to the nightly orphan-media sweep",
    },
  ] as const;

/** Every ownership column the orphan report covers, enforced or not. */
export const ALL_OWNING_ORGANIZATION_COLUMNS: readonly OwningOrganizationColumn[] =
  [
    ...ENFORCED_OWNING_ORGANIZATION_COLUMNS,
    ...REPORTED_OWNING_ORGANIZATION_COLUMNS,
  ];

export function formatOwningOrganizationColumn({
  table,
  column,
}: Pick<OwningOrganizationColumn, "table" | "column">): string {
  return `${table}.${column}`;
}

/** Double-quote a PostgreSQL identifier that comes from the registry above. */
function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(
      `Refusing to build SQL for unexpected identifier: ${identifier}`,
    );
  }
  return `"${identifier}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Idempotent DDL that installs or verifies the ownership guard. Healthy
 * triggers are not dropped and recreated on every boot because that requires
 * an ACCESS EXCLUSIVE lock on each guarded table.
 */
export function buildOwningOrganizationGuardSql(
  columns: readonly EnforcedOwningOrganizationColumn[] = ENFORCED_OWNING_ORGANIZATION_COLUMNS,
): string {
  const installs = columns
    .map((entry) => {
      const table = quoteIdentifier(entry.table);
      const column = quoteIdentifier(entry.column);
      const trigger = quoteIdentifier(entry.triggerName);
      // Re-quoted once more because these land inside an EXECUTE string.
      const dropSql = quoteLiteral(
        `DROP TRIGGER IF EXISTS ${trigger} ON public.${table}`,
      );
      const createSql = quoteLiteral(
        `CREATE TRIGGER ${trigger} BEFORE INSERT OR UPDATE OF ${column} ` +
          `ON public.${table} FOR EACH ROW EXECUTE FUNCTION ` +
          `${OWNING_ORGANIZATION_GUARD_FUNCTION}(` +
          `${quoteLiteral(entry.column)}, ${quoteLiteral(entry.describes)})`,
      );
      return `  IF to_regclass('public.${entry.table}') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid = to_regclass('public.${entry.table}')
        AND t.tgname = ${quoteLiteral(entry.triggerName)}
        AND t.tgfoid = ${quoteLiteral(`${OWNING_ORGANIZATION_GUARD_FUNCTION}()`)}::regprocedure
        AND t.tgtype = 23
        AND t.tgenabled IN ('O', 'A')
        AND t.tgqual IS NULL
        AND t.tgnargs = 2
        AND t.tgargs = decode(
          encode(convert_to(${quoteLiteral(entry.column)}, 'UTF8'), 'hex') || '00' ||
          encode(convert_to(${quoteLiteral(entry.describes)}, 'UTF8'), 'hex') || '00',
          'hex'
        )
        AND t.tgattr::text = (
          SELECT a.attnum::text
          FROM pg_attribute a
          WHERE a.attrelid = t.tgrelid
            AND a.attname = ${quoteLiteral(entry.column)}
            AND NOT a.attisdropped
        )
        AND NOT t.tgisinternal
    ) THEN
      EXECUTE ${dropSql};
      EXECUTE ${createSql};
    END IF;
  END IF;`;
    })
    .join("\n");

  // Every statement goes through EXECUTE so the function body never has to be
  // planned against a table that does not exist yet on a fresh database.
  // Restricts are emitted before cascades: if the delete is going to be
  // refused, nothing has been removed by the time it is.
  const parentChecks = [
    ...columns.filter((entry) => entry.onDelete === "restrict"),
    ...columns.filter((entry) => entry.onDelete === "cascade"),
  ]
    .map((entry) => {
      const qualified = `public.${quoteIdentifier(entry.table)}`;
      const column = quoteIdentifier(entry.column);
      const guard = `  IF to_regclass('public.${entry.table}') IS NOT NULL THEN`;

      if (entry.onDelete === "cascade") {
        return `${guard}
    EXECUTE ${quoteLiteral(`DELETE FROM ${qualified} WHERE ${column} = $1`)} USING OLD.id;
  END IF;`;
      }

      const probe = quoteLiteral(
        `SELECT count(*) FROM ${qualified} WHERE ${column} = $1`,
      );
      return `${guard}
    EXECUTE ${probe} INTO owned_rows USING OLD.id;
    IF owned_rows > 0 THEN
      RAISE EXCEPTION
        'cannot delete organization % — % % row(s) still belong to it (%.%)',
        OLD.id, owned_rows, ${quoteLiteral(entry.describes)}, ${quoteLiteral(entry.table)}, ${quoteLiteral(entry.column)}
        USING ERRCODE = 'foreign_key_violation',
              HINT = 'Remove or reassign those rows first — deleting the organization while they point at it would orphan them.';
    END IF;
  END IF;`;
    })
    .join("\n");

  return `
-- Owning-organization guard. See lib/db/src/schema/owning-organizations.ts for
-- why this is a trigger and not a foreign key.
CREATE OR REPLACE FUNCTION ${OWNING_ORGANIZATION_GUARD_FUNCTION}()
RETURNS TRIGGER LANGUAGE plpgsql AS $owning_org$
DECLARE
  owner_column text := TG_ARGV[0];
  owner_label  text := TG_ARGV[1];
  next_owner   text := to_jsonb(NEW) ->> TG_ARGV[0];
  prev_owner   text;
BEGIN
  -- Nullability is the column's business, not this guard's.
  IF next_owner IS NULL THEN
    RETURN NEW;
  END IF;

  -- An UPDATE that does not move the row to a different owner is allowed, so
  -- rows that are already orphaned remain editable and repairable. This is
  -- what a NOT VALID foreign key does too.
  IF TG_OP = 'UPDATE' THEN
    prev_owner := to_jsonb(OLD) ->> owner_column;
    IF prev_owner IS NOT DISTINCT FROM next_owner THEN
      RETURN NEW;
    END IF;
  END IF;

  -- FOR KEY SHARE is what a real foreign key takes on the parent row: it does
  -- not block other writers referencing the same organization, but it does
  -- hold off a DELETE of that organization until this transaction ends, so the
  -- owner cannot disappear between this check and the commit.
  PERFORM 1 FROM organizations o WHERE o.id = next_owner FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'cannot save this % against organization % — no such organization exists (%.%)',
      owner_label, next_owner, TG_TABLE_NAME, owner_column
      USING ERRCODE = 'foreign_key_violation',
            HINT = 'Create or correct the owning organization first. Rows that already violate this rule are listed by: pnpm --filter @workspace/scripts run report-orphaned-owning-organizations';
  END IF;

  RETURN NEW;
END
$owning_org$;

-- Parent side: an organization that still owns any guarded row may not be
-- deleted. Without this, deleting the lab is simply another way to create the
-- orphans the child-side trigger exists to prevent.
CREATE OR REPLACE FUNCTION ${OWNING_ORGANIZATION_PARENT_GUARD_FUNCTION}()
RETURNS TRIGGER LANGUAGE plpgsql AS $owning_org_parent$
DECLARE
  owned_rows bigint;
BEGIN
${parentChecks}
  RETURN OLD;
END
$owning_org_parent$;

DO $owning_org_setup$
BEGIN
  IF to_regclass('public.organizations') IS NULL THEN
    RETURN;
  END IF;
${installs}
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.organizations'::regclass
      AND t.tgname = ${quoteLiteral(OWNING_ORGANIZATION_PARENT_GUARD_TRIGGER)}
      AND t.tgfoid = ${quoteLiteral(`${OWNING_ORGANIZATION_PARENT_GUARD_FUNCTION}()`)}::regprocedure
      AND t.tgtype = 11
      AND t.tgenabled IN ('O', 'A')
      AND t.tgqual IS NULL
      AND t.tgnargs = 0
      AND cardinality(t.tgattr) = 0
      AND NOT t.tgisinternal
  ) THEN
    EXECUTE ${quoteLiteral(
      `DROP TRIGGER IF EXISTS ${quoteIdentifier(OWNING_ORGANIZATION_PARENT_GUARD_TRIGGER)} ON public.organizations`,
    )};
    EXECUTE ${quoteLiteral(
      `CREATE TRIGGER ${quoteIdentifier(OWNING_ORGANIZATION_PARENT_GUARD_TRIGGER)} ` +
        `BEFORE DELETE ON public.organizations FOR EACH ROW ` +
        `EXECUTE FUNCTION ${OWNING_ORGANIZATION_PARENT_GUARD_FUNCTION}()`,
    )};
  END IF;
END
$owning_org_setup$;
`.trim();
}

/**
 * One row per ownership column: how many rows it has, how many name an
 * organization that does not exist, and how many distinct phantom
 * organizations those rows point at.
 */
export function buildOwningOrganizationOrphanSummarySql(
  columns: readonly OwningOrganizationColumn[] = ALL_OWNING_ORGANIZATION_COLUMNS,
): string {
  if (columns.length === 0) {
    throw new Error("No owning-organization columns to summarize");
  }
  return columns
    .map((entry) => {
      const table = quoteIdentifier(entry.table);
      const column = quoteIdentifier(entry.column);
      return `SELECT ${quoteLiteral(entry.table)} AS table_name,
       ${quoteLiteral(entry.column)} AS column_name,
       (SELECT count(*) FROM public.${table}) AS total_rows,
       count(*) AS orphan_rows,
       count(DISTINCT t.${column}) AS phantom_organizations
  FROM public.${table} t
 WHERE t.${column} IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.${column})`;
    })
    .join("\nUNION ALL\n");
}

/** Every offending row of one ownership column, oldest phantom owner first. */
export function buildOwningOrganizationOrphanRowsSql(
  entry: OwningOrganizationColumn,
): string {
  const table = quoteIdentifier(entry.table);
  const column = quoteIdentifier(entry.column);
  const rowId = quoteIdentifier(entry.rowIdColumn);
  const identity = entry.identityColumns
    .map(
      (name) =>
        `${quoteLiteral(name)}, t.${quoteIdentifier(name)}::text`,
    )
    .join(", ");
  return `SELECT t.${rowId}::text AS row_id,
       t.${column}::text AS organization_id,
       ${identity.length > 0 ? `jsonb_build_object(${identity})` : "'{}'::jsonb"} AS identity
  FROM public.${table} t
 WHERE t.${column} IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.${column})
 ORDER BY t.${column}, t.${rowId}`;
}

/** Which of the registry's tables actually exist in the connected database. */
export const OWNING_ORGANIZATION_TABLE_EXISTS_SQL = `
select tablename as table_name
  from pg_tables
 where schemaname = 'public'
   and tablename = any($1::text[])
`.trim();

/** Which enforced guard triggers are currently installed. */
export const OWNING_ORGANIZATION_TRIGGER_SQL = `
select trigger.tgname as trigger_name,
       table_class.relname as table_name
  from pg_trigger trigger
  join pg_class table_class on table_class.oid = trigger.tgrelid
  join pg_namespace table_namespace on table_namespace.oid = table_class.relnamespace
 where table_namespace.nspname = 'public'
   and not trigger.tgisinternal
`.trim();
