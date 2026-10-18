/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/pages/settings";
import { makeAuthWrapper } from "../../__tests__/test-utils";

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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
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
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
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
