// Tests for `lib/save-attachment-prompt.ts` — the reusable long-press "Save"
// confirmation shared by every photo/document tile. We mock react-native's
// Alert and the save-to-device helpers so no real Alert UI or I/O happens,
// and drive the confirm/cancel buttons directly.
import { describe, it, expect, beforeEach, vi } from "vitest";

const { alert, saveImageToDevice, saveDocumentToDevice } = vi.hoisted(() => ({
  alert: vi.fn(),
  saveImageToDevice: vi.fn(),
  saveDocumentToDevice: vi.fn(),
}));

vi.mock("react-native", () => ({
  Alert: { alert },
}));

vi.mock("@/lib/save-to-device", () => ({
  saveImageToDevice,
  saveDocumentToDevice,
}));

import { confirmSaveAttachment } from "@/lib/save-attachment-prompt";

type AlertButton = { text: string; style?: string; onPress?: () => void | Promise<void> };

function pressButton(text: string) {
  const buttons = alert.mock.calls[alert.mock.calls.length - 1][2] as AlertButton[];
  const button = buttons.find((b) => b.text === text);
  return button?.onPress?.();
}

beforeEach(() => {
  vi.clearAllMocks();
  saveImageToDevice.mockResolvedValue("saved");
  saveDocumentToDevice.mockResolvedValue("opened");
});

describe("confirmSaveAttachment — image", () => {
  it("shows a Save/Cancel confirmation before doing anything", async () => {
    confirmSaveAttachment({ kind: "image", url: "/api/x" });
    expect(saveImageToDevice).not.toHaveBeenCalled();
    const [title, , buttons] = alert.mock.calls[0] as [string, string, AlertButton[]];
    expect(title).toBe("Save Photo");
    expect(buttons.map((b) => b.text)).toEqual(["Cancel", "Save"]);
  });

  it("saves the image and confirms success on 'Save'", async () => {
    confirmSaveAttachment({ kind: "image", url: "/api/x" });
    await pressButton("Save");
    expect(saveImageToDevice).toHaveBeenCalledWith("/api/x");
    expect(alert).toHaveBeenLastCalledWith("Saved", "Photo saved to your device.");
  });

  it("passes the original photo name and type to the authenticated save helper", async () => {
    confirmSaveAttachment({
      kind: "image",
      url: "/api/cases/c1/attachments/a1/file",
      fileName: "margin.jpg",
      fileType: "image/jpeg",
    });
    await pressButton("Save");
    expect(saveImageToDevice).toHaveBeenCalledWith(
      "/api/cases/c1/attachments/a1/file",
      { fileName: "margin.jpg", fileType: "image/jpeg" },
    );
  });

  it("shows a specific message when photo-library permission is denied", async () => {
    saveImageToDevice.mockResolvedValue("permission-denied");
    confirmSaveAttachment({ kind: "image", url: "/api/x" });
    await pressButton("Save");
    expect(alert).toHaveBeenLastCalledWith(
      "Permission needed",
      "Enable photo library access in Settings to save photos to your device.",
    );
  });

  it("shows a generic error message on failure", async () => {
    saveImageToDevice.mockResolvedValue("error");
    confirmSaveAttachment({ kind: "image", url: "/api/x" });
    await pressButton("Save");
    expect(alert).toHaveBeenLastCalledWith(
      "Couldn't save",
      "This photo could not be saved. Please try again.",
    );
  });

  it("does nothing on 'Cancel'", async () => {
    confirmSaveAttachment({ kind: "image", url: "/api/x" });
    pressButton("Cancel");
    expect(saveImageToDevice).not.toHaveBeenCalled();
  });

  it("toggles the busy flag around the save", async () => {
    const setBusy = vi.fn();
    confirmSaveAttachment({ kind: "image", url: "/api/x" }, { setBusy });
    await pressButton("Save");
    expect(setBusy.mock.calls).toEqual([[true], [false]]);
  });
});

describe("confirmSaveAttachment — document", () => {
  it("includes the file name in the confirmation", async () => {
    confirmSaveAttachment({ kind: "document", url: "/api/x", fileName: "report.pdf" });
    const [title, message] = alert.mock.calls[0] as [string, string];
    expect(title).toBe("Save File");
    expect(message).toContain("report.pdf");
  });

  it("hands the file to the share/save flow on 'Save'", async () => {
    const target = {
      kind: "document" as const,
      url: "/api/x",
      fileName: "report.pdf",
      fileType: "application/pdf",
    };
    confirmSaveAttachment(target);
    await pressButton("Save");
    expect(saveDocumentToDevice).toHaveBeenCalledWith(target);
  });

  it("shows an error message when the file can't be saved", async () => {
    saveDocumentToDevice.mockResolvedValue("error");
    confirmSaveAttachment({ kind: "document", url: "/api/x" });
    await pressButton("Save");
    expect(alert).toHaveBeenLastCalledWith(
      "Couldn't save file",
      "This file could not be downloaded or saved. Please try again.",
    );
  });

  it("shows an 'unavailable' message when sharing isn't supported", async () => {
    saveDocumentToDevice.mockResolvedValue("unavailable");
    confirmSaveAttachment({ kind: "document", url: "/api/x" });
    await pressButton("Save");
    expect(alert).toHaveBeenLastCalledWith(
      "Can't save file",
      "Saving files isn't supported on this device.",
    );
  });

  it("does not show an extra alert when the share sheet opens successfully", async () => {
    confirmSaveAttachment({ kind: "document", url: "/api/x" });
    await pressButton("Save");
    // Only the initial confirmation alert should have fired.
    expect(alert).toHaveBeenCalledTimes(1);
  });
});
