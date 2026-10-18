import { beforeEach, describe, expect, it, vi } from "vitest";

const { printAsync, resilientFetch } = vi.hoisted(() => ({
  printAsync: vi.fn(),
  resilientFetch: vi.fn(),
}));

vi.mock("expo-print", () => ({ printAsync }));
vi.mock("@/lib/query-client", () => ({ resilientFetch }));

import { printCaseLabel } from "@/lib/print-case-label";

beforeEach(() => {
  vi.clearAllMocks();
  printAsync.mockResolvedValue(undefined);
});

describe("printCaseLabel", () => {
  it("refetches the case and uses authoritative fields while preserving a barcode override", async () => {
    resilientFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          id: "case-1",
          caseNumber: "CURRENT-42",
          patientFirstName: "Current",
          patientLastName: "Patient",
          doctorName: "Dr. Current",
          casePanBarcode: "SERVER-BARCODE",
          status: "in_design",
        },
      }),
    });

    await printCaseLabel({
      id: "case-1",
      caseNumber: "STALE-1",
      patientFirstName: "Stale",
      patientLastName: "Patient",
    }, { barcode: "NEW-BARCODE" });

    expect(resilientFetch).toHaveBeenCalledWith("/api/cases/case-1");
    const [{ html }] = printAsync.mock.calls[0] as [{ html: string }];
    expect(html).toContain("CURRENT-42");
    expect(html).toContain("Current Patient");
    expect(html).not.toContain("STALE-1");
    expect(html).toContain("NEW-BARCODE");
    expect(html).not.toContain("SERVER-BARCODE");
  });
});