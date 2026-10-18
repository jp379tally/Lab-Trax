/** @vitest-environment jsdom */
/**
 * Regression guard: Settings → Backup → OneDrive connect/reconnect.
 *
 * Protected workflow: "OneDrive connect/reconnect from Backup settings".
 *
 * The Microsoft OAuth handshake for the OneDrive backup destination is
 * completed through the Replit-managed connector in the hosting workspace.
 * The Backup settings page must still offer the connect/reconnect action
 * in-product:
 *   1. Disconnected + manageUrl → a "Connect OneDrive" button opens the
 *      hosting-workspace page (window.open) and a "Check again" button
 *      re-polls the status endpoint.
 *   2. Disconnected + no manageUrl → no dead button; fallback copy tells the
 *      admin where to connect, and "Check again" still works.
 *   3. Connected + manageUrl → a "Reconnect a different account" action is
 *      offered alongside the connected-account summary.
 *
 * Keep these tests permanently per REGRESSION_GUARDRAILS.md policy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SettingsPage from "@/pages/settings";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const MANAGE_URL = "https://replit.com/@test-owner/test-slug";

const ADMIN_USER = {
  id: "u1",
  username: "labadmin",
  firstName: "Lab",
  lastName: "Admin",
  role: "admin",
  phone: null,
  phoneVerifiedAt: null,
  practiceOrganizationId: null,
  practiceLogoUrl: null,
};

type OneDriveStatusBody = {
  ok: boolean;
  connected: boolean;
  accountName: string | null;
  accountEmail: string | null;
  folder: string;
  error: string | null;
  manageUrl: string | null;
};

let oneDriveStatusBody: OneDriveStatusBody;
let oneDriveStatusCalls = 0;
let oneDriveHttpStatus = 200;
let invalidOneDriveResponse = false;

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  oneDriveStatusCalls = 0;
  oneDriveHttpStatus = 200;
  invalidOneDriveResponse = false;
  oneDriveStatusBody = {
    ok: true,
    connected: false,
    accountName: null,
    accountEmail: null,
    folder: "Apps/LabTrax Backups",
    error: "OneDrive is not connected.",
    manageUrl: MANAGE_URL,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/admin/backup/onedrive-status")) {
        oneDriveStatusCalls += 1;
        if (oneDriveHttpStatus !== 200) {
          return new Response(JSON.stringify({ error: "Admin access required." }), {
            status: oneDriveHttpStatus,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (invalidOneDriveResponse) return jsonResponse({ ok: true });
        return jsonResponse(oneDriveStatusBody);
      }
      if (url.includes("/admin/backup/schedule")) {
        return jsonResponse({
          interval: null,
          unit: null,
          destination: null,
          path: null,
          enabled: false,
          lastSuccessfulBackupAt: new Date().toISOString(),
          staleAlertThresholdDays: 7,
          staleAlertRateLimitDays: 3,
          staleAfterDays: 7,
        });
      }
      if (url.includes("/admin/backup/history")) {
        return jsonResponse({ ok: true, runs: [] });
      }
      return jsonResponse({ ok: true, team: [], members: [], items: [], sessions: [], runs: [] });
    }),
  );
  (window as unknown as { electronAPI: unknown }).electronAPI = {};
  window.history.replaceState(null, "", "/settings?tab=backup");
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function renderBackupTabWithOneDriveSelected() {
  const Wrapper = makeAuthWrapper("/settings?tab=backup", {
    user: ADMIN_USER as any,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
    refresh: vi.fn(async () => {}),
  });
  const utils = render(<Wrapper><SettingsPage /></Wrapper>);
  // Select OneDrive as the "Back up now" destination — this enables the
  // status query and renders the OneDrive connection notice.
  const radio = await screen.findByRole("radio", { name: /OneDrive/i });
  fireEvent.click(radio);
  return utils;
}

describe("Settings → Backup → OneDrive connect/reconnect", () => {
  it("offers a Connect OneDrive button that opens the hosting workspace when disconnected", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    await renderBackupTabWithOneDriveSelected();

    await waitFor(() =>
      expect(screen.getByTestId("onedrive-status-disconnected")).toBeInTheDocument(),
    );
    const connectBtn = screen.getByTestId("onedrive-connect-button");
    expect(connectBtn).toHaveTextContent(/Connect OneDrive/i);

    fireEvent.click(connectBtn);
    expect(openSpy).toHaveBeenCalledWith(MANAGE_URL, "_blank", "noopener,noreferrer");
  });

  it("re-polls the status endpoint via Check again, flipping to connected after the OAuth completes", async () => {
    await renderBackupTabWithOneDriveSelected();
    await waitFor(() =>
      expect(screen.getByTestId("onedrive-status-disconnected")).toBeInTheDocument(),
    );
    const callsBefore = oneDriveStatusCalls;

    // Simulate the admin completing the connector OAuth in the workspace…
    oneDriveStatusBody = {
      ok: true,
      connected: true,
      accountName: "Backup Owner",
      accountEmail: "owner@example.com",
      folder: "Apps/LabTrax Backups",
      error: null,
      manageUrl: MANAGE_URL,
    };
    // …then clicking "Check again" back in LabTrax.
    fireEvent.click(screen.getByTestId("onedrive-check-again-button"));

    await waitFor(() =>
      expect(screen.getByTestId("onedrive-status-connected")).toBeInTheDocument(),
    );
    expect(oneDriveStatusCalls).toBeGreaterThan(callsBefore);
    expect(screen.getByTestId("onedrive-status-connected")).toHaveTextContent("Backup Owner");
  });

  it("hides the connect button (no dead link) when the server has no manage URL", async () => {
    oneDriveStatusBody.manageUrl = null;
    await renderBackupTabWithOneDriveSelected();

    await waitFor(() =>
      expect(screen.getByTestId("onedrive-status-disconnected")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("onedrive-connect-button")).not.toBeInTheDocument();
    // Fallback copy still tells the admin where the connection is made.
    expect(screen.getByTestId("onedrive-status-disconnected")).toHaveTextContent(/Integrations/i);
    expect(screen.getByTestId("onedrive-check-again-button")).toBeInTheDocument();
  });

  it("offers Reconnect a different account when already connected", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    oneDriveStatusBody = {
      ok: true,
      connected: true,
      accountName: "Backup Owner",
      accountEmail: "owner@example.com",
      folder: "Apps/LabTrax Backups",
      error: null,
      manageUrl: MANAGE_URL,
    };
    await renderBackupTabWithOneDriveSelected();

    await waitFor(() =>
      expect(screen.getByTestId("onedrive-status-connected")).toBeInTheDocument(),
    );
    const reconnectBtn = screen.getByTestId("onedrive-reconnect-button");
    fireEvent.click(reconnectBtn);
    expect(openSpy).toHaveBeenCalledWith(MANAGE_URL, "_blank", "noopener,noreferrer");
  });

  it("reports a forbidden status check as an access error, not a disconnected account", async () => {
    oneDriveHttpStatus = 403;
    await renderBackupTabWithOneDriveSelected();

    const notice = await screen.findByTestId("onedrive-status-error");
    expect(notice).toHaveTextContent("Could not check OneDrive");
    expect(notice).toHaveTextContent("Admin access required.");
    expect(screen.queryByTestId("onedrive-status-disconnected")).not.toBeInTheDocument();
    expect(screen.queryByTestId("onedrive-connect-button")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back up now" })).toBeDisabled();
    expect(oneDriveStatusCalls).toBe(1);

    oneDriveHttpStatus = 200;
    oneDriveStatusBody.connected = true;
    oneDriveStatusBody.error = null;
    fireEvent.click(screen.getByTestId("onedrive-check-again-button"));
    await screen.findByTestId("onedrive-status-connected");
    expect(screen.getByRole("button", { name: "Back up now" })).toBeEnabled();
  });

  it("refreshes after returning from the external browser without a visibility change", async () => {
    await renderBackupTabWithOneDriveSelected();
    await screen.findByTestId("onedrive-status-disconnected");
    const callsBefore = oneDriveStatusCalls;

    oneDriveStatusBody.connected = true;
    oneDriveStatusBody.error = null;
    fireEvent(window, new Event("focus"));

    await screen.findByTestId("onedrive-status-connected");
    expect(oneDriveStatusCalls).toBeGreaterThan(callsBefore);
    expect(screen.getByRole("button", { name: "Back up now" })).toBeEnabled();
  });

  it("does not trust a cached connected result after its refresh is forbidden", async () => {
    oneDriveStatusBody.connected = true;
    oneDriveStatusBody.error = null;
    await renderBackupTabWithOneDriveSelected();
    await screen.findByTestId("onedrive-status-connected");
    expect(screen.getByRole("button", { name: "Back up now" })).toBeEnabled();

    oneDriveHttpStatus = 403;
    fireEvent.click(screen.getByTestId("onedrive-check-again-button"));

    await screen.findByTestId("onedrive-status-error");
    expect(screen.queryByTestId("onedrive-status-connected")).not.toBeInTheDocument();
    expect(screen.queryByTestId("onedrive-status-disconnected")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back up now" })).toBeDisabled();
  });

  it("does not label an unexpected server response as a disconnected account", async () => {
    invalidOneDriveResponse = true;
    await renderBackupTabWithOneDriveSelected();

    await waitFor(() => {
      expect(screen.getByTestId("onedrive-status-error")).toHaveTextContent(
        "The server did not return a OneDrive connection status.",
      );
    }, { timeout: 5000 });
    expect(screen.queryByTestId("onedrive-status-disconnected")).not.toBeInTheDocument();
    expect(screen.queryByTestId("onedrive-connect-button")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back up now" })).toBeDisabled();
  });
});
