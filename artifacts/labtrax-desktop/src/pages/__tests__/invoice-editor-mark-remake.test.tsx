/** @vitest-environment jsdom */
/**
 * Regression tests for the Invoice Editor's "Mark as remake" action.
 *
 * Pins three behaviors so a future refactor of invoices.tsx can't silently
 * hide or break the flow:
 * 1. Menu visibility rule — the "Mark as remake" item appears in the More
 *    menu only when the invoice's linked case exists and is NOT already a
 *    remake (no linked case → hidden; remakeOfCaseId set → hidden).
 * 2. Banner-vs-action gating — once the linked case has remakeOfCaseId set,
 *    the "This case is a remake" banner renders instead of the action.
 * 3. Submit wiring — filling the questionnaire and submitting sends
 *    PATCH /cases/:id/mark-as-remake with the buildRemakeLinkPayload shape,
 *    then invalidates the invoice/case queries (so the UI refreshes without
 *    a manual reload) and closes the modal.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { InvoiceEditor } from "@/pages/invoices";
import { AuthContext, type AuthContextValue } from "@/lib/auth-context";
import type { Invoice } from "@/lib/types";
import { MOCK_AUTH_DEFAULTS } from "../../__tests__/test-utils";
import {
  RemakeQuestionnaire,
  blankQuestionnaire,
  buildRemakeLinkPayload,
  isRemakeQuestionnaireComplete,
} from "@/components/remake-questionnaire";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

const CASE_ID = "case-1";
const ORIGINAL_HIT = {
  id: "case-orig",
  caseNumber: "26-100",
  patientFirstName: "Sam",
  patientLastName: "Rivera",
  doctorName: "Dr. Vega",
  status: "complete",
};

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv-1",
    invoiceNumber: "INV-26-200",
    caseId: CASE_ID,
    labOrganizationId: "lab-1",
    providerOrganizationId: "prov-1",
    status: "open",
    tax: 0,
    discount: 0,
    notes: null,
    issuedAt: null,
    dueAt: null,
    items: [],
    displayMetadata: { patientName: "Pat Doe", billTo: "Dr. Vega" },
    ...overrides,
  } as unknown as Invoice;
}

function makeLinkedCase(overrides: Record<string, unknown> = {}) {
  return {
    id: CASE_ID,
    caseNumber: "26-200",
    status: "in_progress",
    remakeOfCaseId: null,
    remakeReason: null,
    remakeCharged: null,
    restorations: [],
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Records every request; routes by most-specific-path-first. */
function makeFetchStub(opts: {
  invoice: Invoice;
  linkedCase: Record<string, unknown> | null;
}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url, method, body });

    if (url.includes("/invoice-template/presets")) return json({ presets: [] });
    if (url.includes(`/invoices/${opts.invoice.id}`)) return json(opts.invoice);
    if (url.includes("/cases/quick-search")) return json({ cases: [ORIGINAL_HIT] });
    if (url.includes("/cases/next-remake-suffix")) return json({ caseNumber: "26-100B" });
    if (url.includes(`/cases/${CASE_ID}/remake-chain`)) {
      return json({
        chain: [
          { id: "case-orig", caseNumber: "26-100", status: "complete", remakeReason: null, remakeCharged: null },
        ],
      });
    }
    if (url.includes(`/cases/${CASE_ID}/attachments`)) return json({ attachments: [] });
    if (url.includes(`/cases/${CASE_ID}/mark-as-remake`)) {
      return json({ caseId: CASE_ID, caseNumber: "26-100B" });
    }
    if (url.includes(`/cases/${CASE_ID}`)) {
      return opts.linkedCase ? json(opts.linkedCase) : json({ error: "not found" }, 404);
    }
    if (url.includes("/pricing/resolve-items")) return json({ items: [] });
    if (url.includes("/finance/vendors")) return json([]);
    if (url.includes("/organizations")) return json([]);
    return json([]);
  });
  return { stub, calls };
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
  const authValue: AuthContextValue = {
    ...MOCK_AUTH_DEFAULTS,
    status: "authed",
    user: { id: "u1", email: "admin@lab.test", name: "Admin", role: "admin" } as unknown as AuthContextValue["user"],
  };
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

function renderEditor(invoice: Invoice, queryClient = makeQueryClient()) {
  const Wrapper = makeWrapper(queryClient);
  render(
    <Wrapper>
      <InvoiceEditor key={invoice.id} invoice={invoice} doctorNames={[]} onClose={vi.fn()} />
    </Wrapper>,
  );
  return queryClient;
}

async function openMoreMenu() {
  const trigger = await screen.findByRole("button", { name: "More actions" });
  fireEvent.click(trigger);
  // Menu is open once a known always-present item renders.
  await screen.findByRole("button", { name: /preview pdf/i });
}

/** The remake-reason <select> lives in the modal's questionnaire; the invoice
 *  form has its own comboboxes, so match by the placeholder option. */
function getReasonSelect() {
  const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
  const found = selects.find((s) =>
    Array.from(s.options).some((o) => o.text.startsWith("Select a reason")),
  );
  if (!found) throw new Error("Remake reason select not found");
  return found;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Invoice Editor — Mark as remake", () => {
  it("supports a required trimmed custom Other reason and clears it when switching away", () => {
    const onChange = vi.fn();
    const q = { ...blankQuestionnaire(), reasonKey: "other" as const, customReason: "  Occlusal issue  " };
    expect(isRemakeQuestionnaireComplete({ ...q, charge: "yes" })).toBe(true);
    expect(buildRemakeLinkPayload(ORIGINAL_HIT, { ...q, charge: "yes" })).toMatchObject({
      remakeReasonKey: "other",
      remakeReason: "Occlusal issue",
      remakeCharged: true,
    });
    render(<RemakeQuestionnaire value={q} onChange={onChange} />);
    expect(screen.getByLabelText(/custom remake reason/i)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "fit_margins" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      reasonKey: "fit_margins",
      customReason: "",
    }));
  });

  describe("menu visibility rule", () => {
    it("shows the menu item when the linked case exists and is not a remake", async () => {
      const invoice = makeInvoice();
      vi.stubGlobal("fetch", makeFetchStub({ invoice, linkedCase: makeLinkedCase() }).stub);
      renderEditor(invoice);

      await openMoreMenu();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /mark as remake/i })).toBeInTheDocument(),
      );
      // Banner must NOT show for a non-remake case.
      expect(screen.queryByText(/this case is a remake/i)).not.toBeInTheDocument();
    });

    it("hides the menu item when the invoice has no linked case", async () => {
      const invoice = makeInvoice({ caseId: null } as Partial<Invoice>);
      vi.stubGlobal("fetch", makeFetchStub({ invoice, linkedCase: null }).stub);
      renderEditor(invoice);

      await openMoreMenu();
      // Give any pending queries a beat to settle, then assert absence.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /duplicate/i })).toBeInTheDocument(),
      );
      expect(screen.queryByRole("button", { name: /mark as remake/i })).not.toBeInTheDocument();
    });

    it("hides the menu item and shows the banner when the case is already a remake", async () => {
      const invoice = makeInvoice();
      vi.stubGlobal(
        "fetch",
        makeFetchStub({
          invoice,
          linkedCase: makeLinkedCase({
            remakeOfCaseId: "case-orig",
            remakeReason: "Shade was wrong",
            remakeCharged: false,
          }),
        }).stub,
      );
      renderEditor(invoice);

      // Banner replaces the action.
      await waitFor(() =>
        expect(screen.getByText(/this case is a remake/i)).toBeInTheDocument(),
      );
      // Original case number resolved from the remake-chain endpoint.
      await waitFor(() => expect(screen.getByText("26-100")).toBeInTheDocument());
      expect(screen.getByText(/no charge/i)).toBeInTheDocument();

      await openMoreMenu();
      expect(screen.queryByRole("button", { name: /mark as remake/i })).not.toBeInTheDocument();
    });
  });

  describe("submit wiring", () => {
    it("PATCHes mark-as-remake with the questionnaire payload, refreshes queries, and closes the modal", async () => {
      const invoice = makeInvoice();
      const { stub, calls } = makeFetchStub({ invoice, linkedCase: makeLinkedCase() });
      vi.stubGlobal("fetch", stub);
      const queryClient = makeQueryClient();
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
      renderEditor(invoice, queryClient);

      // Open the modal from the More menu.
      await openMoreMenu();
      const menuItem = await screen.findByRole("button", { name: /mark as remake/i });
      fireEvent.click(menuItem);
      await screen.findByPlaceholderText(/search by case/i);

      // Search for and pick the original case (280ms debounce in the picker).
      fireEvent.change(screen.getByPlaceholderText(/search by case/i), {
        target: { value: "26-100" },
      });
      const hit = await screen.findByText(/26-100 · Sam Rivera/i, undefined, { timeout: 3000 });
      fireEvent.click(hit);
      await screen.findByText(/remaking:/i);

      // Fill the required questionnaire fields: reason + charge.
      fireEvent.change(getReasonSelect(), { target: { value: "fit_margins" } });
      fireEvent.click(screen.getByRole("button", { name: /no — no-charge/i }));

      // Submit.
      const submit = screen.getByRole("button", { name: /^mark as remake$/i });
      expect(submit).toBeEnabled();
      fireEvent.click(submit);

      // The PATCH must hit the mark-as-remake endpoint with the payload shape
      // produced by buildRemakeLinkPayload.
      await waitFor(() => {
        const patch = calls.find(
          (c) => c.method === "PATCH" && c.url.includes(`/cases/${CASE_ID}/mark-as-remake`),
        );
        expect(patch).toBeTruthy();
        expect(patch!.body).toMatchObject({
          remakeOfCaseId: "case-orig",
          remakeReasonKey: "fit_margins",
          remakeReason: "Didn't fit — margins",
          remakeCharged: false,
          remakeCategory: "crown_bridge",
        });
      });

      // Post-submit refresh: the invoice + linked-case queries must be
      // invalidated so the editor/list update without a manual reload.
      await waitFor(() => {
        const keys = invalidateSpy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
        expect(keys).toContain(JSON.stringify(["invoice", invoice.id]));
        expect(keys).toContain(JSON.stringify(["invoices"]));
        expect(keys).toContain(JSON.stringify(["case-number-for-invoice", CASE_ID]));
        expect(keys).toContain(JSON.stringify(["case-remake-chain", CASE_ID]));
      });

      // Modal closes on success.
      await waitFor(() =>
        expect(screen.queryByText(/find the original case being remade/i)).not.toBeInTheDocument(),
      );
    });

    it("submit stays disabled until an original case, reason, and charge are all provided", async () => {
      const invoice = makeInvoice();
      vi.stubGlobal("fetch", makeFetchStub({ invoice, linkedCase: makeLinkedCase() }).stub);
      renderEditor(invoice);

      await openMoreMenu();
      fireEvent.click(await screen.findByRole("button", { name: /mark as remake/i }));
      await screen.findByPlaceholderText(/search by case/i);

      // No original selected yet — submit disabled.
      expect(screen.getByRole("button", { name: /^mark as remake$/i })).toBeDisabled();

      fireEvent.change(screen.getByPlaceholderText(/search by case/i), {
        target: { value: "26-100" },
      });
      fireEvent.click(await screen.findByText(/26-100 · Sam Rivera/i, undefined, { timeout: 3000 }));
      await screen.findByText(/remaking:/i);

      // Original picked but reason/charge missing — still disabled.
      expect(screen.getByRole("button", { name: /^mark as remake$/i })).toBeDisabled();

      fireEvent.change(getReasonSelect(), { target: { value: "fit_margins" } });
      expect(screen.getByRole("button", { name: /^mark as remake$/i })).toBeDisabled();

      fireEvent.click(screen.getByRole("button", { name: /no — no-charge/i }));
      expect(screen.getByRole("button", { name: /^mark as remake$/i })).toBeEnabled();
    });
  });
});
