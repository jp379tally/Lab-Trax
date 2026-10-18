/** @vitest-environment jsdom */
/**
 * Exception Cases dashboard card — queue rendering and states.
 *
 * The card replaced the platform-admin-only Media Cleanup box, so it must be
 * usable by ordinary lab members: it loads the active queue itself, shows a
 * count, surfaces patient/case identity, an issue preview, age + author and a
 * media indicator, and it distinguishes loading / error / empty rather than
 * collapsing them into "nothing here".
 */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { ExceptionCasesCard, patientLabel } from "../ExceptionCasesCard";
import { makeWrapper } from "../../__tests__/test-utils";
import type { CaseExceptionQueueItem } from "@/lib/types";

function makeItem(
  overrides: Partial<CaseExceptionQueueItem> = {},
): CaseExceptionQueueItem {
  return {
    id: "exc_1",
    labOrganizationId: "lab_1",
    caseId: "case_1",
    caseKind: "canonical",
    status: "active",
    issueText: "Margin is short on #14",
    createdByUserId: "user_1",
    createdByName: "Tina Tech",
    createdAt: new Date().toISOString(),
    resolvedByUserId: null,
    resolvedByName: null,
    resolvedAt: null,
    resolutionNote: null,
    resolutionLabLocationId: null,
    resolutionStatus: null,
    previousStatus: "in_design",
    caseNumber: "SYN-CASE-001",
    patientFirstName: "Ada",
    patientLastName: "Lovelace",
    doctorName: "Dr. Synthetic042",
    caseStatus: "on_hold",
    mediaCount: 0,
    hasMedia: false,
    noteCount: 0,
    latestNoteText: null,
    latestNoteAuthorName: null,
    latestNoteCreatedAt: null,
    ...overrides,
  } as CaseExceptionQueueItem;
}

function renderCard(onSelectCase?: (id: string) => void) {
  const Wrapper = makeWrapper("/");
  return render(
    <Wrapper>
      <ExceptionCasesCard onSelectCase={onSelectCase} />
    </Wrapper>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
});

describe("ExceptionCasesCard", () => {
  it("shows a loading state before the queue resolves", async () => {
    let release: (v: unknown) => void = () => {};
    apiFetch.mockReturnValue(new Promise((r) => (release = r)));

    renderCard();
    expect(screen.getByTestId("exception-cases-loading")).toBeTruthy();

    release({ exceptions: [] });
    await waitFor(() =>
      expect(screen.queryByTestId("exception-cases-loading")).toBeNull(),
    );
  });

  it("renders each active exception with identity, issue, author and a media indicator", async () => {
    apiFetch.mockResolvedValue({
      exceptions: [
        makeItem(),
        makeItem({
          id: "exc_2",
          caseId: "legacy_2",
          caseKind: "legacy",
          caseNumber: "MOB-77",
          patientFirstName: "Legacy",
          patientLastName: "Mobile",
          issueText: "Wrong shade sent",
          hasMedia: true,
          mediaCount: 2,
        }),
      ],
    });

    renderCard();

    await waitFor(() =>
      expect(screen.getByTestId("exception-cases-count").textContent).toBe("2"),
    );
    expect(apiFetch).toHaveBeenCalledWith("/case-exceptions/active");

    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(
      screen.getByTestId("exception-case-location-case_1").textContent,
    ).toContain("On Hold");
    expect(screen.getByText(/Margin is short on #14/)).toBeTruthy();
    expect(screen.getByText(/Case SYN-CASE-001/)).toBeTruthy();
    expect(screen.getAllByText(/Tina Tech/).length).toBe(2);

    // Legacy mobile-originated cases sit in the same queue.
    expect(screen.getByText("Legacy Mobile")).toBeTruthy();

    // Only the row that actually has media gets the paperclip.
    expect(screen.getByTestId("exception-case-media-legacy_2")).toBeTruthy();
    expect(screen.queryByTestId("exception-case-media-case_1")).toBeNull();
  });

  it("opens the case drawer for the clicked row (canonical and legacy ids alike)", async () => {
    const onSelectCase = vi.fn();
    apiFetch.mockResolvedValue({
      exceptions: [
        makeItem(),
        makeItem({ id: "exc_2", caseId: "legacy_2", caseKind: "legacy" }),
      ],
    });

    renderCard(onSelectCase);

    await waitFor(() =>
      expect(screen.getByTestId("exception-case-row-case_1")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("exception-case-row-case_1"));
    expect(onSelectCase).toHaveBeenCalledWith("case_1");

    fireEvent.click(screen.getByTestId("exception-case-row-legacy_2"));
    expect(onSelectCase).toHaveBeenCalledWith("legacy_2");
  });

  it("previews the newest follow-up note with its matching author", async () => {
    const openerAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const latestNoteAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    apiFetch.mockResolvedValue({
      exceptions: [
        makeItem({
          noteCount: 2,
          createdAt: openerAt.toISOString(),
          latestNoteText: "Newest conversation update",
          latestNoteAuthorName: "Olive Owner",
          latestNoteCreatedAt: latestNoteAt.toISOString(),
        }),
      ],
    });
    renderCard();
    await waitFor(() =>
      expect(screen.getByText("Newest conversation update")).toBeTruthy(),
    );
    expect(screen.getByText(/Olive Owner/)).toBeTruthy();
    expect(screen.getByText(/2h ago/)).toBeTruthy();
    expect(screen.queryByText("Margin is short on #14")).toBeNull();
    expect(screen.queryByText(/Tina Tech/)).toBeNull();
    expect(screen.queryByText(/5d ago/)).toBeNull();
  });

  it("shows the live location beside the patient name, falling back to case status", async () => {
    apiFetch.mockResolvedValue({
      exceptions: [
        makeItem({ currentLocationName: "Porcelain Bench", caseStatus: "qc" }),
        makeItem({
          id: "exc_2",
          caseId: "case_2",
          currentLocationName: null,
          caseStatus: "in_design",
        }),
      ],
    });

    renderCard();

    await waitFor(() =>
      expect(
        screen.getByTestId("exception-case-location-case_1").textContent,
      ).toContain("Porcelain Bench"),
    );
    expect(
      screen.getByTestId("exception-case-location-case_2").textContent,
    ).toContain("In Design");
  });

  it("shows an explicit empty state (with no count badge) when nothing is flagged", async () => {
    apiFetch.mockResolvedValue({ exceptions: [] });
    renderCard();

    await waitFor(() =>
      expect(screen.getByTestId("exception-cases-empty")).toBeTruthy(),
    );
    expect(screen.queryByTestId("exception-cases-count")).toBeNull();
  });

  it("shows an error state rather than a misleading empty queue", async () => {
    apiFetch.mockRejectedValue(new Error("boom"));
    renderCard();

    await waitFor(() =>
      expect(screen.getByTestId("exception-cases-error")).toBeTruthy(),
    );
    expect(screen.queryByTestId("exception-cases-empty")).toBeNull();
  });

  it("collapses and expands the queue", async () => {
    apiFetch.mockResolvedValue({ exceptions: [makeItem()] });
    renderCard();

    await waitFor(() =>
      expect(screen.getByTestId("exception-case-row-case_1")).toBeTruthy(),
    );
    fireEvent.click(screen.getByLabelText("Collapse exception cases"));
    expect(screen.queryByTestId("exception-case-row-case_1")).toBeNull();

    fireEvent.click(screen.getByLabelText("Expand exception cases"));
    expect(screen.getByTestId("exception-case-row-case_1")).toBeTruthy();
  });
});

describe("patientLabel", () => {
  it("falls back when the case carries no patient name (common for legacy rows)", () => {
    expect(
      patientLabel({ patientFirstName: null, patientLastName: null }),
    ).toBe("Unnamed patient");
    expect(
      patientLabel({ patientFirstName: "Ada", patientLastName: null }),
    ).toBe("Ada");
  });
});
