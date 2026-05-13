import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react-native";

import LinkLabsScreen from "@/app/link-labs";

type FetchMock = ReturnType<typeof vi.fn>;

function installFetchMock(payload: unknown): FetchMock {
  const mock: FetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

beforeEach(() => {
  installFetchMock({
    data: {
      linked: [],
      pendingInvitesSent: [],
      pendingInvitesReceived: [],
    },
  });
});

describe("LinkLabsScreen (smoke)", () => {
  it("renders the intro copy and the manual-link section", async () => {
    render(<LinkLabsScreen />);

    expect(
      await screen.findByText(/Working with more than one lab/i),
    ).toBeTruthy();
    expect(screen.getByText(/Link by account number/i)).toBeTruthy();
    expect(screen.getByText(/Link account/i)).toBeTruthy();
  });

  it("loads the user's existing links on mount via /account-links", async () => {
    const fetchMock = installFetchMock({
      data: {
        linked: [],
        pendingInvitesSent: [],
        pendingInvitesReceived: [],
      },
    });
    render(<LinkLabsScreen />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const firstCall = fetchMock.mock.calls[0];
    const calledUrl = String(firstCall?.[0] ?? "");
    expect(calledUrl).toContain("/api/account-links");
  });

  it("shows the empty-state message when there are no linked accounts", async () => {
    render(<LinkLabsScreen />);
    expect(await screen.findByText(/No linked accounts yet/i)).toBeTruthy();
  });

  it("renders linked accounts returned by the server", async () => {
    installFetchMock({
      data: {
        linked: [
          {
            userId: "u1",
            username: "drsmith",
            firstName: "John",
            lastName: "Smith",
            platformAccountNumber: "2926JS",
            labs: ["Acme Lab"],
          },
        ],
        pendingInvitesSent: [],
        pendingInvitesReceived: [],
      },
    });

    render(<LinkLabsScreen />);
    expect(await screen.findByText(/John Smith/)).toBeTruthy();
    expect(screen.getByText(/2926JS/)).toBeTruthy();
    expect(screen.getByText(/Acme Lab/)).toBeTruthy();
    expect(screen.getByText(/Unlink/)).toBeTruthy();
  });

  it("renders received invites with Link / Dismiss buttons", async () => {
    installFetchMock({
      data: {
        linked: [],
        pendingInvitesSent: [],
        pendingInvitesReceived: [
          {
            inviteId: "inv-1",
            fromUser: {
              userId: "u9",
              username: "drother",
              firstName: null,
              lastName: null,
              platformAccountNumber: "1234XX",
              labs: ["Other Lab"],
            },
            sentAt: null,
            status: "pending",
          },
        ],
      },
    });

    render(<LinkLabsScreen />);
    expect(await screen.findByText(/Invites for you/i)).toBeTruthy();
    expect(screen.getByText(/1234XX/)).toBeTruthy();
    expect(screen.getByText("Link")).toBeTruthy();
    expect(screen.getByText("Dismiss")).toBeTruthy();
  });
});
