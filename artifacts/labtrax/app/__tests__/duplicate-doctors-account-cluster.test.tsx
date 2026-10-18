/**
 * The mobile possible-duplicates screen must say which provider account
 * survives before it consolidates duplicate accounts (Task #4397).
 *
 * Two different operations share this list:
 *  - a NAME cluster opens the merge sheet; merging names moves cases and
 *    pricing only, so every doctor keeps the account they already have and no
 *    row may be singled out here — the sheet decides who is kept;
 *  - an ACCOUNT cluster consolidates on tap, with no sheet in between. That
 *    collapses the whole cluster onto the oldest account number and retires
 *    the rest, so exactly one row may read "keeps" and the others have to say
 *    they are being retired — before the tap, not after.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react-native";

const refetch = vi.fn();
const consolidateHandle = { mutate: vi.fn(), isPending: false };

// Both account rows own a DIFFERENT account; 1526BK is the cluster's oldest,
// so it is the one consolidation keeps.
const ACCOUNT_CLUSTER = {
  labOrganizationId: "lab-1",
  labName: "Acme Dental Lab",
  topScore: 0.97,
  clusterKey: "lab-1::dr. brittney craig|org-1||brittney k. craig|org-1",
  kind: "account" as const,
  conflictReason: null,
  survivingAccountNumber: "1526BK",
  doctors: [
    {
      doctorName: "Dr. Brittney Craig",
      providerOrganizationId: "org-1",
      practiceName: "Alpha Dental",
      totalCases: 0,
      accountCount: 1,
      platformAccountNumber: "1526BK",
    },
    {
      doctorName: "Synthetic Provider Alpha",
      providerOrganizationId: "org-1",
      practiceName: "Alpha Dental",
      totalCases: 0,
      accountCount: 1,
      platformAccountNumber: "5026CD",
    },
  ],
};

const NAME_CLUSTER = {
  labOrganizationId: "lab-1",
  labName: "Acme Dental Lab",
  topScore: 0.91,
  clusterKey: "lab-1::dr able|org-1||dr. able|org-1",
  kind: "name" as const,
  conflictReason: null,
  survivingAccountNumber: null,
  doctors: [
    {
      doctorName: "Dr Able",
      providerOrganizationId: "org-1",
      practiceName: "Alpha Dental",
      totalCases: 3,
      accountCount: 1,
      platformAccountNumber: "0925AB",
    },
    {
      doctorName: "Dr. Able",
      providerOrganizationId: "org-1",
      practiceName: "Alpha Dental",
      totalCases: 1,
      accountCount: 0,
      platformAccountNumber: null,
    },
  ],
};

vi.mock("@/lib/duplicate-doctors", () => ({
  useDuplicateDoctorClusters: () => ({
    query: {
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch,
    },
    clusters: [ACCOUNT_CLUSTER, NAME_CLUSTER],
    totalGroups: 2,
    enabled: true,
  }),
  useConsolidateDoctorAccounts: () => consolidateHandle,
}));

// The merge sheet has its own coverage and pulls in the merge mutations; this
// screen test only cares about the cluster cards.
vi.mock("@/components/DoctorMergeSheet", () => ({
  DoctorMergeSheet: () => null,
}));

import DuplicateDoctorsScreen from "../duplicate-doctors";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Possible duplicates — account kept on consolidation", () => {
  it("names the surviving account and marks the others as retiring", async () => {
    await render(<DuplicateDoctorsScreen />);

    expect(screen.getByText("Keeps account #1526BK")).toBeTruthy();
    expect(
      screen.getByText("Account #5026CD retires onto #1526BK"),
    ).toBeTruthy();
    // The card explains the whole operation before the tap that runs it.
    expect(
      screen.getByText(
        /Consolidating keeps account #1526BK — the other accounts are retired onto it\./,
      ),
    ).toBeTruthy();
    expect(screen.getByText("Tap to consolidate accounts")).toBeTruthy();
  });

  it("never calls a retiring account kept", async () => {
    await render(<DuplicateDoctorsScreen />);

    expect(screen.queryByText("Keeps account #5026CD")).toBeNull();
    expect(screen.queryByText(/account #null/i)).toBeNull();
  });

  it("leaves a name cluster's accounts neutral — a name merge retires none", async () => {
    await render(<DuplicateDoctorsScreen />);

    // Which doctor is kept is chosen in the sheet, and both keep their own
    // account either way, so the card states what the row has and no more.
    expect(screen.getByText("Account #0925AB")).toBeTruthy();
    expect(screen.queryByText(/#0925AB retires/)).toBeNull();
    expect(screen.queryByText("Keeps account #0925AB")).toBeNull();
  });
});
