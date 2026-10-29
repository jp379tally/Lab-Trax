import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import {
  clearAiReaderSession,
  setAiReaderSession,
} from "@/lib/ai-reader-store";
import AiReaderExtractedScreen from "@/app/ai-reader/extracted";
import {
  mockCreateCaseMutateAsync,
  resetMockAppState,
  resetMockFetchHandler,
  setMockAppState,
  setMockFetchHandler,
} from "../../vitest.setup";

const LAB_ID = "turnaround-lab";
const PROVIDER_ID = "turnaround-provider";

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function todayLocal(): string {
  const now = new Date();
  return isoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function addDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day + days);
  return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function seedReview({
  turnaroundDays = 7,
  receivedAt = "2026-08-01",
  rxDueDate = "2026-08-05",
}: {
  turnaroundDays?: number | null;
  receivedAt?: string | null;
  rxDueDate?: string | null;
} = {}) {
  setMockAppState({
    meMemberships: [
      {
        id: "turnaround-membership",
        role: "owner",
        status: "active",
        organizationId: LAB_ID,
        organization: {
          id: LAB_ID,
          name: "Turnaround Lab",
          type: "lab",
          ...(turnaroundDays != null ? { defaultCaseDueDays: turnaroundDays } : {}),
        },
      },
    ],
    labProviders: [{ id: PROVIDER_ID, name: "Bright Smile Dental" }],
  });
  setAiReaderSession({
    pages: [],
    extracted: {
      doctorName: "Dr. Synthetic",
      patientName: "Jane Doe",
      patientInitials: null,
      caseType: null,
      toothIndices: null,
      shade: null,
      material: null,
      dueDate: rxDueDate,
      isRush: null,
      notes: null,
      practiceName: "Bright Smile Dental",
      practiceAddress: null,
      practicePhone: null,
      confidence: null,
      step: null,
      gingivialShade: null,
    },
    userOverrides: receivedAt ? { receivedAt } : {},
  });
}

function installFetchHandler() {
  setMockFetchHandler((url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/api/rx-practice-aliases") && method === "GET") {
      return new Response(
        JSON.stringify({ data: { found: true, providerOrganizationId: PROVIDER_ID } }),
        { status: 200 },
      );
    }
    if (url.includes("/api/rx-practice-aliases") && method === "POST") {
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }
    if (url.includes("/api/cases/patient-similarity")) {
      return new Response(JSON.stringify({ data: { matches: [] } }), { status: 200 });
    }
    if (url.includes("/api/doctors/resolve-name")) {
      return new Response(
        JSON.stringify({
          data: { exactMatch: "Dr. Synthetic", similarMatches: [], canAddNew: true },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ data: null }), { status: 200 });
  });
}

type RenderedScreen = Awaited<ReturnType<typeof render>>;

async function renderReview(): Promise<RenderedScreen> {
  installFetchHandler();
  const screen = await render(<AiReaderExtractedScreen />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await fireEvent.changeText(screen.getByPlaceholderText("e.g. 26-42"), "26-42");
  return screen;
}

function dateFieldText(screen: RenderedScreen, testID: string): string {
  const children = screen.getByTestId(testID).props.children;
  const label = Array.isArray(children) ? children[0] : children;
  return String(label?.props?.children ?? "");
}

async function typeDate(screen: RenderedScreen, testID: string, value: string) {
  await fireEvent.press(screen.getByTestId(testID));
  await fireEvent.press(screen.getByTestId(`${testID}-type`));
  await fireEvent.changeText(screen.getByTestId(`${testID}-typed-input`), value);
  await fireEvent.press(screen.getByTestId(`${testID}-typed-confirm`));
}

afterEach(() => {
  cleanup();
  resetMockAppState();
  resetMockFetchHandler();
  clearAiReaderSession();
  vi.clearAllMocks();
});

describe("AI intake turnaround dates on mobile", () => {
  it("defaults Received date to today and pre-fills Lab due date seven days later", async () => {
    seedReview({ receivedAt: null });
    const screen = await renderReview();

    expect(dateFieldText(screen, "ai-reader-received-date")).toBe(
      todayLocal().slice(5, 7) + "/" + todayLocal().slice(8, 10) + "/" + todayLocal().slice(0, 4),
    );
    const expectedLabDueDate = addDays(todayLocal(), 7);
    expect(dateFieldText(screen, "ai-reader-lab-due-date")).toBe(
      expectedLabDueDate.slice(5, 7) + "/" + expectedLabDueDate.slice(8, 10) + "/" + expectedLabDueDate.slice(0, 4),
    );
  });

  it("recalculates the default when Received date changes but keeps a manual Lab due date", async () => {
    seedReview();
    const screen = await renderReview();
    expect(dateFieldText(screen, "ai-reader-lab-due-date")).toBe("08/08/2026");

    await typeDate(screen, "ai-reader-received-date", "08/02/2026");
    expect(dateFieldText(screen, "ai-reader-lab-due-date")).toBe("08/09/2026");

    await typeDate(screen, "ai-reader-lab-due-date", "08/12/2026");
    await typeDate(screen, "ai-reader-received-date", "08/03/2026");
    expect(dateFieldText(screen, "ai-reader-lab-due-date")).toBe("08/12/2026");
  });

  it("omits an Rx date before the received date", async () => {
    seedReview({ rxDueDate: "2026-07-31" });
    const screen = await renderReview();
    expect(screen.queryByTestId("ai-reader-rx-due-date")).toBeNull();
  });

  it("shows an Rx date on the inclusive turnaround boundary with a warning", async () => {
    seedReview({ rxDueDate: "2026-08-08" });
    const screen = await renderReview();
    expect(dateFieldText(screen, "ai-reader-rx-due-date")).toBe("08/08/2026");
    expect(screen.getByText(/within the lab’s 7-day turnaround/)).toBeTruthy();
  });

  it("omits an Rx date after the turnaround boundary", async () => {
    seedReview({ rxDueDate: "2026-08-09" });
    const screen = await renderReview();
    expect(screen.queryByTestId("ai-reader-rx-due-date")).toBeNull();
  });

  it("keeps a missing Rx date editable and preserves manual date entry without a preference", async () => {
    seedReview({ turnaroundDays: null, rxDueDate: null });
    const screen = await renderReview();

    expect(dateFieldText(screen, "ai-reader-lab-due-date")).toBe("YYYY-MM-DD");
    expect(dateFieldText(screen, "ai-reader-rx-due-date")).toBe("YYYY-MM-DD");
    expect(screen.getByText(/No lab turnaround is configured/)).toBeTruthy();

    await typeDate(screen, "ai-reader-lab-due-date", "08/15/2026");
    await typeDate(screen, "ai-reader-rx-due-date", "08/12/2026");
    expect(dateFieldText(screen, "ai-reader-lab-due-date")).toBe("08/15/2026");
    expect(dateFieldText(screen, "ai-reader-rx-due-date")).toBe("08/12/2026");
  });

  it("submits the reviewed Lab and eligible Rx dates as distinct values", async () => {
    seedReview({ rxDueDate: "2026-08-05" });
    mockCreateCaseMutateAsync.mockResolvedValueOnce({
      ok: true,
      data: { id: "turnaround-case" },
    });
    const screen = await renderReview();
    expect(dateFieldText(screen, "ai-reader-lab-due-date")).toBe("08/08/2026");
    expect(dateFieldText(screen, "ai-reader-rx-due-date")).toBe("08/05/2026");
    await typeDate(screen, "ai-reader-received-date", "08/02/2026");
    await typeDate(screen, "ai-reader-lab-due-date", "08/10/2026");
    expect(dateFieldText(screen, "ai-reader-lab-due-date")).toBe("08/10/2026");
    expect(dateFieldText(screen, "ai-reader-rx-due-date")).toBe("08/05/2026");

    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalledTimes(1));
    const submitted = mockCreateCaseMutateAsync.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(submitted.data.receivedAt).toBe("2026-08-02");
    expect(submitted.data.dueDate).toBe("2026-08-10");
    expect(submitted.data.prescriptionDueDate).toBe("2026-08-05");
    expect(submitted.data.aiIntakeReviewedDates).toBe(true);
  });

  it("does not submit an out-of-window extracted Rx date", async () => {
    seedReview({ rxDueDate: "2026-08-09" });
    mockCreateCaseMutateAsync.mockResolvedValueOnce({
      ok: true,
      data: { id: "turnaround-case-outside-rx-window" },
    });
    const screen = await renderReview();
    expect(screen.queryByTestId("ai-reader-rx-due-date")).toBeNull();

    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalledTimes(1));
    const submitted = mockCreateCaseMutateAsync.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(submitted.data.prescriptionDueDate).toBeUndefined();
  });
});
