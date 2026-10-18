import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { resetMockAppState, setMockAppState } from "../../vitest.setup";
import ReportIssueScreen from "../settings/report-issue";

const support = vi.hoisted(() => ({
  submit: vi.fn(async () => ({ ok: true, copySent: true })),
}));

vi.mock("@/lib/support-reports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/support-reports")>();
  return { ...actual, submitSupportReport: support.submit };
});

vi.mock("expo-file-system", () => ({
  File: class {
    size = 2048;
  },
}));

function membership(role: string, status = "active") {
  return {
    organizationId: "lab-1",
    role,
    status,
    organization: { id: "lab-1", type: "lab" },
  };
}

function providerMembership(role: string, status = "active") {
  return {
    organizationId: "provider-1",
    role,
    status,
    organization: { id: "provider-1", type: "provider" },
  };
}

describe("Report an Issue screen", () => {
  beforeEach(() => {
    support.submit.mockClear();
    setMockAppState({ meMemberships: [membership("admin")] });
  });

  afterEach(() => {
    cleanup();
    resetMockAppState();
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockReset();
    vi.mocked(DocumentPicker.getDocumentAsync).mockReset();
  });

  it.each([
    ["user", "active"],
    ["billing", "active"],
    ["admin", "inactive"],
  ])("denies direct access for role %s with status %s", async (role, status) => {
    setMockAppState({ meMemberships: [membership(role, status)] });
    const screen = await render(<ReportIssueScreen />);
    expect(screen.getByText("Administrator access required")).toBeTruthy();
    expect(screen.queryByTestId("report-issue-submit")).toBeNull();
  });

  it.each(["owner", "admin"])("allows an active %s to open the report form", async (role) => {
    setMockAppState({ meMemberships: [membership(role)] });
    expect((await render(<ReportIssueScreen />)).getByTestId("report-issue-submit")).toBeTruthy();
  });

  it("selects a screenshot, previews it, removes it, and submits the remaining supported file", async () => {
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///screenshot.png", fileName: "screen.png", fileSize: 4096 }],
    } as any);
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///diagnostic.txt", name: "diagnostic.txt", mimeType: "text/plain", size: 1024 }],
    } as any);

    const screen = await render(<ReportIssueScreen />);
    await fireEvent.press(screen.getByTestId("report-issue-pick-screenshots"));
    await waitFor(() => expect(screen.getByText("screen.jpg")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("report-issue-preview-0"));
    await fireEvent.press(screen.getByTestId("report-issue-preview-close"));
    await fireEvent.press(screen.getByTestId("report-issue-pick-files"));
    await waitFor(() => expect(screen.getByText("diagnostic.txt")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("report-issue-remove-0"));
    expect(screen.queryByText("screen.jpg")).toBeNull();
    await fireEvent.changeText(screen.getByTestId("report-issue-description"), "Timeline does not update");
    await fireEvent.press(screen.getByTestId("report-issue-submit"));

    await waitFor(() => {
      expect(support.submit).toHaveBeenCalledWith("Timeline does not update", [
        expect.objectContaining({ name: "diagnostic.txt", mimeType: "text/plain" }),
      ], { portal: "lab" }, "issue");
      expect(screen.getByTestId("report-issue-success")).toBeTruthy();
    });
  });

  it("submits provider administrators in their provider organization context", async () => {
    setMockAppState({ meMemberships: [providerMembership("admin")] });
    const screen = await render(<ReportIssueScreen />);
    await fireEvent.changeText(screen.getByTestId("report-issue-description"), "Provider issue");
    await fireEvent.press(screen.getByTestId("report-issue-submit"));
    await waitFor(() => expect(support.submit).toHaveBeenCalledWith(
      "Provider issue",
      [],
      { portal: "provider", providerOrganizationId: "provider-1" }, "issue",
    ));
  });

  it("keeps server authorization errors visible", async () => {
    support.submit.mockRejectedValueOnce(new Error("Support reports require lab administrator access."));
    const screen = await render(<ReportIssueScreen />);
    await fireEvent.changeText(screen.getByTestId("report-issue-description"), "Issue");
    await fireEvent.press(screen.getByTestId("report-issue-submit"));
    await waitFor(() => expect(screen.getByText("Support reports require lab administrator access.")).toBeTruthy());
  });
});