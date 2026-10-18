/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PayBillsPage from "@/pages/finance/pay-bills";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const baseBill = {
  labOrganizationId: "lab", vendorIsActive: true, billDate: "2026-01-01", dueDate: "2026-02-01",
  termsDays: 30, memo: null, amountPaid: "0.00", amountCredited: "0.00", status: "open",
  voidedAt: null, voidReason: null, createdAt: "2026-01-01", updatedAt: "2026-01-01", lines: [],
};
const makeVendors = () => [
  {
    vendorId: "v1", vendorName: "Acme Supply", vendorIsActive: true, totalDue: "50.00", availableCredit: "5.00",
    credits: [{ id: "credit-1", remainingAmount: "5.00" }],
    bills: [{ ...baseBill, id: "b1", vendorId: "v1", vendorName: "Acme Supply", billNumber: "A-1", total: "50.00", balanceDue: "50.00" }],
  },
  {
    vendorId: "v2", vendorName: "Beta Services", vendorIsActive: true, totalDue: "30.00", availableCredit: "0.00", credits: [],
    bills: [{ ...baseBill, id: "b2", vendorId: "v2", vendorName: "Beta Services", billNumber: "B-2", total: "30.00", balanceDue: "30.00" }],
  },
];
let vendors = makeVendors();

let posts: any[];
let holdSubmit: boolean;
let resolveSubmit: (() => void) | undefined;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ ok: true, data }), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  localStorage.clear();
  vendors = makeVendors();
  posts = [];
  holdSubmit = false;
  resolveSubmit = undefined;
  vi.stubGlobal("crypto", { randomUUID: () => "12345678-1234-1234-1234-123456789012" });
  vi.stubGlobal("BroadcastChannel", class { postMessage() {} close() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input.toString(), "http://localhost").pathname;
    if (path.endsWith("/organizations")) return json([{ id: "lab", name: "Lab", type: "lab" }]);
    if (path.endsWith("/finance/accounts")) return json([{ id: "bank-1", name: "Operating", openingBalance: "1000.00", bookBalance: "1000.00" }]);
    if (path.endsWith("/finance/undeposited-funds")) return json({ count: 0, total: 0 });
    if (path.endsWith("/finance/pay-bills")) return json({ vendors });
    if (path.endsWith("/finance/bill-payments") && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      if (holdSubmit) {
        return new Promise<Response>((resolve) => {
          resolveSubmit = () => resolve(json({ payments: [{ id: "p1", amount: "10.01" }, { id: "p2", amount: "20.02" }], replayed: false }, 201));
        });
      }
      return json({ payments: [], replayed: false }, 201);
    }
    return json({});
  }));
});

afterEach(() => vi.unstubAllGlobals());

async function page() {
  const Wrapper = makeAuthWrapper("/finance/pay-bills", {
    user: { id: "u", role: "admin", userType: "lab", practiceOrganizationId: "lab" } as any,
    status: "authed", restoreStatus: "ok", restoreNoticeDismissed: true,
  });
  render(<Wrapper><PayBillsPage /></Wrapper>);
  await screen.findByText("A-1");
}

function paymentInput(billNumber: string) {
  const checkbox = screen.getByRole("checkbox", { name: `Pay bill ${billNumber}` });
  const row = checkbox.closest("tr")!;
  return row.querySelectorAll("input[type=number]")[1] as HTMLInputElement;
}

function creditInput(billNumber: string) {
  const checkbox = screen.getByRole("checkbox", { name: `Pay bill ${billNumber}` });
  const row = checkbox.closest("tr")!;
  return row.querySelectorAll("input[type=number]")[0] as HTMLInputElement;
}

describe("Pay Bills", () => {
  it("computes partial totals and blocks overpayments and missing funding accounts", async () => {
    await page();
    fireEvent.change(screen.getAllByRole("combobox")[2], { target: { value: "due_today" } });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("dueBefore="))).toBe(true));
    await screen.findByRole("checkbox", { name: "Pay bill A-1" });

    fireEvent.click(screen.getByRole("checkbox", { name: "Pay bill A-1" }));
    fireEvent.change(paymentInput("A-1"), { target: { value: "12.34" } });
    expect(screen.getByText("$12.34")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Pay from"), { target: { value: "bank-1" } });
    fireEvent.change(paymentInput("A-1"), { target: { value: "50.01" } });
    fireEvent.click(screen.getByRole("button", { name: "Record payment" }));
    expect(await screen.findByText(/only owes \$50.00/)).toBeInTheDocument();
    expect(posts).toHaveLength(0);

    fireEvent.change(paymentInput("A-1"), { target: { value: "12.34" } });
    fireEvent.change(screen.getByLabelText("Pay from"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Record payment" }));
    expect(await screen.findByText("Choose the bank account the money comes from.")).toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });

  it("posts one cent-accurate entry per vendor and disables submit in flight", async () => {
    await page();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pay bill A-1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Pay bill B-2" }));
    fireEvent.change(paymentInput("A-1"), { target: { value: "10.01" } });
    fireEvent.change(paymentInput("B-2"), { target: { value: "20.02" } });
    fireEvent.change(screen.getByLabelText("Pay from"), { target: { value: "bank-1" } });
    holdSubmit = true;
    const submit = screen.getByRole("button", { name: "Record payment" });
    fireEvent.click(submit);

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      organizationId: "lab",
      bankAccountId: "bank-1",
      vendorPayments: [
        { vendorId: "v1", allocations: [{ billId: "b1", amount: 10.01, creditApplications: [] }] },
        { vendorId: "v2", allocations: [{ billId: "b2", amount: 20.02, creditApplications: [] }] },
      ],
    });
    resolveSubmit?.();
    await screen.findByText(/Recorded 2 vendor payments/);
  });

  it("spends each vendor credit once across every bill in the run", async () => {
    const acme = vendors[0]!;
    acme.availableCredit = "65.00";
    acme.credits = [
      { id: "credit-1", remainingAmount: "5.00" },
      { id: "credit-2", remainingAmount: "60.00" },
    ];
    acme.bills.push({
      ...baseBill, id: "b1b", vendorId: "v1", vendorName: "Acme Supply",
      billNumber: "A-2", total: "40.00", balanceDue: "40.00",
    });

    await page();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pay bill A-1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Pay bill A-2" }));
    fireEvent.change(paymentInput("A-1"), { target: { value: "0" } });
    fireEvent.change(paymentInput("A-2"), { target: { value: "0" } });
    fireEvent.change(creditInput("A-1"), { target: { value: "5" } });
    fireEvent.change(creditInput("A-2"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "Record payment" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    // The first bill uses up the $5 credit, so the second draws only on what
    // is left rather than spending that credit a second time.
    expect(posts[0].vendorPayments).toEqual([
      {
        vendorId: "v1",
        allocations: [
          { billId: "b1", amount: 0, creditApplications: [{ vendorCreditId: "credit-1", amount: 5 }] },
          { billId: "b1b", amount: 0, creditApplications: [{ vendorCreditId: "credit-2", amount: 40 }] },
        ],
      },
    ]);
  });
});