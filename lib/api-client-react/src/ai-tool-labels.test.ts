import { describe, it, expect } from "vitest";
import { getToolCallLabel } from "./ai-tool-labels";

describe("getToolCallLabel", () => {
  it("returns a friendly label for known tool names", () => {
    expect(getToolCallLabel("lookup_case")).toBe("Looking up cases…");
    expect(getToolCallLabel("lookup_invoice")).toBe("Checking invoices…");
    expect(getToolCallLabel("financial_summary")).toBe("Crunching financials…");
  });

  it("falls back to the generic label for unmapped tool names", () => {
    expect(getToolCallLabel("some_unknown_tool")).toBe("Looking up…");
  });

  it("falls back to the generic label for null/undefined/empty", () => {
    expect(getToolCallLabel(null)).toBe("Looking up…");
    expect(getToolCallLabel(undefined)).toBe("Looking up…");
    expect(getToolCallLabel("")).toBe("Looking up…");
  });
});
