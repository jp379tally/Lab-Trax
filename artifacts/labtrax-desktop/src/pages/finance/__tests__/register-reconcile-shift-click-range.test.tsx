/** @vitest-environment jsdom */
/**
 * Shift-click range selection on the Bank Register reconcile worksheet (same
 * semantics as the Cases list). Inside the Reconcile dialog's worksheet step,
 * each candidate transaction has a checkbox; a shift-click extends the cleared
 * selection from the anchor to the clicked row over the candidate order,
 * preserving any prior selection outside the range.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RegisterTable } from "@/pages/finance/register";
import type { SessionUser } from "@/lib/api";
import { makeAuthWrapper } from "../../../__tests__/test-utils";

const ADMIN_USER = {
  id: "u1",
  username: "admin",
  role: "admin",
  userType: "lab",
} as unknown as SessionUser;

const ACCOUNT = {
  id: "acc-1",
  name: "Checking",
  accountType: "checking",
  last4: "1234",
  isArchived: false,
};

// Five candidate deposits (netAmount >= 0), rendered in candidate order t-1..t-5.
const CANDIDATES = [1, 2, 3, 4, 5].map((n) => ({
  id: `t-${n}`,
  txnDate: `2026-06-0${n}`,
  payee: `Payer ${n}`,
  debitAmount: "0",
  creditAmount: "100.00",
  netAmount: "100.00",
  cleared: false,
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
      if (path.endsWith("/finance/reconciliation/candidates"))
        return json({ startingBalance: "0.00", candidates: CANDIDATES });
      if (path.includes("/finance/transactions")) return json([]);
      if (path.endsWith("/finance/categories")) return json([]);
      return json([]);
    }),
  );
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
});

async function renderWorksheet() {
  const Wrapper = makeAuthWrapper("/finance/register", {
    user: ADMIN_USER,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
  });
  render(
    <Wrapper>
      <RegisterTable
        organizationId="lab-1"
        accountId="acc-1"
        accounts={[ACCOUNT as never]}
      />
    </Wrapper>,
  );

  fireEvent.click(await screen.findByRole("button", { name: /Reconcile/ }));
  fireEvent.change(await screen.findByPlaceholderText("0.00"), {
    target: { value: "500.00" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Start reconciling/ }));
  await screen.findByLabelText("Select transaction t-1");
}

function checkbox(id: string): HTMLInputElement {
  return screen.getByLabelText(`Select transaction ${id}`) as HTMLInputElement;
}

function selectedIds(): string[] {
  return ["t-1", "t-2", "t-3", "t-4", "t-5"].filter((id) => checkbox(id).checked);
}

describe("Reconcile worksheet shift-click range selection", () => {
  it("selects the range downward (anchor above the shift-clicked row)", async () => {
    await renderWorksheet();

    fireEvent.click(checkbox("t-1"));
    fireEvent.click(checkbox("t-4"), { shiftKey: true });

    expect(selectedIds()).toEqual(["t-1", "t-2", "t-3", "t-4"]);
  });

  it("selects the range upward (anchor below the shift-clicked row)", async () => {
    await renderWorksheet();

    fireEvent.click(checkbox("t-4"));
    fireEvent.click(checkbox("t-2"), { shiftKey: true });

    expect(selectedIds()).toEqual(["t-2", "t-3", "t-4"]);
  });

  it("adds the range to previously selected transactions outside it", async () => {
    await renderWorksheet();

    fireEvent.click(checkbox("t-5"));
    fireEvent.click(checkbox("t-1"));
    fireEvent.click(checkbox("t-3"), { shiftKey: true });

    expect(selectedIds()).toEqual(["t-1", "t-2", "t-3", "t-5"]);
  });

  it("treats a shift-click with no anchor as a single toggle and sets the anchor", async () => {
    await renderWorksheet();

    fireEvent.click(checkbox("t-3"), { shiftKey: true });
    expect(selectedIds()).toEqual(["t-3"]);

    fireEvent.click(checkbox("t-5"), { shiftKey: true });
    expect(selectedIds()).toEqual(["t-3", "t-4", "t-5"]);
  });

  it("keeps normal single toggling intact", async () => {
    await renderWorksheet();

    fireEvent.click(checkbox("t-2"));
    expect(checkbox("t-2").checked).toBe(true);

    fireEvent.click(checkbox("t-2"));
    expect(checkbox("t-2").checked).toBe(false);
  });
});
