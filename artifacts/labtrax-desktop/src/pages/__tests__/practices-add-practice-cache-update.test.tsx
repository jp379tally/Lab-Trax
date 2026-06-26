/** @vitest-environment jsdom */
/**
 * Regression suite: AddPracticeDialog cache update (Customer Center visibility)
 *
 * When a lab admin adds a new practice from Customer Center (/accounts), the
 * new practice must appear in the table immediately — without a manual refresh.
 * This test pins two invariants:
 *
 * 1. After a successful POST /organizations, `queryClient.setQueriesData` is
 *    called with the `["organizations"]` prefix filter and an updater that
 *    inserts the new org — so every cache entry keyed under `["organizations"]`
 *    (including the Customer Center key with `includeLabPractices`) is updated
 *    synchronously before the background refetch triggered by `invalidateQueries`.
 *
 * 2. When `onNavigateToPractice` is provided, it is called (not `onClose`)
 *    after a no-doctor creation so the caller can expand/highlight the new row.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthContext } from "@/lib/auth-context";
import { MOCK_AUTH_DEFAULTS } from "../../__tests__/test-utils";
import type { Organization } from "@/lib/types";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

import { AddPracticeDialog } from "@/pages/practices";

const EXISTING_LAB: Organization = {
  id: "lab1",
  type: "lab",
  name: "Acme Dental Lab",
  displayName: "Acme Dental Lab",
} as Organization;

const NEW_ORG: Organization = {
  id: "new-practice-99",
  type: "provider",
  name: "Bright Smile Dental",
  displayName: "Bright Smile Dental",
  parentLabOrganizationId: "lab1",
} as Organization;

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

function makeWrapper(queryClient: QueryClient) {
  const { hook } = memoryLocation({ path: "/" });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <Router hook={hook}>
          <AuthContext.Provider value={MOCK_AUTH_DEFAULTS}>
            {children}
          </AuthContext.Provider>
        </Router>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
    if (url === "/organizations" && opts?.method !== "POST") {
      return Promise.resolve([EXISTING_LAB]);
    }
    if (url === "/organizations" && opts?.method === "POST") {
      return Promise.resolve(NEW_ORG);
    }
    return Promise.resolve(null);
  });
});

describe("AddPracticeDialog — cache update on creation (Customer Center visibility)", () => {
  it("calls setQueriesData with the ['organizations'] prefix so the Customer Center cache is updated synchronously", async () => {
    const queryClient = makeQueryClient();

    const accountsQueryKey = [
      "organizations",
      { includeArchived: true, includeLabPractices: true },
    ];
    queryClient.setQueryData<Organization[]>(accountsQueryKey, [EXISTING_LAB]);

    const setQueriesDataSpy = vi.spyOn(queryClient, "setQueriesData");

    const onClose = vi.fn();
    const onNavigateToPractice = vi.fn();

    render(
      <AddPracticeDialog
        adminLabOrgIds={["lab1"]}
        onClose={onClose}
        onNavigateToPractice={onNavigateToPractice}
      />,
      { wrapper: makeWrapper(queryClient) },
    );

    const label = screen.getByText("Legal name");
    const nameInput = label.parentElement?.querySelector("input") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Bright Smile Dental" } });
    fireEvent.click(screen.getByRole("button", { name: "Create practice" }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/organizations",
        expect.objectContaining({ method: "POST" }),
      ),
    );

    await waitFor(() => expect(onNavigateToPractice).toHaveBeenCalledWith(NEW_ORG.id));

    expect(setQueriesDataSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["organizations"] }),
      expect.any(Function),
    );

    const updaterArg = setQueriesDataSpy.mock.calls[0][1] as (old: Organization[]) => Organization[];
    const result = updaterArg([EXISTING_LAB]);
    expect(result).toContainEqual(expect.objectContaining({ id: NEW_ORG.id }));

    const cached = queryClient.getQueryData<Organization[]>(accountsQueryKey);
    expect(cached?.some((o) => o.id === NEW_ORG.id)).toBe(true);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onNavigateToPractice with the new org id (not onClose) when no doctors are added", async () => {
    const queryClient = makeQueryClient();
    const onClose = vi.fn();
    const onNavigateToPractice = vi.fn();

    render(
      <AddPracticeDialog
        adminLabOrgIds={["lab1"]}
        onClose={onClose}
        onNavigateToPractice={onNavigateToPractice}
      />,
      { wrapper: makeWrapper(queryClient) },
    );

    const label = screen.getByText("Legal name");
    const nameInput = label.parentElement?.querySelector("input") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Bright Smile Dental" } });
    fireEvent.click(screen.getByRole("button", { name: "Create practice" }));

    await waitFor(() =>
      expect(onNavigateToPractice).toHaveBeenCalledWith(NEW_ORG.id),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("falls back to onClose when onNavigateToPractice is not provided (no doctors)", async () => {
    const queryClient = makeQueryClient();
    const onClose = vi.fn();

    render(
      <AddPracticeDialog adminLabOrgIds={["lab1"]} onClose={onClose} />,
      { wrapper: makeWrapper(queryClient) },
    );

    const label = screen.getByText("Legal name");
    const nameInput = label.parentElement?.querySelector("input") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Bright Smile Dental" } });
    fireEvent.click(screen.getByRole("button", { name: "Create practice" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
