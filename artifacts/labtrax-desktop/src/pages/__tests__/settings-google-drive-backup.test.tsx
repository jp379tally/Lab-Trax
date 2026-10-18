/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

let googleStatus: Record<string, unknown>;
let schedule: Record<string, unknown>;
let savedSchedule: Record<string, unknown> | null;
let manualRunBody: Record<string, unknown> | null;
let scheduledTestCalled = false;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeSchedule(enabled = false) {
  return {
    interval: 24,
    unit: "hours",
    destination: null,
    path: null,
    enabled,
    lastSuccessfulBackupAt: new Date().toISOString(),
    staleAlertThresholdDays: 7,
    staleAlertRateLimitDays: 3,
    staleAfterDays: 7,
  };
}

beforeEach(() => {
  googleStatus = {
    ok: true,
    connected: false,
    accountName: null,
    accountEmail: null,
    folder: "LabTrax Backups/non-production",
    error: "Google Drive is not connected.",
    manageUrl: MANAGE_URL,
  };
  schedule = makeSchedule();
  savedSchedule = null;
  manualRunBody = null;
  scheduledTestCalled = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/admin/backup/google-drive-status")) return jsonResponse(googleStatus);
    if (url.includes("/admin/backup/schedule/run-now")) {
      scheduledTestCalled = true;
      return jsonResponse({
        ok: true,
        destination: "google-drive",
        size: 2_500_000,
        fileName: "labtrax-test.zip.enc",
        completedAt: new Date().toISOString(),
      });
    }
    if (url.includes("/admin/backup/schedule")) {
      if (init?.method === "PUT") {
        savedSchedule = JSON.parse(String(init.body)) as Record<string, unknown>;
        schedule = { ...schedule, ...savedSchedule };
        return jsonResponse(schedule);
      }
      return jsonResponse(schedule);
    }
    if (url.includes("/admin/backup/run")) {
      manualRunBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        ok: true,
        size: 2_500_000,
        completedAt: new Date().toISOString(),
        fileName: "labtrax-test.zip.enc",
      });
    }
    if (url.includes("/admin/backup/status/")) {
      return jsonResponse({
        state: "completed",
        phase: "backup complete",
        elapsedMs: 0,
        metrics: {},
      });
    }
    if (url.includes("/admin/backup/history")) return jsonResponse({ ok: true, runs: [] });
    return jsonResponse({ ok: true, items: [], data: [], runs: [] });
  }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {};
  window.history.replaceState(null, "", "/settings?tab=backup");
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function renderBackupSettings() {
  const Wrapper = makeAuthWrapper("/settings?tab=backup", {
    user: ADMIN_USER as any,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
    refresh: vi.fn(async () => {}),
  });
  return render(<Wrapper><SettingsPage /></Wrapper>);
}

describe("Settings → Backup → Google Drive", () => {
  it("shows actionable disconnected guidance and offers workspace linking", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    await renderBackupSettings();
    fireEvent.click(await screen.findByRole("radio", { name: "Google Drive" }));

    const notice = await screen.findByTestId("google-drive-status-disconnected");
    expect(notice).toHaveTextContent(/hosting workspace/i);
    expect(notice).toHaveTextContent(/desktop browser may not complete account linking/i);
    expect(screen.getByRole("button", { name: "Back up now" })).toBeDisabled();

    fireEvent.click(screen.getByTestId("google-drive-connect-button"));
    expect(openSpy).toHaveBeenCalledWith(MANAGE_URL, "_blank", "noopener,noreferrer");
  });

  it("sends manual backups to Google Drive without asking for a local path", async () => {
    googleStatus = {
      ...googleStatus,
      connected: true,
      accountName: "Backup Account",
      error: null,
    };
    await renderBackupSettings();
    fireEvent.click(await screen.findByRole("radio", { name: "Google Drive" }));
    await screen.findByTestId("google-drive-status-connected");

    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await waitFor(() => expect(manualRunBody).not.toBeNull());
    expect(manualRunBody).toMatchObject({ destination: "google-drive" });
    expect(manualRunBody).not.toHaveProperty("path");
  });

  it("saves a Google Drive schedule without a path and offers Run now", async () => {
    googleStatus = { ...googleStatus, connected: true, error: null };
    await renderBackupSettings();
    const selects = await screen.findAllByRole("combobox");
    const destination = selects.find((element) =>
      Array.from((element as HTMLSelectElement).options)
        .some((option) => option.value === "google-drive"),
    );
    expect(destination).toBeDefined();
    fireEvent.change(destination!, { target: { value: "google-drive" } });
    await screen.findByTestId("google-drive-status-connected");
    fireEvent.click(screen.getByLabelText("Enable automatic backups"));
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() => expect(savedSchedule).not.toBeNull());
    expect(savedSchedule).toMatchObject({
      destination: "google-drive",
      enabled: true,
      path: null,
    });
    expect(await screen.findByRole("button", { name: "Run now" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(scheduledTestCalled).toBe(true));
  });
});

