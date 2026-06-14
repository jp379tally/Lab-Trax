/** @vitest-environment jsdom */
/**
 * Regression test for the "logo uploads, then the button is stuck on
 * Uploading… forever" bug.
 *
 * The fix routes the upload through the XHR-based apiUploadWithProgress (which
 * always fires a terminal event) and guards it with a timeout/abort, then
 * always clears the uploading state in a finally block. These tests assert the
 * button text leaves the "Uploading…" state on BOTH a successful upload and a
 * failed one, so a single failure can never wedge the control.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const uploadMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiUploadWithProgress: (...args: unknown[]) => uploadMock(...args),
  };
});

const refreshMock = vi.fn(async () => {});

const LOGO_UPLOAD_USER = {
  id: "user-1",
  username: "admin",
  firstName: "Ada",
  lastName: "Lovelace",
  role: "admin",
  practiceOrganizationId: "org-1",
  // No practiceLogoUrl so the preview shows "No logo" (no AuthedImage
  // blob fetch) and the button reads "Add a logo".
};

import SettingsPage from "@/pages/settings";

beforeEach(() => {
  uploadMock.mockReset();
  refreshMock.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      // A broadly-safe shape: the settings page reads collections like
      // `team`/`members` non-optionally in a few spots, so hand back empty
      // arrays to keep background queries from throwing during re-render.
      return new Response(JSON.stringify({ team: [], members: [], items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

function renderSettings() {
  const Wrapper = makeAuthWrapper("/settings", {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    user: LOGO_UPLOAD_USER as any,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
    refresh: refreshMock,
  });
  const { container } = render(
    <Wrapper>
      <SettingsPage />
    </Wrapper>,
  );
  // The lab-logo file input is the one accepting svg (distinguishes it from any
  // other file inputs that might appear on the page).
  const inputs = Array.from(
    container.querySelectorAll<HTMLInputElement>('input[type="file"]'),
  );
  const logoInput = inputs.find((i) =>
    (i.getAttribute("accept") ?? "").includes("image/svg+xml"),
  );
  if (!logoInput) throw new Error("logo file input not found");
  return logoInput;
}

function selectFile(input: HTMLInputElement) {
  const file = new File(["logo-bytes"], "logo.png", { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
}

describe("settings lab-logo upload state", () => {
  it("clears the Uploading… state after a successful upload", async () => {
    uploadMock.mockResolvedValue({});
    const input = renderSettings();

    selectFile(input);

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    // The button must return out of the uploading state.
    await waitFor(() =>
      expect(screen.queryByText("Uploading…")).not.toBeInTheDocument(),
    );
    expect(refreshMock).toHaveBeenCalled();
  });

  it("clears the Uploading… state and shows an error when the upload fails", async () => {
    uploadMock.mockRejectedValue(new Error("network exploded"));
    const input = renderSettings();

    selectFile(input);

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByText("Uploading…")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/network exploded/i)).toBeInTheDocument();
  });
});
