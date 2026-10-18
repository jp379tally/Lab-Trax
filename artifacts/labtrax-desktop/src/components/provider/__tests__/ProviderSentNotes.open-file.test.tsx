/** @vitest-environment jsdom */
/**
 * A provider can re-open a file they already sent to the lab from the Sent
 * list, instead of re-sending it or phoning the lab.
 *
 * The invariants enforced here:
 *   1. The file name is a real control that fetches the bytes through the
 *      authenticated media API (authedMediaFetch against /lab-inbox/:id/file).
 *   2. The fetched blob opens in the shared preview window — the same one the
 *      lab's Unassigned Documents card uses — never an automatic download.
 *   3. An entry with no file stays plain text: no button, no dead affordance.
 *   4. A failed fetch surfaces a toast and opens nothing.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor as rtlWaitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ASYNC_UI_TIMEOUT = 15_000;

function waitFor<T>(cb: () => T | Promise<T>): Promise<T> {
  return rtlWaitFor(cb, { timeout: ASYNC_UI_TIMEOUT });
}

// ---- api layer mock: observe exactly which URL is fetched, no real network.
const apiFetch = vi.fn();
const authedMediaFetch = vi.fn();

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  apiUrl: (path: string) => `/api${path}`,
  getProviderOrganizationId: () => "fixture-practice",
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  authedMediaFetch: (...args: unknown[]) => authedMediaFetch(...args),
}));

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  toast: (...args: unknown[]) => toast(...args),
}));

const openFilePreviewWindow = vi.fn();
vi.mock("@/lib/file-preview", () => ({
  openFilePreviewWindow: (...args: unknown[]) => openFilePreviewWindow(...args),
}));

import { ProviderSentNotes } from "../ProviderSentNotes";

const LAB_ORG_ID = "lab_org_1";
const BLOB_URL = "blob:labtrax/provider-sent-preview";

type SentEntry = {
  id: string;
  note: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  linkedCaseIds: string | null;
  createdAt: string;
};

function makeEntry(overrides: Partial<SentEntry> = {}): SentEntry {
  return {
    id: "sent_1",
    note: "New Rx attached",
    originalFilename: "rx-slip.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2048,
    linkedCaseIds: null,
    createdAt: "2026-02-01T10:00:00.000Z",
    ...overrides,
  };
}

function renderSent() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProviderSentNotes labOrganizationId={LAB_ORG_ID} labName="Acme Dental" />
    </QueryClientProvider>,
  );
}

let origCreate: typeof URL.createObjectURL | undefined;
let origRevoke: typeof URL.revokeObjectURL | undefined;

beforeEach(() => {
  apiFetch.mockReset();
  authedMediaFetch.mockReset();
  openFilePreviewWindow.mockReset();
  toast.mockReset();

  origCreate = URL.createObjectURL;
  origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => BLOB_URL) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
});

afterEach(() => {
  URL.createObjectURL = origCreate as typeof URL.createObjectURL;
  URL.revokeObjectURL = origRevoke as typeof URL.revokeObjectURL;
});

describe("ProviderSentNotes — opening a file the provider already sent", () => {
  it("fetches the file through the authenticated media API and previews it", async () => {
    const entry = makeEntry();
    apiFetch.mockResolvedValue([entry]);
    authedMediaFetch.mockResolvedValue(
      new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 }),
    );

    renderSent();
    const btn = await screen.findByRole(
      "button",
      { name: /rx-slip\.pdf/ },
      { timeout: ASYNC_UI_TIMEOUT },
    );
    fireEvent.click(btn);

    await waitFor(() => expect(authedMediaFetch).toHaveBeenCalledTimes(1));
    expect(authedMediaFetch.mock.calls[0]?.[0]).toBe(
      `/api/lab-inbox/${entry.id}/file`,
    );

    await waitFor(() => expect(openFilePreviewWindow).toHaveBeenCalledTimes(1));
    expect(openFilePreviewWindow.mock.calls[0]).toEqual([
      BLOB_URL,
      "application/pdf",
      "rx-slip.pdf",
    ]);
    expect(toast).not.toHaveBeenCalled();
  });

  it("leaves a note-only entry as plain text with nothing to click", async () => {
    apiFetch.mockResolvedValue([
      makeEntry({
        id: "sent_note",
        note: "Please check the shade",
        originalFilename: null,
        mimeType: null,
        sizeBytes: null,
      }),
    ]);

    renderSent();
    await screen.findByText("Please check the shade", undefined, {
      timeout: ASYNC_UI_TIMEOUT,
    });

    // The only buttons on screen belong to the composer, never the entry.
    expect(screen.queryByTitle(/^Open /)).toBeNull();
    expect(authedMediaFetch).not.toHaveBeenCalled();
  });

  it("surfaces a toast and previews nothing when the fetch fails", async () => {
    apiFetch.mockResolvedValue([makeEntry()]);
    authedMediaFetch.mockResolvedValue(new Response("", { status: 403 }));

    renderSent();
    const btn = await screen.findByRole(
      "button",
      { name: /rx-slip\.pdf/ },
      { timeout: ASYNC_UI_TIMEOUT },
    );
    fireEvent.click(btn);

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Could not open file",
          variant: "destructive",
        }),
      ),
    );
    expect(openFilePreviewWindow).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
