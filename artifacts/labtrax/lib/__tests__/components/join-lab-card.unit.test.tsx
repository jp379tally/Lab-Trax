/**
 * Unit tests for JoinLabCard — the self-serve "request to join a lab" card on
 * the mobile dashboard. Renders the real component so the search-results list,
 * the send path, and the "Request pending" state are all exercised.
 *
 * The global setupFiles stub `@tanstack/react-query`'s useQuery to a single
 * auth-me shape, so it is overridden back to the real implementation here and
 * the card is wrapped in a real QueryClientProvider. The network layer
 * (`resilientFetch` + `apiRequest`) is mocked file-locally so we control the
 * lab-lookup and pending-request responses without native deps.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-query", async (importOriginal) =>
  importOriginal<typeof import("@tanstack/react-query")>(),
);

// Hoisted so the vi.mock factory below (also hoisted) can safely reference
// these without hitting the TDZ on module evaluation.
const mockState = vi.hoisted(() => ({
  pendingRequests: [] as unknown[],
  labResults: [] as unknown[],
  apiRequest: vi.fn(
    async (_method: string, _path: string, _body?: unknown) => ({
      ok: true,
      data: null as unknown,
    }),
  ),
}));
const mockApiRequest = mockState.apiRequest;

vi.mock("@/lib/query-client", () => ({
  getApiUrl: () => "http://localhost/",
  resilientFetch: vi.fn(async (url: string) => {
    if (url.includes("/join-requests/mine/pending")) {
      return new Response(JSON.stringify({ data: mockState.pendingRequests }), {
        status: 200,
      });
    }
    if (url.includes("/api/labs/lookup")) {
      return new Response(JSON.stringify({ labs: mockState.labResults }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ data: null }), { status: 200 });
  }),
  apiRequest: mockState.apiRequest,
}));

import { JoinLabCard } from "@/components/JoinLabCard";

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <JoinLabCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockState.pendingRequests = [];
  mockState.labResults = [];
  mockApiRequest.mockReset();
  mockApiRequest.mockResolvedValue({ ok: true, data: null });
});

afterEach(() => cleanup());

describe("JoinLabCard — search results", () => {
  it("renders matching labs after typing a query", async () => {
    mockState.labResults = [
      {
        id: "lab-1",
        name: "Acme Dental Lab",
        displayName: "Acme Dental Lab",
        addressLine1: "123 Main St",
        city: "Austin",
        state: "TX",
        zip: "78701",
        phone: "(512) 555-0100",
      },
    ];
    const { getByText, getByPlaceholderText } = renderCard();
    await waitFor(() =>
      expect(getByText("Your account is ready")).toBeTruthy(),
    );

    fireEvent.changeText(getByPlaceholderText("Lab name or city"), "Acme");

    await waitFor(() => expect(getByText("Acme Dental Lab")).toBeTruthy(), {
      timeout: 3000,
    });
    // Address + phone appear under the lab name so a searcher can tell apart
    // labs with similar names.
    expect(getByText("123 Main St")).toBeTruthy();
    expect(getByText("Austin, TX 78701")).toBeTruthy();
    expect(getByText("(512) 555-0100")).toBeTruthy();
    expect(getByText("Request to join")).toBeTruthy();
  });

  it("shows the empty state when no labs match the query", async () => {
    mockState.labResults = [];
    const { getByText, getByPlaceholderText } = renderCard();

    fireEvent.changeText(getByPlaceholderText("Lab name or city"), "zzz");

    await waitFor(
      () =>
        expect(
          getByText("No labs found. Try a different search."),
        ).toBeTruthy(),
      { timeout: 3000 },
    );
  });
});

describe("JoinLabCard — send path", () => {
  it("POSTs a join request and transitions to the pending state", async () => {
    mockState.labResults = [
      {
        id: "lab-1",
        name: "Acme Dental Lab",
        displayName: "Acme Dental Lab",
        city: null,
        state: null,
      },
    ];
    // Simulate the server creating the request: once sent, the pending list
    // returns it so the invalidated query flips the card to the pending state.
    mockApiRequest.mockImplementation(async () => {
      mockState.pendingRequests = [
        {
          id: "jr-1",
          organizationId: "lab-1",
          status: "pending",
          organization: { id: "lab-1", name: "Acme Dental Lab" },
        },
      ];
      return { ok: true, data: null };
    });

    const { getByText, getByPlaceholderText } = renderCard();
    fireEvent.changeText(getByPlaceholderText("Lab name or city"), "Acme");
    await waitFor(() => expect(getByText("Request to join")).toBeTruthy(), {
      timeout: 3000,
    });

    fireEvent.press(getByText("Request to join"));

    await waitFor(() =>
      expect(mockApiRequest).toHaveBeenCalledWith(
        "POST",
        "/api/organizations/lab-1/join-requests",
        { requestedRole: "user" },
      ),
    );
    await waitFor(() => expect(getByText("Request pending")).toBeTruthy(), {
      timeout: 3000,
    });
  });
});

describe("JoinLabCard — pending state", () => {
  it("renders the pending state when a request already exists", async () => {
    mockState.pendingRequests = [
      {
        id: "jr-9",
        organizationId: "lab-2",
        status: "pending",
        organization: { id: "lab-2", displayName: "Bright Smiles Lab" },
      },
    ];
    const { getByText } = renderCard();

    await waitFor(() => expect(getByText("Request pending")).toBeTruthy());
    expect(getByText(/Bright Smiles Lab/)).toBeTruthy();
    expect(getByText("Cancel request")).toBeTruthy();
  });

  it("cancels the pending request via apiRequest DELETE", async () => {
    mockState.pendingRequests = [
      {
        id: "jr-9",
        organizationId: "lab-2",
        status: "pending",
        organization: { id: "lab-2", displayName: "Bright Smiles Lab" },
      },
    ];
    const { getByText } = renderCard();
    await waitFor(() => expect(getByText("Cancel request")).toBeTruthy());

    fireEvent.press(getByText("Cancel request"));

    await waitFor(() =>
      expect(mockApiRequest).toHaveBeenCalledWith(
        "DELETE",
        "/api/organizations/join-requests/jr-9",
      ),
    );
  });
});

describe("JoinLabCard — declined state", () => {
  it("renders the 'Request declined' state when the active request was rejected", async () => {
    mockState.pendingRequests = [
      {
        id: "jr-7",
        organizationId: "lab-3",
        status: "rejected",
        organization: { id: "lab-3", displayName: "Crystal Dental Lab" },
      },
    ];
    const { getByText } = renderCard();

    await waitFor(() => expect(getByText("Request declined")).toBeTruthy());
    expect(getByText(/Crystal Dental Lab/)).toBeTruthy();
    expect(getByText("Find another lab")).toBeTruthy();
  });

  it("dismisses the declined request via apiRequest DELETE on 'Find another lab'", async () => {
    mockState.pendingRequests = [
      {
        id: "jr-7",
        organizationId: "lab-3",
        status: "rejected",
        organization: { id: "lab-3", displayName: "Crystal Dental Lab" },
      },
    ];
    const { getByText } = renderCard();
    await waitFor(() => expect(getByText("Find another lab")).toBeTruthy());

    fireEvent.press(getByText("Find another lab"));

    await waitFor(() =>
      expect(mockApiRequest).toHaveBeenCalledWith(
        "DELETE",
        "/api/organizations/join-requests/jr-7",
      ),
    );
  });
});
