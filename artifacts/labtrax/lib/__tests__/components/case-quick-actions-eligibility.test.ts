import { describe, expect, it } from "vitest";
import { isActiveCaseRecord } from "@/lib/case-quick-actions";

describe("isActiveCaseRecord", () => {
  it.each([
    ["complete", {}],
    ["delivered", {}],
    ["cancelled", {}],
    ["canceled", {}],
    ["void", {}],
    ["deleted", {}],
    ["in_design", { deleted: true }],
    ["received", { deletedAt: "2026-01-01T00:00:00Z" }],
  ])("excludes %s and deleted records", (status, extra) => {
    expect(isActiveCaseRecord({ status, ...extra })).toBe(false);
  });

  it("keeps live workflow statuses eligible", async () => {
    expect(isActiveCaseRecord({ status: "received" })).toBe(true);
    expect(isActiveCaseRecord({ status: "in_design" })).toBe(true);
    expect(isActiveCaseRecord({ status: "exception" })).toBe(true);
  });
});