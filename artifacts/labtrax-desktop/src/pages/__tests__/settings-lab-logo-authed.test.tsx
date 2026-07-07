/** @vitest-environment jsdom */
/**
 * Regression guard: lab logo in Settings renders through AuthedImage (authenticated
 * media fetch), never as a plain unauthenticated <img src={practiceLogoUrl}>.
 *
 * Protected workflow: "Desktop lab-logo authenticated rendering"
 *
 * The lab logo stored at practiceLogoUrl comes from a bearer-auth-gated endpoint.
 * A raw <img src={practiceLogoUrl}> would 401 silently. This test locks in that
 * the logo always goes through AuthedImage → authedMediaFetch → blob URL.
 *
 * Assertions:
 *   1. When practiceLogoUrl is set, authedMediaFetch is called with that URL.
 *   2. No <img> with src equal to the raw practiceLogoUrl appears in the DOM
 *      (the resolved src is always a blob URL).
 *   3. When practiceLogoUrl is null, authedMediaFetch is not called for the logo.
 *
 * Keep this test permanently per REGRESSION_GUARDRAILS.md policy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";

// ── Mock targeted functions while preserving everything else from @/lib/api ──
const authedMediaFetch = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    // Return a stable origin that matches LOGO_URL so isSameApiOrigin() is true
    // and the bearer-token path is exercised (not the unauthenticated fast-path).
    getApiOrigin: () => "https://api.labtrax.example",
    // Resolve immediately — no localStorage/keychain in jsdom.
    waitForTokenHydration: async () => {},
    authedMediaFetch: (...args: unknown[]) => authedMediaFetch(...args),
  };
});

const LOGO_URL = "https://api.labtrax.example/api/uploads/case-media/org-logo.png";
const BLOB_URL = "blob:labtrax/logo-object";

let origCreate: typeof URL.createObjectURL | undefined;
let origRevoke: typeof URL.revokeObjectURL | undefined;

beforeEach(() => {
  authedMediaFetch.mockReset();
  authedMediaFetch.mockResolvedValue(
    new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), {
      status: 200,
    }),
  );
  origCreate = URL.createObjectURL;
  origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => BLOB_URL) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ team: [], members: [], items: [], sessions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  (window as unknown as { electronAPI: unknown }).electronAPI = {};
});

afterEach(() => {
  if (origCreate) URL.createObjectURL = origCreate;
  if (origRevoke) URL.revokeObjectURL = origRevoke;
  vi.restoreAllMocks();
});

import SettingsPage from "@/pages/settings";

const USER_WITH_LOGO = {
  id: "u1",
  username: "labadmin",
  firstName: "Lab",
  lastName: "Admin",
  role: "admin",
  phone: null,
  phoneVerifiedAt: null,
  practiceOrganizationId: "org-1",
  practiceLogoUrl: LOGO_URL,
};

const USER_WITHOUT_LOGO = {
  ...USER_WITH_LOGO,
  practiceLogoUrl: null,
};

describe("Settings lab-logo authenticated rendering", () => {
  it("calls authedMediaFetch with the practiceLogoUrl (not a direct unauthenticated fetch)", async () => {
    const Wrapper = makeAuthWrapper("/settings", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user: USER_WITH_LOGO as any,
      status: "authed",
      restoreStatus: "ok",
      restoreNoticeDismissed: true,
      refresh: vi.fn(async () => {}),
    });
    render(<Wrapper><SettingsPage /></Wrapper>);

    await waitFor(() => {
      expect(authedMediaFetch).toHaveBeenCalledWith(
        LOGO_URL,
        expect.anything(),
      );
    });
  });

  it("never renders a plain <img src={practiceLogoUrl}> (raw unauthenticated URL)", async () => {
    const Wrapper = makeAuthWrapper("/settings", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user: USER_WITH_LOGO as any,
      status: "authed",
      restoreStatus: "ok",
      restoreNoticeDismissed: true,
      refresh: vi.fn(async () => {}),
    });
    const { container } = render(<Wrapper><SettingsPage /></Wrapper>);

    await waitFor(() =>
      expect(authedMediaFetch).toHaveBeenCalled(),
    );

    // After AuthedImage resolves, no img should carry the raw server URL as src.
    const allImgs = container.querySelectorAll("img");
    for (const img of allImgs) {
      expect(img.getAttribute("src")).not.toBe(LOGO_URL);
    }
  });

  it("renders the logo img with the blob object URL as src after authed fetch resolves", async () => {
    const Wrapper = makeAuthWrapper("/settings", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user: USER_WITH_LOGO as any,
      status: "authed",
      restoreStatus: "ok",
      restoreNoticeDismissed: true,
      refresh: vi.fn(async () => {}),
    });
    const { container } = render(<Wrapper><SettingsPage /></Wrapper>);

    await waitFor(() => {
      const blobImgs = container.querySelectorAll(`img[src="${BLOB_URL}"]`);
      expect(blobImgs.length).toBeGreaterThan(0);
    });
  });

  it("does NOT call authedMediaFetch for a logo URL when practiceLogoUrl is null", async () => {
    const Wrapper = makeAuthWrapper("/settings", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user: USER_WITHOUT_LOGO as any,
      status: "authed",
      restoreStatus: "ok",
      restoreNoticeDismissed: true,
      refresh: vi.fn(async () => {}),
    });
    const { container } = render(<Wrapper><SettingsPage /></Wrapper>);

    // Wait for the page to settle
    await new Promise((r) => setTimeout(r, 80));

    // No authedMediaFetch call for the logo URL
    const logoCalls = authedMediaFetch.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("org-logo"),
    );
    expect(logoCalls).toHaveLength(0);

    // No img with the null logo URL
    const allImgs = container.querySelectorAll("img");
    for (const img of allImgs) {
      expect(img.getAttribute("src")).not.toBe(LOGO_URL);
    }
  });
});
