// UI visibility layer for the existing photo/video upload retry queue
// (Task #1421). The retry queue itself (lib/pending-uploads.ts + app-context)
// is covered elsewhere; these tests cover only the banner that exposes it:
//
// - badge/banner appears when there are pending uploads
// - it is hidden when the queue is empty
// - tapping it shows the parked uploads
// - "Retry now" requests a retry, "Discard" requests a discard
// - the banner clears once the queue drains
//
// The banner now sources its data directly from the pending-uploads helpers
// (lib/pending-uploads.ts) instead of the deprecated app-context sync fields,
// so we drive it with the reactive store: setPendingUploadsSnapshot pushes the
// live queue and registerPendingUploadHandlers captures the retry/discard
// requests the banner makes.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react-native";

import { PendingSyncBanner } from "@/components/PendingSyncBanner";
import {
  type PendingUpload,
  setPendingUploadsSnapshot,
  registerPendingUploadHandlers,
} from "@/lib/pending-uploads";

function pendingPhoto(id: string, attempts = 0): PendingUpload {
  return {
    id,
    caseId: `case-${id}`,
    fileUri: `file:///tmp/${id}.jpg`,
    isVid: false,
    createdAt: 0,
    attempts,
  };
}

afterEach(() => {
  cleanup();
  setPendingUploadsSnapshot([]);
  registerPendingUploadHandlers({ retry: () => undefined, discard: () => undefined });
});

describe("PendingSyncBanner", () => {
  it("shows the badge/banner when there are pending uploads", () => {
    setPendingUploadsSnapshot([pendingPhoto("a"), pendingPhoto("b")]);

    const { getByText } = render(<PendingSyncBanner />);
    expect(getByText("2 attachments still uploading")).toBeTruthy();
    // Requirement 7: the user can tell it isn't on web/desktop yet.
    expect(getByText("Not yet visible on web or desktop")).toBeTruthy();
  });

  it("is hidden when the queue is empty", () => {
    setPendingUploadsSnapshot([]);

    const { queryByText, toJSON } = render(<PendingSyncBanner />);
    expect(queryByText(/still uploading/)).toBeNull();
    expect(toJSON()).toBeNull();
  });

  it("shows the parked uploads when the banner is tapped", () => {
    setPendingUploadsSnapshot([pendingPhoto("a", 3)]);

    const { getByText, getByLabelText, queryByLabelText } = render(
      <PendingSyncBanner />,
    );
    // The management sheet (and its per-item actions) is not shown until tap.
    expect(queryByLabelText("Retry now")).toBeNull();

    fireEvent.press(getByLabelText(/Tap to manage pending uploads/));

    expect(getByText("Waiting to upload")).toBeTruthy();
    expect(getByText(/Photo/)).toBeTruthy();
    expect(getByLabelText("Retry now")).toBeTruthy();
    expect(getByLabelText("Discard")).toBeTruthy();
  });

  it('"Retry now" requests a retry with the item id', () => {
    const retry = vi.fn();
    registerPendingUploadHandlers({ retry, discard: vi.fn() });
    setPendingUploadsSnapshot([pendingPhoto("item-1")]);

    const { getByLabelText } = render(<PendingSyncBanner />);
    fireEvent.press(getByLabelText(/Tap to manage pending uploads/));
    fireEvent.press(getByLabelText("Retry now"));

    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith("item-1");
  });

  it('"Discard" requests a discard with the item id', () => {
    const discard = vi.fn();
    registerPendingUploadHandlers({ retry: vi.fn(), discard });
    setPendingUploadsSnapshot([pendingPhoto("item-9")]);

    const { getByLabelText } = render(<PendingSyncBanner />);
    fireEvent.press(getByLabelText(/Tap to manage pending uploads/));
    fireEvent.press(getByLabelText("Discard"));

    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith("item-9");
  });

  it("clears the banner after the queue drains", () => {
    setPendingUploadsSnapshot([pendingPhoto("a")]);

    const { queryByText, rerender } = render(<PendingSyncBanner />);
    expect(queryByText("1 attachment still uploading")).toBeTruthy();

    // Queue drains (e.g. uploads recovered) → snapshot goes empty.
    setPendingUploadsSnapshot([]);
    rerender(<PendingSyncBanner />);

    expect(queryByText(/still uploading/)).toBeNull();
  });
});
