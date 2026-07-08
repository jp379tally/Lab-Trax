/** @vitest-environment jsdom */
/**
 * Regression guard: the Unassigned Documents card opens a proper in-app
 * preview window instead of triggering an unwanted download or a red error.
 *
 * `openFilePreviewWindow()` in UnassignedDocumentsCard.tsx renders:
 *   - PDFs in an <iframe>
 *   - images in an <img>
 *   - every other type on a fallback page with an explicit Download button
 * and falls back gracefully when the popup is blocked.
 *
 * The invariants enforced here:
 *   1. Clicking View fetches the file through the authenticated media API
 *      (authedMediaFetch against /lab-inbox/:id/file) — never a plain fetch.
 *   2. The preview document embeds the blob object URL via the markup that
 *      matches the mime type (iframe for PDF, img for images).
 *   3. Unsupported types show a Download-button fallback page instead of
 *      auto-downloading.
 *   4. A blocked popup falls back to opening the blob URL directly — no
 *      crash, no document.write into a null handle.
 *   5. A failed fetch surfaces a toast, opens nothing, and leaves no blob URL.
 *
 * Keep this test permanently per the REGRESSION_GUARDRAILS.md policy.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// ---- api layer mock: observe exactly which URL is fetched, no real network.
const authedMediaFetch = vi.fn();
const apiFetch = vi.fn();
const authedFetch = vi.fn();
const createUploadSession = vi.fn();
const sendUploadChunk = vi.fn();

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  apiUrl: (path: string) => `/api${path}`,
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  authedFetch: (...args: unknown[]) => authedFetch(...args),
  authedMediaFetch: (...args: unknown[]) => authedMediaFetch(...args),
  createUploadSession: (...args: unknown[]) => createUploadSession(...args),
  sendUploadChunk: (...args: unknown[]) => sendUploadChunk(...args),
}));

// ---- toast mock: assert error surfacing without mounting a toast container.
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  toast: (...args: unknown[]) => toast(...args),
}));

// ---- generated API hooks mock: feed the card a fixed file list, no network.
import type { LabInboxFile } from "@workspace/api-client-react";

let inboxFiles: LabInboxFile[] = [];

vi.mock("@workspace/api-client-react", () => ({
  useListLabInboxFiles: () => ({
    data: { ok: true, data: inboxFiles },
    isLoading: false,
  }),
  useAssignLabInboxFile: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteLabInboxFile: () => ({ mutate: vi.fn(), isPending: false }),
  useBulkDeleteLabInboxFiles: () => ({ mutate: vi.fn(), isPending: false }),
  getListLabInboxFilesQueryKey: (params: unknown) => [
    "lab-inbox-files",
    params,
  ],
}));

import { UnassignedDocumentsCard } from "../UnassignedDocumentsCard";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import type { AuthContextValue } from "@/lib/auth-context";

const LAB_ORG_ID = "lab_org_1";
const BLOB_URL = "blob:labtrax/inbox-preview";

function makeFile(overrides: Partial<LabInboxFile>): LabInboxFile {
  return {
    id: "inbox_file_1",
    labOrganizationId: LAB_ORG_ID,
    uploadedByUserId: "user_1",
    originalFilename: "document.pdf",
    mimeType: "application/pdf",
    sizeBytes: 12345,
    storagePath: "lab-inbox/document.pdf",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    uploaderFirstName: "Ann",
    uploaderLastName: "Tech",
    ...overrides,
  } as LabInboxFile;
}

function renderCard() {
  const Wrapper = makeAuthWrapper("/", {
    status: "authed",
    user: {
      id: "user_1",
      username: "labtech",
      role: "user",
      practiceOrganizationId: LAB_ORG_ID,
    } as unknown as AuthContextValue["user"],
  } as Partial<AuthContextValue>);
  return render(
    <Wrapper>
      <UnassignedDocumentsCard />
    </Wrapper>,
  );
}

/** Fake preview-window handle capturing what openFilePreviewWindow writes. */
function makePreviewWindow() {
  return {
    document: {
      write: vi.fn(),
      close: vi.fn(),
    },
  } as unknown as Window;
}

function writtenHtml(win: Window): string {
  const write = (win.document.write as unknown as ReturnType<typeof vi.fn>)
    .mock;
  return write.calls.map((c) => String(c[0])).join("");
}

const windowOpen = vi.fn();

let origCreate: typeof URL.createObjectURL | undefined;
let origRevoke: typeof URL.revokeObjectURL | undefined;

beforeEach(() => {
  authedMediaFetch.mockReset();
  toast.mockReset();
  windowOpen.mockReset();
  inboxFiles = [];

  vi.stubGlobal("open", windowOpen);

  // jsdom does not implement object URLs. Attach the mocks onto the real URL
  // constructor rather than replacing it, so `new URL(...)` keeps working.
  origCreate = URL.createObjectURL;
  origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => BLOB_URL) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  URL.createObjectURL = origCreate as typeof URL.createObjectURL;
  URL.revokeObjectURL = origRevoke as typeof URL.revokeObjectURL;
});

async function clickView(filename: string) {
  // The filename itself is a "Click to view" button; use it (the Eye icon
  // button triggers the same handleView).
  const btn = await screen.findByRole("button", {
    name: new RegExp(filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  });
  fireEvent.click(btn);
}

describe("UnassignedDocumentsCard — View opens an in-app preview window", () => {
  it("fetches the file via the authenticated media API and opens a preview window", async () => {
    const file = makeFile({ mimeType: "application/pdf" });
    inboxFiles = [file];
    authedMediaFetch.mockResolvedValue(
      new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 }),
    );
    windowOpen.mockReturnValue(makePreviewWindow());

    renderCard();
    await clickView(file.originalFilename);

    await waitFor(() => expect(authedMediaFetch).toHaveBeenCalledTimes(1));
    expect(authedMediaFetch.mock.calls[0]?.[0]).toBe(
      `/api/lab-inbox/${file.id}/file`,
    );

    // A preview window is opened blank first, then written to — never a
    // direct navigation that could trigger a download.
    await waitFor(() => expect(windowOpen).toHaveBeenCalledTimes(1));
    expect(windowOpen.mock.calls[0]).toEqual(["", "_blank"]);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it("renders PDFs in an <iframe> pointed at the blob URL", async () => {
    const file = makeFile({
      mimeType: "application/pdf",
      originalFilename: "rx-slip.pdf",
    });
    inboxFiles = [file];
    authedMediaFetch.mockResolvedValue(
      new Response(new Blob([new Uint8Array([1])]), { status: 200 }),
    );
    const win = makePreviewWindow();
    windowOpen.mockReturnValue(win);

    renderCard();
    await clickView(file.originalFilename);

    await waitFor(() => expect(win.document.write).toHaveBeenCalled());
    const html = writtenHtml(win);
    expect(html).toContain(`<iframe src="${BLOB_URL}"`);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("Download");
    expect(win.document.close).toHaveBeenCalled();
  });

  it("renders images in an <img> pointed at the blob URL", async () => {
    const file = makeFile({
      mimeType: "image/jpeg",
      originalFilename: "shade-photo.jpg",
    });
    inboxFiles = [file];
    authedMediaFetch.mockResolvedValue(
      new Response(new Blob([new Uint8Array([1])]), { status: 200 }),
    );
    const win = makePreviewWindow();
    windowOpen.mockReturnValue(win);

    renderCard();
    await clickView(file.originalFilename);

    await waitFor(() => expect(win.document.write).toHaveBeenCalled());
    const html = writtenHtml(win);
    expect(html).toContain(`<img src="${BLOB_URL}"`);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("Download");
  });

  it("shows an explicit Download-button fallback for unsupported types instead of auto-downloading", async () => {
    const file = makeFile({
      mimeType: "application/vnd.ms-excel",
      originalFilename: "billing.xls",
    });
    inboxFiles = [file];
    authedMediaFetch.mockResolvedValue(
      new Response(new Blob([new Uint8Array([1])]), { status: 200 }),
    );
    const win = makePreviewWindow();
    windowOpen.mockReturnValue(win);

    renderCard();
    await clickView(file.originalFilename);

    await waitFor(() => expect(win.document.write).toHaveBeenCalled());
    const html = writtenHtml(win);
    // Explicit user-triggered download link — not an iframe/img preview.
    expect(html).toContain(`href="${BLOB_URL}"`);
    expect(html).toContain(`download="billing.xls"`);
    expect(html).toContain(">Download</a>");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain(`<img src="${BLOB_URL}"`);
    // The window itself was opened blank — nothing auto-navigated to the blob.
    expect(windowOpen.mock.calls[0]).toEqual(["", "_blank"]);
  });

  it("falls back gracefully when the popup is blocked (no crash, opens the blob directly)", async () => {
    const file = makeFile({ mimeType: "application/pdf" });
    inboxFiles = [file];
    authedMediaFetch.mockResolvedValue(
      new Response(new Blob([new Uint8Array([1])]), { status: 200 }),
    );
    // Popup blocked: window.open returns null for every call.
    windowOpen.mockReturnValue(null);

    renderCard();
    await clickView(file.originalFilename);

    // First attempt is the blank preview window; the fallback opens the blob
    // URL directly in a new tab.
    await waitFor(() => expect(windowOpen).toHaveBeenCalledTimes(2));
    expect(windowOpen.mock.calls[0]).toEqual(["", "_blank"]);
    expect(windowOpen.mock.calls[1]).toEqual([BLOB_URL, "_blank"]);
    // No crash → no error toast.
    expect(toast).not.toHaveBeenCalled();
  });

  it("surfaces a toast and opens nothing when the authenticated fetch fails", async () => {
    const file = makeFile({ mimeType: "application/pdf" });
    inboxFiles = [file];
    authedMediaFetch.mockResolvedValue(new Response("", { status: 401 }));
    windowOpen.mockReturnValue(makePreviewWindow());

    renderCard();
    await clickView(file.originalFilename);

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Could not open file",
          variant: "destructive",
        }),
      ),
    );
    expect(windowOpen).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
