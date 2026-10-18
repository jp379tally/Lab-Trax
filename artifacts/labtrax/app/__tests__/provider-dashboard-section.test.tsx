// Mobile provider portal → Dashboard.
//
// The Dashboard is the provider's case list, mirroring the desktop
// ProviderDashboard. The outcomes protected here are the ones a provider would
// notice going wrong:
//
//  * completed cases stay out of the active list and only they reach the
//    completed panel;
//  * the lab appears for a provider linked to more than one lab and stays
//    hidden for everyone else;
//  * the completed panel opens on the month in progress, re-filters when the
//    dates change, and counts what it is showing;
//  * loading, error, "no cases at all", and "no active cases" each say the
//    thing desktop says;
//  * tapping any case — active or completed — reaches the existing mobile
//    provider case detail route;
//  * the values on screen (status, due date, open balance) are formatted the
//    way desktop formats the same case;
//  * pulling the list down re-fetches the cases, and a refresh that fails
//    leaves the ones already on screen alone.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router } from "expo-router";
import {
  resetMockAppState,
  resetMockFetchHandler,
  setMockFetchHandler,
} from "../../vitest.setup";

// The global setup replaces the query hooks with static stubs. The Dashboard
// loads its cases through a real query, so this file uses React Query for
// real and drives the data from the mocked fetch layer instead.
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
}));

import { ProviderDashboardSection } from "@/components/provider-portal/sections/ProviderDashboardSection";
import type { ProviderCase } from "@/lib/provider-cases";

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeCase(overrides: Partial<ProviderCase> & { id: string }): ProviderCase {
  return {
    caseNumber: `C-${overrides.id}`,
    status: "in_progress",
    dueDate: "2026-09-10T00:00:00.000Z",
    patientFirstName: "Jane",
    patientLastName: "Doe",
    patientInitials: null,
    restorationTypes: "Crown",
    labName: "Northside Lab",
    openInvoiceAmount: 0,
    ...overrides,
  };
}

const ACTIVE = makeCase({
  id: "active-1",
  caseNumber: "1001",
  status: "in_progress",
  patientFirstName: "Jane",
  patientLastName: "Doe",
  restorationTypes: "Crown, Bridge",
  dueDate: "2026-09-10T00:00:00.000Z",
});

const COMPLETED = makeCase({
  id: "done-1",
  caseNumber: "0900",
  status: "complete",
  patientFirstName: "Sam",
  patientLastName: "Ray",
  restorationTypes: "Veneer",
  dueDate: "2026-09-04T00:00:00.000Z",
  openInvoiceAmount: 1234.5,
});

/** What GET /api/cases/provider answers with, and when. */
let casesResponse: { status: number; body: unknown };
/** Set to hold the cases request open until the test releases it. */
let gate: { promise: Promise<void>; open: () => void } | null = null;

function respondWith(cases: ProviderCase[]): void {
  casesResponse = { status: 200, body: { ok: true, data: cases } };
}

function holdCasesRequest(): void {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  gate = { promise, open };
}

function installHandler(): void {
  setMockFetchHandler(async (url) => {
    if (url.includes("/api/cases/provider")) {
      if (gate) await gate.promise;
      return new Response(JSON.stringify(casesResponse.body), {
        status: casesResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, data: null }), { status: 200 });
  });
}

async function renderDashboard(props: { caseId?: string | null } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProviderDashboardSection caseId={props.caseId ?? null} />
    </QueryClientProvider>,
  );
}

async function press(element: Parameters<typeof fireEvent.press>[0]): Promise<void> {
  await act(async () => {
    await fireEvent.press(element);
  });
}

/**
 * The list's pull-to-refresh control. It is handed to the ScrollView as a
 * prop rather than rendered as a child, so it is read off the host element —
 * freshly each time, since its props change as the refresh runs.
 */
type RefreshControlProps = { refreshing: boolean; onRefresh: () => void };

/** The text of an element whose children may be a string or a fragment list. */
function textOf(element: { props: Record<string, any> }): string {
  const children = element.props.children;
  return Array.isArray(children) ? children.join("") : String(children);
}

beforeEach(() => {
  resetMockAppState();
  resetMockFetchHandler();
  gate = null;
  respondWith([]);
  installHandler();
  (router.push as ReturnType<typeof vi.fn>).mockClear();
  // Pin "today" so the completed panel's default month is deterministic.
  // Only Date is faked, so waitFor's real timers still advance.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
});

afterEach(() => {
  cleanup();
  resetMockFetchHandler();
  vi.useRealTimers();
});

// ── Active cases ───────────────────────────────────────────────────────────

describe("active cases", () => {
  it("lists active cases with the desktop field set and keeps completed ones out", async () => {
    respondWith([ACTIVE, COMPLETED]);
    const { getByTestId, getByText, queryByTestId } = await renderDashboard();

    expect(getByText("Your Active Cases")).toBeTruthy();
    expect(getByText("All active cases assigned to your account")).toBeTruthy();

    await waitFor(() => expect(getByTestId("provider-case-row-active-1")).toBeTruthy());

    // Every desktop column is present, formatted the desktop way.
    expect(getByText("1001")).toBeTruthy();
    expect(getByText("Jane Doe")).toBeTruthy();
    expect(getByText("Crown, Bridge")).toBeTruthy();
    expect(getByText("09/10/2026")).toBeTruthy();
    expect(textOf(getByTestId("provider-case-row-active-1-status"))).toBe("In Progress");

    // The completed case is not in the main list.
    expect(queryByTestId("provider-case-row-done-1")).toBeNull();
  });

  it("keeps a hyphenated status as one word", async () => {
    // The mobile titleCase helper splits on hyphens too and would show
    // "In House"; desktop shows "In-house", so this row must as well.
    respondWith([makeCase({ id: "active-3", status: "in-house" })]);
    const { getByTestId } = await renderDashboard();

    await waitFor(() => expect(getByTestId("provider-case-row-active-3")).toBeTruthy());
    expect(textOf(getByTestId("provider-case-row-active-3-status"))).toBe("In-house");
  });

  it("hides the lab for a provider linked to a single lab", async () => {
    respondWith([ACTIVE, makeCase({ id: "active-2", labName: "Northside Lab" })]);
    const { getByTestId, queryByTestId } = await renderDashboard();

    await waitFor(() => expect(getByTestId("provider-case-row-active-1")).toBeTruthy());
    expect(queryByTestId("provider-case-row-active-1-lab")).toBeNull();
    expect(queryByTestId("provider-case-row-active-2-lab")).toBeNull();
  });

  it("shows the lab for a provider linked to more than one lab", async () => {
    respondWith([ACTIVE, makeCase({ id: "active-2", labName: "Southside Lab" })]);
    const { getByTestId, getByText } = await renderDashboard();

    await waitFor(() => expect(getByTestId("provider-case-row-active-1")).toBeTruthy());
    expect(getByTestId("provider-case-row-active-1-lab")).toBeTruthy();
    expect(getByText("Northside Lab")).toBeTruthy();
    expect(getByText("Southside Lab")).toBeTruthy();
  });

  it("opens the provider case detail route when an active case is tapped", async () => {
    respondWith([ACTIVE]);
    const { getByTestId } = await renderDashboard();

    await waitFor(() => expect(getByTestId("provider-case-row-active-1")).toBeTruthy());
    await press(getByTestId("provider-case-row-active-1"));
    expect(router.push).toHaveBeenCalledWith("/case/provider/active-1");
  });
});

// ── Pull to refresh ────────────────────────────────────────────────────────

describe("pull to refresh", () => {
  it("re-fetches the cases and runs the indicator while it does", async () => {
    respondWith([ACTIVE]);
    const { getByTestId, queryByTestId } = await renderDashboard();

    await waitFor(() => expect(getByTestId("provider-case-row-active-1")).toBeTruthy());
    expect(refreshControl(getByTestId).refreshing).toBe(false);

    // Hold the refetch open, so the indicator stays on until this test lets
    // the response through and there is no window to race against.
    holdCasesRequest();
    respondWith([ACTIVE, makeCase({ id: "active-9", caseNumber: "1009" })]);
    await pullToRefresh(getByTestId);
    await waitFor(() => expect(refreshControl(getByTestId).refreshing).toBe(true));

    await act(async () => {
      gate?.open();
      gate = null;
    });

    await waitFor(() => expect(getByTestId("provider-case-row-active-9")).toBeTruthy());
    expect(refreshControl(getByTestId).refreshing).toBe(false);
    expect(queryByTestId("provider-dashboard-refresh-error")).toBeNull();
  });

  it("keeps the loaded cases on screen when a refresh fails", async () => {
    respondWith([ACTIVE, COMPLETED]);
    const { getByTestId, getByText, queryByTestId } = await renderDashboard();

    await waitFor(() => expect(getByTestId("provider-case-row-active-1")).toBeTruthy());

    casesResponse = {
      status: 500,
      body: { ok: false, message: "Something went wrong." },
    };
    await pullToRefresh(getByTestId);

    await waitFor(() =>
      expect(getByTestId("provider-dashboard-refresh-error")).toBeTruthy(),
    );
    expect(
      getByText("Could not refresh your cases. Showing the ones last loaded."),
    ).toBeTruthy();
    expect(getByText("Something went wrong.")).toBeTruthy();

    // The list is still the one the provider was reading: not blanked, and not
    // replaced by the state a first load that never succeeded shows.
    expect(getByTestId("provider-case-row-active-1")).toBeTruthy();
    expect(textOf(getByTestId("provider-case-row-active-1-status"))).toBe("In Progress");
    expect(queryByTestId("provider-dashboard-error")).toBeNull();
    expect(queryByTestId("provider-dashboard-loading")).toBeNull();
    expect(queryByTestId("provider-dashboard-empty")).toBeNull();
    expect(refreshControl(getByTestId).refreshing).toBe(false);
  });

  it("carries a newly completed case into the completed panel", async () => {
    respondWith([ACTIVE]);
    const { getByTestId, queryByTestId } = await renderDashboard();

    await waitFor(() => expect(getByTestId("provider-case-row-active-1")).toBeTruthy());
    expect(queryByTestId("provider-dashboard-view-completed")).toBeNull();

    // The lab marks the case complete; pulling down is how the provider sees it.
    respondWith([COMPLETED]);
    await pullToRefresh(getByTestId);

    await waitFor(() =>
      expect(getByTestId("provider-dashboard-view-completed")).toBeTruthy(),
    );
    expect(queryByTestId("provider-case-row-active-1")).toBeNull();

    await press(getByTestId("provider-dashboard-view-completed"));
    expect(getByTestId("provider-completed-row-done-1")).toBeTruthy();
  });
});

// ── Completed cases panel ──────────────────────────────────────────────────

describe("completed cases", () => {
  it("hides the completed entry when the provider has none", async () => {
    respondWith([ACTIVE]);
    const { getByTestId, queryByTestId } = await renderDashboard();

    await waitFor(() => expect(getByTestId("provider-case-row-active-1")).toBeTruthy());
    expect(queryByTestId("provider-dashboard-view-completed")).toBeNull();
  });

  it("defaults to the current month, counts matches, and shows each open balance", async () => {
    respondWith([ACTIVE, COMPLETED]);
    const { getByTestId, getByText } = await renderDashboard();

    await waitFor(() =>
      expect(getByTestId("provider-dashboard-view-completed")).toBeTruthy(),
    );
    await press(getByTestId("provider-dashboard-view-completed"));
    expect(getByTestId("provider-completed-panel")).toBeTruthy();

    // 2026-09-01 → 2026-09-15, the month in progress.
    expect(getByText("09/01/2026")).toBeTruthy();
    expect(getByText("09/15/2026")).toBeTruthy();

    // The completed case (due 09/04) falls inside that range, and only it does.
    expect(textOf(getByTestId("provider-completed-count"))).toBe("1 case");
    expect(getByTestId("provider-completed-row-done-1")).toBeTruthy();
    expect(getByText("Veneer")).toBeTruthy();
    expect(getByText("09/04/2026")).toBeTruthy();
    expect(textOf(getByTestId("provider-completed-row-done-1-balance"))).toBe("$1,234.50");
  });

  it("shows an em dash, not $0.00, on a case that owes nothing", async () => {
    // Desktop shows an em dash for a settled case; the mobile formatMoney
    // helper would render "$0.00" here, which is why the row is formatted
    // through @workspace/provider-case-format instead.
    respondWith([
      ACTIVE,
      makeCase({ id: "done-2", status: "complete", openInvoiceAmount: 0 }),
      makeCase({ id: "done-3", status: "complete", openInvoiceAmount: null }),
    ]);
    const { getByTestId, queryByText } = await renderDashboard();

    await waitFor(() =>
      expect(getByTestId("provider-dashboard-view-completed")).toBeTruthy(),
    );
    await press(getByTestId("provider-dashboard-view-completed"));

    expect(textOf(getByTestId("provider-completed-row-done-2-balance"))).toBe("—");
    expect(textOf(getByTestId("provider-completed-row-done-3-balance"))).toBe("—");
    expect(queryByText("$0.00")).toBeNull();
  });

  it("re-filters when the from date moves past the case's due date", async () => {
    respondWith([ACTIVE, COMPLETED]);
    const { getByTestId, getByText } = await renderDashboard();

    await waitFor(() =>
      expect(getByTestId("provider-dashboard-view-completed")).toBeTruthy(),
    );
    await press(getByTestId("provider-dashboard-view-completed"));
    expect(getByTestId("provider-completed-row-done-1")).toBeTruthy();

    // Move "From" to 09/08 — after the 09/04 due date.
    await press(getByTestId("provider-completed-from"));
    await press(getByTestId("provider-completed-from-day-8"));

    expect(textOf(getByTestId("provider-completed-count"))).toBe("0 cases");
    expect(getByTestId("provider-completed-empty")).toBeTruthy();
    expect(getByText("No completed cases in this date range")).toBeTruthy();
  });

  it("opens the provider case detail route when a completed case is tapped", async () => {
    respondWith([ACTIVE, COMPLETED]);
    const { getByTestId, queryByTestId } = await renderDashboard();

    await waitFor(() =>
      expect(getByTestId("provider-dashboard-view-completed")).toBeTruthy(),
    );
    await press(getByTestId("provider-dashboard-view-completed"));
    await press(getByTestId("provider-completed-row-done-1"));
    expect(router.push).toHaveBeenCalledWith("/case/provider/done-1");

    // The panel overlays the section, so leaving it up would cover the case
    // detail the tap just opened.
    expect(queryByTestId("provider-completed-panel")).toBeNull();
  });

  it("will not let the from date move past the to date", async () => {
    respondWith([ACTIVE, COMPLETED]);
    const { getByTestId, queryByText } = await renderDashboard();

    await waitFor(() =>
      expect(getByTestId("provider-dashboard-view-completed")).toBeTruthy(),
    );
    await press(getByTestId("provider-dashboard-view-completed"));

    // Pull "To" back to 09/10, then try to set "From" to 09/20.
    await press(getByTestId("provider-completed-to"));
    await press(getByTestId("provider-completed-to-day-10"));
    expect(within(getByTestId("provider-completed-to")).getByText("09/10/2026")).toBeTruthy();

    await press(getByTestId("provider-completed-from"));
    await press(getByTestId("provider-completed-from-day-20"));

    // The day is out of range, so nothing was selected and the range holds.
    expect(queryByText("09/20/2026")).toBeNull();
    expect(within(getByTestId("provider-completed-from")).getByText("09/01/2026")).toBeTruthy();
  });
});

// ── States ─────────────────────────────────────────────────────────────────

describe("loading, error and empty states", () => {
  it("says it is loading until the cases arrive", async () => {
    holdCasesRequest();
    respondWith([ACTIVE]);
    const { getByTestId, getByText, queryByTestId } = await renderDashboard();

    expect(getByTestId("provider-dashboard-loading")).toBeTruthy();
    expect(getByText("Loading cases…")).toBeTruthy();
    expect(queryByTestId("provider-case-row-active-1")).toBeNull();

    await act(async () => {
      gate?.open();
      gate = null;
    });

    await waitFor(() => expect(getByTestId("provider-case-row-active-1")).toBeTruthy());
    expect(queryByTestId("provider-dashboard-loading")).toBeNull();
  });

  it("surfaces a load failure instead of an empty list", async () => {
    casesResponse = {
      status: 500,
      body: { ok: false, message: "Something went wrong." },
    };
    const { getByTestId, getByText, queryByTestId } = await renderDashboard();

    await waitFor(() => expect(getByTestId("provider-dashboard-error")).toBeTruthy());
    expect(getByText("Something went wrong.")).toBeTruthy();
    expect(queryByTestId("provider-dashboard-empty")).toBeNull();
    expect(queryByTestId("provider-dashboard-loading")).toBeNull();
  });

  it("says the provider has no assigned cases at all", async () => {
    respondWith([]);
    const { getByTestId, getByText, queryByTestId } = await renderDashboard();

    await waitFor(() => expect(getByTestId("provider-dashboard-empty")).toBeTruthy());
    expect(getByText("You have no assigned cases yet.")).toBeTruthy();
    expect(queryByTestId("provider-dashboard-view-completed")).toBeNull();
  });

  it("points a provider whose cases are all complete at their history", async () => {
    respondWith([COMPLETED]);
    const { getByTestId, getByText } = await renderDashboard();

    await waitFor(() => expect(getByTestId("provider-dashboard-empty")).toBeTruthy());
    expect(
      getByText("No active cases. Check completed cases for your history."),
    ).toBeTruthy();
    expect(getByTestId("provider-dashboard-view-completed")).toBeTruthy();
  });
});

// ── Notification deep link ─────────────────────────────────────────────────

describe("notification deep link", () => {
  it("opens the case the notification pointed at", async () => {
    respondWith([ACTIVE]);
    const { getByTestId } = await renderDashboard({ caseId: "case-42" });

    await waitFor(() => expect(getByTestId("provider-case-row-active-1")).toBeTruthy());
    expect(router.push).toHaveBeenCalledWith("/case/provider/case-42");
  });

  it("does not navigate when the section opens without a case", async () => {
    respondWith([ACTIVE]);
    const { getByTestId } = await renderDashboard();

    await waitFor(() => expect(getByTestId("provider-case-row-active-1")).toBeTruthy());
    expect(router.push).not.toHaveBeenCalled();
  });

  it("opens the same case again when the notification is tapped a second time", async () => {
    respondWith([ACTIVE]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const withCaseId = (caseId: string | null) => (
      <QueryClientProvider client={client}>
        <ProviderDashboardSection caseId={caseId} />
      </QueryClientProvider>
    );

    const { getByTestId, rerender } = await render(withCaseId("case-42"));
    await waitFor(() => expect(getByTestId("provider-case-row-active-1")).toBeTruthy());
    expect(router.push).toHaveBeenCalledTimes(1);

    // The shell clears the id once it has been consumed; a re-render while it
    // is still set must not fire a second push.
    await act(async () => {
      await rerender(withCaseId("case-42"));
    });
    expect(router.push).toHaveBeenCalledTimes(1);

    // Cleared, then the same notification tapped again — the case opens again.
    await act(async () => {
      await rerender(withCaseId(null));
    });
    await act(async () => {
      await rerender(withCaseId("case-42"));
    });
    expect(router.push).toHaveBeenCalledTimes(2);
    expect(router.push).toHaveBeenLastCalledWith("/case/provider/case-42");
  });
});

type ByTestId = (id: string) => { props: Record<string, unknown> };

function refreshControl(getByTestId: ByTestId): RefreshControlProps {
  const scroll = getByTestId("provider-dashboard-scroll");
  return (scroll.props.refreshControl as { props: RefreshControlProps }).props;
}

/** Pull the case list down, the way a provider asks for fresh cases. */
async function pullToRefresh(getByTestId: ByTestId): Promise<void> {
  const onRefresh = refreshControl(getByTestId).onRefresh;
  await act(async () => {
    onRefresh();
  });
}
