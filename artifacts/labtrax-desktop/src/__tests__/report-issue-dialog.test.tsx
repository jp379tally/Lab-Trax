/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  ReportIssueAction,
  ReportIssueDialog,
  FeedbackAction,
  canReportIssueRole,
  canReportIssueMembership,
  canReportIssueForSelectedOrganization,
} from "@/components/ReportIssueDialog";

const submit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetchFormData: submit }));

function openDialog(portal: "lab" | "provider" = "lab") {
  render(<ReportIssueDialog open onOpenChange={vi.fn()} portal={portal} />);
}
function file(name: string, type: string, size = 10) {
  return new File([new Uint8Array(size)], name, { type });
}

describe("ReportIssueDialog", () => {
  beforeEach(() => {
    submit.mockReset();
    submit.mockResolvedValue({});
    vi.spyOn(URL, "createObjectURL").mockImplementation((value) => `blob:${(value as File).name}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["lab", "provider"] as const)("submits ordinary %s member feedback through durable support intake", async (portal) => {
    render(<FeedbackAction portal={portal} />);
    fireEvent.click(screen.getByTestId(`button-feedback-${portal}`));
    fireEvent.change(screen.getByTestId("input-report-description"), { target: { value: "Please improve the case search." } });
    fireEvent.click(screen.getByTestId("button-submit-report-issue"));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][0]).toBe(`/support-reports?portal=${portal}&kind=feedback`);
    expect((submit.mock.calls[0][1] as FormData).get("description")).toBe("Please improve the case search.");
  });

  it("gates issue actions to owner and admin roles", () => {
    expect(canReportIssueRole("owner")).toBe(true);
    expect(canReportIssueRole("admin")).toBe(true);
    expect(canReportIssueRole("billing")).toBe(false);
    expect(canReportIssueRole("user")).toBe(false);
    expect(canReportIssueMembership({ role: "admin", status: "active" })).toBe(true);
    expect(canReportIssueMembership({ role: "admin", status: "inactive" })).toBe(false);
    expect(canReportIssueForSelectedOrganization([{ organizationId: "p1", role: "owner", status: "active" }], "p1")).toBe(true);
    expect(canReportIssueForSelectedOrganization([{ organizationId: "p1", role: "owner", status: "active" }], "p2")).toBe(false);
    render(<ReportIssueAction portal="provider" />);
    expect(screen.getByTestId("button-report-issue-provider")).toBeVisible();
  });

  it("requires a description and accepts disk files", async () => {
    openDialog();
    fireEvent.click(screen.getByTestId("button-submit-report-issue"));
    expect(screen.getByTestId("error-report-issue")).toHaveTextContent("describe");
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [file("note.txt", "text/plain")] } });
    expect(screen.getByText("note.txt")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("input-report-description"), { target: { value: "It is broken" } });
    fireEvent.click(screen.getByTestId("button-submit-report-issue"));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const form = submit.mock.calls[0][1] as FormData;
    expect(form.get("portal")).toBeNull();
    expect(form.get("description")).toBe("It is broken");
    expect((form.getAll("attachments")[0] as File).name).toBe("note.txt");
    expect(form.getAll("files")).toHaveLength(0);
    expect(submit.mock.calls[0][0]).toBe("/support-reports?portal=lab");
  });

  it("validates count, type, individual and total size limits", () => {
    openDialog();
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [file("bad.exe", "application/octet-stream")] } });
    expect(screen.getByRole("alert")).toHaveTextContent("supported");
    fireEvent.change(picker, { target: { files: [file("huge.txt", "text/plain", 5 * 1024 * 1024 + 1)] } });
    expect(screen.getByRole("alert")).toHaveTextContent("5 MiB");
    fireEvent.change(picker, { target: { files: Array.from({ length: 6 }, (_, i) => file(`${i}.txt`, "text/plain")) } });
    expect(screen.getByRole("alert")).toHaveTextContent("up to 5");
    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByTestId(`button-remove-attachment-0`));
    }
    fireEvent.change(picker, { target: { files: [file("a.txt", "text/plain", 4 * 1024 * 1024), file("b.txt", "text/plain", 4 * 1024 * 1024), file("c.txt", "text/plain", 3 * 1024 * 1024)] } });
    expect(screen.getByRole("alert")).toHaveTextContent("10 MiB");
  });

  it("turns a pasted clipboard image into a named attachment", () => {
    openDialog();
    const image = file("clipboard.png", "image/png");
    fireEvent.paste(screen.getByTestId("input-report-description"), {
      clipboardData: { files: [image] },
    });
    expect(screen.getByTestId("list-report-attachments").textContent).toMatch(/screenshot-.*\.png/);
    expect(screen.getByTestId("input-report-description")).toHaveValue("");
  });

  it("renders image thumbnails, opens a lightbox, removes files, and revokes URLs", () => {
    openDialog();
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [file("photo.png", "image/png")] } });
    expect(screen.getByAltText("photo.png")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-preview-attachment-0"));
    const previewDialog = screen.getByTestId("dialog-report-image-preview");
    expect(previewDialog).toHaveAttribute("aria-modal", "true");
    expect(previewDialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.click(screen.getByTestId("button-close-report-image-preview"));
    expect(screen.queryByTestId("dialog-report-image-preview")).not.toBeInTheDocument();
    const previewButton = screen.getByTestId("button-preview-attachment-0");
    expect(previewButton).toHaveFocus();
    fireEvent.click(previewButton);
    fireEvent.keyDown(screen.getByTestId("dialog-report-image-preview"), { key: "Escape" });
    expect(screen.queryByTestId("dialog-report-image-preview")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-remove-attachment-0"));
    expect(screen.queryByAltText("photo.png")).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:photo.png");
  });

  it("revokes remaining object URLs when the dialog unmounts", () => {
    const view = render(<ReportIssueDialog open onOpenChange={vi.fn()} portal="lab" />);
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [file("close.png", "image/png")] } });
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:close.png");
  });

  it("shows pending, success, and sanitized failure states", async () => {
    let resolve!: (value: unknown) => void;
    submit.mockImplementation(() => new Promise((r) => { resolve = r; }));
    openDialog("provider");
    fireEvent.change(screen.getByTestId("input-report-description"), { target: { value: "Provider issue" } });
    fireEvent.click(screen.getByTestId("button-submit-report-issue"));
    expect(screen.getByText("Submitting…")).toBeInTheDocument();
    expect(screen.getByTestId("status-report-pending")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByTestId("dialog-report-issue")).toHaveAttribute("aria-busy", "true");
    resolve({});
    await waitFor(() => expect(screen.getByTestId("status-report-success")).toBeInTheDocument());
    expect(submit.mock.calls[0][1]).toBeInstanceOf(FormData);
    expect((submit.mock.calls[0][1] as FormData).get("portal")).toBeNull();
    expect(submit.mock.calls[0][0]).toBe("/support-reports?portal=provider");

    submit.mockRejectedValueOnce(new Error("Request failed (400) https://private.example/api/token"));
    fireEvent.click(screen.getByTestId("button-close-report-success"));
    // Re-open a fresh dialog after the successful submission.
    render(<ReportIssueDialog open onOpenChange={vi.fn()} portal="lab" />);
    fireEvent.change(screen.getAllByTestId("input-report-description").at(-1)!, { target: { value: "Fail" } });
    fireEvent.click(screen.getAllByTestId("button-submit-report-issue").at(-1)!);
    await waitFor(() => expect(screen.getAllByTestId("error-report-issue").at(-1)).toHaveTextContent("Request failed"));
    expect(screen.getAllByTestId("error-report-issue").at(-1)).not.toHaveTextContent("private.example");
  });

  it("reuses a key only for an unchanged ambiguous retry", async () => {
    submit.mockRejectedValue(new Error("network response was lost"));
    const view = render(<ReportIssueDialog open onOpenChange={vi.fn()} portal="lab" />);
    const description = screen.getByTestId("input-report-description");
    fireEvent.change(description, { target: { value: "First payload" } });
    fireEvent.click(screen.getByTestId("button-submit-report-issue"));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const firstKey = submit.mock.calls[0][2].headers["Idempotency-Key"];

    fireEvent.click(screen.getByTestId("button-submit-report-issue"));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1][2].headers["Idempotency-Key"]).toBe(firstKey);

    fireEvent.change(description, { target: { value: "Changed payload" } });
    fireEvent.click(screen.getByTestId("button-submit-report-issue"));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(3));
    const changedKey = submit.mock.calls[2][2].headers["Idempotency-Key"];
    expect(changedKey).not.toBe(firstKey);

    view.rerender(<ReportIssueDialog open={false} onOpenChange={vi.fn()} portal="lab" />);
    view.rerender(<ReportIssueDialog open onOpenChange={vi.fn()} portal="lab" />);
    fireEvent.change(screen.getByTestId("input-report-description"), { target: { value: "New dialog payload" } });
    fireEvent.click(screen.getByTestId("button-submit-report-issue"));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(4));
    expect(submit.mock.calls[3][2].headers["Idempotency-Key"]).not.toBe(changedKey);
  });
});