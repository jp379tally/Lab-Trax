import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { mockInvalidateQueries, resetMockAppState, resetMockFetchHandler, setMockAppState, setMockFetchHandler } from "../../vitest.setup";
import BillsScreen from "@/app/finance/bills";
import PayBillsScreen from "@/app/finance/pay-bills";
import ApAgingScreen from "@/app/finance/ap-aging";

const membership = {
  organizationId: "lab-1",
  role: "admin",
  status: "active",
  organization: { id: "lab-1", type: "lab", name: "Test Lab" },
};
const vendor = { id: "vendor-a", name: "Alpha Supply", isActive: true, paymentTermsDays: 30 };
const bill = {
  id: "bill-a", vendorId: "vendor-a", vendorName: "Alpha Supply", vendorIsActive: true,
  billNumber: "A-100", billDate: "2026-01-01", dueDate: "2026-01-31", termsDays: 30,
  memo: null, total: "125.25", amountPaid: "25.00", amountCredited: "0.00",
  balanceDue: "100.25", status: "partially_paid", voidedAt: null, voidReason: null,
  createdAt: "2026-01-01", updatedAt: "2026-01-01", lines: [],
};

async function renderScreen(element: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}
function seed(overrides: Record<string, unknown> = {}) {
  setMockAppState({
    meMemberships: [membership],
    apBills: [bill],
    apVendors: [vendor],
    apCategories: [{ id: "cat-1", name: "Materials", kind: "expense" }],
    apAccounts: [{ id: "bank-1", name: "Operating Checking", accountType: "bank", isArchived: false }],
    ...overrides,
  });
}
afterEach(() => { cleanup(); resetMockAppState(); resetMockFetchHandler(); vi.clearAllMocks(); });

describe("Bills mobile screen", () => {
  it("renders the bill list with vendor and balance", async () => {
    seed();
    const screen = await renderScreen(<BillsScreen />);
    expect(screen.getByText("Alpha Supply")).toBeTruthy();
    expect(screen.getAllByText("$100.25").length).toBeGreaterThan(0);
    expect(screen.getByText(/Bill A-100/)).toBeTruthy();
  });

  it("posts a cents-safe bill payload", async () => {
    seed({ apBills: [] });
    const bodies: Record<string, unknown>[] = [];
    setMockFetchHandler(async (url, init) => {
      if (url === "/api/finance/bills" && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ data: { id: "new-bill" } }), { status: 201 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    const screen = await renderScreen(<BillsScreen />);
    await fireEvent.press(screen.getByTestId("bills-enter"));
    await fireEvent.press(screen.getByTestId("bill-entry-vendor-vendor-a"));
    await fireEvent.changeText(screen.getByTestId("bill-entry-number"), "REF-9");
    await fireEvent.changeText(screen.getByTestId("bill-line-description-0"), "Alloy");
    await fireEvent.changeText(screen.getByTestId("bill-line-amount-0"), "12.34");
    await fireEvent.press(screen.getByTestId("bill-save"));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      organizationId: "lab-1", vendorId: "vendor-a", billNumber: "REF-9",
      billDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), dueDate: null, termsDays: 30,
      lines: [{ categoryId: null, description: "Alloy", amount: 12.34 }],
    });
    expect(bodies[0]).not.toHaveProperty("acknowledgeDuplicateReference");
  });

  it("shows a duplicate warning and resubmits with acknowledgement", async () => {
    seed({ apBills: [] });
    const bodies: Record<string, unknown>[] = [];
    setMockFetchHandler(async (url, init) => {
      if (url === "/api/finance/bills" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)); bodies.push(body);
        if (bodies.length === 1) return new Response(JSON.stringify({ ok: false, error: { code: "duplicate_bill_reference", message: "Alpha Supply already has bill DUP-1." } }), { status: 409 });
        return new Response(JSON.stringify({ data: { id: "saved-anyway" } }), { status: 201 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    const screen = await renderScreen(<BillsScreen />);
    await fireEvent.press(screen.getByTestId("bills-enter"));
    await fireEvent.press(screen.getByTestId("bill-entry-vendor-vendor-a"));
    await fireEvent.changeText(screen.getByTestId("bill-entry-number"), "DUP-1");
    await fireEvent.changeText(screen.getByTestId("bill-line-description-0"), "Duplicate shipment");
    await fireEvent.changeText(screen.getByTestId("bill-line-amount-0"), "10.01");
    await fireEvent.press(screen.getByTestId("bill-save"));
    await waitFor(() => expect(screen.getByText("Alpha Supply already has bill DUP-1.")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("bill-save-anyway"));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ ...bodies[0], acknowledgeDuplicateReference: true });
  });

  describe("Add new vendor", () => {
    type Screen = Awaited<ReturnType<typeof renderScreen>>;
    const duplicateName = "A payee with this name already exists in this lab.";
    const vendorChipIds = (screen: Screen) => screen.getAllByTestId(/^bill-entry-vendor-/).map((chip) => chip.props.testID);
    // While the sheet is open it is modal to screen readers, so queries that
    // look at the bill underneath have to include hidden elements.
    const hidden = { includeHiddenElements: true };
    const isSelected = (screen: Screen, vendorId: string) => screen.getByTestId(`bill-entry-vendor-${vendorId}`, hidden).props.accessibilityState?.selected === true;
    const sheetOpen = (screen: Screen) => screen.queryByTestId("new-vendor-name") !== null;
    const billOpen = (screen: Screen) => screen.queryByTestId("bill-entry-number", hidden) !== null;
    // Android's back button goes to the nearest native Modal. The sheet is an
    // overlay inside the bill's Modal, so the bill has to hand it over.
    async function pressBack(screen: Screen, fromTestId = "new-vendor-sheet") {
      let node: any = screen.getByTestId(fromTestId).parent;
      while (node && node.type !== "Modal") node = node.parent;
      expect(node).toBeTruthy();
      await fireEvent(node, "requestClose");
    }
    function track(vendorResponse: () => Promise<Response>) {
      const vendorBodies: Record<string, unknown>[] = [];
      const billBodies: Record<string, unknown>[] = [];
      setMockFetchHandler(async (url, init) => {
        if (url === "/api/finance/vendors" && init?.method === "POST") {
          vendorBodies.push(JSON.parse(String(init.body)));
          return vendorResponse();
        }
        if (url === "/api/finance/bills" && init?.method === "POST") {
          billBodies.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ data: { id: "new-bill" } }), { status: 201 });
        }
        return new Response(JSON.stringify({ data: null }), { status: 200 });
      });
      return { vendorBodies, billBodies };
    }
    async function fillLineAndSave(screen: Screen) {
      await fireEvent.changeText(screen.getByTestId("bill-line-description-0"), "Zirconia");
      await fireEvent.changeText(screen.getByTestId("bill-line-amount-0"), "80.00");
      await fireEvent.press(screen.getByTestId("bill-save"));
    }

    it("lists Add new vendor as the first vendor chip", async () => {
      seed({ apBills: [] });
      const screen = await renderScreen(<BillsScreen />);
      await fireEvent.press(screen.getByTestId("bills-enter"));
      expect(vendorChipIds(screen)).toEqual(["bill-entry-vendor-add", "bill-entry-vendor-vendor-a"]);
      expect(screen.getByText("+ Add new vendor")).toBeTruthy();
      expect(sheetOpen(screen)).toBe(false);
      // With no sheet open, the back button still closes the bill as before.
      await pressBack(screen, "bill-entry-number");
      expect(billOpen(screen)).toBe(false);
    });

    it("keeps the chosen vendor and sends nothing when the sheet is closed", async () => {
      seed({ apBills: [] });
      const { vendorBodies, billBodies } = track(async () => new Response(JSON.stringify({ ok: true, data: null }), { status: 200 }));
      const screen = await renderScreen(<BillsScreen />);
      await fireEvent.press(screen.getByTestId("bills-enter"));
      await fireEvent.press(screen.getByTestId("bill-entry-vendor-vendor-a"));

      await fireEvent.press(screen.getByTestId("bill-entry-vendor-add"));
      expect(sheetOpen(screen)).toBe(true);
      // Screen readers stay inside the sheet; the bill is still there beneath it.
      expect(screen.queryByTestId("bill-entry-number")).toBeNull();
      expect(billOpen(screen)).toBe(true);
      await fireEvent.changeText(screen.getByTestId("new-vendor-name"), "Never saved");
      await fireEvent.press(screen.getByTestId("new-vendor-cancel"));
      expect(sheetOpen(screen)).toBe(false);
      expect(isSelected(screen, "vendor-a")).toBe(true);

      // Each opening starts blank. When idle, the back button closes only the
      // sheet, and so does a tap on the backdrop.
      await fireEvent.press(screen.getByTestId("bill-entry-vendor-add"));
      expect(screen.getByTestId("new-vendor-name").props.value).toBe("");
      await pressBack(screen);
      expect(sheetOpen(screen)).toBe(false);
      expect(billOpen(screen)).toBe(true);
      await fireEvent.press(screen.getByTestId("bill-entry-vendor-add"));
      await fireEvent.press(screen.getByTestId("new-vendor-backdrop"));
      expect(sheetOpen(screen)).toBe(false);
      expect(billOpen(screen)).toBe(true);
      expect(isSelected(screen, "vendor-a")).toBe(true);
      expect(screen.getByTestId("bill-entry-terms").props.value).toBe("30");

      await fillLineAndSave(screen);
      await waitFor(() => expect(billBodies).toHaveLength(1));
      expect(billBodies[0]).toMatchObject({ vendorId: "vendor-a", termsDays: 30 });
      expect(vendorBodies).toEqual([]);
    });

    it("creates the vendor once, selects it right away and saves the bill with it", async () => {
      seed({ apBills: [] });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const created = { id: "vendor-new", name: "Bright Dental Supply", isActive: true, paymentTermsDays: 45, vendorType: "vendor", phone: "555-0100", email: "orders@bright.example" };
      const { vendorBodies, billBodies } = track(async () => {
        await held;
        return new Response(JSON.stringify({ ok: true, data: created }), { status: 200 });
      });
      const screen = await renderScreen(<BillsScreen />);
      await fireEvent.press(screen.getByTestId("bills-enter"));
      await fireEvent.changeText(screen.getByTestId("bill-entry-number"), "BD-7");
      await fireEvent.changeText(screen.getByTestId("bill-entry-memo"), "Crowns");

      await fireEvent.press(screen.getByTestId("bill-entry-vendor-add"));
      await fireEvent.changeText(screen.getByTestId("new-vendor-name"), "  Bright Dental Supply  ");
      await fireEvent.changeText(screen.getByTestId("new-vendor-terms"), "45");
      await fireEvent.changeText(screen.getByTestId("new-vendor-phone"), " 555-0100 ");
      await fireEvent.changeText(screen.getByTestId("new-vendor-email"), "orders@bright.example");
      const saveVendor = screen.getByTestId("new-vendor-save");
      await fireEvent.press(saveVendor);
      await fireEvent.press(saveVendor);
      await waitFor(() => expect(screen.getByTestId("new-vendor-cancel").props.disabled).toBe(true));
      expect(screen.getByTestId("new-vendor-save").props.disabled).toBe(true);
      expect(vendorBodies).toHaveLength(1);

      // While saving, nothing closes the sheet: not Cancel, the backdrop, or
      // the back button, which must not close the bill behind it either.
      await fireEvent.press(screen.getByTestId("new-vendor-cancel"));
      await fireEvent.press(screen.getByTestId("new-vendor-backdrop"));
      await pressBack(screen);
      expect(sheetOpen(screen)).toBe(true);
      expect(billOpen(screen)).toBe(true);

      release();
      await waitFor(() => expect(sheetOpen(screen)).toBe(false));
      expect(vendorBodies).toEqual([{
        organizationId: "lab-1", name: "Bright Dental Supply", vendorType: "vendor",
        paymentTermsDays: 45, phone: "555-0100", email: "orders@bright.example",
      }]);
      // The vendor list itself still lacks it, so the chip comes from the save.
      expect(vendorChipIds(screen)).toEqual(["bill-entry-vendor-add", "bill-entry-vendor-vendor-new", "bill-entry-vendor-vendor-a"]);
      expect(isSelected(screen, "vendor-new")).toBe(true);
      expect(isSelected(screen, "vendor-a")).toBe(false);
      expect(screen.getByTestId("bill-entry-terms").props.value).toBe("45");
      expect(screen.getByTestId("bill-entry-number").props.value).toBe("BD-7");
      expect(screen.getByTestId("bill-entry-memo").props.value).toBe("Crowns");
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["finance", "vendors", "lab-1"] });
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["vendors", "lab-1"] });

      await fillLineAndSave(screen);
      await waitFor(() => expect(billBodies).toHaveLength(1));
      expect(billBodies[0]).toMatchObject({ vendorId: "vendor-new", termsDays: 45, billNumber: "BD-7", memo: "Crowns" });
      expect(vendorBodies).toHaveLength(1);
    });

    it("keeps the sheet open with the server's reason when the save is refused", async () => {
      seed({ apBills: [] });
      const { vendorBodies } = track(async () => new Response(JSON.stringify({ ok: false, message: duplicateName }), { status: 409 }));
      const screen = await renderScreen(<BillsScreen />);
      await fireEvent.press(screen.getByTestId("bills-enter"));
      await fireEvent.press(screen.getByTestId("bill-entry-vendor-vendor-a"));

      await fireEvent.press(screen.getByTestId("bill-entry-vendor-add"));
      await fireEvent.changeText(screen.getByTestId("new-vendor-name"), "alpha supply");
      await fireEvent.changeText(screen.getByTestId("new-vendor-terms"), "15");
      await fireEvent.press(screen.getByTestId("new-vendor-save"));

      await waitFor(() => expect(screen.getByTestId("new-vendor-error").props.children).toBe(duplicateName));
      expect(screen.getByTestId("new-vendor-name").props.value).toBe("alpha supply");
      expect(screen.getByTestId("new-vendor-terms").props.value).toBe("15");
      expect(screen.getByTestId("new-vendor-cancel").props.disabled).toBe(false);
      expect(isSelected(screen, "vendor-a")).toBe(true);
      expect(screen.getByTestId("bill-entry-terms", hidden).props.value).toBe("30");
      expect(mockInvalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["finance", "vendors", "lab-1"] });

      await fireEvent.press(screen.getByTestId("new-vendor-cancel"));
      expect(sheetOpen(screen)).toBe(false);
      expect(vendorChipIds(screen)).toEqual(["bill-entry-vendor-add", "bill-entry-vendor-vendor-a"]);
      expect(isSelected(screen, "vendor-a")).toBe(true);
      expect(vendorBodies).toHaveLength(1);
    });
  });
});

const payVendorA = {
  vendorId: "vendor-a", vendorName: "Alpha Supply", vendorIsActive: true,
  bills: [bill], totalDue: "100.25", availableCredit: "20.00",
  credits: [
    { id: "credit-old", vendorId: "vendor-a", creditNumber: "C1", creditDate: "2025-01-01", categoryId: null, memo: null, amount: "5.00", amountApplied: "0.00", remainingAmount: "5.00", status: "open", voidedAt: null },
    { id: "credit-new", vendorId: "vendor-a", creditNumber: "C2", creditDate: "2025-02-01", categoryId: null, memo: null, amount: "15.00", amountApplied: "0.00", remainingAmount: "15.00", status: "open", voidedAt: null },
  ],
};
const billB = { ...bill, id: "bill-b", vendorId: "vendor-b", vendorName: "Beta Services", billNumber: "B-5", total: "50.00", balanceDue: "50.00", amountPaid: "0.00", status: "open" };
const payVendorB = { vendorId: "vendor-b", vendorName: "Beta Services", vendorIsActive: true, bills: [billB], credits: [], totalDue: "50.00", availableCredit: "0.00" };

describe("Pay Bills mobile screen", () => {
  it("posts partial cash and oldest-first credit in one entry per vendor", async () => {
    seed({ apPayBills: { vendors: [payVendorA, payVendorB] } });
    const bodies: Record<string, any>[] = [];
    setMockFetchHandler(async (url, init) => {
      if (url === "/api/finance/bill-payments" && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ data: { payments: [{ id: "p-a", amount: "12.34" }, { id: "p-b", amount: "20.00" }] } }), { status: 201 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    const screen = await renderScreen(<PayBillsScreen />);
    await fireEvent.press(screen.getByTestId("pay-bill-bill-a"));
    await fireEvent.changeText(screen.getByTestId("pay-bill-cash-bill-a"), "12.34");
    await fireEvent.changeText(screen.getByTestId("pay-bill-credit-bill-a"), "7.89");
    await fireEvent.press(screen.getByTestId("pay-bill-bill-b"));
    await fireEvent.changeText(screen.getByTestId("pay-bill-cash-bill-b"), "20.00");
    await fireEvent.press(screen.getByTestId("pay-bills-submit"));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].vendorPayments).toHaveLength(2);
    expect(bodies[0].vendorPayments[0]).toEqual({
      vendorId: "vendor-a",
      allocations: [{ billId: "bill-a", amount: 12.34, creditApplications: [{ vendorCreditId: "credit-old", amount: 5 }, { vendorCreditId: "credit-new", amount: 2.89 }] }],
    });
    expect(bodies[0]).toMatchObject({ bankAccountId: "bank-1", idempotencyKey: expect.stringMatching(/^mobile-pay-bills-/) });
  });

  it("blocks an allocation above the bill balance", async () => {
    seed({ apPayBills: { vendors: [payVendorA] } });
    const screen = await renderScreen(<PayBillsScreen />);
    await fireEvent.press(screen.getByTestId("pay-bill-bill-a"));
    await fireEvent.changeText(screen.getByTestId("pay-bill-cash-bill-a"), "100.26");
    await fireEvent.press(screen.getByTestId("pay-bills-submit"));
    await waitFor(() => expect(screen.getByText(/only owes \$100\.25/)).toBeTruthy());
  });

  it("blocks cash when no funding account exists", async () => {
    seed({ apPayBills: { vendors: [payVendorA] }, apAccounts: [] });
    const screen = await renderScreen(<PayBillsScreen />);
    await fireEvent.press(screen.getByTestId("pay-bill-bill-a"));
    await fireEvent.changeText(screen.getByTestId("pay-bill-cash-bill-a"), "1.00");
    await fireEvent.press(screen.getByTestId("pay-bills-submit"));
    await waitFor(() => expect(screen.getByText("Choose the bank account the money comes from.")).toBeTruthy());
  });

  it("synchronously guards an in-flight payment from a double submit", async () => {
    seed({ apPayBills: { vendors: [payVendorA] } });
    let posts = 0;
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    setMockFetchHandler(async (url, init) => {
      if (url === "/api/finance/bill-payments" && init?.method === "POST") {
        posts++;
        await pending;
        return new Response(JSON.stringify({ data: { payments: [{ id: "p-a", amount: "1.00" }] } }), { status: 201 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    const screen = await renderScreen(<PayBillsScreen />);
    await fireEvent.press(screen.getByTestId("pay-bill-bill-a"));
    await fireEvent.changeText(screen.getByTestId("pay-bill-cash-bill-a"), "1.00");
    const submit = screen.getByTestId("pay-bills-submit");
    await fireEvent.press(submit);
    await fireEvent.press(submit);
    await waitFor(() => expect(posts).toBe(1));
    expect(screen.getByTestId("pay-bills-submit").props.disabled).toBe(true);
    resolve();
  });
});

describe("A/P Aging mobile screen", () => {
  it("renders buckets, totals, separate credits, and API limitations", async () => {
    seed({
      apAging: {
        basis: "accrual", asOf: "2026-03-01T12:00:00.000Z",
        buckets: [{ key: "current", label: "Current" }, { key: "d1_30", label: "1–30" }, { key: "d31_60", label: "31–60" }, { key: "d61_90", label: "61–90" }, { key: "d90_plus", label: "Over 90" }],
        rows: [{ vendorId: "vendor-a", vendorName: "Alpha Supply", vendorIsActive: true, buckets: { current: "10.00", d1_30: "20.00", d31_60: "30.00", d61_90: "40.00", d90_plus: "50.00" }, total: "150.00", unappliedCredit: "7.00", bills: [] }],
        totals: { current: "10.00", d1_30: "20.00", d31_60: "30.00", d61_90: "40.00", d90_plus: "50.00" },
        total: "150.00", unappliedCreditTotal: "7.00",
        limitations: [{ code: "historical_credit", message: "Older credits may be approximate." }],
      },
    });
    const screen = await renderScreen(<ApAgingScreen />);
    expect(screen.getAllByText("Current")).toHaveLength(2);
    expect(screen.getAllByText("Over 90")).toHaveLength(2);
    expect(screen.getByText("$150.00")).toBeTruthy();
    expect(screen.getByText("Alpha Supply")).toBeTruthy();
    expect(screen.getAllByText("$7.00")).toHaveLength(2);
    expect(screen.getByText("Unapplied credit (not netted)")).toBeTruthy();
    expect(screen.getByText("Older credits may be approximate.")).toBeTruthy();
  });

  it("switches to the A/R endpoint data and renders receivable totals and limitations", async () => {
    seed({
      apAging: {
        basis: "accrual", asOf: "2026-03-01T12:00:00.000Z",
        buckets: [{ key: "current", label: "Current" }, { key: "d1_30", label: "1–30" }, { key: "d31_60", label: "31–60" }, { key: "d61_90", label: "61–90" }, { key: "d90_plus", label: "Over 90" }],
        rows: [], totals: { current: "0.00", d1_30: "0.00", d31_60: "0.00", d61_90: "0.00", d90_plus: "0.00" }, total: "0.00", unappliedCreditTotal: "0.00",
      },
      arAging: {
        basis: "accrual", asOf: "2026-03-01T12:00:00.000Z",
        buckets: [{ key: "current", label: "Current" }, { key: "d1_30", label: "1–30" }, { key: "d31_60", label: "31–60" }, { key: "d61_90", label: "61–90" }, { key: "d90_plus", label: "Over 90" }],
        rows: [{ customerId: "customer-a", customerName: "Oak Dental", buckets: { current: "11.00", d1_30: "22.00", d31_60: "33.00", d61_90: "44.00", d90_plus: "55.00" }, total: "165.00", unappliedCredit: "8.25", invoices: [] }],
        totals: { current: "11.00", d1_30: "22.00", d31_60: "33.00", d61_90: "44.00", d90_plus: "55.00" },
        total: "165.00", unappliedCreditTotal: "8.25",
        limitations: [{ code: "reversed_payments_not_dated", message: "Some historical receivable balances are approximate." }],
      },
    });
    const screen = await renderScreen(<ApAgingScreen />);
    expect(screen.getByText("A/P Aging")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("aging-side-ar"));
    expect(screen.getByText("A/R Aging")).toBeTruthy();
    expect(screen.getByText("Oak Dental")).toBeTruthy();
    expect(screen.getByText("$165.00")).toBeTruthy();
    expect(screen.getAllByText("$8.25")).toHaveLength(2);
    expect(screen.getByText("Some historical receivable balances are approximate.")).toBeTruthy();
    expect(screen.getByText(/accounts receivable asset/)).toBeTruthy();
    expect(vi.mocked(useQuery).mock.calls.some(([options]) => Array.isArray(options.queryKey) && options.queryKey[1] === "ar-aging")).toBe(true);
  });
});