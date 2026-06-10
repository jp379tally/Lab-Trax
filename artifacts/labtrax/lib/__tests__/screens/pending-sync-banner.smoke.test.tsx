// UI visibility layer for the existing photo/video upload retry queue
// (Task #1421). The retry queue itself (lib/pending-uploads.ts + app-context)
// is covered elsewhere; these tests cover only the banner that exposes it:
//
// - badge/banner appears when pendingSyncCount > 0
// - it is hidden when the queue is empty
// - tapping it shows the stuck items from stuckSyncItems
// - "Retry now" calls retrySync, "Discard" calls discardSync
// - the banner clears once the queue drains
//
// The banner reads pendingSyncCount / stuckSyncItems and drives the queue's own
// retrySync / discardSync via useApp(), so we drive it with setMockAppState.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react-native";
import { resetMockAppState, setMockAppState } from "../../../vitest.setup";

import { PendingSyncBanner } from "@/components/PendingSyncBanner";
import type { StuckQueueItem } from "@/lib/sync-types";

function stuckPhoto(id: string, attempts = 0): StuckQueueItem {
  return { id, caseId: `case-${id}`, type: "photo", attempts };
}

afterEach(() => {
  cleanup();
  resetMockAppState();
});

describe("PendingSyncBanner", () => {
  it("shows the badge/banner when pendingSyncCount > 0", () => {
    setMockAppState({
      pendingSyncCount: 2,
      stuckSyncItems: [stuckPhoto("a"), stuckPhoto("b")],
      retrySync: vi.fn(),
      discardSync: vi.fn(),
    });

    const { getByText } = render(<PendingSyncBanner />);
    expect(getByText("2 attachments still uploading")).toBeTruthy();
    // Requirement 7: the user can tell it isn't on web/desktop yet.
    expect(getByText("Not yet visible on web or desktop")).toBeTruthy();
  });

  it("is hidden when the queue is empty", () => {
    setMockAppState({
      pendingSyncCount: 0,
      stuckSyncItems: [],
      retrySync: vi.fn(),
      discardSync: vi.fn(),
    });

    const { queryByText, toJSON } = render(<PendingSyncBanner />);
    expect(queryByText(/still uploading/)).toBeNull();
    expect(toJSON()).toBeNull();
  });

  it("shows the stuck items when the banner is tapped", () => {
    setMockAppState({
      pendingSyncCount: 1,
      stuckSyncItems: [stuckPhoto("a", 3)],
      retrySync: vi.fn(),
      discardSync: vi.fn(),
    });

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

  it('"Retry now" calls retrySync with the item id', () => {
    const retrySync = vi.fn();
    setMockAppState({
      pendingSyncCount: 1,
      stuckSyncItems: [stuckPhoto("item-1")],
      retrySync,
      discardSync: vi.fn(),
    });

    const { getByLabelText } = render(<PendingSyncBanner />);
    fireEvent.press(getByLabelText(/Tap to manage pending uploads/));
    fireEvent.press(getByLabelText("Retry now"));

    expect(retrySync).toHaveBeenCalledTimes(1);
    expect(retrySync).toHaveBeenCalledWith("item-1");
  });

  it('"Discard" calls discardSync with the item id', () => {
    const discardSync = vi.fn();
    setMockAppState({
      pendingSyncCount: 1,
      stuckSyncItems: [stuckPhoto("item-9")],
      retrySync: vi.fn(),
      discardSync,
    });

    const { getByLabelText } = render(<PendingSyncBanner />);
    fireEvent.press(getByLabelText(/Tap to manage pending uploads/));
    fireEvent.press(getByLabelText("Discard"));

    expect(discardSync).toHaveBeenCalledTimes(1);
    expect(discardSync).toHaveBeenCalledWith("item-9");
  });

  it("clears the banner after the queue drains", () => {
    setMockAppState({
      pendingSyncCount: 1,
      stuckSyncItems: [stuckPhoto("a")],
      retrySync: vi.fn(),
      discardSync: vi.fn(),
    });

    const { queryByText, rerender } = render(<PendingSyncBanner />);
    expect(queryByText("1 attachment still uploading")).toBeTruthy();

    // Queue drains (e.g. uploads recovered) → pendingSyncCount goes to 0.
    setMockAppState({
      pendingSyncCount: 0,
      stuckSyncItems: [],
      retrySync: vi.fn(),
      discardSync: vi.fn(),
    });
    rerender(<PendingSyncBanner />);

    expect(queryByText(/still uploading/)).toBeNull();
  });
});
