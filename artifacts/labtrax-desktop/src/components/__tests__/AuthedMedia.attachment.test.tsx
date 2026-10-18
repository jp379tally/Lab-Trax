/** @vitest-environment jsdom */
/**
 * Regression guard: desktop case photos render through authenticated media.
 *
 * Protected workflow: "Desktop Case Photo Cross-Platform Visibility"
 *
 * Case photos are served from the bearer-auth-gated canonical endpoint
 *   GET /api/cases/:caseId/attachments/:attachmentId/file
 * A plain <img src="…/file"> can't attach the Authorization header, so the
 * browser request 401s and the image renders blank — this is exactly the
 * "photos show on web/mobile but are blank on desktop" bug this test locks
 * against.
 *
 * The invariant enforced here:
 *   1. AuthedImage (used by every desktop attachment surface — AttachmentRow,
 *      the Files tab, the image lightbox, history-event thumbnails, and
 *      PrescriptionPreview) fetches the canonical /file URL WITH a bearer
 *      token via authedMediaFetch, turns the bytes into an object URL, and renders
 *      that object URL.
 *   2. The rendered <img> src is the blob object URL — NEVER the raw protected
 *      /api/…/file URL. A protected attachment image must not be rendered
 *      through a plain unauthenticated <img src>.
 *
 * Keep this test permanently per the REGRESSION_GUARDRAILS.md policy.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the api layer AuthedMedia depends on so we can observe exactly which
// URL is fetched and with what auth, without a real network or token store.
const authedMediaFetch = vi.fn();
const getApiOrigin = vi.fn(() => "https://api.labtrax.example");
const waitForTokenHydration = vi.fn(async () => {});

const apiFetch = vi.fn();

vi.mock("@/lib/api", () => ({
  authedMediaFetch: (...args: unknown[]) => authedMediaFetch(...args),
  getApiOrigin: () => getApiOrigin(),
  waitForTokenHydration: () => waitForTokenHydration(),
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import {
  AuthedImage,
  buildCaseMediaGallery,
  MediaLightbox,
  isLikelyBrowserPlayableVideo,
} from "../AuthedMedia";
import { AttachmentThumb, HistoryEventMedia } from "../PrescriptionPreview";
import type { CaseAttachment } from "@/lib/types";
import {
  migratedLegacyPhotoContract,
  migratedLegacyVideoContract,
} from "@workspace/legacy-case-media-contract";

const CASE_ID = "case_abc123";
const ATTACHMENT_ID = "att_photo_9";
const FILE_URL = `https://api.labtrax.example/api/cases/${CASE_ID}/attachments/${ATTACHMENT_ID}/file`;
const BLOB_URL = "blob:labtrax/desktop-photo";

let origCreate: typeof URL.createObjectURL | undefined;
let origRevoke: typeof URL.revokeObjectURL | undefined;

beforeEach(() => {
  authedMediaFetch.mockReset();
  authedMediaFetch.mockResolvedValue(
    new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), {
      status: 200,
    }),
  );
  // jsdom does not implement object URLs. Attach the mocks onto the real URL
  // constructor rather than replacing it, so `new URL(...)` (used by
  // isSameApiOrigin) keeps working.
  origCreate = URL.createObjectURL;
  origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => BLOB_URL) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
});

afterEach(() => {
  URL.createObjectURL = origCreate as typeof URL.createObjectURL;
  URL.revokeObjectURL = origRevoke as typeof URL.revokeObjectURL;
});

describe("AuthedImage — desktop case attachment photo", () => {
  it("fetches the canonical /file endpoint with auth and renders the object URL (not the raw protected URL)", async () => {
    render(<AuthedImage url={FILE_URL} alt="prescription-photo.jpg" />);

    // The canonical, bearer-authed fetch must run against the /file endpoint.
    await waitFor(() => expect(authedMediaFetch).toHaveBeenCalledTimes(1));
    expect(authedMediaFetch.mock.calls[0]?.[0]).toBe(FILE_URL);

    // Once the bytes resolve, an <img> appears whose src is the blob object
    // URL produced from the authenticated response — never the raw /file URL.
    const img = await screen.findByAltText("prescription-photo.jpg");
    expect(img.tagName).toBe("IMG");
    expect(img).toHaveAttribute("src", BLOB_URL);
    expect(img.getAttribute("src")).not.toBe(FILE_URL);
  });

  it("never renders a plain <img> pointed at the protected /file URL", async () => {
    const { container } = render(
      <AuthedImage url={FILE_URL} alt="prescription-photo.jpg" />,
    );

    await screen.findByAltText("prescription-photo.jpg");

    // No element in the tree may reference the protected endpoint directly —
    // that would 401 and render blank for authenticated desktop users.
    const rawSrc = container.querySelector(`img[src="${FILE_URL}"]`);
    expect(rawSrc).toBeNull();
  });

  it("shows the fallback (no <img>) when the authenticated fetch fails", async () => {
    authedMediaFetch.mockResolvedValueOnce(new Response("", { status: 401 }));

    render(
      <AuthedImage
        url={FILE_URL}
        alt="prescription-photo.jpg"
        fallback={<div data-testid="photo-unavailable" />}
      />,
    );

    await screen.findByTestId("photo-unavailable");
    expect(screen.queryByAltText("prescription-photo.jpg")).toBeNull();
  });
});

// Proving AuthedImage itself is safe (above) is not enough: a refactor could
// swap AuthedImage for a plain <img src={fileUrl}> inside the REAL attachment
// surface and the AuthedImage-only guard would not catch it. This block mounts
// the actual Files-tab / prescription-preview thumbnail component that ships to
// users and asserts it wires the canonical /file endpoint through AuthedImage.
describe("AttachmentThumb — real desktop Files-tab attachment surface", () => {
  const imageAttachment: CaseAttachment = {
    id: ATTACHMENT_ID,
    caseId: CASE_ID,
    uploadedByUserId: "user_1",
    uploadedByOrganizationId: "org_1",
    fileName: "prescription-photo.jpg",
    storageKey: "case-media/prescription-photo.jpg",
    fileType: "image/jpeg",
  };

  it("renders an image attachment through AuthedImage against the canonical /file endpoint", async () => {
    render(
      <AttachmentThumb
        caseId={CASE_ID}
        attachment={imageAttachment}
        onLightbox={() => {}}
      />,
    );

    // The real surface builds the canonical /file URL and hands it to
    // AuthedImage, which performs the bearer-authed fetch.
    await waitFor(() => expect(authedMediaFetch).toHaveBeenCalledTimes(1));
    expect(authedMediaFetch.mock.calls[0]?.[0]).toBe(FILE_URL);

    // The visible <img> src is the blob object URL, not the protected /file URL.
    const img = await screen.findByAltText("prescription-photo.jpg");
    expect(img.tagName).toBe("IMG");
    expect(img).toHaveAttribute("src", BLOB_URL);
    expect(img.getAttribute("src")).not.toBe(FILE_URL);
  });

  it("never renders a plain <img> pointed at the protected /file URL", async () => {
    const { container } = render(
      <AttachmentThumb
        caseId={CASE_ID}
        attachment={imageAttachment}
        onLightbox={() => {}}
      />,
    );

    await screen.findByAltText("prescription-photo.jpg");

    // A plain <img src="…/file"> here would 401 and render blank on desktop —
    // exactly the regression this guard exists to prevent.
    const rawSrc = container.querySelector(`img[src="${FILE_URL}"]`);
    expect(rawSrc).toBeNull();
  });

  it("shows the Unavailable fallback (no <img>) when the authenticated fetch fails", async () => {
    authedMediaFetch.mockResolvedValueOnce(new Response("", { status: 401 }));

    render(
      <AttachmentThumb
        caseId={CASE_ID}
        attachment={imageAttachment}
        onLightbox={() => {}}
      />,
    );

    await screen.findByText("Unavailable");
    expect(screen.queryByAltText("prescription-photo.jpg")).toBeNull();
    expect(document.querySelector(`img[src="${FILE_URL}"]`)).toBeNull();
  });

});

// The history timeline renders inline thumbnails for attachments referenced
// from a case event's metadata. This is a REAL user-facing surface: a refactor
// swapping AuthedImage for a plain <img src={apiSrc}> here would render every
// history-event photo blank for authenticated desktop users, and nothing else
// would catch it.
describe("HistoryEventMedia — real desktop history-timeline thumbnail surface", () => {
  const imageMetadata: Record<string, unknown> = {
    attachmentId: ATTACHMENT_ID,
    fileType: "image/jpeg",
    fileName: "prescription-photo.jpg",
  };

  it("renders an image attachment through AuthedImage against the canonical /file endpoint", async () => {
    render(
      <HistoryEventMedia
        caseId={CASE_ID}
        metadata={imageMetadata}
        onLightbox={() => {}}
      />,
    );

    // The real surface derives the canonical /file URL from the event metadata
    // and hands it to AuthedImage, which performs the bearer-authed fetch.
    await waitFor(() => expect(authedMediaFetch).toHaveBeenCalledTimes(1));
    expect(authedMediaFetch.mock.calls[0]?.[0]).toBe(FILE_URL);

    const img = await screen.findByAltText("prescription-photo.jpg");
    expect(img.tagName).toBe("IMG");
    expect(img).toHaveAttribute("src", BLOB_URL);
    expect(img.getAttribute("src")).not.toBe(FILE_URL);
  });

  it("never renders a plain <img> pointed at the protected /file URL", async () => {
    const { container } = render(
      <HistoryEventMedia
        caseId={CASE_ID}
        metadata={imageMetadata}
        onLightbox={() => {}}
      />,
    );

    await screen.findByAltText("prescription-photo.jpg");

    const rawSrc = container.querySelector(`img[src="${FILE_URL}"]`);
    expect(rawSrc).toBeNull();
  });

  it("shows the Unavailable fallback (no <img>) when the authenticated fetch fails", async () => {
    authedMediaFetch.mockResolvedValueOnce(new Response("", { status: 401 }));

    render(
      <HistoryEventMedia
        caseId={CASE_ID}
        metadata={imageMetadata}
        onLightbox={() => {}}
      />,
    );

    await screen.findByText("Unavailable");
    expect(screen.queryByAltText("prescription-photo.jpg")).toBeNull();
    expect(document.querySelector(`img[src="${FILE_URL}"]`)).toBeNull();
  });

  it("keeps repeated and distinct migrated attachment-file photos visible through authenticated object URLs", async () => {
    const [firstEvent, secondEvent] = migratedLegacyPhotoContract.events;
    const repeatedUrl = firstEvent!.metadataJson.imageUri;
    const distinctUrl = secondEvent!.metadataJson.imageUri;
    authedMediaFetch.mockImplementation(async () =>
      new Response(
        new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
        { status: 200 },
      ),
    );
    vi.mocked(URL.createObjectURL)
      .mockReturnValueOnce("blob:labtrax/migrated-occlusal-gallery")
      .mockReturnValueOnce("blob:labtrax/migrated-occlusal-history")
      .mockReturnValueOnce("blob:labtrax/migrated-buccal");

    render(
      <>
        <HistoryEventMedia
          caseId={CASE_ID}
          metadata={{
            ...firstEvent!.metadataJson,
          }}
          onLightbox={() => {}}
        />
        <HistoryEventMedia
          caseId={CASE_ID}
          metadata={{
            ...firstEvent!.metadataJson,
            fileName: "migrated-occlusal-history.jpg",
          }}
          onLightbox={() => {}}
        />
        <HistoryEventMedia
          caseId={CASE_ID}
          metadata={{
            ...secondEvent!.metadataJson,
          }}
          onLightbox={() => {}}
        />
      </>,
    );

    await waitFor(() => expect(authedMediaFetch).toHaveBeenCalledTimes(3));
    expect(authedMediaFetch.mock.calls.map(([url]) => url)).toEqual([
      repeatedUrl,
      repeatedUrl,
      distinctUrl,
    ]);
    expect(
      await screen.findByAltText(firstEvent!.metadataJson.fileName),
    ).toHaveAttribute(
      "src",
      "blob:labtrax/migrated-occlusal-gallery",
    );
    expect(
      await screen.findByAltText("migrated-occlusal-history.jpg"),
    ).toHaveAttribute("src", "blob:labtrax/migrated-occlusal-history");
    expect(
      await screen.findByAltText(secondEvent!.metadataJson.fileName),
    ).toHaveAttribute(
      "src",
      "blob:labtrax/migrated-buccal",
    );
  });

  it("plays projected legacy videos from gallery and history with authenticated relative references", async () => {
    const { caseId, attachments, events } = migratedLegacyVideoContract;
    const onLightbox = vi.fn();
    authedMediaFetch.mockResolvedValue(
      new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" }), {
        status: 200,
      }),
    );
    const gallery = buildCaseMediaGallery(
      caseId,
      attachments.map((attachment) => ({
        ...attachment,
        uploadedByUserId: "legacy-owner",
        uploadedByOrganizationId: "legacy-lab",
      })),
    );
    expect(gallery.map((item) => item.kind)).toEqual(["video", "video"]);
    expect(gallery.map((item) => item.attachmentId)).toEqual(
      attachments.map((attachment) => attachment.id),
    );

    render(
      <>
        {events.map((event) => (
          <HistoryEventMedia
            key={event.id}
            caseId={caseId}
            metadata={event.metadataJson}
            onLightbox={onLightbox}
          />
        ))}
      </>,
    );
    const first = await screen.findByTitle(`Play ${events[0]!.metadataJson.fileName}`);
    await waitFor(() => expect(first.querySelector("video")).not.toBeNull());
    await waitFor(() =>
      expect(authedMediaFetch.mock.calls.map(([url]) => url)).toEqual(
        events.map((event) => event.metadataJson.imageUri),
      ),
    );
    fireEvent.click(first);
    expect(onLightbox).toHaveBeenCalledWith(
      expect.objectContaining({
        url: events[0]!.metadataJson.imageUri,
        kind: "video",
        mimeType: "video/mp4",
      }),
    );
  });

  it("classifies an octet-stream mp4 history attachment as video", async () => {
    const onLightbox = vi.fn();
    render(
      <HistoryEventMedia
        caseId={CASE_ID}
        metadata={{
          attachmentId: "att_clip",
          fileType: "application/octet-stream",
          fileName: "clip.mp4",
        }}
        onLightbox={onLightbox}
      />,
    );

    const video = await screen.findByTitle("Play clip.mp4");
    expect(video.querySelector("video")).not.toBeNull();
    fireEvent.click(video);
    expect(onLightbox).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentId: "att_clip",
        kind: "video",
      }),
    );
  });
});

// The full-size lightbox (shared by cases.tsx and PrescriptionPreview.tsx) is
// the surface where a blank photo is most obvious to the user: they clicked a
// thumbnail expecting the full image. It must render the protected /file bytes
// through AuthedImage, never a plain <img src="…/file"> that would 401.
describe("MediaLightbox — real desktop full-size image lightbox surface", () => {
  it("renders the full-size image through AuthedImage against the canonical /file endpoint", async () => {
    render(
      <MediaLightbox
        lightbox={{ url: FILE_URL, kind: "image" }}
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(authedMediaFetch).toHaveBeenCalledTimes(1));
    expect(authedMediaFetch.mock.calls[0]?.[0]).toBe(FILE_URL);

    const img = await screen.findByAltText("Preview");
    expect(img.tagName).toBe("IMG");
    expect(img).toHaveAttribute("src", BLOB_URL);
    expect(img.getAttribute("src")).not.toBe(FILE_URL);
  });

  it("never renders a plain <img> pointed at the protected /file URL", async () => {
    const { container } = render(
      <MediaLightbox
        lightbox={{ url: FILE_URL, kind: "image" }}
        onClose={() => {}}
      />,
    );

    await screen.findByAltText("Preview");

    const rawSrc = container.querySelector(`img[src="${FILE_URL}"]`);
    expect(rawSrc).toBeNull();
  });

  it("zooms around the pointer only while Ctrl is held and stays within its bounds", async () => {
    render(
      <MediaLightbox
        lightbox={{ url: FILE_URL, kind: "image" }}
        onClose={() => {}}
      />,
    );
    const img = await screen.findByAltText("Preview");
    vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 50,
      width: 400,
      height: 200,
      right: 500,
      bottom: 250,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    });

    const ordinaryWheel = new WheelEvent("wheel", {
      deltaY: -100,
      clientX: 200,
      clientY: 100,
      bubbles: true,
      cancelable: true,
    });
    act(() => img.dispatchEvent(ordinaryWheel));
    expect(ordinaryWheel.defaultPrevented).toBe(false);
    expect(img).toHaveStyle({
      transform: "translate3d(0px, 0px, 0) scale(1)",
    });

    const zoomWheel = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: -100,
      clientX: 200,
      clientY: 100,
      bubbles: true,
      cancelable: true,
    });
    act(() => img.dispatchEvent(zoomWheel));
    expect(zoomWheel.defaultPrevented).toBe(true);
    expect(img).toHaveStyle({
      transform: "translate3d(0px, 0px, 0) scale(1.25)",
      transformOrigin: "25% 25%",
    });

    for (let i = 0; i < 20; i += 1) {
      fireEvent.wheel(img, { ctrlKey: true, deltaY: -100 });
    }
    expect(img).toHaveStyle({
      transform: "translate3d(0px, 0px, 0) scale(5)",
    });

    for (let i = 0; i < 30; i += 1) {
      fireEvent.wheel(img, { ctrlKey: true, deltaY: 100 });
    }
    expect(img).toHaveStyle({
      transform: "translate3d(0px, 0px, 0) scale(1)",
    });
  });

  it("recenters a dragged image without changing zoom or closing the preview, then resets when switching images", async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <MediaLightbox
        lightbox={{ url: FILE_URL, kind: "image" }}
        onClose={onClose}
      />,
    );
    let img = await screen.findByAltText("Preview");
    const backdrop = screen.getByTestId("media-lightbox-backdrop");

    vi.spyOn(backdrop, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(img, "getBoundingClientRect").mockImplementation(() => {
      const match = img.style.transform.match(
        /translate3d\((-?\d+)px, (-?\d+)px/,
      );
      const panX = Number(match?.[1] ?? 0);
      const panY = Number(match?.[2] ?? 0);
      return {
        left: 100 + panX,
        top: 100 + panY,
        width: 600,
        height: 400,
        right: 700 + panX,
        bottom: 500 + panY,
        x: 100 + panX,
        y: 100 + panY,
        toJSON: () => ({}),
      };
    });
    fireEvent.wheel(img, { ctrlKey: true, deltaY: -100 });
    expect(img).toHaveStyle({
      transform: "translate3d(0px, 0px, 0) scale(1.25)",
    });

    fireEvent.pointerDown(img, {
      pointerId: 1,
      button: 0,
      clientX: 300,
      clientY: 250,
    });
    fireEvent.pointerMove(img, {
      pointerId: 1,
      clientX: 1300,
      clientY: 1250,
    });
    fireEvent.pointerUp(img, { pointerId: 1 });
    expect(img).toHaveStyle({
      // The original left/top (100px each) plus the clamped translation leaves
      // exactly 40px visible at the viewport's right and bottom edges.
      transform: "translate3d(660px, 460px, 0) scale(1.25)",
    });

    const recenterButton = screen.getByRole("button", {
      name: "Recenter image",
    });
    expect(recenterButton).toHaveClass("z-10");
    fireEvent.click(recenterButton);
    expect(img).toHaveStyle({
      transform: "translate3d(0px, 0px, 0) scale(1.25)",
      transformOrigin: "50% 50%",
    });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.wheel(img, { ctrlKey: true, deltaY: 100 });
    expect(img).toHaveStyle({
      transform: "translate3d(0px, 0px, 0) scale(1)",
    });

    authedMediaFetch.mockResolvedValueOnce(
      new Response(new Blob([new Uint8Array([4, 5, 6])], { type: "image/jpeg" }), {
        status: 200,
      }),
    );
    rerender(
      <MediaLightbox
        lightbox={{ url: `${FILE_URL}?next=1`, kind: "image" }}
        onClose={() => {}}
      />,
    );
    img = await screen.findByAltText("Preview");
    await waitFor(() =>
      expect(img).toHaveStyle({
        transform: "translate3d(0px, 0px, 0) scale(1)",
      }),
    );
    expect(img).toHaveStyle({
      transformOrigin: "50% 50%",
      cursor: "default",
    });
  });

  it("pans a focused zoomed image with arrow keys and keeps 40 pixels visible", async () => {
    render(
      <MediaLightbox
        lightbox={{ url: FILE_URL, kind: "image" }}
        onClose={() => {}}
      />,
    );
    const img = await screen.findByAltText("Preview");
    const backdrop = screen.getByTestId("media-lightbox-backdrop");

    vi.spyOn(backdrop, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(img, "getBoundingClientRect").mockImplementation(() => {
      const match = img.style.transform.match(
        /translate3d\((-?\d+)px, (-?\d+)px/,
      );
      const panX = Number(match?.[1] ?? 0);
      const panY = Number(match?.[2] ?? 0);
      return {
        left: 100 + panX,
        top: 100 + panY,
        width: 600,
        height: 400,
        right: 700 + panX,
        bottom: 500 + panY,
        x: 100 + panX,
        y: 100 + panY,
        toJSON: () => ({}),
      };
    });

    expect(img).not.toHaveAttribute("tabindex");
    const zoomInButton = screen.getByRole("button", { name: "Zoom in" });
    zoomInButton.focus();
    expect(zoomInButton).toHaveFocus();
    fireEvent.keyDown(zoomInButton, { key: "Enter" });
    fireEvent.click(zoomInButton);
    expect(img).toHaveAttribute("tabindex", "0");
    img.focus();
    expect(img).toHaveFocus();

    const arrowRight = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    act(() => img.dispatchEvent(arrowRight));
    expect(arrowRight.defaultPrevented).toBe(true);
    expect(img).toHaveStyle({
      transform: "translate3d(40px, 0px, 0) scale(1.25)",
    });

    for (let i = 0; i < 30; i += 1) {
      fireEvent.keyDown(img, { key: "ArrowRight" });
      fireEvent.keyDown(img, { key: "ArrowDown" });
    }
    expect(img).toHaveStyle({
      transform: "translate3d(660px, 460px, 0) scale(1.25)",
    });

    for (let i = 0; i < 40; i += 1) {
      fireEvent.keyDown(img, { key: "ArrowLeft" });
      fireEvent.keyDown(img, { key: "ArrowUp" });
    }
    expect(img).toHaveStyle({
      transform: "translate3d(-660px, -460px, 0) scale(1.25)",
    });
  });

  it("lets keyboard users zoom between 1x and 5x without closing the preview", async () => {
    const onClose = vi.fn();
    render(
      <MediaLightbox
        lightbox={{ url: FILE_URL, kind: "image" }}
        onClose={onClose}
      />,
    );
    const img = await screen.findByAltText("Preview");
    const zoomInButton = screen.getByRole("button", { name: "Zoom in" });
    const zoomOutButton = screen.getByRole("button", { name: "Zoom out" });

    expect(zoomOutButton).toBeDisabled();
    for (let i = 0; i < 20; i += 1) {
      zoomInButton.focus();
      fireEvent.keyDown(zoomInButton, { key: "Enter" });
      fireEvent.click(zoomInButton);
    }
    expect(img).toHaveStyle({
      transform: "translate3d(0px, 0px, 0) scale(5)",
    });
    expect(zoomInButton).toBeDisabled();

    for (let i = 0; i < 20; i += 1) {
      zoomOutButton.focus();
      fireEvent.keyDown(zoomOutButton, { key: "Enter" });
      fireEvent.click(zoomOutButton);
    }
    expect(img).toHaveStyle({
      transform: "translate3d(0px, 0px, 0) scale(1)",
    });
    expect(zoomOutButton).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("navigates a mixed case gallery by attachment identity and disables boundary arrows", async () => {
    authedMediaFetch.mockImplementation(async () =>
      new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), {
        status: 200,
      }),
    );
    const gallery = [
      {
        attachmentId: "att-photo",
        url: `${FILE_URL}?photo`,
        kind: "image" as const,
        fileName: "photo.jpg",
      },
      {
        attachmentId: "att-video",
        url: `${FILE_URL}?video`,
        kind: "video" as const,
        mimeType: "video/mp4",
        fileName: "clip.mp4",
      },
      {
        attachmentId: "att-photo-2",
        url: `${FILE_URL}?photo-2`,
        kind: "image" as const,
        fileName: "photo-2.jpg",
      },
    ];
    render(
      <MediaLightbox
        lightbox={{ ...gallery[1], gallery }}
        onClose={() => {}}
      />,
    );

    expect(screen.getByTestId("media-lightbox-position")).toHaveTextContent("2 / 3");
    expect(screen.getByRole("button", { name: "Previous media" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Next media" })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next media" }));
    const imageAfterVideo = await screen.findByAltText("Preview");
    fireEvent.wheel(imageAfterVideo, { ctrlKey: true, deltaY: -100 });
    expect(imageAfterVideo).toHaveStyle({
      transform: "translate3d(0px, 0px, 0) scale(1.25)",
    });
    expect(screen.getByTestId("media-lightbox-position")).toHaveTextContent("3 / 3");
    expect(screen.getByRole("button", { name: "Next media" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Previous media" }));
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    expect(screen.getByTestId("media-lightbox-position")).toHaveTextContent("2 / 3");
    fireEvent.click(screen.getByRole("button", { name: "Previous media" }));
    const imageAfterSecondVideo = await screen.findByAltText("Preview");
    fireEvent.wheel(imageAfterSecondVideo, { ctrlKey: true, deltaY: -100 });
    expect(imageAfterSecondVideo).toHaveStyle({
      transform: "translate3d(0px, 0px, 0) scale(1.25)",
    });
    expect(screen.getByTestId("media-lightbox-position")).toHaveTextContent("1 / 3");
  });

  it("uses arrows for navigation at normal scale but keeps arrows as pan controls while zoomed", async () => {
    authedMediaFetch.mockImplementation(async () =>
      new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), {
        status: 200,
      }),
    );
    const gallery = [
      {
        attachmentId: "att-photo",
        url: `${FILE_URL}?photo`,
        kind: "image" as const,
        fileName: "photo.jpg",
      },
      {
        attachmentId: "att-photo-2",
        url: `${FILE_URL}?photo-2`,
        kind: "image" as const,
        fileName: "photo-2.jpg",
      },
    ];
    render(
      <MediaLightbox
        lightbox={{ ...gallery[0], gallery }}
        onClose={() => {}}
      />,
    );
    await screen.findByAltText("Preview");
    const arrowRight = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    act(() => window.dispatchEvent(arrowRight));
    expect(arrowRight.defaultPrevented).toBe(true);
    expect(screen.getByTestId("media-lightbox-position")).toHaveTextContent("2 / 2");

    // Return to the first image, zoom it, and verify ArrowRight pans rather
    // than advancing to the next gallery item.
    fireEvent.click(screen.getByRole("button", { name: "Previous media" }));
    const currentImage = await screen.findByAltText("Preview");
    vi.spyOn(currentImage, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 100,
      width: 600,
      height: 400,
      right: 700,
      bottom: 500,
      x: 100,
      y: 100,
      toJSON: () => ({}),
    });
    vi.spyOn(screen.getByTestId("media-lightbox-backdrop"), "getBoundingClientRect")
      .mockReturnValue({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    currentImage.focus();
    fireEvent.keyDown(currentImage, { key: "ArrowRight" });
    expect(screen.getByTestId("media-lightbox-position")).toHaveTextContent("1 / 2");
    expect(currentImage).toHaveStyle({
      transform: "translate3d(40px, 0px, 0) scale(1.25)",
    });
  });

  it("closes instead of falling back to the original item when the selected item disappears on refresh", async () => {
    const onClose = vi.fn();
    const onActiveItemChange = vi.fn();
    const gallery = [
      { attachmentId: "att_a", url: "blob:a", kind: "image" as const },
      { attachmentId: "att_b", url: "blob:b", kind: "image" as const },
    ];
    const { rerender } = render(
      <MediaLightbox
        lightbox={{ ...gallery[0]!, gallery }}
        activeItemIdentity="att_a"
        onActiveItemChange={onActiveItemChange}
        onClose={onClose}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Next media" }));
    expect(onActiveItemChange).toHaveBeenCalledWith("att_b");

    rerender(
      <MediaLightbox
        lightbox={{ ...gallery[0]!, gallery: [gallery[0]!] }}
        activeItemIdentity="att_b"
        onActiveItemChange={onActiveItemChange}
        onClose={onClose}
      />,
    );

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByAltText("Preview")).toBeNull();
  });

  it("builds a stable gallery from case attachments while excluding documents and 3D scans", () => {
    const gallery = buildCaseMediaGallery(CASE_ID, [
      {
        id: "photo",
        caseId: CASE_ID,
        uploadedByUserId: "u",
        uploadedByOrganizationId: "o",
        fileName: "photo.jpg",
        storageKey: "photo.jpg",
        fileType: "image/jpeg",
      },
      {
        id: "document",
        caseId: CASE_ID,
        uploadedByUserId: "u",
        uploadedByOrganizationId: "o",
        fileName: "notes.pdf",
        storageKey: "notes.pdf",
        fileType: "application/pdf",
      },
      {
        id: "scan",
        caseId: CASE_ID,
        uploadedByUserId: "u",
        uploadedByOrganizationId: "o",
        fileName: "scan.stl",
        storageKey: "scan.stl",
        fileType: "model/stl",
      },
      {
        id: "movie",
        caseId: CASE_ID,
        uploadedByUserId: "u",
        uploadedByOrganizationId: "o",
        fileName: "clip.mp4",
        storageKey: "clip.mp4",
        fileType: "application/octet-stream",
      },
    ]);
    expect(gallery.map((item) => item.attachmentId)).toEqual(["photo", "movie"]);
    expect(gallery[1]?.kind).toBe("video");
  });

  it("keeps backdrop and close-button closing behavior", async () => {
    const onClose = vi.fn();
    render(
      <MediaLightbox
        lightbox={{ url: FILE_URL, kind: "image" }}
        onClose={onClose}
      />,
    );
    const img = await screen.findByAltText("Preview");

    fireEvent.click(img);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("media-lightbox-backdrop"));
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("does not add image zoom handling or scaling to video previews", async () => {
    const { container } = render(
      <MediaLightbox
        lightbox={{ url: FILE_URL, kind: "video", mimeType: "video/mp4" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    const video = container.querySelector("video")!;
    fireEvent.wheel(video, { ctrlKey: true, deltaY: -100 });
    expect(video.style.transform).toBe("");
  });

  it("renders nothing when there is no active lightbox", () => {
    const { container } = render(
      <MediaLightbox lightbox={null} onClose={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
    expect(authedMediaFetch).not.toHaveBeenCalled();
  });
});

describe("MediaLightbox — authenticated video preview", () => {
  it("renders a supported clip from an authenticated blob URL", async () => {
    render(
      <MediaLightbox
        lightbox={{
          url: FILE_URL,
          kind: "video",
          mimeType: "video/mp4",
          fileName: "clip.mp4",
        }}
        onClose={() => {}}
      />,
    );

    const video = await waitFor(() => {
      const element = document.querySelector("video");
      expect(element).not.toBeNull();
      return element as HTMLVideoElement;
    });
    expect(video).toHaveAttribute("src", BLOB_URL);
    expect(video.getAttribute("src")).not.toBe(FILE_URL);
    expect(video).toHaveAttribute("controls");
  });

  it("keeps QuickTime clips in the viewer with an explicit authenticated download", async () => {
    render(
      <MediaLightbox
        lightbox={{
          url: FILE_URL,
          kind: "video",
          mimeType: "video/quicktime",
          fileName: "Shade Check.MOV",
        }}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("This video can’t be played here")).toBeInTheDocument();
    expect(document.querySelector("video")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download Shade Check.MOV" }));
    await waitFor(() =>
      expect(authedMediaFetch).toHaveBeenCalledWith(`${FILE_URL}?download=1`),
    );
  });

  it("replaces a failed authenticated video load with a useful download fallback", async () => {
    authedMediaFetch.mockResolvedValueOnce(new Response("", { status: 404 }));
    render(
      <MediaLightbox
        lightbox={{
          url: FILE_URL,
          kind: "video",
          mimeType: "video/mp4",
          fileName: "missing.mp4",
        }}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText("This video can’t be played here")).toBeInTheDocument();
    expect(screen.queryByText("Loading video…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download missing.mp4" })).toBeInTheDocument();
  });

  it("shows download failure without closing the unsupported-video viewer", async () => {
    authedMediaFetch.mockResolvedValueOnce(new Response("", { status: 500 }));
    render(
      <MediaLightbox
        lightbox={{
          url: FILE_URL,
          kind: "video",
          mimeType: "video/quicktime",
          fileName: "clip.MOV",
        }}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download clip.MOV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The download could not be started",
    );
    expect(screen.getByText("This video can’t be played here")).toBeInTheDocument();
  });

  it("classifies video formats case-insensitively", () => {
    expect(isLikelyBrowserPlayableVideo("video/mp4", "clip.MP4")).toBe(true);
    expect(isLikelyBrowserPlayableVideo("video/quicktime", "clip.MOV")).toBe(false);
    expect(isLikelyBrowserPlayableVideo("", "clip.mov")).toBe(false);
  });
});
