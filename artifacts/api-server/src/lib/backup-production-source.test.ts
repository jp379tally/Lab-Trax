import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { verifyProductionBackupSource } from "./backup-production-source";
const mock = vi.hoisted(() => ({ missing: false }));
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => {
    if (mock.missing) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return Buffer.from(JSON.stringify({
      minimumRetainedFraction: 0.9,
      production: { labOrganizationId: "protected-lab", activeCaseCount: 100,
        oldestCaseCreatedAt: "2026-05-12T15:44:59.587588Z" },
      development: { oldestCaseCreatedAt: "2026-04-09T00:20:34.236879Z" },
    }));
  }),
}));
const client = (row: Record<string, unknown>) => ({
  query: vi.fn(async () => ({ rows: [row] })),
}) as unknown as PoolClient;
const original = { exists: true, cases: "100", oldest: "2026-05-12T15:44:59.587588Z" };
describe("production backup source lineage", () => {
  it("pins the committed identity from the snapshot client, not an environment label", async () => {
    const source = client(original);
    expect(await verifyProductionBackupSource(source)).toMatch(/^[a-f0-9]{64}$/);
    expect(source.query).toHaveBeenCalledWith(expect.stringContaining("YYYY-MM-DD"), ["protected-lab"]);
  });
  it("rejects a swapped database, absent protected lab, or collapsed retained scope", async () => {
    for (const row of [{ ...original, exists: false }, { ...original, cases: "89" },
      { ...original, oldest: "2026-04-09T00:20:34.236879Z" }]) {
      await expect(verifyProductionBackupSource(client(row))).rejects.toThrow(/lineage/);
    }
  });
  it("fails explicitly when the deployment lacks its committed fingerprint", async () => {
    mock.missing = true;
    try { await expect(verifyProductionBackupSource(client(original))).rejects.toThrow(/fingerprint/); }
    finally { mock.missing = false; }
  });
});
