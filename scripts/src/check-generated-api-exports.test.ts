import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoDuplicateNamedExports,
  assertRetiredCaseReviewAbsent,
  assertRequiredNamedExports,
  assertGeneratedApiFingerprintCurrent,
  createGeneratedApiFingerprint,
  findDuplicateNamedExports,
} from "./check-generated-api-exports";

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
