/**
 * Harness guard — every mocked hook in the shared mobile Vitest setup must
 * read its own seeded fixture and nothing else.
 *
 * Parallel merges have repeatedly spliced the doctor-directory fixture into
 * the paged-invoice, invoice-facet and statement-summary mocks. The damage is
 * type-silent: the finance screens simply render as if the API returned
 * nothing ("0 practices", "$0.00" totals), which reads as a product bug in
 * suites nowhere near the harness. These assertions fail the moment a mock
 * starts reading a fixture that belongs to another hook.
 */
import { renderHook } from "@testing-library/react-native";
import { afterEach, describe, expect, it } from "vitest";
import {
  useDoctorDirectory,
  useInvoiceFilterFacets,
  usePagedInvoices,
  useStatementAccountSummaries,
} from "@workspace/api-client-react";
import { resetMockAppState, setMockAppState } from "../../../vitest.setup";

const directoryEntry = {
  doctorName: "Dr Directory",
  practiceName: "Directory Dental",
  openCases: 3,
};

const accountSummary = {
  practiceId: "practice-1",
  practiceName: "Acme Dental",
  billingEmail: null,
  openInvoiceCount: 1,
  openInvoiceTotal: 100,
  unpaidStatements: [],
  totalOpenBalance: 100,
  overdueBalance: 0,
};

const invoice = (id: string, practiceId: string, practiceName: string) => ({
  id,
  invoiceNumber: id.toUpperCase(),
  status: "open",
  total: 100,
  balanceDue: 100,
  providerOrganizationId: practiceId,
  providerOrganization: { name: practiceName },
  displayMetadataJson: { billTo: `Dr ${practiceName}` },
});

afterEach(() => {
  resetMockAppState();
});

describe("shared mobile mocks read only their own fixture", () => {
  it("keeps invoice, facet and statement mocks empty when only the directory is seeded", async () => {
    setMockAppState({ doctorDirectory: [directoryEntry] });

    expect(
      (await renderHook(() => usePagedInvoices({ labOrganizationId: "lab-1" }))).result
        .current.data,
    ).toEqual([]);
    expect((await renderHook(() => useInvoiceFilterFacets())).result.current.data)
      .toEqual({ practices: [], doctors: [] });
    expect(
      (await renderHook(() => useStatementAccountSummaries("lab-1"))).result.current
        .data,
    ).toEqual([]);
    expect((await renderHook(() => useDoctorDirectory("lab-1"))).result.current.data)
      .toEqual([directoryEntry]);
  });

  it("keeps the directory mock empty when only invoices and statements are seeded", async () => {
    setMockAppState({
      invoices: [invoice("inv-1", "practice-1", "Acme")],
      statementAccountSummaries: [accountSummary],
    });

    expect((await renderHook(() => useDoctorDirectory("lab-1"))).result.current.data)
      .toEqual([]);
    expect(
      (await renderHook(() => useStatementAccountSummaries("lab-1"))).result.current
        .data,
    ).toEqual([accountSummary]);
  });

  it("feeds the invoice list and its facets from the seeded invoices", async () => {
    setMockAppState({
      invoices: [
        invoice("inv-1", "practice-1", "Acme"),
        invoice("inv-2", "practice-2", "Zenith"),
      ],
    });

    const rows = (await renderHook(() =>
      usePagedInvoices({ labOrganizationId: "lab-1" }),
    )).result.current.data;
    expect(rows?.map((row) => row.id)).toEqual(["inv-1", "inv-2"]);

    const facets = (await renderHook(() => useInvoiceFilterFacets())).result.current
      .data;
    expect(facets?.practices).toEqual([
      { id: "practice-1", name: "Acme" },
      { id: "practice-2", name: "Zenith" },
    ]);
    expect(facets?.doctors).toEqual(["Dr Acme", "Dr Zenith"]);
  });

  it("does not reorder the seeded invoice fixture when a page is sorted", async () => {
    const seeded = [
      invoice("inv-1", "practice-2", "Zenith"),
      invoice("inv-2", "practice-1", "Acme"),
    ];
    setMockAppState({ invoices: seeded });

    const sorted = (await renderHook(() =>
      usePagedInvoices({
        labOrganizationId: "lab-1",
        sortBy: "practice",
        sortDirection: "asc",
      } as Parameters<typeof usePagedInvoices>[0]),
    )).result.current.data;

    expect(sorted?.map((row) => row.id)).toEqual(["inv-2", "inv-1"]);
    expect(seeded.map((row) => row.id)).toEqual(["inv-1", "inv-2"]);
  });
});
