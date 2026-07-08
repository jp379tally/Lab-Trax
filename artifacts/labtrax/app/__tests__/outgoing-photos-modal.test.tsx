/**
 * Outgoing case photos — prompt + guided capture flow (Task: scan-to-complete
 * photo prompt).
 *
 * Invariants protected:
 *  - Pure helpers: prompt title (single vs batch), generated file name is
 *    filename-safe and .jpg, advance-button label transitions
 *    (Skip case → Next case → Done).
 *  - Batch eligibility: only succeeded cases, in scan order (scannedCases is
 *    stored newest-first), and only when the destination station is
 *    "complete".
 *  - History labeling: attachment events with metadata.category === "outgoing"
 *    are detected (object or JSON-string metadata), others are not.
 *  - Component: renders nothing with no cases; prompt phase Yes/No — declining
 *    calls onDone without uploading; accepting shows the guided capture step;
 *    a captured photo uploads through uploadCaseAttachment with
 *    category "outgoing"; the flow steps through multiple cases.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";

import {
  OutgoingPhotosModal,
  outgoingPromptTitle,
  outgoingPhotoFileName,
  advanceButtonLabel,
  type OutgoingPhotoCase,
} from "@/components/OutgoingPhotosModal";
import { outgoingPhotoCasesForBatch } from "@/app/batch-locate/index";
import { eventIsOutgoingPhoto } from "@/app/case/[id]";

vi.mock("@/lib/uploadCaseAttachment", () => ({
  uploadCaseAttachment: vi.fn(async () => ({ ok: true, attachment: { id: "att1" } })),
}));

import { uploadCaseAttachment } from "@/lib/uploadCaseAttachment";

const uploadMock = vi.mocked(uploadCaseAttachment);
const cameraMock = vi.mocked(ImagePicker.launchCameraAsync);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("outgoingPromptTitle", () => {
  it("uses singular wording for one case and plural for many", () => {
    expect(outgoingPromptTitle(1)).toBe("Take a photo of the outgoing case?");
    expect(outgoingPromptTitle(3)).toBe("Take photos of the outgoing cases?");
  });
});

describe("outgoingPhotoFileName", () => {
  it("builds a filename-safe .jpg name from the case number", () => {
    expect(outgoingPhotoFileName("C-1042", 1700000000000)).toBe(
      "outgoing-case-C-1042-1700000000000.jpg",
    );
  });

  it("strips unsafe characters and tolerates a missing case number", () => {
    expect(outgoingPhotoFileName("A/B #7", 5)).toBe("outgoing-case-A-B-7-5.jpg");
    expect(outgoingPhotoFileName(null, 5)).toBe("outgoing-case-5.jpg");
  });
});

describe("advanceButtonLabel", () => {
  it("offers Skip case before a photo, Next case after, Done on the last case", () => {
    expect(advanceButtonLabel({ isLast: false, photoCount: 0 })).toBe("Skip case");
    expect(advanceButtonLabel({ isLast: false, photoCount: 2 })).toBe("Next case");
    expect(advanceButtonLabel({ isLast: true, photoCount: 0 })).toBe("Done");
    expect(advanceButtonLabel({ isLast: true, photoCount: 1 })).toBe("Done");
  });
});

describe("outgoingPhotoCasesForBatch", () => {
  const scannedNewestFirst = [
    { caseId: "c3", caseNumber: "N3", patientName: "Cara", barcode: "b3" },
    { caseId: "c2", caseNumber: "N2", patientName: "Ben", barcode: "b2" },
    { caseId: "c1", caseNumber: "N1", patientName: "Amy", barcode: "b1" },
  ] as any[];

  it("returns succeeded cases in scan order for the complete station", () => {
    const out = outgoingPhotoCasesForBatch(
      scannedNewestFirst as any,
      ["c1", "c3"],
      "complete",
    );
    expect(out.map((c) => c.caseId)).toEqual(["c1", "c3"]);
    expect(out[0]).toEqual({ caseId: "c1", patientName: "Amy", caseNumber: "N1" });
  });

  it("returns nothing for other stations or when nothing succeeded", () => {
    expect(
      outgoingPhotoCasesForBatch(scannedNewestFirst as any, ["c1"], "polishing"),
    ).toEqual([]);
    expect(
      outgoingPhotoCasesForBatch(scannedNewestFirst as any, [], "complete"),
    ).toEqual([]);
  });
});

describe("eventIsOutgoingPhoto", () => {
  it("detects outgoing category in object and JSON-string metadata", () => {
    expect(
      eventIsOutgoingPhoto({
        eventType: "case_attachment_added",
        metadataJson: { category: "outgoing" },
      }),
    ).toBe(true);
    expect(
      eventIsOutgoingPhoto({
        eventType: "attachment_added",
        metadataJson: JSON.stringify({ category: "outgoing" }),
      }),
    ).toBe(true);
  });

  it("rejects non-attachment events and attachments without the category", () => {
    expect(
      eventIsOutgoingPhoto({
        eventType: "status_changed",
        metadataJson: { category: "outgoing" },
      }),
    ).toBe(false);
    expect(
      eventIsOutgoingPhoto({ eventType: "case_attachment_added", metadataJson: {} }),
    ).toBe(false);
    expect(
      eventIsOutgoingPhoto({ eventType: "case_attachment_added", metadataJson: "not json" }),
    ).toBe(false);
  });
});

// ── Component ─────────────────────────────────────────────────────────────────

const singleCase: OutgoingPhotoCase[] = [
  { caseId: "case-1", patientName: "Jane Doe", caseNumber: "C-100" },
];
const batchCases: OutgoingPhotoCase[] = [
  { caseId: "case-1", patientName: "Jane Doe", caseNumber: "C-100" },
  { caseId: "case-2", patientName: "John Roe", caseNumber: "C-200" },
];

describe("OutgoingPhotosModal", () => {
  it("renders nothing when there are no cases", () => {
    const { queryByTestId } = render(
      <OutgoingPhotosModal cases={[]} onDone={() => {}} />,
    );
    expect(queryByTestId("outgoing-photos-modal")).toBeNull();
  });

  it("declining the prompt calls onDone without uploading", async () => {
    const onDone = vi.fn();
    const { getByTestId, getByText } = render(
      <OutgoingPhotosModal cases={singleCase} onDone={onDone} />,
    );
    expect(getByText("Take a photo of the outgoing case?")).toBeTruthy();
    fireEvent.press(getByTestId("outgoing-photos-decline"));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("accepting shows the guided capture step with patient details", () => {
    const { getByTestId, getByText, queryByTestId } = render(
      <OutgoingPhotosModal cases={singleCase} onDone={() => {}} />,
    );
    fireEvent.press(getByTestId("outgoing-photos-accept"));
    expect(getByTestId("outgoing-photos-patient")).toBeTruthy();
    expect(getByText("Jane Doe")).toBeTruthy();
    expect(getByText("Case #C-100")).toBeTruthy();
    // Single case → no step counter, advance says Done.
    expect(queryByTestId("outgoing-photos-step")).toBeNull();
    expect(getByText("Done")).toBeTruthy();
  });

  it("uploads a captured photo with category 'outgoing' for the current case", async () => {
    cameraMock.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///tmp/raw.jpg" }],
    } as any);
    const { getByTestId, getByText } = render(
      <OutgoingPhotosModal cases={singleCase} onDone={() => {}} />,
    );
    fireEvent.press(getByTestId("outgoing-photos-accept"));
    fireEvent.press(getByTestId("outgoing-photos-take"));

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    const args = uploadMock.mock.calls[0]![0];
    expect(args.caseId).toBe("case-1");
    expect(args.category).toBe("outgoing");
    expect(args.mimeType).toBe("image/jpeg");
    expect(args.fileName).toMatch(/^outgoing-case-C-100-\d+\.jpg$/);
    await waitFor(() => expect(getByText("1 photo saved to this case")).toBeTruthy());
  });

  it("steps through a batch: step counter, Skip case advances, Done finishes", async () => {
    const onDone = vi.fn();
    const { getByTestId, getByText } = render(
      <OutgoingPhotosModal cases={batchCases} onDone={onDone} />,
    );
    expect(getByText("Take photos of the outgoing cases?")).toBeTruthy();
    fireEvent.press(getByTestId("outgoing-photos-accept"));

    expect(getByText("Case 1 of 2")).toBeTruthy();
    expect(getByText("Jane Doe")).toBeTruthy();
    expect(getByText("Skip case")).toBeTruthy();

    fireEvent.press(getByTestId("outgoing-photos-advance"));
    expect(getByText("Case 2 of 2")).toBeTruthy();
    expect(getByText("John Roe")).toBeTruthy();
    expect(getByText("Done")).toBeTruthy();

    fireEvent.press(getByTestId("outgoing-photos-advance"));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("a cancelled camera session uploads nothing", async () => {
    cameraMock.mockResolvedValueOnce({ canceled: true, assets: [] } as any);
    const { getByTestId } = render(
      <OutgoingPhotosModal cases={singleCase} onDone={() => {}} />,
    );
    fireEvent.press(getByTestId("outgoing-photos-accept"));
    fireEvent.press(getByTestId("outgoing-photos-take"));
    await waitFor(() => expect(cameraMock).toHaveBeenCalled());
    expect(uploadMock).not.toHaveBeenCalled();
  });
});
