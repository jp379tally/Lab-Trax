import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  resetMockAppState,
  setMockAppState,
  setMockFetchHandler,
  resetMockFetchHandler,
  triggerMockBarcodeScan,
  mockUpdateCaseMutateAsync,
} from "../../../vitest.setup";
import { resilientFetch } from "@/lib/query-client";
import * as Haptics from "expo-haptics";

import BatchLocateScreen from "@/app/batch-locate/index";

// ── barcode-guide-box mock ────────────────────────────────────────────────────
// We stub pickBestBarcode to control the "out-of-box → ignored" and
// "in-box → lookup" paths independently from the real guide-box geometry.
//
// vi.hoisted is required: vi.mock factories are hoisted to the top of the file
// by Vitest, so any variable they reference must also be hoisted.
const mockPickBestBarcode = vi.hoisted(() => vi.fn());

vi.mock("@/lib/barcode-guide-box", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/barcode-guide-box")>();
  return { ...actual, pickBestBarcode: mockPickBestBarcode };
});

// ── helpers ───────────────────────────────────────────────────────────────────

const LAB_MEMBERSHIP = {
  organizationId: "lab-org-batch-smoke",
  status: "active",
  role: "admin",
  organization: { type: "lab" },
};

function renderScanner() {
  return render(<BatchLocateScreen />);
}

function simulateScannerLayout(utils: ReturnType<typeof render>) {
  const area = utils.getByTestId("batch-locate-scanner-area");
  fireEvent(area, "layout", {
    nativeEvent: { layout: { width: 400, height: 600 } },
  });
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  // The haptics mock (vi.mock in vitest.setup) returns undefined by default;
  // the production code calls .catch() on the return value, so we need a
  // real Promise here to avoid a "Cannot read properties of undefined" crash.
  vi.mocked(Haptics.impactAsync).mockResolvedValue(undefined as never);
});

afterEach(() => {
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("BatchLocateScreen — scanner step", () => {
  it("renders the scanning step without throwing", () => {
    expect(() => renderScanner()).not.toThrow();
  });

  it("shows the Batch Locate header and initial prompt", () => {
    const { getByText } = renderScanner();
    expect(getByText("Batch Locate")).toBeTruthy();
    expect(getByText("Scan case pans to build your batch")).toBeTruthy();
  });

  it("Continue button is disabled when no cases have been scanned", () => {
    const { getByTestId } = renderScanner();
    const btn = getByTestId("batch-locate-continue");
    expect(btn.props.accessibilityState?.disabled ?? btn.props.disabled).toBe(true);
  });

  describe("guide-box filter wiring", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      setMockAppState({ meMemberships: [LAB_MEMBERSHIP] });
    });

    it("does NOT issue a lookup when pickBestBarcode returns null (out-of-box barcode)", () => {
      mockPickBestBarcode.mockReturnValue(null);

      const utils = renderScanner();
      simulateScannerLayout(utils);

      triggerMockBarcodeScan("OUT-OF-BOX-BATCH-001", null);

      // Run the 120 ms debounce synchronously; no async lookup should follow.
      act(() => { vi.runAllTimers(); });

      expect(resilientFetch).not.toHaveBeenCalledWith(
        expect.stringContaining("barcode"),
      );
    });

    it("issues a lookup when pickBestBarcode returns a barcode (in-box barcode)", async () => {
      mockPickBestBarcode.mockReturnValue({ data: "IN-BOX-BATCH-001" });
      setMockFetchHandler(() =>
        new Response(JSON.stringify({ ok: false }), { status: 404 }),
      );

      const utils = renderScanner();
      simulateScannerLayout(utils);

      triggerMockBarcodeScan("IN-BOX-BATCH-001", null);
      act(() => { vi.runAllTimers(); });

      // Switch back to real timers so waitFor polling works normally.
      vi.useRealTimers();

      await waitFor(() => {
        expect(resilientFetch).toHaveBeenCalledWith(
          expect.stringContaining("IN-BOX-BATCH-001"),
        );
      });
    });

    it("appends a found case to the scanned list after a successful in-box scan", async () => {
      mockPickBestBarcode.mockReturnValue({ data: "PAN-ABC-123" });
      setMockFetchHandler(() =>
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              case: {
                id: "case-batch-001",
                patientFirstName: "Bob",
                patientLastName: "Baker",
                caseNumber: "8001",
                status: "received",
              },
            },
          }),
          { status: 200 },
        ),
      );

      const utils = renderScanner();
      simulateScannerLayout(utils);

      triggerMockBarcodeScan("PAN-ABC-123", null);
      act(() => { vi.runAllTimers(); });

      vi.useRealTimers();

      await waitFor(() => {
        expect(utils.getByText("Bob Baker")).toBeTruthy();
      });

      // Subtitle updates to show the count.
      expect(utils.getByText("Scanned: 1 Case")).toBeTruthy();
    });

    it("does NOT append a duplicate barcode to the scanned list", async () => {
      mockPickBestBarcode.mockReturnValue({ data: "PAN-DUP-001" });
      setMockFetchHandler(() =>
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              case: {
                id: "case-dup-001",
                patientFirstName: "Carol",
                patientLastName: "Chen",
                caseNumber: "8002",
                status: "received",
              },
            },
          }),
          { status: 200 },
        ),
      );

      const utils = renderScanner();
      simulateScannerLayout(utils);

      // First scan — should succeed.
      triggerMockBarcodeScan("PAN-DUP-001", null);
      act(() => { vi.runAllTimers(); });

      vi.useRealTimers();
      await waitFor(() => expect(utils.getByText("Carol Chen")).toBeTruthy());

      // Second scan of the same barcode — should be rejected as a duplicate.
      vi.useFakeTimers();
      mockPickBestBarcode.mockReturnValue({ data: "PAN-DUP-001" });
      triggerMockBarcodeScan("PAN-DUP-001", null);
      act(() => { vi.runAllTimers(); });
      vi.useRealTimers();

      // Still only 1 case in the list.
      expect(utils.getByText("Scanned: 1 Case")).toBeTruthy();
    });
  });
});

// ── Move → result transition ───────────────────────────────────────────────
//
// These tests drive the full scanner → selecting → confirming → result flow,
// verifying that the result screen appears with accurate counts only after
// cache invalidation completes, and that partial-failure details render
// correctly.

const MOVE_CASE_RESPONSE = {
  ok: true,
  data: {
    case: {
      id: "case-move-001",
      patientFirstName: "Alice",
      patientLastName: "Adams",
      caseNumber: "9001",
      status: "received",
    },
  },
};

// A URL-aware fetch handler used by the move/retry describe blocks.
// - Barcode lookup requests → return the case data.
// - Locations requests → return an empty array so stations fall back to
//   CASE_STATIONS (keeps the selecting step simple and independent of the
//   locations API shape).
// - Everything else → 200 with null data (safe default).
function makeMoveFlowFetchHandler(
  caseResponse = MOVE_CASE_RESPONSE,
): (url: string) => Response {
  return (url: string) => {
    if (url.includes("/api/locations")) {
      return new Response(JSON.stringify({ ok: true, data: [] }), {
        status: 200,
      });
    }
    if (url.includes("barcode")) {
      return new Response(JSON.stringify(caseResponse), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, data: null }), {
      status: 200,
    });
  };
}

/**
 * Scans a single case, waits for it to appear in the list, presses Continue →
 * selects the "In Design" station → presses Next, landing on the confirming step.
 *
 * Prerequisites: fake timers active, `pickBestBarcode` mocked, fetch handler
 * configured, and `meMemberships` set so `primaryLabOrgId` returns a valid ID.
 */
async function scanOneAndReachConfirm(
  utils: ReturnType<typeof render>,
  barcode: string,
  patientName: string,
) {
  simulateScannerLayout(utils);
  triggerMockBarcodeScan(barcode, null);
  act(() => { vi.runAllTimers(); });

  // Switch to real timers so waitFor polling works.
  vi.useRealTimers();
  await waitFor(() => expect(utils.getByText(patientName)).toBeTruthy());

  // Advance to the station-selection step.
  fireEvent.press(utils.getByTestId("batch-locate-continue"));

  // Locations fetch returns [] → apiLocations is empty → stations fall back
  // to CASE_STATIONS.  Wait for any station button to appear.
  await waitFor(() =>
    expect(utils.getByTestId("batch-locate-station-in_design")).toBeTruthy(),
  );
  fireEvent.press(utils.getByTestId("batch-locate-station-in_design"));

  // Advance to confirming step.
  fireEvent.press(utils.getByTestId("batch-locate-next"));
  await waitFor(() =>
    expect(utils.getByTestId("batch-locate-confirm")).toBeTruthy(),
  );
}

describe("BatchLocateScreen — move → result transition", () => {
  beforeEach(() => {
    vi.mocked(Haptics.impactAsync).mockResolvedValue(undefined as never);
    vi.useFakeTimers();
    // meMemberships must be set so primaryLabOrgId() returns a non-empty value;
    // without it handleBarcodeScanned bails out before issuing the lookup.
    setMockAppState({ meMemberships: [LAB_MEMBERSHIP] });
    mockPickBestBarcode.mockReturnValue({ data: "PAN-MOVE-001" });
    setMockFetchHandler(makeMoveFlowFetchHandler());
  });

  it("shows 'All Done!' with the correct case count when every case succeeds", async () => {
    // mockUpdateCaseMutateAsync resolves successfully by default.
    const utils = renderScanner();
    await scanOneAndReachConfirm(utils, "PAN-MOVE-001", "Alice Adams");

    fireEvent.press(utils.getByTestId("batch-locate-confirm"));

    await waitFor(() => {
      expect(utils.getByText("All Done!")).toBeTruthy();
    });
    expect(utils.getByText(/1 case moved to In Design/)).toBeTruthy();
  });

  it("shows 'Partial Success' with accurate counts when a case update fails", async () => {
    mockUpdateCaseMutateAsync.mockRejectedValueOnce(new Error("Server error"));

    const utils = renderScanner();
    await scanOneAndReachConfirm(utils, "PAN-MOVE-001", "Alice Adams");

    fireEvent.press(utils.getByTestId("batch-locate-confirm"));

    await waitFor(() => {
      expect(utils.getByText("Partial Success")).toBeTruthy();
    });
    // 0 updated, 1 failed
    expect(utils.getByText("0 updated, 1 failed")).toBeTruthy();
    // Failed case detail is listed
    expect(utils.getByText("Alice Adams")).toBeTruthy();
    // Retry button is present
    expect(utils.getByTestId("batch-locate-retry")).toBeTruthy();
  });

  it("calls queryClient.invalidateQueries({ queryKey: ['cases'] }) before rendering the result screen", async () => {
    const mockInvalidate = vi.fn(async () => undefined);
    vi.mocked(useQueryClient).mockReturnValue({
      invalidateQueries: mockInvalidate,
      setQueryData: vi.fn(),
      getQueryData: vi.fn(() => undefined),
    } as unknown as ReturnType<typeof useQueryClient>);

    const utils = renderScanner();
    await scanOneAndReachConfirm(utils, "PAN-MOVE-001", "Alice Adams");

    fireEvent.press(utils.getByTestId("batch-locate-confirm"));

    // The result screen only renders after the await on invalidateQueries resolves.
    await waitFor(() => {
      expect(utils.getByText("All Done!")).toBeTruthy();
    });
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ["cases"] });
  });

  it("shows the Done button on the result screen and calls router.back() when pressed", async () => {
    const { router } = await import("expo-router");
    const utils = renderScanner();
    await scanOneAndReachConfirm(utils, "PAN-MOVE-001", "Alice Adams");

    fireEvent.press(utils.getByTestId("batch-locate-confirm"));

    await waitFor(() =>
      expect(utils.getByTestId("batch-locate-done")).toBeTruthy(),
    );
    fireEvent.press(utils.getByTestId("batch-locate-done"));
    expect(router.back).toHaveBeenCalled();
  });

  it("'Start a new batch' resets back to the scanning step", async () => {
    const utils = renderScanner();
    await scanOneAndReachConfirm(utils, "PAN-MOVE-001", "Alice Adams");

    fireEvent.press(utils.getByTestId("batch-locate-confirm"));

    await waitFor(() =>
      expect(utils.getByTestId("batch-locate-scan-more")).toBeTruthy(),
    );
    fireEvent.press(utils.getByTestId("batch-locate-scan-more"));

    // Back on the scanning step: header title and disabled continue button.
    await waitFor(() =>
      expect(utils.getByText("Batch Locate")).toBeTruthy(),
    );
    const continueBtn = utils.getByTestId("batch-locate-continue");
    expect(
      continueBtn.props.accessibilityState?.disabled ?? continueBtn.props.disabled,
    ).toBe(true);
  });
});

// ── Retry path ────────────────────────────────────────────────────────────────
//
// Covers handleRetry: pressing "Retry N failed cases" on the result screen
// runs another batch move for the previously-failed cases, and the result
// screen updates to reflect the cumulative outcome.

const RETRY_CASE_RESPONSE = {
  ok: true,
  data: {
    case: {
      id: "case-retry-001",
      patientFirstName: "Diana",
      patientLastName: "Drake",
      caseNumber: "9010",
      status: "received",
    },
  },
};

describe("BatchLocateScreen — retry path", () => {
  beforeEach(() => {
    vi.mocked(Haptics.impactAsync).mockResolvedValue(undefined as never);
    vi.useFakeTimers();
    // meMemberships must be set so primaryLabOrgId() returns a non-empty value.
    setMockAppState({ meMemberships: [LAB_MEMBERSHIP] });
    mockPickBestBarcode.mockReturnValue({ data: "PAN-RETRY-001" });
    setMockFetchHandler(makeMoveFlowFetchHandler(RETRY_CASE_RESPONSE));
    // First attempt fails so we land on a "Partial Success" result screen.
    mockUpdateCaseMutateAsync.mockRejectedValueOnce(new Error("Timeout"));
  });

  it("retrying a failed case that now succeeds updates the result to 'All Done!'", async () => {
    const utils = renderScanner();
    await scanOneAndReachConfirm(utils, "PAN-RETRY-001", "Diana Drake");

    // First attempt — the case fails.
    fireEvent.press(utils.getByTestId("batch-locate-confirm"));
    await waitFor(() =>
      expect(utils.getByText("Partial Success")).toBeTruthy(),
    );

    // The retry attempt will succeed (mockUpdateCaseMutateAsync resolves by default now).
    fireEvent.press(utils.getByTestId("batch-locate-retry"));

    // After retry the merged result should be all-succeeded.
    await waitFor(() => {
      expect(utils.getByText("All Done!")).toBeTruthy();
    });
    // succeededIds = [original successes (none)] + [retry success] = 1
    expect(utils.getByText(/1 case moved to In Design/)).toBeTruthy();
  });

  it("retrying a failed case that fails again keeps 'Partial Success' with updated counts", async () => {
    // beforeEach already queued one mockRejectedValueOnce (for the confirm).
    // Queue a second one for the retry so this test doesn't set a permanent
    // rejection that would leak into subsequent tests via the fallback impl.
    mockUpdateCaseMutateAsync.mockRejectedValueOnce(new Error("Persistent error"));

    const utils = renderScanner();
    await scanOneAndReachConfirm(utils, "PAN-RETRY-001", "Diana Drake");

    // First attempt — fails.
    fireEvent.press(utils.getByTestId("batch-locate-confirm"));
    await waitFor(() =>
      expect(utils.getByText("Partial Success")).toBeTruthy(),
    );

    // Retry — still fails.
    fireEvent.press(utils.getByTestId("batch-locate-retry"));

    await waitFor(() => {
      // Still partial: 0 succeeded across both attempts, 1 still failed.
      expect(utils.getByText("Partial Success")).toBeTruthy();
    });
    expect(utils.getByText("0 updated, 1 failed")).toBeTruthy();
    // Retry button is still shown so the user can try again.
    expect(utils.getByTestId("batch-locate-retry")).toBeTruthy();
  });

  it("invalidateQueries is called again on each retry attempt", async () => {
    const mockInvalidate = vi.fn(async () => undefined);
    vi.mocked(useQueryClient).mockReturnValue({
      invalidateQueries: mockInvalidate,
      setQueryData: vi.fn(),
      getQueryData: vi.fn(() => undefined),
    } as unknown as ReturnType<typeof useQueryClient>);

    const utils = renderScanner();
    await scanOneAndReachConfirm(utils, "PAN-RETRY-001", "Diana Drake");

    // First attempt.
    fireEvent.press(utils.getByTestId("batch-locate-confirm"));
    await waitFor(() =>
      expect(utils.getByText("Partial Success")).toBeTruthy(),
    );
    expect(mockInvalidate).toHaveBeenCalledTimes(1);

    // Retry.
    fireEvent.press(utils.getByTestId("batch-locate-retry"));
    await waitFor(() =>
      expect(utils.getByText("All Done!")).toBeTruthy(),
    );
    expect(mockInvalidate).toHaveBeenCalledTimes(2);
    expect(mockInvalidate).toHaveBeenNthCalledWith(2, { queryKey: ["cases"] });
  });
});
