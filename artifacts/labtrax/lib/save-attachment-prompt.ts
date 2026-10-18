import { Alert } from "react-native";
import { saveImageToDevice, saveDocumentToDevice } from "./save-to-device";

export type SaveAttachmentTarget =
  | { kind: "image"; url: string; fileName?: string | null; fileType?: string | null }
  | { kind: "document"; url: string; fileName?: string | null; fileType?: string | null };

export interface ConfirmSaveAttachmentOptions {
  // Toggle a busy indicator around the async save, mirroring
  // openAttachmentPreview's setBusy so call sites can reuse the same
  // per-item spinner state they already have for tap-to-open.
  setBusy?: (busy: boolean) => void;
}

// Reusable long-press "Save" prompt shared by every photo/document tile
// (files grid, timelines, lightboxes). Confirms with the user, then either
// saves a photo to the device photo library or hands a document to the OS
// share/save flow, always leaving the user with a clear success or error
// message — including a specific message when photo-library permission is
// denied.
export function confirmSaveAttachment(
  target: SaveAttachmentTarget,
  opts: ConfirmSaveAttachmentOptions = {},
): void {
  const isImage = target.kind === "image";
  const title = isImage ? "Save Photo" : "Save File";
  const subject = isImage ? "this photo" : `"${target.fileName || "this file"}"`;

  Alert.alert(title, `Save a copy of ${subject} to your device?`, [
    { text: "Cancel", style: "cancel" },
    {
      text: "Save",
      onPress: async () => {
        opts.setBusy?.(true);
        try {
          if (target.kind === "image") {
            const result = target.fileName
              ? await saveImageToDevice(target.url, {
                  fileName: target.fileName,
                  fileType: target.fileType,
                })
              : await saveImageToDevice(target.url);
            if (result === "saved") {
              Alert.alert("Saved", "Photo saved to your device.");
            } else if (result === "permission-denied") {
              Alert.alert(
                "Permission needed",
                "Enable photo library access in Settings to save photos to your device.",
              );
            } else {
              Alert.alert("Couldn't save", "This photo could not be saved. Please try again.");
            }
          } else {
            const result = await saveDocumentToDevice(target);
            if (result === "unavailable") {
              Alert.alert("Can't save file", "Saving files isn't supported on this device.");
            } else if (result === "error") {
              Alert.alert(
                "Couldn't save file",
                "This file could not be downloaded or saved. Please try again.",
              );
            }
            // "opened" — the OS share/save sheet is now up; no extra alert needed.
          }
        } finally {
          opts.setBusy?.(false);
        }
      },
    },
  ]);
}
