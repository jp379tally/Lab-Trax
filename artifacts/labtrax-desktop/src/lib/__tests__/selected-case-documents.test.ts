/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../api";
import { invoicePrintOptions, mapPrintSelection, prepareSelectedInvoices, prepareSelectedLabSlips } from "../selected-case-documents";
import { DEFAULT_CASE_PRINT_TEMPLATE } from "../case-print-template";
import type { Invoice } from "../types";

vi.mock("../api", () => ({
  apiFetch: vi.fn(), apiFetchArrayBuffer: vi.fn(),
  getApiOrigin: () => "", serverAssetUrl: (url: string) => url,
}));
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:image/png;base64,qr") } }));
const caseFor = (id: string) => ({
  id, caseNumber: `26-${id}`, labOrganizationId: `lab-${id}`, status: "received",
  priority: "normal", restorations: [], attachments: [], notes: [],
  caseNotes: `Full Rx ${id}`, createdAt: "2026-01-01", updatedAt: "2026-01-01", totalPrice: "999",
});
const invoiceFor = (id: string) => ({
  id: `inv-${id}`, caseId: id, labOrganizationId: `lab-${id}`, invoiceNumber: `BILL-${id}`,
  status: "issued", items: [{ id: "line", description: "Persisted charge", quantity: 2, unitPrice: "10", lineTotal: "20" }],
  subtotal: "20", tax: "2", discount: "1", total: "21", balanceDue: "8",
  labOrganization: { name: `Lab ${id}` }, providerOrganization: { name: "Practice" },
});

beforeEach(() => {
  localStorage.clear();
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path.startsWith("/cases/")) return caseFor(path.split("/").pop()!);
    if (path.startsWith("/invoices?")) {
      const id = new URL(path, "http://localhost").searchParams.get("caseId")!;
      return [invoiceFor(id)];
    }
    if (path.startsWith("/invoices/")) return invoiceFor(path.split("inv-")[1]);
    if (path.split("?")[0].endsWith("/case-print-template")) {
      return { data: { template: DEFAULT_CASE_PRINT_TEMPLATE, isCustom: path.includes("lab-b/") } };
    }
    if (path.endsWith("/invoice-template")) return { data: { template: null } };
    if (path.startsWith("/organizations/")) return { id: path.split("/").pop(), name: "Lab", logoUrl: null };
    throw new Error(`Unexpected ${path}`);
  });
});

describe("authoritative selected document preparation", () => {
  it("loads exactly captured IDs, preserves order, and uses persisted financial details including sub-items", async () => {
    const result = await prepareSelectedInvoices(["b", "a"]);
    expect(result.options.map((opts) => opts.invoiceNumber)).toEqual(["BILL-b", "BILL-a"]);
    expect(result.options[0]).toMatchObject({ subtotal: "20", total: "21", tax: "2", discount: "1", balanceDue: "8" });
    expect(result.options[0].items[0].description).toBe("Persisted charge");
    expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path.startsWith("/cases/")).map(([path]) => path)).toEqual(["/cases/b", "/cases/a"]);
    const inv = invoiceFor("a") as unknown as Invoice;
    inv.items![0].subItems = [{ ...inv.items![0], id: "child", description: "Alloy" }];
    expect(invoicePrintOptions(inv, caseFor("a") as never).items[0].subItems?.[0].description).toBe("Alloy");
  });

  it("lists missing invoices by current case number, including all-missing", async () => {
    const base = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (path, opts) => path.startsWith("/invoices?") ? [] : base(path, opts));
    expect(await prepareSelectedInvoices(["a", "b"])).toEqual({ missing: ["26-a", "26-b"], options: [] });
    expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.includes("/invoice-template"))).toBe(false);
  });

  it("keeps current joined branding when the real detail response omits organizations", async () => {
    const base = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (path, opts) => {
      if (path.startsWith("/invoices/")) {
        const inv = invoiceFor(path.split("inv-")[1]);
        const { labOrganization: _lab, providerOrganization: _practice, ...detail } = inv;
        return detail;
      }
      return base(path, opts);
    });
    const result = await prepareSelectedInvoices(["a"]);
    expect(result.options[0]).toMatchObject({ labName: "Lab a", practiceName: "Practice", billTo: "Practice" });
  });

  it.each([403, 404, 500])("does not treat a failed invoice lookup (%s) as missing", async (status) => {
    const base = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (path, opts) => {
      if (path === "/invoices?caseId=b") throw new Error(`Access/load failure ${status}`);
      return base(path, opts);
    });
    await expect(prepareSelectedInvoices(["a", "b"])).rejects.toThrow(/Case 26-b.*No documents printed/);
  });

  it("honors different labs' default and custom layouts without opening a window", async () => {
    const open = vi.spyOn(window, "open");
    const documents = await prepareSelectedLabSlips(["a", "b"], false);
    expect(documents).toHaveLength(2);
    expect(documents[0].bodyClass).toBe("lt-ov-page");
    expect(documents[0].body).toContain("Full Rx a");
    expect(documents[1].body).toContain("lt-adv-page");
    expect(documents[1].body).toContain("Full Rx b");
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("aborts rather than silently dropping a custom template image", async () => {
    const base = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (path, opts) => path.split("?")[0].endsWith("/case-print-template") ? {
      template: { version: 2, elements: [{ id: "stamp", kind: "image", url: "/stamp", storageKey: "stamp", visible: true, x: 1, y: 1, w: 20, h: 20 }] },
      isCustom: true,
    } : base(path, opts));
    await expect(prepareSelectedLabSlips(["a"], true)).rejects.toThrow(/template image/);
  });

  it("bounds preparation concurrency and snapshots mutable input", async () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    let active = 0;
    let peak = 0;
    const progress = vi.fn();
    const result = mapPrintSelection(ids, async (id) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return id;
    }, progress);
    ids.push("later");
    expect(await result).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(peak).toBe(4);
    expect(progress).toHaveBeenLastCalledWith(6, 6);
  });
});
