/**
 * Integration test for the returned-case wizard's "Scan a new prescription?"
 * branch: capture → review → attach to the existing case → resume the wizard.
 *
 * The regression this pins down: the capture screen resets the AI reader
 * session when it is opened with `new=1`. The wizard primes that same session
 * with the case to attach to, so without the `attach=1` opt-out the context is
 * wiped and review silently falls back to the create-a-case flow.
 */
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import {
  resetMockUploadHandler,
  setMockFetchHandler,
  setMockSearchParams,
  setMockUploadHandler,
} from "../../../vitest.setup";
import {
  clearAiReaderSession,
  getAiReaderSession,
  setAiReaderSession,
} from "@/lib/ai-reader-store";
import {
  clearPendingReturnedWizard,
  peekPendingReturnedWizard,
  setPendingReturnedWizard,
} from "@/lib/returned-case-wizard";

// The capture screen dynamically imports the native scanner on mount. Cancel
// immediately so the screen settles without a real document capture.
vi.mock("react-native-document-scanner-plugin", () => ({
  default: { scanDocument: vi.fn(async () => ({ status: "cancel", scannedImages: [] })) },
  ResponseType: { ImageFilePath: "imageFilePath" },
  ScanDocumentResponseStatus: { Cancel: "cancel", Success: "success" },
}));

const CASE_ID = "case-abc";

/** Exactly what the case screen's handleWizardScanRx does before navigating. */
function primeWizardScanSession() {
  clearAiReaderSession();
  setAiReaderSession({
    caseId: CASE_ID,
    attachToCaseId: CASE_ID,
    caseNumber: "C-100",
    patientName: "Jane Doe",
  });
  setPendingReturnedWizard(CASE_ID, "remake");
}

beforeEach(() => {
  clearAiReaderSession();
  clearPendingReturnedWizard();
  resetMockUploadHandler();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  clearAiReaderSession();
  clearPendingReturnedWizard();
});

describe("returned-case Rx re-scan — capture stage", () => {
  it("keeps the attach-to-case context when opened with new=1&attach=1", async () => {
    primeWizardScanSession();
    setMockSearchParams({ new: "1", attach: "1" });
    const CaptureScreen = (await import("@/app/ai-reader/capture")).default;
    await render(<CaptureScreen />);
    // Let the auto-launched (mock-cancelled) scanner settle.
    await act(async () => undefined);
    expect(getAiReaderSession().attachToCaseId).toBe(CASE_ID);
  });

  it("still resets the session for an ordinary new intake scan", async () => {
    primeWizardScanSession();
    setMockSearchParams({ new: "1" });
    const CaptureScreen = (await import("@/app/ai-reader/capture")).default;
    await render(<CaptureScreen />);
    await act(async () => undefined);
    expect(getAiReaderSession().attachToCaseId).toBeNull();
  });
});

describe("returned-case Rx re-scan — review stage", () => {
  it("uploads the pages to the existing case and returns to it", async () => {
    primeWizardScanSession();
    setAiReaderSession({
      pages: [
        { uri: "file:///page-1.jpg", base64: "AAA" },
        { uri: "file:///page-2.jpg", base64: "BBB" },
      ],
    });
    setMockSearchParams({});

    const uploads: { uri: string; name: string; mimeType: string }[] = [];
    setMockUploadHandler((uri, name, mimeType) => {
      uploads.push({ uri, name, mimeType });
      return { ok: true, url: `/uploads/case-media/${name}` };
    });

    const attachBodies: any[] = [];
    const rxNoteBodies: any[] = [];
    setMockFetchHandler(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/analyze-prescription")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              doctorName: "Smith",
              material: "Zirconia",
              shade: "A2",
              notes: "Keep the original incisal contour.",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes(`/api/cases/${CASE_ID}/attachments`)) {
        attachBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ data: { id: "att-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes(`/api/cases/${CASE_ID}/rx-note-scans`)) {
        rxNoteBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ ok: true, data: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const ReviewScreen = (await import("@/app/ai-reader/review")).default;
    const utils = await render(<ReviewScreen />);
    await act(async () => {
      await fireEvent.press(utils.getByTestId("ai-reader-process-btn"));
    });

    // Both captured pages land on the existing case as attachments…
    await waitFor(() => expect(attachBodies).toHaveLength(2));
    expect(uploads).toHaveLength(2);
    expect(uploads.map(({ uri }) => uri)).toEqual([
      "file:///page-1.jpg",
      "file:///page-2.jpg",
    ]);
    expect(uploads.every(({ mimeType }) => mimeType === "image/jpeg")).toBe(true);
    for (const body of attachBodies as { note?: string; submissionId?: string }[]) {
      expect(body.note).toContain("Rescanned prescription");
      expect(body.submissionId).toMatch(/:page:/);
    }
    expect(rxNoteBodies).toEqual([
      expect.objectContaining({
        submissionId: expect.any(String),
        notes: "Keep the original incisal contour.",
      }),
    ]);

    // …no new case is created, and the user is taken back to the case with the
    // scanner stack unwound so Back doesn't land on the camera.
    expect(router.push).not.toHaveBeenCalled();
    expect(router.dismissTo).toHaveBeenCalledWith(`/case/${CASE_ID}`);

    // The parked wizard stage survives for the case screen to resume, and the
    // attach context does not follow the user into their next scan.
    expect(peekPendingReturnedWizard()).toEqual({ caseId: CASE_ID, stage: "remake" });
    expect(getAiReaderSession().attachToCaseId).toBeNull();
  });

  it("keeps the user on review when the attachment upload fails", async () => {
    primeWizardScanSession();
    setAiReaderSession({ pages: [{ uri: "file:///page-1.jpg", base64: "AAA" }] });
    setMockSearchParams({});
    setMockUploadHandler(() => ({ ok: false, error: "network down" }));
    setMockFetchHandler(
      async () =>
        new Response(JSON.stringify({ success: true, data: { doctorName: "Smith" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const ReviewScreen = (await import("@/app/ai-reader/review")).default;
    const utils = await render(<ReviewScreen />);
    await act(async () => {
      await fireEvent.press(utils.getByTestId("ai-reader-process-btn"));
    });

    await waitFor(() => {
      expect(utils.getByText(/Couldn't attach the prescription/)).toBeTruthy();
    });
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("retries note persistence with the same scan ID without re-uploading pages", async () => {
    primeWizardScanSession();
    setAiReaderSession({ pages: [{ uri: "file:///page-1.jpg", base64: "AAA" }] });
    setMockSearchParams({});

    const uploadUris: string[] = [];
    setMockUploadHandler((uri, name, mimeType) => {
      uploadUris.push(uri);
      return { ok: true, url: `/uploads/case-media/${name}` };
    });
    let analysisCalls = 0;
    const noteBodies: any[] = [];
    let noteSaveAttempts = 0;
    setMockFetchHandler(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/analyze-prescription")) {
        analysisCalls += 1;
        return new Response(
          JSON.stringify({ success: true, data: { notes: "Use the signed shade." } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes(`/api/cases/${CASE_ID}/attachments`)) {
        return new Response(JSON.stringify({ data: { id: "att-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes(`/api/cases/${CASE_ID}/rx-note-scans`)) {
        noteSaveAttempts += 1;
        noteBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ error: "temporary failure" }), {
          status: noteSaveAttempts === 1 ? 503 : 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const ReviewScreen = (await import("@/app/ai-reader/review")).default;
    const utils = await render(<ReviewScreen />);
    await act(async () => {
      await fireEvent.press(utils.getByTestId("ai-reader-process-btn"));
    });
    await waitFor(() =>
      expect(utils.getByText(/Couldn't save prescription notes/)).toBeTruthy(),
    );
    const firstSubmissionId = noteBodies[0]?.submissionId;
    expect(firstSubmissionId).toBeTruthy();

    await act(async () => {
      await fireEvent.press(utils.getByTestId("ai-reader-process-btn"));
    });
    await waitFor(() => expect(router.dismissTo).toHaveBeenCalled());

    expect(analysisCalls).toBe(1);
    expect(uploadUris).toEqual(["file:///page-1.jpg"]);
    expect(noteBodies).toHaveLength(2);
    expect(noteBodies[1]).toEqual(noteBodies[0]);
  });
});
