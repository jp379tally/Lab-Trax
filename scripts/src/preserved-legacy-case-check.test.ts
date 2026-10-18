import { describe, expect, it, vi } from "vitest";
import { createSyntheticPreservedCaseManifest } from "./__tests__/fixtures/synthetic-preserved-case-manifest";
import {
  checkPreservedLegacyCases,
  loadPreservedCaseManifest,
  PRESERVED_LEGACY_CASES_SQL,
} from "./preserved-legacy-case-check";

const fsState = vi.hoisted(() => ({
  manifestJson: "",
  unavailable: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((path: unknown, ...args: unknown[]) => {
    if (String(path).endsWith("preserved-legacy-case-fingerprints.json")) {
      if (fsState.unavailable) {
        throw Object.assign(new Error("synthetic manifest unavailable"), { code: "ENOENT" });
      }
      return fsState.manifestJson;
    }
    return actual.readFileSync(path as never, ...(args as never[]));
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync };
});

const intact = {
  expected_count: "297", present_count: "297",
  matching_count: "297", unexpected_count: "0",
};

const syntheticManifest = createSyntheticPreservedCaseManifest();
fsState.manifestJson = JSON.stringify(syntheticManifest);
const manifest = loadPreservedCaseManifest();

describe("publishing-only preserved legacy case exception", () => {
  it("accepts only the synthetic unchanged cohort through parameterized SELECT", async () => {
    const query = vi.fn(async () => ({ rows: [intact] }));
    const result = await checkPreservedLegacyCases(query);
    expect(result.blocking).toBe(false);
    expect(result.errors).toEqual([]);
    expect(query).toHaveBeenCalledWith(
      PRESERVED_LEGACY_CASES_SQL,
      [expect.any(String), manifest.columns],
    );
    const parameters = query.mock.calls[0] as unknown as [string, [string, string[]]];
    expect(JSON.parse(parameters[1][0])).toHaveLength(297);
    expect(JSON.parse(parameters[1][0])[0].id).toBe("synthetic-case-0001");
    expect(PRESERVED_LEGACY_CASES_SQL).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP|TRUNCATE)\b/i);
    expect(PRESERVED_LEGACY_CASES_SQL).toContain("jsonb_each(to_jsonb(c))");
    expect(PRESERVED_LEGACY_CASES_SQL).toContain("field.key = ANY($2::text[])");
  });

  it.each([
    [{ ...intact, unexpected_count: "1" }, "outside the committed legacy exception"],
    [{ ...intact, matching_count: "296" }, "changed from the approved archive"],
    [{ ...intact, present_count: "296", matching_count: "296" }, "missing from live tables"],
  ])("blocks unexpected, changed or removed records", async (row, message) => {
    const result = await checkPreservedLegacyCases(
      async () => ({ rows: [row] }),
    );
    expect(result.blocking).toBe(true);
    expect(result.errors.join("\n")).toContain(message);
  });

  it.each([
    [],
    [intact, intact],
    [{ ...intact, matching_count: "not-a-count" }],
    [{ ...intact, expected_count: "0" }],
    [{ ...intact, present_count: "298" }],
    [{ ...intact, matching_count: "298" }],
  ].map((rows) => ({ rows })))("fails closed on malformed results", async ({ rows }) => {
    await expect(
      checkPreservedLegacyCases(async () => ({ rows })),
    ).rejects.toThrow();
  });

  it("fails closed on an unavailable database", async () => {
    await expect(
      checkPreservedLegacyCases(async () => {
        throw new Error("database unavailable");
      }),
    ).rejects.toThrow("database unavailable");
  });

  it("uses only synthetic identifiers and no patient content", () => {
    expect(manifest.cases).toHaveLength(297);
    expect(new Set(manifest.cases.map((row) => row.id)).size).toBe(297);
    expect(manifest.cases.every((row) => row.id.startsWith("synthetic-case-"))).toBe(true);
    expect(manifest.columns).toContain("lab_organization_id");
    expect(manifest.columns).toContain("provider_organization_id");
    expect(manifest.cases.every((row) => Object.keys(row).sort().join() === "id,rowHash")).toBe(true);
    expect(manifest.archiveSha256).toBe("a".repeat(64));
  });

  it("fails closed when the required private manifest path is unavailable", () => {
    fsState.unavailable = true;
    try {
      expect(() => loadPreservedCaseManifest()).toThrow();
    } finally {
      fsState.unavailable = false;
    }
  });
});
