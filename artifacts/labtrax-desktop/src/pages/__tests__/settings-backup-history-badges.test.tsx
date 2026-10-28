/** @vitest-environment jsdom */
/**
 * Regression guard: Settings → Backup → history badges.
 *
 * A OneDrive backup upload that includes profile-photos can fail and fall
 * back to a smaller upload without them (see runOneDriveBackup in
 * artifacts/api-server/src/lib/backup.ts). That partial success must stay
 * operator-visible instead of silently succeeding: the recorded run carries
 * `partialFailure`/`warnings`, and the Backup history table must surface a
 * yellow "Partial" badge for it, alongside the pre-existing "No media" badge
 * used when attachment rows exist but no media files were found.
 *
 * Keep this test permanently per REGRESSION_GUARDRAILS.md policy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/pages/settings";
import { makeAuthWrapper } from "../../__tests__/test-utils";

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

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const NO_MEDIA_RUN = {
  id: 1,
  triggeredBy: "schedule",
  destination: "onedrive",
  path: null,
  fileName: "backup-no-media.zip.enc",
  sizeBytes: 12_345,
  status: "success",
  error: null,
  completedAt: "2026-08-20T03:00:00.000Z",
  mediaFileCount: 0,
  attachmentRowCount: 5,
  partialFailure: false,
  warnings: null,
  archiveKind: "complete-production",
};

const PARTIAL_RUN = {
  id: 2,
  triggeredBy: "schedule",
  destination: "onedrive",
  path: null,
  fileName: "backup-partial.zip.enc",
  sizeBytes: 22_222,
  status: "success",
  error: null,
  completedAt: "2026-08-21T03:00:00.000Z",
  mediaFileCount: 10,
  attachmentRowCount: 10,
  partialFailure: true,
  warnings: "Missing file references: 526. This archive is not a complete recovery point.",
};

const CLEAN_RUN = {
  id: 3,
  triggeredBy: "schedule",
  destination: "onedrive",
  path: null,
  fileName: "backup-clean.zip.enc",
  sizeBytes: 33_333,
  status: "success",
  error: null,
  completedAt: "2026-08-22T03:00:00.000Z",
  mediaFileCount: 10,
  attachmentRowCount: 10,
  partialFailure: false,
  warnings: null,
  archiveKind: "complete-production",
};

let historyRuns: Array<Record<string, unknown>>;

beforeEach(() => {
  historyRuns = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/admin/backup/history-retention")) {
        return jsonResponse({
          ok: true,
          retentionDays: 30,
          dbRetentionDays: null,
          envRetentionDays: 30,
          maxRows: 200,
          dbMaxRows: null,
          envMaxRows: 200,
        });
      }
      if (url.includes("/admin/backup/history")) {
        return jsonResponse({ ok: true, runs: historyRuns });
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

async function renderBackupTab() {
  const Wrapper = makeAuthWrapper("/settings?tab=backup", {
    user: ADMIN_USER as any,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
    refresh: vi.fn(async () => {}),
  });
  return render(<Wrapper><SettingsPage /></Wrapper>);
}

describe("Settings → Backup → history badges", () => {
  it("keeps the full history table and restore selection reachable in its own scroll region", async () => {
    historyRuns = [CLEAN_RUN];
    await renderBackupTab();

    const historyRegion = await screen.findByRole("region", { name: "Recent backup history" });
    expect(historyRegion).toHaveAttribute("tabindex", "0");
    expect(historyRegion).toHaveClass("overflow-x-auto");
    expect(screen.getByRole("columnheader", { name: "Triggered by" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Select backup from/ })).toBeInTheDocument();
  });

  it("shows actionable failure details, not only a hover tooltip", async () => {
    historyRuns = [{ ...CLEAN_RUN, status: "error", error: "Backup failed during case-media transfer after 60s: App Storage stalled." }];
    await renderBackupTab();
    const summary = await screen.findByText(/The backup did not complete, so no new complete recovery point was created/);
    expect(summary).toBeVisible();
    const details = await screen.findByText("Failure details");
    fireEvent.click(details);
    expect(screen.getByText(/Backup failed during case-media transfer after 60s/)).toBeVisible();
  });
  it("shows a yellow Partial badge for a run flagged partialFailure, with the warning as its tooltip", async () => {
    historyRuns = [PARTIAL_RUN];
    await renderBackupTab();

    const badge = await screen.findByText("Partial");
    await waitFor(() => expect(badge.closest("span")).toHaveAttribute("title", PARTIAL_RUN.warnings));
  });

  it("shows the No media badge for a run with attachment rows but zero media files, independent of Partial", async () => {
    historyRuns = [NO_MEDIA_RUN];
    await renderBackupTab();

    await screen.findByText("No media");
    expect(screen.queryByText("Partial")).not.toBeInTheDocument();
  });

  it("shows both badges together when a run is both missing media and partially failed", async () => {
    historyRuns = [
      {
        ...NO_MEDIA_RUN,
        id: 4,
        partialFailure: PARTIAL_RUN.partialFailure,
        warnings: PARTIAL_RUN.warnings,
      },
    ];
    await renderBackupTab();

    await screen.findByText("No media");
    await screen.findByText("Partial");
  });

  it("shows neither badge for a normal successful run", async () => {
    historyRuns = [CLEAN_RUN];
    await renderBackupTab();

    await waitFor(() => expect(screen.getByText("OK")).toBeInTheDocument());
    expect(screen.queryByText("No media")).not.toBeInTheDocument();
    expect(screen.queryByText("Partial")).not.toBeInTheDocument();
    expect(screen.getByText("Complete production database + all files")).toBeVisible();
  });
  it("does not relabel historical or development copies as complete production protection", async () => {
    historyRuns = [
      { ...CLEAN_RUN, id: 5, archiveKind: "full" },
      { ...CLEAN_RUN, id: 6, archiveKind: "complete-non-production" },
    ];
    await renderBackupTab();
    expect(await screen.findByText("Historical full — narrower/unverified coverage")).toBeVisible();
    expect(screen.getByText("Complete non-production — not production protection")).toBeVisible();
  });
});
