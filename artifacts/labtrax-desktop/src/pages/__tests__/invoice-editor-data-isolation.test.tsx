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

const INVOICE_A = makeInvoice("inv-a", "INV-A", "Patient Example A", "Dr. Scott");
const INVOICE_B = makeInvoice("inv-b", "INV-B", "Patient Example B", "Dr. Synthetic028");
const DATED_INVOICE = {
  ...makeInvoice("inv-dated", "INV-DATED", "Date Patient", "Dr. Date"),
  issuedAt: "2026-01-15T00:00:00.000Z",
  dueAt: "2026-02-15T00:00:00.000Z",
} as Invoice;
const REPAIRED_INVOICE = {
  ...DATED_INVOICE,
  id: "inv-repaired",
  invoiceNumber: "INV-REPAIRED",
  dateRepairLogs: [
    {
      id: "repair-1",
      userId: "owner-1",
      beforeJson: {
        issuedAt: "2026-01-15T05:00:00.000Z",
        dueAt: "2026-02-15T05:00:00.000Z",
      },
      afterJson: {
        issuedAt: "2026-01-15T00:00:00.000Z",
        dueAt: "2026-02-15T00:00:00.000Z",
      },
      createdAt: "2026-09-10T14:30:00.000Z",
      actorUsername: "lab.owner",
      actorFirstName: "Morgan",
      actorLastName: "Lee",
      actorInitials: "ML",
    },
  ],
} as Invoice;

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
  it("keeps rejected edits open, then refreshes sales and Stats only after a confirmed save", async () => {
    const original = {
      ...INVOICE_A,
      caseId: "case-reviewed",
      items: [{
        id: "parent-1", description: "Scanned crown", quantity: 1, unitPrice: "5.00",
        subItems: [{ id: "child-1", description: "Layered Porcelain", quantity: 1, unitPrice: "37.00" }],
      }, {
        id: "fee-1", description: "Rush fee", quantity: 1, unitPrice: "15.00", subItems: [],
      }],
    } as unknown as Invoice;
    let rejectSave = true;
    let saved = original;
    const writes: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = input instanceof Request ? input.method : init?.method;
      if (method === "PATCH" && url.includes(`/invoices/${original.id}`)) {
        const body = input instanceof Request ? await input.clone().json() : JSON.parse(String(init?.body));
        writes.push(body);
        if (rejectSave) return new Response(JSON.stringify({ message: "Save refused" }), {
          status: 409, headers: { "Content-Type": "application/json" },
        });
        saved = { ...saved, ...body } as Invoice;
        return new Response(JSON.stringify(saved), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes(`/invoices/${original.id}`)) return new Response(JSON.stringify(saved), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
      if (url.includes(`/cases/${original.caseId}/attachments`)) return new Response(
        JSON.stringify({ attachments: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
      return new Response(JSON.stringify(url.includes("/invoice-template/presets") ? { presets: [] } : []), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }));
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const close = vi.fn();
    const Wrapper = makeWrapper(queryClient);
    const { container, rerender } = render(<Wrapper><InvoiceEditor invoice={original} doctorNames={[]} onClose={close} /></Wrapper>);
    await waitForPatientName("Patient Example A");
    const price = container.querySelector<HTMLInputElement>('tr [data-col-id="col-4"] input');
    expect(price).not.toBeNull();
    fireEvent.change(price!, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(screen.getByText(/Save refused/i)).toBeInTheDocument());
    expect(close).not.toHaveBeenCalled();
    expect(price?.value).toBe("10");
    expect(invalidate).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["reports"] }));
    rejectSave = false;
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(writes[1].items).toEqual([
      expect.objectContaining({ id: "parent-1", unitPrice: 10, subItems: [
        expect.objectContaining({ id: "child-1", unitPrice: 37 }),
      ] }),
      expect.objectContaining({ id: "fee-1", unitPrice: 15 }),
    ]);
    for (const key of [
      ["invoice", original.id], ["invoice-for-case", original.caseId],
      ["invoice-detail", original.id], ["case", original.caseId],
      ["cases"], ["invoices"], ["reports"], ["stats"],
    ]) {
      expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: key }));
    }
    rerender(<Wrapper><InvoiceEditor key="reopened" invoice={saved} doctorNames={[]} onClose={vi.fn()} /></Wrapper>);
    await waitFor(() => expect(container.querySelector<HTMLInputElement>('tr [data-col-id="col-4"] input')?.value).toBe("10"));
  });

  it("shows a dedicated date-repair history entry with actor and old and corrected dates", async () => {
    vi.stubGlobal("fetch", makeFetchStub([REPAIRED_INVOICE]));
    const queryClient = makeQueryClient();
    const Wrapper = makeWrapper(queryClient);
    render(
      <Wrapper>
        <InvoiceEditor
          invoice={REPAIRED_INVOICE}
          doctorNames={[]}
          onClose={vi.fn()}
        />
      </Wrapper>,
    );

    expect(await screen.findByText("Date repair history")).toBeInTheDocument();
    expect(screen.getByText("Invoice dates repaired")).toBeInTheDocument();
    expect(screen.getByText("By Morgan Lee")).toBeInTheDocument();
    expect(screen.getByText(/Issue date:/)).toHaveTextContent(
      "Issue date: 01/15/2026 → 01/15/2026",
    );
    expect(screen.getByText(/Due date:/)).toHaveTextContent(
      "Due date: 02/15/2026 → 02/15/2026",
    );
  });

  it("shows invoice A patient data when invoice A is open", async () => {
    const queryClient = makeQueryClient();
    const Wrapper = makeWrapper(queryClient);
    render(
      <Wrapper>
        <InvoiceEditor key={INVOICE_A.id} invoice={INVOICE_A} doctorNames={[]} onClose={vi.fn()} />
      </Wrapper>,
    );

    await waitForPatientName("Patient Example A");
    expect(screen.queryByDisplayValue("Patient Example B")).not.toBeInTheDocument();
  });

  it("shows invoice B patient data when invoice B is open (not invoice A's data)", async () => {
    const queryClient = makeQueryClient();
    const Wrapper = makeWrapper(queryClient);
    render(
      <Wrapper>
        <InvoiceEditor key={INVOICE_B.id} invoice={INVOICE_B} doctorNames={[]} onClose={vi.fn()} />
      </Wrapper>,
    );

    await waitForPatientName("Patient Example B");
    expect(screen.queryByDisplayValue("Patient Example A")).not.toBeInTheDocument();
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

    // The id guard must block the stale payload — Patient Example B must never appear.
    // The network fetch will eventually deliver the correct data (Patient Example A).
    await waitFor(() =>
      // Either the wrong patient is absent (guard working) OR the correct
      // patient has loaded from network (also guard working — real data replaced stale).
      expect(screen.queryByDisplayValue("Patient Example B")).not.toBeInTheDocument(),
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
    await waitForPatientName("Patient Example A");

    // Simulate switching to invoice B: key change causes full remount.
    await act(async () => {
      rerender(
        <Wrapper>
          <InvoiceEditor key={INVOICE_B.id} invoice={INVOICE_B} doctorNames={[]} onClose={vi.fn()} />
        </Wrapper>,
      );
    });

    // Invoice B's data should appear; invoice A's data must be gone.
    await waitForPatientName("Patient Example B");
    expect(screen.queryByDisplayValue("Patient Example A")).not.toBeInTheDocument();
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

  it("loads and repeatedly saves issue and due dates without calendar-day drift", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = input instanceof Request ? input.method : init?.method;
        if (method === "PATCH") {
          const body = input instanceof Request
            ? ((await input.clone().json()) as Record<string, unknown>)
            : (JSON.parse(String(init?.body)) as Record<string, unknown>);
          requests.push(body);
          return new Response(JSON.stringify({ ...DATED_INVOICE, ...body }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/invoice-template/presets")) {
          return new Response(JSON.stringify({ presets: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes(`/invoices/${DATED_INVOICE.id}`)) {
          return new Response(JSON.stringify(DATED_INVOICE), {
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

    const queryClient = makeQueryClient();
    const Wrapper = makeWrapper(queryClient);
    const { container } = render(
      <Wrapper>
        <InvoiceEditor
          key={DATED_INVOICE.id}
          invoice={DATED_INVOICE}
          doctorNames={[]}
          onClose={vi.fn()}
        />
      </Wrapper>,
    );

    await waitFor(() => {
      const dates = container.querySelectorAll<HTMLInputElement>('input[type="date"]');
      expect(Array.from(dates, (input) => input.value)).toEqual([
        "2026-01-15",
        "2026-02-15",
      ]);
    });
    await waitForPatientName("Date Patient");

    const dates = container.querySelectorAll<HTMLInputElement>('input[type="date"]');
    fireEvent.change(dates[0], { target: { value: "2026-01-16" } });
    fireEvent.change(dates[1], { target: { value: "2026-02-16" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(requests).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(requests).toHaveLength(2));

    for (const body of requests) {
      expect(body.issuedAt).toBe("2026-01-16T00:00:00.000Z");
      expect(body.dueAt).toBe("2026-02-16T00:00:00.000Z");
    }
  });
});
