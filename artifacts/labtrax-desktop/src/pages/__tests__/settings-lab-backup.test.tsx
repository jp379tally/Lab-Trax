/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/pages/settings";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { resetManualBackupProgress, saveManualBackupIdentity } from "@/lib/manual-backup-progress";

const LAB_ONE = {
  id: "lab-one",
  type: "lab",
  name: "North Lab",
  isActive: true,
};
const LAB_TWO = {
  id: "lab-two",
  type: "lab",
  name: "South Lab",
  isActive: true,
};
const ADMIN_USER = {
  id: "user-one",
  username: "labadmin",
  role: "admin",
  userType: "lab",
  practiceOrganizationId: null,
};

let memberships: Array<Record<string, unknown>>;
let downloadStatus: number;
let downloadError = "You do not have active owner or admin access to the selected lab.";
let downloadCalls: string[];
let adminBackupCalls: string[];
let adminBackupReports: Array<Record<string, unknown>>;
let manualBackupBody: Record<string, unknown> | null;
let manualLiveStatus: Record<string, unknown>;
let holdManualGeneration: boolean;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  resetManualBackupProgress("", "");
  memberships = [
    {
      organizationId: LAB_ONE.id,
      role: "owner",
      status: "active",
      organization: LAB_ONE,
    },
    {
      organizationId: LAB_TWO.id,
      role: "admin",
      status: "active",
      organization: LAB_TWO,
    },
  ];
  downloadStatus = 200;
  downloadCalls = [];
  adminBackupCalls = [];
  adminBackupReports = [];
  manualBackupBody = null;
  holdManualGeneration = false;
  manualLiveStatus = { runId: "", state: "running", phase: "starting backup", elapsedMs: 0, metrics: {} };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/me")) {
      return jsonResponse({ user: ADMIN_USER, memberships });
    }
    if (url.includes("/lab/backup/generate")) {
      downloadCalls.push(url);
      if (downloadStatus !== 200) {
        return jsonResponse({ error: downloadError }, downloadStatus);
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([76, 84, 82, 50, 1, 2, 3]));
          controller.close();
        },
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="north-lab-backup.zip.enc"',
        },
      });
    }
    if (url.includes("/admin/backup/run")) {
      manualBackupBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      manualLiveStatus = holdManualGeneration
        ? { runId: manualBackupBody.runId, state: "running", phase: "database dump", elapsedMs: 100, metrics: {} }
        : {
          runId: manualBackupBody.runId,
          state: "awaiting_verification",
          phase: "desktop verification",
          elapsedMs: 100,
          metrics: {},
          archiveEvidence: {
            archiveKind: "complete-non-production",
            coverageVersion: 1,
            mediaFileCount: 1,
            attachmentRowCount: 1,
          },
          delivery: {
            fileName: "labtrax-backup.zip.enc",
            size: 76,
            archiveKind: "complete-non-production",
            sourceEnvironment: "non-production",
          },
        };
      return jsonResponse({ ok: true, runId: manualBackupBody.runId, state: "running" }, 202);
    }
    if (url.includes("/admin/backup/status/")) {
      return jsonResponse(manualLiveStatus);
    }
    if (url.includes("/admin/backup/cancel/")) {
      manualLiveStatus = { ...manualLiveStatus, state: "cancelled", phase: "backup cancelled", error: "Backup cancelled." };
      return jsonResponse({ ok: true, state: "cancelled" });
    }
    if (url.includes("/admin/backup/download/")) {
      adminBackupCalls.push(url);
      const archive = new Uint8Array(76);
      archive.set(new TextEncoder().encode("LTR2"), 0);
      archive.set(new TextEncoder().encode("LTF1"), 64);
      new DataView(archive.buffer).setBigUint64(68, 64n, false);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(archive.subarray(0, 3));
          controller.enqueue(archive.subarray(3, 70));
          controller.enqueue(archive.subarray(70));
          controller.close();
        },
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="labtrax-backup.zip.enc"',
          "Content-Length": String(archive.byteLength),
          "x-backup-archive-kind": "complete-non-production",
          "x-backup-coverage-version": "1",
          "x-backup-missing-file-count": "0",
          "x-backup-media-file-count": "1",
          "x-backup-attachment-row-count": "1",
        },
      });
    }
    if (url.includes("/admin/backup/desktop-run-report")) {
      adminBackupReports.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({ ok: true, completedAt: "2026-10-20T18:00:00.000Z" });
    }
    if (url.includes("/admin/backup/onedrive-status")) {
      return jsonResponse({ ok: true, connected: false, folder: "", manageUrl: null });
    }
    if (url.includes("/admin/backup/schedule")) {
      return jsonResponse({ interval: null, destination: null, enabled: false });
    }
    if (url.includes("/admin/backup/history")) {
      return jsonResponse({ ok: true, runs: [] });
    }
    return jsonResponse({ ok: true });
  }));
  window.history.replaceState(null, "", "/settings?tab=backup");
});

afterEach(() => {
  resetManualBackupProgress("", "");
  vi.unstubAllGlobals();
  delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker;
  window.history.replaceState(null, "", "/");
});

function renderBackupSettings(user = ADMIN_USER) {
  const Wrapper = makeAuthWrapper("/settings?tab=backup", {
    user: user as any,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
    refresh: vi.fn(async () => {}),
  });
  return render(<Wrapper><SettingsPage /></Wrapper>);
}

describe("Settings → Backup → lab-scoped download", () => {
  it("streams a full manual backup to a browser-selected USB file", async () => {
    let savedBytes = 0;
    const picker = vi.fn(async () => ({
      name: "labtrax-backup.zip.enc",
      createWritable: async () => new WritableStream<Uint8Array>({
        write(chunk) { savedBytes += chunk.byteLength; },
      }),
    }));
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: picker,
    });
    renderBackupSettings();

    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));

    expect(await screen.findByText(/saved to/)).toBeInTheDocument();
    expect(picker).toHaveBeenCalledWith({ suggestedName: "labtrax-backup.zip.enc" });
    expect(adminBackupCalls).toHaveLength(1);
    expect(adminBackupCalls[0]).toContain("/admin/backup/download/");
    expect(manualBackupBody).toMatchObject({ destination: "browser", archiveKind: "full" });
    expect(adminBackupReports).toEqual([expect.objectContaining({
      status: "success",
      source: "manual",
      fileName: "labtrax-backup.zip.enc",
      sizeBytes: 76,
    })]);
    expect(savedBytes).toBe(76);
  });

  it("cancels only the active manual run and displays cancellation rather than success", async () => {
    holdManualGeneration = true;
    renderBackupSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));
    await waitFor(() => expect(screen.getByTestId("cancel-manual-backup")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("cancel-manual-backup"));

    expect(await screen.findByText(/Backup cancelled\. Incomplete output was discarded/)).toBeInTheDocument();
    expect(adminBackupCalls).toHaveLength(0);
    expect(adminBackupReports).toHaveLength(0);
    expect(manualLiveStatus.state).toBe("cancelled");
  });

  it("reconnects after a page reload and redelivers the same staged archive without a new run", async () => {
    const runId = "2cd9aedf-87cf-40f6-8d10-920db0a0aef7";
    manualLiveStatus = {
      runId,
      state: "awaiting_verification",
      phase: "desktop verification",
      elapsedMs: 500,
      metrics: {},
      delivery: {
        fileName: "labtrax-backup.zip.enc",
        size: 76,
        archiveKind: "complete-non-production",
        sourceEnvironment: "non-production",
      },
    };
    saveManualBackupIdentity("user-one", {
      runId,
      destination: "local",
      archiveKind: "full",
      path: "",
      startedAt: Date.now() - 500,
    });
    renderBackupSettings();

    fireEvent.click(await screen.findByTestId("resume-manual-backup-download"));
    expect(await screen.findByText(/downloaded by your browser/)).toBeInTheDocument();
    expect(adminBackupCalls).toHaveLength(1);
    expect(manualBackupBody).toBeNull();
    expect(adminBackupReports).toHaveLength(1);
  });

  it("lets an owner/admin select an actively administered lab and streams the browser download", async () => {
    let downloadedBytes = 0;
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: vi.fn(async () => ({
        createWritable: async () => new WritableStream<Uint8Array>({
          write(chunk) {
            downloadedBytes += chunk.byteLength;
          },
        }),
      })),
    });
    renderBackupSettings();

    const selector = await screen.findByRole("combobox", { name: "Lab for backup" });
    fireEvent.change(selector, { target: { value: LAB_TWO.id } });
    fireEvent.click(screen.getByTestId("download-lab-backup"));

    await waitFor(() => expect(screen.getByTestId("lab-backup-success")).toBeInTheDocument());
    expect(downloadCalls).toHaveLength(1);
    expect(downloadCalls[0]).toContain(`labOrganizationId=${LAB_TWO.id}`);
    expect(downloadedBytes).toBeGreaterThan(0);
    expect(screen.getByTestId("lab-backup-success")).toHaveTextContent("South Lab");
  });

  it("shows the server's actionable denial when a lab download is refused", async () => {
    downloadStatus = 403;
    downloadError = "You do not have active owner or admin access to the selected lab.";
    renderBackupSettings();
    const selector = await screen.findByRole("combobox", { name: "Lab for backup" });
    fireEvent.change(selector, { target: { value: LAB_TWO.id } });
    fireEvent.click(screen.getByTestId("download-lab-backup"));

    expect(await screen.findByRole("alert")).toHaveTextContent(downloadError);
    expect(downloadCalls).toHaveLength(1);
  });

  it("does not offer backup downloads to a non-admin or inactive member", async () => {
    memberships = [
      {
        organizationId: LAB_ONE.id,
        role: "member",
        status: "active",
        organization: LAB_ONE,
      },
      {
        organizationId: LAB_TWO.id,
        role: "admin",
        status: "inactive",
        organization: LAB_TWO,
      },
    ];
    renderBackupSettings();

    expect(await screen.findByText(/An active owner or admin membership is required/i)).toBeInTheDocument();
    expect(screen.queryByTestId("download-lab-backup")).not.toBeInTheDocument();
  });

  it("shows an owner the lab backup without exposing platform-wide backup controls", async () => {
    memberships = [{
      organizationId: LAB_ONE.id,
      role: "owner",
      status: "active",
      organization: LAB_ONE,
    }];
    renderBackupSettings({ ...ADMIN_USER, role: "user" });

    expect(await screen.findByTestId("download-lab-backup")).toBeInTheDocument();
    expect(screen.queryByText("Back up all LabTrax data")).not.toBeInTheDocument();
    expect(screen.queryByText(/schedule backups/i)).not.toBeInTheDocument();
  });
});
