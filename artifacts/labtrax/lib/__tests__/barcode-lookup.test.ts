import { describe, it, expect } from "vitest";
import { extractLookupCase } from "@/lib/barcode-lookup";

describe("extractLookupCase", () => {
  it("reads the case from the wrapped { ok, data: { case } } envelope", () => {
    const body = {
      ok: true,
      data: { case: { id: "case-123", caseNumber: "CN-0002" } },
    };
    expect(extractLookupCase(body)?.id).toBe("case-123");
    expect(extractLookupCase(body)?.caseNumber).toBe("CN-0002");
  });

  it("falls back to a top-level { case } shape", () => {
    const body = { case: { id: "case-legacy" } };
    expect(extractLookupCase(body)?.id).toBe("case-legacy");
  });

  it("prefers data.case over a top-level case when both are present", () => {
    const body = {
      data: { case: { id: "wrapped" } },
      case: { id: "raw" },
    };
    expect(extractLookupCase(body)?.id).toBe("wrapped");
  });

  it("returns undefined when the case is absent", () => {
    expect(extractLookupCase({ ok: true, data: {} })).toBeUndefined();
    expect(extractLookupCase({ ok: true, data: { case: undefined } })).toBeUndefined();
  });

  it("returns undefined for non-object / nullish bodies", () => {
    expect(extractLookupCase(null)).toBeUndefined();
    expect(extractLookupCase(undefined)).toBeUndefined();
    expect(extractLookupCase("nope")).toBeUndefined();
    expect(extractLookupCase(42)).toBeUndefined();
  });
});
