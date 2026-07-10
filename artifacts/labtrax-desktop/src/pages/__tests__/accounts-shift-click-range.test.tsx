/** @vitest-environment jsdom */
/**
 * Shift-click range selection on the Customer Center (Accounts) practice list
 * (same semantics as the Cases list). Each practice row's select control is a
 * role="checkbox" button with aria-label "Select practice <name>"; a shift-click
 * extends the practice selection from the anchor to the clicked row over the
 * current filtered order, preserving prior selection outside the range.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthContext } from "@/lib/auth-context";
import { MOCK_AUTH_DEFAULTS } from "../../__tests__/test-utils";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetDoctorDuplicateClusters: () => ({ data: { data: { clusters: [] } } }),
    getGetDoctorDuplicateClustersQueryKey: () => ["doctor-duplicate-clusters"],
  };
});

import AccountsPage from "@/pages/accounts";

const ADMIN_ME = {
  id: "u1",
  memberships: [
    {
      status: "active",
      role: "admin",
      organizationId: "lab1",
      organization: { id: "lab1", type: "lab" },
    },
  ],
};

// Five provider practices; sorted alphabetically by name they render Alpha..Echo.
const NAMES = [
  "Alpha Dental",
  "Bravo Dental",
  "Charlie Dental",
  "Delta Dental",
  "Echo Dental",
];
const PROVIDERS = NAMES.map((name, idx) => ({
  id: `prov-${idx + 1}`,
  type: "provider",
  name,
  displayName: name,
}));

function makeApiFetch() {
  return (url: string) => {
    if (url.startsWith("/organizations")) return Promise.resolve(PROVIDERS);
    if (url === "/cases") return Promise.resolve([]);
    if (url === "/invoices") return Promise.resolve([]);
    if (url === "/auth/me") return Promise.resolve(ADMIN_ME);
    if (url === "/cases/legacy-doctor-directory") return Promise.resolve([]);
    return Promise.resolve([]);
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

async function renderPage() {
  const queryClient = makeQueryClient();
  const { hook } = memoryLocation({ path: "/" });
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={hook}>
        <AuthContext.Provider value={MOCK_AUTH_DEFAULTS}>
          <AccountsPage />
        </AuthContext.Provider>
      </Router>
    </QueryClientProvider>,
  );
  await screen.findByLabelText("Select practice Alpha Dental");
}

function control(name: string): HTMLElement {
  return screen.getByLabelText(`Select practice ${name}`);
}

function selectedNames(): string[] {
  return NAMES.filter(
    (n) => control(n).getAttribute("aria-checked") === "true",
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(makeApiFetch());
  try {
    sessionStorage.clear();
  } catch {}
});

describe("Customer Center practices shift-click range selection", () => {
  it("selects the range downward (anchor above the shift-clicked row)", async () => {
    await renderPage();

    fireEvent.click(control("Alpha Dental"));
    fireEvent.click(control("Delta Dental"), { shiftKey: true });

    expect(selectedNames()).toEqual([
      "Alpha Dental",
      "Bravo Dental",
      "Charlie Dental",
      "Delta Dental",
    ]);
  });

  it("selects the range upward (anchor below the shift-clicked row)", async () => {
    await renderPage();

    fireEvent.click(control("Delta Dental"));
    fireEvent.click(control("Bravo Dental"), { shiftKey: true });

    expect(selectedNames()).toEqual([
      "Bravo Dental",
      "Charlie Dental",
      "Delta Dental",
    ]);
  });

  it("adds the range to previously selected practices outside it", async () => {
    await renderPage();

    fireEvent.click(control("Echo Dental"));
    fireEvent.click(control("Alpha Dental"));
    fireEvent.click(control("Charlie Dental"), { shiftKey: true });

    expect(selectedNames()).toEqual([
      "Alpha Dental",
      "Bravo Dental",
      "Charlie Dental",
      "Echo Dental",
    ]);
  });

  it("treats a shift-click with no anchor as a single toggle and sets the anchor", async () => {
    await renderPage();

    fireEvent.click(control("Charlie Dental"), { shiftKey: true });
    expect(selectedNames()).toEqual(["Charlie Dental"]);

    fireEvent.click(control("Echo Dental"), { shiftKey: true });
    expect(selectedNames()).toEqual([
      "Charlie Dental",
      "Delta Dental",
      "Echo Dental",
    ]);
  });

  it("keeps normal single toggling intact", async () => {
    await renderPage();

    fireEvent.click(control("Bravo Dental"));
    expect(control("Bravo Dental").getAttribute("aria-checked")).toBe("true");

    fireEvent.click(control("Bravo Dental"));
    expect(control("Bravo Dental").getAttribute("aria-checked")).toBe("false");
  });

  // Cases parity: a successful shift-range does NOT move the anchor — only a
  // plain click does. So after a shift-range, if the shift-clicked row is
  // later filtered out, a subsequent shift-click must still extend from the
  // original plain-click anchor (which is still visible), not fall back to a
  // single toggle. This fails if the anchor had been moved to the shift-
  // clicked row and then hidden by the filter.
  it("keeps the plain-click anchor after a shift-range even when the shift-clicked row is filtered out", async () => {
    // "Charlie Group" lacks the shared "Dental" token so a "Dental" search
    // hides only it while keeping the rest in order.
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/organizations"))
        return Promise.resolve([
          { id: "prov-1", type: "provider", name: "Alpha Dental", displayName: "Alpha Dental" },
          { id: "prov-2", type: "provider", name: "Bravo Dental", displayName: "Bravo Dental" },
          { id: "prov-3", type: "provider", name: "Charlie Group", displayName: "Charlie Group" },
          { id: "prov-4", type: "provider", name: "Delta Dental", displayName: "Delta Dental" },
          { id: "prov-5", type: "provider", name: "Echo Dental", displayName: "Echo Dental" },
        ]);
      if (url === "/cases") return Promise.resolve([]);
      if (url === "/invoices") return Promise.resolve([]);
      if (url === "/auth/me") return Promise.resolve(ADMIN_ME);
      if (url === "/cases/legacy-doctor-directory") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    await renderPage();

    // Plain click sets the anchor to Bravo, then shift-range to Charlie Group.
    fireEvent.click(control("Bravo Dental"));
    fireEvent.click(control("Charlie Group"), { shiftKey: true });

    // Filter out "Charlie Group" (the shift-clicked row) while keeping Bravo.
    fireEvent.change(
      screen.getByPlaceholderText("Search practice or doctor…"),
      { target: { value: "Dental" } },
    );
    await screen.findByLabelText("Select practice Echo Dental");

    // Shift-click Echo: the anchor is still Bravo (visible), so the range
    // Bravo..Echo over the visible list adds Delta. If the anchor had moved to
    // the now-hidden Charlie, this would fall back to a single toggle of Echo
    // and Delta would stay unselected.
    fireEvent.click(control("Echo Dental"), { shiftKey: true });

    expect(control("Delta Dental").getAttribute("aria-checked")).toBe("true");
  });
});
