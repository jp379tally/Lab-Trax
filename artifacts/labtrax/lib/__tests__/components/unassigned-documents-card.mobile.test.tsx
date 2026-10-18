import React from "react";
import { Alert } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor, cleanup } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";

const { saveMock, invalidateMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  invalidateMock: vi.fn(),
}));

vi.mock("@/lib/shared-file-inbox", () => ({
  saveFileToUnassignedDocuments: (...args: unknown[]) => saveMock(...args),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: invalidateMock }),
}));
vi.mock("@/lib/auth-me", () => ({
  useMe: () => ({ data: { memberships: [{ organizationId: "lab-1", organizationType: "lab" }] } }),
  primaryLabOrgId: () => "lab-1",
}));
vi.mock("@/lib/theme-context", () => ({
  useTheme: () => ({
    colors: {
      tint: "#2563eb", text: "#111827", textSecondary: "#4b5563",
      textTertiary: "#6b7280", textInverse: "#fff", border: "#d1d5db",
      surface: "#fff", background: "#f9fafb",
    },
  }),
}));
vi.mock("@workspace/api-client-react", () => ({
  useListLabInboxFiles: () => ({ data: { data: [] }, isLoading: false }),
  useAssignLabInboxFile: () => ({ mutate: vi.fn(), isPending: false }),
  getListLabInboxFilesQueryKey: () => ["lab-inbox"],
}));
vi.mock("@/lib/open-attachment", () => ({ openAttachment: vi.fn() }));

import { UnassignedDocumentsCard } from "@/components/UnassignedDocumentsCard";

async function renderCard() {
  return render(<UnassignedDocumentsCard />);
}

beforeEach(() => {
  vi.clearAllMocks();
  saveMock.mockResolvedValue({ ok: true });
  vi.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockResolvedValue({
    status: "granted",
    granted: true,
  } as never);
  vi.mocked(ImageManipulator.manipulateAsync).mockImplementation(async (uri) => ({
    uri: `${uri}-jpeg`,
  }) as never);
});

afterEach(() => {
  cleanup();
});

describe("UnassignedDocumentsCard mobile photo intake", () => {
  it("does not open a confirmation or upload when photo permission is denied", async () => {
    vi.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockResolvedValueOnce({
      status: "denied",
      granted: false,
    } as never);
    const alert = vi.spyOn(Alert, "alert").mockImplementation(() => undefined);
    const screen = await renderCard();

    await fireEvent.press(screen.getByLabelText("Choose photos from library"));

    expect(ImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(
      "Photo Library Permission Required",
      expect.stringContaining("photo access"),
    );
    alert.mockRestore();
  });

  it("accepts limited iOS photo-library access", async () => {
    vi.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockResolvedValueOnce({
      status: "granted",
      granted: true,
      accessPrivileges: "limited",
    } as never);
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///limited.heic", fileName: "limited.heic" }],
    } as never);
    const screen = await renderCard();

    await fireEvent.press(screen.getByLabelText("Choose photos from library"));

    expect(ImageManipulator.manipulateAsync).toHaveBeenCalledWith(
      "file:///limited.heic",
      [{ resize: { width: 1200 } }],
      expect.objectContaining({ format: ImageManipulator.SaveFormat.JPEG }),
    );
    expect(screen.getByTestId("unassigned-document-upload")).toBeTruthy();
  });

  it("reports native permission and picker failures instead of rejecting silently", async () => {
    vi.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockRejectedValueOnce(
      new Error("native picker unavailable"),
    );
    const alert = vi.spyOn(Alert, "alert").mockImplementation(() => undefined);
    const screen = await renderCard();

    await fireEvent.press(screen.getByLabelText("Choose photos from library"));

    expect(alert).toHaveBeenCalledWith(
      "Could not open photo library",
      "native picker unavailable",
    );
    expect(saveMock).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it("treats a cancelled library picker as a no-op", async () => {
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({
      canceled: true,
      assets: [],
    } as never);
    const screen = await renderCard();

    await fireEvent.press(screen.getByLabelText("Choose photos from library"));

    expect(saveMock).not.toHaveBeenCalled();
    expect(ImageManipulator.manipulateAsync).not.toHaveBeenCalled();
  });

  it("normalizes every selected photo to JPEG and confirms each file sequentially", async () => {
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [
        { uri: "file:///photo.heic", fileName: "shade.heic", mimeType: "image/heic" },
        { uri: "file:///photo-2.png", fileName: "scan.png", mimeType: "image/png" },
      ],
    } as never);
    const screen = await renderCard();

    await fireEvent.press(screen.getByLabelText("Choose photos from library"));
    expect(ImageManipulator.manipulateAsync).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("unassigned-document-note").props.maxLength).toBe(2000);

    await fireEvent.press(screen.getByTestId("unassigned-document-upload"));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock.mock.calls[0][0]).toMatchObject({
      fileUri: "file:///photo.heic-jpeg",
      fileName: "shade.jpg",
      mimeType: "image/jpeg",
    });
    expect(screen.getByTestId("unassigned-document-upload")).toBeTruthy();

    await fireEvent.press(screen.getByTestId("unassigned-document-upload"));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(2));
    expect(saveMock.mock.calls[1][0]).toMatchObject({
      fileUri: "file:///photo-2.png-jpeg",
      fileName: "scan.jpg",
      mimeType: "image/jpeg",
    });
  });

  it("keeps the current file and remaining queue available after a failed upload", async () => {
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [
        { uri: "file:///one.heic", fileName: "one.heic" },
        { uri: "file:///two.heif", fileName: "two.heif" },
      ],
    } as never);
    saveMock
      .mockResolvedValueOnce({ ok: false, error: "network down" })
      .mockResolvedValue({ ok: true });
    const screen = await renderCard();

    await fireEvent.press(screen.getByLabelText("Choose photos from library"));
    await fireEvent.press(screen.getByTestId("unassigned-document-upload"));
    await waitFor(() => expect(screen.getByText("network down")).toBeTruthy());
    expect(saveMock).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByText("Retry"));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(2));
    expect(saveMock.mock.calls[1][0].fileName).toBe("one.jpg");
    expect(screen.getByTestId("unassigned-document-upload")).toBeTruthy();
  });
});