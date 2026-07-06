/** @vitest-environment jsdom */
/**
 * Regression guard: the Files-tab list row renders case photos through
 * authenticated media.
 *
 * Protected workflow: "Desktop Case Photo Cross-Platform Visibility"
 *
 * `AttachmentRow` (artifacts/labtrax-desktop/src/pages/cases.tsx) is the real
 * Files-tab list-row surface that ships to users. Its image thumbnail must be
 * rendered through `AuthedImage`, which fetches the bearer-auth-gated canonical
 * endpoint
 *   GET /api/cases/:caseId/attachments/:attachmentId/file
 * with an Authorization header, turns the bytes into a blob object URL, and
 * renders that. A refactor swapping `AuthedImage` for a plain
 * `<img src="…/file">` here would 401 and render blank for authenticated
 * desktop users — exactly the "photos show on web/mobile but go blank on
 * desktop" bug this guard locks against.
 *
 * The sibling guard in
 *   components/__tests__/AuthedMedia.attachment.test.tsx
 * covers the other real surfaces (AttachmentThumb, HistoryEventMedia, and the
 * full-size MediaLightbox). This file isolates AttachmentRow because it lives in
 * the heavy cases.tsx page module, which needs the jspdf/react-pdf mocks below.
 *
 * Keep this test permanently per the REGRESSION_GUARDRAILS.md policy.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// jspdf and react-pdf pull in heavy/non-jsdom-friendly modules at import time.
// This surface never touches PDF code, but cases.tsx loads them at module time.
vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

import { AttachmentRow } from "@/pages/cases";
import { getApiOrigin } from "@/lib/api";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import type { CaseAttachment } from "@/lib/types";

const CASE_ID = "case_abc123";
const ATTACHMENT_ID = "att_photo_9";
// getApiOrigin() is "" in the web/test build, so the row builds a relative
// same-origin /file URL — which AuthedImage still fetches with auth.
const FILE_URL = `${getApiOrigin()}/api/cases/${CASE_ID}/attachments/${ATTACHMENT_ID}/file`;
const BLOB_URL = "blob:labtrax/desktop-photo-row";

const imageAttachment: CaseAttachment = {
  id: ATTACHMENT_ID,
  caseId: CASE_ID,
  uploadedByUserId: "user_1",
  uploadedByOrganizationId: "org_1",
  fileName: "prescription-photo.jpg",
  storageKey: "case-media/prescription-photo.jpg",
  fileType: "image/jpeg",
} as unknown as CaseAttachment;

const fetchMock = vi.fn();

let origCreate: typeof URL.createObjectURL | undefined;
let origRevoke: typeof URL.revokeObjectURL | undefined;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/file")) {
      return new Response(
        new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
        { status: 200 },
      );
    }
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  // jsdom does not implement object URLs. Attach the mocks onto the real URL
  // constructor rather than replacing it, so `new URL(...)` (used by
  // isSameApiOrigin) keeps working.
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

describe("AttachmentRow — real desktop Files-tab list-row surface", () => {
  it("renders an image attachment through AuthedImage against the canonical /file endpoint", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(
      <Wrapper>
        <AttachmentRow
          caseId={CASE_ID}
          attachment={imageAttachment}
          canManage={false}
        />
      </Wrapper>,
    );

    // The row builds the canonical /file URL and hands it to AuthedImage, which
    // performs the bearer-authed fetch against that endpoint.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) => String(call?.[0]) === FILE_URL,
        ),
      ).toBe(true),
    );

    // The visible <img> src is the blob object URL, not the protected /file URL.
    const img = await screen.findByAltText("prescription-photo.jpg");
    expect(img.tagName).toBe("IMG");
    expect(img).toHaveAttribute("src", BLOB_URL);
    expect(img.getAttribute("src")).not.toBe(FILE_URL);
  });

  it("never renders a plain <img> pointed at the protected /file URL", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    const { container } = render(
      <Wrapper>
        <AttachmentRow
          caseId={CASE_ID}
          attachment={imageAttachment}
          canManage={false}
        />
      </Wrapper>,
    );

    await screen.findByAltText("prescription-photo.jpg");

    // A plain <img src="…/file"> here would 401 and render blank on desktop —
    // exactly the regression this guard exists to prevent.
    const rawSrc = container.querySelector(`img[src="${FILE_URL}"]`);
    expect(rawSrc).toBeNull();
  });

  it("shows the fallback (no <img>) when the authenticated fetch fails", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/file")) return new Response("", { status: 401 });
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const Wrapper = makeAuthWrapper("/cases");
    const { container } = render(
      <Wrapper>
        <AttachmentRow
          caseId={CASE_ID}
          attachment={imageAttachment}
          canManage={false}
        />
      </Wrapper>,
    );

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call?.[0]) === FILE_URL),
      ).toBe(true),
    );

    expect(screen.queryByAltText("prescription-photo.jpg")).toBeNull();
    expect(container.querySelector(`img[src="${FILE_URL}"]`)).toBeNull();
  });
});
