import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../sql/case-saved-views.sql", import.meta.url), "utf8");
const setup = readFileSync(new URL("../post-merge.sh", import.meta.url), "utf8");

describe("saved Cases views additive merge reconciliation", () => {
  it("installs every declared field and both indexes idempotently", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.case_saved_views");
    for (const column of ["id", "lab_organization_id", "name", "filters", "created_by_user_id", "created_at", "updated_at"]) {
      expect(migration).toMatch(new RegExp(`\\b${column}\\s+(varchar|text|jsonb|timestamptz)`));
    }
    expect(migration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS case_saved_views_lab_name_unique");
    expect(migration).toContain("lower(name)");
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS case_saved_views_lab_idx");
    expect(migration).toContain("ON DELETE CASCADE");
    expect(migration).toContain("ON DELETE SET NULL");
  });

  it("is transactional, bounded, and performs no historical data repairs", () => {
    const statements = migration.replace(/--[^\n]*/g, "");
    expect(statements.trim()).toMatch(/^BEGIN;/);
    expect(statements.trim()).toMatch(/COMMIT;$/);
    expect(statements).toContain("pg_advisory_xact_lock");
    expect(statements).toContain("SET LOCAL lock_timeout");
    expect(statements).not.toMatch(/\b(UPDATE|INSERT|TRUNCATE|DROP)\b|\bDELETE\s+FROM\b/i);
  });

  it("runs before the broad push and retains the independent drift gate", () => {
    const command = 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/case-saved-views.sql';
    expect(setup).toContain(command);
    expect(setup.indexOf(command)).toBeLessThan(setup.indexOf("pnpm --filter @workspace/db run push-force"));
    expect(setup.indexOf(command)).toBeLessThan(setup.indexOf("pnpm --filter @workspace/scripts run check-schema-columns"));
  });
});
