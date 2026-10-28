import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const harness = readFileSync(resolve(root, "scripts/run-isolated-backup-restore.sh"), "utf8");

describe("isolated restore harness safety", () => {
  it("uses owned, executable workspace scratch even when launched directly", () => {
    expect(harness).toContain('scripts/with-workspace-test-scratch.sh" -- bash "$0" "$@"');
    expect(harness).toContain("labtrax-workspace-test-scratch-v1");
    expect(harness).toContain("requires owned workspace test scratch");
  });

  it("does not clone a configured shared database schema", () => {
    expect(harness).not.toContain(': "${DATABASE_URL:?');
    expect(harness).not.toContain('pg_dump --dbname="$DATABASE_URL" --schema-only');
    expect(harness).toContain("unset DATABASE_URL PROD_DATABASE_URL");
    const localBinding = harness.indexOf('export DATABASE_URL="postgresql://${LOCAL_USER}:${LOCAL_PASSWORD}@127.0.0.1:');
    const sourceSchema = harness.indexOf("pnpm --filter @workspace/db exec drizzle-kit export");
    const schemaImport = harness.indexOf('psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction');
    expect(localBinding).toBeGreaterThan(-1);
    expect(localBinding).toBeGreaterThan(harness.indexOf("unset DATABASE_URL PROD_DATABASE_URL"));
    expect(sourceSchema).toBeGreaterThan(localBinding);
    expect(schemaImport).toBeGreaterThan(sourceSchema);
    expect(harness).toContain('-f "$TMP_DIR/schema.sql"');
    expect(harness).toContain('--single-transaction');
    expect(harness).toContain('-v ON_ERROR_STOP=1');
  });

  it("applies the complete exported schema atomically before running restore tests", () => {
    const sourceSchema = harness.indexOf("pnpm --filter @workspace/db exec drizzle-kit export");
    const importSchema = harness.indexOf('psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction');
    const runTests = harness.indexOf('cd "$TEST_PACKAGE"');
    expect(sourceSchema).toBeGreaterThan(-1);
    expect(harness).toContain('--config ./drizzle.config.ts >"$TMP_DIR/schema.sql"');
    expect(importSchema).toBeGreaterThan(sourceSchema);
    expect(harness).toContain('-f "$TMP_DIR/schema.sql"');
    expect(runTests).toBeGreaterThan(importSchema);
  });

  it("retains verified TLS, random test keys, and authenticated loopback database access", () => {
    expect(harness).toContain("sslmode=verify-full&sslrootcert=");
    expect(harness).toContain("SELECT ssl FROM pg_stat_ssl");
    expect(harness).toContain("--auth-host=scram-sha-256");
    for (const key of ["JWT_SECRET", "BACKUP_ENCRYPTION_KEY", "SESSION_SECRET"]) {
      expect(harness).toContain(`export ${key}="$(openssl rand -hex 32)"`);
    }
    expect(harness).toContain("LABTRAX_ENABLE_DEMO_SEEDS=false");
    expect(harness).toContain('export LABTRAX_RECOVERY_DATA_DIR="$TMP_DIR/no-private-recovery-data"');
  });
});
