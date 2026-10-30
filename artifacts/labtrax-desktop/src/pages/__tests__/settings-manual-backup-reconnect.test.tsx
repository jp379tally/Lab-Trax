/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/pages/settings";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import {
  getManualBackupProgress,
  loadManualBackupIdentity,
  resetManualBackupProgress,
  saveManualBackupIdentity,
} from "@/lib/manual-backup-progress";

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_USER = {
  id: "u1", username: "labadmin", firstName: "Lab", lastName: "Admin",
  role: "admin", phone: null, phoneVerifiedAt: null,
  practiceOrganizationId: null, practiceLogoUrl: null,
};
let reconnectHttpStatus: number;
let reconnectState: "running" | "unavailable";
let reconnected: boolean;
let reconnectCalls: number;
let manualRunCalls: number;
let reconnectDelay: Promise<void> | null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  resetManualBackupProgress("", "");
  reconnectHttpStatus = 200;
  reconnectState = "running";
  reconnected = false;
  reconnectCalls = 0;
  manualRunCalls = 0;
  reconnectDelay = null;
  saveManualBackupIdentity(ADMIN_USER.id, {
    runId: RUN_ID, destination: "onedrive", archiveKind: "full", path: "",
    startedAt: Date.now() - 150_000_000,
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/admin/backup/reconnect/")) {
      reconnectCalls += 1;
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("X-LabTrax-Backup-Source")).toBe("production");
      if (reconnectDelay) await reconnectDelay;
      if (reconnectHttpStatus !== 200) return jsonResponse({ error: "Status unavailable." }, reconnectHttpStatus);
      reconnected = true;
      return jsonResponse({ ok: true, runId: RUN_ID, state: reconnectState });
    }
    if (url.includes("/admin/backup/status/")) {
      if (!reconnected || reconnectState === "unavailable") {
        return jsonResponse({ error: "Run not found for this session." }, 404);
      }
      return jsonResponse({
        runId: RUN_ID, state: "running", phase: "Uploading to OneDrive",
        elapsedMs: 12_000, overallProgress: 42, metrics: {},
      });
    }
    if (url.includes("/admin/backup/run")) {
      manualRunCalls += 1;
      return jsonResponse({ ok: true });
    }
    if (url.includes("/admin/backup/onedrive-status")) {
      return jsonResponse({
        ok: true, connected: true, accountName: "Backup Owner", accountEmail: "owner@example.com",
        folder: "Apps/LabTrax Backups", error: null, manageUrl: null,
      });
    }
    if (url.includes("/admin/backup/schedule")) {
      return jsonResponse({
        sourceEnvironment: "production", interval: 15, unit: "minutes",
        destination: "onedrive", path: "", enabled: false,
        lastSuccessfulBackupAt: null, staleAlertThresholdDays: 1,
        staleAlertRateLimitDays: 1, staleAfterDays: 1,
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

function renderBackupSettings() {
  const Wrapper = makeAuthWrapper("/settings?tab=backup", {
    user: ADMIN_USER as any, status: "authed", restoreStatus: "ok",
    restoreNoticeDismissed: true, refresh: vi.fn(async () => {}),
  });
  return render(<Wrapper><SettingsPage /></Wrapper>);
}

describe("Settings → Backup → saved manual run reconnection", () => {
  it("automatically rebinds an old-session run before showing its live progress", async () => {
    renderBackupSettings();
    await waitFor(() => expect(screen.getByTestId("backup-overall-percent")).toHaveTextContent("42%"));
    expect(reconnectCalls).toBe(1);
    expect(loadManualBackupIdentity(ADMIN_USER.id)?.runId).toBe(RUN_ID);
    expect(screen.getByRole("button", { name: "Backing up…" })).toBeDisabled();
    expect(manualRunCalls).toBe(0);
  });

  it("clears an obsolete run only after the server confirms it is unavailable", async () => {
    reconnectState = "unavailable";
    renderBackupSettings();
    await waitFor(() => expect(loadManualBackupIdentity(ADMIN_USER.id)).toBeNull());
    expect(reconnectCalls).toBe(1);
    expect(getManualBackupProgress().state).toBe("idle");
    expect(screen.queryByTestId("backup-live-progress")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Back up now" })).toBeEnabled());
    expect(screen.getByText(/no completed backup is confirmed/i)).toBeInTheDocument();
    expect(manualRunCalls).toBe(0);
  });

  it.each([401, 403, 404, 503])("keeps a run reserved and shows unknown progress after HTTP %s", async (status) => {
    reconnectHttpStatus = status;
    renderBackupSettings();
    await screen.findByText(/Could not reconnect to this backup|Live progress is unavailable/i);
    expect(screen.getByTestId("backup-reconnect-status")).toHaveTextContent("Backup status unknown");
    expect(screen.queryByTestId("backup-overall-percent")).not.toBeInTheDocument();
    expect(screen.queryByTestId("backup-live-progress")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Backup status unknown" })).toBeDisabled();
    expect(loadManualBackupIdentity(ADMIN_USER.id)?.runId).toBe(RUN_ID);
    expect(getManualBackupProgress().state).toBe("running");
    expect(reconnectCalls).toBe(1);
    expect(manualRunCalls).toBe(0);
  });

  it("can release an obsolete run on explicit retry after a connection failure", async () => {
    reconnectHttpStatus = 503;
    renderBackupSettings();
    await screen.findByText(/Could not reconnect to this backup|Live progress is unavailable/i);
    reconnectHttpStatus = 200;
    reconnectState = "unavailable";
    fireEvent.click(screen.getByRole("button", { name: "Retry backup reconnection" }));
    await waitFor(() => expect(loadManualBackupIdentity(ADMIN_USER.id)).toBeNull());
    expect(reconnectCalls).toBe(2);
    expect(getManualBackupProgress().state).toBe("idle");
    expect(manualRunCalls).toBe(0);
  });

  it("automatically reconnects an existing module-scoped run after polling loses its session", async () => {
    resetManualBackupProgress(RUN_ID, "Uploading to OneDrive", Date.now() - 12_000);
    renderBackupSettings();
    await waitFor(() => expect(screen.getByTestId("backup-overall-percent")).toHaveTextContent("42%"));
    expect(reconnectCalls).toBe(1);
    expect(getManualBackupProgress().runId).toBe(RUN_ID);
    expect(manualRunCalls).toBe(0);
  });

  it("does not replace a newer successful status with an older reconnect failure", async () => {
    reconnectHttpStatus = 503;
    reconnected = true;
    let finishReconnect!: () => void;
    reconnectDelay = new Promise<void>(resolve => { finishReconnect = resolve; });
    renderBackupSettings();
    await waitFor(() => expect(screen.getByTestId("backup-overall-percent")).toHaveTextContent("42%"));
    await act(async () => { finishReconnect(); });
    expect(screen.queryByText(/Could not reconnect to this backup/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("backup-reconnect-status")).not.toBeInTheDocument();
    expect(getManualBackupProgress().error).toBeNull();
    expect(manualRunCalls).toBe(0);
  });
});
