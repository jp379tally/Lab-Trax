/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import RecoveryBillingPage from "../recovery-billing";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import type { SessionUser } from "@/lib/api";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
const refresh = vi.hoisted(() => ({ sales: vi.fn(), balances: vi.fn() }));
vi.mock("@/lib/api", () => ({
  apiFetch: api.fetch, apiUrl: (url: string) => url, authedMediaFetch: vi.fn(),
}));
vi.mock("@/lib/refresh-case-finance", () => ({
  refreshInvoiceSalesQueries: refresh.sales, refreshCustomerBalanceQueries: refresh.balances,
}));
const caseId = "fixture-recovered-case";
const row = {
  caseId, caseNumber: "fixture-number", patientName: "Isolated Fixture",
  doctorName: "Fixture Doctor", historicalDate: "2026-01-18", state: "needs_prescription_review",
  prescriptions: [{ id: "rx", fileName: "fixture.pdf" }, { id: "rx2", fileName: "second-fixture.pdf" }],
  invoice: null, proposal: null, proposalId: null,
};
const pricing = (total = "210.00", exceptions: string[] = []) => ({
  rows: [{ id: "work-1", toothNumber: "19", restorationType: "Crown & Bridge", restorationSubtype: null, arch: null,
    material: "Zirconia", shade: "A2", quantity: 1, unitPrice: "185.00", priceSource: "tier", priceSourceId: "tier-1",
    priceSourceName: "Gold", priceKey: "zirconia" }],
  lines: [{ description: "Zirconia crown #19", quantity: 1, unitPrice: "185.00", lineTotal: "185.00",
    childItems: [{ description: "Custom shade", quantity: 1, unitPrice: "25.00", lineTotal: "25.00" }] }],
  total, exceptions, pricingAt: "2026-10-09T15:00:00.000Z", pricingBasis: "current_catalog", persisted: false,
});
const proposal = (exceptions: string[] = []) => ({ ...pricing("210.00", exceptions), version: 1, previousInvoiceId: null });
const proposed = { ...row, state: "proposed", proposal: proposal(), proposalId: "proposal-1" };
const heldInvoice = {
  id: "invoice-1", invoiceNumber: "REC-SYNTH-001", status: "recovery_draft", total: "210.00", balanceDue: "0.00", dueAt: null,
  recoveryBilling: { state: "held", proposalId: "proposal-1" },
};
const held = { ...proposed, state: "held", invoice: heldInvoice };
const released = { ...proposed, state: "released", invoice: { ...heldInvoice, status: "open", balanceDue: "210.00",
  dueAt: "2026-11-10T00:00:00.000Z", recoveryBilling: { state: "released", proposalId: "proposal-1" } } };

/** Requests other than the debounced price preview, in order. */
const urls = () => api.fetch.mock.calls.map(([url]) => String(url)).filter((url) => !url.endsWith("/preview"));

type Handler = (body: never) => unknown;
/** Routes the page's requests; `role` is the signed-in member's role in the recovery lab. */
function serve(routes: Record<string, Handler>, role: string | null = null, available = true) {
  api.fetch.mockImplementation(async (url: string, init?: { body?: string }) => {
    if (url === "/billing-recovery/access") {
      return { available, role: role === "owner" || role === "admin" ? "admin" : "staff" };
    }
    const handler = url === "/billing-recovery" ? routes.list : routes[url.replace(`/billing-recovery/cases/${caseId}/`, "")];
    if (!handler) throw new Error(`Unexpected request ${url}`);
    return handler((init?.body ? JSON.parse(init.body) : undefined) as never);
  });
}
const renderSignedIn = () => render(<RecoveryBillingPage />, {
  wrapper: makeAuthWrapper("/", { user: { id: "fixture-user" } as SessionUser, status: "authed" }),
});

async function open() {
  renderSignedIn();
  fireEvent.click(await screen.findByTestId(`button-propose-${caseId}`));
  fireEvent.change(screen.getByTestId("input-type-0"), { target: { value: "Manual Crown" } });
  fireEvent.change(screen.getByTestId("input-tooth-0"), { target: { value: "8" } });
  fireEvent.change(screen.getByTestId("input-review-notes"), { target: { value: "Manual review notes" } });
  for (const review of ["rx", "identity", "duplicate"]) fireEvent.click(screen.getByTestId(`check-${review}`));
  expect(screen.getByTestId("button-submit-proposal")).toBeEnabled();
}

describe("Recovery Billing prescription analysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetch.mockImplementation(async (url: string) => {
      if (url === "/billing-recovery/access") return { available: true, role: "staff" };
      if (url === "/billing-recovery") return { rows: [row], timezone: "America/New_York" };
      if (url.endsWith("/preview")) return pricing();
      throw new Error("PDF analysis is unavailable. Ask an administrator to check the PDF converter.");
    });
  });

  it("keeps manual rows and notes on failure and makes no proposal, charge or release", async () => {
    await open();
    fireEvent.click(screen.getByTestId("button-analyze"));
    expect(await screen.findByTestId("error-analyze")).toHaveTextContent("check the PDF converter");
    expect(screen.getByTestId("input-type-0")).toHaveValue("Manual Crown");
    expect(screen.getByTestId("input-tooth-0")).toHaveValue("8");
    expect(screen.getByTestId("input-review-notes")).toHaveValue("Manual review notes");
    expect(screen.queryByTestId("analysis-exceptions")).not.toBeInTheDocument();
    expect(urls()).toEqual([
      "/billing-recovery/access", "/billing-recovery", `/billing-recovery/cases/${caseId}/analyze`,
    ]);
  });
  it("fills extracted rows, displays exceptions and requires every review again on success", async () => {
    await open();
    api.fetch.mockResolvedValueOnce({
      analysisId: "audit", restorations: [{ restorationType: "Crown & Bridge", toothNumber: "19", material: "Zirconia", quantity: 1 }],
      exceptions: ["Review the bridge topology."],
    });
    fireEvent.click(screen.getByTestId("button-analyze"));
    expect(await screen.findByTestId("analysis-exceptions")).toHaveTextContent("Review the bridge topology.");
    expect(screen.getByTestId("input-type-0")).toHaveValue("Crown & Bridge");
    expect(screen.getByTestId("input-tooth-0")).toHaveValue("19");
    for (const review of ["rx", "identity", "duplicate"]) expect(screen.getByTestId(`check-${review}`)).toHaveAttribute("data-state", "unchecked");
    expect(screen.getByTestId("button-submit-proposal")).toBeDisabled();
    expect(urls()).toEqual([
      "/billing-recovery/access", "/billing-recovery", `/billing-recovery/cases/${caseId}/analyze`,
    ]);
    const analyzed = api.fetch.mock.calls.find(([url]) => String(url).endsWith("/analyze"));
    expect(JSON.parse(analyzed![1].body)).toEqual({ evidenceAttachmentId: "rx" });
    // The analyzed work is priced before staging.
    expect(await screen.findByTestId("preview-price")).toHaveTextContent("Current-rate replacement: $210.00");
  });
  it("keeps manual rows for empty extraction but resets confirmations and shows review exceptions", async () => {
    await open();
    api.fetch.mockResolvedValueOnce({ analysisId: "audit", restorations: [], exceptions: ["No explicit work extracted."] });
    fireEvent.click(screen.getByTestId("button-analyze"));
    await screen.findByTestId("analysis-exceptions");
    expect(screen.getByTestId("input-type-0")).toHaveValue("Manual Crown");
    expect(screen.getByTestId("button-submit-proposal")).toBeDisabled();
  });
  it("blocks evidence edits and staging while analysis is pending, then restores manual work on rejection", async () => {
    await open();
    let reject!: (error: Error) => void;
    api.fetch.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    fireEvent.click(screen.getByTestId("button-analyze"));
    await waitFor(() => expect(screen.getByTestId("button-submit-proposal")).toBeDisabled());
    expect(screen.getByTestId("stage-missing")).toHaveTextContent("Wait for the analysis to finish");
    expect(screen.getByTestId("select-evidence")).toBeDisabled();
    expect(screen.getByTestId("input-type-0")).toBeDisabled();
    reject(new Error("Analysis could not be recorded. Retry shortly."));
    await screen.findByTestId("error-analyze");
    expect(screen.getByTestId("input-type-0")).toHaveValue("Manual Crown");
    expect(screen.getByTestId("input-type-0")).toBeEnabled();
  });
  it("requires renewed review when the selected evidence changes", async () => {
    await open();
    fireEvent.change(screen.getByTestId("select-evidence"), { target: { value: "rx2" } });
    expect(screen.getByTestId("button-submit-proposal")).toBeDisabled();
    expect(screen.getByTestId("input-type-0")).toHaveValue("Manual Crown");
    for (const review of ["rx", "identity", "duplicate"]) expect(screen.getByTestId(`check-${review}`)).toHaveAttribute("data-state", "unchecked");
  });
});

describe("Recovery Billing staging hints and price preview", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("names exactly what blocks staging next to the disabled button", async () => {
    serve({ list: () => ({ rows: [row] }), preview: () => pricing() });
    renderSignedIn();
    const opener = await screen.findByTestId(`button-propose-${caseId}`);
    expect(opener).toHaveTextContent("Enter prescription work");
    fireEvent.click(opener);
    const submit = screen.getByTestId("button-submit-proposal");
    expect(submit).toHaveTextContent("Stage proposal");
    expect(submit).toBeDisabled();
    const missing = () => within(screen.getByTestId("stage-missing")).getAllByRole("listitem").map((item) => item.textContent);
    expect(missing()).toEqual([
      "Give every work row a type", "Confirm you reviewed the prescription", "Confirm doctor and practice identity",
      "Confirm you checked for duplicate work", "Add review notes",
    ]);
    expect(submit).toHaveAttribute("aria-describedby", screen.getByTestId("stage-missing").id);
    expect(screen.getByLabelText(/Review notes/)).toHaveAttribute("aria-required", "true");
    expect(screen.getByText("(required)")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("input-type-0"), { target: { value: "Crown & Bridge" } });
    for (const review of ["rx", "identity", "duplicate"]) fireEvent.click(screen.getByTestId(`check-${review}`));
    expect(missing()).toEqual(["Add review notes"]);
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId("input-review-notes"), { target: { value: "Checked against the prescription." } });
    expect(screen.queryByTestId("stage-missing")).not.toBeInTheDocument();
    expect(submit).toBeEnabled();
    expect(submit).not.toHaveAttribute("aria-describedby");
    fireEvent.change(screen.getByTestId("select-evidence"), { target: { value: "" } });
    expect(missing()).toContain("Select the prescription");
    expect(submit).toBeDisabled();
  });
  it("shows the current-catalog replacement price for the entered work without saving anything", async () => {
    const bodies: unknown[] = [];
    serve({ list: () => ({ rows: [row] }), preview: (body) => { bodies.push(body); return pricing(); } });
    renderSignedIn();
    fireEvent.click(await screen.findByTestId(`button-propose-${caseId}`));
    expect(screen.getByTestId("preview-idle")).toHaveTextContent("once every work row has a type");
    fireEvent.change(screen.getByTestId("input-type-0"), { target: { value: "Crown & Bridge" } });
    fireEvent.change(screen.getByTestId("input-tooth-0"), { target: { value: "19" } });
    const panel = await screen.findByTestId("preview-price");
    expect(panel).toHaveTextContent("Current-rate replacement: $210.00");
    expect(panel).toHaveTextContent("not the original invoice total");
    expect(panel).toHaveTextContent("nothing is saved until you stage");
    expect(panel).toHaveTextContent("Zirconia crown #19 · 1 x $185.00 = $185.00");
    expect(panel).toHaveTextContent("Custom shade 1 x $25.00 = $25.00");
    expect(panel).toHaveTextContent("Crown & Bridge #19 · qty 1 · rate $185.00 · assigned tier: Gold");
    expect(screen.queryByTestId("preview-exceptions")).not.toBeInTheDocument();
    expect(bodies.at(-1)).toEqual({
      evidenceAttachmentId: "rx", bridgeConnectors: null,
      restorations: [{ toothNumber: "19", restorationType: "Crown & Bridge", restorationSubtype: null, arch: null,
        material: null, shade: null, quantity: 1 }],
    });
    expect(urls()).toEqual(["/billing-recovery/access", "/billing-recovery"]);
  });
  it("lists preview exceptions that would block applying", async () => {
    serve({ list: () => ({ rows: [row] }), preview: () => pricing("0.00", ["Doctor identity has duplicate matches."]) });
    renderSignedIn();
    fireEvent.click(await screen.findByTestId(`button-propose-${caseId}`));
    fireEvent.change(screen.getByTestId("input-type-0"), { target: { value: "Crown & Bridge" } });
    expect(await screen.findByTestId("preview-exceptions")).toHaveTextContent("Doctor identity has duplicate matches.");
    expect(screen.getByTestId("preview-price")).toHaveTextContent("would block applying");
  });
  it("ignores a slower, stale preview response once newer work is entered", async () => {
    const pending: Array<(value: unknown) => void> = [];
    serve({ list: () => ({ rows: [row] }), preview: () => new Promise((resolve) => { pending.push(resolve); }) });
    renderSignedIn();
    fireEvent.click(await screen.findByTestId(`button-propose-${caseId}`));
    fireEvent.change(screen.getByTestId("input-type-0"), { target: { value: "Crown & Bridge" } });
    expect(screen.getByTestId("preview-loading")).toBeInTheDocument();
    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!(pricing("100.00"));
    expect(await screen.findByTestId("preview-total")).toHaveTextContent("$100.00");
    fireEvent.change(screen.getByTestId("input-tooth-0"), { target: { value: "19" } });
    expect(screen.getByTestId("preview-price")).toHaveTextContent("Updating…");
    await waitFor(() => expect(pending).toHaveLength(2));
    fireEvent.change(screen.getByTestId("input-connectors"), { target: { value: "19-20" } });
    await waitFor(() => expect(pending).toHaveLength(3));
    pending[2]!(pricing("130.00"));
    await waitFor(() => expect(screen.getByTestId("preview-total")).toHaveTextContent("$130.00"));
    pending[1]!(pricing("999.00"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("preview-total")).toHaveTextContent("$130.00");
    expect(screen.getByTestId("preview-price")).not.toHaveTextContent("Updating…");
  });
  it("keeps manual entry and staging available when the preview fails", async () => {
    const staged: unknown[] = [];
    serve({
      list: () => ({ rows: [row] }),
      preview: () => { throw new Error("Catalog pricing is temporarily unavailable."); },
      proposal: (body) => { staged.push(body); return { proposalId: "proposal-1" }; },
    });
    await open();
    expect(await screen.findByTestId("preview-error")).toHaveTextContent("Catalog pricing is temporarily unavailable.");
    expect(screen.getByTestId("input-type-0")).toBeEnabled();
    expect(screen.getByTestId("button-submit-proposal")).toBeEnabled();
    fireEvent.click(screen.getByTestId("button-submit-proposal"));
    await waitFor(() => expect(staged).toHaveLength(1));
    expect(staged[0]).toMatchObject({ evidenceAttachmentId: "rx", reviewNotes: "Manual review notes",
      prescriptionReviewed: true, identityReviewed: true, duplicateReviewed: true });
  });
});

describe("Recovery Billing apply and release", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("offers owners and admins Apply with the total and the held outcome", async () => {
    serve({ list: () => ({ rows: [proposed] }) }, "owner");
    renderSignedIn();
    const button = await screen.findByTestId(`button-apply-${caseId}`);
    expect(button).toHaveTextContent("Apply as held invoice · $210.00");
    expect(button).toBeEnabled();
    expect(screen.getByTestId(`apply-help-${caseId}`)).toHaveTextContent("$0.00 balance and not on the customer's balance");
    expect(screen.getByTestId(`button-propose-${caseId}`)).toHaveTextContent("Revise prescription work");
  });
  it("tells billing staff an owner or admin must apply", async () => {
    serve({ list: () => ({ rows: [proposed] }) }, "billing");
    renderSignedIn();
    expect(await screen.findByTestId(`apply-help-${caseId}`)).toHaveTextContent("An owner or admin must apply this proposal.");
    expect(screen.queryByTestId(`button-apply-${caseId}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`button-propose-${caseId}`)).toBeEnabled();
  });
  it("explains that proposals with exceptions must be fixed and staged again", async () => {
    serve({ list: () => ({ rows: [{ ...proposed, state: "exception", proposal: proposal(["Doctor identity has duplicate matches."]) }] }) }, "admin");
    renderSignedIn();
    expect(await screen.findByTestId(`apply-blocked-${caseId}`)).toHaveTextContent("must be fixed and the work staged again");
    expect(screen.getByTestId(`exceptions-${caseId}`)).toHaveTextContent("Doctor identity has duplicate matches.");
    await waitFor(() => expect(urls()).toContain("/billing-recovery/access"));
    expect(screen.queryByTestId(`button-apply-${caseId}`)).not.toBeInTheDocument();
  });
  it("applies once as a held invoice, then release puts it on the customer's balance", async () => {
    let current: object = proposed;
    const posts: Array<[string, unknown]> = [];
    serve({
      list: () => ({ rows: [current] }),
      apply: (body) => { posts.push(["apply", body]); current = held; return { invoiceId: "invoice-1", total: "210.00", outcome: "created_held" }; },
      release: (body) => { posts.push(["release", body]); current = released; return { invoiceId: "invoice-1", total: "210.00", outcome: "released" }; },
    }, "admin");
    renderSignedIn();
    fireEvent.click(await screen.findByTestId(`button-apply-${caseId}`));
    await waitFor(() => expect(screen.getByTestId(`invoice-${caseId}`)).toHaveTextContent("Held replacement invoice REC-SYNTH-001"));
    expect(screen.getByTestId(`invoice-${caseId}`)).toHaveTextContent("Total $210.00 · balance $0.00");
    expect(screen.getByTestId(`invoice-${caseId}`)).toHaveTextContent("Not on the customer's balance yet.");
    expect(screen.getByTestId(`status-recovery-${caseId}`)).toHaveTextContent("Held replacement");
    expect(screen.queryByTestId(`button-apply-${caseId}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`committed-${caseId}`)).not.toBeInTheDocument();
    expect(refresh.balances).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId(`button-release-${caseId}`));
    fireEvent.click(screen.getByTestId("check-charges"));
    fireEvent.click(screen.getByTestId("check-payments"));
    fireEvent.change(screen.getByTestId("input-evidence-notes"), { target: { value: "Original ledger shows no settlement for this case." } });
    fireEvent.click(screen.getByTestId("button-submit-release"));
    await waitFor(() => expect(screen.getByTestId(`invoice-${caseId}`)).toHaveTextContent("Released — on customer's balance"));
    expect(screen.getByTestId(`invoice-${caseId}`)).toHaveTextContent("Invoice REC-SYNTH-001 · total $210.00 · balance $210.00 · due 11/10/2026");
    expect(screen.getByTestId(`status-recovery-${caseId}`)).toHaveTextContent("Released replacement");
    expect(within(screen.getByTestId(`card-recovery-${caseId}`)).queryByText(/Existing billing/)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`button-release-${caseId}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`button-apply-${caseId}`)).not.toBeInTheDocument();
    expect(posts).toEqual([
      ["apply", { proposalId: "proposal-1" }],
      ["release", { chargesReviewed: true, historicalPaymentsReviewed: true,
        historicalSettlement: "independent_evidence_of_no_payment", evidenceNotes: "Original ledger shows no settlement for this case." }],
    ]);
    expect(refresh.balances).toHaveBeenCalledTimes(2);
    expect(refresh.sales).toHaveBeenCalledTimes(2);
  });
  it("shows the server's refusal and leaves Apply available", async () => {
    serve({
      list: () => ({ rows: [proposed] }),
      apply: () => { throw new Error("Case changed after the proposal; stage a fresh proposal."); },
    }, "owner");
    renderSignedIn();
    fireEvent.click(await screen.findByTestId(`button-apply-${caseId}`));
    expect(await screen.findByTestId(`error-apply-${caseId}`)).toHaveTextContent("Case changed after the proposal; stage a fresh proposal.");
    expect(screen.getByTestId(`button-apply-${caseId}`)).toBeEnabled();
    expect(screen.queryByTestId(`committed-${caseId}`)).not.toBeInTheDocument();
    expect(refresh.balances).not.toHaveBeenCalled();
  });
  it("never offers a second apply after a committed apply whose refresh failed", async () => {
    let listCalls = 0;
    let applies = 0;
    serve({
      list: () => { listCalls += 1; if (listCalls > 1) throw new Error("Network unavailable."); return { rows: [proposed] }; },
      apply: () => { applies += 1; return { invoiceId: "invoice-1", total: "210.00", outcome: "created_held" }; },
    }, "owner");
    renderSignedIn();
    fireEvent.click(await screen.findByTestId(`button-apply-${caseId}`));
    expect(await screen.findByTestId(`committed-${caseId}`)).toHaveTextContent("do not submit again");
    await waitFor(() => expect(listCalls).toBeGreaterThan(1));
    expect(screen.queryByTestId(`button-apply-${caseId}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`error-apply-${caseId}`)).not.toBeInTheDocument();
    expect(applies).toBe(1);
  });
});

it("does not load recovery records when the authenticated availability probe is negative", async () => {
  vi.clearAllMocks();
  api.fetch.mockImplementation(async (url: string) => {
    if (url === "/billing-recovery/access") return { available: false };
    throw new Error("Unexpected recovery request.");
  });
  renderSignedIn();

  expect(await screen.findByTestId("error-recovery-access-unavailable")).toBeInTheDocument();
  expect(urls()).toContain("/billing-recovery/access");
  expect(urls()).not.toContain("/billing-recovery");
});
