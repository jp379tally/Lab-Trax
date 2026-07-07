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
import { render, screen, waitFor } from "@testing-library/react";
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

import { AuthedImage, MediaLightbox } from "../AuthedMedia";
import { AttachmentThumb, HistoryEventMedia } from "../PrescriptionPreview";
import type { CaseAttachment } from "@/lib/types";

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

  it("renders nothing when there is no active lightbox", () => {
    const { container } = render(
      <MediaLightbox lightbox={null} onClose={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
    expect(authedMediaFetch).not.toHaveBeenCalled();
  });
});
