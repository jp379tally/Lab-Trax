import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { queryClient } from "@/lib/query-client";
import {
  isMockKeyboardVisible,
  mockAddCaseNoteMutateAsync,
  resetMockFetchHandler,
  resetMockUploadHandler,
  setMockUploadHandler,
  showMockKeyboard,
} from "../../../vitest.setup";

const { uploadMock } = vi.hoisted(() => ({ uploadMock: vi.fn() }));

vi.mock("@/lib/uploadCaseAttachment", () => ({
  uploadCaseAttachment: (params: unknown) => uploadMock(params),
}));
vi.mock("@/components/LocateCaseSheet", () => ({
  LocateCaseSheet: () => React.createElement("LocateCaseSheet", { testID: "quick-locate-sheet" }),
}));
vi.mock("@/components/CaseExceptionSheet", () => ({
  CaseExceptionCreateSheet: () =>
    React.createElement("CaseExceptionCreateSheet", { testID: "quick-exception-sheet" }),
}));

import { CaseQuickActionSheet } from "@/components/CaseQuickActionSheet";

const CASE = {
  id: "case-quick-1",
  caseNumber: "1001",
  patientFirstName: "Ada",
  patientLastName: "Lovelace",
  status: "in_design",
  labOrganizationId: "lab-1",
};

async function renderSheet() {
  const onDismiss = vi.fn();
  return {
    ...(await render(<CaseQuickActionSheet visible caseItem={CASE} onDismiss={onDismiss} />)),
    onDismiss,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAddCaseNoteMutateAsync.mockResolvedValue({ ok: true, data: null });
  uploadMock.mockResolvedValue({ ok: true, attachment: { id: "att-1" } });
  setMockUploadHandler(() => ({ ok: true, url: "/upload/test.jpg" }));
});

afterEach(() => {
  cleanup();
  resetMockFetchHandler();
  resetMockUploadHandler();
});

describe("CaseQuickActionSheet", () => {
  it("dismisses an open keyboard whenever any host presents quick actions", async () => {
    const onDismiss = vi.fn();
    const view = await render(
      <CaseQuickActionSheet visible={false} caseItem={CASE} onDismiss={onDismiss} />,
    );
    await act(async () => {
      showMockKeyboard();
    });
    expect(isMockKeyboardVisible()).toBe(true);

    await view.rerender(
      <CaseQuickActionSheet visible caseItem={CASE} onDismiss={onDismiss} />,
    );

    expect(isMockKeyboardVisible()).toBe(false);
    expect(view.getByTestId("case-quick-actions")).toBeTruthy();
  });

  it("offers all four approved actions", async () => {
    const { getByTestId, queryByTestId } = await renderSheet();
    expect(getByTestId("case-quick-action-locate")).toBeTruthy();
    expect(getByTestId("case-quick-action-note")).toBeTruthy();
    expect(getByTestId("case-quick-action-picture")).toBeTruthy();
    expect(getByTestId("case-quick-action-exception")).toBeTruthy();
  });

  it.each([
    ["case-quick-action-locate", "quick-locate-sheet"],
    ["case-quick-action-exception", "quick-exception-sheet"],
  ])("opens the existing workflow for %s", async (actionTestId, workflowTestId) => {
    const { getByTestId, queryByTestId } = await renderSheet();
    await fireEvent.press(getByTestId(actionTestId));
    expect(getByTestId(workflowTestId)).toBeTruthy();
  });

  it("requires a nonblank internal note", async () => {
    const { getByTestId, queryByTestId } = await renderSheet();
    await fireEvent.press(getByTestId("case-quick-action-note"));
    await fireEvent.press(getByTestId("case-quick-note-save"));
    expect(getByTestId("case-quick-note-error")).toBeTruthy();
    expect(queryByTestId("case-quick-note-input")?.props.value).toBe("");
    expect(mockAddCaseNoteMutateAsync).not.toHaveBeenCalled();
  });

  it("saves internal notes and invalidates case queries", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { getByTestId, onDismiss } = await renderSheet();
    await fireEvent.press(getByTestId("case-quick-action-note"));
    await fireEvent.changeText(getByTestId("case-quick-note-input"), "Check shade");
    await fireEvent.press(getByTestId("case-quick-note-save"));
    await waitFor(() => expect(mockAddCaseNoteMutateAsync).toHaveBeenCalled());
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect(mockAddCaseNoteMutateAsync).toHaveBeenCalledWith({
      caseId: CASE.id,
      data: { noteText: "Check shade", visibility: "internal_lab_only" },
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cases"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["case", CASE.id] });
    invalidate.mockRestore();
  });

  it("does not offer a duplicate note retry when refresh fails after the save commits", async () => {
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockRejectedValueOnce(new Error("refresh unavailable"));
    const { getByTestId, onDismiss } = await renderSheet();
    await fireEvent.press(getByTestId("case-quick-action-note"));
    await fireEvent.changeText(getByTestId("case-quick-note-input"), "Committed once");
    await fireEvent.press(getByTestId("case-quick-note-save"));
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect(mockAddCaseNoteMutateAsync).toHaveBeenCalledTimes(1);
    invalidate.mockRestore();
  });

  it("shows camera and library permission guidance, with settings when permission is final", async () => {
    vi.mocked(ImagePicker.requestCameraPermissionsAsync).mockResolvedValueOnce({
      granted: false,
      status: "denied",
      canAskAgain: false,
      expires: "never",
    } as never);
    const { getByTestId } = await renderSheet();
    await fireEvent.press(getByTestId("case-quick-action-picture"));
    await fireEvent.press(getByTestId("case-quick-photo-camera"));
    await waitFor(() => expect(getByTestId("case-quick-photo-open-settings")).toBeTruthy());
    await fireEvent.press(getByTestId("case-quick-photo-open-settings"));
    expect(vi.mocked(Linking.openSettings)).toHaveBeenCalled();
  });

  it("keeps the library retry path available after a permission denial", async () => {
    vi.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockResolvedValueOnce({
      granted: false,
      status: "denied",
      canAskAgain: true,
      expires: "never",
    } as never);
    const { getByTestId } = await renderSheet();
    await fireEvent.press(getByTestId("case-quick-action-picture"));
    await fireEvent.press(getByTestId("case-quick-photo-library"));
    await waitFor(() => expect(getByTestId("case-quick-photo-permission-error")).toBeTruthy());
    expect(getByTestId("case-quick-photo-library")).toBeTruthy();
    expect(() => getByTestId("case-quick-photo-open-settings")).toThrow();
  });

  it("requires a note for a selected picture", async () => {
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///photo.jpg", fileName: "photo.jpg" }],
    } as never);
    const { getByTestId, queryByTestId } = await renderSheet();
    await fireEvent.press(getByTestId("case-quick-action-picture"));
    await fireEvent.press(getByTestId("case-quick-photo-library"));
    await waitFor(() => expect(queryByTestId("case-quick-photo-empty")).toBeNull());
    await fireEvent.press(getByTestId("case-quick-photo-save"));
    expect(getByTestId("case-quick-photo-error")).toBeTruthy();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("shows upload progress and preserves work so a failed upload can retry", async () => {
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue(undefined);
    let attempt = 0;
    let resolveFirst: ((result: unknown) => void) | undefined;
    uploadMock.mockImplementation(async (params: { onProgress?: (value: number) => void }) => {
      attempt += 1;
      params.onProgress?.(0.42);
      if (attempt === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { ok: true, attachment: { id: "att-2" } };
    });
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///photo.jpg", fileName: "photo.jpg" }],
    } as never);
    const { getByTestId, onDismiss } = await renderSheet();
    await fireEvent.press(getByTestId("case-quick-action-picture"));
    await fireEvent.press(getByTestId("case-quick-photo-library"));
    await waitFor(() => expect(getByTestId("case-quick-photo-note-input")).toBeTruthy());
    await fireEvent.changeText(getByTestId("case-quick-photo-note-input"), "Inspect margin");
    await act(async () => {
      fireEvent.press(getByTestId("case-quick-photo-save"));
      await Promise.resolve();
    });
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(getByTestId("case-quick-photo-progress")).toBeTruthy();
    expect(resolveFirst).toEqual(expect.any(Function));
    await act(async () => {
      resolveFirst!({ ok: false, error: "Network unavailable" });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(getByTestId("case-quick-photo-error")).toBeTruthy());
    expect(getByTestId("case-quick-photo-note-input").props.value).toBe("Inspect margin");
    await fireEvent.press(getByTestId("case-quick-photo-save"));
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect(uploadMock).toHaveBeenCalledTimes(2);
    invalidate.mockRestore();
  });

  it("invalidates case queries after a successful picture upload", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///photo.jpg", fileName: "photo.jpg" }],
    } as never);
    const { getByTestId } = await renderSheet();
    await fireEvent.press(getByTestId("case-quick-action-picture"));
    await fireEvent.press(getByTestId("case-quick-photo-library"));
    await waitFor(() => expect(getByTestId("case-quick-photo-note-input")).toBeTruthy());
    await fireEvent.changeText(getByTestId("case-quick-photo-note-input"), "Ready for review");
    await fireEvent.press(getByTestId("case-quick-photo-save"));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cases"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["case", CASE.id] });
    invalidate.mockRestore();
  });

  it("does not offer a duplicate upload retry when refresh fails after registration", async () => {
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockRejectedValueOnce(new Error("refresh unavailable"));
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///photo.jpg", fileName: "photo.jpg" }],
    } as never);
    const { getByTestId, onDismiss } = await renderSheet();
    await fireEvent.press(getByTestId("case-quick-action-picture"));
    await fireEvent.press(getByTestId("case-quick-photo-library"));
    await waitFor(() => expect(getByTestId("case-quick-photo-note-input")).toBeTruthy());
    await fireEvent.changeText(getByTestId("case-quick-photo-note-input"), "Committed once");
    await fireEvent.press(getByTestId("case-quick-photo-save"));
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect(uploadMock).toHaveBeenCalledTimes(1);
    invalidate.mockRestore();
  });
});