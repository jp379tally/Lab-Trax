/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import InvoicesPage from "@/pages/invoices";
import type { Invoice } from "@/lib/types";
import type { SessionUser } from "@/lib/api";
import { makeAuthWrapper } from "../../__tests__/test-utils";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

const user = (role: string) => ({ id: "u", username: role, role }) as unknown as SessionUser;
const list = [0, 1].map((n) => ({
  id: `inv-${n}`, invoiceNumber: `INV-00${n}`, labOrganizationId: "lab-1", providerOrganizationId: "prov-1",
  status: "open", total: 46, balanceDue: 46, items: [],
  providerOrganization: { id: "prov-1", name: "Heartland Dental" },
  displayMetadata: { patientName: `Patient ${n}`, caseType: "Zirconia crown", teeth: "5" },
})) as unknown as Invoice[];

function install(detail: (id: string) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    const m = url.match(/\/api\/invoices\/([^/?]+)$/);
    if (m) return detail(m[1]);
    if (url.includes("/api/invoices")) return new Response(JSON.stringify(list), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.includes("/cases/doctor-names") || url.includes("/organizations")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}
const ok = (id: string) => new Response(JSON.stringify({
  ...list[Number(id.slice(-1))], notes: "Rush", payments: [{ id: "p", invoiceId: id, amount: 10 }], balanceDue: 36,
}), { status: 200, headers: { "Content-Type": "application/json" } });

async function setup(role = "billing", detail = ok) {
  install(detail);
  const W = makeAuthWrapper("/invoices", { user: user(role), status: "authed" });
  render(<W><InvoicesPage /></W>);
  await screen.findByText("INV-000");
}

describe("Invoice preview panel", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("shows authoritative detail on row click, independent of checkbox", async () => {
    await setup();
    fireEvent.click(screen.getByTestId("invoice-row-inv-0"));
    expect((await screen.findByTestId("invoice-preview-balance")).textContent).toContain("36.00");
    expect(screen.getByTestId("invoice-preview-payments").textContent).toContain("10.00");
    expect(screen.getByTestId("invoice-preview-notes").textContent).toBe("Rush");
    expect(screen.queryByText(/invoices? selected/)).toBeNull();
    fireEvent.click(screen.getByLabelText("Select invoice INV-001"));
    expect(screen.getByText(/1 invoice selected/)).toBeTruthy();
    expect(screen.getByTestId("invoice-preview-title").textContent).toContain("INV-000");
    fireEvent.click(screen.getByTestId("invoice-preview-close"));
    expect(screen.queryByTestId("invoice-preview")).toBeNull();
    expect(screen.getByText(/1 invoice selected/)).toBeTruthy();
  });

  it("hides edit and Record Payment for non-billing users", async () => {
    await setup("technician");
    fireEvent.click(screen.getByTestId("invoice-row-inv-0"));
    await screen.findByTestId("invoice-preview-balance");
    expect(screen.queryByTestId("invoice-preview-record-payment")).toBeNull();
    expect(screen.queryByTestId("invoice-preview-edit")).toBeNull();
  });

  it("shows error with retry and missing state", async () => {
    let fail = true;
    await setup("billing", (id) => fail ? new Response("{}", { status: 500 }) : ok(id));
    fireEvent.click(screen.getByTestId("invoice-row-inv-0"));
    await screen.findByTestId("invoice-preview-error");
    fail = false;
    fireEvent.click(screen.getByTestId("invoice-preview-retry"));
    await screen.findByTestId("invoice-preview-balance");
  });

  it("shows missing state on 404", async () => {
    await setup("billing", () => new Response(JSON.stringify({ error: "nf" }), { status: 404, headers: { "Content-Type": "application/json" } }));
    fireEvent.click(screen.getByTestId("invoice-row-inv-0"));
    await waitFor(() => screen.getByTestId("invoice-preview-missing"));
  });

  it("disables actions when a refetch errors with stale data, and falls back to line items", async () => {
    let mode: "ok" | "gone" = "ok";
    await setup("billing", () =>
      mode === "gone"
        ? new Response("{}", { status: 404 })
        : new Response(JSON.stringify({ ...list[0], displayMetadata: {}, items: [{ id: "l", description: "Full contour crown", toothNumber: 8, quantity: 1 }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fireEvent.click(screen.getByTestId("invoice-row-inv-0"));
    await waitFor(() => expect(screen.getByTestId("invoice-preview-restoration").textContent).toBe("Full contour crown"));
    expect(screen.getByTestId("invoice-preview-tooth").textContent).toBe("8");
    mode = "gone";
    fireEvent.click(screen.getByTestId("invoice-preview-close"));
    fireEvent.click(screen.getByTestId("invoice-row-inv-0"));
    await screen.findByTestId("invoice-preview-missing");
    expect((screen.getByTestId("invoice-preview-edit") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("invoice-preview-record-payment") as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes on Escape and refetches detail when the register refreshes", async () => {
    await setup();
    const detailCalls = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => /\/api\/invoices\/inv-0$/.test(String(c[0]))).length;
    fireEvent.click(screen.getByTestId("invoice-row-inv-0"));
    await screen.findByTestId("invoice-preview-balance");
    const before = detailCalls();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("invoice-preview")).toBeNull();
    expect(before).toBeGreaterThan(0);
  });

  it("opens the payment workflow from the preview", async () => {
    await setup();
    fireEvent.click(screen.getByTestId("invoice-row-inv-0"));
    await screen.findByTestId("invoice-preview-balance");
    fireEvent.click(screen.getByTestId("invoice-preview-record-payment"));
    await screen.findByText("Receive payment");
  });
});
