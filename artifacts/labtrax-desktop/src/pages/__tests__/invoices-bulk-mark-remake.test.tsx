/** @vitest-environment jsdom */
/**
 * Tests for the bulk "Mark as remakes" wizard on the desktop Invoices register.
 *
 * Verified here (client side):
 * - The "Mark as remakes" action appears only once invoices are selected (and
 *   only for a billing user).
 * - The wizard steps through the selected invoices one at a time and submits
 *   each linked case through the same PATCH /cases/:caseId/mark-as-remake
 *   endpoint as the single-invoice flow (original + reason + charge payload).
 * - Invoices without a linked case can only be skipped, and the summary
 *   reports linked vs skipped counts.
 *
 * jspdf / react-pdf are stubbed (heavy, non-jsdom-friendly at import time).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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

const BILLING_USER = {
  id: "u-bill",
  username: "billing",
  role: "billing",
} as unknown as SessionUser;

const STAFF_USER = {
  id: "u-staff",
  username: "staff",
  role: "technician",
} as unknown as SessionUser;

function makeInvoices(): Invoice[] {
  return [
    {
      id: "inv-a",
      invoiceNumber: "INV-A",
      caseId: "case-a",
      labOrganizationId: "lab-1",
      providerOrganizationId: "prov-1",
      status: "open",
      total: 0,
      balanceDue: 0,
      items: [],
      displayMetadata: { patientName: "Alba", billTo: "Dr. Scott" },
    },
    {
      id: "inv-b",
      invoiceNumber: "INV-B",
      caseId: null,
      labOrganizationId: "lab-1",
      providerOrganizationId: "prov-2",
      status: "open",
      total: 0,
      balanceDue: 0,
      items: [],
      displayMetadata: { patientName: "Pam", billTo: "Dr. Synthetic028" },
    },
  ] as unknown as Invoice[];
}

type PatchCall = { url: string; body: unknown };

function installFetch(patchCalls: PatchCall[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      const json = (data: unknown) =>
        new Response(JSON.stringify({ ok: true, data }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      if (method === "PATCH" && url.includes("/mark-as-remake")) {
        let body: unknown = null;
        try {
          body = init?.body ? JSON.parse(init.body as string) : null;
        } catch {
          body = init?.body;
        }
        patchCalls.push({ url, body });
        return json({ caseId: "case-a", caseNumber: "26-100B" });
      }
      if (url.includes("/cases/quick-search")) {
        return json({
          cases: [
            {
              id: "case-orig",
              caseNumber: "26-100",
              patientFirstName: "Alba",
              patientLastName: "Nguyen",
              doctorName: "Dr. Scott",
              status: "complete",
            },
          ],
        });
      }
      if (url.includes("/cases/next-remake-suffix")) {
        return json({ caseNumber: "26-100B" });
      }
      if (url.includes("/cases/case-a")) {
        return json({
          id: "case-a",
          caseNumber: "26-200",
          remakeOfCaseId: null,
        });
      }
      if (url.endsWith("/api/invoices") || url.includes("/api/invoices?")) {
        return new Response(JSON.stringify(makeInvoices()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/cases/doctor-names")) {
        return json([]);
      }
      if (url.includes("/organizations")) {
        return json([]);
      }
      return json({});
    }),
  );
}

async function selectAll() {
  await screen.findByText("INV-A");
  await screen.findByText("INV-B");
  fireEvent.click(screen.getByTitle(/select all/i));
  await screen.findByText(/2 invoices selected/i);
}

describe("Invoices bulk mark-as-remakes wizard", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
  });

  it("hides the Mark as remakes action until invoices are selected", async () => {
    installFetch([]);
    render(<InvoicesPage />, { wrapper: makeAuthWrapper("/invoices", { user: BILLING_USER, status: "authed" }) });
    await screen.findByText("INV-A");
    expect(screen.queryByText(/mark as remakes/i)).toBeNull();
  });

  it("does not offer the action to non-billing staff", async () => {
    installFetch([]);
    render(<InvoicesPage />, { wrapper: makeAuthWrapper("/invoices", { user: STAFF_USER, status: "authed" }) });
    await selectAll();
    expect(screen.queryByText(/mark as remakes/i)).toBeNull();
  });

  it("steps through the selection, PATCHes mark-as-remake, and reports skips", async () => {
    const patchCalls: PatchCall[] = [];
    installFetch(patchCalls);
    render(<InvoicesPage />, { wrapper: makeAuthWrapper("/invoices", { user: BILLING_USER, status: "authed" }) });
    await selectAll();

    fireEvent.click(screen.getByRole("button", { name: /mark as remakes/i }));
    await screen.findByText(/mark as remakes \(1 of 2\)/i);
    // Linked case number loads for step 1.
    await screen.findByText(/case #26-200/i);

    // Search for and pick the original case.
    const searchInput = screen.getByPlaceholderText(/search by case #/i);
    fireEvent.change(searchInput, { target: { value: "26-1" } });
    const hit = await screen.findByText(/26-100 · Alba Nguyen/i, undefined, {
      timeout: 3000,
    });
    fireEvent.click(hit);

    // Fill the required questionnaire answers: reason + charge. Scope to the
    // wizard modal — the page header also renders a "Change status…" select.
    const wizard = screen
      .getByText(/mark as remakes \(1 of 2\)/i)
      .closest("div.relative") as HTMLElement;
    const reasonSelect = within(wizard)
      .getAllByRole("combobox")
      .find((el) =>
        within(el).queryByText(/select a reason/i),
      ) as HTMLElement;
    fireEvent.change(reasonSelect, {
      target: { value: "crown_broke" },
    });
    fireEvent.click(screen.getByRole("button", { name: /no — no-charge/i }));

    const submit = screen.getByRole("button", { name: /mark & next/i });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    // Advances to step 2 (invoice without a linked case → skip only).
    await screen.findByText(/mark as remakes \(2 of 2\)/i);
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]!.url).toContain("/cases/case-a/mark-as-remake");
    expect(patchCalls[0]!.body).toMatchObject({
      remakeOfCaseId: "case-orig",
      remakeReason: "Crown broke",
      remakeReasonKey: "crown_broke",
      remakeCharged: false,
    });
    await screen.findByText(/isn't linked to a case/i);
    // The submit button is disabled for a case-less invoice.
    expect(
      screen.getByRole("button", { name: /^mark as remake$/i }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));

    // Summary: 1 linked, 1 skipped.
    const summary = await screen.findByText(/1 of 2 invoices linked as remakes/i);
    const dialog = summary.closest("div.relative") as HTMLElement;
    expect(within(dialog).getByText("Marked as remake")).toBeTruthy();
    expect(within(dialog).getByText("No linked case")).toBeTruthy();
  });
});
