import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it as vitestIt,
  vi,
} from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  resetMockAppState,
  setMockAppState,
  setMockFetchHandler,
  resetMockFetchHandler,
  triggerMockBarcodeScan,
  mockUpdateCaseMutateAsync,
  flushPendingReactUpdates,
} from "../../../vitest.setup";
import { resilientFetch } from "@/lib/query-client";
import * as Haptics from "expo-haptics";
import { LAB_LOCATIONS, locationsResponse } from "./__fixtures__/locations";

import BatchLocateScreen from "@/app/batch-locate/index";

// ── barcode-guide-box mock ────────────────────────────────────────────────────
// We stub filterBarcodesInBox to verify the screen preserves decoded values
// even if geometry filtering cannot resolve a candidate.
//
// vi.hoisted is required: vi.mock factories are hoisted to the top of the file
// by Vitest, so any variable they reference must also be hoisted.
const mockFilterBarcodesInBox = vi.hoisted(() => vi.fn());

vi.mock("@/lib/barcode-guide-box", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/barcode-guide-box")>();
  return { ...actual, filterBarcodesInBox: mockFilterBarcodesInBox };
});

// ── helpers ───────────────────────────────────────────────────────────────────

const LAB_MEMBERSHIP = {
  organizationId: "lab-org-batch-smoke",
  status: "active",
  role: "admin",
  organization: { type: "lab" },
};
const SCAN_WINDOW_TEST_MS = 120;

const it = (
  name: string,
  testFn: () => void | Promise<void>,
  timeout?: number,
): void => {
  vitestIt(
    name,
    async () => {
      await testFn();
      await flushPendingReactUpdates();
    },
    timeout,
  );
};

async function renderScanner() {
  const utils = await render(<BatchLocateScreen />);
  await waitFor(() => expect(utils.getByText("Batch Locate")).toBeTruthy());
  // Permission is granted by the global camera mock, but the first committed
  // tree can still briefly be the permission branch while the native hook
  // settles. Drive that real branch if it appears instead of racing the
  // scanner testID.
  if (utils.queryByTestId("batch-locate-scanner-area") === null) {
    const grant = utils.queryByText("Grant access");
    if (grant) await fireEvent.press(grant);
  }
  await waitFor(() => expect(utils.getByTestId("batch-locate-scanner-area")).toBeTruthy());
  return utils;
}

async function simulateScannerLayout(utils: Awaited<ReturnType<typeof render>>) {
  const area = utils.getByTestId("batch-locate-scanner-area");
  await fireEvent(area, "layout", {
    nativeEvent: { layout: { width: 400, height: 600 } },
  });
}

function barcodeFromLookupUrl(url: string): string {
  const encoded = url.match(/\/barcode\/([^?]+)/)?.[1] ?? "";
  return decodeURIComponent(encoded);
}

function successfulLookupResponse(barcode: string, index = 1): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      data: {
        case: {
          id: `case-${barcode}`,
          patientFirstName: "Patient",
          patientLastName: String(index),
          caseNumber: String(8000 + index),
          status: "received",
          labOrganizationId: LAB_MEMBERSHIP.organizationId,
        },
      },
    }),
    { status: 200 },
  );
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  // The haptics mock (vi.mock in vitest.setup) returns undefined by default;
  // the production code calls .catch() on the return value, so we need a
  // real Promise here to avoid a "Cannot read properties of undefined" crash.
  vi.mocked(Haptics.impactAsync).mockResolvedValue(undefined as never);
  mockFilterBarcodesInBox.mockImplementation((codes) => codes);
});

afterEach(() => {
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("BatchLocateScreen — scanner step", () => {
  it("renders the scanning step without throwing", async () => {
    await expect(renderScanner()).resolves.toBeDefined();
  });

  it("shows the Batch Locate header and initial prompt", async () => {
    const { getByText } = await renderScanner();
    expect(getByText("Batch Locate")).toBeTruthy();
    expect(getByText("Scan case pans to build your batch")).toBeTruthy();
  });

  it("Continue button is disabled when no cases have been scanned", async () => {
    const { getByTestId } = await renderScanner();
    const btn = getByTestId("batch-locate-continue");
    expect(btn.props.accessibilityState?.disabled ?? btn.props.disabled).toBe(true);
  });

  describe("guide-box filter wiring", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      setMockAppState({ meMemberships: [LAB_MEMBERSHIP] });
    });

    it("still issues a lookup when geometry filtering returns no candidate", async () => {
      mockFilterBarcodesInBox.mockReturnValue([]);
      setMockFetchHandler(() =>
        new Response(JSON.stringify({ ok: false }), { status: 404 }),
      );

      const utils = await renderScanner();
      await simulateScannerLayout(utils);

      triggerMockBarcodeScan("OUT-OF-BOX-BATCH-001", null);

      await act(() => { vi.runAllTimers(); });

      expect(resilientFetch).toHaveBeenCalledWith(
        expect.stringContaining("OUT-OF-BOX-BATCH-001"),
      );
    });

    it("accepts a decoded scan before the scanner layout is reported", async () => {
      setMockFetchHandler(() =>
        new Response(JSON.stringify({ ok: false }), { status: 404 }),
      );
      await renderScanner();

      triggerMockBarcodeScan("NO-LAYOUT-BATCH-001", null);
      await act(() => { vi.runAllTimers(); });

      expect(resilientFetch).toHaveBeenCalledWith(
        expect.stringContaining("NO-LAYOUT-BATCH-001"),
      );
    });

    it("shows feedback instead of dropping a scan while the lab is unresolved", async () => {
      resetMockAppState();
      const utils = await renderScanner();
      await simulateScannerLayout(utils);

      triggerMockBarcodeScan("NO-LAB-BATCH-001", null);
      await act(() => { vi.advanceTimersByTime(SCAN_WINDOW_TEST_MS); });

      expect(utils.getByText("Waiting for lab account")).toBeTruthy();
      expect(resilientFetch).not.toHaveBeenCalledWith(
        expect.stringContaining("NO-LAB-BATCH-001"),
      );
    });

    it("issues a lookup when the guide-box filter keeps a barcode", async () => {
      setMockFetchHandler(() =>
        new Response(JSON.stringify({ ok: false }), { status: 404 }),
      );

      const utils = await renderScanner();
      await simulateScannerLayout(utils);

      triggerMockBarcodeScan("IN-BOX-BATCH-001", null);
      await act(() => { vi.runAllTimers(); });

      // Switch back to real timers so waitFor polling works normally.
      vi.useRealTimers();

      await waitFor(() => {
        expect(resilientFetch).toHaveBeenCalledWith(
          expect.stringContaining("IN-BOX-BATCH-001"),
        );
      });
    });

    it("appends a found case to the scanned list after a successful in-box scan", async () => {
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

      const utils = await renderScanner();
      await simulateScannerLayout(utils);

      triggerMockBarcodeScan("PAN-ABC-123", null);
      await act(() => { vi.runAllTimers(); });

      vi.useRealTimers();

      await waitFor(() => {
        expect(utils.getByText("Bob Baker")).toBeTruthy();
      });

      // Subtitle updates to show the count.
      expect(utils.getByText("Scanned: 1 Case")).toBeTruthy();
    });

    it("accepts lookup results when mounted under React Strict Mode", async () => {
      setMockFetchHandler(() =>
        successfulLookupResponse("PAN-STRICT-001", 7),
      );
      const utils = await render(
        <React.StrictMode>
          <BatchLocateScreen />
        </React.StrictMode>,
      );
      await simulateScannerLayout(utils);

      triggerMockBarcodeScan("PAN-STRICT-001", null);
      await act(() => { vi.advanceTimersByTime(SCAN_WINDOW_TEST_MS); });
      vi.useRealTimers();

      await waitFor(() => expect(utils.getByText("Patient 7")).toBeTruthy());
      expect(utils.getByText("Scanned: 1 Case")).toBeTruthy();
    });

    it("does NOT append a duplicate barcode to the scanned list", async () => {
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

      const utils = await renderScanner();
      await simulateScannerLayout(utils);

      // First scan — should succeed.
      triggerMockBarcodeScan("PAN-DUP-001", null);
      await act(() => { vi.runAllTimers(); });

      vi.useRealTimers();
      await waitFor(() => expect(utils.getByText("Carol Chen")).toBeTruthy());

      // Second scan of the same barcode — should be rejected as a duplicate.
      vi.useFakeTimers();
      triggerMockBarcodeScan("PAN-DUP-001", null);
      await act(() => { vi.runAllTimers(); });
      vi.useRealTimers();

      // Still only 1 case in the list.
      expect(utils.getByText("Scanned: 1 Case")).toBeTruthy();
    });

    it("removes one scanned case and allows its barcode to be scanned again", async () => {
      setMockFetchHandler((url) => {
        const barcode = barcodeFromLookupUrl(url);
        const index = barcode.endsWith("002") ? 2 : 1;
        return successfulLookupResponse(barcode, index);
      });
      const utils = await renderScanner();
      await simulateScannerLayout(utils);

      triggerMockBarcodeScan(["PAN-REMOVE-001", "PAN-KEEP-002"], null);
      await act(() => { vi.advanceTimersByTime(SCAN_WINDOW_TEST_MS); });
      vi.useRealTimers();
      await waitFor(() => expect(utils.getByText("Scanned: 2 Cases")).toBeTruthy());

      await fireEvent.press(utils.getByTestId("batch-locate-remove-PAN-REMOVE-001"));
      expect(utils.getByText("Scanned: 1 Case")).toBeTruthy();
      expect(utils.queryByTestId("batch-locate-remove-PAN-REMOVE-001")).toBeNull();

      vi.useFakeTimers();
      triggerMockBarcodeScan("PAN-REMOVE-001", null);
      await act(() => { vi.advanceTimersByTime(SCAN_WINDOW_TEST_MS); });
      vi.useRealTimers();

      await waitFor(() => expect(utils.getByText("Scanned: 2 Cases")).toBeTruthy());
      expect(
        vi.mocked(resilientFetch).mock.calls
          .map(([url]) => barcodeFromLookupUrl(String(url)))
          .filter((barcode) => barcode === "PAN-REMOVE-001"),
      ).toHaveLength(2);
    });

    it("uses a fixed scan window that is not postponed by repeated callbacks", async () => {
      setMockFetchHandler(() =>
        new Response(JSON.stringify({ ok: false }), { status: 404 }),
      );
      const utils = await renderScanner();
      await simulateScannerLayout(utils);

      triggerMockBarcodeScan("PAN-WINDOW-001", null);
      await act(() => { vi.advanceTimersByTime(60); });
      triggerMockBarcodeScan("PAN-WINDOW-002", null);

      // The first callback opened the fixed 120 ms window. The second callback
      // must not restart it, so both lookups dispatch at the original deadline.
      await act(() => { vi.advanceTimersByTime(60); });

      const lookupCalls = vi
        .mocked(resilientFetch)
        .mock.calls.map(([url]) => String(url))
        .filter((url) => url.includes("/barcode/"));
      expect(lookupCalls).toHaveLength(2);
    });

    it("captures every distinct barcode from one native callback", async () => {
      setMockFetchHandler(() =>
        new Promise<Response>(() => {}),
      );
      const utils = await renderScanner();
      await simulateScannerLayout(utils);

      triggerMockBarcodeScan(
        ["PAN-MULTI-001", "PAN-MULTI-002", "PAN-MULTI-003"],
        null,
      );
      await act(() => { vi.advanceTimersByTime(SCAN_WINDOW_TEST_MS); });

      const lookedUp = vi
        .mocked(resilientFetch)
        .mock.calls.map(([url]) => barcodeFromLookupUrl(String(url)));
      expect(lookedUp).toEqual([
        "PAN-MULTI-001",
        "PAN-MULTI-002",
        "PAN-MULTI-003",
      ]);
    });

    it("dispatches later lookups while earlier requests are still pending", async () => {
      setMockFetchHandler(() =>
        new Promise<Response>(() => {}),
      );
      const utils = await renderScanner();
      await simulateScannerLayout(utils);

      triggerMockBarcodeScan("PAN-CONCURRENT-001", null);
      await act(() => { vi.advanceTimersByTime(SCAN_WINDOW_TEST_MS); });
      triggerMockBarcodeScan("PAN-CONCURRENT-002", null);
      await act(() => { vi.advanceTimersByTime(SCAN_WINDOW_TEST_MS); });

      expect(resilientFetch).toHaveBeenCalledTimes(2);
    });

    it("suppresses duplicates while queued, in flight, and completed", async () => {
      let resolveLookup: ((response: Response) => void) | undefined;
      setMockFetchHandler(
        () =>
          new Promise<Response>((resolve) => {
            resolveLookup = resolve;
          }),
      );
      const utils = await renderScanner();
      await simulateScannerLayout(utils);

      // Same-window duplicate: only one request is reserved and dispatched.
      triggerMockBarcodeScan(["PAN-STATE-001", " PAN-STATE-001 "], null);
      await act(() => { vi.advanceTimersByTime(SCAN_WINDOW_TEST_MS); });
      expect(resilientFetch).toHaveBeenCalledTimes(1);

      // In-flight duplicate: still only one request.
      triggerMockBarcodeScan("PAN-STATE-001", null);
      await act(() => { vi.advanceTimersByTime(SCAN_WINDOW_TEST_MS); });
      expect(resilientFetch).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveLookup?.(successfulLookupResponse("PAN-STATE-001"));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(utils.getByText("Patient 1")).toBeTruthy();

      // Completed duplicate: the successful state remains reserved.
      triggerMockBarcodeScan("PAN-STATE-001", null);
      await act(() => { vi.advanceTimersByTime(SCAN_WINDOW_TEST_MS); });
      expect(resilientFetch).toHaveBeenCalledTimes(1);
    });

    it("keeps scanning after one lookup fails", async () => {
      setMockFetchHandler((url) => {
        const barcode = barcodeFromLookupUrl(url);
        if (barcode === "PAN-MISSING-001") {
          return new Response(JSON.stringify({ ok: false }), { status: 404 });
        }
        return successfulLookupResponse(barcode, 2);
      });
      const utils = await renderScanner();
      await simulateScannerLayout(utils);

      triggerMockBarcodeScan(["PAN-MISSING-001", "PAN-FOUND-002"], null);
      await act(() => { vi.advanceTimersByTime(SCAN_WINDOW_TEST_MS); });
      vi.useRealTimers();

      await waitFor(() => expect(utils.getByText("Patient 2")).toBeTruthy());
      expect(resilientFetch).toHaveBeenCalledTimes(2);
      expect(utils.getByText("Scanned: 1 Case")).toBeTruthy();
    });

    it("suppresses a repeated barcode after its lookup failed", async () => {
      setMockFetchHandler(() =>
        new Response(JSON.stringify({ ok: false }), { status: 404 }),
      );
      const utils = await renderScanner();
      await simulateScannerLayout(utils);

      triggerMockBarcodeScan("PAN-FAILED-DUP-001", null);
      await act(() => { vi.advanceTimersByTime(SCAN_WINDOW_TEST_MS); });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      triggerMockBarcodeScan("PAN-FAILED-DUP-001", null);
      await act(() => { vi.advanceTimersByTime(SCAN_WINDOW_TEST_MS); });
      expect(resilientFetch).toHaveBeenCalledTimes(1);
    });

    it("queues ten unique barcodes within the three-second throughput target", async () => {
      setMockFetchHandler((url) => {
        const barcode = barcodeFromLookupUrl(url);
        const index = Number(barcode.slice(-2));
        return new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(successfulLookupResponse(barcode, index)),
            200,
          );
        });
      });
      const utils = await renderScanner();
      await simulateScannerLayout(utils);
      const startedAt = Date.now();

      const barcodes = Array.from(
        { length: 10 },
        (_, index) => `PAN-THROUGHPUT-${String(index + 1).padStart(2, "0")}`,
      );
      for (const [index, barcode] of barcodes.entries()) {
        triggerMockBarcodeScan(barcode, null);
        if (index < barcodes.length - 1) {
          await act(() => { vi.advanceTimersByTime(10); });
        }
      }

      await act(() => { vi.advanceTimersByTime(30); });
      expect(resilientFetch).toHaveBeenCalledTimes(10);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      expect(Date.now() - startedAt).toBeLessThan(3000);
      expect(utils.getByText("Scanned: 10 Cases")).toBeTruthy();
      expect(Haptics.impactAsync).toHaveBeenCalledTimes(10);
    });

    it("ignores a pending lookup after the scanner unmounts", async () => {
      let resolveLookup: ((response: Response) => void) | undefined;
      setMockFetchHandler(
        () =>
          new Promise<Response>((resolve) => {
            resolveLookup = resolve;
          }),
      );
      const utils = await renderScanner();
      await simulateScannerLayout(utils);

      triggerMockBarcodeScan("PAN-UNMOUNT-001", null);
      await act(() => { vi.advanceTimersByTime(SCAN_WINDOW_TEST_MS); });
      await utils.unmount();

      await act(async () => {
        resolveLookup?.(successfulLookupResponse("PAN-UNMOUNT-001"));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(Haptics.impactAsync).not.toHaveBeenCalled();
    });
  });
});

// ── Move → result transition ───────────────────────────────────────────────
//
// These tests drive the full scanner → selecting → confirming → result flow,
// verifying that the result screen appears with accurate counts only after
// cache invalidation completes, and that partial-failure details render
// correctly.

// The scanned case's lab is deliberately NOT the membership-derived lab
// (LAB_MEMBERSHIP.organizationId) — batch locate must scope its location list
// to the lab the scanned cases actually belong to.
const SCANNED_CASE_LAB_ORG = "lab-org-scanned";

const MOVE_CASE_RESPONSE = {
  ok: true,
  data: {
    case: {
      id: "case-move-001",
      patientFirstName: "Alice",
      patientLastName: "Adams",
      caseNumber: "9001",
      status: "received",
      labOrganizationId: SCANNED_CASE_LAB_ORG,
    },
  },
};

// A URL-aware fetch handler used by the move/retry describe blocks.
// - Barcode lookup requests → return the case data.
// - Locations requests → return the lab's real list. There is no built-in
//   fallback list any more, so an empty response would leave the selecting
//   step with nothing to pick.
// - Everything else → 200 with null data (safe default).
function makeMoveFlowFetchHandler(
  caseResponse = MOVE_CASE_RESPONSE,
  locations = LAB_LOCATIONS,
): (url: string) => Response {
  return (url: string) => {
    if (url.includes("/api/locations")) {
      return locationsResponse(url, locations);
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
  utils: Awaited<ReturnType<typeof render>>,
  barcode: string,
  patientName: string,
) {
  await simulateScannerLayout(utils);
  triggerMockBarcodeScan(barcode, null);
  await act(() => { vi.runAllTimers(); });

  // Switch to real timers so waitFor polling works.
  vi.useRealTimers();
  await waitFor(() => expect(utils.getByText(patientName)).toBeTruthy());

  // Advance to the station-selection step.
  await fireEvent.press(utils.getByTestId("batch-locate-continue"));

  // Wait for the lab's locations to load, then pick "In Design". Station rows
  // are keyed by location id (not status) so two same-status custom locations
  // stay independently selectable.
  await waitFor(() =>
    expect(utils.getByTestId("batch-locate-station-loc-in-design")).toBeTruthy(),
  );
  await fireEvent.press(utils.getByTestId("batch-locate-station-loc-in-design"));

  // Advance to confirming step.
  await fireEvent.press(utils.getByTestId("batch-locate-next"));
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
    setMockFetchHandler(makeMoveFlowFetchHandler());
  });

  it("shows 'All Done!' with the correct case count when every case succeeds", async () => {
    // mockUpdateCaseMutateAsync resolves successfully by default.
    const utils = await renderScanner();
    await scanOneAndReachConfirm(utils, "PAN-MOVE-001", "Alice Adams");

    await fireEvent.press(utils.getByTestId("batch-locate-confirm"));

    await waitFor(() => {
      expect(utils.getByText("All Done!")).toBeTruthy();
    });
    expect(utils.getByText(/1 case moved to In Design/)).toBeTruthy();
  });

  it("moves every case captured from a multi-code camera callback", async () => {
    setMockFetchHandler((url) => {
      if (url.includes("/api/locations")) {
        return locationsResponse(url, LAB_LOCATIONS);
      }
      if (url.includes("/barcode/")) {
        const barcode = barcodeFromLookupUrl(url);
        const index = barcode.endsWith("002") ? 2 : 1;
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              case: {
                id: `case-multi-move-${index}`,
                patientFirstName: "Move",
                patientLastName: String(index),
                caseNumber: `90${index}`,
                status: "received",
                labOrganizationId: SCANNED_CASE_LAB_ORG,
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, data: null }), {
        status: 200,
      });
    });

    const utils = await renderScanner();
    await simulateScannerLayout(utils);
    triggerMockBarcodeScan(["PAN-MOVE-001", "PAN-MOVE-002"], null);
    await act(() => { vi.advanceTimersByTime(SCAN_WINDOW_TEST_MS); });
    vi.useRealTimers();

    await waitFor(() => expect(utils.getByText("Scanned: 2 Cases")).toBeTruthy());
    await fireEvent.press(utils.getByTestId("batch-locate-continue"));
    await waitFor(() =>
      expect(utils.getByTestId("batch-locate-station-loc-in-design")).toBeTruthy(),
    );
    await fireEvent.press(utils.getByTestId("batch-locate-station-loc-in-design"));
    await fireEvent.press(utils.getByTestId("batch-locate-next"));
    await fireEvent.press(utils.getByTestId("batch-locate-confirm"));

    await waitFor(() => expect(utils.getByText("All Done!")).toBeTruthy());
    expect(mockUpdateCaseMutateAsync).toHaveBeenCalledTimes(2);
    expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
      caseId: "case-multi-move-1",
      data: { status: "in_design", labLocationId: "loc-in-design" },
    });
    expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
      caseId: "case-multi-move-2",
      data: { status: "in_design", labLocationId: "loc-in-design" },
    });
  });

  it("removes a case during confirmation and moves only the remaining case", async () => {
    setMockFetchHandler((url) => {
      if (url.includes("/api/locations")) {
        return locationsResponse(url, LAB_LOCATIONS);
      }
      const barcode = barcodeFromLookupUrl(url);
      const index = barcode.endsWith("002") ? 2 : 1;
      return new Response(JSON.stringify({
        ok: true,
        data: {
          case: {
            id: `case-confirm-${index}`,
            patientFirstName: "Confirm",
            patientLastName: String(index),
            caseNumber: `92${index}`,
            status: "received",
            labOrganizationId: SCANNED_CASE_LAB_ORG,
          },
        },
      }), { status: 200 });
    });
    const utils = await renderScanner();
    await simulateScannerLayout(utils);
    triggerMockBarcodeScan(["PAN-CONFIRM-001", "PAN-CONFIRM-002"], null);
    await act(() => { vi.advanceTimersByTime(SCAN_WINDOW_TEST_MS); });
    vi.useRealTimers();
    await waitFor(() => expect(utils.getByText("Scanned: 2 Cases")).toBeTruthy());
    await fireEvent.press(utils.getByTestId("batch-locate-continue"));
    await waitFor(() =>
      expect(utils.getByTestId("batch-locate-station-loc-in-design")).toBeTruthy(),
    );
    await fireEvent.press(utils.getByTestId("batch-locate-station-loc-in-design"));
    await fireEvent.press(utils.getByTestId("batch-locate-next"));

    await fireEvent.press(
      utils.getByTestId("batch-locate-confirm-remove-PAN-CONFIRM-001"),
    );
    expect(utils.getByText(/Move 1 case to In Design\?/)).toBeTruthy();
    expect(utils.queryByText("Confirm 1")).toBeNull();
    expect(utils.getByText("Confirm 2")).toBeTruthy();
    await fireEvent.press(utils.getByTestId("batch-locate-confirm"));

    await waitFor(() => expect(utils.getByText("All Done!")).toBeTruthy());
    expect(mockUpdateCaseMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
      caseId: "case-confirm-2",
      data: { status: "in_design", labLocationId: "loc-in-design" },
    });
  });

  it("returns to scanning when the final confirmation case is removed", async () => {
    const utils = await renderScanner();
    await scanOneAndReachConfirm(utils, "PAN-MOVE-001", "Alice Adams");

    await fireEvent.press(
      utils.getByTestId("batch-locate-confirm-remove-PAN-MOVE-001"),
    );

    await waitFor(() =>
      expect(utils.getByText("No cases scanned yet")).toBeTruthy(),
    );
    const continueBtn = utils.getByTestId("batch-locate-continue");
    expect(
      continueBtn.props.accessibilityState?.disabled ?? continueBtn.props.disabled,
    ).toBe(true);
    expect(utils.queryByTestId("batch-locate-confirm")).toBeNull();
    expect(mockUpdateCaseMutateAsync).not.toHaveBeenCalled();
  });

  it("freezes the reviewed batch when Continue is pressed during a pending lookup", async () => {
    const resolvers = new Map<string, (response: Response) => void>();
    setMockFetchHandler((url) => {
      if (url.includes("/api/locations")) {
        return locationsResponse(url, LAB_LOCATIONS);
      }
      if (url.includes("/barcode/")) {
        const barcode = barcodeFromLookupUrl(url);
        return new Promise<Response>((resolve) => {
          resolvers.set(barcode, resolve);
        });
      }
      return new Response(JSON.stringify({ ok: true, data: null }), {
        status: 200,
      });
    });

    const utils = await renderScanner();
    await simulateScannerLayout(utils);
    triggerMockBarcodeScan(["PAN-FREEZE-001", "PAN-FREEZE-002"], null);
    await act(() => { vi.advanceTimersByTime(SCAN_WINDOW_TEST_MS); });

    await act(async () => {
      resolvers.get("PAN-FREEZE-001")?.(
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              case: {
                id: "case-freeze-1",
                patientFirstName: "Freeze",
                patientLastName: "One",
                caseNumber: "9101",
                status: "received",
                labOrganizationId: SCANNED_CASE_LAB_ORG,
              },
            },
          }),
          { status: 200 },
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    vi.useRealTimers();
    await waitFor(() => expect(utils.getByText("Scanned: 1 Case")).toBeTruthy());
    await fireEvent.press(utils.getByTestId("batch-locate-continue"));

    // This response belongs to the camera session that was just frozen. It
    // must not alter the reviewed list or become part of the move.
    await act(async () => {
      resolvers.get("PAN-FREEZE-002")?.(
        successfulLookupResponse("PAN-FREEZE-002", 2),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(utils.getByTestId("batch-locate-station-loc-in-design")).toBeTruthy(),
    );
    await fireEvent.press(utils.getByTestId("batch-locate-station-loc-in-design"));
    await fireEvent.press(utils.getByTestId("batch-locate-next"));
    expect(utils.getByText(/Move 1 case to In Design\?/)).toBeTruthy();
    await fireEvent.press(utils.getByTestId("batch-locate-confirm"));

    await waitFor(() => expect(utils.getByText("All Done!")).toBeTruthy());
    expect(mockUpdateCaseMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
      caseId: "case-freeze-1",
      data: { status: "in_design", labLocationId: "loc-in-design" },
    });
  });

  it("shows 'Partial Success' with accurate counts when a case update fails", async () => {
    mockUpdateCaseMutateAsync.mockRejectedValueOnce(new Error("Server error"));

    const utils = await renderScanner();
    await scanOneAndReachConfirm(utils, "PAN-MOVE-001", "Alice Adams");

    await fireEvent.press(utils.getByTestId("batch-locate-confirm"));

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

    const utils = await renderScanner();
    await scanOneAndReachConfirm(utils, "PAN-MOVE-001", "Alice Adams");

    await fireEvent.press(utils.getByTestId("batch-locate-confirm"));

    // The result screen only renders after the await on invalidateQueries resolves.
    await waitFor(() => {
      expect(utils.getByText("All Done!")).toBeTruthy();
    });
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ["cases"] });
  });

  it("shows the Done button on the result screen and calls router.back() when pressed", async () => {
    const { router } = await import("expo-router");
    const utils = await renderScanner();
    await scanOneAndReachConfirm(utils, "PAN-MOVE-001", "Alice Adams");

    await fireEvent.press(utils.getByTestId("batch-locate-confirm"));

    await waitFor(() =>
      expect(utils.getByTestId("batch-locate-done")).toBeTruthy(),
    );
    await fireEvent.press(utils.getByTestId("batch-locate-done"));
    expect(router.back).toHaveBeenCalled();
  });

  it("'Start a new batch' resets back to the scanning step", async () => {
    const utils = await renderScanner();
    await scanOneAndReachConfirm(utils, "PAN-MOVE-001", "Alice Adams");

    await fireEvent.press(utils.getByTestId("batch-locate-confirm"));

    await waitFor(() =>
      expect(utils.getByTestId("batch-locate-scan-more")).toBeTruthy(),
    );
    await fireEvent.press(utils.getByTestId("batch-locate-scan-more"));

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
      labOrganizationId: SCANNED_CASE_LAB_ORG,
    },
  },
};

describe("BatchLocateScreen — retry path", () => {
  beforeEach(() => {
    vi.mocked(Haptics.impactAsync).mockResolvedValue(undefined as never);
    vi.useFakeTimers();
    // meMemberships must be set so primaryLabOrgId() returns a non-empty value.
    setMockAppState({ meMemberships: [LAB_MEMBERSHIP] });
    setMockFetchHandler(makeMoveFlowFetchHandler(RETRY_CASE_RESPONSE));
    // First attempt fails so we land on a "Partial Success" result screen.
    mockUpdateCaseMutateAsync.mockRejectedValueOnce(new Error("Timeout"));
  });

  it("retrying a failed case that now succeeds updates the result to 'All Done!'", async () => {
    const utils = await renderScanner();
    await scanOneAndReachConfirm(utils, "PAN-RETRY-001", "Diana Drake");

    // First attempt — the case fails.
    await fireEvent.press(utils.getByTestId("batch-locate-confirm"));
    await waitFor(() =>
      expect(utils.getByText("Partial Success")).toBeTruthy(),
    );

    // The retry attempt will succeed (mockUpdateCaseMutateAsync resolves by default now).
    await fireEvent.press(utils.getByTestId("batch-locate-retry"));

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

    const utils = await renderScanner();
    await scanOneAndReachConfirm(utils, "PAN-RETRY-001", "Diana Drake");

    // First attempt — fails.
    await fireEvent.press(utils.getByTestId("batch-locate-confirm"));
    await waitFor(() =>
      expect(utils.getByText("Partial Success")).toBeTruthy(),
    );

    // Retry — still fails.
    await fireEvent.press(utils.getByTestId("batch-locate-retry"));

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

    const utils = await renderScanner();
    await scanOneAndReachConfirm(utils, "PAN-RETRY-001", "Diana Drake");

    // First attempt.
    await fireEvent.press(utils.getByTestId("batch-locate-confirm"));
    await waitFor(() =>
      expect(utils.getByText("Partial Success")).toBeTruthy(),
    );
    expect(mockInvalidate).toHaveBeenCalledTimes(1);

    // Retry.
    await fireEvent.press(utils.getByTestId("batch-locate-retry"));
    await waitFor(() =>
      expect(utils.getByText("All Done!")).toBeTruthy(),
    );
    expect(mockInvalidate).toHaveBeenCalledTimes(2);
    expect(mockInvalidate).toHaveBeenNthCalledWith(2, { queryKey: ["cases"] });
  });
});

// ── Location list parity ──────────────────────────────────────────────────────
//
// Batch locate must offer the same active locations desktop/web shows for the
// lab that owns the SCANNED cases — never a shorter built-in list standing in
// while the fetch is in flight, and never another lab's stations.

describe("BatchLocateScreen — location list parity", () => {
  beforeEach(() => {
    vi.mocked(Haptics.impactAsync).mockResolvedValue(undefined as never);
    vi.useFakeTimers();
    setMockAppState({ meMemberships: [LAB_MEMBERSHIP] });
    setMockFetchHandler(makeMoveFlowFetchHandler());
  });

  /** Scans one case and advances to the station-selection step. */
  async function scanOneAndReachSelecting(utils: Awaited<ReturnType<typeof render>>) {
    await simulateScannerLayout(utils);
    triggerMockBarcodeScan("PAN-MOVE-001", null);
    await act(() => { vi.runAllTimers(); });
    vi.useRealTimers();
    await waitFor(() => expect(utils.getByText("Alice Adams")).toBeTruthy());
    await fireEvent.press(utils.getByTestId("batch-locate-continue"));
  }

  it("scopes the location list to the lab the scanned cases belong to", async () => {
    const utils = await renderScanner();
    await scanOneAndReachSelecting(utils);

    await waitFor(() => {
      const locationCalls = vi
        .mocked(resilientFetch)
        .mock.calls.map(([url]) => String(url))
        .filter((url) => url.includes("/api/locations"));
      expect(locationCalls.length).toBeGreaterThan(0);
      // Scoped to the scanned case's lab, not the membership-derived guess.
      expect(
        locationCalls.some((url) =>
          url.includes(`organizationId=${SCANNED_CASE_LAB_ORG}`),
        ),
      ).toBe(true);
      expect(
        locationCalls.some((url) =>
          url.includes(`organizationId=${LAB_MEMBERSHIP.organizationId}`),
        ),
      ).toBe(false);
    });
  });

  it("lists the lab's custom active locations and never an inactive one", async () => {
    const utils = await renderScanner();
    await scanOneAndReachSelecting(utils);

    // A custom location that is not part of the built-in station list.
    await waitFor(() =>
      expect(utils.getByTestId("batch-locate-station-loc-polish")).toBeTruthy(),
    );
    expect(utils.getByText("Polishing Bench")).toBeTruthy();
    // Inactive locations are excluded by the activeOnly=true request.
    expect(utils.queryByTestId("batch-locate-station-loc-retired")).toBeNull();
  });

  it("keeps two custom locations that share a workflow status independently selectable", async () => {
    const utils = await renderScanner();
    await scanOneAndReachSelecting(utils);

    // Both qc-mapped locations render as their own rows (the old status-keyed
    // list collapsed them into a single entry).
    await waitFor(() =>
      expect(utils.getByTestId("batch-locate-station-loc-glaze")).toBeTruthy(),
    );
    expect(utils.getByTestId("batch-locate-station-loc-polish")).toBeTruthy();

    // Picking one carries that location's own name to the confirm step...
    await fireEvent.press(utils.getByTestId("batch-locate-station-loc-glaze"));
    await fireEvent.press(utils.getByTestId("batch-locate-next"));
    await waitFor(() =>
      expect(utils.getByText(/Move 1 case to Glaze Oven\?/)).toBeTruthy(),
    );

    // ...and the sibling row is an independent selection, not the same one.
    await fireEvent.press(utils.getByTestId("batch-locate-cancel"));
    await waitFor(() =>
      expect(utils.getByTestId("batch-locate-station-loc-polish")).toBeTruthy(),
    );
    await fireEvent.press(utils.getByTestId("batch-locate-station-loc-polish"));
    await fireEvent.press(utils.getByTestId("batch-locate-next"));
    await waitFor(() =>
      expect(utils.getByText(/Move 1 case to Polishing Bench\?/)).toBeTruthy(),
    );

    // The mapped status and unique location id are both written, preserving
    // a live custom location even when a sibling location uses the same status.
    await fireEvent.press(utils.getByTestId("batch-locate-confirm"));
    await waitFor(() => {
      expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
        caseId: "case-move-001",
        data: { status: "qc", labLocationId: "loc-polish" },
      });
    });
  });

  it("shows a loading state instead of a stand-in list while locations load", async () => {
    setMockFetchHandler((url: string) => {
      if (url.includes("/api/locations")) {
        // Never resolves — the selecting step must show it is still loading.
        return new Promise<Response>(() => {});
      }
      if (url.includes("barcode")) {
        return new Response(JSON.stringify(MOVE_CASE_RESPONSE), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, data: null }), { status: 200 });
    });

    const utils = await renderScanner();
    await scanOneAndReachSelecting(utils);

    await waitFor(() =>
      expect(utils.getByTestId("batch-locate-locations-loading")).toBeTruthy(),
    );
    expect(utils.queryByTestId("batch-locate-station-loc-received")).toBeNull();
  });

  it("shows an explicit empty state when the lab has no active locations", async () => {
    setMockFetchHandler(makeMoveFlowFetchHandler(MOVE_CASE_RESPONSE, []));

    const utils = await renderScanner();
    await scanOneAndReachSelecting(utils);

    await waitFor(() =>
      expect(utils.getByTestId("batch-locate-locations-empty")).toBeTruthy(),
    );
    // No built-in list quietly standing in for the lab's real data.
    expect(utils.queryByTestId("batch-locate-station-loc-received")).toBeNull();
    expect(utils.queryByTestId("batch-locate-station-received")).toBeNull();
  });
});
