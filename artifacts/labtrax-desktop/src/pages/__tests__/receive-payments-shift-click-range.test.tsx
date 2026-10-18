/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ReceivePaymentsPage from "@/pages/finance/receive-payments";
import { makeAuthWrapper } from "../../__tests__/test-utils";

// Task #2798: shift-click range selection on the Receive Payments invoice
// list (same semantics as the Cases list, Task #2796). "Selected" here means
// an invoice has an applied amount > 0, so a shift-click applies the full
// balance to every unapplied invoice in the range while keeping existing
// (partial) amounts untouched.

const LAB_ORG = { id: "lab-1", name: "Lab One", type: "lab" };

// One open (unpaid) invoice per provider so the provider dropdown resolves
// to prov-1.
const ALL_INVOICES = [
  {
    id: "seed-1",
    labOrganizationId: "lab-1",
    providerOrganizationId: "prov-1",
    providerOrganization: { name: "Alpha Dental" },
    status: "sent",
    total: "100.00",
    balanceDue: "100.00",
  },
];

// Five open invoices, rendered in this order.
const OPEN_INVOICES = [1, 2, 3, 4, 5].map((n) => ({
  id: `inv-${n}`,
  invoiceNumber: `INV-${n}`,
  issuedAt: `2026-06-${String(10 + n).padStart(2, "0")}T10:00:00.000Z`,
  ageDays: 30 - n,
  total: "100.00",
  balanceDue: "100.00",
}));
const STATEMENT = {
  id: "statement-prov-1",
  periodStart: "2026-06-01T00:00:00.000Z",
  periodEnd: "2026-06-30T00:00:00.000Z",
  savedBalanceDue: "500.00",
  invoiceCount: OPEN_INVOICES.length,
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url, "http://localhost").pathname;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (path.endsWith("/billing/lab-1/accounts/prov-1/statements")) {
        return json([STATEMENT]);
      }
      if (path.includes("/eligible-statement-accounts")) {
        return json([{
          providerOrganizationId: "prov-1",
          providerName: "Alpha Dental",
          statementId: STATEMENT.id,
          periodEnd: STATEMENT.periodEnd,
          sentAt: "2026-07-01T00:00:00.000Z",
          invoiceCount: STATEMENT.invoiceCount,
          currentBalanceDue: STATEMENT.savedBalanceDue,
        }]);
      }
      if (path.endsWith("/billing/statements/statement-prov-1")) {
        return json({
          ...STATEMENT,
          invoices: OPEN_INVOICES.map((invoice) => ({
            ...invoice,
            currentBalanceDue: invoice.balanceDue,
            eligibleForPayment: true,
          })),
        });
      }
      if (path.endsWith("/invoices")) return json(ALL_INVOICES);
      // Receive Payments is gated on the user's role in the selected lab.
      if (path.endsWith("/auth/me")) {
        return json({
          user: { id: "u1", username: "admin", role: "admin", userType: "lab" },
          memberships: [{ organizationId: LAB_ORG.id, role: "admin", status: "active", organization: LAB_ORG }],
        });
      }
      if (path.endsWith("/organizations")) return json([LAB_ORG]);
      if (path.endsWith("/finance/accounts")) return json([]);
      if (path.endsWith("/finance/undeposited-funds"))
        return json({ count: 0, total: 0 });
      return json({});
    }),
  );
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

async function renderPage() {
  const Wrapper = makeAuthWrapper("/finance/receive-payments", {
    user: {
      id: "u1",
      username: "admin",
      role: "admin",
      userType: "lab",
    } as any,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
  });
  render(
    <Wrapper>
      <ReceivePaymentsPage />
    </Wrapper>,
  );
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select Alpha Dental" }));
  await waitFor(() => expect(screen.getByTestId("expected-payments")).toHaveTextContent("$500.00"));
  fireEvent.click(screen.getByTestId("receive-continue"));
  await screen.findByLabelText("Select invoice INV-1");
  // The completed customer-payment workflow now defaults the full open
  // balance and auto-applies it oldest-first. Clear those required defaults
  // without clicking a checkbox so these tests begin with no shift anchor.
  for (const invoice of OPEN_INVOICES) {
    fireEvent.change(amountInput(invoice.invoiceNumber), {
      target: { value: "" },
    });
  }
}

function checkbox(invoiceNumber: string): HTMLInputElement {
  return screen.getByLabelText(
    `Select invoice ${invoiceNumber}`,
  ) as HTMLInputElement;
}

function amountInput(invoiceNumber: string): HTMLInputElement {
  const row = checkbox(invoiceNumber).closest("tr")!;
  return row.querySelector('input[type="number"]') as HTMLInputElement;
}

function selectedNumbers(): string[] {
  return ["INV-1", "INV-2", "INV-3", "INV-4", "INV-5"].filter(
    (n) => checkbox(n).checked,
  );
}

describe("Receive Payments shift-click range selection", () => {
  it("selects the range downward (anchor above the shift-clicked row)", async () => {
    await renderPage();

    fireEvent.click(checkbox("INV-1"));
    fireEvent.click(checkbox("INV-4"), { shiftKey: true });

    expect(selectedNumbers()).toEqual(["INV-1", "INV-2", "INV-3", "INV-4"]);
    expect(amountInput("INV-2").value).toBe("100.00");
  });

  it("selects the range upward (anchor below the shift-clicked row)", async () => {
    await renderPage();

    fireEvent.click(checkbox("INV-4"));
    fireEvent.click(checkbox("INV-2"), { shiftKey: true });

    expect(selectedNumbers()).toEqual(["INV-2", "INV-3", "INV-4"]);
  });

  it("adds the range to previously selected invoices and keeps partial amounts", async () => {
    await renderPage();

    // INV-5 selected outside the range; INV-2 has a manual partial amount.
    fireEvent.click(checkbox("INV-5"));
    fireEvent.change(amountInput("INV-2"), { target: { value: "25.00" } });

    fireEvent.click(checkbox("INV-1"));
    fireEvent.click(checkbox("INV-3"), { shiftKey: true });

    expect(selectedNumbers()).toEqual([
      "INV-1",
      "INV-2",
      "INV-3",
      "INV-5",
    ]);
    // The partial amount inside the range is preserved, not overwritten.
    expect(amountInput("INV-2").value).toBe("25.00");
    expect(amountInput("INV-1").value).toBe("100.00");
    expect(amountInput("INV-3").value).toBe("100.00");
  });

  it("treats a shift-click with no anchor as a single toggle and sets the anchor", async () => {
    await renderPage();

    // No prior click: shift-click toggles only the clicked invoice…
    fireEvent.click(checkbox("INV-3"), { shiftKey: true });
    expect(selectedNumbers()).toEqual(["INV-3"]);

    // …and it becomes the anchor for the next shift-click.
    fireEvent.click(checkbox("INV-5"), { shiftKey: true });
    expect(selectedNumbers()).toEqual(["INV-3", "INV-4", "INV-5"]);
  });

  it("keeps normal single toggling intact", async () => {
    await renderPage();

    fireEvent.click(checkbox("INV-2"));
    expect(checkbox("INV-2").checked).toBe(true);
    expect(amountInput("INV-2").value).toBe("100.00");

    fireEvent.click(checkbox("INV-2"));
    expect(checkbox("INV-2").checked).toBe(false);
    expect(amountInput("INV-2").value).toBe("");
  });
});
