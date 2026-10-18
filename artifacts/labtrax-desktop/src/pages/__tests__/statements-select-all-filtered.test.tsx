/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import StatementsPage from "@/pages/statements";
import { makeAuthWrapper } from "../../__tests__/test-utils";

// Task #2838: "Select all" must respect the active recipient filter/search.
// The old buildKeysPayload sent null (whole scope) when all-selected, so a
// filtered "select all" would still contact hidden recipients. The batch-send
// payload must now carry only the currently-visible recipient keys.

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));

const LAB_ORG = { id: "lab-1", name: "Lab One", type: "lab" };

// Three practice recipients: two "Alpha" (visible under the filter) and one
// "Beta" (hidden). All have a billing email so the email channel is usable.
const RECIPIENTS = [
  { key: "prov-1", name: "Alpha Practice 1", email: "a1@example.com", phone: null, statementEmailOptOut: false, invoiceCount: 1, openBalance: 300, totalBilled: 900 },
  { key: "prov-2", name: "Beta Practice 2", email: "b2@example.com", phone: null, statementEmailOptOut: false, invoiceCount: 1, openBalance: 200, totalBilled: 800 },
  { key: "prov-3", name: "Alpha Practice 3", email: "a3@example.com", phone: null, statementEmailOptOut: false, invoiceCount: 1, openBalance: 100, totalBilled: 700 },
  { key: "prov-4", name: "Paid Practice", email: "paid@example.com", phone: null, statementEmailOptOut: false, invoiceCount: 1, openBalance: 0, totalBilled: 600 },
];
const DOCTOR_RECIPIENTS = [
  { key: "prov-1::Dr. Synthetic033", name: "Dr. Synthetic033", email: "doctor@example.com", phone: null, statementEmailOptOut: false, invoiceCount: 1, openBalance: 300.01, totalBilled: 900, doctors: [{ key: "nested", openBalance: 999 }] },
];

// The main Statements table must have at least one row or the "Generate
// Statements" button stays disabled (rows.length === 0). These invoices only
// enable the button; the modal's recipient list is sourced separately.
const INVOICES = RECIPIENTS.map((r, i) => ({
  id: `inv-${i + 1}`,
  labOrganizationId: "lab-1",
  providerOrganizationId: r.key,
  providerOrganization: { name: r.name },
  status: "sent",
  total: String(r.totalBilled),
  balanceDue: String(r.openBalance),
  createdAt: "2026-06-01T10:00:00.000Z",
}));
const ACCOUNT_SUMMARIES = RECIPIENTS.map((recipient) => ({
  practiceId: recipient.key,
  practiceName: recipient.name,
  billingEmail: recipient.email,
  phone: recipient.phone,
  openInvoiceCount: recipient.invoiceCount,
  openInvoiceTotal: recipient.openBalance,
  unpaidStatements: [],
  totalOpenBalance: recipient.openBalance,
  overdueBalance: 0,
}));

let batchSendBody: Record<string, unknown> | null = null;

beforeEach(() => {
  batchSendBody = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url, "http://localhost").pathname;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (path.endsWith("/statements/recipients")) {
        const mode = new URL(url, "http://localhost").searchParams.get("mode");
        return json({ recipients: mode === "doctor" ? DOCTOR_RECIPIENTS : RECIPIENTS });
      }
      if (path.endsWith("/statements/batch-send")) {
        batchSendBody = init?.body ? JSON.parse(init.body as string) : null;
        return json({ periodLabel: "June 2026", results: [] });
      }
      if (path.endsWith("/invoices")) return json(INVOICES);
      if (path.endsWith("/statements/account-summaries"))
        return json(ACCOUNT_SUMMARIES);
      if (path.endsWith("/organizations")) return json([LAB_ORG]);
      if (path.endsWith("/statement-schedule")) return json({});
      if (path.endsWith("/admin/templates/statement-email"))
        return json({ emailSubject: null, emailBody: null });
      return json({});
    }),
  );
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

/**
 * Opens the Generate Statements modal and advances to the recipient step.
 * Returns a `within` scope bound to the modal — the main page behind it
 * carries identically-labelled controls ("Search practice…", "Select all",
 * "Select practice …"), so every modal query must be scoped to avoid
 * matching those.
 */
async function openModalToRecipients() {
  localStorage.setItem("labtrax_finance_org_v1", "lab-1");
  const Wrapper = makeAuthWrapper("/statements", {
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
      <StatementsPage />
    </Wrapper>,
  );
  // The button is disabled until the invoices query resolves (rows > 0).
  const genBtn = await screen.findByRole("button", { name: /Generate Statements/i });
  await waitFor(() => expect((genBtn as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(genBtn);
  const modalRoot = (await screen.findByText("Generate statements")).closest(
    "div.fixed",
  ) as HTMLElement;
  const modal = within(modalRoot);
  // Step 1 → Step 2 (recipient selection).
  fireEvent.click(modal.getByRole("button", { name: "Next" }));
  await modal.findByLabelText("Select practice Alpha Practice 1");
  return modal;
}

async function openModalToReviewAsDoctor() {
  localStorage.setItem("labtrax_finance_org_v1", "lab-1");
  const Wrapper = makeAuthWrapper("/statements", {
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
      <StatementsPage />
    </Wrapper>,
  );
  const genBtn = await screen.findByRole("button", { name: /Generate Statements/i });
  await waitFor(() => expect((genBtn as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(genBtn);
  const modalRoot = (await screen.findByText("Generate statements")).closest(
    "div.fixed",
  ) as HTMLElement;
  const modal = within(modalRoot);
  fireEvent.click(modal.getByRole("button", { name: /^Doctors/ }));
  fireEvent.click(modal.getByRole("button", { name: "Next" }));
  await modal.findByLabelText("Select doctor Dr. Synthetic033");
  fireEvent.click(modal.getByRole("button", { name: "Next" }));
  fireEvent.click(modal.getByRole("button", { name: "Next" }));
  await modal.findByLabelText("Message body");
  return modal;
}

describe("Statements select-all respects the active filter", () => {
  it("sends only the visible recipient keys when 'Select all' is used with a search filter active", async () => {
    const modal = await openModalToRecipients();
    expect(modal.getByRole("status")).toHaveTextContent("$600.00");

    // Filter to "Alpha" — hides Beta Practice 2.
    fireEvent.change(modal.getByPlaceholderText("Search practice…"), {
      target: { value: "Alpha" },
    });
    expect(modal.queryByLabelText("Select practice Beta Practice 2")).toBeNull();
    expect(modal.getByRole("status")).toHaveTextContent("$400.00");

    // Select all (now scoped to the filtered set).
    fireEvent.click(modal.getByRole("button", { name: "Select all" }));
    expect(modal.getByRole("status")).toHaveTextContent("$400.00");

    // Step 2 → Step 3 (delivery). Email is enabled by default, so the send
    // path is already valid; advance to Step 4 → Review and send.
    fireEvent.click(modal.getByRole("button", { name: "Next" }));
    await modal.findByText(/Email \(PDF attachment\)/i);
    fireEvent.click(modal.getByRole("button", { name: "Next" }));
    fireEvent.click(await modal.findByRole("button", { name: /Generate & Send/i }));

    await waitFor(() => expect(batchSendBody).not.toBeNull());
    // Only the two visible "Alpha" practices — never the hidden "Beta" one,
    // and never null (which the server treats as the whole scope).
    expect(batchSendBody!.practiceIds).toEqual(["prov-1", "prov-3"]);
    expect(batchSendBody!.doctorKeys).toBeNull();
    expect(batchSendBody!.recipientType).toBe("practice");
  });
});

describe("Statements recipient-aware email greetings", () => {
  it("resets selection on mode changes and counts each doctor recipient once", async () => {
    const modal = await openModalToRecipients();
    fireEvent.click(modal.getByRole("button", { name: "None" }));
    expect(modal.getByRole("status")).toHaveTextContent("$0.00");
    fireEvent.click(modal.getByRole("button", { name: /Setup$/ }));
    fireEvent.click(modal.getByRole("button", { name: /^Doctors/ }));
    fireEvent.click(modal.getByRole("button", { name: "Next" }));
    await modal.findByLabelText("Select doctor Dr. Synthetic033");
    expect(modal.getByRole("status")).toHaveTextContent("$300.01");
    fireEvent.click(modal.getByLabelText("Select doctor Dr. Synthetic033"));
    expect(modal.getByRole("status")).toHaveTextContent("$0.00");
    fireEvent.click(modal.getByRole("button", { name: "Select all" }));
    expect(modal.getByRole("status")).toHaveTextContent("$300.01");
  });

  it("keeps explicit selections in sync with search and open-balance filters", async () => {
    const modal = await openModalToRecipients();
    fireEvent.click(modal.getByRole("button", { name: "None" }));
    fireEvent.click(modal.getByLabelText("Select practice Alpha Practice 1"));
    fireEvent.click(modal.getByLabelText("Select practice Beta Practice 2"));
    expect(modal.getByRole("status")).toHaveTextContent("$500.00");
    fireEvent.change(modal.getByPlaceholderText("Search practice…"), { target: { value: "Alpha" } });
    expect(modal.getByRole("status")).toHaveTextContent("$300.00");
    fireEvent.change(modal.getByPlaceholderText("Search practice…"), { target: { value: "" } });
    expect(modal.getByRole("status")).toHaveTextContent("$500.00");
    fireEvent.click(modal.getByLabelText("Open balance only"));
    fireEvent.click(modal.getByRole("button", { name: "Select all" }));
    expect(modal.getByLabelText("Select practice Paid Practice")).toBeChecked();
    expect(modal.getByRole("status")).toHaveTextContent("$600.00");
  });

  it("uses the doctor placeholder in review and preserves it in the batch-send payload", async () => {
    const modal = await openModalToReviewAsDoctor();
    const body = modal.getByLabelText("Message body") as HTMLTextAreaElement;

    expect(body.value).toMatch(/^Hello \{\{doctorName\}\},/);

    fireEvent.click(modal.getByRole("button", { name: /Generate & Send/i }));
    await waitFor(() => expect(batchSendBody).not.toBeNull());
    expect(batchSendBody!.recipientType).toBe("doctor");
    expect(batchSendBody!.doctorKeys).toEqual(["prov-1::Dr. Synthetic033"]);
    expect(batchSendBody!.emailBody).toMatch(/^Hello \{\{doctorName\}\},/);
  });

  it("does not replace an edited subject or message when recipient mode changes", async () => {
    const modal = await openModalToRecipients();
    fireEvent.click(modal.getByRole("button", { name: "Next" }));
    fireEvent.click(modal.getByRole("button", { name: "Next" }));

    const subject = await modal.findByLabelText("Email subject");
    const body = modal.getByLabelText("Message body");
    fireEvent.change(subject, { target: { value: "My edited subject" } });
    fireEvent.change(body, { target: { value: "My edited message" } });

    fireEvent.click(modal.getByRole("button", { name: /Setup$/ }));
    fireEvent.click(modal.getByRole("button", { name: /^Doctors/ }));
    fireEvent.click(modal.getByRole("button", { name: "Next" }));
    await modal.findByLabelText("Select doctor Dr. Synthetic033");
    fireEvent.click(modal.getByRole("button", { name: "Next" }));
    fireEvent.click(modal.getByRole("button", { name: "Next" }));

    expect((await modal.findByLabelText("Email subject") as HTMLInputElement).value)
      .toBe("My edited subject");
    expect((modal.getByLabelText("Message body") as HTMLTextAreaElement).value)
      .toBe("My edited message");
  });
});
