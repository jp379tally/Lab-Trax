import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildOwningOrganizationGuardSql } from "@workspace/db/schema";
import {
  assertDevelopmentGuardTarget,
  installOwningOrganizationGuards,
} from "./install-owning-organization-guards";

describe("post-merge owning-organization guards", () => {
  it("installs the shared boot definitions transactionally with bounded lock waits", async () => {
    const query = vi.fn(async (_sql: string) => undefined);
    await installOwningOrganizationGuards({ query });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN", "SET LOCAL lock_timeout = '10s'",
      buildOwningOrganizationGuardSql(), "COMMIT",
    ]);
  });

  it("rolls back an installation error and reports failure rather than skipping it", async () => {
    const failure = new Error("DDL rejected");
    const query = vi.fn(async (sql: string) => {
      if (sql === buildOwningOrganizationGuardSql()) throw failure;
    });
    await expect(installOwningOrganizationGuards({ query })).rejects.toBe(failure);
    expect(query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
    expect(query.mock.calls.flat()).not.toContain("COMMIT");
  });

  it("requires a database and refuses accidental production targeting", () => {
    expect(() => assertDevelopmentGuardTarget({})).toThrow(/DATABASE_URL is required/);
    expect(() => assertDevelopmentGuardTarget({
      DATABASE_URL: "production-test-url", NODE_ENV: "production",
    })).toThrow(/development-only/);
    expect(() => assertDevelopmentGuardTarget({
      DATABASE_URL: "same-test-url", PROD_DATABASE_URL: "same-test-url",
    })).toThrow(/development-only/);
    expect(() => assertDevelopmentGuardTarget({
      DATABASE_URL: "development-test-url", PROD_DATABASE_URL: "production-test-url",
    })).not.toThrow();
  });

  it("installs guards after schema push but before the mandatory drift gate", () => {
    const setup = readFileSync(resolve(import.meta.dirname, "../post-merge.sh"), "utf8");
    const push = setup.indexOf("pnpm --filter @workspace/db run push-force");
    const install = setup.indexOf("pnpm --filter @workspace/scripts run install-owning-organization-guards");
    const check = setup.indexOf("pnpm --filter @workspace/scripts run check-schema-columns");
    expect(push).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(push);
    expect(check).toBeGreaterThan(install);
    expect(setup).toContain("set -euo pipefail");
    expect(setup).not.toMatch(/install-owning-organization-guards\s*\|\|/);
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"));
    expect(pkg.scripts["install-owning-organization-guards"]).toBe(
      "tsx ./src/install-owning-organization-guards.ts",
    );
  });
});
