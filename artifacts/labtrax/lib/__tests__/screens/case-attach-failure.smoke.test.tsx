// Regression guard for the user-facing photo-upload failure surface.
//
// Task #1419 covered the low-level chunk retry/resume logic in
// `chunkedUploadCaseMedia` (lib/query-client.ts), but the thing that actually
// protects a user — the "Upload Failed" alert that fires when an upload returns
// `{ ok: false }` — was untested. Without it a photo can silently vanish.
//
// These tests exercise the REAL caller: the photo-attach flow in
// `app/case/[id].tsx` (uploadAttachment). The global `@/lib/query-client` mock
// (see vitest.setup.ts) exposes a controllable `chunkedUploadCaseMedia`; we
// drive it via setMockUploadHandler and assert on the Alert.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react-native";
import { Alert } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import {
  resetMockAppState,
  resetMockFetchHandler,
  resetMockUploadHandler,
  setMockAppState,
  setMockSearchParams,
  setMockUploadHandler,
} from "../../../vitest.setup";

import CaseDetailScreen from "@/app/case/[id]";
import { inProgressCase, sampleClient } from "./__fixtures__/cases";

type AlertButton = { text?: string; onPress?: () => void | Promise<void> };

// Presses "Attach file", then pulls the named button's onPress out of the
// mocked Alert (Alert.alert is a vi.fn, so its action sheet never renders —
// scan.smoke.test.tsx uses the same trick).
function pressAttachAndGetButton(
  getAllByText: (t: string) => unknown[],
  buttonText: string,
): AlertButton {
  fireEvent.press((getAllByText("Attach file") as any[])[0]);
  const alertMock = vi.mocked(Alert.alert);
  const lastCall = alertMock.mock.calls[alertMock.mock.calls.length - 1];
  expect(lastCall[0]).toBe("Attach File");
  const buttons = lastCall[2] as AlertButton[];
  const button = buttons.find((b) => b.text === buttonText);
  expect(button).toBeTruthy();
  return button as AlertButton;
}

afterEach(() => {
  cleanup();
  setMockSearchParams({});
  resetMockAppState();
  resetMockFetchHandler();
  resetMockUploadHandler();
  vi.mocked(Alert.alert).mockClear();
});

describe("CaseDetailScreen — photo upload failure surface", () => {
  function renderWithCase() {
    setMockSearchParams({ id: inProgressCase.id });
    setMockAppState({
      cases: [inProgressCase],
      invoices: [],
      clients: [sampleClient],
    });
    return render(<CaseDetailScreen />);
  }

  it('shows an "Upload Failed" alert when the upload returns { ok: false }', async () => {
    // The upload helper reports failure (e.g. all chunk retries exhausted).
    setMockUploadHandler(() => ({ ok: false }));
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [
        { uri: "file:///tmp/scan.jpg", name: "scan.jpg", mimeType: "image/jpeg" },
      ],
    } as any);

    const { getAllByText } = renderWithCase();
    const browse = pressAttachAndGetButton(getAllByText, "Browse Files");

    // Ignore the "Attach File" action-sheet alert; we only care about the
    // failure alert that fires after the upload resolves.
    vi.mocked(Alert.alert).mockClear();
    await (browse.onPress as () => Promise<void>)();

    const calls = vi.mocked(Alert.alert).mock.calls;
    const failureAlert = calls.find((c) => c[0] === "Upload Failed");
    expect(failureAlert).toBeTruthy();
  });

  it("does NOT show a failure alert when the upload succeeds", async () => {
    // Default handler returns { ok: true }; the follow-up attachment POST also
    // succeeds via the default fetch handler ({ data: null } → res.ok true).
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [
        { uri: "file:///tmp/scan.jpg", name: "scan.jpg", mimeType: "image/jpeg" },
      ],
    } as any);

    const { getAllByText } = renderWithCase();
    const browse = pressAttachAndGetButton(getAllByText, "Browse Files");

    vi.mocked(Alert.alert).mockClear();
    await (browse.onPress as () => Promise<void>)();

    const calls = vi.mocked(Alert.alert).mock.calls;
    expect(calls.find((c) => c[0] === "Upload Failed")).toBeFalsy();
  });

  // ── Camera path ──────────────────────────────────────────────────────────
  // The "Camera" button funnels through requestCameraWithPrompt: when
  // getCameraPermissionsAsync reports `{ granted: true }` (the global mock
  // default) the onGranted callback runs synchronously inside the resolved
  // promise, calling launchCameraAsync and then the shared uploadAttachment.
  it('Camera path: shows an "Upload Failed" alert when the upload returns { ok: false }', async () => {
    setMockUploadHandler(() => ({ ok: false }));
    vi.mocked(ImagePicker.launchCameraAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///tmp/camera.jpg", mimeType: "image/jpeg" }],
    } as any);

    const { getAllByText } = renderWithCase();
    const camera = pressAttachAndGetButton(getAllByText, "Camera");

    vi.mocked(Alert.alert).mockClear();
    await (camera.onPress as () => Promise<void>)();
    // requestCameraWithPrompt resolves getCameraPermissionsAsync in a
    // microtask before invoking onGranted → uploadAttachment; flush it.
    await new Promise((r) => setTimeout(r, 0));

    const calls = vi.mocked(Alert.alert).mock.calls;
    const failureAlert = calls.find((c) => c[0] === "Upload Failed");
    expect(failureAlert).toBeTruthy();
  });

  it("Camera path: does NOT show a failure alert when the upload succeeds", async () => {
    vi.mocked(ImagePicker.launchCameraAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///tmp/camera.jpg", mimeType: "image/jpeg" }],
    } as any);

    const { getAllByText } = renderWithCase();
    const camera = pressAttachAndGetButton(getAllByText, "Camera");

    vi.mocked(Alert.alert).mockClear();
    await (camera.onPress as () => Promise<void>)();
    await new Promise((r) => setTimeout(r, 0));

    const calls = vi.mocked(Alert.alert).mock.calls;
    expect(calls.find((c) => c[0] === "Upload Failed")).toBeFalsy();
  });

  // ── Photo Library path ───────────────────────────────────────────────────
  // The "Photo Library" button gates on requestMediaLibraryPermissionsAsync
  // (newly added to the global mock so this path is drivable) then loops over
  // launchImageLibraryAsync assets through the shared uploadAttachment.
  it('Photo Library path: shows an "Upload Failed" alert when the upload returns { ok: false }', async () => {
    setMockUploadHandler(() => ({ ok: false }));
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///tmp/library.jpg", mimeType: "image/jpeg" }],
    } as any);

    const { getAllByText } = renderWithCase();
    const library = pressAttachAndGetButton(getAllByText, "Photo Library");

    vi.mocked(Alert.alert).mockClear();
    await (library.onPress as () => Promise<void>)();

    const calls = vi.mocked(Alert.alert).mock.calls;
    const failureAlert = calls.find((c) => c[0] === "Upload Failed");
    expect(failureAlert).toBeTruthy();
  });

  it("Photo Library path: does NOT show a failure alert when the upload succeeds", async () => {
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///tmp/library.jpg", mimeType: "image/jpeg" }],
    } as any);

    const { getAllByText } = renderWithCase();
    const library = pressAttachAndGetButton(getAllByText, "Photo Library");

    vi.mocked(Alert.alert).mockClear();
    await (library.onPress as () => Promise<void>)();

    const calls = vi.mocked(Alert.alert).mock.calls;
    expect(calls.find((c) => c[0] === "Upload Failed")).toBeFalsy();
  });
});
