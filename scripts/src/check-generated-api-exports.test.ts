import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  assertNoDuplicateNamedExports,
  assertRetiredCaseReviewAbsent,
  assertRequiredNamedExports,
  assertGeneratedApiFingerprintCurrent,
  createGeneratedApiFingerprint,
  findDuplicateNamedExports,
} from "./check-generated-api-exports";

describe("generated API Zod runtime compatibility", () => {
  it("targets the locked validator version and rejects a stale installation", () => {
    const packagePath = resolve(import.meta.dirname, "../../lib/api-zod/package.json");
    const requireZod = createRequire(packagePath);
    const installedVersion = requireZod("zod/package.json").version;
    const lockfile = parse(readFileSync(
      resolve(import.meta.dirname, "../../pnpm-lock.yaml"), "utf8",
    ));
    const lockedVersion = lockfile.importers["lib/api-zod"].dependencies.zod.version;
    expect(installedVersion).toBe(lockedVersion.split("(")[0]);
    const major = Number(installedVersion.split(".")[0]);
    const config = readFileSync(
      resolve(import.meta.dirname, "../../lib/api-spec/orval.config.ts"), "utf8",
    );
    expect(config).toMatch(new RegExp(`version:\\s*${major}\\b`));
  });

  it("loads the complete generated module and preserves URL, UUID, and extensible-object validation", async () => {
    // This is a runtime check of another package, not a scripts source import.
    // Keep that package's sources outside the scripts TypeScript compilation.
    const modulePath = resolve(import.meta.dirname, "../../lib/api-zod/src/generated/api.ts");
    const schemas = await import(modulePath);
    expect(schemas.CreateSubscriptionCheckoutBody.safeParse({
      successUrl: "https://example.com/success",
    }).success).toBe(true);
    expect(schemas.CreateSubscriptionCheckoutBody.safeParse({
      successUrl: "not a URL",
    }).success).toBe(false);
    expect(schemas.GetBackupRunStatusParams.safeParse({
      runId: "123e4567-e89b-42d3-a456-426614174000",
    }).success).toBe(true);
    expect(schemas.GetBackupRunStatusParams.safeParse({
      runId: "not a UUID",
    }).success).toBe(false);
    const extraData = { id: 123, customMetadata: { source: "regression" } };
    expect(schemas.UpdateCase200Response.parse({
      ok: true, data: extraData,
    }).data).toEqual(extraData);
  });
});

describe("retired case-review API guard", () => {
  it.each([
    "/cases/{caseId}/ai-review",
    '"/cases/{caseId}/ai-review"',
    "'/cases/{caseId}/ai-review'",
  ])("rejects the retired path %s even with a renamed operation", (path) => {
    const source = `
paths:
  ${path}:
    patch:
      operationId: reviewCaseAgain
`;
    expect(() =>
      assertRetiredCaseReviewAbsent(source, "openapi.yaml"),
    ).toThrowError(/Retired case-review API found in openapi.yaml/);
  });

  it("rejects the acknowledgement operation even on a different path", () => {
    const source = `
paths:
  /cases/{caseId}/review:
    patch:
      operationId: "acknowledgeAiReview"
`;
    expect(() =>
      assertRetiredCaseReviewAbsent(source, "openapi.yaml"),
    ).toThrowError(/acknowledgeAiReview/);
  });

  it.each([
    "acknowledgeAiReview",
    "useAcknowledgeAiReview",
    "getAcknowledgeAiReviewMutationOptions",
    "AcknowledgeAiReview200",
    "acknowledgeAiReviewResponse",
  ])("rejects the generated acknowledgement symbol %s", (name) => {
    expect(() =>
      assertRetiredCaseReviewAbsent(
        `export const ${name} = {};`,
        "generated.ts",
      ),
    ).toThrowError(/Retired case-review API found in generated.ts/);
  });

  it("preserves invoice review and historical case metadata", () => {
    expect(() =>
      assertRetiredCaseReviewAbsent(`
paths:
  /invoices/{invoiceId}/ai-review:
    patch:
      operationId: acknowledgeInvoiceAiReview
components:
  schemas:
    Case:
      properties:
        needsAiReview: { type: boolean }
        itero: { type: object }
`, "openapi.yaml"),
    ).not.toThrow();
  });

  it("accepts the current OpenAPI contract", () => {
    const path = resolve(import.meta.dirname, "../../lib/api-spec/openapi.yaml");
    expect(() =>
      assertRetiredCaseReviewAbsent(readFileSync(path, "utf8"), path),
    ).not.toThrow();
  });
});

describe("generated API duplicate export guard", () => {
  it("detects the duplicate-export regression fixture", () => {
    const fixturePath = resolve(
      import.meta.dirname,
      "fixtures/generated-api-duplicate-export.ts.txt",
    );
    const fixture = readFileSync(fixturePath, "utf8");

    expect(findDuplicateNamedExports(fixture)).toEqual([
      "getExampleResponseLimitMax",
    ]);
    expect(() =>
      assertNoDuplicateNamedExports(fixture, fixturePath),
    ).toThrowError(/pnpm --filter @workspace\/api-spec run codegen/);
  });

  it("accepts unique declaration and export-list names", () => {
    const source = `
      export const First = 1;
      const localValue = 2;
      export { localValue as Second };
      export type Third = { ok: true };
      export const Third = { ok: true } as const;
    `;

    expect(findDuplicateNamedExports(source)).toEqual([]);
  });
});

describe("generated API required export guard", () => {
  it("requires generated scanner error response validators", () => {
    const source = `
      export const StartScanJob409Response = {};
      export const UploadScanInputChunk409Response = {};
    `;

    expect(() =>
      assertRequiredNamedExports(source, "generated.ts", [
        "StartScanJob409Response",
        "UploadScanInputChunk409Response",
      ]),
    ).not.toThrow();
    expect(() =>
      assertRequiredNamedExports(
        "export const StartScanJob409Response = {};",
        "generated.ts",
        ["StartScanJob409Response", "UploadScanInputChunk409Response"],
      ),
    ).toThrowError(/UploadScanInputChunk409Response/);
  });
});

describe("generated API codegen drift guard", () => {
  it("detects stale generated output", () => {
    const workspaceRoot = resolve(import.meta.dirname, "../..");
    const current = createGeneratedApiFingerprint(workspaceRoot);
    const stale = structuredClone(current);
    const generatedPath = Object.keys(stale.outputs)[0];
    stale.outputs[generatedPath] = "stale-generated-content";

    expect(() =>
      assertGeneratedApiFingerprintCurrent(stale, current),
    ).toThrowError(/pnpm --filter @workspace\/api-spec run codegen/);
  });

  it("detects a changed codegen toolchain", () => {
    const workspaceRoot = resolve(import.meta.dirname, "../..");
    const current = createGeneratedApiFingerprint(workspaceRoot);
    const stale = structuredClone(current);
    stale.toolchain.orval = "older-orval-version";

    expect(() =>
      assertGeneratedApiFingerprintCurrent(stale, current),
    ).toThrowError(/pnpm --filter @workspace\/api-spec run codegen/);
  });
});
