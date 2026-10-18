/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import StatementsPage from "@/pages/statements";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { selectCutoffDate } from "../../__tests__/select-cutoff-date";

/**
 * Task 4794: Practices mode sends ONE email per billing practice carrying a
 * SEPARATE statement PDF per selected doctor. The wizard must therefore:
 *
 *  - count practice emails separately from doctor statement PDFs,
 *  - list each practice's recipients and doctor attachments on Review,
 *  - let the user add/remove recipient addresses for this send only, and
 *  - carry the doctor selection and the chosen recipients on every
 *    batch-send payload, including "Retry failed".
 */

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));

const LAB_ORG = { id: "lab-1", name: "Lab One", type: "lab" };

const DOCTORS = [
  { key: "Dr. Adams", name: "Dr. Adams", email: null, phone: null, invoiceCount: 1, totalBilled: 100, openBalance: 100 },
  { key: "Dr. Brown", name: "Dr. Brown", email: null, phone: null, invoiceCount: 1, totalBilled: 200, openBalance: 200 },
  { key: "Dr. Chen", name: "Dr. Chen", email: null, phone: null, invoiceCount: 1, totalBilled: 300, openBalance: 300 },
  { key: "Dr. Diaz", name: "Dr. Diaz", email: null, phone: null, invoiceCount: 1, totalBilled: 400, openBalance: 400 },
];

// One billing practice with four doctors and two saved billing addresses.
const RECIPIENTS = [
  {
    key: "org-a",
    name: "Sunrise Dental",
    email: "billing@sunrise.example",
    phone: null,
    statementEmailOptOut: false,
    invoiceCount: 4,
    openBalance: 1000,
    totalBilled: 1000,
    recipientEmails: ["billing@sunrise.example", "ap@sunrise.example"],
    doctors: DOCTORS,
  },
];

const INVOICES = DOCTORS.map((doc, i) => ({
  id: `inv-${i + 1}`,
  labOrganizationId: "lab-1",
  providerOrganizationId: "org-a",
  providerOrganization: { name: "Sunrise Dental" },
  status: "sent",
  total: String(doc.totalBilled),
  balanceDue: String(doc.openBalance),
  createdAt: "2026-06-01T10:00:00.000Z",
}));

const ACCOUNT_SUMMARIES = [
  {
    practiceId: "org-a",
    practiceName: "Sunrise Dental",
    billingEmail: "billing@sunrise.example",
    phone: null,
    openInvoiceCount: 4,
    openInvoiceTotal: 1000,
    unpaidStatements: [],
    totalOpenBalance: 1000,
    overdueBalance: 0,
  },
];

/** Recipient fixtures the mocked API serves; a test may narrow this. */
let recipientsFixture: Array<Record<string, any>> = RECIPIENTS;
let batchSendBodies: Array<Record<string, any>> = [];
/** Email status the mocked batch-send reports back, per call index. */
let batchSendEmailStatus: Array<"sent" | "failed"> = [];
/** Non-GET requests, so a test can prove saved contacts were left alone. */
let writeRequests: Array<{ method: string; path: string; body: unknown }> = [];
let recipientQueries: URLSearchParams[] = [];
let recipientResponse: ((params: URLSearchParams) => Promise<Response>) | null = null;

beforeEach(() => {
  recipientsFixture = RECIPIENTS;
  batchSendBodies = [];
  batchSendEmailStatus = [];
  writeRequests = [];
  recipientQueries = [];
  recipientResponse = null;
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
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET") {
        writeRequests.push({
          method,
          path,
          body: init?.body ? JSON.parse(init.body as string) : null,
        });
      }
      if (path.endsWith("/statements/recipients")) {
        const params = new URL(url, "http://localhost").searchParams;
        recipientQueries.push(params);
        if (recipientResponse) return recipientResponse(params);
        const mode = params.get("mode");
        return json({ recipients: mode === "doctor" ? [] : recipientsFixture });
      }
      if (path.endsWith("/statements/preview-pdf")) {
        return new Response("%PDF-1.7 fixture", {
          headers: { "Content-Type": "application/pdf" },
        });
      }
      if (path.endsWith("/statements/batch-send")) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        const index = batchSendBodies.length;
        batchSendBodies.push(body);
        return json({
          periodLabel: "June 2026",
          results: (body.practiceIds ?? []).map((id: string) => {
            // Mirrors the server: an explicit per-send recipient list is
            // authoritative — an empty one skips the practice instead of
            // falling back to saved contacts, which are used otherwise.
            const override = body.recipientEmails?.[id];
            const saved =
              recipientsFixture.find((r) => r.key === id)?.recipientEmails ?? [];
            const effective = Array.isArray(override) ? override : saved;
            const emailStatus =
              effective.length === 0
                ? "skipped"
                : (batchSendEmailStatus[index] ?? "sent");
            return {
              practiceId: id,
              practiceName: "Sunrise Dental",
              emailStatus,
              emailError:
                emailStatus === "failed"
                  ? "smtp rejected"
                  : emailStatus === "skipped"
                    ? "No recipient addresses selected for this practice"
                    : null,
              smsStatus: null,
              smsError: null,
              runId: `run-${index}-${id}`,
              // A skipped practice never got as far as issuing documents,
              // so only a rendered bundle can be replayed.
              statementId: emailStatus === "skipped" ? null : `stmt-${index}-${id}`,
              replayable: emailStatus !== "skipped",
            };
          }),
        });
      }
      if (path.endsWith("/invoices")) return json(INVOICES);
      if (path.endsWith("/statements/account-summaries")) return json(ACCOUNT_SUMMARIES);
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

/** Opens the Generate Statements modal on step 1 (Setup). */
async function openModal() {
  localStorage.setItem("labtrax_finance_org_v1", "lab-1");
  const Wrapper = makeAuthWrapper("/statements", {
    user: { id: "u1", username: "admin", role: "admin", userType: "lab" } as any,
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
  return within(modalRoot);
}

/** Setup → recipient selection (everything is selected by default). */
async function toRecipients(modal: ReturnType<typeof within>) {
  fireEvent.click(modal.getByRole("button", { name: "Next" }));
  await modal.findByLabelText("Select practice Sunrise Dental");
}

/** Recipient selection → delivery → review. */
async function toReview(modal: ReturnType<typeof within>) {
  fireEvent.click(modal.getByRole("button", { name: "Next" }));
  await modal.findByText(/Email \(PDF attachment\)/i);
  fireEvent.click(modal.getByRole("button", { name: "Next" }));
  await modal.findByText(/Review each practice's recipients/i);
}

describe("Statements wizard — practice bundles", () => {
  it("totals selected doctor open balances once, including fractional amounts and documentless practices", async () => {
    recipientsFixture = [
      {
        ...RECIPIENTS[0]!,
        openBalance: 999,
        totalBilled: 9000,
        doctors: DOCTORS.map((doctor, i) => ({
          ...doctor,
          totalBilled: 1000,
          openBalance: [10.01, 20.02, 30.03, 40.04][i],
        })),
      },
      { ...RECIPIENTS[0]!, key: "org-b", name: "Documentless", doctors: [], openBalance: 0.10, totalBilled: 500 },
      { ...RECIPIENTS[0]!, key: "org-c", name: "Fractional", doctors: [], openBalance: 0.20, totalBilled: 600 },
    ];
    const modal = await openModal();
    await toRecipients(modal);
    const summary = modal.getByRole("status", { name: "Total Generated Statement Amount" });
    expect(summary).toHaveTextContent("$100.40");
    fireEvent.click(modal.getByTitle("Expand doctors"));
    fireEvent.click(modal.getByLabelText("Dr. Chen"));
    expect(summary).toHaveTextContent("$70.37");
    fireEvent.click(modal.getByLabelText("Select practice Documentless"));
    expect(summary).toHaveTextContent("$70.27");
    for (const name of ["Dr. Adams", "Dr. Brown", "Dr. Diaz"]) {
      fireEvent.click(modal.getByLabelText(name));
    }
    expect(summary).toHaveTextContent("$0.20");
    fireEvent.click(modal.getByRole("button", { name: "None" }));
    expect(summary).toHaveTextContent("$0.00");
    fireEvent.click(modal.getByRole("button", { name: "Select all" }));
    expect(summary).toHaveTextContent("$100.40");
  });

  it("shows unknown totals while loading or failed, and preserves doctor choices after a cutoff refresh", async () => {
    const modal = await openModal();
    await toRecipients(modal);
    fireEvent.click(modal.getByTitle("Expand doctors"));
    fireEvent.click(modal.getByLabelText("Dr. Chen"));
    expect(modal.getByRole("status")).toHaveTextContent("$700.00");

    fireEvent.click(modal.getByRole("button", { name: /Setup$/ }));
    let resolveResponse!: (response: Response) => void;
    recipientResponse = () => new Promise((resolve) => { resolveResponse = resolve; });
    fireEvent.click(modal.getByRole("radio", { name: /Open invoices through a cutoff date/i }));
    await selectCutoffDate("2026-09-30");
    fireEvent.click(modal.getByRole("button", { name: "Next" }));
    expect(modal.getByRole("status")).toHaveTextContent("Calculating…");
    expect(modal.getByRole("status")).not.toHaveTextContent("$0.00");
    await waitFor(() => expect(resolveResponse).toBeDefined());
    resolveResponse(new Response(JSON.stringify({
      recipients: [{
        ...RECIPIENTS[0]!,
        totalBilled: 10000,
        openBalance: 1000,
        doctors: DOCTORS.map((doctor) => ({ ...doctor, totalBilled: 2500, openBalance: doctor.openBalance / 10 })),
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await waitFor(() => expect(modal.getByRole("status")).toHaveTextContent("$70.00"));
    expect(modal.getByLabelText("Dr. Chen")).not.toBeChecked();

    fireEvent.click(modal.getByRole("button", { name: /Setup$/ }));
    recipientResponse = async () => new Response(JSON.stringify({ message: "Failed" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
    fireEvent.click(modal.getByRole("button", { name: "Change date" }));
    await selectCutoffDate("2026-08-31");
    fireEvent.click(modal.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(modal.getByRole("status")).toHaveTextContent("Unavailable"));
    expect(modal.getByRole("status")).not.toHaveTextContent("$0.00");
  });

  it("retains all 19 September-cutoff practices through select-all, review, preview and generation", async () => {
    recipientsFixture = Array.from({ length: 19 }, (_, i) => ({
      ...RECIPIENTS[0]!,
      key: `practice-${i + 1}`,
      name: `Cutoff Practice ${i + 1}`,
      email: `practice-${i + 1}@example.invalid`,
      recipientEmails: [`practice-${i + 1}@example.invalid`],
      invoiceCount: 3, totalBilled: 300, openBalance: 300,
      doctors: [
        { ...DOCTORS[0]!, key: "Dr. Shared", name: "Dr. Shared" },
        { ...DOCTORS[0]!, key: "Dr. Missing", name: "Dr. Missing" },
        { ...DOCTORS[0]!, key: "__no_doctor__", name: "No doctor assigned" },
      ],
    }));
    const modal = await openModal();
    fireEvent.click(modal.getByRole("radio", { name: /Open invoices through a cutoff date/i }));
    await selectCutoffDate("2026-09-30");
    const asOf = new Date("2026-09-30T23:59:59").toISOString();
    fireEvent.click(modal.getByRole("button", { name: "Next" }));
    await modal.findByLabelText("Select practice Cutoff Practice 19");
    expect(recipientQueries.at(-1)?.get("scope")).toBe("open_as_of");
    expect(recipientQueries.at(-1)?.get("asOf")).toBe(asOf);
    fireEvent.click(modal.getByRole("button", { name: "None" }));
    fireEvent.click(modal.getByRole("button", { name: "Select all" }));
    expect(modal.getByText("19 of 19 practices selected")).toBeTruthy();
    expect(modal.getByText("19 practice emails · 57 statement PDFs")).toBeTruthy();
    for (const recipient of recipientsFixture) {
      expect(modal.getByLabelText(`Select practice ${recipient.name}`)).toBeChecked();
    }
    await toReview(modal);
    expect(modal.getAllByText("3 statement PDFs attached")).toHaveLength(19);
    expect(modal.getAllByLabelText("Preview Dr. Shared statement")).toHaveLength(19);
    expect(modal.getAllByLabelText("Preview Dr. Missing statement")).toHaveLength(19);
    expect(modal.getAllByLabelText("Preview No doctor assigned statement")).toHaveLength(19);
    fireEvent.click(modal.getAllByLabelText("Preview Dr. Shared statement")[18]!);
    await waitFor(() =>
      expect(writeRequests.find((r) => r.path.endsWith("/statements/preview-pdf"))?.body)
        .toMatchObject({
          recipientType: "practice", recipientKey: "practice-19",
          documentKey: "Dr. Shared", invoiceScope: "open_as_of", asOf,
        }),
    );
    fireEvent.click(modal.getByRole("button", { name: /Generate & Send/i }));
    await waitFor(() => expect(batchSendBodies).toHaveLength(1));
    expect(batchSendBodies[0]).toMatchObject({
      recipientType: "practice", invoiceScope: "open_as_of", asOf,
      practiceIds: recipientsFixture.map((r) => r.key),
    });
    // No overrides means saved billing contacts and every qualifying doctor
    // document, not an explicit empty list that would suppress delivery.
    expect(batchSendBodies[0]!.recipientEmails).toBeUndefined();
    expect(batchSendBodies[0]!.doctorFilters).toBeUndefined();
  });

  it("counts practice emails separately from doctor PDFs and lists every attachment", async () => {
    const modal = await openModal();
    await toRecipients(modal);

    fireEvent.click(modal.getByTitle("Expand doctors"));
    fireEvent.click(await modal.findByLabelText("Dr. Chen"));

    // One email either way, but one fewer attachment.
    expect(modal.getByText("1 practice email · 3 statement PDFs")).toBeTruthy();

    await toReview(modal);
    expect(modal.getByText("3 statement PDFs attached")).toBeTruthy();
    expect(modal.queryByLabelText("Preview Dr. Chen statement")).toBeNull();
    expect(modal.getByLabelText("Preview Dr. Adams statement")).toBeTruthy();

    fireEvent.click(modal.getByRole("button", { name: /Generate & Send/i }));
    await waitFor(() => expect(batchSendBodies).toHaveLength(1));
    expect(batchSendBodies[0]!.doctorFilters).toEqual({
      "org-a": ["Dr. Adams", "Dr. Brown", "Dr. Diaz"],
    });
  });

  it("adds and removes recipients for this send only and keeps them across navigation", async () => {
    const modal = await openModal();
    await toRecipients(modal);
    await toReview(modal);

    // Remove a saved address for this send.
    fireEvent.click(
      modal.getByLabelText("Remove ap@sunrise.example from Sunrise Dental"),
    );
    expect(modal.queryByText("ap@sunrise.example")).toBeNull();

    // An invalid address is refused rather than silently dropped later.
    fireEvent.click(modal.getByRole("button", { name: "+ Add email" }));
    const input = modal.getByLabelText("Add recipient for Sunrise Dental");
    fireEvent.change(input, { target: { value: "not-an-email" } });
    fireEvent.click(modal.getByRole("button", { name: "Add" }));
    expect(modal.getByText("Enter a valid email address.")).toBeTruthy();

    fireEvent.change(modal.getByLabelText("Add recipient for Sunrise Dental"), {
      target: { value: "office@sunrise.example" },
    });
    fireEvent.click(modal.getByRole("button", { name: "Add" }));
    expect(modal.getByText("office@sunrise.example")).toBeTruthy();

    // Step back to Setup and forward again — the per-send list survives.
    fireEvent.click(modal.getByRole("button", { name: /Setup$/ }));
    await modal.findByText(
      "One email per billing practice, with a separate statement PDF for each selected doctor.",
    );
    await toRecipients(modal);
    await toReview(modal);
    expect(modal.getByText("office@sunrise.example")).toBeTruthy();
    expect(modal.queryByText("ap@sunrise.example")).toBeNull();

    fireEvent.click(modal.getByRole("button", { name: /Generate & Send/i }));
    await waitFor(() => expect(batchSendBodies).toHaveLength(1));
    // The removed address is genuinely excluded — not reintroduced as a CC.
    expect(batchSendBodies[0]!.recipientEmails).toEqual({
      "org-a": ["billing@sunrise.example", "office@sunrise.example"],
    });
    expect(batchSendBodies[0]!.practiceIds).toEqual(["org-a"]);
    expect(batchSendBodies[0]!.recipientType).toBe("practice");
  });

  it("drops a deselected doctor from the counts, the review list, and the payload", async () => {
    const modal = await openModal();
    await toRecipients(modal);

    fireEvent.click(modal.getByTitle("Expand doctors"));
    fireEvent.click(await modal.findByLabelText("Dr. Chen"));

    // One email either way, but one fewer attachment.
    expect(modal.getByText("1 practice email · 3 statement PDFs")).toBeTruthy();

    await toReview(modal);
    expect(modal.getByText("3 statement PDFs attached")).toBeTruthy();
    expect(modal.queryByLabelText("Preview Dr. Chen statement")).toBeNull();
    expect(modal.getByLabelText("Preview Dr. Adams statement")).toBeTruthy();

    fireEvent.click(modal.getByRole("button", { name: /Generate & Send/i }));
    await waitFor(() => expect(batchSendBodies).toHaveLength(1));
    expect(batchSendBodies[0]!.doctorFilters).toEqual({
      "org-a": ["Dr. Adams", "Dr. Brown", "Dr. Diaz"],
    });
  });

  it("retries a failed practice with the same doctor selection and recipient list", async () => {
    batchSendEmailStatus = ["failed", "sent"];
    const modal = await openModal();
    await toRecipients(modal);

    fireEvent.click(modal.getByTitle("Expand doctors"));
    fireEvent.click(await modal.findByLabelText("Dr. Diaz"));

    await toReview(modal);
    fireEvent.click(
      modal.getByLabelText("Remove billing@sunrise.example from Sunrise Dental"),
    );
    fireEvent.click(modal.getByRole("button", { name: /Generate & Send/i }));

    await waitFor(() => expect(batchSendBodies).toHaveLength(1));
    const retryBtn = await modal.findByRole("button", { name: /Retry failed/i });
    fireEvent.click(retryBtn);

    await waitFor(() => expect(batchSendBodies).toHaveLength(2));
    // The retry reproduces the original bundle exactly — same practices,
    // same doctor selection, same per-send recipients, same scope/label —
    // and re-sends the documents that practice was already issued rather
    // than rebuilding them from invoices that may have changed since.
    const { replayRuns, ...retried } = batchSendBodies[1]!;
    expect(retried).toEqual(batchSendBodies[0]);
    expect(replayRuns).toEqual({ "org-a": "run-0-org-a" });
    expect(batchSendBodies[1]!.recipientEmails).toEqual({
      "org-a": ["ap@sunrise.example"],
    });
    expect(batchSendBodies[1]!.doctorFilters).toEqual({
      "org-a": ["Dr. Adams", "Dr. Brown", "Dr. Chen"],
    });
  });

  it("recovers a practice skipped for having no recipients by adding one to this send", async () => {
    const modal = await openModal();
    await toRecipients(modal);
    await toReview(modal);

    fireEvent.click(modal.getByLabelText("Remove billing@sunrise.example from Sunrise Dental"));
    fireEvent.click(modal.getByLabelText("Remove ap@sunrise.example from Sunrise Dental"));
    fireEvent.click(modal.getByRole("button", { name: /Generate & Send/i }));
    await waitFor(() => expect(batchSendBodies).toHaveLength(1));
    const skipped = await modal.findByRole("button", { name: "Skipped" });

    fireEvent.click(skipped);
    const input = await modal.findByLabelText("Recipient email for Sunrise Dental");
    fireEvent.change(input, { target: { value: "office@sunrise.example" } });
    expect(
      modal.getByText(
        "Added to this send's recipients only — saved contacts are unchanged.",
      ),
    ).toBeTruthy();
    fireEvent.click(modal.getByRole("button", { name: "Save" }));

    const sendNow = await modal.findByRole("button", { name: "Send now" });
    fireEvent.click(sendNow);
    await waitFor(() => expect(batchSendBodies).toHaveLength(2));

    // …so "Send now" actually sends instead of skipping again.
    expect(batchSendBodies[1]!.practiceIds).toEqual(["org-a"]);
    expect(batchSendBodies[1]!.recipientEmails).toEqual({
      "org-a": ["office@sunrise.example"],
    });
    await waitFor(() =>
      expect(modal.queryByRole("button", { name: "Skipped" })).toBeNull(),
    );

    // The practice's saved contacts were never rewritten.
    expect(
      writeRequests.filter((r) => r.path.includes("/organizations/")),
    ).toEqual([]);
  });

  it("rescues a practice with no saved billing address without editing its contact record", async () => {
    // Nothing is prefilled for this practice, so the address the user types
    // in Results is the first one it has — and still belongs to this send.
    recipientsFixture = [
      { ...RECIPIENTS[0]!, email: null, recipientEmails: [] },
    ];
    const modal = await openModal();
    await toRecipients(modal);
    await toReview(modal);

    fireEvent.click(modal.getByRole("button", { name: /Generate & Send/i }));
    await waitFor(() => expect(batchSendBodies).toHaveLength(1));
    const skipped = await modal.findByRole("button", { name: "Skipped" });

    fireEvent.click(skipped);
    const input = await modal.findByLabelText("Recipient email for Sunrise Dental");
    fireEvent.change(input, { target: { value: "office@sunrise.example" } });
    expect(
      modal.getByText(
        "Added to this send's recipients only — saved contacts are unchanged.",
      ),
    ).toBeTruthy();
    fireEvent.click(modal.getByRole("button", { name: "Save" }));

    const sendNow = await modal.findByRole("button", { name: "Send now" });
    fireEvent.click(sendNow);
    await waitFor(() => expect(batchSendBodies).toHaveLength(2));

    expect(batchSendBodies[1]!.recipientEmails).toEqual({
      "org-a": ["office@sunrise.example"],
    });
    // Nothing was issued for the skipped practice, so the resend builds the
    // statement rather than replaying documents that do not exist.
    expect(batchSendBodies[1]!.replayRuns).toBeUndefined();
    // The saved practice contact is untouched — the address was never
    // written to the organization record.
    expect(
      writeRequests.filter((r) => r.path.includes("/organizations/")),
    ).toEqual([]);
  });
});
