/** @vitest-environment jsdom */
/**
 * Regression guard for the DoctorProfilePanel rename confirmation dialog.
 *
 * Invariants protected:
 *  1. When the backend rejects a rename (4xx / server error), the confirmation
 *     dialog stays open and the error message is shown inline — the dialog
 *     must not silently close, leaving the user with no feedback.
 *  2. When the backend accepts the rename, the dialog closes, a success toast
 *     fires, and the relevant query caches are invalidated.
 *
 * Without these tests a regression in the onError / onSuccess callbacks (e.g.
 * accidentally calling setRenameConfirmOpen(false) before checking the result)
 * would ship silently.
 */

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthContext } from "@/lib/auth-context";
import { MOCK_AUTH_DEFAULTS } from "../../__tests__/test-utils";
import { DoctorProfilePanel } from "@/pages/practices";

// ---------------------------------------------------------------------------
// Transitive heavy deps pulled in through:
//   practices.tsx → customer-detail-tabs.tsx → invoices.tsx → @/lib/export
// None of them are exercised by DoctorProfilePanel; mock them so jsdom
// doesn't crash importing canvas / PDF workers.
// ---------------------------------------------------------------------------
vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

// ---------------------------------------------------------------------------
// API layer — intercept apiFetch without touching the network.
// ---------------------------------------------------------------------------
const apiFetchMock = vi.fn();

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
  apiUrl: (path: string) => `/api${path}`,
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  authedFetch: vi.fn(),
  authedMediaFetch: vi.fn(),
  apiFetchArrayBuffer: vi.fn(),
  createUploadSession: vi.fn(),
  sendUploadChunk: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Toast — capture calls without needing a mounted Toaster container.
// ---------------------------------------------------------------------------
const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  toast: (...args: unknown[]) => toastMock(...args),
  useToast: () => ({ toast: toastMock, toasts: [] }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LAB_ORG_ID = "lab-1";
const PROVIDER_ORG_ID = "prov-1";
const DOCTOR_NAME = "Dr. Synthetic063";
const NEW_DOCTOR_NAME = "Dr. Synthetic047";

/** A minimal resolved doctor profile (no phones, emails, or preferences). */
const EMPTY_PROFILE = { phones: [], emails: [], preferences: "" };

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderPanel(options: { userId?: string } = {}) {
  const queryClient = makeQueryClient();
  const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

  const { hook } = memoryLocation({ path: "/" });
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={hook}>
        <AuthContext.Provider value={MOCK_AUTH_DEFAULTS}>
          <DoctorProfilePanel
            labOrgId={LAB_ORG_ID}
            providerOrgId={PROVIDER_ORG_ID}
            userId={options.userId}
            doctorName={DOCTOR_NAME}
            isAdmin={true}
          />
        </AuthContext.Provider>
      </Router>
    </QueryClientProvider>,
  );

  return { invalidateQueriesSpy, queryClient };
}

/** Wait for the profile to finish loading (loading spinner disappears). */
async function waitForProfileLoaded() {
  await waitFor(() =>
    expect(screen.queryByText(/Loading profile/i)).not.toBeInTheDocument(),
  );
}

/** Open the edit-name input and type a new name. */
async function openRenameInput() {
  await waitForProfileLoaded();
  fireEvent.click(screen.getByRole("button", { name: /Edit name/i }));
  const input = screen.getByDisplayValue(DOCTOR_NAME);
  fireEvent.change(input, { target: { value: NEW_DOCTOR_NAME } });
  return input;
}

/** Open the rename confirmation dialog (clicks Save after changing the name). */
async function openConfirmDialog() {
  await openRenameInput();
  // The edit-name row has a "Save" button (accessible name exactly "Save").
  // The profile section also has "Save profile" — anchor to start+end to avoid
  // matching both with a contains-regex.
  fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
  await waitFor(() =>
    expect(screen.getByText(/Rename doctor\?/i)).toBeInTheDocument(),
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  toastMock.mockReset();
  apiFetchMock.mockReset();
  // Default: profile query resolves with an empty profile.
  apiFetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes("/doctors/profile")) {
      return EMPTY_PROFILE;
    }
    // Rename and any other endpoint: unresolved by default — override per test.
    return {};
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DoctorProfilePanel — rename confirmation dialog", () => {
  it("opens the confirmation dialog when the user clicks Save with a changed name", async () => {
    renderPanel();
    await openRenameInput();

    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() =>
      expect(screen.getByText(/Rename doctor\?/i)).toBeInTheDocument(),
    );
    // The confirmation copy shows both the old and new names.
    expect(screen.getByText(DOCTOR_NAME)).toBeInTheDocument();
    expect(screen.getByText(NEW_DOCTOR_NAME)).toBeInTheDocument();
  });

  it("does NOT open the dialog when the name is unchanged", async () => {
    renderPanel();
    await waitForProfileLoaded();
    fireEvent.click(screen.getByRole("button", { name: /Edit name/i }));
    // Name input starts at DOCTOR_NAME — click Save without changing it.
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    // Dialog must not appear; the edit field simply closes.
    expect(screen.queryByText(/Rename doctor\?/i)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByDisplayValue(DOCTOR_NAME)).not.toBeInTheDocument(),
    );
  });

  // -----------------------------------------------------------------------
  // Error path — the core regression guard for this task
  // -----------------------------------------------------------------------

  it("shows the error and keeps the dialog open when the backend rejects the rename", async () => {
    const SERVER_ERROR = "A doctor with that name already exists at this practice.";
    apiFetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/doctors/profile")) return EMPTY_PROFILE;
      if (String(url).includes("/doctors/rename")) {
        throw new Error(SERVER_ERROR);
      }
      return {};
    });

    renderPanel();
    await openConfirmDialog();

    // Trigger the rename mutation.
    fireEvent.click(screen.getByRole("button", { name: /^Rename$/i }));

    // The error message must surface below the name field.
    await waitFor(() =>
      expect(screen.getByText(SERVER_ERROR)).toBeInTheDocument(),
    );

    // The dialog must remain open so the user can correct the name.
    expect(screen.getByText(/Rename doctor\?/i)).toBeInTheDocument();

    // No success toast.
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Doctor renamed" }),
    );
  });

  it("keeps the dialog open on a 409 conflict error (duplicate name)", async () => {
    const CONFLICT_MESSAGE = "Doctor name already in use.";
    apiFetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/doctors/profile")) return EMPTY_PROFILE;
      if (String(url).includes("/doctors/rename")) {
        // Simulate a 4xx ApiError the same way apiFetch would throw one.
        const err = Object.assign(new Error(CONFLICT_MESSAGE), { status: 409 });
        throw err;
      }
      return {};
    });

    renderPanel();
    await openConfirmDialog();

    fireEvent.click(screen.getByRole("button", { name: /^Rename$/i }));

    await waitFor(() =>
      expect(screen.getByText(CONFLICT_MESSAGE)).toBeInTheDocument(),
    );
    // Dialog stays open.
    expect(screen.getByText(/Rename doctor\?/i)).toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Success path
  // -----------------------------------------------------------------------

  it("closes the dialog, fires a toast, and invalidates queries on success", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/doctors/profile")) return EMPTY_PROFILE;
      if (String(url).includes("/doctors/rename")) return {};
      return {};
    });

    const { invalidateQueriesSpy } = renderPanel();
    await openConfirmDialog();

    fireEvent.click(screen.getByRole("button", { name: /^Rename$/i }));

    // Dialog must close.
    await waitFor(() =>
      expect(screen.queryByText(/Rename doctor\?/i)).not.toBeInTheDocument(),
    );

    // Success toast must fire.
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Doctor renamed" }),
    );

    // The query caches the rename touches must be invalidated.
    expect(invalidateQueriesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["organizations"]) }),
    );
    expect(invalidateQueriesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["cases"]) }),
    );
    expect(invalidateQueriesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["pricing-overrides"]) }),
    );
  });

  it("Cancel in the dialog closes it without calling the rename endpoint", async () => {
    renderPanel();
    await openConfirmDialog();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    await waitFor(() =>
      expect(screen.queryByText(/Rename doctor\?/i)).not.toBeInTheDocument(),
    );

    // The rename endpoint must not have been called.
    const renameCalls = apiFetchMock.mock.calls.filter(([url]: [string]) =>
      String(url).includes("/doctors/rename"),
    );
    expect(renameCalls).toHaveLength(0);
    expect(toastMock).not.toHaveBeenCalled();
  });
});

describe("DoctorProfilePanel — practice assignments", () => {
  const USER_ID = "provider-user-1";
  const assignments = [
    {
      practiceOrganizationId: PROVIDER_ORG_ID,
      practiceName: "Bright Dental",
      accountNumber: "2603-BC-1",
      membershipId: "membership-1",
      status: "active",
      assigned: true,
    },
    {
      practiceOrganizationId: "prov-2",
      practiceName: "South Ridge Dental",
      accountNumber: "SDR1-1280-BG-1",
      membershipId: "membership-2",
      status: "active",
      assigned: true,
    },
  ];

  it("renders selected account numbers as a semicolon-separated summary", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/doctors/profile")) return EMPTY_PROFILE;
      if (String(url).includes("/doctors/assignments")) {
        return {
          userId: USER_ID,
          providerOrgId: PROVIDER_ORG_ID,
          assignments,
        };
      }
      return {};
    });

    renderPanel({ userId: USER_ID });

    expect(
      await screen.findByTestId("assigned-account-number-summary"),
    ).toHaveTextContent("2603-BC-1; SDR1-1280-BG-1");
    expect(screen.getByText("Provider Portal Access")).toBeInTheDocument();
    expect(screen.getByLabelText(/Bright Dental/i)).toBeDisabled();
  });

  it("does not expose provider portal access controls to non-admins", async () => {
    const queryClient = makeQueryClient();
    const { hook } = memoryLocation({ path: "/" });
    render(
      <QueryClientProvider client={queryClient}>
        <Router hook={hook}>
          <AuthContext.Provider value={MOCK_AUTH_DEFAULTS}>
            <DoctorProfilePanel
              labOrgId={LAB_ORG_ID}
              providerOrgId={PROVIDER_ORG_ID}
              userId={USER_ID}
              doctorName={DOCTOR_NAME}
              isAdmin={false}
            />
          </AuthContext.Provider>
        </Router>
      </QueryClientProvider>,
    );
    await waitForProfileLoaded();
    expect(screen.queryByText("Provider Portal Access")).not.toBeInTheDocument();
    expect(
      apiFetchMock.mock.calls.some(([url]) =>
        String(url).includes("/doctors/assignments"),
      ),
    ).toBe(false);
  });

  it("confirms removal and saves only the remaining practice", async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/doctors/profile")) return EMPTY_PROFILE;
      if (
        String(url).includes("/doctors/assignments") &&
        init?.method === "PUT"
      ) {
        return {
          userId: USER_ID,
          providerOrgId: PROVIDER_ORG_ID,
          assignments: [
            assignments[0],
            { ...assignments[1], assigned: false, status: "available" },
          ],
        };
      }
      if (String(url).includes("/doctors/assignments")) {
        return {
          userId: USER_ID,
          providerOrgId: PROVIDER_ORG_ID,
          assignments,
        };
      }
      return {};
    });

    renderPanel({ userId: USER_ID });
    const secondPractice = await screen.findByLabelText(
      /South Ridge Dental/i,
    );
    fireEvent.click(secondPractice);
    fireEvent.click(
      screen.getByRole("button", { name: /Save assignments/i }),
    );

    expect(
      await screen.findByText(/Remove practice access\?/i),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /Remove access and save/i }),
    );

    await waitFor(() => {
      const putCall = apiFetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).includes("/doctors/assignments") &&
          (init as RequestInit | undefined)?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      expect(JSON.parse((putCall?.[1] as RequestInit).body as string)).toEqual({
        providerOrgId: PROVIDER_ORG_ID,
        userId: USER_ID,
        practiceOrganizationIds: [PROVIDER_ORG_ID],
      });
    });
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Practice assignments saved" }),
    );
  });
});
