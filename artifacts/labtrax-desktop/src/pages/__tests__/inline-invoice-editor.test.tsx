/** @vitest-environment jsdom */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { InlineInvoiceEditor } from "@/pages/invoices";
import { CaseDrawer } from "@/pages/cases";
import { SalesInvoicesPanel } from "@/components/reports/SalesInvoicesPanel";
import { AiPanelContext } from "@/lib/ai-panel-context";
import { guardNavigation, registerNavBlocker } from "@/lib/nav-guard";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import type { Invoice, LabCase } from "@/lib/types";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({ Document: () => null, Page: () => null, pdfjs: { GlobalWorkerOptions: {} } }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));
vi.mock("@/lib/export", async (original) => ({ ...await original<object>(), printInvoicePdf: vi.fn() }));

const original = {
  id: "inline-invoice", invoiceNumber: "INV-INLINE", labOrganizationId: "lab-1",
  providerOrganizationId: "practice-1", status: "open", caseId: null,
  issuedAt: "2026-09-01T00:00:00.000Z", dueAt: "2026-09-15T00:00:00.000Z",
  createdAt: "2026-09-01T12:00:00.000Z", tax: 0, discount: 0, total: 110, balanceDue: 110,
  notes: "Saved note", payments: [], layoutPresetId: null,
  displayMetadata: { patientName: "Jane Doe", billTo: "Dr. Synthetic063", retainedMetadata: "keep",
    lineItems: [{ item: "Crown", catalogItemKey: "crown", customLineFlag: "retain", subItems: [{ item: "Alloy", customChildFlag: "retain" }] }] },
  items: [{ id: "parent", description: "Crown", quantity: 1, unitPrice: 100, lineTotal: 100,
    toothLabel: "Upper", subItems: [{ id: "child", description: "Alloy", quantity: 1, unitPrice: 10, lineTotal: 10, toothLabel: "Lower" }] }],
} as unknown as Invoice;
let confirmed: Invoice;
let failSave: boolean;
let failReload: boolean;
let holdSave: (() => void) | undefined;
let requests: Array<{ url: string; method: string; body?: Record<string, any> }>;
let qc: QueryClient;
function QueryProbe() { qc = useQueryClient(); return null; }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  confirmed = structuredClone(original);
  failSave = false;
  failReload = false;
  holdSave = undefined;
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    if (url.includes("/invoices/reports/sales-invoices?")) {
      const params = new URL(url, "http://localhost").searchParams;
      const issueTime = new Date(confirmed.issuedAt ?? confirmed.createdAt ?? "").getTime();
      const from = new Date(params.get("dateFrom") ?? "").getTime();
      const to = new Date(params.get("dateTo") ?? "").getTime();
      const rows = issueTime >= from && issueTime <= to ? [{
        id: confirmed.id,
        invoiceNumber: confirmed.invoiceNumber,
        issuedAt: confirmed.issuedAt ?? confirmed.createdAt,
        total: Number(confirmed.total).toFixed(2),
        status: confirmed.status,
        practiceName: "Practice One",
        doctorName: "Dr. Synthetic063",
      }] : [];
      return json({
        data: {
          rows,
          total: rows.length,
          billedTotal: rows.reduce((sum, row) => sum + Number(row.total), 0).toFixed(2),
          offset: 0,
          hasMore: false,
        },
      });
    }
    if (url.endsWith(`/invoices/${confirmed.id}`)) {
      if (method === "PATCH") {
        if (holdSave) await new Promise<void>((resolve) => { holdSave = resolve; });
        if (failSave) return json({ error: "Discount lines cannot reduce the total below the amount already paid." }, 409);
        const subtotal = body.items.reduce((sum: number, line: any) =>
          sum + Number(line.quantity) * Number(line.unitPrice) +
          (line.subItems ?? []).reduce((subSum: number, sub: any) =>
            subSum + Number(sub.quantity) * Number(sub.unitPrice), 0), 0);
        const total = subtotal + Number(body.tax ?? confirmed.tax ?? 0) -
          Number(body.discount ?? confirmed.discount ?? 0) -
          Number(body.displayMetadata?.credits ?? 0);
        const paid = (confirmed.payments ?? []).reduce(
          (sum, payment) => sum + Number(payment.amount), 0,
        );
        confirmed = { ...confirmed, ...body, displayMetadata: body.displayMetadata,
          subtotal: subtotal.toFixed(2), total: total.toFixed(2),
          balanceDue: (body.status === "void" ? 0 : total - paid).toFixed(2),
          items: body.items.map((line: any, i: number) => ({
            ...line, id: line.id ?? `new-${i}`,
            subItems: line.subItems.map((sub: any, j: number) => ({ ...sub, id: sub.id ?? `new-${i}-${j}` })),
          })) };
        // The actual PATCH endpoint returns only a header, not detail items.
        return json({ ...confirmed, items: undefined });
      }
      if (failReload && patches().length > 0) return json({ error: "Could not reload invoice" }, 503);
      return json(confirmed);
    }
    if (url.includes("/invoices?caseId=")) return json([confirmed]);
    if (url.includes("/invoice-template/presets")) return json({ presets: [{ id: "preset-1", name: "Compact layout" }] });
    if (url.includes("/organizations?")) return json([
      { id: "practice-1", name: "Practice One", type: "practice", parentLabOrganizationId: "lab-1" },
      { id: "practice-2", name: "Practice Two", type: "practice", parentLabOrganizationId: "lab-1" },
    ]);
    if (url.includes("/pricing/")) return json({ items: [] });
    if (url.includes("/attachments")) return json({ attachments: [] });
    if (url.includes("/cases/case-1")) return json(fakeCase);
    return json([]);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const fakeCase = { id: "case-1", caseNumber: "26-1", patientFirstName: "Jane", patientLastName: "Doe",
  doctorName: "Dr. Synthetic063", status: "received", priority: "normal", totalPrice: "110",
  restorations: [], notes: [], events: [], attachments: [],
} as unknown as LabCase;

function setup(role = "billing", invoice = original) {
  const onClose = vi.fn();
  const onOpenEditor = vi.fn();
  const Wrapper = makeAuthWrapper("/cases", { user: { id: "user-1", role } as any, status: "authed" });
  const view = render(<Wrapper><QueryProbe /><InlineInvoiceEditor invoice={invoice} doctorNames={["Dr. Synthetic063", "Dr. Synthetic047"]} onClose={onClose} onOpenEditor={onOpenEditor} /></Wrapper>);
  return { ...view, Wrapper, onClose, onOpenEditor };
}
async function loaded() { await screen.findByDisplayValue("Jane Doe"); }
function patches() { return requests.filter((request) => request.method === "PATCH"); }
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
async function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(patches()).toHaveLength(1));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
}

describe("shared inline invoice workflow", () => {
  it("keeps a non-midnight invoice in its original local sales day after an amount edit", async () => {
    confirmed = {
      ...structuredClone(original),
      issuedAt: "2026-03-10T05:30:00.000Z",
      createdAt: "2026-10-20T00:03:00.000Z",
    } as Invoice;
    const Wrapper = makeAuthWrapper("/reports", {
      user: { id: "user-1", role: "billing" } as any,
      status: "authed",
    });
    render(
      <Wrapper>
        <QueryProbe />
        <SalesInvoicesPanel
          organizationId="lab-1"
          dateFrom="2026-03-10T04:00:00.000Z"
          dateTo="2026-03-11T03:59:59.999Z"
        />
        <InlineInvoiceEditor
          invoice={confirmed}
          doctorNames={["Dr. Synthetic063"]}
          onClose={vi.fn()}
          onOpenEditor={vi.fn()}
        />
      </Wrapper>,
    );
    await loaded();
    const salesRow = await screen.findByTestId("sales-invoice-row");
    expect(within(salesRow).getByText("$110.00")).toBeInTheDocument();

    change("Unit price", "150");
    await save();

    expect(patches()[0].body).not.toHaveProperty("issuedAt");
    expect(patches()[0].body).not.toHaveProperty("dueAt");
    expect(confirmed.issuedAt).toBe("2026-03-10T05:30:00.000Z");
    expect(Number(confirmed.total)).toBe(160);
    await waitFor(() => {
      expect(within(screen.getByTestId("sales-invoice-row")).getByText("$160.00"))
        .toBeInTheDocument();
    });
  });

  it("shows the legacy ownership warning and clears it only after an explicit successful save", async () => {
    confirmed.displayMetadata = {
      ...confirmed.displayMetadata,
      legacyChargesNeedsReview: true,
      reviewedCharges: true,
      reviewedChargesNeedsReview: true,
    } as Invoice["displayMetadata"];
    setup();
    await loaded();
    expect(await screen.findByRole("alert")).toHaveTextContent("missing ownership information");
    expect(patches()).toHaveLength(0);
    failSave = true;
    await save();
    expect(screen.getByText(/Charges and totals have been left unchanged/)).toBeInTheDocument();
    failSave = false;
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText(/Charges and totals have been left unchanged/)).not.toBeInTheDocument());
    expect(patches()[1]).toMatchObject({
      body: { displayMetadata: { legacyChargesNeedsReview: false } },
    });
  });
  it("persists the complete header, adjustments, child fields, metadata and stable IDs without closing", async () => {
    const { onClose } = setup();
    await loaded();
    await screen.findByRole("option", { name: "Practice Two" });
    change("Invoice number", "INV-CORRECTED");
    change("Client / Provider", "practice-2");
    fireEvent.click(screen.getByRole("button", { name: "Reassign" }));
    change("Issued", "2026-09-03");
    change("Due", "2026-09-20");
    change("Patient name", "Corrected patient");
    change("Teeth", "8, 9"); change("Shade", "A2"); change("Material", "Zirconia");
    change("Case notes", "Review Rx");
    change("Credits", "2"); change("Tax", "5"); change("Invoice discount", "3");
    change("Notes", "Corrected note");
    change("Layout preset", "preset-1");
    change("Description for line 1", "Reviewed crown");
    change("Quantity for line 1", "2");
    change("Tooth for sub-item 1.1", "Upper left");
    change("Description for sub-item 1.1", "Reviewed alloy");
    change("Unit price for sub-item 1.1", "15");
    await save();
    expect(onClose).not.toHaveBeenCalled();
    expect(patches()[0].body).toMatchObject({
      invoiceNumber: "INV-CORRECTED", providerOrganizationId: "practice-2", tax: 5, discount: 3, notes: "Corrected note",
      layoutPresetId: "preset-1", issuedAt: expect.stringContaining("2026-09-03"), dueAt: expect.stringContaining("2026-09-20"),
      displayMetadata: { retainedMetadata: "keep", reviewedCharges: true, reviewedChargesNeedsReview: false, credits: 2, patientName: "Corrected patient", teeth: "8, 9", shade: "A2", material: "Zirconia", caseNotes: "Review Rx",
        lineItems: [{ catalogItemKey: "crown", customLineFlag: "retain", subItems: [{ customChildFlag: "retain" }] }] },
      items: [{ id: "parent", quantity: 2, description: "Reviewed crown", subItems: [{ id: "child", toothLabel: "Upper left", description: "Reviewed alloy", unitPrice: 15 }] }],
    });
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  it("deletes children and parents in the draft only, Cancel restores both, and empty invoices can add lines", async () => {
    setup(); await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Remove sub-item 1.1" }));
    expect(screen.queryByDisplayValue("Alloy")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByLabelText("Description for sub-item 1.1");
    fireEvent.click(screen.getByRole("button", { name: "Remove line 1" }));
    expect(screen.queryByLabelText("Description for sub-item 1.1")).not.toBeInTheDocument();
    expect(patches()).toHaveLength(0);
    await save();
    expect(patches()[0].body!.items).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /Add line/ }));
    fireEvent.click(screen.getByText("One-off line item"));
    change("Description for line 1", "New manual charge");
    change("Unit price", "20");
    expect(screen.getByRole("button", { name: "Remove line 1" })).toBeEnabled();
  });

  it("reloads newly persisted line IDs before the next save", async () => {
    confirmed = { ...confirmed, items: [] };
    setup(); await loaded();
    fireEvent.click(screen.getByRole("button", { name: /Add line/ }));
    fireEvent.click(screen.getByText("One-off line item"));
    change("Description for line 1", "New charge"); change("Unit price", "25");
    await save();
    change("Description for line 1", "Revised charge");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1].body!.items[0].id).toBe("new-0");
  });

  it("keeps dirty drafts across background refreshes and Cancel restores the latest confirmed values", async () => {
    setup(); await loaded(); change("Invoice number", "LOCAL-DRAFT");
    confirmed = { ...confirmed, invoiceNumber: "SERVER-CHANGED" };
    await act(async () => { await qc.invalidateQueries({ queryKey: ["invoice", original.id] }); });
    expect(screen.getByLabelText("Invoice number")).toHaveValue("LOCAL-DRAFT");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByLabelText("Invoice number")).toHaveValue("SERVER-CHANGED"));
  });

  it("resolves route navigation and editor switching without silently discarding edits", async () => {
    const { onOpenEditor } = setup(); await loaded(); change("Invoice number", "DRAFT");
    const proceed = vi.fn();
    act(() => { expect(guardNavigation(proceed)).toBe(true); });
    expect(proceed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Keep editing"));
    fireEvent.click(screen.getByText("Open in editor"));
    expect(onOpenEditor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Discard changes"));
    expect(onOpenEditor).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByLabelText("Invoice number")).toHaveValue("INV-INLINE"));
  });

  it("never prints unsaved financial changes", async () => {
    const { printInvoicePdf } = await import("@/lib/export");
    vi.mocked(printInvoicePdf).mockClear();
    setup(); await loaded(); change("Invoice number", "DRAFT");
    fireEvent.click(screen.getByText("Print", { exact: true }));
    expect(printInvoicePdf).not.toHaveBeenCalled();
    expect(screen.getByText(/Save or cancel your changes before printing/)).toBeInTheDocument();
  });

  it("keeps refused edits unsaved and does not refresh financial views on refusal", async () => {
    setup(); await loaded();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    failSave = true;
    change("Invoice number", "DRAFT");
    fireEvent.click(screen.getByText("Save changes"));
    await screen.findByText(/Discount lines cannot reduce/);
    expect(screen.getByLabelText("Invoice number")).toHaveValue("DRAFT");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(invalidate).not.toHaveBeenCalled();
    expect(screen.getByText("Save changes")).toBeEnabled();
  });

  it("prevents duplicate submissions and navigation while saving, then refreshes finance views", async () => {
    setup(); await loaded();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    holdSave = () => {};
    change("Invoice number", "CORRECTED");
    fireEvent.click(screen.getByText("Save changes"));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(screen.getByText("Saving…")).toBeDisabled();
    const proceed = vi.fn();
    act(() => { guardNavigation(proceed); });
    expect(proceed).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(patches()).toHaveLength(1);
    await act(async () => { holdSave!(); });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["reports"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["invoice-detail", original.id] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["statements"] });
  });

  it("does not offer a duplicate save when the write commits but detail reload fails", async () => {
    setup(); await loaded();
    failReload = true;
    change("Invoice number", "COMMITTED");
    fireEvent.click(screen.getByText("Save changes"));
    await screen.findByText(/Invoice saved, but confirmed data could not be reloaded/);
    expect(patches()).toHaveLength(1);
    expect(screen.getByText("Save changes")).toBeDisabled();
    expect(screen.getByText("Open in editor")).toBeDisabled();
    failReload = false;
    fireEvent.click(screen.getByText("Retry loading confirmed invoice"));
    await waitFor(() => expect(screen.getByText("Save changes")).toBeEnabled());
    expect(screen.getByLabelText("Invoice number")).toHaveValue("COMMITTED");
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(patches()).toHaveLength(1);
  });

  it("isolates draft state when the invoice identity changes", async () => {
    const { rerender, Wrapper, onClose, onOpenEditor } = setup();
    await loaded(); change("Invoice number", "DRAFT-A");
    confirmed = { ...confirmed, id: "invoice-b", invoiceNumber: "INV-B", displayMetadata: { patientName: "Patient B" } };
    rerender(<Wrapper><InlineInvoiceEditor invoice={confirmed} onClose={onClose} onOpenEditor={onOpenEditor} /></Wrapper>);
    await screen.findByDisplayValue("Patient B");
    expect(screen.getByLabelText("Invoice number")).toHaveValue("INV-B");
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  it.each([{ role: "technician", frozen: false }, { role: "billing", frozen: true }, { role: "billing", frozen: true, status: "recovery_draft" }])("protects non-billing and frozen/recovery invoices: %o", async ({ role, frozen, status }) => {
    confirmed = { ...confirmed, frozen, ...(status ? { status } : {}) } as Invoice;
    setup(role, confirmed); await loaded();
    expect(screen.getByLabelText("Invoice number")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove line 1" })).toBeDisabled();
    if (role === "technician") expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
    else expect(screen.getByText("Save changes")).toBeDisabled();
    expect(screen.getByText("Open in editor")).toBeEnabled();
  });

  it("reuses paid-to-open and open-to-paid payment status prompts", async () => {
    confirmed = { ...confirmed, status: "paid", payments: [{ id: "p1", amount: 110 }] } as unknown as Invoice;
    setup("billing", confirmed); await loaded();
    change("Status", "open"); fireEvent.click(screen.getByText("Save changes"));
    await screen.findByText("This invoice has a recorded payment");
    expect(patches()).toHaveLength(0);
  });

  it("offers the existing record-payment prompt before marking an invoice paid", async () => {
    setup(); await loaded();
    change("Status", "paid"); fireEvent.click(screen.getByText("Save changes"));
    await screen.findByText("Record a payment?");
    expect(patches()).toHaveLength(0);
  });

  it("preserves protected legacy dates and exposes the same separate repair action", async () => {
    confirmed = { ...confirmed, issuedAt: "2026-09-01T07:00:00.000Z", dueAt: "2026-09-15T07:00:00.000Z" };
    setup("admin", confirmed); await loaded();
    expect(screen.getByLabelText("Issued")).toBeDisabled();
    expect(screen.getByLabelText("Due")).toBeDisabled();
    expect(screen.getByText("Review possible date shift")).toBeEnabled();
    change("Notes", "Corrected note");
    expect(screen.getByText("Review possible date shift")).toBeDisabled();
    await save();
    expect(patches()[0].body).not.toHaveProperty("issuedAt");
    expect(patches()[0].body).not.toHaveProperty("dueAt");
  });

  it("counts clearing a zero price as a dirty, invalid draft", async () => {
    confirmed.items![0].unitPrice = "0";
    setup(); await loaded();
    change("Unit price", "");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Save changes"));
    await screen.findByText(/Each line item needs a valid price/);
    expect(patches()).toHaveLength(0);
  });
});

describe("case tab integration", () => {
  it("guards tab changes and closing, opens the full editor after resolution and keeps the drawer after saving", async () => {
    confirmed = { ...confirmed, caseId: "case-1" };
    const onClose = vi.fn();
    const Wrapper = makeAuthWrapper("/cases", { user: { id: "u1", role: "billing" } as any, status: "authed" });
    render(<Wrapper><AiPanelContext.Provider value={{ openPanel: () => {} }}><CaseDrawer labCase={fakeCase} onClose={onClose} docked /></AiPanelContext.Provider></Wrapper>);
    const invoiceTab = screen.getByRole("tab", { name: "Invoice" });
    fireEvent.click(invoiceTab);
    await loaded();
    change("Invoice number", "DRAWER-DRAFT");
    invoiceTab.focus();
    fireEvent.keyDown(invoiceTab, { key: "ArrowRight" });
    const discardDialog = await screen.findByRole("alertdialog", { name: "Discard changes?" });
    expect(discardDialog).toHaveAttribute("aria-modal", "true");
    expect(discardDialog).toHaveAccessibleDescription(
      "You have unsaved edits to this invoice. If you leave now, your changes will be lost.",
    );
    expect(screen.getByRole("tab", { name: "Invoice" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button", { name: "Keep editing" }), { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Discard changes" })).toHaveFocus();
    fireEvent.click(screen.getByText("Keep editing"));
    expect(invoiceTab).toHaveFocus();
    expect(screen.getByLabelText("Invoice number")).toHaveValue("DRAWER-DRAFT");
    invoiceTab.focus();
    fireEvent.keyDown(invoiceTab, { key: "ArrowRight" });
    await screen.findByRole("alertdialog", { name: "Discard changes?" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(invoiceTab).toHaveFocus();
    expect(screen.getByLabelText("Invoice number")).toHaveValue("DRAWER-DRAFT");
    fireEvent.keyDown(invoiceTab, { key: "ArrowRight" });
    await screen.findByRole("alertdialog", { name: "Discard changes?" });
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    const historyTab = screen.getByRole("tab", { name: /History/ });
    await waitFor(() => expect(historyTab).toHaveAttribute("aria-selected", "true"));
    expect(historyTab).toHaveFocus();
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", historyTab.id);
    fireEvent.click(screen.getByRole("tab", { name: "Invoice" }));
    await loaded();
    change("Invoice number", "DRAWER-SAVED");
    fireEvent.click(screen.getByText("Save changes"));
    await waitFor(() => expect(patches()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument());
    expect(screen.getByTestId("case-drawer")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Open in editor"));
    await screen.findByLabelText("Close without saving");
    expect(screen.getByLabelText("Invoice number")).toHaveValue("DRAWER-SAVED");
  });

  it("prints confirmed read-only invoices with child lines and invoice adjustments", async () => {
    confirmed = { ...confirmed, tax: 5, discount: 10, displayMetadata: { ...confirmed.displayMetadata, credits: 3 } };
    const Wrapper = makeAuthWrapper("/cases", { user: { id: "reader", role: "technician" } as any, status: "authed" });
    render(<Wrapper><AiPanelContext.Provider value={{ openPanel: () => {} }}><CaseDrawer labCase={fakeCase} onClose={vi.fn()} /></AiPanelContext.Provider></Wrapper>);
    fireEvent.click(screen.getByRole("tab", { name: "Invoice" }));
    await screen.findByText("Open in editor");
    const print = screen.getByRole("button", { name: "Print" });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);
    const { printInvoicePdf } = await import("@/lib/export");
    expect(printInvoicePdf).toHaveBeenLastCalledWith(expect.objectContaining({
      tax: 5, discount: 10, credits: 3,
      items: [expect.objectContaining({ subItems: [expect.objectContaining({ description: "Alloy", unitPrice: 10 })] })],
    }));
  });

  it("retains a read-only invoice card for non-billing case users", async () => {
    const Wrapper = makeAuthWrapper("/cases", { user: { id: "u1", role: "technician" } as any, status: "authed" });
    render(<Wrapper><AiPanelContext.Provider value={{ openPanel: () => {} }}><CaseDrawer labCase={fakeCase} onClose={vi.fn()} /></AiPanelContext.Provider></Wrapper>);
    fireEvent.click(screen.getByRole("tab", { name: "Invoice" }));
    await screen.findByText("Open in editor");
    expect(screen.queryByLabelText("Invoice number")).not.toBeInTheDocument();
    expect(screen.getByText("Print", { exact: true })).toBeInTheDocument();
  });

  it("releases only its own navigation blocker and resolves every dirty surface", () => {
    const parent = vi.fn((next: () => void) => next());
    const child = vi.fn((next: () => void) => next());
    const unregisterParent = registerNavBlocker(parent);
    const unregisterChild = registerNavBlocker(child);
    const proceed = vi.fn();
    expect(guardNavigation(proceed)).toBe(true);
    expect(parent).toHaveBeenCalledOnce();
    expect(child).toHaveBeenCalledOnce();
    expect(proceed).toHaveBeenCalledOnce();
    unregisterChild();
    guardNavigation(proceed);
    expect(parent).toHaveBeenCalledTimes(2);
    expect(child).toHaveBeenCalledOnce();
    unregisterParent();
  });
});
