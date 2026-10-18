/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import StatementsPage from "@/pages/statements";
import { makeAuthWrapper } from "../../__tests__/test-utils";

// Task #2798: shift-click range selection on the Statements page practice
// table (same semantics as the Cases list, Task #2796). After a normal
// checkbox click sets the anchor, shift-clicking another practice selects
// every practice between them in the currently visible (filtered + sorted)
// order.

// jspdf and export helpers pull in heavy/non-jsdom-friendly modules at
// import time. These tests don't exercise PDF/export code paths.
vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));

const LAB_ORG = { id: "lab-1", name: "Lab One", type: "lab" };

// Five practices with descending open balances so the default sort
// (openBalance desc) renders them in the order P1 → P5. Names alternate
// between "Alpha" and "Beta" so the search filter can hide alternating rows.
const PRACTICES = [1, 2, 3, 4, 5].map((n) => ({
  id: `prov-${n}`,
  name: n % 2 === 1 ? `Alpha Practice ${n}` : `Beta Practice ${n}`,
  balance: (6 - n) * 100,
}));

const INVOICES = PRACTICES.map((p, i) => ({
  id: `seed-${i + 1}`,
  labOrganizationId: "lab-1",
  providerOrganizationId: p.id,
  providerOrganization: { name: p.name },
  status: "sent",
  total: String(p.balance),
  balanceDue: String(p.balance),
  createdAt: "2026-06-01T10:00:00.000Z",
}));

const ACCOUNT_SUMMARIES = PRACTICES.map((p, index) => ({
  practiceId: p.id,
  practiceName: p.name,
  billingEmail: index === 0 ? "billing@alpha.test" : null,
  phone: null,
  openInvoiceCount: 1,
  openInvoiceTotal: p.balance,
  unpaidStatements:
    index === 0
      ? [
          {
            id: "statement-new",
            date: "2026-08-31T12:00:00.000Z",
            periodStart: "2026-08-01T00:00:00.000Z",
            periodEnd: "2026-09-01T00:00:00.000Z",
            remainingBalance: 120,
            overdue: false,
          },
          {
            id: "statement-old",
            date: "2026-07-31T12:00:00.000Z",
            periodStart: "2026-07-01T00:00:00.000Z",
            periodEnd: "2026-08-01T00:00:00.000Z",
            remainingBalance: 80,
            overdue: true,
          },
        ]
      : [],
  totalOpenBalance: p.balance,
  overdueBalance: index === 0 ? 80 : 0,
}));

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

async function renderPage() {
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
  await screen.findByLabelText(`Select practice ${PRACTICES[0].name}`);
}

function checkbox(n: number): HTMLInputElement {
  return screen.getByLabelText(
    `Select practice ${PRACTICES[n - 1].name}`,
  ) as HTMLInputElement;
}

function queryCheckbox(n: number): HTMLElement | null {
  return screen.queryByLabelText(`Select practice ${PRACTICES[n - 1].name}`);
}

function selectedPractices(): number[] {
  return [1, 2, 3, 4, 5].filter((n) => {
    const box = queryCheckbox(n) as HTMLInputElement | null;
    return !!box && box.checked;
  });
}

describe("Statements practice table shift-click range selection", () => {
  it("shows the shared account-summary columns, email fallback, and aligned statements", async () => {
    await renderPage();

    for (const heading of [
      "Open Invoices",
      "Open Invoices Total",
      "Recent Statement Date",
      "Recent Statement Amount",
      "Total Open Balance",
      "Overdue",
    ]) {
      expect(screen.getByRole("columnheader", { name: heading })).toBeTruthy();
    }
    expect(screen.getByText("billing@alpha.test")).toBeTruthy();
    expect(screen.getAllByText("No email on file.")).toHaveLength(4);

    const firstRow = checkbox(1).closest("tr");
    expect(firstRow).not.toBeNull();
    const row = within(firstRow!);
    const augustDate = row.getByText("08/31/2026");
    const julyDate = row.getByText("07/31/2026");
    const newAmount = row.getByText("$120.00");
    const oldAmount = row.getAllByText("$80.00")[0];
    expect(augustDate.compareDocumentPosition(julyDate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(newAmount.compareDocumentPosition(oldAmount) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("selects the range downward (anchor above the shift-clicked row)", async () => {
    await renderPage();

    fireEvent.click(checkbox(1));
    fireEvent.click(checkbox(4), { shiftKey: true });

    expect(selectedPractices()).toEqual([1, 2, 3, 4]);
  });

  it("selects the range upward (anchor below the shift-clicked row)", async () => {
    await renderPage();

    fireEvent.click(checkbox(4));
    fireEvent.click(checkbox(2), { shiftKey: true });

    expect(selectedPractices()).toEqual([2, 3, 4]);
  });

  it("adds the range to previously selected practices outside it", async () => {
    await renderPage();

    fireEvent.click(checkbox(5));
    fireEvent.click(checkbox(1));
    fireEvent.click(checkbox(3), { shiftKey: true });

    expect(selectedPractices()).toEqual([1, 2, 3, 5]);
  });

  it("follows the filtered order and never selects hidden practices", async () => {
    await renderPage();

    // Filter to the "Alpha" practices only (1, 3, 5 visible).
    fireEvent.change(screen.getByPlaceholderText("Search practice…"), {
      target: { value: "Alpha" },
    });
    await waitFor(() => expect(queryCheckbox(2)).toBeNull());
    await screen.findByLabelText(`Select practice ${PRACTICES[0].name}`);

    fireEvent.click(checkbox(1));
    fireEvent.click(checkbox(5), { shiftKey: true });
    expect(checkbox(3).checked).toBe(true);

    // Hidden practices (2, 4) were never included even though they sit
    // between the endpoints in the unfiltered order.
    fireEvent.change(screen.getByPlaceholderText("Search practice…"), {
      target: { value: "" },
    });
    await waitFor(() => expect(selectedPractices()).toEqual([1, 3, 5]));
  });

  it("falls back to a single toggle and resets the anchor when the anchor is filtered out", async () => {
    await renderPage();

    // Anchor on practice 2 (Beta), then filter it out of view.
    fireEvent.click(checkbox(2));
    fireEvent.change(screen.getByPlaceholderText("Search practice…"), {
      target: { value: "Alpha" },
    });
    await waitFor(() => expect(queryCheckbox(2)).toBeNull());
    await screen.findByLabelText(`Select practice ${PRACTICES[4].name}`);

    // Shift-click with a stale anchor: only the clicked practice toggles…
    fireEvent.click(checkbox(5), { shiftKey: true });
    expect(checkbox(5).checked).toBe(true);
    expect(checkbox(1).checked).toBe(false);
    expect(checkbox(3).checked).toBe(false);

    // …and the anchor resets to the clicked practice, so a follow-up
    // shift-click ranges from practice 5 within the visible list.
    fireEvent.click(checkbox(1), { shiftKey: true });
    expect(checkbox(1).checked).toBe(true);
    expect(checkbox(3).checked).toBe(true);
    expect(checkbox(5).checked).toBe(true);
  });

  it("keeps normal single toggling and select-all behavior intact", async () => {
    await renderPage();

    fireEvent.click(checkbox(3));
    expect(checkbox(3).checked).toBe(true);
    fireEvent.click(checkbox(3));
    expect(checkbox(3).checked).toBe(false);

    const selectAll = screen.getByTitle(
      "Select all practices",
    ) as HTMLInputElement;
    fireEvent.click(selectAll);
    expect(selectedPractices()).toEqual([1, 2, 3, 4, 5]);
    fireEvent.click(selectAll);
    expect(selectedPractices()).toEqual([]);
  });
});
