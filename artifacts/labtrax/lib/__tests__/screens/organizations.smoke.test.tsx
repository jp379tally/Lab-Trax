import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  resetMockAppState,
  setMockFetchHandler,
  resetMockFetchHandler,
} from "../../../vitest.setup";

import OrganizationsScreen from "@/app/settings/organizations";

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

const LAB_USER_NO_MEMBERSHIP = {
  data: { user: { id: "u1", userType: "lab" }, memberships: [] },
  isLoading: false,
  isError: false,
} as const;

const PROVIDER_USER_NO_MEMBERSHIP = {
  data: { user: { id: "u2", userType: "provider" }, memberships: [] },
  isLoading: false,
  isError: false,
} as const;

const LAB_USER_WITH_ACTIVE_LAB = {
  data: {
    user: { id: "u3", userType: "lab" },
    memberships: [
      {
        id: "mem-1",
        role: "owner",
        status: "active",
        organizationId: "org-1",
        organization: { id: "org-1", type: "lab", name: "My Dental Lab" },
      },
    ],
  },
  isLoading: false,
  isError: false,
} as const;

// The screen renders several `useQuery` consumers (meQuery, clusterQuery,
// invitesQuery). A blanket `mockReturnValue` would feed the me-response shape
// to every one of them — including `PendingInvitesCard`, whose `invitesQuery`
// expects an array (`invites.map`). Mock per query key so each consumer gets a
// shape it can handle; the `meValue` under test drives the me-query only.
function applyUseQueryMock(meValue: unknown) {
  vi.mocked(useQuery).mockImplementation((options: any) => {
    const key = options?.queryKey ?? [];
    const head = Array.isArray(key) ? key[0] : key;
    if (head === "pending-invites") {
      return { data: [], isLoading: false, isError: false } as any;
    }
    if (head === "org-clusters") {
      return { data: undefined, isLoading: false, isError: false } as any;
    }
    return meValue as any;
  });
}

afterEach(() => {
  cleanup();
  resetMockAppState();
  resetMockFetchHandler();
  vi.mocked(useQuery).mockReset();
  vi.clearAllMocks();
});

describe("OrganizationsScreen — Create lab button visibility", () => {
  it("shows the Create lab button when userType is lab and no active lab membership", () => {
    applyUseQueryMock(LAB_USER_NO_MEMBERSHIP);
    const { getByTestId } = render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });
    expect(getByTestId("create-lab-open-btn")).toBeTruthy();
  });

  it("hides the Create lab button when userType is provider (not lab)", () => {
    applyUseQueryMock(PROVIDER_USER_NO_MEMBERSHIP);
    const { queryByTestId } = render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });
    expect(queryByTestId("create-lab-open-btn")).toBeNull();
  });

  it("hides the Create lab button when the user already has an active lab membership", () => {
    applyUseQueryMock(LAB_USER_WITH_ACTIVE_LAB);
    const { queryByTestId } = render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });
    expect(queryByTestId("create-lab-open-btn")).toBeNull();
  });
});

describe("OrganizationsScreen — CreateLabSheet required-field guard", () => {
  beforeEach(() => {
    applyUseQueryMock(LAB_USER_NO_MEMBERSHIP);
  });

  it("shows an inline error and does not POST when all required fields are empty", async () => {
    setMockFetchHandler(() =>
      new Response(JSON.stringify({ error: "LAB_NAME_TAKEN" }), { status: 409 }),
    );
    const { getByTestId, getByText } = render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });

    fireEvent.press(getByTestId("form-save"));

    await waitFor(() => {
      expect(
        getByText(/lab name, license number, phone, email, and street address are required/i),
      ).toBeTruthy();
    });
  });

  it("shows an inline error when only the lab name is filled (4 remaining fields empty)", async () => {
    setMockFetchHandler(() =>
      new Response(JSON.stringify({ error: "UNEXPECTED" }), { status: 500 }),
    );
    const { getByTestId, getByText, getAllByPlaceholderText } = render(
      <OrganizationsScreen />,
      { wrapper: makeWrapper() },
    );

    fireEvent.changeText(getAllByPlaceholderText("Acme Dental Lab")[0], "Test Lab");

    fireEvent.press(getByTestId("form-save"));

    await waitFor(() => {
      expect(
        getByText(/lab name, license number, phone, email, and street address are required/i),
      ).toBeTruthy();
    });
  });
});

describe("OrganizationsScreen — CreateLabSheet server error surfacing", () => {
  beforeEach(() => {
    applyUseQueryMock(LAB_USER_NO_MEMBERSHIP);
  });

  it("surfaces a LAB_NAME_TAKEN error inline after a 409 from /api/organizations", async () => {
    setMockFetchHandler((url) => {
      if (url.includes("/api/organizations")) {
        return new Response(JSON.stringify({ error: "LAB_NAME_TAKEN" }), {
          status: 409,
        });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const { getByTestId, getByText, getAllByPlaceholderText } = render(
      <OrganizationsScreen />,
      { wrapper: makeWrapper() },
    );

    fireEvent.changeText(getAllByPlaceholderText("Acme Dental Lab")[0], "Acme Lab");
    fireEvent.changeText(getAllByPlaceholderText("Lab license number")[0], "LIC-123");
    fireEvent.changeText(getAllByPlaceholderText("000-000-0000")[0], "555-000-1111");
    fireEvent.changeText(getAllByPlaceholderText("lab@example.com")[0], "lab@example.com");
    fireEvent.changeText(getAllByPlaceholderText("123 Main St")[0], "100 Elm St");

    fireEvent.press(getByTestId("form-save"));

    await waitFor(() => {
      expect(getByText("LAB_NAME_TAKEN")).toBeTruthy();
    });
  });

  it("surfaces a generic server error inline when /api/organizations returns 500", async () => {
    setMockFetchHandler((url) => {
      if (url.includes("/api/organizations")) {
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
        });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const { getByTestId, getByText, getAllByPlaceholderText } = render(
      <OrganizationsScreen />,
      { wrapper: makeWrapper() },
    );

    fireEvent.changeText(getAllByPlaceholderText("Acme Dental Lab")[0], "Acme Lab");
    fireEvent.changeText(getAllByPlaceholderText("Lab license number")[0], "LIC-123");
    fireEvent.changeText(getAllByPlaceholderText("000-000-0000")[0], "555-000-1111");
    fireEvent.changeText(getAllByPlaceholderText("lab@example.com")[0], "lab@example.com");
    fireEvent.changeText(getAllByPlaceholderText("123 Main St")[0], "100 Elm St");

    fireEvent.press(getByTestId("form-save"));

    await waitFor(() => {
      expect(getByText("Internal server error")).toBeTruthy();
    });
  });
});
