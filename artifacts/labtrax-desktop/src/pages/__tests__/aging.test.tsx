/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import AgingPage from "@/pages/finance/aging";
import { AuthContext } from "@/lib/auth-context";
import { MOCK_AUTH_DEFAULTS, makeAuthWrapper, makeQueryClient } from "../../__tests__/test-utils";

const buckets = [
  { key: "current", label: "Current" }, { key: "d1_30", label: "1–30" },
  { key: "d31_60", label: "31–60" }, { key: "d61_90", label: "61–90" },
  { key: "d90_plus", label: "90+" },
];
const empty = { current: "0.00", d1_30: "0.00", d31_60: "0.00", d61_90: "0.00", d90_plus: "0.00" };
const apReport = {
  basis: "accrual", asOf: "2026-03-31T23:59:59.999Z", buckets,
  rows: [{
    vendorId: "v1", vendorName: "Acme Supply", vendorIsActive: true,
    buckets: { ...empty, current: "100.25", d31_60: "40.10" }, total: "140.35", unappliedCredit: "5.00",
    bills: [{ id: "b1", billNumber: "AC-100", billDate: "2026-01-01", dueDate: "2026-02-01", total: "40.10", outstanding: "40.10", bucket: "d31_60" }],
  }],
  totals: { ...empty, current: "100.25", d31_60: "40.10" }, total: "140.35", unappliedCreditTotal: "5.00",
  limitations: [{ code: "historical", message: "Historical reversals may make these figures approximate." }],
};
const arReport = {
  basis: "accrual", asOf: "2026-03-31T23:59:59.999Z", buckets,
  rows: [{ customerId: "c1", customerName: "Smile Dental", buckets: { ...empty, d1_30: "75.00" }, total: "75.00", unappliedCredit: "0.00", invoices: [] }],
  totals: { ...empty, d1_30: "75.00" }, total: "75.00", unappliedCreditTotal: "0.00", limitations: [],
};

let paths: string[];
let downloaded: string | null;
// The user's role in the lab selected in the Financial header; null when they
// are not a member. The session role is set separately by each render.
let labRole: string | null = "admin";
const json = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  localStorage.clear();
  paths = [];
  downloaded = null;
  labRole = "admin";
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:aging");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloaded = this.download;
  });
  vi.stubGlobal("BroadcastChannel", class { postMessage() {} close() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString(), "http://localhost");
    paths.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/organizations")) return json([{ id: "lab", name: "Lab", type: "lab" }]);
    if (url.pathname.endsWith("/auth/me")) {
      return json({
        user: { id: "u", role: "admin", userType: "lab" },
        memberships: labRole
          ? [{ organizationId: "lab", role: labRole, status: "active", organization: { id: "lab", name: "Lab" } }]
          : [],
      });
    }
    if (url.pathname.endsWith("/finance/accounts")) return json([]);
    if (url.pathname.endsWith("/finance/undeposited-funds")) return json({ count: 0, total: 0 });
    if (url.pathname.endsWith("/finance/reports/ap-aging")) return json(apReport);
    if (url.pathname.endsWith("/finance/reports/ar-aging")) return json(arReport);
    return json({});
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Renders Aging for a user whose session (primary-lab) role is `sessionRole`. */
function renderAging(path = "/finance/aging", sessionRole = "admin") {
  const memory = memoryLocation({ path });
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <Router hook={memory.hook} searchHook={memory.searchHook}>
        <AuthContext.Provider
          value={{
            ...MOCK_AUTH_DEFAULTS,
            user: { id: "u", role: sessionRole, userType: "lab", practiceOrganizationId: "lab" } as any,
            status: "authed",
            restoreStatus: "ok",
            restoreNoticeDismissed: true,
          }}
        >
          <AgingPage />
        </AuthContext.Provider>
      </Router>
    </QueryClientProvider>,
  );
}

async function page() {
  const Wrapper = makeAuthWrapper("/finance/aging", {
    user: { id: "u", role: "admin", userType: "lab", practiceOrganizationId: "lab" } as any,
    status: "authed", restoreStatus: "ok", restoreNoticeDismissed: true,
  });
  render(<Wrapper><AgingPage /></Wrapper>);
  await screen.findByText("Acme Supply");
}

describe("Aging", () => {
  it("renders buckets, totals, limitations, refetches by side and drills into details", async () => {
    await page();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getAllByText("$140.35").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Historical reversals may make these figures approximate.")).toBeInTheDocument();
    const exportButton = screen.getByRole("button", { name: "Export CSV" });
    expect(exportButton).toBeEnabled();
    fireEvent.click(exportButton);
    expect(downloaded).toMatch(/^ap-aging-\d{4}-\d{2}-\d{2}\.csv$/);

    fireEvent.change(screen.getByLabelText("As of"), { target: { value: "2026-03-31" } });
    await waitFor(() => expect(paths.some((path) => path.includes("asOf=2026-03-31"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Detail" }));
    await waitFor(() => expect(paths.some((path) => path.includes("detail=true"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Acme Supply" }));
    expect(await screen.findByText(/AC-100 · due/)).toBeInTheDocument();
    expect(screen.getAllByText("$40.10").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "A/R — what we're owed" }));
    expect(await screen.findByText("Smile Dental")).toBeInTheDocument();
    expect(paths.some((path) => path.includes("/finance/reports/ar-aging"))).toBe(true);
    expect(screen.getAllByText("$75.00").length).toBeGreaterThanOrEqual(2);
  });

  it("opens on the A/R side when linked with ?side=ar, as Receive Payments does", async () => {
    renderAging("/finance/aging?side=ar");
    expect(await screen.findByText("Smile Dental")).toBeInTheDocument();
    expect(paths.some((path) => path.includes("/finance/reports/ar-aging"))).toBe(true);
    expect(paths.some((path) => path.includes("/finance/reports/ap-aging"))).toBe(false);
    expect(screen.queryByText("Acme Supply")).toBeNull();
  });
});

// The server authorizes both aging reports by the user's role in the lab
// chosen in the Financial header (owner, admin or billing), not by the
// primary-lab role on the session.
describe("Aging role in the selected lab", () => {
  const reportRequested = () => paths.some((path) => path.includes("/finance/reports/"));

  it("opens the A/R side for an admin of the selected lab whose session role is user", async () => {
    labRole = "admin";
    renderAging("/finance/aging?side=ar", "user");
    expect(await screen.findByText("Smile Dental")).toBeInTheDocument();
    expect(screen.queryByText("Not available")).toBeNull();
    expect(screen.getByRole("link", { name: "Aging" })).toBeInTheDocument();
  });

  it("opens for a billing member of the selected lab whose session role is user", async () => {
    labRole = "billing";
    renderAging("/finance/aging", "user");
    expect(await screen.findByText("Acme Supply")).toBeInTheDocument();
    expect(screen.queryByText("Not available")).toBeNull();
    // The tabs follow the same rule: billing members may not receive payments or make deposits.
    expect(screen.getByRole("link", { name: "Aging" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Receive Payments" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Make Deposits" })).toBeNull();
  });

  it("is not available to a user of the selected lab, even with an admin session role", async () => {
    labRole = "user";
    renderAging("/finance/aging?side=ar", "admin");
    expect(await screen.findByText(/Your role in Lab is User\./)).toBeInTheDocument();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(
      screen.getByText(/Aging is available only to lab owners, administrators and billing members\./),
    ).toBeInTheDocument();
    expect(screen.queryByText("Smile Dental")).toBeNull();
    expect(reportRequested()).toBe(false);
  });

  it("explains when the user is not an active member of the selected lab", async () => {
    labRole = null;
    renderAging("/finance/aging", "admin");
    expect(await screen.findByText(/You are not an active member of Lab\./)).toBeInTheDocument();
    expect(reportRequested()).toBe(false);
  });
});