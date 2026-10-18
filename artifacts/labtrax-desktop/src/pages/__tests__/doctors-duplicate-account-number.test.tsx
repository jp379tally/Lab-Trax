/** @vitest-environment jsdom */
/**
 * The Doctors page "Suggested merges" panel must name the provider account
 * each duplicate row already owns (Task #4397).
 *
 * Merging or consolidating duplicates keeps the doctor's existing account and
 * its number — nothing is minted and nothing is reissued — so the panel spells
 * out which account survives instead of leaving the admin to guess.
 *
 * Three things are covered:
 *  - a server cluster folded in directly (duplicate accounts with no cases);
 *  - the browser-side scan over cases, which has no account numbers of its own
 *    and must borrow them from the server's view of the same rows;
 *  - the difference between the two operations: merging NAMES retires no
 *    account, so every row keeps its own, while consolidating ACCOUNTS keeps
 *    only the cluster's oldest number and retires the rest. A near-name
 *    account cluster whose members each own a different account must label
 *    exactly one row as kept, never all of them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SessionUser } from "@/lib/api";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const LAB_ID = "lab-1";
const PRACTICE_ID = "prov-1";

// A near-name account cluster: each row owns a DIFFERENT account, and
// consolidating keeps only the cluster's oldest number (1526BK).
const SERVER_CLUSTER = {
  labOrganizationId: LAB_ID,
  labName: "Lab One",
  topScore: 1,
  clusterKey: `${LAB_ID}::dr. brittney craig|${PRACTICE_ID}||brittney k. craig|${PRACTICE_ID}`,
  kind: "account",
  conflictReason: null,
  survivingAccountNumber: "1526BK",
  doctors: [
    {
      doctorName: "Dr. Brittney Craig",
      providerOrganizationId: PRACTICE_ID,
      practiceName: "Alpha Dental",
      totalCases: 0,
      accountCount: 4,
      platformAccountNumber: "1526BK",
    },
    {
      doctorName: "Synthetic Provider Alpha",
      providerOrganizationId: PRACTICE_ID,
      practiceName: "Alpha Dental",
      totalCases: 0,
      accountCount: 1,
      platformAccountNumber: "5026CD",
    },
  ],
};

// The same rows the local (case-derived) scan finds below, so the panel can
// borrow their account numbers even though the local scan never sees any.
const NAME_CLUSTER = {
  labOrganizationId: LAB_ID,
  labName: "Lab One",
  topScore: 0.92,
  clusterKey: `${LAB_ID}::dr able|${PRACTICE_ID}||dr. able|${PRACTICE_ID}`,
  kind: "name",
  conflictReason: null,
  survivingAccountNumber: null,
  doctors: [
    {
      doctorName: "Dr Able",
      providerOrganizationId: PRACTICE_ID,
      practiceName: "Alpha Dental",
      totalCases: 1,
      accountCount: 1,
      platformAccountNumber: "0925AB",
    },
    {
      doctorName: "Dr. Able",
      providerOrganizationId: PRACTICE_ID,
      practiceName: "Alpha Dental",
      totalCases: 1,
      accountCount: 0,
      platformAccountNumber: null,
    },
  ],
};

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetDoctorDuplicateClusters: () => ({
      data: {
        data: {
          totalGroups: 2,
          totalDoctors: 4,
          clusters: [SERVER_CLUSTER, NAME_CLUSTER],
          dismissedClusters: [],
        },
      },
      isLoading: false,
    }),
    useDismissDoctorDuplicateCluster: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useRestoreDoctorDuplicateCluster: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useListUnassignedDoctors: () => ({ data: { ok: true, data: [] } }),
  };
});

import DoctorsPage from "@/pages/doctors";

const ADMIN_USER = {
  id: "u1",
  username: "admin",
  role: "admin",
  userType: "lab",
} as unknown as SessionUser;

const ME = {
  user: ADMIN_USER,
  memberships: [
    {
      organizationId: LAB_ID,
      status: "active",
      role: "admin",
      organization: { id: LAB_ID, name: "Lab One", type: "lab" },
    },
  ],
};

// Two near-duplicate names on cases so the browser-side scan produces the
// local twin of NAME_CLUSTER.
const CASES = ["Dr Able", "Dr. Able"].map((doctorName, idx) => ({
  id: `case-${idx + 1}`,
  doctorName,
  providerOrganizationId: PRACTICE_ID,
  labOrganizationId: LAB_ID,
  status: "in_progress",
  priority: "standard",
  totalPrice: "100.00",
  createdAt: `2026-06-0${idx + 1}T10:00:00.000Z`,
}));

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url, "http://localhost").pathname;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (path.endsWith("/cases")) return json(CASES);
      if (path.endsWith("/invoices")) return json([]);
      if (path.endsWith("/organizations"))
        return json([
          { id: PRACTICE_ID, name: "Alpha Dental", type: "provider" },
        ]);
      if (path.endsWith("/auth/me")) return json(ME);
      return json({});
    }),
  );
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
});

function renderPage() {
  const Wrapper = makeAuthWrapper("/doctors", {
    user: ADMIN_USER,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
  });
  render(
    <Wrapper>
      <DoctorsPage />
    </Wrapper>,
  );
}

describe("Doctors duplicate panel — account kept on merge", () => {
  it("calls only the cluster survivor kept when accounts are consolidated", async () => {
    renderPage();

    expect(await screen.findByText(/keeps account #1526BK/)).toBeTruthy();
    // The other member's account is retired onto the survivor — claiming it is
    // kept, right beside the Consolidate button, would be a lie.
    expect(screen.getByText(/account #5026CD retires/)).toBeTruthy();
    expect(screen.queryByText(/keeps account #5026CD/)).toBeNull();
    expect(screen.queryByText(/account #null/)).toBeNull();
  });

  it("annotates the locally-scanned name cluster with the server's account number", async () => {
    renderPage();

    // "Dr Able" is found by the browser-side scan (it has cases), so its
    // account number can only come from the server's matching row. A name
    // merge retires nothing, so it reads as kept.
    expect(await screen.findByText(/keeps account #0925AB/)).toBeTruthy();
    expect(screen.queryByText(/account #0925AB retires/)).toBeNull();
  });
});
