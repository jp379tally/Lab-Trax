/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import StatementsPage from "@/pages/statements";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { selectCutoffDate } from "../../__tests__/select-cutoff-date";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));

const LAB_ORG = { id: "lab-1", name: "Lab One", type: "lab" };

const PRACTICE_RECIPIENTS = [
  {
    key: "prov-1",
    name: "Alpha Practice 1",
    email: "a1@example.com",
    phone: null,
    statementEmailOptOut: false,
    invoiceCount: 1,
    openBalance: 300,
    totalBilled: 300,
    doctors: [],
  },
  {
    key: "prov-2",
    name: "Beta Practice 2",
    email: "b2@example.com",
    phone: null,
    statementEmailOptOut: false,
    invoiceCount: 1,
    openBalance: 200,
    totalBilled: 200,
    doctors: [],
  },
];

const DOCTOR_RECIPIENTS = [
  {
    key: "doc-1",
    name: "Dr. Alpha One",
    email: "doc1@example.com",
    phone: null,
    statementEmailOptOut: false,
    invoiceCount: 1,
    openBalance: 300,
    totalBilled: 300,
    doctors: [],
  },
  {
    key: "doc-2",
    name: "Dr. Alpha Two",
    email: "doc2@example.com",
    phone: null,
    statementEmailOptOut: false,
    invoiceCount: 1,
    openBalance: 200,
    totalBilled: 200,
    doctors: [],
  },
];

const INVOICES = PRACTICE_RECIPIENTS.map((recipient, index) => ({
  id: `inv-${index + 1}`,
  labOrganizationId: "lab-1",
  providerOrganizationId: recipient.key,
  providerOrganization: { name: recipient.name },
  status: "sent",
  total: String(recipient.totalBilled),
  balanceDue: String(recipient.openBalance),
  createdAt: "2026-06-01T10:00:00.000Z",
}));
const ACCOUNT_SUMMARIES = PRACTICE_RECIPIENTS.map((recipient) => ({
  practiceId: recipient.key,
  practiceName: recipient.key === "prov-1" ? "Alpha Dental" : recipient.name,
  billingEmail: recipient.email,
  phone: recipient.phone,
  openInvoiceCount: recipient.invoiceCount,
  openInvoiceTotal: recipient.openBalance,
  unpaidStatements: [],
  totalOpenBalance: recipient.openBalance,
  overdueBalance: 0,
  invoiceCount: recipient.invoiceCount,
  totalBilled: recipient.totalBilled,
  totalPaid: recipient.totalBilled - recipient.openBalance,
}));

let batchSendBody: Record<string, unknown> | null = null;
let statementEmailBody: Record<string, unknown> | null = null;
let previewBody: Record<string, unknown> | null = null;
let downloadBody: Record<string, unknown> | null = null;
let recipientQueryAsOf: Array<string | null> = [];
let statementSchedule: Record<string, unknown> = {};
let statementScheduleUpdateBody: Record<string, unknown> | null = null;
let statementSettingsTemplate: Record<string, unknown> = {
  emailSubject: null,
  emailBody: null,
  emailReplyTo: null,
};

beforeEach(() => {
  batchSendBody = null;
  statementEmailBody = null;
  previewBody = null;
  downloadBody = null;
  recipientQueryAsOf = [];
  statementSchedule = {};
  statementScheduleUpdateBody = null;
  statementSettingsTemplate = {
    emailSubject: null,
    emailBody: null,
    emailReplyTo: null,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const parsedUrl = new URL(url, "http://localhost");
      const path = parsedUrl.pathname;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      if (path.endsWith("/statements/recipients")) {
        recipientQueryAsOf.push(parsedUrl.searchParams.get("asOf"));
        return json({
          recipients:
            parsedUrl.searchParams.get("mode") === "doctor"
              ? DOCTOR_RECIPIENTS
              : PRACTICE_RECIPIENTS,
        });
      }
      if (path.endsWith("/statements/preview-pdf")) {
        previewBody = init?.body ? JSON.parse(init.body as string) : null;
        return json({ pdf: "preview" });
      }
      if (path.endsWith("/statements/batch-download")) {
        downloadBody = init?.body ? JSON.parse(init.body as string) : null;
        return new Response("zip fixture");
      }
      if (path.endsWith("/statement-runs")) return json([]);
      if (path.endsWith("/statements/batch-send")) {
        batchSendBody = init?.body ? JSON.parse(init.body as string) : null;
        return json({ periodLabel: "June 2026", results: [] });
      }
      if (path.endsWith("/invoices/statements/email")) {
        statementEmailBody = init?.body ? JSON.parse(init.body as string) : null;
        return json({
          sentAt: "2026-09-04T12:00:00.000Z",
          to: "a1@example.com",
          invoiceCount: 1,
        });
      }
      if (path.endsWith("/invoices")) return json(INVOICES);
      if (path.endsWith("/statements/account-summaries"))
        return json(ACCOUNT_SUMMARIES);
      if (path.endsWith("/organizations")) {
        return json([
          LAB_ORG,
          {
            id: "prov-1",
            name: "Alpha Practice 1",
            displayName: "Alpha Dental",
            type: "provider",
            billingEmail: "a1@example.com",
            parentLabOrganizationId: "lab-1",
          },
        ]);
      }
      if (path.endsWith("/statement-schedule")) {
        if (init?.method === "PUT") {
          statementScheduleUpdateBody = init.body
            ? JSON.parse(init.body as string)
            : null;
          statementSchedule = {
            ...statementSchedule,
            ...(statementScheduleUpdateBody ?? {}),
          };
        }
        return json(statementSchedule);
      }
      if (path.endsWith("/admin/templates/statement-email")) {
        return json(statementSettingsTemplate);
      }
      return json({});
    }),
  );
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

async function renderStatementsPage() {
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
  await screen.findByLabelText("Select practice Alpha Dental");
}

async function openGenerateModal(selectedPractice = false) {
  await renderStatementsPage();
  if (selectedPractice) {
    fireEvent.click(screen.getByLabelText("Select practice Alpha Dental"));
  }
  const generateButton = await screen.findByRole("button", {
    name: /Generate Statements/i,
  });
  await waitFor(() =>
    expect((generateButton as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(generateButton);
  const modalRoot = (await screen.findByText("Generate statements")).closest(
    "div.fixed",
  ) as HTMLElement;
  return within(modalRoot);
}

async function advanceToRecipients(
  modal: ReturnType<typeof within>,
  recipientLabel = "Select practice Alpha Practice 1",
) {
  fireEvent.click(modal.getByRole("button", { name: "Next" }));
  await modal.findByLabelText(recipientLabel);
}

async function sendFromRecipients(modal: ReturnType<typeof within>) {
  fireEvent.click(modal.getByRole("button", { name: "Next" }));
  await modal.findByText(/Email \(PDF attachment\)/i);
  fireEvent.click(modal.getByRole("button", { name: "Next" }));
  fireEvent.click(await modal.findByRole("button", { name: /Generate & Send/i }));
  await waitFor(() => expect(batchSendBody).not.toBeNull());
}

function dateInputIn(modal: ReturnType<typeof within>, label: string) {
  return modal.getByText(label).parentElement?.querySelector("input") as
    | HTMLInputElement
    | null;
}

describe("Generate Statements recipient selection lifecycle", () => {
  it("opens on activation, dismisses without a cutoff, and preserves a confirmed date", async () => {
    const modal = await openGenerateModal();
    const scope = modal.getByRole("radio", { name: /Open invoices through a cutoff date/i });
    fireEvent.click(scope);
    const dialog = await screen.findByRole("dialog", { name: "Invoice cutoff date" });
    expect(modal.getByRole("button", { name: "Next", hidden: true })).toBeDisabled();
    expect(modal.getByText("Choose an invoice cutoff date.")).toBeTruthy();
    expect(modal.queryByLabelText("Invoice cutoff date")).toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(modal.getByRole("button", { name: "Next" })).toBeDisabled();

    // An already checked radio must reopen for both mouse and keyboard.
    fireEvent.click(scope);
    await selectCutoffDate("2020-02-29");
    expect(modal.getByText("February 29, 2020")).toBeTruthy();
    expect(modal.getByRole("button", { name: "Next" })).toBeEnabled();
    fireEvent.keyDown(scope, { key: "Enter" });
    expect(await screen.findByRole("button", { name: /February 29th, 2020, selected/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close cutoff calendar" }));
    expect(modal.getByText("February 29, 2020")).toBeTruthy();
    fireEvent.keyDown(scope, { key: " " });
    await screen.findByRole("dialog");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await advanceToRecipients(modal);
    fireEvent.click(modal.getByRole("button", { name: /Setup/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(modal.getByText("February 29, 2020")).toBeTruthy();
    fireEvent.click(modal.getByRole("button", { name: "Change date" }));
    // Leaving this scope also unmounts/closes its popup.
    fireEvent.click(modal.getByRole("radio", { name: /Custom date range/i, hidden: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(dateInputIn(modal, "From")?.type).toBe("date");
    expect(dateInputIn(modal, "To")?.type).toBe("date");
  });
  it("saves the monthly PDF format choice and defaults to one PDF per doctor", async () => {
    statementSchedule = {
      enabled: false,
      dayOfMonth: 0,
      statementFormat: "per_doctor",
      includedOrgIds: null,
      emailSubject: null,
      emailBody: null,
      emailReplyTo: null,
    };
    await renderStatementsPage();

    fireEvent.click(screen.getByRole("button", { name: /Auto-send/i }));
    const modalRoot = (
      await screen.findByText("Auto-send statements")
    ).closest("div.fixed") as HTMLElement;
    const modal = within(modalRoot);
    const perDoctor = modal.getByRole("radio", {
      name: /One PDF per doctor/i,
    });
    const consolidated = modal.getByRole("radio", {
      name: /One consolidated PDF per practice/i,
    });

    expect(perDoctor).toBeChecked();
    expect(consolidated).not.toBeChecked();
    fireEvent.click(consolidated);
    fireEvent.click(modal.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(statementScheduleUpdateBody).toMatchObject({
        statementFormat: "consolidated",
      }),
    );
  });

  it("renders the saved schedule template for a one-off email and keeps it editable", async () => {
    statementSettingsTemplate = {
      emailSubject: "Settings subject should not win",
      emailBody: "Settings body should not win",
      emailReplyTo: "settings@lab.test",
    };
    statementSchedule = {
      emailSubject: "Custom {{practiceName}} / {{periodLabel}} / {{totalBilled}}",
      emailBody: "Balance for {{practiceName}}: {{openBalance}} — {{labName}}",
      emailReplyTo: "billing@lab.test",
    };
    await renderStatementsPage();

    fireEvent.click(screen.getByText("Alpha Dental"));
    await screen.findByRole("button", { name: /Email statement/i });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Email statement/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Email statement/i }));

    await waitFor(() =>
      expect(screen.getAllByText("Email statement")).toHaveLength(2),
    );
    const dialog = screen.getAllByText("Email statement")[1]?.closest(
      "div.fixed",
    ) as HTMLElement;
    const subject = within(dialog).getByText("Subject").parentElement?.querySelector(
      "input",
    ) as HTMLInputElement;
    const message = within(dialog).getByText("Message").parentElement?.querySelector(
      "textarea",
    ) as HTMLTextAreaElement;

    await waitFor(() => {
      expect(subject.value).toMatch(/^Custom Alpha Dental \/ \d{2}\/\d{4} \/ \$300\.00$/);
      expect(message.value).toBe("Balance for Alpha Dental: $300.00 — Lab One");
    });

    fireEvent.change(subject, { target: { value: "One-off subject" } });
    fireEvent.change(message, { target: { value: "One-off message" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Send email/i }));

    await waitFor(() =>
      expect(statementEmailBody).toMatchObject({
        subject: "One-off subject",
        message: "One-off message",
      }),
    );
  });

  it("falls back to the saved Settings template when the schedule template is blank", async () => {
    statementSchedule = {
      emailSubject: null,
      emailBody: null,
      emailReplyTo: null,
    };
    statementSettingsTemplate = {
      emailSubject: "Settings {{practiceName}} / {{totalBilled}}",
      emailBody: "Settings balance: {{openBalance}} — {{labName}}",
      emailReplyTo: "settings@lab.test",
    };
    await renderStatementsPage();

    fireEvent.click(screen.getByText("Alpha Dental"));
    await screen.findByRole("button", { name: /Email statement/i });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Email statement/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Email statement/i }));
    await waitFor(() =>
      expect(screen.getAllByText("Email statement")).toHaveLength(2),
    );
    const dialog = screen.getAllByText("Email statement")[1]?.closest(
      "div.fixed",
    ) as HTMLElement;

    await waitFor(() => {
      expect(within(dialog).getByRole("textbox", { name: "Subject" })).toHaveValue(
        "Settings Alpha Dental / $300.00",
      );
      expect(within(dialog).getByRole("textbox", { name: "Message" })).toHaveValue(
        "Settings balance: $300.00 — Lab One",
      );
    });
  });

  it("preserves a selected practice through timeframe and date changes", async () => {
    const modal = await openGenerateModal(true);

    fireEvent.click(
      modal.getByRole("radio", { name: /Open invoices \(aging highlighted\)/i }),
    );
    await advanceToRecipients(modal);

    expect(
      (modal.getByLabelText("Select practice Alpha Practice 1") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (modal.getByLabelText("Select practice Beta Practice 2") as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(modal.getByText("1 of 2 practices selected")).toBeTruthy();

    fireEvent.click(modal.getByRole("button", { name: /Setup/ }));
    fireEvent.click(modal.getByRole("radio", { name: /Custom date range/i }));
    fireEvent.change(dateInputIn(modal, "From") as HTMLInputElement, {
      target: { value: "2026-01-01" },
    });
    fireEvent.change(dateInputIn(modal, "To") as HTMLInputElement, {
      target: { value: "2026-06-30" },
    });
    await advanceToRecipients(modal);

    expect(
      (modal.getByLabelText("Select practice Alpha Practice 1") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (modal.getByLabelText("Select practice Beta Practice 2") as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(modal.getByText("1 of 2 practices selected")).toBeTruthy();

    fireEvent.click(modal.getByRole("button", { name: /Setup/ }));
    fireEvent.click(
      modal.getByRole("radio", { name: /Open invoices through a cutoff date/i }),
    );
    await selectCutoffDate("2026-06-30");
    await advanceToRecipients(modal);

    expect(
      (modal.getByLabelText("Select practice Alpha Practice 1") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (modal.getByLabelText("Select practice Beta Practice 2") as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(modal.getByText("1 of 2 practices selected")).toBeTruthy();

    await sendFromRecipients(modal);
    expect(batchSendBody).toMatchObject({
      recipientType: "practice",
      practiceIds: ["prov-1"],
      doctorKeys: null,
      asOf: new Date("2026-06-30T23:59:59").toISOString(),
    });
  });

  it("keeps the statement label separate from the cutoff through recipient refresh, preview, and send", async () => {
    const modal = await openGenerateModal();
    const statementLabel = modal.getByLabelText("Statement label") as HTMLInputElement;
    expect(statementLabel.value).toMatch(/^Statement for [A-Z][a-z]+ \d{4}$/);
    expect(statementLabel.value).not.toContain("as of");
    expect(
      modal.getByText(
        "This label appears on the PDF and in the email. It does not control which invoices are included.",
      ),
    ).toBeTruthy();

    fireEvent.change(statementLabel, {
      target: { value: "September balance statement" },
    });
    fireEvent.click(
      modal.getByRole("radio", { name: /Open invoices through a cutoff date/i }),
    );
    await selectCutoffDate("2026-09-30");
    expect(
      modal.getByText("Include open invoices issued on or before September 30, 2026."),
    ).toBeTruthy();

    const initialAsOf = new Date("2026-09-30T23:59:59").toISOString();
    await advanceToRecipients(modal);
    await waitFor(() => expect(recipientQueryAsOf).toContain(initialAsOf));
    expect(modal.getByText("2 of 2 practices selected")).toBeTruthy();

    fireEvent.click(modal.getByRole("button", { name: /Setup/ }));
    expect(modal.getByText("September 30, 2026")).toBeTruthy();
    expect((modal.getByLabelText("Statement label") as HTMLInputElement).value).toBe(
      "September balance statement",
    );
    const queriesBeforeRefresh = recipientQueryAsOf.length;
    fireEvent.click(modal.getByRole("button", { name: "Change date" }));
    expect(screen.getByRole("button", { name: /September 30th, 2026, selected/ })).toBeTruthy();
    await selectCutoffDate("2026-09-29");
    expect(modal.getByText("September 29, 2026")).toBeTruthy();
    const expectedAsOf = new Date("2026-09-29T23:59:59").toISOString();
    await waitFor(() =>
      expect(recipientQueryAsOf.length).toBeGreaterThan(queriesBeforeRefresh),
    );
    expect(recipientQueryAsOf.at(-1)).toBe(expectedAsOf);
    await advanceToRecipients(modal);
    expect(modal.getByText("2 of 2 practices selected")).toBeTruthy();

    fireEvent.click(modal.getByRole("button", { name: "Next" }));
    await modal.findByText(/Email \(PDF attachment\)/i);
    fireEvent.click(modal.getByText("Download ZIP"));
    fireEvent.click(modal.getByRole("button", { name: "Next" }));
    await modal.findByText(/Review each practice's recipients/i);

    expect(modal.getByText("Statement label")).toBeTruthy();
    expect(modal.getByText("September balance statement")).toBeTruthy();
    expect(modal.getByText("Invoice cutoff")).toBeTruthy();
    expect(modal.getByText("September 29, 2026")).toBeTruthy();

    fireEvent.click(modal.getAllByTitle("Preview PDF")[0]!);
    await waitFor(() => expect(previewBody).not.toBeNull());
    expect(previewBody).toMatchObject({
      invoiceScope: "open_as_of",
      asOf: expectedAsOf,
      periodLabel: "September balance statement",
    });

    fireEvent.click(await modal.findByRole("button", { name: /Generate & Send/i }));
    await waitFor(() => expect(batchSendBody).not.toBeNull());
    expect(batchSendBody).toMatchObject({
      invoiceScope: "open_as_of",
      asOf: expectedAsOf,
      periodLabel: "September balance statement",
    });
    await waitFor(() => expect(downloadBody).toMatchObject({
      invoiceScope: "open_as_of",
      asOf: expectedAsOf,
      periodLabel: "September balance statement",
    }));
  });

  it("defaults to all recipients when the wizard opens without a table selection", async () => {
    const modal = await openGenerateModal();
    await advanceToRecipients(modal);

    expect(
      (modal.getByLabelText("Select practice Alpha Practice 1") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (modal.getByLabelText("Select practice Beta Practice 2") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(modal.getByText("2 of 2 practices selected")).toBeTruthy();
  });

  it("resets to the doctor key set when switching recipient modes", async () => {
    const modal = await openGenerateModal(true);

    fireEvent.click(modal.getByRole("button", { name: /Doctors/i }));
    await advanceToRecipients(modal, "Select doctor Dr. Alpha One");

    expect(
      (modal.getByLabelText("Select doctor Dr. Alpha One") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (modal.getByLabelText("Select doctor Dr. Alpha Two") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(modal.getByText("2 of 2 doctors selected")).toBeTruthy();

    await sendFromRecipients(modal);
    expect(batchSendBody).toMatchObject({
      recipientType: "doctor",
      practiceIds: null,
      doctorKeys: ["doc-1", "doc-2"],
    });
  });
});