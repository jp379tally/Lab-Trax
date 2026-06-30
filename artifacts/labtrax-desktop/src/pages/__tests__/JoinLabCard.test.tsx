/** @vitest-environment jsdom */
/**
 * Integration tests for the desktop self-serve "request to join a lab" card
 * (the inline JoinLabCard rendered on the dashboard when a signed-up user is
 * not yet a member of any active lab). Mirrors the mobile JoinLabCard coverage
 * added in Task #2601: it exercises the lab search results, the "Request to
 * join" send path, and the "Request pending" / cancel state.
 *
 * The network layer (`apiFetch` from `@/lib/api`) is mocked file-locally and
 * routed by URL so we control the pending-request, lab-lookup, send, and cancel
 * responses without any real fetch. The card is rendered inside the shared
 * auth + QueryClient wrapper so its useQuery/useMutation hooks run for real.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { JoinLabCard } from "../dashboard";
import { makeAuthWrapper } from "../../__tests__/test-utils";

// ─── Module mocks ─────────────────────────────────────────────────────────────

const mockApiFetch = vi.fn();

vi.mock("@/lib/api", () => {
  class MockApiError extends Error {
    status: number;
    body: unknown;
    constructor(msg: string, status = 500, body: unknown = null) {
      super(msg);
      this.status = status;
      this.body = body;
    }
  }
  return {
    apiFetch: (...args: unknown[]) => mockApiFetch(...args),
    ApiError: MockApiError,
  };
});

// ─── Mock network state ──────────────────────────────────────────────────────

interface JoinRequest {
  id: string;
  organizationId: string;
  status: string;
  organization?: { id: string; name: string; displayName?: string | null } | null;
}

interface LabResult {
  id: string;
  name: string;
  displayName: string;
  city: string | null;
  state: string | null;
}

const state: {
  pendingRequests: JoinRequest[];
  labResults: LabResult[];
} = {
  pendingRequests: [],
  labResults: [],
};

function renderCard() {
  const Wrapper = makeAuthWrapper("/");
  return render(
    <Wrapper>
      <JoinLabCard />
    </Wrapper>,
  );
}

beforeEach(() => {
  state.pendingRequests = [];
  state.labResults = [];
  mockApiFetch.mockReset();
  // Default router: pending list + lab lookup are GETs; the send (POST) and
  // cancel (DELETE) resolve to null and let each test override behaviour.
  mockApiFetch.mockImplementation(
    async (path: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (path.includes("/join-requests/mine/pending")) {
        return state.pendingRequests;
      }
      if (path.includes("/labs/lookup")) {
        return { labs: state.labResults };
      }
      if (method === "POST" && path.includes("/join-requests")) {
        return null;
      }
      if (method === "DELETE") {
        return null;
      }
      return null;
    },
  );
});

describe("desktop JoinLabCard — search results", () => {
  it("renders matching labs after typing a query", async () => {
    state.labResults = [
      {
        id: "lab-1",
        name: "Acme Dental Lab",
        displayName: "Acme Dental Lab",
        city: "Austin",
        state: "TX",
      },
    ];
    renderCard();
    await waitFor(() =>
      expect(screen.getByText("Your account is ready")).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByPlaceholderText("Lab name or city"), {
      target: { value: "Acme" },
    });

    await waitFor(
      () => expect(screen.getByText("Acme Dental Lab")).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.getByText("Austin, TX")).toBeInTheDocument();
    expect(screen.getByText("Request to join")).toBeInTheDocument();
  });

  it("shows the empty state when no labs match the query", async () => {
    state.labResults = [];
    renderCard();
    await waitFor(() =>
      expect(screen.getByText("Your account is ready")).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByPlaceholderText("Lab name or city"), {
      target: { value: "zzz" },
    });

    await waitFor(
      () =>
        expect(
          screen.getByText("No labs found. Try a different search."),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });
});

describe("desktop JoinLabCard — send path", () => {
  it("POSTs a join request and transitions to the pending state", async () => {
    state.labResults = [
      {
        id: "lab-1",
        name: "Acme Dental Lab",
        displayName: "Acme Dental Lab",
        city: null,
        state: null,
      },
    ];
    mockApiFetch.mockImplementation(
      async (path: string, init?: { method?: string }) => {
        const method = init?.method ?? "GET";
        if (path.includes("/join-requests/mine/pending")) {
          return state.pendingRequests;
        }
        if (path.includes("/labs/lookup")) {
          return { labs: state.labResults };
        }
        if (method === "POST" && path.includes("/join-requests")) {
          // Simulate the server creating the request: the invalidated pending
          // query now returns it, flipping the card to the pending state.
          state.pendingRequests = [
            {
              id: "jr-1",
              organizationId: "lab-1",
              status: "pending",
              organization: { id: "lab-1", name: "Acme Dental Lab" },
            },
          ];
          return null;
        }
        return null;
      },
    );

    renderCard();
    fireEvent.change(screen.getByPlaceholderText("Lab name or city"), {
      target: { value: "Acme" },
    });
    await waitFor(
      () => expect(screen.getByText("Request to join")).toBeInTheDocument(),
      { timeout: 3000 },
    );

    fireEvent.click(screen.getByText("Request to join"));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/organizations/lab-1/join-requests",
        {
          method: "POST",
          body: JSON.stringify({ requestedRole: "user" }),
        },
      ),
    );
    await waitFor(
      () => expect(screen.getByText("Request pending")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("surfaces a server error when the request fails", async () => {
    state.labResults = [
      {
        id: "lab-1",
        name: "Acme Dental Lab",
        displayName: "Acme Dental Lab",
        city: null,
        state: null,
      },
    ];
    mockApiFetch.mockImplementation(
      async (path: string, init?: { method?: string }) => {
        const method = init?.method ?? "GET";
        if (path.includes("/join-requests/mine/pending")) {
          return state.pendingRequests;
        }
        if (path.includes("/labs/lookup")) {
          return { labs: state.labResults };
        }
        if (method === "POST" && path.includes("/join-requests")) {
          throw new Error("You already requested to join this lab.");
        }
        return null;
      },
    );

    renderCard();
    fireEvent.change(screen.getByPlaceholderText("Lab name or city"), {
      target: { value: "Acme" },
    });
    await waitFor(
      () => expect(screen.getByText("Request to join")).toBeInTheDocument(),
      { timeout: 3000 },
    );

    fireEvent.click(screen.getByText("Request to join"));

    await waitFor(() =>
      expect(
        screen.getByText("You already requested to join this lab."),
      ).toBeInTheDocument(),
    );
  });
});

describe("desktop JoinLabCard — pending state", () => {
  it("renders the pending state when a request already exists", async () => {
    state.pendingRequests = [
      {
        id: "jr-9",
        organizationId: "lab-2",
        status: "pending",
        organization: { id: "lab-2", name: "Bright Smiles Lab", displayName: "Bright Smiles Lab" },
      },
    ];
    renderCard();

    await waitFor(() =>
      expect(screen.getByText("Request pending")).toBeInTheDocument(),
    );
    expect(screen.getByText(/Bright Smiles Lab/)).toBeInTheDocument();
    expect(screen.getByText("Cancel request")).toBeInTheDocument();
  });

  it("cancels the pending request via apiFetch DELETE", async () => {
    state.pendingRequests = [
      {
        id: "jr-9",
        organizationId: "lab-2",
        status: "pending",
        organization: { id: "lab-2", name: "Bright Smiles Lab", displayName: "Bright Smiles Lab" },
      },
    ];
    renderCard();
    await waitFor(() =>
      expect(screen.getByText("Cancel request")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText("Cancel request"));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/organizations/join-requests/jr-9",
        { method: "DELETE" },
      ),
    );
  });
});
