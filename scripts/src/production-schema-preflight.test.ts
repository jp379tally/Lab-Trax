import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseExpectedDataFingerprints } from "./data-fingerprint";

describe("production schema preflight", () => {
  it("reports production drift before building without blocking Publish-managed migrations", () => {
    const artifactToml = readFileSync(
      resolve(
        import.meta.dirname,
        "../../artifacts/api-server/.replit-artifact/artifact.toml",
      ),
      "utf8",
    );

    expect(artifactToml).toContain(
      'args = ["pnpm", "run", "build:api-production"]',
    );

    const rootPackage = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(rootPackage.scripts["build:api-production"]).toBe(
      "pnpm run check:generated-api && pnpm --filter @workspace/scripts run check-production-schema-columns && pnpm --filter @workspace/scripts run check-publish-schema-safety && pnpm --filter @workspace/api-server run build",
    );

    const scriptsPackage = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(scriptsPackage.scripts["check-production-schema-columns"]).toBe(
      "SCHEMA_COLUMN_CHECK_TARGET=production SCHEMA_COLUMN_CHECK_ALLOW_MISSING=1 tsx ./src/check-schema-columns.ts",
    );
  });

  it("runs migration screening before compiling and never claims platform promotion safety", () => {
    const scriptsPackage = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(scriptsPackage.scripts["check-publish-schema-safety"]).toBe(
      "tsx ./src/publish-schema-safety.ts",
    );

    const checker = readFileSync(
      resolve(import.meta.dirname, "./publish-schema-safety.ts"),
      "utf8",
    );
    expect(checker).toContain("MIGRATION SAFETY UNVERIFIED");
    expect(checker).toContain("PUBLISH_SCHEMA_DIFF_PATH");
    expect(checker).toContain("process.exitCode = 1");

    const policy = readFileSync(
      resolve(import.meta.dirname, "../../docs/production-data-preservation.md"),
      "utf8",
    );
    expect(policy).toContain("platform-managed pending migration diff");
    expect(policy).toContain("off-site production backup");
  });

  it("checks the production data fingerprint inside that same preflight", () => {
    const preflight = readFileSync(
      resolve(import.meta.dirname, "./check-schema-columns.ts"),
      "utf8",
    );

    // One gate, not two: the deployment build runs a single preflight that
    // reports schema drift and database identity together.
    expect(preflight).toContain("./data-fingerprint");
    expect(preflight).toContain("checkDataIdentity");

    // The identity verdict comes from the shared resolver, so a database the
    // probe cannot read is judged rather than skipped.
    expect(preflight).toContain("resolveDataIdentity");
  });

  it("keeps a deliberate, committed way to re-record a fingerprint", () => {
    const scriptsPackage = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(scriptsPackage.scripts["record-data-fingerprint"]).toBe(
      "tsx ./src/record-data-fingerprint.ts",
    );
    expect(scriptsPackage.scripts["record-production-data-fingerprint"]).toBe(
      'DATA_FINGERPRINT_TARGET=production DATABASE_URL="$PROD_DATABASE_URL" tsx ./src/record-data-fingerprint.ts',
    );

    // The production fingerprint is private. Exercise the same shape contract
    // with the deliberately synthetic fixture shipped for public tests.
    const fingerprintFixture = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, "./fixtures/synthetic-database-fingerprint.json"),
        "utf8",
      ),
    ) as unknown;
    const fingerprint = parseExpectedDataFingerprints(fingerprintFixture);
    expect(fingerprint).toHaveProperty("production");
    expect(fingerprint).toHaveProperty("development");
    expect(fingerprint.production?.labOrganizationId).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
  });
});