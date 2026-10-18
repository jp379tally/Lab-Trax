/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import StatementsPage from "@/pages/statements";
import { makeAuthWrapper } from "../../__tests__/test-utils";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));

const LAB_ORG = { id: "lab-1", name: "Lab One", type: "lab" };
const PRACTICE = {
  id: "practice-1",
  name: "Alpha Dental",
  type: "practice",
  parentLabOrganizationId: LAB_ORG.id,
};

const invoice = {
  id: "invoice-1",
  labOrganizationId: LAB_ORG.id,
  providerOrganizationId: PRACTICE.id,
  providerOrganization: { name: PRACTICE.name },
  status: "overdue",
  total: "200.00",
  balanceDue: "200.00",
  issuedAt: "2026-07-01T12:00:00.000Z",
  createdAt: "2026-07-01T12:00:00.000Z",
};

function accountSummary(paymentRecorded: boolean) {
  return [
    {
      practiceId: PRACTICE.id,
      practiceName: PRACTICE.name,
      billingEmail: "billing@alpha.test",
      phone: null,
      openInvoiceCount: 1,
      openInvoiceTotal: paymentRecorded ? 150 : 200,
      unpaidStatements: [
        {
          id: "statement-1",
          date: "2026-07-31T12:00:00.000Z",
          periodStart: "2026-07-01T00:00:00.000Z",
          periodEnd: "2026-08-01T00:00:00.000Z",
          remainingBalance: paymentRecorded ? 70 : 120,
          overdue: true,
           detailProvenance: "mixed",
        },
      ],
      totalOpenBalance: paymentRecorded ? 150 : 200,
      overdueBalance: paymentRecorded ? 30 : 80,
       hasLegacyStatements: true,
    },
  ];
}

let paymentRecorded = false;
let paymentShouldFail = false;
let paymentResponseShouldBeLost = false;
let accountSummaryRequests = 0;
const timingSensitiveRepeats = Number.parseInt(
  process.env.DESKTOP_TIMING_SENSITIVE_REPEATS ?? "0",
  10,
);

beforeEach(() => {
  paymentRecorded = false;
  paymentShouldFail = false;
  paymentResponseShouldBeLost = false;
  accountSummaryRequests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const path = new URL(url, "http://localhost").pathname;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      if (path.endsWith("/statements/account-summaries")) {
        accountSummaryRequests += 1;
        return json(accountSummary(paymentRecorded));
      }
      if (path.endsWith("/invoices/receive-payments") && init?.method === "POST") {
        if (paymentResponseShouldBeLost) {
          paymentRecorded = true;
          throw new TypeError("Failed to fetch");
        }
        if (paymentShouldFail) {
          return new Response(
            JSON.stringify({ error: "Payment was rejected" }),
            {
              status: 422,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        paymentRecorded = true;
        return json({ totalApplied: "50.00" });
      }
      if (path.endsWith("/invoices/payments/recent")) return json([]);
      if (path.endsWith("/invoices")) {
        return json([
          paymentRecorded
            ? { ...invoice, balanceDue: "150.00" }
            : invoice,
        ]);
      }
      if (path.endsWith("/organizations")) return json([LAB_ORG, PRACTICE]);
      if (path.endsWith("/statement-schedule")) return json({});
      if (path.endsWith("/statement-runs")) return json([]);
      if (path.endsWith("/admin/templates/statement-email")) {
        return json({ emailSubject: null, emailBody: null });
      }
      return json({});
    }),
  );
});


afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("Statements payment refresh", { repeats: timingSensitiveRepeats }, () => {
  it("refetches account summaries and immediately updates statement, open, and overdue balances", async () => {
    const Wrapper = makeAuthWrapper("/statements", {
      user: {
        id: "user-1",
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
        <StatementsPage />
      </Wrapper>,
    );

    const practiceCheckbox = await screen.findByLabelText(
      `Select practice ${PRACTICE.name}`,
    );
    const practiceRow = practiceCheckbox.closest("tr");
    expect(practiceRow).not.toBeNull();
    expect(within(practiceRow!).getByText("$120.00")).toBeInTheDocument();
    expect(within(practiceRow!).getAllByText("$200.00")).toHaveLength(2);
    expect(within(practiceRow!).getByText("$80.00")).toBeInTheDocument();
    expect(within(practiceRow!).getByText(/mixed details/)).toBeInTheDocument();
    expect(within(practiceRow!).getByText(/Some older statement details/)).toBeInTheDocument();

    fireEvent.click(practiceCheckbox);
    fireEvent.click(screen.getByRole("button", { name: "Receive Payment" }));
    fireEvent.change(await screen.findByDisplayValue("200.00"), {
      target: { value: "50.00" },
    });
    await screen.findByDisplayValue("50.00");
    const saveButton = screen.getByRole("button", { name: "Save payment" });
    await waitFor(() => expect(saveButton).toBeEnabled());
    fireEvent.click(saveButton);

    await waitFor(() => expect(accountSummaryRequests).toBeGreaterThan(1));
    await waitFor(() => {
      const refreshedRow = screen
        .getByLabelText(`Select practice ${PRACTICE.name}`)
        .closest("tr");
      expect(refreshedRow).not.toBeNull();
      const row = within(refreshedRow!);
      expect(row.getByText("$70.00")).toBeInTheDocument();
      expect(row.getAllByText("$150.00")).toHaveLength(2);
      expect(row.getByText("$30.00")).toBeInTheDocument();
      expect(row.queryByText("$120.00")).not.toBeInTheDocument();
      expect(row.queryAllByText("$200.00")).toHaveLength(0);
      expect(row.queryByText("$80.00")).not.toBeInTheDocument();
    });
  });

  it("keeps statement, open, and overdue balances unchanged when payment fails", async () => {
    paymentShouldFail = true;
    const Wrapper = makeAuthWrapper("/statements", {
      user: {
        id: "user-1",
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
        <StatementsPage />
      </Wrapper>,
    );

    const practiceCheckbox = await screen.findByLabelText(
      `Select practice ${PRACTICE.name}`,
    );
    fireEvent.click(practiceCheckbox);
    fireEvent.click(screen.getByRole("button", { name: "Receive Payment" }));
    fireEvent.change(await screen.findByDisplayValue("200.00"), {
      target: { value: "50.00" },
    });
    const saveButton = screen.getByRole("button", { name: "Save payment" });
    await waitFor(() => expect(saveButton).toBeEnabled());
    fireEvent.click(saveButton);

    expect(await screen.findByText("Payment was rejected")).toBeInTheDocument();
    expect(accountSummaryRequests).toBe(1);

    const practiceRow = screen
      .getByLabelText(`Select practice ${PRACTICE.name}`)
      .closest("tr");
    expect(practiceRow).not.toBeNull();
    const row = within(practiceRow!);
    expect(row.getByText("$120.00")).toBeInTheDocument();
    expect(row.getAllByText("$200.00")).toHaveLength(2);
    expect(row.getByText("$80.00")).toBeInTheDocument();
    expect(row.queryByText("$70.00")).not.toBeInTheDocument();
    expect(row.queryAllByText("$150.00")).toHaveLength(0);
    expect(row.queryByText("$30.00")).not.toBeInTheDocument();
  });

  it("shows the network error without presenting refreshed balances when the payment response is lost", async () => {
    paymentResponseShouldBeLost = true;
    const Wrapper = makeAuthWrapper("/statements", {
      user: {
        id: "user-1",
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
        <StatementsPage />
      </Wrapper>,
    );

    const practiceCheckbox = await screen.findByLabelText(
      `Select practice ${PRACTICE.name}`,
    );
    fireEvent.click(practiceCheckbox);
    fireEvent.click(screen.getByRole("button", { name: "Receive Payment" }));
    fireEvent.change(await screen.findByDisplayValue("200.00"), {
      target: { value: "50.00" },
    });
    const saveButton = screen.getByRole("button", { name: "Save payment" });
    await waitFor(() => expect(saveButton).toBeEnabled());
    fireEvent.click(saveButton);

    expect(
      await screen.findByText(/Could not reach the server \(Failed to fetch\)/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save payment" })).toBeInTheDocument();
    expect(screen.queryByText("Payment recorded")).not.toBeInTheDocument();
    expect(accountSummaryRequests).toBe(1);

    const practiceRow = screen
      .getByLabelText(`Select practice ${PRACTICE.name}`)
      .closest("tr");
    expect(practiceRow).not.toBeNull();
    const row = within(practiceRow!);
    expect(row.getByText("$120.00")).toBeInTheDocument();
    expect(row.getAllByText("$200.00")).toHaveLength(2);
    expect(row.getByText("$80.00")).toBeInTheDocument();
    expect(row.queryByText("$70.00")).not.toBeInTheDocument();
    expect(row.queryAllByText("$150.00")).toHaveLength(0);
    expect(row.queryByText("$30.00")).not.toBeInTheDocument();

    // A lost response is ambiguous: the server may have recorded the payment.
    // Keep the modal/error visible and the last confirmed balances on screen;
    // the user must reconcile recent payments (or refresh) before retrying.
    expect(paymentRecorded).toBe(true);
  });
});