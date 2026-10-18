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
import {
  resetMockAppState,
  setMockAppState,
  setMockFetchHandler,
  resetMockFetchHandler,
  triggerMockBarcodeScan,
  flushPendingReactUpdates,
} from "../../../vitest.setup";
import { resilientFetch } from "@/lib/query-client";
import * as Haptics from "expo-haptics";

import CasesListScreen from "@/app/(tabs)/index";

// ── barcode-guide-box mock ────────────────────────────────────────────────────
// We stub pickBestBarcode so smoke tests can verify the screen-level decoded
// fallback independently from the real guide-box geometry.
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
  organizationId: "lab-org-scan-smoke",
  status: "active",
  role: "admin",
  organization: { type: "lab" },
};

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

async function openScanModal() {
  const utils = await render(<CasesListScreen />);
  await fireEvent.press(utils.getByTestId("cases-scan-barcode"));
  return utils;
}

async function simulateCameraLayout(utils: Awaited<Awaited<ReturnType<typeof render>>>) {
  const wrap = utils.getByTestId("scan-camera-wrap");
  await fireEvent(wrap, "layout", {
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

describe("CasesListScreen — barcode scan modal", () => {
  it("opens when the scan button is pressed", async () => {
    const { getByText } = await openScanModal();
    expect(getByText("Scan Barcode")).toBeTruthy();
    expect(getByText("Find a case by pan barcode")).toBeTruthy();
  });

  it("renders Camera and Manual mode tabs once open", async () => {
    const { getByText } = await openScanModal();
    expect(getByText("Camera")).toBeTruthy();
    expect(getByText("Manual")).toBeTruthy();
  });

  describe("guide-box filter wiring", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      setMockAppState({ meMemberships: [LAB_MEMBERSHIP] });
    });

    it("still issues a lookup when geometry picking returns null", async () => {
      mockPickBestBarcode.mockReturnValue(null);
      setMockFetchHandler(() =>
        new Response(JSON.stringify({ ok: false }), { status: 404 }),
      );

       const utils = await openScanModal();
       await simulateCameraLayout(utils);

      triggerMockBarcodeScan("OUT-OF-BOX-001", null);

      // Run the 120 ms debounce synchronously; no async lookup should follow.
      await act(() => { vi.advanceTimersByTime(200); });

      expect(resilientFetch).toHaveBeenCalledWith(
        expect.stringContaining("OUT-OF-BOX-001"),
      );
    });

    it("accepts a decoded scan before the camera layout is reported", async () => {
      mockPickBestBarcode.mockReturnValue(null);
      setMockFetchHandler(() =>
        new Response(JSON.stringify({ ok: false }), { status: 404 }),
      );
       await openScanModal();

      triggerMockBarcodeScan("NO-LAYOUT-001", null);
      await act(() => { vi.advanceTimersByTime(200); });

      expect(resilientFetch).toHaveBeenCalledWith(
        expect.stringContaining("NO-LAYOUT-001"),
      );
    });

    it("issues a lookup when pickBestBarcode returns a barcode (in-box barcode)", async () => {
      mockPickBestBarcode.mockReturnValue({ data: "IN-BOX-001" });
      setMockFetchHandler(() =>
        new Response(
          JSON.stringify({ ok: false }),
          { status: 404 },
        ),
      );

       const utils = await openScanModal();
       await simulateCameraLayout(utils);

      triggerMockBarcodeScan("IN-BOX-001", null);

      // Fire the debounce timer; the lookup is async so we advance real time too.
      await act(() => { vi.advanceTimersByTime(200); });

      // Switch back to real timers so waitFor polling works normally.
      vi.useRealTimers();

      await waitFor(() => {
        expect(resilientFetch).toHaveBeenCalledWith(
          expect.stringContaining("IN-BOX-001"),
        );
      });
    });

    it("navigates to the case after a successful in-box scan", async () => {
      const { router } = await import("expo-router");
      mockPickBestBarcode.mockReturnValue({ data: "FOUND-001" });
      setMockFetchHandler(() =>
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              case: {
                id: "case-found-001",
                patientFirstName: "Alice",
                patientLastName: "Smith",
                caseNumber: "9001",
                status: "received",
              },
            },
          }),
          { status: 200 },
        ),
      );

       const utils = await openScanModal();
       await simulateCameraLayout(utils);

       await act(async () => {
         triggerMockBarcodeScan("FOUND-001", null);
         vi.advanceTimersByTime(200);
         await Promise.resolve();
         await Promise.resolve();
       });
       // The lookup resolves in a microtask and schedules navigation only
       // after that result is committed. Advance the post-match delay in a
       // separate act so the timer is not raced by switching timer modes.
       await act(async () => {
         vi.advanceTimersByTime(900);
         await Promise.resolve();
       });

      // Switch to real timers only after the navigation timer has fired.
      vi.useRealTimers();

      await waitFor(
        () => {
          expect(router.push).toHaveBeenCalledWith("/case/case-found-001");
        },
        { timeout: 3000 },
      );
    });
  });
});
