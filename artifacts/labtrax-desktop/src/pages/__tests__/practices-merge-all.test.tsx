/** @vitest-environment jsdom */
/**
 * Regression suite: "Merge all duplicate practices from the suggestion banner".
 *
 * Task #2474 made brand-prefixed / bracketed-code duplicate practices cluster
 * in the desktop "Suggested duplicates" banner, but an admin still had to open
 * and merge each surfaced cluster one at a time. MergeAllPracticesDialog is the
 * guided bulk flow: it lists every surfaced cluster with an auto-picked
 * survivor, lets the admin exclude any cluster, and on confirm merges them one
 * /practices/merge call per cluster.
 *
 * These tests pin:
 *  - pickPracticeMergeTarget chooses the most-populated practice as survivor.
 *  - "Merge" fires exactly one merge call per included cluster, each with the
 *    correct target + source ids.
 *  - An excluded cluster is NOT merged.
 *  - Nothing merges until the admin clicks the confirm button (no auto-merge).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import type { Organization } from "@/lib/types";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

import {
  MergeAllPracticesDialog,
  pickPracticeMergeTarget,
  buildPracticeDuplicateClusters,
  DEFAULT_PRACTICE_DUP_SIMILARITY_THRESHOLD,
} from "@/pages/practices";

const LAB_ID = "lab1";

function provider(
  id: string,
  name: string,
  extra: Partial<Organization> = {},
): Organization {
  return {
    id,
    type: "provider",
    name,
    parentLabOrganizationId: LAB_ID,
    isActive: true,
    ...extra,
  };
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({ casesMoved: 2, invoicesMoved: 1 });
});

describe("pickPracticeMergeTarget", () => {
  it("returns the most-populated practice as the survivor", () => {
    const bare = provider("p1", "Riverbend Family Dental");
    const rich = provider("p2", "Riverbend Family Dental", {
      displayName: "Riverbend Family Dental",
      billingEmail: "office@riverbend.example",
      phone: "555-1212",
      addressLine1: "1 Main St",
    });
    expect(pickPracticeMergeTarget([bare, rich])?.id).toBe("p2");
  });

  it("returns null for an empty list", () => {
    expect(pickPracticeMergeTarget([])).toBeNull();
  });
});

describe("MergeAllPracticesDialog", () => {
  function twoClusters() {
    const practices = [
      provider("a1", "Riverbend Family Dental", {
        billingEmail: "office@riverbend.example",
      }),
      provider("a2", "Sample Dental Group - Riverbend Family Dental [101]"),
      provider("b1", "Summit Dental Care", {
        billingEmail: "office@summit.example",
      }),
      provider("b2", "Sample Dental Group - Summit Dental Care [202]"),
    ];
    return buildPracticeDuplicateClusters(
      practices,
      new Set([LAB_ID]),
      DEFAULT_PRACTICE_DUP_SIMILARITY_THRESHOLD,
    );
  }

  it("merges one call per cluster with the correct target + sources", async () => {
    const clusters = twoClusters();
    expect(clusters).toHaveLength(2);

    render(
      <MergeAllPracticesDialog
        clusters={clusters}
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />,
      { wrapper: makeAuthWrapper() },
    );

    // Nothing should be merged before the admin confirms.
    expect(apiFetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Merge 2 clusters/ }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));

    const payloads = apiFetchMock.mock.calls.map(([url, opts]) => {
      expect(url).toBe("/practices/merge");
      return JSON.parse((opts as { body: string }).body);
    });

    // Survivor of each cluster = the one with the billing email (a1 / b1).
    const byTarget = new Map(payloads.map((p) => [p.targetOrganizationId, p]));
    expect(byTarget.get("a1")?.sourceOrganizationIds).toEqual(["a2"]);
    expect(byTarget.get("b1")?.sourceOrganizationIds).toEqual(["b2"]);

    await screen.findByText(/Merge complete/);
  });

  it("does not merge a cluster the admin excludes", async () => {
    const clusters = twoClusters();
    render(
      <MergeAllPracticesDialog
        clusters={clusters}
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />,
      { wrapper: makeAuthWrapper() },
    );

    // Uncheck the first cluster's include checkbox.
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);

    fireEvent.click(screen.getByRole("button", { name: /^Merge 1 cluster/ }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
  });
});
