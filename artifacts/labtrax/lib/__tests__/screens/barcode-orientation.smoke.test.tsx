/**
 * Barcode scanning across a device rotation — screen level.
 *
 * `lib/__tests__/barcode-orientation.test.ts` documents the native contract
 * (read out of the installed vision-camera 4.7.3 source) and covers the pure
 * geometry. This file drives the same scenarios through the three real
 * scanning surfaces, so a regression in how a screen feeds the helpers —
 * reticle fractions, layout measurement, the scan-accumulation window — is
 * caught too:
 *
 *   1. Dashboard Scan          — app/(tabs)/index.tsx      → barcode lookup
 *   2. Batch Locate            — app/batch-locate/index.tsx → batch lookups
 *   3. AI-reader assignment    — app/ai-reader/barcode.tsx  → PATCH the case
 *
 * Unlike the other scan smoke tests, `@/lib/barcode-guide-box` is deliberately
 * NOT mocked here — the whole point is exercising the real mapping.
 *
 * ── What "rotation" means here ──────────────────────────────────────────────
 *
 * LabTrax is orientation-locked to portrait, and vision-camera pins the code
 * scanner's coordinate space to the *preview* orientation (iOS:
 * `codeScannerOutput.orientation = previewOrientation`; Android:
 * `codeScannerOutput?.targetRotation = previewRotation`). Preview orientation
 * derives from the interface orientation, which the portrait lock freezes.
 *
 * So rotating the phone does NOT hand JavaScript a differently-shaped frame:
 * the reported CodeScannerFrame stays the landscape sensor size and the
 * coordinates stay preview-relative. The property worth testing is that the
 * outcome is *unchanged* by the rotation, and that nothing is dropped while
 * layout re-settles. Fixtures are written in preview-relative fractions and
 * chosen to sit inside/outside each reticle under both the current mapping and
 * the non-rotating one the contract implies.
 *
 * Behaviour that genuinely cannot be reproduced in JS — when each platform
 * actually re-emits, whether the preview stalls, Android's ML Kit
 * rotated-bounds/unrotated-dimensions discrepancy — is covered by the on-device
 * matrix in docs/mobile-barcode-orientation-matrix.md.
 */

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
  type MockBarcodeScanInput,
} from "../../../vitest.setup";
import { resilientFetch } from "@/lib/query-client";
import { setAiReaderSession, clearAiReaderSession } from "@/lib/ai-reader-store";
import * as Haptics from "expo-haptics";

import CasesListScreen from "@/app/(tabs)/index";
import BatchLocateScreen from "@/app/batch-locate/index";
import AiReaderBarcodeScreen from "@/app/ai-reader/barcode";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const LAB_MEMBERSHIP = {
  organizationId: "lab-org-orientation",
  status: "active",
  role: "admin",
  organization: { type: "lab" },
};

/** The preview never rotates — the app is orientation-locked to portrait. */
const PORTRAIT_LAYOUT = { width: 400, height: 600 };

/**
 * What the native layer reports as CodeScannerFrame: the landscape sensor
 * dimensions. Per the contract this is identical in both device orientations.
 */
const SENSOR_FRAME = { width: 1920, height: 1080 };

const SCAN_WINDOW_MS = 120;

/** Preview-relative positions that behave the same under either mapping. */
const CENTERED = { x: 0.5, y: 0.5 };
const OFF_CENTER = { x: 0.5, y: 0.62 };
const OUTSIDE = { x: 0.95, y: 0.5 };

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

/**
 * Build a scan-mock input the way the iOS scanner does: preview-relative
 * normalized bounds multiplied by the reported (sensor) frame dimensions.
 */
function codeAt(
  data: string,
  pos: { x: number; y: number },
  sizeFrac = 0.06,
): MockBarcodeScanInput {
  const w = SENSOR_FRAME.width * sizeFrac;
  const h = SENSOR_FRAME.height * sizeFrac;
  return {
    data,
    scannerFrame: SENSOR_FRAME,
    frame: {
      x: pos.x * SENSOR_FRAME.width - w / 2,
      y: pos.y * SENSOR_FRAME.height - h / 2,
      width: w,
      height: h,
    },
  };
}

function lookedUpBarcodes(): string[] {
  return vi
    .mocked(resilientFetch)
    .mock.calls.map(([url]) => String(url))
    .filter((url) => url.includes("/barcode/"))
    .map((url) => decodeURIComponent(url.match(/\/barcode\/([^?]+)/)?.[1] ?? ""));
}

function notFoundHandler() {
  return new Response(JSON.stringify({ ok: false }), { status: 404 });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  // The global haptics mock returns undefined; production code calls .catch().
  vi.mocked(Haptics.impactAsync).mockResolvedValue(undefined as never);
  setMockAppState({ meMemberships: [LAB_MEMBERSHIP] });
  vi.useFakeTimers();
});

afterEach(() => {
  clearAiReaderSession();
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ── 1. Dashboard Scan ─────────────────────────────────────────────────────────

describe("Dashboard Scan — rotation", () => {
  async function openScanner() {
    const utils = await render(<CasesListScreen />);
    await waitFor(() => expect(utils.getByTestId("cases-scan-barcode")).toBeTruthy());
    await fireEvent.press(utils.getByTestId("cases-scan-barcode"));
    await waitFor(() => expect(utils.getByTestId("scan-camera-wrap")).toBeTruthy());
    await fireEvent(utils.getByTestId("scan-camera-wrap"), "layout", {
      nativeEvent: { layout: PORTRAIT_LAYOUT },
    });
    return utils;
  }

  async function scan(codes: MockBarcodeScanInput[]) {
    await act(async () => {
      triggerMockBarcodeScan(codes, null);
      vi.advanceTimersByTime(SCAN_WINDOW_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("accepts a centered barcode", async () => {
    setMockFetchHandler(notFoundHandler);
    await openScanner();
    await scan([codeAt("CENTERED", CENTERED)]);
    expect(lookedUpBarcodes()).toEqual(["CENTERED"]);
  });

  it("accepts a centered barcode after the phone is rotated", async () => {
    // The portrait lock keeps the callback payload identical across the
    // rotation, so the outcome must be identical too.
    setMockFetchHandler(notFoundHandler);
    await openScanner();
    await scan([codeAt("AFTER-ROTATION", CENTERED)]);
    expect(lookedUpBarcodes()).toEqual(["AFTER-ROTATION"]);
  });

  it("prefers the centered barcode over an off-center one", async () => {
    setMockFetchHandler(notFoundHandler);
    await openScanner();
    await scan([codeAt("OFF-CENTER", OFF_CENTER), codeAt("CENTERED", CENTERED)]);
    expect(lookedUpBarcodes()).toEqual(["CENTERED"]);
  });

  it("ignores a barcode outside the reticle", async () => {
    setMockFetchHandler(notFoundHandler);
    await openScanner();
    await scan([codeAt("OUTSIDE", OUTSIDE, 0.01), codeAt("CENTERED", CENTERED)]);
    expect(lookedUpBarcodes()).toEqual(["CENTERED"]);
  });

  it("prefers the centered barcode across two callbacks in one scan window", async () => {
    // A rotation can straddle the accumulation window: two native callbacks,
    // each with its own code set, before the window flushes.
    setMockFetchHandler(notFoundHandler);
    await openScanner();
    triggerMockBarcodeScan([codeAt("FIRST-OFF-CENTER", OFF_CENTER)], null);
    await act(() => {
      vi.advanceTimersByTime(60);
    });
    await scan([codeAt("SECOND-CENTERED", CENTERED)]);
    expect(lookedUpBarcodes()).toEqual(["SECOND-CENTERED"]);
  });

  it("does not discard a decoded scan when everything falls outside the reticle", async () => {
    setMockFetchHandler(notFoundHandler);
    await openScanner();
    await scan([codeAt("ONLY-OUTSIDE", OUTSIDE, 0.01)]);
    expect(lookedUpBarcodes()).toEqual(["ONLY-OUTSIDE"]);
  });

  it("does not discard a decoded scan while layout is still unmeasured", async () => {
    // Re-layout after a rotation leaves a beat with no measured preview.
    setMockFetchHandler(notFoundHandler);
    const utils = await render(<CasesListScreen />);
    await fireEvent.press(utils.getByTestId("cases-scan-barcode"));
    await scan([codeAt("NO-LAYOUT", OUTSIDE, 0.01)]);
    expect(lookedUpBarcodes()).toEqual(["NO-LAYOUT"]);
  });

  it("navigates to the case matched by the centered barcode", async () => {
    const { router } = await import("expo-router");
    setMockFetchHandler(() =>
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            case: {
              id: "case-rotated-001",
              patientFirstName: "Rota",
              patientLastName: "Tion",
              caseNumber: "9101",
              status: "received",
            },
          },
        }),
        { status: 200 },
      ),
    );
    await openScanner();
    await scan([codeAt("OFF-CENTER", OFF_CENTER), codeAt("CENTERED", CENTERED)]);

    // The successful lookup schedules navigation after the scanner window;
    // flush that post-match delay before restoring real timers.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(900);
      await Promise.resolve();
    });
    vi.useRealTimers();
    await waitFor(
      () => expect(router.push).toHaveBeenCalledWith("/case/case-rotated-001"),
      { timeout: 3000 },
    );
    expect(lookedUpBarcodes()).toEqual(["CENTERED"]);
  });
});

// ── 2. Batch Locate ───────────────────────────────────────────────────────────

describe("Batch Locate — rotation", () => {
  async function openScanner() {
    const utils = await render(<BatchLocateScreen />);
    await waitFor(() => expect(utils.getByTestId("batch-locate-scanner-area")).toBeTruthy());
    await fireEvent(utils.getByTestId("batch-locate-scanner-area"), "layout", {
      nativeEvent: { layout: PORTRAIT_LAYOUT },
    });
    return utils;
  }

  async function scan(codes: MockBarcodeScanInput[]) {
    await act(async () => {
      triggerMockBarcodeScan(codes, null);
      vi.advanceTimersByTime(SCAN_WINDOW_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("accepts a centered barcode", async () => {
    setMockFetchHandler(notFoundHandler);
    await openScanner();
    await scan([codeAt("BATCH-CENTERED", CENTERED)]);
    expect(lookedUpBarcodes()).toEqual(["BATCH-CENTERED"]);
  });

  it("accepts the same centered barcode again after the phone is rotated", async () => {
    setMockFetchHandler(notFoundHandler);
    await openScanner();
    await scan([codeAt("BATCH-BEFORE", CENTERED)]);
    await scan([codeAt("BATCH-AFTER", CENTERED)]);
    expect(lookedUpBarcodes().sort()).toEqual(["BATCH-AFTER", "BATCH-BEFORE"]);
  });

  it("keeps every in-reticle barcode and drops the out-of-reticle one", async () => {
    // Batch Locate intentionally looks up EVERY in-box candidate, not just the
    // most centered one — the reticle is a boundary, not a tiebreak, here.
    setMockFetchHandler(notFoundHandler);
    await openScanner();
    await scan([
      codeAt("BATCH-IN-A", CENTERED),
      codeAt("BATCH-IN-B", OFF_CENTER),
      codeAt("BATCH-OUT", OUTSIDE, 0.01),
    ]);
    expect(lookedUpBarcodes().sort()).toEqual(["BATCH-IN-A", "BATCH-IN-B"]);
  });

  it("keeps in-reticle barcodes from two callbacks in one scan window", async () => {
    setMockFetchHandler(notFoundHandler);
    await openScanner();
    triggerMockBarcodeScan(
      [codeAt("BATCH-FIRST", CENTERED), codeAt("BATCH-STRAY", OUTSIDE, 0.01)],
      null,
    );
    await act(() => {
      vi.advanceTimersByTime(60);
    });
    // Batch Locate's window is deliberately NOT postponed by later callbacks,
    // so the remaining 60 ms still flushes both callbacks together.
    triggerMockBarcodeScan([codeAt("BATCH-SECOND", OFF_CENTER)], null);
    await act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(lookedUpBarcodes().sort()).toEqual(["BATCH-FIRST", "BATCH-SECOND"]);
  });

  it("does not discard a decoded scan when everything falls outside the reticle", async () => {
    setMockFetchHandler(notFoundHandler);
    await openScanner();
    await scan([codeAt("BATCH-ONLY-OUT", OUTSIDE, 0.01)]);
    expect(lookedUpBarcodes()).toEqual(["BATCH-ONLY-OUT"]);
  });

  it("does not discard a decoded scan while layout is still unmeasured", async () => {
    setMockFetchHandler(notFoundHandler);
    await render(<BatchLocateScreen />);
    await scan([codeAt("BATCH-NO-LAYOUT", OUTSIDE, 0.01)]);
    expect(lookedUpBarcodes()).toEqual(["BATCH-NO-LAYOUT"]);
  });

  it("adds the centered case to the batch", async () => {
    setMockFetchHandler(() =>
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            case: {
              id: "case-batch-rot-001",
              patientFirstName: "Landa",
              patientLastName: "Scape",
              caseNumber: "8101",
              status: "received",
              labOrganizationId: LAB_MEMBERSHIP.organizationId,
            },
          },
        }),
        { status: 200 },
      ),
    );
    const utils = await openScanner();
    await scan([codeAt("BATCH-MATCH", CENTERED), codeAt("BATCH-STRAY", OUTSIDE, 0.01)]);

    vi.useRealTimers();
    await waitFor(() => expect(utils.getByText("Landa Scape")).toBeTruthy());
    expect(lookedUpBarcodes()).toEqual(["BATCH-MATCH"]);
  });
});

// ── 3. AI-reader barcode assignment ───────────────────────────────────────────

describe("AI-reader barcode assignment — rotation", () => {
  const CASE_ID = "case-ai-reader-rot";

  async function openScanner() {
    setAiReaderSession({ caseId: CASE_ID, caseNumber: "26-77" });
    const utils = await render(<AiReaderBarcodeScreen />);
    await waitFor(() => expect(utils.getByTestId("ai-reader-scanner-wrap")).toBeTruthy());
    await fireEvent(utils.getByTestId("ai-reader-scanner-wrap"), "layout", {
      nativeEvent: { layout: PORTRAIT_LAYOUT },
    });
    return utils;
  }

  async function scan(codes: MockBarcodeScanInput[]): Promise<void> {
    await act(async () => {
      triggerMockBarcodeScan(codes, null);
      vi.advanceTimersByTime(SCAN_WINDOW_MS);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  /** Barcode values sent to PATCH /api/cases/:id. */
  function assignedBarcodes(): string[] {
    return vi
      .mocked(resilientFetch)
      .mock.calls.filter(([url, init]) => {
        const opts = init as RequestInit | undefined;
        return String(url).includes(`/api/cases/${CASE_ID}`) && opts?.method === "PATCH";
      })
      .map(([, init]) => {
        const body = JSON.parse(String((init as RequestInit).body));
        return String(body.casePanBarcode);
      });
  }

  function patchHandler() {
    return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 });
  }

  it("assigns a centered barcode", async () => {
    setMockFetchHandler(patchHandler);
    await openScanner();
    await scan([codeAt("AI-CENTERED", CENTERED)]);
    expect(assignedBarcodes()).toEqual(["AI-CENTERED"]);
  });

  it("assigns a centered barcode after the phone is rotated", async () => {
    setMockFetchHandler(patchHandler);
    await openScanner();
    await scan([codeAt("AI-AFTER-ROTATION", CENTERED)]);
    expect(assignedBarcodes()).toEqual(["AI-AFTER-ROTATION"]);
  });

  it("prefers the centered barcode over an off-center one", async () => {
    setMockFetchHandler(patchHandler);
    await openScanner();
    await scan([codeAt("AI-OFF-CENTER", OFF_CENTER), codeAt("AI-CENTERED", CENTERED)]);
    expect(assignedBarcodes()).toEqual(["AI-CENTERED"]);
  });

  it("ignores a barcode outside the reticle", async () => {
    setMockFetchHandler(patchHandler);
    await openScanner();
    await scan([codeAt("AI-OUTSIDE", OUTSIDE, 0.01), codeAt("AI-CENTERED", CENTERED)]);
    expect(assignedBarcodes()).toEqual(["AI-CENTERED"]);
  });

  it("prefers the centered barcode across two callbacks in one scan window", async () => {
    setMockFetchHandler(patchHandler);
    await openScanner();
    await act(async () => {
      triggerMockBarcodeScan([codeAt("AI-FIRST-OFF", OFF_CENTER)], null);
      vi.advanceTimersByTime(60);
      await Promise.resolve();
    });
    await scan([codeAt("AI-SECOND-CENTERED", CENTERED)]);
    expect(assignedBarcodes()).toEqual(["AI-SECOND-CENTERED"]);
  });

  it("does not discard a decoded scan when everything falls outside the reticle", async () => {
    setMockFetchHandler(patchHandler);
    await openScanner();
    await scan([codeAt("AI-ONLY-OUT", OUTSIDE, 0.01)]);
    expect(assignedBarcodes()).toEqual(["AI-ONLY-OUT"]);
  });

  it("does not discard a decoded scan while layout is still unmeasured", async () => {
    setMockFetchHandler(patchHandler);
    setAiReaderSession({ caseId: CASE_ID, caseNumber: "26-77" });
    await render(<AiReaderBarcodeScreen />);
    await scan([codeAt("AI-NO-LAYOUT", OUTSIDE, 0.01)]);
    expect(assignedBarcodes()).toEqual(["AI-NO-LAYOUT"]);
  });
});
