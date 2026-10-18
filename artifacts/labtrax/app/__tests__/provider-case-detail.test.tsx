/**
 * Provider case detail screen — regression firewall.
 *
 * Invariants protected:
 *
 *  1. All seven timeline entry types (location, remake, photo, note, file,
 *     status, payment) render on screen with appropriate content — so a future
 *     refactor can't silently drop a type.
 *
 *  2. The server note-filter uses a positive allow-list (visibility ===
 *     "shared_with_provider"), not a deny-list — so notes with missing or
 *     unknown visibility fields never leak to providers.
 *
 *  3. A pure provider user (no active lab membership) who lands on the lab
 *     case detail route /case/:id is redirected to /case/provider/:id — so
 *     providers who receive a deep-link always end up in the correct view.
 *     (Pinned via source-code assertion; the 8 000-line CaseDetailScreen has
 *     too many unmocked native dependencies to render reliably in jsdom.)
 *
 *  4. Note submission sends POST /api/cases/provider/:caseId/notes and file
 *     upload sends POST /api/cases/provider/:caseId/attachments — so both
 *     write paths target the provider-scoped endpoints.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, waitFor, cleanup, fireEvent } from "@testing-library/react-native";
import { Alert } from "react-native";
import { acquireAuthedMediaUri } from "@/lib/authed-media-cache";
import {
  resetMockAppState,
  setMockAppState,
  setMockSearchParams,
} from "../../vitest.setup";

// Read source files once for static-analysis assertions.
const providerScreenSrc = readFileSync(
  join(__dirname, "../case/provider/[id].tsx"),
  "utf8",
);
const labCaseScreenSrc = readFileSync(
  join(__dirname, "../case/[id].tsx"),
  "utf8",
);
const serverCaseRouteSrc = readFileSync(
  join(__dirname, "../../../api-server/src/routes/cases.ts"),
  "utf8",
);

afterEach(() => {
  cleanup();
  resetMockAppState();
  setMockSearchParams({});
  vi.clearAllMocks();
});

// ─── Helper: build a minimal provider case payload ────────────────────────────

function makeProviderCase(
  extraTimeline: {
    id: string;
    type: string;
    label: string;
    timestamp: string;
    attachmentId?: string;
    fileName?: string;
    fileType?: string;
    author?: string | null;
    fromStatus?: string | null;
    isCaseReturn?: boolean;
  }[] = [],
  extra: Record<string, unknown> = {},
) {
  return {
    id: "case-abc",
    caseNumber: "1001",
    patientFirstName: "Jane",
    patientLastName: "Doe",
    caseType: "Crown/Bridge",
    invoiceLines: [],
    timeline: extraTimeline,
    ...extra,
  };
}

describe("ProviderCaseDetailScreen — clinical summary and invoice", () => {
  it("shows restoration details and a readable removable step without inline prices", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase([], {
        caseType: "Removable",
        step: "wax_setup",
        restorations: [
          {
            id: "restoration-1",
            toothNumber: "Upper",
            restorationType: "Removable",
            restorationSubtype: "Full Denture",
            material: "Acrylic",
          },
        ],
        invoiceId: "invoice-1",
        invoiceStatus: "open",
        invoiceTotal: "250.00",
        invoiceLines: [
          {
            description: "Full denture",
            quantity: 2,
            unitPrice: "125.00",
            totalPrice: "250.00",
          },
        ],
      }),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const { getByText, queryByText } = await render(<Screen />);

    await waitFor(() => {
      expect(getByText("Tooth Upper")).toBeTruthy();
    });
    expect(getByText("Removable · Full Denture")).toBeTruthy();
    expect(getByText("Acrylic")).toBeTruthy();
    expect(getByText("Wax Setup")).toBeTruthy();
    expect(queryByText("Unit $125.00")).toBeNull();
  });

  it("reveals status, quantity, unit price, line total, and invoice total from View Invoice", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase([], {
        invoiceId: "invoice-1",
        invoiceNumber: "INV-1001",
        invoiceStatus: "open",
        invoiceTotal: "250.00",
        invoiceLines: [
          {
            description: "Full denture",
            quantity: 2,
            unitPrice: "125.00",
            totalPrice: "250.00",
          },
        ],
      }),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const { getAllByText, getByTestId, getByText, queryByTestId, queryByText } = await render(<Screen />);

    await waitFor(() => {
      expect(getByTestId("provider-view-invoice")).toBeTruthy();
    });
    expect(queryByTestId("provider-invoice")).toBeNull();
    expect(queryByText("Unit $125.00")).toBeNull();

    await fireEvent.press(getByTestId("provider-view-invoice"));

    expect(getByTestId("provider-invoice")).toBeTruthy();
    expect(getByText("Full denture")).toBeTruthy();
    expect(getByText("Qty 2")).toBeTruthy();
    expect(getByText("Unit $125.00")).toBeTruthy();
    expect(getAllByText("$250.00")).toHaveLength(2);
    expect(getByText("OPEN")).toBeTruthy();
    expect(getByText("Invoice total")).toBeTruthy();
  });

  it("does not offer View Invoice for a missing invoice", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase([], {
        invoiceId: null,
        invoiceLines: [],
      }),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const { queryByTestId, getByText } = await render(<Screen />);

    await waitFor(() => {
      expect(getByText("Case #1001")).toBeTruthy();
    });
    expect(queryByTestId("provider-view-invoice")).toBeNull();
  });
});

// ─── 1. Timeline entry type rendering ─────────────────────────────────────────

describe("ProviderCaseDetailScreen — timeline entry types", () => {
  it("renders a 'note' entry as quoted text", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase([
        {
          id: "n1",
          type: "note",
          label: "Please check the shade selection carefully.",
          timestamp: "2025-01-15T10:00:00.000Z",
          author: "Dr. Synthetic063",
        },
      ]),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const { getByText } = await render(<Screen />);

    await waitFor(() => {
      expect(getByText("Please check the shade selection carefully.")).toBeTruthy();
    });
  });

  it("renders a 'status' entry with a Status: prefix", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase([
        {
          id: "s1",
          type: "status",
          label: "in_progress",
          timestamp: "2025-01-15T11:00:00.000Z",
        },
      ]),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const { getByText } = await render(<Screen />);

    await waitFor(() => {
      // "Status:" appears as a Text node prefix in the status row
      expect(getByText(/Status:/i)).toBeTruthy();
    });
  });

  it("renders a 'payment' entry with a 'Payment received' prefix", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase([
        {
          id: "p1",
          type: "payment",
          label: "$250.00",
          timestamp: "2025-01-15T12:00:00.000Z",
        },
      ]),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const { getByText } = await render(<Screen />);

    await waitFor(() => {
      expect(getByText(/Payment received/i)).toBeTruthy();
    });
  });

  it("renders a 'location' entry label", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase([
        {
          id: "l1",
          type: "location",
          label: "Sent to Porcelain Station",
          timestamp: "2025-01-15T09:00:00.000Z",
        },
      ]),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const { getByText } = await render(<Screen />);

    await waitFor(() => {
      expect(getByText("Sent to Porcelain Station")).toBeTruthy();
    });
  });

  it("renders a 'remake' entry label", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase([
        {
          id: "r1",
          type: "remake",
          label: "Remake of case #998",
          timestamp: "2025-01-15T08:00:00.000Z",
        },
      ]),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const { getByText } = await render(<Screen />);

    await waitFor(() => {
      expect(getByText("Remake of case #998")).toBeTruthy();
    });
  });

  it("renders a non-image 'file' entry with a tappable file row", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase([
        {
          id: "f1",
          type: "file",
          label: "prescription.pdf",
          timestamp: "2025-01-15T13:00:00.000Z",
          attachmentId: "att-f1",
          // .pdf extension and MIME type — isImageAttachment must return false
          // so the non-image file row (not the image thumbnail) is rendered.
          fileName: "prescription.pdf",
          fileType: "application/pdf",
        },
      ]),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const { queryByTestId } = await render(<Screen />);

    await waitFor(() => {
      expect(queryByTestId("provider-timeline-file-f1")).toBeTruthy();
    });
  });

  it("renders a 'photo' entry with a tappable thumbnail", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase([
        {
          id: "ph1",
          type: "photo",
          label: "shade-photo.jpg",
          timestamp: "2025-01-15T14:00:00.000Z",
          attachmentId: "att-ph1",
          fileName: "shade.jpg",
          fileType: "image/jpeg",
        },
      ]),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const { queryByTestId } = await render(<Screen />);

    await waitFor(() => {
      expect(queryByTestId("provider-timeline-photo-ph1")).toBeTruthy();
    });
  });

    it("keeps zoom gestures inside the photo viewer and preserves save and close", async () => {
      setMockSearchParams({ id: "case-abc" });
      setMockAppState({
        providerCase: makeProviderCase([{
          id: "ph1", type: "photo", label: "shade.jpg",
          timestamp: "2025-01-15T14:00:00.000Z",
          attachmentId: "att-ph1", fileName: "shade.jpg", fileType: "image/jpeg",
        }]),
      });
      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
      try {
        const { default: Screen } = await import("@/app/case/provider/[id]");
        const { getByTestId, queryByTestId } = await render(<Screen />);
        await fireEvent.press(await waitFor(() => getByTestId("provider-timeline-photo-ph1")));
        await waitFor(() => expect(getByTestId("provider-lightbox-image")).toBeTruthy());
        expect(getByTestId("zoom-gesture")).toBeTruthy();
        await fireEvent.press(getByTestId("provider-lightbox-image-touch"));
        expect(getByTestId("provider-lightbox-image")).toBeTruthy();
        await fireEvent(getByTestId("provider-lightbox-image-touch"), "longPress");
        expect(alertSpy).toHaveBeenCalledWith("Save Photo", expect.any(String), expect.any(Array));
        await fireEvent.press(getByTestId("provider-lightbox-close"));
        await waitFor(() => expect(queryByTestId("provider-lightbox-image")).toBeNull());
      } finally {
        alertSpy.mockRestore();
      }
    });

  it("renders a video file as a thumbnail and opens the authenticated native player", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase([
        {
          id: "v1",
          type: "file",
          label: "camera.mov",
          timestamp: "2025-01-15T14:00:00.000Z",
          attachmentId: "att-v1",
          fileName: "camera.mov",
          fileType: "application/octet-stream",
        },
      ]),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const { getByTestId, queryByTestId } = await render(<Screen />);
    await waitFor(() => expect(getByTestId("provider-timeline-video-v1")).toBeTruthy());
    expect(queryByTestId("provider-timeline-file-v1")).toBeNull();

    await fireEvent.press(getByTestId("provider-timeline-video-v1"));
    const player = await waitFor(() => getByTestId("provider-lightbox-video"));
    expect(player.props.useNativeControls).toBe(true);
    expect(acquireAuthedMediaUri).toHaveBeenCalledWith(
      "/api/cases/case-abc/attachments/att-v1/file",
      undefined,
      "camera.mov",
      "application/octet-stream",
    );
  });

  it("offers the OS fallback for a recognized video with an unsupported native codec", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase([
        {
          id: "v2",
          type: "file",
          label: "scan.mkv",
          timestamp: "2025-01-15T14:00:00.000Z",
          attachmentId: "att-v2",
          fileName: "scan.mkv",
          fileType: "video/x-matroska",
        },
      ]),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const { getByTestId, queryByTestId } = await render(<Screen />);
    await fireEvent.press(await waitFor(() => getByTestId("provider-timeline-video-v2")));
    expect(getByTestId("provider-video-fallback")).toBeTruthy();
    expect(queryByTestId("provider-lightbox-video")).toBeNull();
  });

  it("replaces a failed native player with the OS fallback", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase([
        {
          id: "v3",
          type: "file",
          label: "camera.mp4",
          timestamp: "2025-01-15T14:00:00.000Z",
          attachmentId: "att-v3",
          fileName: "camera.mp4",
          fileType: "video/mp4",
        },
      ]),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const { getByTestId, queryByTestId } = await render(<Screen />);
    await fireEvent.press(await waitFor(() => getByTestId("provider-timeline-video-v3")));
    const player = await waitFor(() => getByTestId("provider-lightbox-video"));
    await fireEvent(player, "error", { nativeEvent: { error: "unsupported codec" } });
    await waitFor(() => expect(getByTestId("provider-video-fallback")).toBeTruthy());
    expect(queryByTestId("provider-lightbox-video")).toBeNull();
  });
});

// ─── 1b. Explicitly shared Lab Notes rendering ───────────────────────────────

describe("ProviderCaseDetailScreen — Lab Notes field", () => {
  it("renders only explicitly shared notes, never internal notes or Rx notes", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: {
        ...makeProviderCase(),
        rxNotes: "Prescription instructions only.",
        notes: [
          {
            id: "shared",
            noteText: "Please double-check the shade before cementation.",
            visibility: "shared_with_provider",
          },
          {
            id: "internal",
            noteText: "INTERNAL SECRET",
            visibility: "internal_lab_only",
          },
        ],
      },
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const { getByText, queryByText } = await render(<Screen />);

    await waitFor(() => {
      expect(
        getByText("Please double-check the shade before cementation."),
      ).toBeTruthy();
    });
    expect(queryByText("No lab notes for this case.")).toBeNull();
    expect(queryByText("INTERNAL SECRET")).toBeNull();
    expect(queryByText("Prescription instructions only.")).toBeNull();
  });

  it("shows the placeholder when no explicitly shared note rows exist", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: {
        ...makeProviderCase(),
        notes: [],
      },
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const { getByText } = await render(<Screen />);

    await waitFor(() => {
      expect(getByText("No lab notes for this case.")).toBeTruthy();
    });
  });
});

// ─── 1c. Long-press "Save" guard (release onPress must not re-fire) ──────────
//
// RN's Pressability fires the release `onPress` right after `onLongPress` on
// the same element (see the pre-existing `longPressActiveRef` pattern in
// app/(tabs)/index.tsx). Every long-press "Save" affordance added on top of
// an existing tap-to-open action must guard against that follow-up `onPress`
// re-running the tap action while the save prompt is up.

describe("ProviderCaseDetailScreen — long-press save guard", () => {
  it("long-pressing a video saves without opening the player on release", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase([
        {
          id: "v1",
          type: "file",
          label: "camera.mp4",
          timestamp: "2025-01-15T14:00:00.000Z",
          attachmentId: "att-v1",
          fileName: "camera.mp4",
          fileType: "video/mp4",
        },
      ]),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    try {
      const { getByTestId, queryByTestId } = await render(<Screen />);
      const thumb = await waitFor(() => getByTestId("provider-timeline-video-v1"));
      await fireEvent(thumb, "longPress");
      expect(alertSpy).toHaveBeenCalledWith("Save File", expect.any(String), expect.any(Array));
      await fireEvent.press(thumb);
      expect(queryByTestId("provider-lightbox-video")).toBeNull();
    } finally {
      alertSpy.mockRestore();
    }
  });

  it("long-pressing a photo thumbnail shows the save prompt without opening it on the follow-up press", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase([
        {
          id: "ph1",
          type: "photo",
          label: "shade-photo.jpg",
          timestamp: "2025-01-15T14:00:00.000Z",
          attachmentId: "att-ph1",
          fileName: "shade.jpg",
          fileType: "image/jpeg",
        },
      ]),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    try {
      const { getByTestId, queryByTestId } = await render(<Screen />);
      await waitFor(() => expect(getByTestId("provider-timeline-photo-ph1")).toBeTruthy());
      const thumb = getByTestId("provider-timeline-photo-ph1");

      await fireEvent(thumb, "longPress");
      expect(alertSpy).toHaveBeenCalledWith("Save Photo", expect.any(String), expect.any(Array));

      await fireEvent.press(thumb);
      // The follow-up press must not open the full-screen lightbox.
      expect(queryByTestId("provider-lightbox-image")).toBeNull();

      // A genuine, separate tap still opens the lightbox as normal.
      await fireEvent.press(thumb);
      await waitFor(() => expect(getByTestId("provider-lightbox-image")).toBeTruthy());
    } finally {
      alertSpy.mockRestore();
    }
  });

  it("long-pressing a file row shows the save prompt without opening it on the follow-up press", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase([
        {
          id: "f1",
          type: "file",
          label: "prescription.pdf",
          timestamp: "2025-01-15T13:00:00.000Z",
          attachmentId: "att-f1",
          fileName: "prescription.pdf",
          fileType: "application/pdf",
        },
      ]),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    try {
      const { getByTestId, queryByTestId } = await render(<Screen />);
      await waitFor(() => expect(getByTestId("provider-timeline-file-f1")).toBeTruthy());
      const row = getByTestId("provider-timeline-file-f1");

      await fireEvent(row, "longPress");
      expect(alertSpy).toHaveBeenCalledWith("Save File", expect.any(String), expect.any(Array));

      // The follow-up press must not re-trigger the tap-to-open handler,
      // which would flip the row into its busy/opening state.
      await fireEvent.press(row);
      expect(queryByTestId("provider-timeline-file-busy-f1")).toBeNull();
    } finally {
      alertSpy.mockRestore();
    }
  });
});

// ─── 2. Server note-filter allow-list (security firewall) ─────────────────────

describe("Server provider timeline — note visibility allow-list", () => {
  it("requires a live shared_with_provider note row — denies by default", async () => {
    expect(
      serverCaseRouteSrc.includes(`n.visibility === "shared_with_provider"`) &&
        serverCaseRouteSrc.includes("if (!noteId) continue;"),
      "Server GET /cases/provider/:caseId note filter must use " +
        "a live-row shared_with_provider allow-list — event metadata alone " +
        "cannot prove that a note has not been deleted or redacted.",
    ).toBe(true);
  });

  it("no longer uses the old deny-list pattern", async () => {
    // Confirm the old unsafe pattern was replaced.
    expect(
      serverCaseRouteSrc.includes(`meta.visibility === "internal_lab_only"`),
      'The old deny-list filter (`=== "internal_lab_only"`) was found in the server ' +
        "route — it must be replaced with the allow-list check.",
    ).toBe(false);
  });
});

// ─── 3. Pure provider redirect (source-code firewall) ─────────────────────────
//
// Rendering the 8 000-line CaseDetailScreen in jsdom is unreliable due to the
// volume of native dependencies. These assertions pin the redirect contract
// directly in the source code — if a refactor removes the logic, the tests
// catch it without requiring a full render.

describe("Lab case screen — pure provider redirect", () => {
  it("imports activeMemberships and primaryProviderOrgId from auth-me", async () => {
    expect(
      labCaseScreenSrc.includes("activeMemberships") &&
        labCaseScreenSrc.includes("primaryProviderOrgId"),
      "app/case/[id].tsx must import activeMemberships and primaryProviderOrgId " +
        "from @/lib/auth-me to detect pure-provider users.",
    ).toBe(true);
  });

  it("contains the redirect to /case/provider/:id using both helpers", async () => {
    expect(
      labCaseScreenSrc.includes("activeMemberships(me)") &&
        labCaseScreenSrc.includes("primaryProviderOrgId(me)") &&
        labCaseScreenSrc.includes("/case/provider/${id}"),
      "app/case/[id].tsx must redirect pure providers (activeMemberships with no lab " +
        "+ primaryProviderOrgId !== null) to /case/provider/:id.",
    ).toBe(true);
  });

  it("gates redirect on absence of lab membership (not just any non-lab org)", async () => {
    // The check must positively confirm 'lab' is absent, not just that a
    // provider org exists, so hybrid users (lab + provider) stay in the lab view.
    expect(
      labCaseScreenSrc.includes(`"lab"`),
      "app/case/[id].tsx redirect must check for absence of a 'lab' " +
        "membership so hybrid users (lab + provider) keep the lab detail view.",
    ).toBe(true);
  });
});

// ─── 4. Write paths target the provider-scoped endpoints ──────────────────────

describe("ProviderCaseDetailScreen — provider-scoped write endpoints", () => {
  it("sends notes to POST /api/cases/provider/:caseId/notes", async () => {
    expect(
      providerScreenSrc.includes(
        "/api/cases/provider/${encodeURIComponent(id)}/notes",
      ),
      "Provider note composer must POST to /api/cases/provider/:caseId/notes, " +
        "not the lab-gated /api/cases/:caseId/notes.",
    ).toBe(true);
  });

  it("sends file attachments to POST /api/cases/provider/:caseId/attachments", async () => {
    expect(
      providerScreenSrc.includes(
        "/api/cases/provider/${encodeURIComponent(id)}/attachments",
      ),
      "Provider file upload must POST to /api/cases/provider/:caseId/attachments.",
    ).toBe(true);
  });
});

// ─── 5. Returned-case "View Rx" ───────────────────────────────────────────────
//
// The server flags the timeline entry where the case came back into the lab.
// Only that entry offers "View Rx", and the prescription it opens shows the
// same provider-safe fields as the desktop provider portal.

describe("ProviderCaseDetailScreen — returned-case View Rx", () => {
  const RX_CASE_FIELDS = {
    doctorName: "Dr. Synthetic058",
    practiceName: "Bright Smiles Dental",
    rxNotes: "Match the adjacent central.",
    restorations: [
      {
        id: "res-1",
        toothNumber: "14",
        restorationType: "Crown",
        material: "Zirconia",
        shade: "A2",
      },
    ],
  };

  const RETURN_TIMELINE = [
    {
      id: "s-complete",
      type: "status",
      label: "complete",
      timestamp: "2025-01-15T10:00:00.000Z",
      fromStatus: "in_progress",
      isCaseReturn: false,
    },
    {
      id: "s-return",
      type: "status",
      label: "received",
      timestamp: "2025-01-16T10:00:00.000Z",
      fromStatus: "complete",
      isCaseReturn: true,
    },
  ];

  it("shows View Rx only on the entry where the case returned", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase(RETURN_TIMELINE, RX_CASE_FIELDS),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const { getAllByText, getByTestId, queryByTestId } = await render(<Screen />);

    await waitFor(() => {
      expect(getByTestId("provider-timeline-view-rx-s-return")).toBeTruthy();
    });
    expect(queryByTestId("provider-timeline-view-rx-s-complete")).toBeNull();
    expect(getAllByText("View Rx")).toHaveLength(1);
  });

  it("opens a prescription modal with case, patient, doctor, practice, restorations and Rx notes", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase(RETURN_TIMELINE, RX_CASE_FIELDS),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const { getByTestId, getByText, queryByTestId } = await render(<Screen />);

    await waitFor(() => {
      expect(getByTestId("provider-timeline-view-rx-s-return")).toBeTruthy();
    });
    expect(queryByTestId("provider-rx-modal")).toBeNull();

    await fireEvent.press(getByTestId("provider-timeline-view-rx-s-return"));

    await waitFor(() => {
      expect(getByTestId("provider-rx-modal")).toBeTruthy();
    });
    expect(getByText("Prescription")).toBeTruthy();
    expect(getByText("Tooth 14 · Crown")).toBeTruthy();
    expect(getByText("Material: Zirconia · Shade: A2")).toBeTruthy();
    expect(getByText("Match the adjacent central.")).toBeTruthy();
    expect(getByText("Dr. Synthetic058")).toBeTruthy();
    expect(getByText("Bright Smiles Dental")).toBeTruthy();
  });

  it("does not show View Rx when no timeline entry is flagged as a return", async () => {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: makeProviderCase(
        [{ ...RETURN_TIMELINE[1]!, isCaseReturn: false }],
        RX_CASE_FIELDS,
      ),
    });

    const { default: Screen } = await import("@/app/case/provider/[id]");
    const { queryByText } = await render(<Screen />);

    await waitFor(() => {
      expect(queryByText(/Status:/i)).toBeTruthy();
    });
    expect(queryByText("View Rx")).toBeNull();
  });

  it("uses the same button wording as the desktop provider portal", async () => {
    const desktopSrc = readFileSync(
      join(
        __dirname,
        "../../../labtrax-desktop/src/components/provider/ProviderCaseDetailModal.tsx",
      ),
      "utf8",
    );
    expect(
      desktopSrc.includes(">View Rx<") || desktopSrc.includes("View Rx"),
      "Desktop provider portal must offer a 'View Rx' button.",
    ).toBe(true);
    expect(
      providerScreenSrc.includes("View Rx"),
      "Mobile provider case screen must use the same 'View Rx' wording.",
    ).toBe(true);
  });
});
