import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react-native";
import { Alert, Platform, StyleSheet } from "react-native";
import * as Native from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resetMockAppState,
  resetMockFetchHandler,
  resetMockUploadHandler,
  mockInvalidateQueries,
  setMockAppState,
  setMockFetchHandler,
  setMockUploadHandler,
} from "../../../vitest.setup";

const {
  mockRequestPermissionsAsync,
  mockSetAudioModeAsync,
  mockRecordingCreateAsync,
  mockUploadAudioForTranscript,
  mockOpenAttachmentPreview,
  mockSaveImageToDevice,
} = vi.hoisted(() => ({
  mockRequestPermissionsAsync: vi.fn(),
  mockSetAudioModeAsync: vi.fn(),
  mockRecordingCreateAsync: vi.fn(),
  mockUploadAudioForTranscript: vi.fn(),
  mockOpenAttachmentPreview: vi.fn(),
  mockSaveImageToDevice: vi.fn(),
}));

vi.mock("expo-av", () => ({
  Audio: {
    requestPermissionsAsync: () => mockRequestPermissionsAsync(),
    setAudioModeAsync: (...args: unknown[]) => mockSetAudioModeAsync(...args),
    Recording: {
      createAsync: (...args: unknown[]) => mockRecordingCreateAsync(...args),
    },
    RecordingOptionsPresets: { HIGH_QUALITY: {} },
  },
}));

vi.mock("@/lib/audio-transcription", () => ({
  uploadAudioForTranscript: (...args: unknown[]) =>
    mockUploadAudioForTranscript(...args),
}));

vi.mock("@/lib/save-to-device", () => ({
  saveImageToDevice: (...args: unknown[]) => mockSaveImageToDevice(...args),
  saveDocumentToDevice: vi.fn(),
}));

vi.mock("@/lib/attachment-preview", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/attachment-preview")>();
  return {
    ...actual,
    openAttachmentPreview: (...args: unknown[]) =>
      mockOpenAttachmentPreview(...args),
  };
});

import {
  CaseExceptionCreateSheet,
  CaseExceptionDetailSheet,
} from "@/components/CaseExceptionSheet";

/**
 * Mobile exception create / detail sheets.
 *
 * The invariants that matter on mobile:
 *   - flagging posts to the canonical /api/case-exceptions endpoint with the
 *     optional issue text, and a 409 is reported as "already flagged" rather
 *     than a generic failure;
 *   - the detail sheet shows the issue, internal notes, media and history to
 *     any lab member;
 *   - the resolve controls only appear when the server says the viewer may
 *     resolve, and moving to a destination is optional;
 *   - the destination list comes from the lab's real /api/locations rows.
 */

const CASE_ID = "case_1";
const LAB_ID = "lab_1";
const EXCEPTION_ID = "exc_1";
const LOCATIONS = [
  {
    id: "loc_design",
    name: "Design",
    code: "DESIGN",
    status: "in_design",
    isActive: true,
    sortOrder: 10,
  },
  {
    id: "loc_qc",
    name: "QC",
    code: "QC",
    status: "qc",
    isActive: true,
    sortOrder: 20,
  },
];

function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: EXCEPTION_ID,
    labOrganizationId: LAB_ID,
    caseId: CASE_ID,
    caseKind: "canonical",
    status: "active",
    issueText: "Margin is short on #14",
    createdByUserId: "user_1",
    createdByName: "Tina Tech",
    createdAt: new Date().toISOString(),
    notes: [],
    attachments: [],
    history: [
      {
        type: "opened",
        occurredAt: new Date().toISOString(),
        actorName: "Tina Tech",
        detail: null,
      },
    ],
    viewerCanResolve: false,
    currentLocationId: "loc_hold",
    currentLocationName: "On Hold",
    currentLocationStatus: "on_hold",
    ...overrides,
  };
}

/** JSON envelope shaped like the server's `ok()` helper. */
function envelope(data: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => ({ ok: status < 400, data }),
  } as unknown as Response;
}

/** Error body shaped like the server's `fail()` helper. */
function errorEnvelope(status: number, message: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({ ok: false, error: { message } }),
  } as unknown as Response;
}

beforeEach(() => {
  resetMockAppState();
  resetMockFetchHandler();
  mockRequestPermissionsAsync.mockResolvedValue({
    status: "granted",
    granted: true,
  });
  mockSetAudioModeAsync.mockResolvedValue(undefined);
  mockRecordingCreateAsync.mockResolvedValue({
    recording: {
      stopAndUnloadAsync: vi.fn(async () => undefined),
      getURI: vi.fn(() => "file:///tmp/exception.m4a"),
    },
  });
  mockUploadAudioForTranscript.mockResolvedValue("");
  mockSaveImageToDevice.mockResolvedValue("saved");
});

afterEach(() => {
  cleanup();
  resetMockAppState();
  resetMockFetchHandler();
  resetMockUploadHandler();
  vi.clearAllMocks();
});

describe("CaseExceptionCreateSheet", () => {
  it("keeps the file picker and status labels wrapped at a 390-point phone width", async () => {
    const widthSpy = vi
      .spyOn(Native, "useWindowDimensions")
      .mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 });
    try {
      const { getByTestId, getByText } = await render(
        <CaseExceptionCreateSheet
          visible
          caseId={CASE_ID}
          labOrganizationId={LAB_ID}
          onClose={vi.fn()}
        />,
      );
      expect(
        StyleSheet.flatten(
          getByTestId("case-exception-create-columns").props.style,
        ).flexDirection,
      ).toBe("row");
      expect(
        StyleSheet.flatten(
          getByTestId("case-exception-create-picker-row").props.style,
        ).flexWrap,
      ).toBe("wrap");
      expect(
        StyleSheet.flatten(
          getByTestId("case-exception-put-on-hold-no-content").props.style,
        ).flexWrap,
      ).toBe("wrap");
      expect(
        StyleSheet.flatten(getByText("Keep Active").props.style).flexShrink,
      ).toBe(1);
      expect(getByTestId("case-exception-create-pick-file")).toBeTruthy();
    } finally {
      widthSpy.mockRestore();
    }
  });

  it("renders the centered two-column modal at phone dimensions and creates an on-hold case with optional issue text", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    setMockFetchHandler(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path.includes("/api/case-exceptions")) {
        return envelope({ id: EXCEPTION_ID, status: "active" }, 201);
      }
      return envelope(null);
    });
    const onClose = vi.fn();
    const { getByTestId, getByText } = await render(
      <CaseExceptionCreateSheet
        visible
        caseId={CASE_ID}
        labOrganizationId={LAB_ID}
        onClose={onClose}
      />,
    );
    expect(getByTestId("case-exception-create-header")).toBeTruthy();
    expect(getByTestId("case-exception-create-footer")).toBeTruthy();
    expect(getByTestId("case-exception-create-left-column")).toBeTruthy();
    expect(getByTestId("case-exception-create-right-column")).toBeTruthy();
    expect(
      StyleSheet.flatten(
        getByTestId("case-exception-create-columns").props.style,
      ).flexDirection,
    ).toBe("row");
    expect(
      StyleSheet.flatten(
        getByTestId("case-exception-create-picker-row").props.style,
      ).flexWrap,
    ).toBe("wrap");
    expect(
      StyleSheet.flatten(
        getByTestId("case-exception-put-on-hold-no-content").props.style,
      ).flexWrap,
    ).toBe("wrap");
    expect(StyleSheet.flatten(getByText("Keep Active").props.style).flexShrink).toBe(
      1,
    );
    expect(getByTestId("case-exception-create-pick-file")).toBeTruthy();
    expect(
      getByTestId("case-exception-put-on-hold-no").props.accessibilityState
        .selected,
    ).toBe(false);
    expect(
      getByTestId("case-exception-put-on-hold-yes").props.accessibilityState
        .selected,
    ).toBe(false);
    expect(getByText("Keep Active")).toBeTruthy();
    expect(getByText("Place on Hold")).toBeTruthy();
    expect(
      StyleSheet.flatten(getByTestId("case-exception-create-sheet").props.style)
        .height,
    ).toBeUndefined();
    expect(
      StyleSheet.flatten(
        getByTestId("case-exception-create-body-scroll").props.style,
      ).flex,
    ).toBeUndefined();
    expect(["interactive", "on-drag"]).toContain(
      getByTestId("case-exception-create-body-scroll").props
        .keyboardDismissMode,
    );
    await fireEvent.changeText(
      getByTestId("case-exception-issue-input"),
      "Contact too tight",
    );
    await fireEvent.press(getByTestId("case-exception-put-on-hold-yes"));
    expect(
      getByTestId("case-exception-put-on-hold-yes").props.accessibilityState
        .selected,
    ).toBe(true);
    await fireEvent.press(getByTestId("case-exception-create-save"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const post = calls.find((call) => call.init?.method === "POST");
    expect(post).toBeTruthy();
    expect(post!.path).toContain("/api/case-exceptions");
    expect(JSON.parse(String(post!.init!.body))).toEqual({
      caseId: CASE_ID,
      issueText: "Contact too tight",
      putOnHold: true,
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["case-exceptions", "active"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["case", CASE_ID],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["cases"],
    });
  });

  it("requires and posts an active current location when not putting the case on hold", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    setMockFetchHandler(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path.includes("/api/locations")) return envelope(LOCATIONS);
      if (path.includes("/api/case-exceptions"))
        return envelope({ id: EXCEPTION_ID, status: "active" }, 201);
      return envelope(null);
    });
    const onClose = vi.fn();
    const { getByTestId } = await render(
      <CaseExceptionCreateSheet
        visible
        caseId={CASE_ID}
        labOrganizationId={LAB_ID}
        onClose={onClose}
      />,
    );
    await fireEvent.press(getByTestId("case-exception-put-on-hold-no"));
    expect(
      getByTestId("case-exception-put-on-hold-no").props.accessibilityState
        .selected,
    ).toBe(true);
    expect(
      getByTestId("case-exception-put-on-hold-yes").props.accessibilityState
        .selected,
    ).toBe(false);
    await waitFor(() =>
      expect(
        getByTestId("case-exception-create-location-loc_design"),
      ).toBeTruthy(),
    );
    expect(
      getByTestId("case-exception-create-save").props.accessibilityState
        ?.disabled ?? getByTestId("case-exception-create-save").props.disabled,
    ).toBe(true);
    await fireEvent.press(
      getByTestId("case-exception-create-location-loc_design"),
    );
    expect(
      getByTestId("case-exception-create-save").props.accessibilityState
        ?.disabled ?? getByTestId("case-exception-create-save").props.disabled,
    ).toBe(false);
    await fireEvent.press(getByTestId("case-exception-create-save"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const post = calls.find((call) => call.init?.method === "POST");
    expect(JSON.parse(String(post!.init!.body))).toEqual({
      caseId: CASE_ID,
      putOnHold: false,
      labLocationId: "loc_design",
    });
  });

  it("uploads selected files only after creating the exception", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const upload = vi.fn(async () => ({
      ok: true as const,
      url: "/uploads/case-media/exception-file.pdf",
    }));
    setMockUploadHandler(upload);
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [
        {
          uri: "file:///tmp/exception-file.pdf",
          name: "exception-file.pdf",
          mimeType: "application/pdf",
          size: 12,
          lastModified: 1_739_000_000_000,
        },
      ],
    });
    setMockFetchHandler(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path.includes("/api/case-exceptions")) {
        return envelope({ id: EXCEPTION_ID, status: "active" }, 201);
      }
      return envelope({ id: "attachment_1" }, 201);
    });

    const onClose = vi.fn();
    const { getByTestId, getByText } = await render(
      <CaseExceptionCreateSheet
        visible
        caseId={CASE_ID}
        labOrganizationId={LAB_ID}
        onClose={onClose}
      />,
    );
    await fireEvent.press(getByTestId("case-exception-create-pick-file"));
    await waitFor(() =>
      expect(getByText("1 file ready to upload")).toBeTruthy(),
    );
    await fireEvent.press(getByTestId("case-exception-put-on-hold-yes"));
    await fireEvent.press(getByTestId("case-exception-create-save"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(upload).toHaveBeenCalledWith(
      "file:///tmp/exception-file.pdf",
      "exception-file.pdf",
      "application/pdf",
    );
    const attachment = calls.find(
      (call) =>
        call.path === `/api/cases/${CASE_ID}/attachments` &&
        call.init?.method === "POST",
    );
    expect(attachment).toBeTruthy();
    expect(JSON.parse(String(attachment!.init!.body))).toEqual({
      storageKey: "/uploads/case-media/exception-file.pdf",
      fileName: "exception-file.pdf",
      fileType: "application/pdf",
      caseExceptionId: EXCEPTION_ID,
    });
  });

  it("shows an explicit empty state when the lab has no active locations", async () => {
    setMockFetchHandler(async (path: string) => {
      if (path.includes("/api/locations")) return envelope([]);
      return envelope(null);
    });
    const { getByTestId } = await render(
      <CaseExceptionCreateSheet
        visible
        caseId={CASE_ID}
        labOrganizationId={LAB_ID}
        onClose={vi.fn()}
      />,
    );
    await fireEvent.press(getByTestId("case-exception-put-on-hold-no"));
    await waitFor(() =>
      expect(getByTestId("case-exception-create-locations-empty")).toBeTruthy(),
    );
    const save = getByTestId("case-exception-create-save");
    expect(save.props.accessibilityState?.disabled ?? save.props.disabled).toBe(
      true,
    );
  });

  it("shows a location-load retry state and loads locations after retrying", async () => {
    let attempts = 0;
    setMockFetchHandler(async (path: string) => {
      if (!path.includes("/api/locations")) return envelope(null);
      attempts += 1;
      return attempts === 1
        ? errorEnvelope(500, "Locations are unavailable")
        : envelope(LOCATIONS);
    });
    const { getByTestId } = await render(
      <CaseExceptionCreateSheet
        visible
        caseId={CASE_ID}
        labOrganizationId={LAB_ID}
        onClose={vi.fn()}
      />,
    );
    await fireEvent.press(getByTestId("case-exception-put-on-hold-no"));
    await waitFor(() =>
      expect(getByTestId("case-exception-create-locations-retry")).toBeTruthy(),
    );
    await fireEvent.press(getByTestId("case-exception-create-locations-retry"));
    await waitFor(() =>
      expect(getByTestId("case-exception-create-location-loc_qc")).toBeTruthy(),
    );
  });

  it("reports the server's duplicate rejection and keeps the sheet open", async () => {
    setMockFetchHandler(async () =>
      errorEnvelope(409, "This case already has an active exception."),
    );

    const onClose = vi.fn();
    const { getByTestId } = await render(
      <CaseExceptionCreateSheet
        visible
        caseId={CASE_ID}
        labOrganizationId={LAB_ID}
        onClose={onClose}
      />,
    );
    await fireEvent.press(getByTestId("case-exception-put-on-hold-yes"));
    await fireEvent.press(getByTestId("case-exception-create-save"));

    await waitFor(() =>
      expect(
        getByTestId("case-exception-create-error").props.children,
      ).toContain("already has an active exception"),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("records an issue description, shows the stop state, and appends the transcript", async () => {
    mockUploadAudioForTranscript.mockResolvedValue(
      "The occlusal contact is too high.",
    );
    const { getByTestId, getByLabelText } = await render(
      <CaseExceptionCreateSheet
        visible
        caseId={CASE_ID}
        labOrganizationId={LAB_ID}
        onClose={vi.fn()}
      />,
    );
    await fireEvent.changeText(
      getByTestId("case-exception-issue-input"),
      "Called the doctor.",
    );

    await fireEvent.press(getByLabelText("Dictate issue description"));
    await waitFor(() =>
      expect(getByLabelText("Stop recording issue description")).toBeTruthy(),
    );
    expect(
      getByTestId("case-exception-dictation-status").props.children,
    ).toContain("Recording");

    await fireEvent.press(getByLabelText("Stop recording issue description"));
    await waitFor(() =>
      expect(getByTestId("case-exception-issue-input").props.value).toBe(
        "Called the doctor.\nThe occlusal contact is too high.",
      ),
    );
    expect(mockUploadAudioForTranscript).toHaveBeenCalledWith(
      "file:///tmp/exception.m4a",
      "audio/m4a",
    );
  });

  it("keeps a typed issue when permission or transcription fails", async () => {
    mockUploadAudioForTranscript.mockRejectedValue(
      new Error("Voice transcription is temporarily unavailable."),
    );
    const { getByTestId, getByLabelText } = await render(
      <CaseExceptionCreateSheet
        visible
        caseId={CASE_ID}
        labOrganizationId={LAB_ID}
        onClose={vi.fn()}
      />,
    );
    await fireEvent.changeText(
      getByTestId("case-exception-issue-input"),
      "Typed before dictation.",
    );
    await fireEvent.press(getByLabelText("Dictate issue description"));
    await waitFor(() =>
      expect(getByLabelText("Stop recording issue description")).toBeTruthy(),
    );
    await fireEvent.press(getByLabelText("Stop recording issue description"));
    await waitFor(() =>
      expect(
        getByTestId("case-exception-dictation-error").props.children,
      ).toContain("temporarily unavailable"),
    );
    expect(getByTestId("case-exception-issue-input").props.value).toBe(
      "Typed before dictation.",
    );

    mockRequestPermissionsAsync.mockResolvedValueOnce({
      status: "denied",
      granted: false,
    });
    await fireEvent.press(getByLabelText("Dictate issue description"));
    await waitFor(() =>
      expect(
        getByTestId("case-exception-dictation-error").props.children,
      ).toContain("Microphone permission is required"),
    );
    expect(getByTestId("case-exception-issue-input").props.value).toBe(
      "Typed before dictation.",
    );
  });

  it("stops the recorder when the exception form closes", async () => {
    const stopAndUnloadAsync = vi.fn(async () => undefined);
    mockRecordingCreateAsync.mockResolvedValue({
      recording: {
        stopAndUnloadAsync,
        getURI: vi.fn(() => "file:///tmp/exception.m4a"),
      },
    });
    const onClose = vi.fn();
    const { getByTestId, getByLabelText } = await render(
      <CaseExceptionCreateSheet
        visible
        caseId={CASE_ID}
        labOrganizationId={LAB_ID}
        onClose={onClose}
      />,
    );
    await fireEvent.press(getByLabelText("Dictate issue description"));
    await waitFor(() =>
      expect(getByLabelText("Stop recording issue description")).toBeTruthy(),
    );

    await fireEvent.press(getByTestId("case-exception-create-cancel"));
    await waitFor(() => expect(stopAndUnloadAsync).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    expect(mockSetAudioModeAsync).toHaveBeenCalledWith({
      allowsRecordingIOS: false,
    });
  });

  it("does not start a microphone after the sheet closes during audio-session cleanup", async () => {
    let releaseInitialCleanup: (() => void) | undefined;
    let firstCleanup = true;
    mockSetAudioModeAsync.mockImplementation(
      (options: { allowsRecordingIOS?: boolean }) => {
        if (options.allowsRecordingIOS === false && firstCleanup) {
          firstCleanup = false;
          return new Promise<void>((resolve) => {
            releaseInitialCleanup = resolve;
          });
        }
        return Promise.resolve();
      },
    );
    const onClose = vi.fn();
    const { getByTestId, getByLabelText } = await render(
      <CaseExceptionCreateSheet
        visible
        caseId={CASE_ID}
        labOrganizationId={LAB_ID}
        onClose={onClose}
      />,
    );

    await fireEvent.press(getByLabelText("Dictate issue description"));
    await waitFor(() =>
      expect(mockSetAudioModeAsync).toHaveBeenCalledWith({
        allowsRecordingIOS: false,
      }),
    );
    await fireEvent.press(getByTestId("case-exception-create-cancel"));
    releaseInitialCleanup?.();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockRequestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockRecordingCreateAsync).not.toHaveBeenCalled();
  });
});

describe("CaseExceptionDetailSheet", () => {
  async function mount(d: Record<string, unknown>) {
    setMockAppState({ caseExceptionDetail: d });
    setMockFetchHandler(async (path: string) => {
      if (path.includes("/api/locations")) return envelope(LOCATIONS);
      return envelope(null);
    });
    return render(
      <CaseExceptionDetailSheet
        visible
        caseId={CASE_ID}
        exceptionId={EXCEPTION_ID}
        labOrganizationId={LAB_ID}
        onClose={vi.fn()}
      />,
    );
  }

  it("shows the issue conversation and media to a lab member but hides the resolve form", async () => {
    const { getByText, getByTestId, queryByTestId } = await mount(
      detail({
        notes: [
          {
            id: "note_1",
            caseExceptionId: EXCEPTION_ID,
            authorUserId: "user_2",
            authorName: "Olive Owner",
            noteText: "Model re-poured",
            createdAt: new Date().toISOString(),
            attachments: [
              {
                id: "note-photo",
                fileName: "margin.jpg",
                fileType: "image/jpeg",
                uploaderName: "Olive Owner",
                createdAt: new Date().toISOString(),
              },
            ],
          },
        ],
        history: [
          {
            type: "opened",
            occurredAt: new Date().toISOString(),
            actorName: "Tina Tech",
            detail: null,
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
      }),
    );

    expect(getByText("Margin is short on #14")).toBeTruthy();
    expect(getByTestId("case-exception-conversation-note-note_1")).toBeTruthy();
    expect(
      getByTestId("case-exception-note-attachment-note-photo"),
    ).toBeTruthy();
    // The lifecycle History remains in place alongside the conversation.
    expect(
      getByText("note added · Olive Owner — Model re-poured"),
    ).toBeTruthy();
    expect(getByTestId("case-exception-attachment-att_1")).toBeTruthy();
    expect(getByTestId("case-exception-resolve-denied")).toBeTruthy();
    expect(queryByTestId("case-exception-resolve-form")).toBeNull();
    expect(getByTestId("case-exception-note-input").props.placeholder).toBe(
      "Add additional exception notes.",
    );
    expect(
      getByTestId("case-exception-note-submit").props.accessibilityState
        .disabled,
    ).toBe(true);
    expect(
      StyleSheet.flatten(getByTestId("case-exception-note-submit").props.style)
        .opacity,
    ).toBe(0.5);
  });

  it.each([
    { caseId: CASE_ID, caseKind: "canonical" },
    { caseId: "legacy-case-22", caseKind: "legacy" },
  ])(
    "opens exception-note photos and files for a $caseKind case through its case attachment route",
    async ({ caseId, caseKind }) => {
      const d = detail({
        caseId,
        caseKind,
        notes: [
          {
            id: "note_evidence",
            noteText: "Please review the evidence.",
            authorName: "Olive Owner",
            createdAt: new Date().toISOString(),
            attachments: [
              {
                id: "note-photo",
                fileName: "margin.jpg",
                fileType: "image/jpeg",
                uploaderName: "Olive Owner",
                createdAt: new Date().toISOString(),
              },
              {
                id: "note-document",
                fileName: "lab-report.pdf",
                fileType: "application/pdf",
                uploaderName: "Olive Owner",
                createdAt: new Date().toISOString(),
              },
            ],
          },
        ],
      });
      setMockAppState({ caseExceptionDetail: d });
      setMockFetchHandler(async (path: string) => {
        if (path.includes("/api/locations")) return envelope(LOCATIONS);
        return envelope(null);
      });
      mockOpenAttachmentPreview.mockResolvedValue("pdf-viewer");

      const { getByTestId, queryByTestId } = await render(
        <CaseExceptionDetailSheet
          visible
          caseId={caseId}
          exceptionId={EXCEPTION_ID}
          labOrganizationId={LAB_ID}
          onClose={vi.fn()}
        />,
      );

      expect(
        getByTestId("case-exception-note-attachment-note-photo-thumbnail").props
          .source.uri,
      ).toBe(`/api/cases/${caseId}/attachments/note-photo/file`);
      await fireEvent.press(
        getByTestId("case-exception-note-attachment-note-photo"),
      );
      expect(
        getByTestId("case-exception-note-image-preview-image"),
      ).toBeTruthy();
      const alert = vi.spyOn(Alert, "alert");
      const stopPropagation = vi.fn();
      await fireEvent.press(
        getByTestId("case-exception-note-image-preview-save"),
        { stopPropagation },
      );
      expect(stopPropagation).toHaveBeenCalled();
      expect(getByTestId("case-exception-note-image-preview-image")).toBeTruthy();
      expect(alert).toHaveBeenLastCalledWith(
        "Save Photo",
        expect.any(String),
        expect.any(Array),
      );
      const buttons = alert.mock.calls.at(-1)?.[2];
      await act(async () => { await buttons?.find((button) => button.text === "Save")?.onPress?.(); });
      expect(mockSaveImageToDevice).toHaveBeenCalledWith(
        `/api/cases/${caseId}/attachments/note-photo/file`,
        { fileName: "margin.jpg", fileType: "image/jpeg" },
      );
      expect(alert).toHaveBeenLastCalledWith("Saved", "Photo saved to your device.");
      expect(getByTestId("case-exception-note-image-preview-save").props.accessibilityState.busy).toBe(false);
      alert.mockRestore();
      await fireEvent.press(
        getByTestId("case-exception-note-image-preview-close"),
      );
      expect(
        queryByTestId("case-exception-note-image-preview-image"),
      ).toBeNull();

      await fireEvent.press(
        getByTestId("case-exception-note-attachment-note-document"),
      );
      await waitFor(() =>
        expect(mockOpenAttachmentPreview).toHaveBeenCalledWith(
          expect.objectContaining({
            url: `/api/cases/${caseId}/attachments/note-document/file`,
            fileName: "lab-report.pdf",
            fileType: "application/pdf",
          }),
          expect.objectContaining({
            onOpenImage: expect.any(Function),
            onError: expect.any(Function),
            setBusy: expect.any(Function),
            onProgress: expect.any(Function),
          }),
        ),
      );
    },
  );

  it.each([
    ["ios", "saved", "Saved"],
    ["android", "saved", "Saved"],
    ["ios", "permission-denied", "Permission needed"],
    ["android", "permission-denied", "Permission needed"],
    ["ios", "error", "Couldn't save"],
    ["android", "error", "Couldn't save"],
  ])("reports %s photo save result %s", async (os, result, title) => {
    const originalOs = Platform.OS;
    Object.defineProperty(Platform, "OS", { configurable: true, value: os });
    const alert = vi.spyOn(Alert, "alert");
    try {
      setMockAppState({
        caseExceptionDetail: detail({
          notes: [{
            id: "n1",
            noteText: "Photo evidence",
            authorName: "Lab member",
            createdAt: new Date().toISOString(),
            attachments: [{ id: "a1", fileName: "photo.png", fileType: "image/png" }],
          }],
        }),
      });
      mockSaveImageToDevice.mockResolvedValue(result);
      const { getByTestId } = await render(
        <CaseExceptionDetailSheet visible caseId={CASE_ID} exceptionId={EXCEPTION_ID}
          labOrganizationId={LAB_ID} onClose={vi.fn()} />,
      );
      await fireEvent.press(getByTestId("case-exception-note-attachment-a1"));
      await fireEvent.press(getByTestId("case-exception-note-image-preview-save"), {
        stopPropagation: vi.fn(),
      });
      const buttons = alert.mock.calls.at(-1)?.[2];
      await act(async () => { await buttons?.find((button) => button.text === "Save")?.onPress?.(); });
      expect(alert).toHaveBeenLastCalledWith(title, expect.any(String));
      expect(getByTestId("case-exception-note-image-preview-save").props.accessibilityState.busy).toBe(false);
      expect(getByTestId("case-exception-note-image-preview-image")).toBeTruthy();
    } finally {
      alert.mockRestore();
      Object.defineProperty(Platform, "OS", { configurable: true, value: originalOs });
    }
  });

  it("keeps the preview open and prevents another save while a photo is saving", async () => {
    setMockAppState({
      caseExceptionDetail: detail({
        notes: [{
          id: "n1",
          noteText: "Photo evidence",
          authorName: "Lab member",
          createdAt: new Date().toISOString(),
          attachments: [{ id: "a1", fileName: "photo.jpg", fileType: "image/jpeg" }],
        }],
      }),
    });
    let finishSave!: (result: string) => void;
    mockSaveImageToDevice.mockReturnValue(new Promise<string>((resolve) => {
      finishSave = resolve;
    }));
    const alert = vi.spyOn(Alert, "alert");
    try {
      const { getByTestId } = await render(
        <CaseExceptionDetailSheet visible caseId={CASE_ID} exceptionId={EXCEPTION_ID}
          labOrganizationId={LAB_ID} onClose={vi.fn()} />,
      );
      await fireEvent.press(getByTestId("case-exception-note-attachment-a1"));
      await fireEvent.press(getByTestId("case-exception-note-image-preview-save"), {
        stopPropagation: vi.fn(),
      });
      const buttons = alert.mock.calls.at(-1)?.[2];
      let saving: unknown;
      await act(async () => {
        saving = buttons?.find((button) => button.text === "Save")?.onPress?.();
      });
      expect(getByTestId("case-exception-note-image-preview-save").props.accessibilityState)
        .toEqual({ disabled: true, busy: true });
      await fireEvent.press(getByTestId("case-exception-note-image-preview-save"), {
        stopPropagation: vi.fn(),
      });
      expect(mockSaveImageToDevice).toHaveBeenCalledTimes(1);
      expect(getByTestId("case-exception-note-image-preview-image")).toBeTruthy();
      await act(async () => {
        finishSave("saved");
        await saving;
      });
      expect(getByTestId("case-exception-note-image-preview-save").props.accessibilityState)
        .toEqual({ disabled: false, busy: false });
    } finally {
      alert.mockRestore();
    }
  });

  it("submits an additional note, clears it, and preserves it on retryable failure", async () => {
    let shouldFail = false;
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const onClose = vi.fn();
    setMockAppState({ caseExceptionDetail: detail() });
    setMockFetchHandler(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path.includes("/notes") && init?.method === "POST") {
        return shouldFail
          ? errorEnvelope(500, "Notes are temporarily unavailable")
          : envelope({
              id: "note_2",
              noteText: "Waiting on articulation",
              authorName: "Tina Tech",
              createdAt: new Date().toISOString(),
            });
      }
      return envelope(detail());
    });
    const { getByTestId, getByText } = await render(
      <CaseExceptionDetailSheet
        visible
        caseId={CASE_ID}
        exceptionId={EXCEPTION_ID}
        labOrganizationId={LAB_ID}
        onClose={onClose}
      />,
    );
    const input = getByTestId("case-exception-note-input");
    const submitButton = getByTestId("case-exception-note-submit");
    const submitStyle = StyleSheet.flatten(submitButton.props.style);
    expect(submitStyle.minHeight).toBeGreaterThanOrEqual(44);
    expect(submitStyle.alignSelf).toBe("flex-end");
    expect(submitStyle.width).not.toBe("100%");
    expect(submitStyle.backgroundColor).toBe("#145DA0");
    expect(submitStyle.borderWidth).toBeUndefined();
    expect(submitButton.props.accessibilityRole).toBe("button");
    expect(
      StyleSheet.flatten(getByText("Submit additional notes").props.style)
        .color,
    ).toBe("#fff");

    await fireEvent.changeText(input, "   ");
    expect(submitButton.props.accessibilityState.disabled).toBe(true);
    expect(StyleSheet.flatten(submitButton.props.style).opacity).toBe(0.5);

    await fireEvent.changeText(input, "Waiting on articulation");
    await fireEvent.press(submitButton);
    await waitFor(() => expect(input.props.value).toBe(""));
    const postCalls = calls.filter((call) => call.init?.method === "POST");
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.path).toContain(
      `/api/case-exceptions/${EXCEPTION_ID}/notes`,
    );
    expect(JSON.parse(String(postCalls[0]?.init?.body))).toEqual({
      noteText: "Waiting on articulation",
      attachments: [],
    });
    expect(postCalls.some((call) => call.path.includes("/resolve"))).toBe(
      false,
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(getByText("On Hold")).toBeTruthy();

    shouldFail = true;
    await fireEvent.changeText(input, "Keep this for retry");
    await fireEvent.press(submitButton);
    await waitFor(() =>
      expect(
        getByTestId("case-exception-detail-error-message").props.children,
      ).toContain("temporarily unavailable"),
    );
    expect(input.props.value).toBe("Keep this for retry");
  });

  it("keeps uploaded note files with the draft after failure and reuses them on retry", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    let noteShouldFail = true;
    let uploadCount = 0;
    setMockAppState({ caseExceptionDetail: detail() });
    setMockUploadHandler(async () => {
      uploadCount += 1;
      if (uploadCount === 1) {
        return {
          ok: false,
          error: "Upload is temporarily unavailable",
        };
      }
      return {
        ok: true,
        url: "/uploads/case-media/note-evidence.jpg",
      };
    });
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [
        {
          uri: "file:///tmp/note-evidence.jpg",
          fileName: "note-evidence.jpg",
          width: 640,
          height: 480,
          assetId: null,
          base64: null,
          duration: null,
          exif: null,
          mimeType: "image/jpeg",
          fileSize: 1200,
        },
      ],
    });
    setMockFetchHandler(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path.includes("/notes") && init?.method === "POST") {
        return noteShouldFail
          ? errorEnvelope(500, "Notes are temporarily unavailable")
          : envelope({
              id: "note_with_photo",
              noteText: "Inspect this margin.",
              authorName: "Tina Tech",
              createdAt: new Date().toISOString(),
              attachments: [
                {
                  id: "saved-note-photo",
                  fileName: "note-evidence.jpg",
                  fileType: "image/jpeg",
                  uploaderName: "Tina Tech",
                  createdAt: new Date().toISOString(),
                },
              ],
            });
      }
      return envelope(detail());
    });

    const { getByTestId, getByText } = await render(
      <CaseExceptionDetailSheet
        visible
        caseId={CASE_ID}
        exceptionId={EXCEPTION_ID}
        labOrganizationId={LAB_ID}
        onClose={vi.fn()}
      />,
    );
    await fireEvent.press(getByTestId("case-exception-note-pick-library"));
    expect(getByText("note-evidence.jpg")).toBeTruthy();
    const input = getByTestId("case-exception-note-input");
    await fireEvent.changeText(input, "Inspect this margin.");
    await fireEvent.press(getByTestId("case-exception-note-submit"));
    await waitFor(() =>
      expect(
        getByTestId("case-exception-detail-error-message").props.children,
      ).toContain("Upload is temporarily unavailable"),
    );
    expect(input.props.value).toBe("Inspect this margin.");
    expect(getByText("note-evidence.jpg")).toBeTruthy();
    expect(uploadCount).toBe(1);
    expect(calls.filter((call) => call.path.includes("/notes"))).toHaveLength(
      0,
    );

    await fireEvent.press(getByTestId("case-exception-note-submit"));
    await waitFor(() =>
      expect(
        getByTestId("case-exception-detail-error-message").props.children,
      ).toContain("temporarily unavailable"),
    );
    expect(input.props.value).toBe("Inspect this margin.");
    expect(getByText("note-evidence.jpg")).toBeTruthy();
    expect(uploadCount).toBe(2);
    const noteCalls = calls.filter(
      (call) => call.path.includes("/notes") && call.init?.method === "POST",
    );
    expect(
      noteCalls.map((call) => JSON.parse(String(call.init?.body))),
    ).toEqual([
      {
        noteText: "Inspect this margin.",
        attachments: [
          {
            storageKey: "/uploads/case-media/note-evidence.jpg",
            fileName: "note-evidence.jpg",
            fileType: "image/jpeg",
          },
        ],
      },
    ]);

    noteShouldFail = false;
    await fireEvent.press(getByTestId("case-exception-note-submit"));
    await waitFor(() => expect(input.props.value).toBe(""));
    expect(uploadCount).toBe(2);
    expect(
      calls
        .filter(
          (call) =>
            call.path.includes("/notes") && call.init?.method === "POST",
        )
        .map((call) => JSON.parse(String(call.init?.body))),
    ).toEqual([
      {
        noteText: "Inspect this margin.",
        attachments: [
          {
            storageKey: "/uploads/case-media/note-evidence.jpg",
            fileName: "note-evidence.jpg",
            fileType: "image/jpeg",
          },
        ],
      },
      {
        noteText: "Inspect this margin.",
        attachments: [
          {
            storageKey: "/uploads/case-media/note-evidence.jpg",
            fileName: "note-evidence.jpg",
            fileType: "image/jpeg",
          },
        ],
      },
    ]);
  });

  it("shows note-saving feedback without presenting it as a resolution", async () => {
    let finishNoteRequest: ((response: Response) => void) | undefined;
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    setMockAppState({
      caseExceptionDetail: detail({ viewerCanResolve: true }),
    });
    setMockFetchHandler(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path.includes("/api/locations")) return envelope(LOCATIONS);
      if (path.includes("/notes") && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          finishNoteRequest = resolve;
        });
      }
      return envelope(detail({ viewerCanResolve: true }));
    });

    const { getByTestId, getByText } = await render(
      <CaseExceptionDetailSheet
        visible
        caseId={CASE_ID}
        exceptionId={EXCEPTION_ID}
        labOrganizationId={LAB_ID}
        onClose={vi.fn()}
      />,
    );
    const input = getByTestId("case-exception-note-input");
    await fireEvent.changeText(input, "Waiting on the doctor");
    await fireEvent.press(getByTestId("case-exception-note-submit"));

    await waitFor(() =>
      expect(
        getByTestId("case-exception-note-submit").props.accessibilityState.busy,
      ).toBe(true),
    );
    expect(
      getByTestId("case-exception-note-submit").props.accessibilityState
        .disabled,
    ).toBe(true);
    expect(
      StyleSheet.flatten(getByTestId("case-exception-note-submit").props.style)
        .opacity,
    ).toBe(0.5);
    expect(getByText("Submitting…")).toBeTruthy();
    expect(getByText("Resolve exception")).toBeTruthy();
    await fireEvent.press(getByTestId("case-exception-note-submit"));
    expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(
      1,
    );

    await act(async () => {
      finishNoteRequest?.(
        envelope({
          id: "note_3",
          noteText: "Waiting on the doctor",
          authorName: "Tina Tech",
          createdAt: new Date().toISOString(),
        }),
      );
    });
    await waitFor(() => expect(input.props.value).toBe(""));
  });

  it("appends dictated follow-up text without submitting the note", async () => {
    mockUploadAudioForTranscript.mockResolvedValue("Occlusion checked again.");
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    setMockAppState({ caseExceptionDetail: detail() });
    setMockFetchHandler(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path.includes("/api/locations")) return envelope(LOCATIONS);
      return envelope(detail());
    });
    const { getByTestId, getByLabelText } = await render(
      <CaseExceptionDetailSheet
        visible
        caseId={CASE_ID}
        exceptionId={EXCEPTION_ID}
        labOrganizationId={LAB_ID}
        onClose={vi.fn()}
      />,
    );
    await fireEvent.changeText(
      getByTestId("case-exception-note-input"),
      "Typed first.",
    );
    await fireEvent.press(getByLabelText("Dictate additional exception note"));
    await waitFor(() =>
      expect(
        getByLabelText("Stop recording additional exception note"),
      ).toBeTruthy(),
    );
    await fireEvent.press(
      getByLabelText("Stop recording additional exception note"),
    );
    await waitFor(() =>
      expect(getByTestId("case-exception-note-input").props.value).toBe(
        "Typed first.\nOcclusion checked again.",
      ),
    );
    expect(
      calls.some(
        (call) => call.path.includes("/notes") && call.init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("preserves a follow-up draft on dictation failure", async () => {
    mockUploadAudioForTranscript.mockRejectedValue(
      new Error("Voice transcription is temporarily unavailable."),
    );
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    setMockAppState({ caseExceptionDetail: detail() });
    setMockFetchHandler(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path.includes("/api/locations")) return envelope(LOCATIONS);
      return envelope(detail());
    });
    const { getByTestId, getByLabelText } = await render(
      <CaseExceptionDetailSheet
        visible
        caseId={CASE_ID}
        exceptionId={EXCEPTION_ID}
        labOrganizationId={LAB_ID}
        onClose={vi.fn()}
      />,
    );
    await fireEvent.changeText(
      getByTestId("case-exception-note-input"),
      "Keep this draft.",
    );
    await fireEvent.press(getByLabelText("Dictate additional exception note"));
    await waitFor(() =>
      expect(
        getByLabelText("Stop recording additional exception note"),
      ).toBeTruthy(),
    );
    await fireEvent.press(
      getByLabelText("Stop recording additional exception note"),
    );
    await waitFor(() =>
      expect(
        getByTestId("case-exception-note-dictation-error").props.children,
      ).toContain("temporarily unavailable"),
    );
    expect(getByTestId("case-exception-note-input").props.value).toBe(
      "Keep this draft.",
    );
    expect(
      calls.some(
        (call) => call.path.includes("/notes") && call.init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("stops follow-up recording when the detail sheet closes", async () => {
    const stopAndUnloadAsync = vi.fn(async () => undefined);
    mockRecordingCreateAsync.mockResolvedValue({
      recording: {
        stopAndUnloadAsync,
        getURI: vi.fn(() => "file:///tmp/follow-up.m4a"),
      },
    });
    const onClose = vi.fn();
    setMockAppState({ caseExceptionDetail: detail() });
    const { getByTestId, getByLabelText } = await render(
      <CaseExceptionDetailSheet
        visible
        caseId={CASE_ID}
        exceptionId={EXCEPTION_ID}
        labOrganizationId={LAB_ID}
        onClose={onClose}
      />,
    );
    await fireEvent.press(getByLabelText("Dictate additional exception note"));
    await waitFor(() =>
      expect(
        getByLabelText("Stop recording additional exception note"),
      ).toBeTruthy(),
    );
    await fireEvent.press(getByTestId("case-exception-detail-cancel"));
    await waitFor(() => expect(stopAndUnloadAsync).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("does not show the additional-note composer after resolution", async () => {
    const { queryByTestId } = await mount(detail({ status: "resolved" }));
    expect(queryByTestId("case-exception-note-input")).toBeNull();
    expect(queryByTestId("case-exception-note-submit")).toBeNull();
  });

  it("shows the current location, offers real locations, and gates resolving on the required note", async () => {
    const { getByTestId, getByText, queryByTestId } = await mount(
      detail({ viewerCanResolve: true }),
    );

    expect(getByTestId("case-exception-resolve-form")).toBeTruthy();
    expect(queryByTestId("case-exception-resolve-denied")).toBeNull();
    expect(
      getByTestId("case-exception-current-location").props.children,
    ).toBeTruthy();
    expect(getByText("Resolution note (required)")).toBeTruthy();

    await waitFor(() =>
      expect(getByTestId("case-exception-location-loc_qc")).toBeTruthy(),
    );
    // Destinations come from /api/locations — never a built-in station list.
    expect(getByTestId("case-exception-location-loc_design")).toBeTruthy();

    const disabled = () => {
      const btn = getByTestId("case-exception-detail-save");
      return btn.props.accessibilityState?.disabled ?? btn.props.disabled;
    };

    // No note yet — the footer action is inert even after picking a
    // destination, because only the note is required.
    expect(disabled()).toBe(true);
    await fireEvent.press(getByTestId("case-exception-location-loc_qc"));
    expect(disabled()).toBe(true);

    // Whitespace alone is still blank.
    await fireEvent.changeText(
      getByTestId("case-exception-resolution-note"),
      "   ",
    );
    expect(disabled()).toBe(true);

    await fireEvent.changeText(
      getByTestId("case-exception-resolution-note"),
      "Re-seated the margin",
    );
    await waitFor(() => expect(disabled()).toBe(false));
  });

  it("keeps long exception content in a bounded vertical scroller without media gesture conflicts", async () => {
    const now = new Date().toISOString();
    const notes = Array.from({ length: 20 }, (_, index) => ({
      id: `note_${index}`,
      caseExceptionId: EXCEPTION_ID,
      authorUserId: "user_2",
      authorName: "Olive Owner",
      noteText: `Long exception note ${index}`,
      createdAt: now,
    }));
    const attachments = Array.from({ length: 8 }, (_, index) => ({
      id: `att_${index}`,
      fileName: `exception-photo-${index}.jpg`,
      fileType: "image/jpeg",
      createdAt: now,
      uploaderName: "Tina Tech",
    }));
    const history = Array.from({ length: 20 }, (_, index) => ({
      type: "note_added",
      occurredAt: now,
      actorName: "Olive Owner",
      detail: `History entry ${index}`,
    }));

    const screen = await mount(
      detail({
        issueText: "A ".repeat(500),
        notes,
        attachments,
        history,
        viewerCanResolve: true,
      }),
    );
    await act(async () => undefined);

    const { getByTestId, getByText } = screen;
    const bodyScroll = getByTestId("case-exception-detail-body-scroll");
    const sheetStyle = StyleSheet.flatten(
      getByTestId("case-exception-detail-sheet").props.style,
    );
    const bodyStyle = StyleSheet.flatten(bodyScroll.props.style);
    expect(sheetStyle.height).toBe("88%");
    expect(bodyStyle.flex).toBe(1);
    expect(bodyStyle.flexGrow).toBe(1);
    expect(bodyStyle.minHeight).toBe(0);
    expect(bodyScroll.props.directionalLockEnabled).toBe(true);
    expect(bodyScroll.props.nestedScrollEnabled).toBe(true);
    expect(bodyScroll.props.keyboardShouldPersistTaps).toBe("handled");
    expect(["interactive", "on-drag"]).toContain(
      bodyScroll.props.keyboardDismissMode,
    );

    const mediaScroll = getByTestId("case-exception-media-scroll");
    expect(mediaScroll.props.horizontal).toBe(true);
    expect(mediaScroll.props.directionalLockEnabled).toBe(true);
    expect(mediaScroll.props.nestedScrollEnabled).toBe(true);
    expect(mediaScroll.props.alwaysBounceVertical).toBe(false);

    expect(
      getByTestId("case-exception-conversation-note-note_19"),
    ).toBeTruthy();
    expect(getByTestId("case-exception-attachment-att_7")).toBeTruthy();
    expect(
      getByText("note added · Olive Owner — History entry 19"),
    ).toBeTruthy();
    expect(getByTestId("case-exception-resolve-form")).toBeTruthy();
    expect(getByTestId("case-exception-resolution-note")).toBeTruthy();
    expect(getByTestId("case-exception-detail-save")).toBeTruthy();

    const noteSubmit = getByTestId("case-exception-note-submit");
    expect(StyleSheet.flatten(noteSubmit.props.style).minHeight).toBe(48);
    expect(noteSubmit.props.accessibilityState.disabled).toBe(true);
  });

  it("omits the destination when resolving without a move", async () => {
    const bodies: string[] = [];
    setMockAppState({
      caseExceptionDetail: detail({ viewerCanResolve: true }),
    });
    setMockFetchHandler(async (path: string, init?: RequestInit) => {
      if (path.includes("/api/locations")) return envelope(LOCATIONS);
      if (init?.method === "POST") {
        bodies.push(String(init.body));
        return envelope({ id: EXCEPTION_ID, status: "resolved" });
      }
      return envelope(null);
    });

    const onClose = vi.fn();
    const { getByTestId } = await render(
      <CaseExceptionDetailSheet
        visible
        caseId={CASE_ID}
        exceptionId={EXCEPTION_ID}
        labOrganizationId={LAB_ID}
        onClose={onClose}
      />,
    );

    await fireEvent.changeText(
      getByTestId("case-exception-resolution-note"),
      "No move needed",
    );
    await fireEvent.press(getByTestId("case-exception-detail-save"));

    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    expect(JSON.parse(bodies[0]!)).toEqual({
      resolutionNote: "No move needed",
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("posts the chosen destination and the required note when resolving", async () => {
    const bodies: string[] = [];
    setMockAppState({
      caseExceptionDetail: detail({ viewerCanResolve: true }),
    });
    setMockFetchHandler(async (path: string, init?: RequestInit) => {
      if (path.includes("/api/locations")) return envelope(LOCATIONS);
      if (init?.method === "POST") {
        bodies.push(String(init.body));
        return envelope({ id: EXCEPTION_ID, status: "resolved" });
      }
      return envelope(null);
    });

    const onClose = vi.fn();
    const { getByTestId } = await render(
      <CaseExceptionDetailSheet
        visible
        caseId={CASE_ID}
        exceptionId={EXCEPTION_ID}
        labOrganizationId={LAB_ID}
        onClose={onClose}
      />,
    );

    await waitFor(() =>
      expect(getByTestId("case-exception-location-loc_design")).toBeTruthy(),
    );
    await fireEvent.press(getByTestId("case-exception-location-loc_design"));
    await fireEvent.changeText(
      getByTestId("case-exception-resolution-note"),
      "Adjusted and re-polished",
    );
    await fireEvent.press(getByTestId("case-exception-detail-save"));

    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    expect(JSON.parse(bodies[0]!)).toEqual({
      labLocationId: "loc_design",
      resolutionNote: "Adjusted and re-polished",
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe("Mobile case detail — exception action wiring", () => {
  const source = readFileSync(
    join(__dirname, "..", "..", "..", "app", "case", "[id].tsx"),
    "utf8",
  );

  it("puts the exception control in the action row before the Details card", async () => {
    const actionRowIndex = source.indexOf('testID="overview-case-actions"');
    const rxIndex = source.indexOf("onPress={() => setRxPreviewOpen(true)}");
    const exceptionIndex = source.indexOf('testID="case-exception-create"');
    const detailsCardIndex = source.indexOf('testID="overview-details-card"');
    expect(actionRowIndex).toBeGreaterThan(-1);
    expect(rxIndex).toBeGreaterThan(actionRowIndex);
    expect(exceptionIndex).toBeGreaterThan(rxIndex);
    expect(detailsCardIndex).toBeGreaterThan(exceptionIndex);
    expect(source).toContain('flexWrap: "wrap"');
    // Flag vs. open: an already-flagged case must not offer a second flag.
    expect(source).toContain('testID="case-exception-open"');
    expect(source).toContain("activeException ? (");
  });

  it("labels the unflagged-case action exactly 'Create Exception Case'", async () => {
    const openIndex = source.indexOf('testID="case-exception-open"');
    const createIndex = source.indexOf('testID="case-exception-create"');
    expect(openIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(openIndex);
    expect(source.slice(openIndex, createIndex)).toContain("Exception case");
    expect(source.slice(createIndex, createIndex + 1_000)).toContain(
      "Create Exception Case",
    );
  });

  it("reads the active exception from the shared dashboard queue cache", async () => {
    expect(source).toContain("EXCEPTION_QUEUE_QUERY_KEY");
    expect(source).toContain("fetchActiveExceptions");
  });

  it("mounts both the create and detail sheets", async () => {
    expect(source).toContain("<CaseExceptionCreateSheet");
    expect(source).toContain("<CaseExceptionDetailSheet");
  });
});
