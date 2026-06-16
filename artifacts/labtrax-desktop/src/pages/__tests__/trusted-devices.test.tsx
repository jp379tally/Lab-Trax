/** @vitest-environment jsdom */
/**
 * Renderer smoke test for Settings → Two-factor → Trusted devices
 * (the "remembered devices" sign-out section).
 *
 * The section is only covered by manual/API verification otherwise, so these
 * assertions lock in the contract the UI depends on:
 *   - When the GET /auth/2fa/trusted-devices envelope contains a device, a
 *     row renders with its name and a Revoke button.
 *   - Pressing Revoke calls DELETE /auth/2fa/trusted-devices/:id for that row.
 * A drift in the envelope shape (`{ devices: [...] }`), the field names, or the
 * revoke path would fail here instead of silently shipping a broken panel.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

import { TrustedDevicesSection } from "@/pages/settings";

const DEVICE = {
  id: "dev-1",
  deviceName: "Ada's MacBook",
  userAgent: "Mozilla/5.0 (Macintosh)",
  ipAddress: "203.0.113.7",
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  lastUsedAt: null,
  expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
};

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("TrustedDevicesSection — remembered devices", () => {
  it("renders a device row from the GET envelope and revokes it on click", async () => {
    apiFetchMock.mockImplementation((path: string, options?: { method?: string }) => {
      if (path === "/auth/2fa/trusted-devices" && (!options || !options.method)) {
        return Promise.resolve({ devices: [DEVICE] });
      }
      if (
        path === `/auth/2fa/trusted-devices/${DEVICE.id}` &&
        options?.method === "DELETE"
      ) {
        return Promise.resolve({ success: true });
      }
      return Promise.resolve({});
    });

    render(<TrustedDevicesSection />, { wrapper: makeAuthWrapper() });

    // The device row appears once the list query resolves.
    await waitFor(() => {
      expect(screen.getByText("Ada's MacBook")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Revoke/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        `/auth/2fa/trusted-devices/${DEVICE.id}`,
        { method: "DELETE" },
      );
    });
  });

  it("renders nothing when the user has no remembered devices", async () => {
    apiFetchMock.mockResolvedValue({ devices: [] });

    const { container } = render(<TrustedDevicesSection />, {
      wrapper: makeAuthWrapper(),
    });

    // Empty list collapses to null — no stray heading or button.
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith("/auth/2fa/trusted-devices");
    });
    expect(screen.queryByRole("button", { name: /Revoke/i })).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
