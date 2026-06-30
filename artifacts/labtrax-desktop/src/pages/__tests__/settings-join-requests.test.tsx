/** @vitest-environment jsdom */
/**
 * Integration tests for the lab-admin side of the desktop join-a-lab flow:
 * the pending-join-requests section rendered inside Settings → Profile → Lab
 * team status. Task #2607 covered the requester side (search/send/pending/
 * cancel via JoinLabCard); this covers the admin acting on those requests.
 *
 * The network layer (`apiFetch` from `@/lib/api`) is mocked file-locally and
 * routed by URL. Only the `/auth/lab-team` GET and the approve/reject POSTs are
 * given canned responses; every other apiFetch call throws, mirroring the
 * existing SettingsPage smoke test (where the real apiFetch fails gracefully
 * and unrelated queries land in their error/empty state). `callerRole` is
 * "admin" so the `isTeamAdmin`-gated requests list actually renders.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import SettingsPage from "@/pages/settings";
import { makeAuthWrapper } from "../../__tests__/test-utils";

// ─── Module mocks ─────────────────────────────────────────────────────────────

const mockApiFetch = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  };
});

// ─── Mock network state ──────────────────────────────────────────────────────

interface PendingJoinRequest {
  id: string;
  organizationId: string;
  labName: string | null;
  requestedByUserId: string;
  requestedRole: string | null;
  message: string | null;
  createdAt: string | null;
  requesterName: string | null;
  requesterUsername: string | null;
  requesterEmail: string | null;
}

interface LabTeamResponse {
  team: unknown[];
  callerRole: string | null;
  pendingInvites: unknown[];
  pendingJoinRequests: PendingJoinRequest[];
}

const state: { labTeam: LabTeamResponse } = {
  labTeam: {
    team: [],
    callerRole: "admin",
    pendingInvites: [],
    pendingJoinRequests: [],
  },
};

function makeRequest(overrides: Partial<PendingJoinRequest> = {}): PendingJoinRequest {
  return {
    id: "jr-1",
    organizationId: "lab-1",
    labName: "Acme Dental Lab",
    requestedByUserId: "user-99",
    requestedRole: "user",
    message: null,
    createdAt: null,
    requesterName: "Casey Newhire",
    requesterUsername: "casey",
    requesterEmail: "casey@example.com",
    ...overrides,
  };
}

const ADMIN_USER = {
  id: "user-1",
  username: "admin",
  firstName: "Ada",
  lastName: "Lovelace",
  role: "admin",
};

function renderSettings() {
  const Wrapper = makeAuthWrapper("/settings", {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    user: ADMIN_USER as any,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
  });
  return render(
    <Wrapper>
      <SettingsPage />
    </Wrapper>,
  );
}

beforeEach(() => {
  state.labTeam = {
    team: [],
    callerRole: "admin",
    pendingInvites: [],
    pendingJoinRequests: [],
  };
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation(
    async (path: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (path === "/auth/lab-team") {
        return state.labTeam;
      }
      if (method === "POST" && /\/join-requests\/.+\/approve$/.test(path)) {
        return null;
      }
      if (method === "POST" && /\/join-requests\/.+\/reject$/.test(path)) {
        return null;
      }
      // Mirror the real apiFetch failing for everything else so unrelated
      // SettingsPage queries land in their error/empty state instead of
      // receiving bogus data that would crash their renderers.
      throw new Error(`unmocked apiFetch: ${method} ${path}`);
    },
  );
});

describe("SettingsPage — pending join requests (admin)", () => {
  it("renders an incoming request for a team admin", async () => {
    state.labTeam.pendingJoinRequests = [makeRequest()];
    renderSettings();

    await waitFor(() =>
      expect(screen.getByText("Casey Newhire")).toBeInTheDocument(),
    );
    expect(screen.getByText("Wants to join")).toBeInTheDocument();
    expect(screen.getByText("Approve")).toBeInTheDocument();
  });

  it("does NOT render the requests list when the caller is not an admin", async () => {
    state.labTeam.callerRole = "user";
    state.labTeam.pendingJoinRequests = [makeRequest()];
    // A regular teammate is present so we get a positive signal that the team
    // query resolved (its name renders) without depending on the admin-only
    // requests list or the empty-state.
    state.labTeam.team = [
      {
        id: "user-2",
        username: "teammate",
        firstName: "Pat",
        lastName: "Member",
        role: "user",
        membershipId: "m-2",
        workStatus: "active",
        labNames: ["Acme Dental Lab"],
        isSelf: false,
      },
    ];
    renderSettings();

    // Wait for the team query to settle — the teammate's name appears.
    await waitFor(() =>
      expect(screen.getByText(/Pat/)).toBeInTheDocument(),
    );
    // A non-admin must never see the incoming request or its Approve control.
    expect(screen.queryByText("Casey Newhire")).not.toBeInTheDocument();
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
  });

  it("approves a request via POST and removes it from the list", async () => {
    state.labTeam.pendingJoinRequests = [makeRequest()];
    renderSettings();

    await waitFor(() =>
      expect(screen.getByText("Casey Newhire")).toBeInTheDocument(),
    );

    // The approve onSuccess invalidates ["lab-team"]; make the refetch return
    // an empty list so the approved request drops out and the empty-state shows.
    state.labTeam.pendingJoinRequests = [];

    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/organizations/join-requests/jr-1/approve",
        { method: "POST" },
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("Casey Newhire")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByText("No teammates found.")).toBeInTheDocument(),
    );
  });

  it("rejects a request via POST and removes it from the list", async () => {
    state.labTeam.pendingJoinRequests = [makeRequest()];
    renderSettings();

    await waitFor(() =>
      expect(screen.getByText("Casey Newhire")).toBeInTheDocument(),
    );

    state.labTeam.pendingJoinRequests = [];

    fireEvent.click(screen.getByTitle("Decline request"));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/organizations/join-requests/jr-1/reject",
        { method: "POST" },
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("Casey Newhire")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByText("No teammates found.")).toBeInTheDocument(),
    );
  });
});
