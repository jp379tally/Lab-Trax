import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REMAKE_REASONS,
  REMAKE_REASON_KEYS,
  getRemakeReason,
  remakeReasonUsesField,
} from "./remake-reasons";

const workspaceFile = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");

describe("remake reason contract", () => {
  it("has unique stable keys and complete display metadata", () => {
    expect(new Set(REMAKE_REASON_KEYS).size).toBe(REMAKE_REASON_KEYS.length);
    expect(REMAKE_REASONS.map((reason) => reason.key)).toEqual(REMAKE_REASON_KEYS);
    for (const reason of REMAKE_REASONS) {
      expect(reason.label.trim()).not.toBe("");
      expect(["crown_bridge", "removable", null]).toContain(reason.category);
    }
  });

  it("keeps conditional fields attached to their reason metadata", () => {
    expect(remakeReasonUsesField("shade_wrong", "shade")).toBe(true);
    expect(remakeReasonUsesField("wrong_material_lab", "material")).toBe(true);
    expect(remakeReasonUsesField("other", "customReason")).toBe(true);
    expect(getRemakeReason("fit_contacts")?.conditionalFields).toEqual([]);
  });

  it("matches the OpenAPI remakeReasonKey enum exactly", () => {
    const spec = workspaceFile("lib/api-spec/openapi.yaml");
    const match = spec.match(
      /remakeReasonKey:\s*\n\s*type: string\s*\n\s*# BEGIN GENERATED REMAKE REASON KEYS\s*\n\s*enum: \[([^\]]+)\]\s*\n\s*# END GENERATED REMAKE REASON KEYS/,
    );
    expect(match, "OpenAPI remakeReasonKey enum was not found").not.toBeNull();
    const contractKeys = match![1].split(",").map((key) => key.trim());
    expect(contractKeys).toEqual(REMAKE_REASON_KEYS);
  });

  it("generates the OpenAPI enum before API client and Zod codegen", () => {
    const apiSpecPackage = JSON.parse(workspaceFile("lib/api-spec/package.json")) as {
      scripts?: Record<string, string>;
    };
    expect(apiSpecPackage.scripts?.codegen).toMatch(
      /^pnpm run generate:remake-reason-enum && orval\b/,
    );
  });

  it("keeps every runtime surface on the shared catalogue", () => {
    const consumers = [
      "artifacts/api-server/src/routes/cases.ts",
      "artifacts/labtrax-desktop/src/components/remake-questionnaire.tsx",
      "artifacts/labtrax/app/new-case.tsx",
      "artifacts/labtrax/components/RemakeReasonPicker.tsx",
      "artifacts/labtrax/app/ai-reader/extracted.tsx",
    ];
    for (const path of consumers) {
      const source = workspaceFile(path);
      expect(
        /\bREMAKE_REASONS\b|\bREMAKE_REASON_KEYS\b/.test(source),
        `${path} must consume REMAKE_REASONS or REMAKE_REASON_KEYS`,
      ).toBe(true);
    }
  });

  it("traces the case detail screen through its canonical mobile adapter", () => {
    const adapter = workspaceFile("artifacts/labtrax/components/RemakeReasonPicker.tsx");
    const detail = workspaceFile("artifacts/labtrax/app/case/[id].tsx");
    expect(adapter).toMatch(/import\s*{\s*REMAKE_REASONS\s*}\s*from\s*["']@workspace\/case-taxonomy["']/);
    expect(adapter).toMatch(/export const MOBILE_REMAKE_REASONS\s*=\s*REMAKE_REASONS\.map/);
    expect(
      /import\s*{[^}]*\bMOBILE_REMAKE_REASONS\b[^}]*}\s*from\s*["']@\/components\/RemakeReasonPicker["']/.test(detail),
      "The case detail screen must import the canonical mobile adapter",
    ).toBe(true);
    expect(detail.includes("MOBILE_REMAKE_REASONS.find")).toBe(true);
  });
});