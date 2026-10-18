/** @vitest-environment jsdom */
/**
 * Exception case action on the desktop case overview.
 *
 * Covers the three behaviours the workflow depends on:
 *   1. The control beside the patient name flips between "flag" and "open"
 *      depending on whether the case already has an active exception, so a
 *      case can never be double-flagged from the UI (the server 409 is the
 *      real guard, and its message is surfaced).
 *   2. Resolution is owner/admin only — the resolve form renders only when
 *      the server reports `viewerCanResolve`, and moving is optional.
 *   3. Every mutation refreshes the dashboard queue, the case list and the
 *      case detail, so the queue can't go stale after a create/note/resolve.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
  // Declared inside the factory: `vi.mock` is hoisted above module-scope
  // declarations, so a top-level class here would be in its TDZ.
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  apiUrl: (path: string) => `/api${path}`,
  getAccessToken: () => "test-access-token",
  getApiOrigin: () => "http://api.test",
}));

vi.mock("@/lib/upload-media-file", () => ({
  uploadMediaFile: vi
    .fn()
    .mockResolvedValue({ url: "/uploads/case-media/x.jpg" }),
}));

// AuthedMedia mounts an authenticated fetch on render; the exception dialog
// only needs to prove it routes attachments through it.
vi.mock("@/components/AuthedMedia", () => ({
  AuthedImage: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

import { ApiError } from "@/lib/api";
import { uploadMediaFile } from "@/lib/upload-media-file";
import {
  CaseExceptionAction,
  EXCEPTION_DESTINATION_LOCATIONS_QUERY_KEY,
  EXCEPTION_FILE_INPUT_CLASS,
} from "../CaseExceptionAction";
import { EXCEPTION_QUEUE_QUERY_KEY } from "../ExceptionCasesCard";
import { makeQueryClient, makeWrapper } from "../../__tests__/test-utils";
import type { CaseExceptionDetail, CaseExceptionSummary } from "@/lib/types";

const CASE_ID = "case_1";
const LAB_ID = "lab_1";
const EXCEPTION_ID = "exc_1";

let getUserMedia = vi.fn();
function summary(
  overrides: Partial<CaseExceptionSummary> = {},
): CaseExceptionSummary {
  return {
    id: EXCEPTION_ID,
    labOrganizationId: LAB_ID,
    caseId: CASE_ID,
    caseKind: "canonical",
    status: "active",
    issueText: "Margin is short",
    createdByUserId: "user_1",
    createdByName: "Tina Tech",
    createdAt: new Date().toISOString(),
    resolvedByUserId: null,
    resolvedByName: null,
    resolvedAt: null,
    resolutionNote: null,
    resolutionLabLocationId: null,
    resolutionStatus: null,
    previousStatus: "in_design",
    currentLocationId: "loc_hold",
    currentLocationName: "On Hold",
    currentLocationStatus: "on_hold",
    ...overrides,
  } as CaseExceptionSummary;
}

function detail(
  overrides: Partial<CaseExceptionDetail> = {},
): CaseExceptionDetail {
  return {
    ...summary(),
    notes: [],
    attachments: [],
    history: [
      {
        type: "opened",
        occurredAt: new Date().toISOString(),
        actorName: "Tina Tech",
        detail: "Margin is short",
      },
    ],
    viewerCanResolve: false,
    ...overrides,
  } as CaseExceptionDetail;
}

const LOCATIONS = [
  { id: "loc_design", name: "Design", status: "in_design" },
  { id: "loc_qc", name: "QC", status: "qc" },
];

function renderAction(
  activeException: CaseExceptionSummary | null,
  queryClient = makeQueryClient(),
) {
  const Wrapper = makeWrapper("/cases", queryClient);
  return render(
    <Wrapper>
      <CaseExceptionAction
        caseId={CASE_ID}
        labOrganizationId={LAB_ID}
        activeException={activeException}
      />
    </Wrapper>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  vi.mocked(uploadMediaFile).mockClear();
  stubDictationMedia();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CaseExceptionAction — flagging", () => {
  it("uses the shared bordered primary button treatment for both exception states", () => {
    const sharedClasses = [
      "h-8",
      "min-w-32",
      "border",
      "border-primary",
      "bg-primary",
      "text-primary-foreground",
    ];

    const { unmount } = renderAction(null);

    expect(screen.getByTestId("case-exception-create")).toHaveClass(
      ...sharedClasses,
    );
    unmount();

    renderAction(summary());
    expect(screen.getByTestId("case-exception-open")).toHaveClass(
      ...sharedClasses,
    );
  });

  it("renders the reference hierarchy and selectable production-status cards", () => {
    renderAction(null);
    fireEvent.click(screen.getByTestId("case-exception-create"));

    expect(screen.getByTestId("case-exception-create-header")).toBeTruthy();
    expect(screen.getByTestId("case-exception-create-left-column")).toBeTruthy();
    expect(screen.getByTestId("case-exception-create-right-column")).toBeTruthy();
    expect(screen.getByTestId("case-exception-create-footer")).toBeTruthy();
    expect(screen.getByText("Issue Details")).toBeTruthy();
    expect(screen.getByText("Photos & Files")).toBeTruthy();
    expect(screen.getByText("Production Status")).toBeTruthy();
    expect(screen.getByText("Current Location")).toBeTruthy();

    const keepActive = screen.getByTestId("case-exception-put-on-hold-no");
    const placeOnHold = screen.getByTestId("case-exception-put-on-hold-yes");
    expect(keepActive).toHaveTextContent("Keep Active");
    expect(placeOnHold).toHaveTextContent("Place on Hold");
    expect(keepActive).toHaveAttribute("aria-pressed", "false");
    expect(placeOnHold).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("case-exception-create-submit")).toBeDisabled();

    fireEvent.click(placeOnHold);
    expect(placeOnHold).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("case-exception-create-submit")).not.toBeDisabled();

    fireEvent.click(keepActive);
    expect(keepActive).toHaveAttribute("aria-pressed", "true");
    expect(placeOnHold).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("case-exception-create-submit")).toBeDisabled();
  });

  it("selects multiple files and uploads them against the created exception", async () => {
    apiFetch.mockImplementation(async (path: string) => {
      if (path === "/case-exceptions") return summary();
      if (path === `/cases/${CASE_ID}/attachments`) return { id: "attachment" };
      throw new Error(`unexpected ${path}`);
    });

    renderAction(null);
    fireEvent.click(screen.getByTestId("case-exception-create"));

    const input = screen.getByTestId("case-exception-file-input");
    expect(input).toHaveClass(...EXCEPTION_FILE_INPUT_CLASS.split(" "));
    expect(input).toHaveAttribute("multiple");

    fireEvent.change(input, {
      target: {
        files: [
          new File(["photo"], "photo.jpg", { type: "image/jpeg" }),
          new File(["notes"], "notes.txt", { type: "text/plain" }),
        ],
      },
    });

    expect(screen.getByText("2 files selected")).toBeTruthy();
    fireEvent.click(screen.getByTestId("case-exception-put-on-hold-yes"));
    fireEvent.click(screen.getByTestId("case-exception-create-submit"));

    await waitFor(() =>
      expect(screen.queryByTestId("case-exception-create-dialog")).toBeNull(),
    );
    expect(uploadMediaFile).toHaveBeenCalledTimes(2);
    expect(apiFetch).toHaveBeenCalledWith(
      `/cases/${CASE_ID}/attachments`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          storageKey: "/uploads/case-media/x.jpg",
          fileName: "photo.jpg",
          fileType: "image/jpeg",
          caseExceptionId: EXCEPTION_ID,
        }),
      }),
    );
    expect(apiFetch).toHaveBeenCalledWith(
      `/cases/${CASE_ID}/attachments`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          storageKey: "/uploads/case-media/x.jpg",
          fileName: "notes.txt",
          fileType: "text/plain",
          caseExceptionId: EXCEPTION_ID,
        }),
      }),
    );
  });

  it("flags the case with the optional issue text and closes", async () => {
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    apiFetch.mockImplementation(async (path: string) => {
      if (path === "/case-exceptions") return summary();
      throw new Error(`unexpected ${path}`);
    });

    renderAction(null, queryClient);
    fireEvent.click(screen.getByTestId("case-exception-create"));
    fireEvent.change(screen.getByTestId("case-exception-issue-input"), {
      target: { value: "Contact too tight" },
    });
    fireEvent.click(screen.getByTestId("case-exception-put-on-hold-yes"));
    fireEvent.click(screen.getByTestId("case-exception-create-submit"));

    await waitFor(() =>
      expect(screen.queryByTestId("case-exception-create-dialog")).toBeNull(),
    );
    expect(apiFetch).toHaveBeenCalledWith(
      "/case-exceptions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          caseId: CASE_ID,
          putOnHold: true,
          issueText: "Contact too tight",
        }),
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: EXCEPTION_QUEUE_QUERY_KEY,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cases"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["case", CASE_ID] });
  });

  it("surfaces the server's duplicate-exception rejection", async () => {
    apiFetch.mockRejectedValue(
      new ApiError("This case already has an active exception.", 409),
    );

    renderAction(null);
    fireEvent.click(screen.getByTestId("case-exception-create"));
    fireEvent.click(screen.getByTestId("case-exception-put-on-hold-yes"));
    fireEvent.click(screen.getByTestId("case-exception-create-submit"));

    await waitFor(() =>
      expect(
        screen.getByTestId("case-exception-create-error").textContent,
      ).toContain("already has an active exception"),
    );
    // The dialog stays open so the user sees why nothing happened.
    expect(screen.getByTestId("case-exception-create-dialog")).toBeTruthy();
  });

  it("shows the open-exception control instead of the flag control once flagged", () => {
    apiFetch.mockResolvedValue(detail());
    renderAction(summary());
    expect(screen.getByTestId("case-exception-open")).toBeTruthy();
    expect(screen.queryByTestId("case-exception-create")).toBeNull();
  });

  it("requires an active location when the case is not put on hold", async () => {
    apiFetch.mockImplementation(async (path: string) => {
      if (path.startsWith("/locations")) return LOCATIONS;
      if (path === "/case-exceptions") return summary();
      throw new Error(`unexpected ${path}`);
    });

    renderAction(null);
    fireEvent.click(screen.getByTestId("case-exception-create"));
    fireEvent.click(screen.getByTestId("case-exception-put-on-hold-no"));

    await waitFor(() =>
      expect(
        (
          screen.getByTestId(
            "case-exception-create-location-select",
          ) as HTMLSelectElement
        ).options.length,
      ).toBe(LOCATIONS.length + 1),
    );
    expect(screen.getByTestId("case-exception-create-submit")).toBeDisabled();
    fireEvent.change(
      screen.getByTestId("case-exception-create-location-select"),
      {
        target: { value: "loc_qc" },
      },
    );
    fireEvent.click(screen.getByTestId("case-exception-create-submit"));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/case-exceptions",
        expect.objectContaining({
          body: JSON.stringify({
            caseId: CASE_ID,
            putOnHold: false,
            labLocationId: "loc_qc",
          }),
        }),
      ),
    );
  });

  it("shows a retryable active-location error for the non-hold path", async () => {
    let attempts = 0;
    apiFetch.mockImplementation(async (path: string) => {
      if (!path.startsWith("/locations")) throw new Error(`unexpected ${path}`);
      attempts += 1;
      if (attempts === 1) throw new Error("locations unavailable");
      return LOCATIONS;
    });

    renderAction(null);
    fireEvent.click(screen.getByTestId("case-exception-create"));
    fireEvent.click(screen.getByTestId("case-exception-put-on-hold-no"));

    await waitFor(() =>
      expect(
        screen.getByTestId("case-exception-create-location-error"),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("case-exception-create-location-retry"));
    await waitFor(() =>
      expect(
        (
          screen.getByTestId(
            "case-exception-create-location-select",
          ) as HTMLSelectElement
        ).options.length,
      ).toBe(LOCATIONS.length + 1),
    );
  });
});

describe("CaseExceptionAction — detail and resolution", () => {
  function mockDetail(d: CaseExceptionDetail) {
    apiFetch.mockImplementation(async (path: string) => {
      if (path === `/case-exceptions/${EXCEPTION_ID}`) return d;
      if (path.startsWith("/locations")) return LOCATIONS;
      if (path === `/case-exceptions/${EXCEPTION_ID}/notes`)
        return { id: "n1" };
      if (path === `/case-exceptions/${EXCEPTION_ID}/resolve`)
        return summary({ status: "resolved" });
      throw new Error(`unexpected ${path}`);
    });
  }

  it("shows the issue, past notes in history, attachments and history to a non-admin but hides the resolve form", async () => {
    mockDetail(
      detail({
        notes: [
          {
            id: "note_1",
            caseExceptionId: EXCEPTION_ID,
            authorUserId: "user_2",
            authorName: "Olive Owner",
            noteText: "Model re-poured",
            createdAt: new Date().toISOString(),
          },
        ],
        history: [
          {
            type: "opened",
            occurredAt: new Date().toISOString(),
            actorName: "Tina Tech",
            detail: "Margin is short",
          },
          {
            type: "note_added",
            occurredAt: new Date().toISOString(),
            actorName: "Olive Owner",
            detail: "Model re-poured",
          },
        ],
        attachments: [
          {
            id: "att_1",
            fileName: "photo.jpg",
            fileType: "image/jpeg",
            createdAt: new Date().toISOString(),
            uploaderName: "Tina Tech",
          },
        ],
        viewerCanResolve: false,
      } as Partial<CaseExceptionDetail>),
    );

    renderAction(summary());
    fireEvent.click(screen.getByTestId("case-exception-open"));

    await waitFor(() =>
      expect(screen.getByText("Margin is short")).toBeTruthy(),
    );
    expect(screen.getByTestId("case-exception-conversation")).toBeTruthy();
    expect(
      screen.getByTestId("case-exception-conversation-note-note_1").textContent,
    ).toContain("Olive Owner");
    expect(
      screen.getByText(/note added.*Olive Owner.*Model re-poured/),
    ).toBeTruthy();
    expect(screen.getByTestId("case-exception-attachment-att_1")).toBeTruthy();
    expect(screen.getByTestId("case-exception-detail-file-input")).toHaveClass(
      ...EXCEPTION_FILE_INPUT_CLASS.split(" "),
      "mt-2",
    );
    expect(
      screen.getByTestId("case-exception-detail-file-input"),
    ).toHaveAttribute("multiple");
    expect(screen.getByTestId("case-exception-resolve-denied")).toBeTruthy();
    expect(screen.queryByTestId("case-exception-resolve-form")).toBeNull();
  });

  it("shows the current location and lets an owner/admin resolve without moving", async () => {
    mockDetail(detail({ viewerCanResolve: true }));

    renderAction(summary());
    fireEvent.click(screen.getByTestId("case-exception-open"));

    await waitFor(() =>
      expect(screen.getByTestId("case-exception-resolve-form")).toBeTruthy(),
    );

    const submit = screen.getByTestId(
      "case-exception-resolve-submit",
    ) as HTMLButtonElement;
    expect(
      screen.getByTestId("case-exception-current-location").textContent,
    ).toContain("On Hold");
    expect(screen.getByText("Move case to (optional)")).toBeTruthy();
    // The note is required, so the button starts disabled.
    expect(submit.disabled).toBe(true);

    await waitFor(() =>
      expect(
        (
          screen.getByTestId(
            "case-exception-destination-select",
          ) as HTMLSelectElement
        ).options.length,
      ).toBe(LOCATIONS.length + 1),
    );

    fireEvent.change(screen.getByTestId("case-exception-resolution-note"), {
      target: { value: "Adjusted and re-polished" },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        `/case-exceptions/${EXCEPTION_ID}/resolve`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            resolutionNote: "Adjusted and re-polished",
          }),
        }),
      ),
    );
    // The dialog closes so the (now stale) exception view can't be acted on.
    await waitFor(() =>
      expect(screen.queryByTestId("case-exception-detail-dialog")).toBeNull(),
    );
  });

  it("keeps named destinations when the case drawer cache has a transformed location shape", async () => {
    mockDetail(detail({ viewerCanResolve: true }));

    const queryClient = makeQueryClient();
    queryClient.setQueryData(
      ["locations", LAB_ID, "active"],
      [{ id: "drawer_loc", value: "qc", label: "Drawer QC" }],
    );
    const Wrapper = makeWrapper("/cases", queryClient);

    render(
      <Wrapper>
        <CaseExceptionAction
          caseId={CASE_ID}
          labOrganizationId={LAB_ID}
          activeException={summary()}
        />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("case-exception-open"));

    await waitFor(() => expect(screen.getByText("Design")).toBeTruthy());
    expect(screen.getByText("QC")).toBeTruthy();
    expect(
      queryClient.getQueryData([
        ...EXCEPTION_DESTINATION_LOCATIONS_QUERY_KEY,
        LAB_ID,
      ]),
    ).toEqual(LOCATIONS);

    fireEvent.change(screen.getByTestId("case-exception-destination-select"), {
      target: { value: "loc_qc" },
    });
    fireEvent.change(screen.getByTestId("case-exception-resolution-note"), {
      target: { value: "Sent to QC" },
    });
    fireEvent.click(screen.getByTestId("case-exception-resolve-submit"));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        `/case-exceptions/${EXCEPTION_ID}/resolve`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            labLocationId: "loc_qc",
            resolutionNote: "Sent to QC",
          }),
        }),
      ),
    );
  });

  it("still allows no-move resolution while destination locations fail to load and retries in the dialog", async () => {
    let locationAttempts = 0;
    apiFetch.mockImplementation(async (path: string) => {
      if (path === `/case-exceptions/${EXCEPTION_ID}`) {
        return detail({ viewerCanResolve: true });
      }
      if (path.startsWith("/locations")) {
        locationAttempts += 1;
        if (locationAttempts === 1) {
          throw new Error("locations unavailable");
        }
        return LOCATIONS;
      }
      throw new Error(`unexpected ${path}`);
    });

    renderAction(summary());
    fireEvent.click(screen.getByTestId("case-exception-open"));

    await waitFor(() =>
      expect(
        screen.getByTestId("case-exception-destination-error"),
      ).toBeTruthy(),
    );
    expect(
      (
        screen.getByTestId(
          "case-exception-destination-select",
        ) as HTMLSelectElement
      ).disabled,
    ).toBe(true);
    // A failed destination load must not block a no-move resolution: with the
    // required note filled in, the button is still live.
    fireEvent.change(screen.getByTestId("case-exception-resolution-note"), {
      target: { value: "Resolved in place" },
    });
    expect(
      (screen.getByTestId("case-exception-resolve-submit") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByTestId("case-exception-destination-retry"));
    await waitFor(() => expect(screen.getByText("Design")).toBeTruthy());
    expect(
      (
        screen.getByTestId(
          "case-exception-destination-select",
        ) as HTMLSelectElement
      ).disabled,
    ).toBe(false);
  });

  it("communicates a loading destination request without blocking no-move resolution", async () => {
    let resolveLocations: (locations: typeof LOCATIONS) => void = () => {};
    apiFetch.mockImplementation(async (path: string) => {
      if (path === `/case-exceptions/${EXCEPTION_ID}`) {
        return detail({ viewerCanResolve: true });
      }
      if (path.startsWith("/locations")) {
        return new Promise<typeof LOCATIONS>((resolve) => {
          resolveLocations = resolve;
        });
      }
      throw new Error(`unexpected ${path}`);
    });

    renderAction(summary());
    fireEvent.click(screen.getByTestId("case-exception-open"));

    await waitFor(() =>
      expect(
        screen.getByTestId("case-exception-destination-loading"),
      ).toBeTruthy(),
    );
    expect(
      (
        screen.getByTestId(
          "case-exception-destination-select",
        ) as HTMLSelectElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByTestId("case-exception-resolution-note"), {
      target: { value: "Resolved in place" },
    });
    expect(
      (screen.getByTestId("case-exception-resolve-submit") as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    resolveLocations(LOCATIONS);
    await waitFor(() =>
      expect(
        (
          screen.getByTestId(
            "case-exception-destination-select",
          ) as HTMLSelectElement
        ).disabled,
      ).toBe(false),
    );
  });

  it("explains when a lab has no active destination locations without blocking no-move resolution", async () => {
    apiFetch.mockImplementation(async (path: string) => {
      if (path === `/case-exceptions/${EXCEPTION_ID}`) {
        return detail({ viewerCanResolve: true });
      }
      if (path.startsWith("/locations")) return [];
      throw new Error(`unexpected ${path}`);
    });

    renderAction(summary());
    fireEvent.click(screen.getByTestId("case-exception-open"));

    await waitFor(() =>
      expect(
        screen.getByTestId("case-exception-destination-empty"),
      ).toBeTruthy(),
    );
    fireEvent.change(screen.getByTestId("case-exception-resolution-note"), {
      target: { value: "Resolved in place" },
    });
    expect(
      (screen.getByTestId("case-exception-resolve-submit") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("explains when the case has no lab scope for destination locations", async () => {
    apiFetch.mockResolvedValue(detail({ viewerCanResolve: true }));
    const Wrapper = makeWrapper("/cases");
    render(
      <Wrapper>
        <CaseExceptionAction
          caseId={CASE_ID}
          labOrganizationId={null}
          activeException={summary()}
        />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("case-exception-open"));

    await waitFor(() =>
      expect(
        screen.getByTestId("case-exception-destination-unavailable"),
      ).toBeTruthy(),
    );
    expect(
      (
        screen.getByTestId(
          "case-exception-destination-select",
        ) as HTMLSelectElement
      ).disabled,
    ).toBe(true);
  });

  it("shows the oldest-first conversation and lets any active member add a note", async () => {
    const noteText = "Waiting on articulation";
    const older = "First follow-up";
    const newer = "Second follow-up";
    mockDetail(
      detail({
        viewerCanResolve: false,
        notes: [
          {
            id: "note_new",
            caseExceptionId: EXCEPTION_ID,
            authorUserId: "user_2",
            authorName: "Olive Owner",
            noteText: newer,
            createdAt: "2026-09-04T12:00:00.000Z",
          },
          {
            id: "note_old",
            caseExceptionId: EXCEPTION_ID,
            authorUserId: "user_1",
            authorName: "Tina Tech",
            noteText: older,
            createdAt: "2026-09-04T10:00:00.000Z",
          },
        ],
        history: [
          {
            type: "opened",
            occurredAt: new Date().toISOString(),
            actorName: "Tina Tech",
            detail: "Margin is short",
          },
          {
            type: "note_added",
            occurredAt: new Date().toISOString(),
            actorName: "Olive Owner",
            detail: noteText,
          },
        ],
      } as Partial<CaseExceptionDetail>),
    );

    renderAction(summary());
    fireEvent.click(screen.getByTestId("case-exception-open"));

    await waitFor(() =>
      expect(screen.getByTestId("case-exception-conversation")).toBeTruthy(),
    );
    const conversation = screen.getByTestId("case-exception-conversation");
    expect(conversation.textContent!.indexOf("Margin is short")).toBeLessThan(
      conversation.textContent!.indexOf(older),
    );
    expect(conversation.textContent!.indexOf(older)).toBeLessThan(
      conversation.textContent!.indexOf(newer),
    );
    const input = screen.getByTestId(
      "case-exception-note-input",
    ) as HTMLTextAreaElement;
    const submit = screen.getByTestId(
      "case-exception-note-submit",
    ) as HTMLButtonElement;
    expect(input.placeholder).toBe("Add additional exception notes.");
    expect(submit.textContent).toContain("Submit additional notes");
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: noteText } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        `/case-exceptions/${EXCEPTION_ID}/notes`,
        {
          method: "POST",
          body: JSON.stringify({ noteText }),
        },
      ),
    );
    await waitFor(() => expect(input.value).toBe(""));
    expect(screen.getByTestId("case-exception-detail-file-input")).toBeTruthy();
  });

  it("preserves an additional note after a failed submission", async () => {
    const noteText = "Keep this note for retry";
    mockDetail(detail());
    apiFetch.mockImplementation(async (path: string) => {
      if (path === `/case-exceptions/${EXCEPTION_ID}`) return detail();
      if (path === `/case-exceptions/${EXCEPTION_ID}/notes`)
        throw new Error("Notes are temporarily unavailable");
      throw new Error(`unexpected ${path}`);
    });
    renderAction(summary());
    fireEvent.click(screen.getByTestId("case-exception-open"));
    const input = await screen.findByTestId("case-exception-note-input");
    fireEvent.change(input, { target: { value: noteText } });
    fireEvent.click(screen.getByTestId("case-exception-note-submit"));
    await waitFor(() =>
      expect(screen.getByText("Notes are temporarily unavailable")).toBeTruthy(),
    );
    expect((input as HTMLTextAreaElement).value).toBe(noteText);
  });

  it("appends dictated follow-up text without submitting the note", async () => {
    mockDetail(detail());
    sttFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ transcript: "Occlusion checked again." }),
    });
    renderAction(summary());
    fireEvent.click(screen.getByTestId("case-exception-open"));
    const input = (await screen.findByTestId(
      "case-exception-note-input",
    )) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Typed first." } });
    fireEvent.click(
      screen.getByLabelText("Dictate additional exception note"),
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText("Stop recording additional exception note"),
      ).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByLabelText("Stop recording additional exception note"),
    );
    await waitFor(() =>
      expect(input.value).toBe("Typed first.\nOcclusion checked again."),
    );
    expect(apiFetch).not.toHaveBeenCalledWith(
      `/case-exceptions/${EXCEPTION_ID}/notes`,
      expect.anything(),
    );
  });

  it("preserves a follow-up draft when transcription fails", async () => {
    mockDetail(detail());
    sttFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Voice transcription is unavailable." }),
    });
    renderAction(summary());
    fireEvent.click(screen.getByTestId("case-exception-open"));
    const input = (await screen.findByTestId(
      "case-exception-note-input",
    )) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Keep this draft." } });
    fireEvent.click(
      screen.getByLabelText("Dictate additional exception note"),
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText("Stop recording additional exception note"),
      ).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByLabelText("Stop recording additional exception note"),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("case-exception-note-dictation-error").textContent,
      ).toContain("unavailable"),
    );
    expect(input.value).toBe("Keep this draft.");
  });

  it("stops follow-up recording when the detail dialog closes", async () => {
    mockDetail(detail());
    renderAction(summary());
    fireEvent.click(screen.getByTestId("case-exception-open"));
    await screen.findByTestId("case-exception-note-input");
    fireEvent.click(
      screen.getByLabelText("Dictate additional exception note"),
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText("Stop recording additional exception note"),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByLabelText("Close"));
    expect(recorderStop).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
  });

  it("does not show the additional-note composer after resolution", async () => {
    mockDetail(detail({ status: "resolved" }));
    renderAction(summary());
    fireEvent.click(screen.getByTestId("case-exception-open"));
    await screen.findByTestId("case-exception-conversation");
    expect(screen.queryByTestId("case-exception-note-input")).toBeNull();
    expect(screen.queryByTestId("case-exception-note-submit")).toBeNull();
  });

  it("keeps Resolve exception disabled until a non-blank resolution note is entered", async () => {
    mockDetail(detail({ viewerCanResolve: true }));

    renderAction(summary());
    fireEvent.click(screen.getByTestId("case-exception-open"));

    await waitFor(() =>
      expect(screen.getByTestId("case-exception-resolve-form")).toBeTruthy(),
    );
    const submit = screen.getByTestId(
      "case-exception-resolve-submit",
    ) as HTMLButtonElement;
    expect(screen.getByText("Resolution note (required)")).toBeTruthy();
    expect(submit.disabled).toBe(true);

    // Whitespace alone is still blank.
    fireEvent.change(screen.getByTestId("case-exception-resolution-note"), {
      target: { value: "   " },
    });
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("case-exception-resolution-note"), {
      target: { value: "Re-seated the margin" },
    });
    expect(submit.disabled).toBe(false);
  });
});

describe("exception queue key", () => {
  it("is the single shared key both the dashboard card and the action invalidate", () => {
    expect(EXCEPTION_QUEUE_QUERY_KEY).toEqual(["case-exceptions", "active"]);
  });
});

let recorderStart = vi.fn();

let trackStop = vi.fn();

function stubDictationMedia() {
  getUserMedia = vi.fn();
  recorderStart = vi.fn();
  recorderStop = vi.fn();
  trackStop = vi.fn();
  const stream = {
    getTracks: () => [{ stop: trackStop }],
  };
  getUserMedia.mockResolvedValue(stream);
  Object.defineProperty(window.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });

  class FakeMediaRecorder {
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    mimeType = "audio/webm";
    start = recorderStart;
    stop = () => {
      recorderStop();
      this.ondataavailable?.({ data: new Blob(["recorded issue"]) });
      queueMicrotask(() => this.onstop?.());
    };
  }
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder =
    FakeMediaRecorder;
  sttFetch = vi.fn();
  vi.stubGlobal("fetch", sttFetch);
}

let sttFetch = vi.fn();

let recorderStop = vi.fn();
