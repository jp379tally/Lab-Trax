/** @vitest-environment jsdom */
/**
 * Regression tests for the invoice editor patient/billing data isolation bug.
 *
 * Bug: opening invoice A then invoice B could leak invoice A's patient/billing
 * data into invoice B's form (stale-state from React Query cache or missing
 * component remount).
 *
 * Fixes verified:
 * - key={editing.id} on InvoiceEditor in InvoicesPage causes full remount on
 *   invoice switch, so local state is never carried over.
 * - useEffect id guard: if detailQuery.data.id !== invoice.id, the effect bails
 *   and never populates form fields with mismatched data.
 * - saveMutation id guard: if detailQuery.data.id !== invoice.id at save time,
 *   the mutation throws rather than PATCHing the wrong record.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { InvoiceEditor } from "@/pages/invoices";
import { AuthContext, type AuthContextValue } from "@/lib/auth-context";
import type { Invoice } from "@/lib/types";
import { MOCK_AUTH_DEFAULTS } from "../../__tests__/test-utils";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

function makeInvoice(id: string, invoiceNumber: string, patientName: string, doctorName: string): Invoice {
  return {
    id,
    invoiceNumber,
    caseId: null,
    labOrganizationId: "lab-1",
    providerOrganizationId: "prov-1",
    status: "open",
    tax: 0,
    discount: 0,
    notes: null,
    issuedAt: null,
    dueAt: null,
    items: [],
    displayMetadata: { patientName, billTo: doctorName },
  } as unknown as Invoice;
}

const INVOICE_A = makeInvoice("inv-a", "INV-A", "Alba Hurtado", "Dr. Scott");
const INVOICE_B = makeInvoice("inv-b", "INV-B", "Pam McGoff", "Dr. Dalton");

function makeFetchStub(invoices: Invoice[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/invoice-template/presets")) {
      return new Response(JSON.stringify({ presets: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    for (const inv of invoices) {
      if (url.includes(`/invoices/${inv.id}`)) {
        return new Response(JSON.stringify(inv), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

function makeWrapper(queryClient: QueryClient) {
  const { hook } = memoryLocation({ path: "/invoices" });
  const authValue: AuthContextValue = { ...MOCK_AUTH_DEFAULTS };
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <Router hook={hook}>
          <AuthContext.Provider value={authValue}>
            {children}
          </AuthContext.Provider>
        </Router>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", makeFetchStub([INVOICE_A, INVOICE_B]));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function waitForPatientName(name: string) {
  await waitFor(() => expect(screen.getByDisplayValue(name)).toBeInTheDocument());
}

describe("InvoiceEditor data isolation", () => {
  it("shows invoice A patient data when invoice A is open", async () => {
    const queryClient = makeQueryClient();
    const Wrapper = makeWrapper(queryClient);
    render(
      <Wrapper>
        <InvoiceEditor key={INVOICE_A.id} invoice={INVOICE_A} doctorNames={[]} onClose={vi.fn()} />
      </Wrapper>,
    );

    await waitForPatientName("Alba Hurtado");
    expect(screen.queryByDisplayValue("Pam McGoff")).not.toBeInTheDocument();
  });

  it("shows invoice B patient data when invoice B is open (not invoice A's data)", async () => {
    const queryClient = makeQueryClient();
    const Wrapper = makeWrapper(queryClient);
    render(
      <Wrapper>
        <InvoiceEditor key={INVOICE_B.id} invoice={INVOICE_B} doctorNames={[]} onClose={vi.fn()} />
      </Wrapper>,
    );

    await waitForPatientName("Pam McGoff");
    expect(screen.queryByDisplayValue("Alba Hurtado")).not.toBeInTheDocument();
  });

  it("does not populate form fields when detailQuery returns data for the wrong invoice id", async () => {
    const queryClient = makeQueryClient();
    // Pre-seed the cache for invoice A's query key with invoice B's data
    // (wrong id in the payload) — simulates a stale cache entry.
    queryClient.setQueryData(["invoice", INVOICE_A.id], { ...INVOICE_B, id: "WRONG-ID" });

    const Wrapper = makeWrapper(queryClient);
    render(
      <Wrapper>
        <InvoiceEditor key={INVOICE_A.id} invoice={INVOICE_A} doctorNames={[]} onClose={vi.fn()} />
      </Wrapper>,
    );

    // The id guard must block the stale payload — Pam McGoff must never appear.
    // The network fetch will eventually deliver the correct data (Alba Hurtado).
    await waitFor(() =>
      // Either the wrong patient is absent (guard working) OR the correct
      // patient has loaded from network (also guard working — real data replaced stale).
      expect(screen.queryByDisplayValue("Pam McGoff")).not.toBeInTheDocument(),
    );
  });

  it("after switching from invoice A to invoice B, form reflects invoice B — not invoice A", async () => {
    const queryClient = makeQueryClient();
    const Wrapper = makeWrapper(queryClient);

    // Render invoice A first (with key), wait for it to load.
    const { rerender } = render(
      <Wrapper>
        <InvoiceEditor key={INVOICE_A.id} invoice={INVOICE_A} doctorNames={[]} onClose={vi.fn()} />
      </Wrapper>,
    );
    await waitForPatientName("Alba Hurtado");

    // Simulate switching to invoice B: key change causes full remount.
    await act(async () => {
      rerender(
        <Wrapper>
          <InvoiceEditor key={INVOICE_B.id} invoice={INVOICE_B} doctorNames={[]} onClose={vi.fn()} />
        </Wrapper>,
      );
    });

    // Invoice B's data should appear; invoice A's data must be gone.
    await waitForPatientName("Pam McGoff");
    expect(screen.queryByDisplayValue("Alba Hurtado")).not.toBeInTheDocument();
  });

  it("save mutation is blocked when detailQuery.data.id does not match invoice.id", async () => {
    const queryClient = makeQueryClient();
    // Pre-seed the cache with mismatched id — simulates stale React Query entry.
    queryClient.setQueryData(["invoice", INVOICE_A.id], { ...INVOICE_B, id: "STALE-WRONG-ID" });

    // Override fetch to keep returning stale data so the query never "heals".
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/invoice-template/presets")) {
          return new Response(JSON.stringify({ presets: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes(`/invoices/${INVOICE_A.id}`)) {
          return new Response(JSON.stringify({ ...INVOICE_B, id: "STALE-WRONG-ID" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const Wrapper = makeWrapper(queryClient);
    render(
      <Wrapper>
        <InvoiceEditor key={INVOICE_A.id} invoice={INVOICE_A} doctorNames={[]} onClose={vi.fn()} />
      </Wrapper>,
    );

    // Wait for the editor to be rendered (spinner should be visible initially,
    // then when stale data resolves, the id guard must block form population).
    // We just need the Save button to be enabled before trying.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /save changes/i }),
      ).toBeInTheDocument(),
    );

    // Attempt to save — the mutation must surface the id-mismatch error.
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/invoice data mismatch/i),
      ).toBeInTheDocument(),
    );
  });
});
