/**
 * The mobile duplicate-merge sheet must name the provider account the kept
 * doctor keeps (Task #4397).
 *
 * Merging duplicate doctor NAMES rewrites cases and pricing only — it never
 * creates, moves, or reissues a provider account. The sheet used to say just
 * that ("no account is created"), which left an admin guessing which of four
 * look-alike rows owns the surviving account. The duplicate-cluster endpoint
 * now returns each row's existing account number, so the sheet names it:
 *
 *  - the kept (selected) row reads "Keeps account #…";
 *  - the other rows read "Has account #…" so the admin can compare before
 *    picking;
 *  - each account sits on its own wrapping line, NOT appended to the
 *    single-line practice/case summary, so a long practice name can never
 *    ellipsize the number away on a phone;
 *  - a row with no provider account shows no account text at all;
 *  - the preview sentence names the kept doctor's account, and falls back to
 *    the "no new account" wording when the kept doctor has none.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Stable hook handles: the sheet resets the preview inside an effect keyed on
// the mutation handle, so a fresh object per render would loop forever.
vi.mock("@workspace/api-client-react", () => {
  const previewHandle = {
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    data: {
      data: {
        totalCases: 5,
        totalOverrides: 1,
        targetExists: true,
        targetCases: 3,
      },
    },
  };
  const mergeHandle = { mutate: vi.fn(), isPending: false };
  return {
    usePreviewDoctorMerge: () => previewHandle,
    useMergeDoctors: () => mergeHandle,
    undoDoctorMerge: vi.fn(),
    getGetDoctorDuplicateClustersQueryKey: () => ["doctor-duplicate-clusters"],
  };
});

import { DoctorMergeSheet } from "@/components/DoctorMergeSheet";

const PRACTICE_ID = "org-9";

const CLUSTER = {
  labOrganizationId: "lab-1",
  labName: "Acme Dental Lab",
  topScore: 0.95,
  clusterKey: `lab-1::dr. kanesha cole|${PRACTICE_ID}||kanesha cole|${PRACTICE_ID}`,
  kind: "name" as const,
  conflictReason: null,
  doctors: [
    {
      doctorName: "Dr. Kanesha Cole",
      providerOrganizationId: PRACTICE_ID,
      practiceName: "Summit Dental Care",
      totalCases: 6,
      accountCount: 1,
      platformAccountNumber: "1526BK",
    },
    {
      doctorName: "Kanesha Cole",
      providerOrganizationId: PRACTICE_ID,
      practiceName: "Summit Dental Care",
      totalCases: 2,
      accountCount: 0,
      platformAccountNumber: null,
    },
  ],
};

async function renderSheet() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DoctorMergeSheet cluster={CLUSTER} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("DoctorMergeSheet — account the kept doctor keeps", () => {
  it("marks the kept doctor's account and leaves a name-only doctor bare", async () => {
    await renderSheet();

    // Default target is the doctor with the most cases — they keep their account.
    expect(screen.getByText("Keeps account #1526BK")).toBeTruthy();
    // The account is its own line; the summary line stays as it was.
    expect(
      screen.getByText("Summit Dental Care · 6 cases"),
    ).toBeTruthy();
    // The spelling variant has no provider account, so no account text.
    expect(
      screen.getByText("Summit Dental Care · 2 cases"),
    ).toBeTruthy();
    expect(screen.queryByText(/account #null/)).toBeNull();
  });

  it("keeps every account readable when practice names are long", async () => {
    const LONG = {
      ...CLUSTER,
      doctors: [
        {
          ...CLUSTER.doctors[0],
          practiceName:
            "Mahan Village Family Dentistry & Implant Center of Tallahassee",
        },
        {
          ...CLUSTER.doctors[1],
          practiceName:
            "Mahan Village Family Dentistry and Implant Center — North Office",
          accountCount: 1,
          platformAccountNumber: "0925AB",
        },
      ],
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    await render(
      <QueryClientProvider client={queryClient}>
        <DoctorMergeSheet cluster={LONG} onClose={() => {}} />
      </QueryClientProvider>,
    );

    // Both numbers render on their own lines, so neither shares the
    // numberOfLines={1} summary that the long practice names fill up.
    const kept = screen.getByText("Keeps account #1526BK");
    const other = screen.getByText("Has account #0925AB");
    expect(kept.props.numberOfLines).toBeUndefined();
    expect(other.props.numberOfLines).toBeUndefined();
  });

  it("names the kept doctor's account in the preview", async () => {
    await renderSheet();

    expect(
      screen.getByText(
        /Dr\. Kanesha Cole keeps account #1526BK — no new doctor account or account number is created\./,
      ),
    ).toBeTruthy();
  });

  it("follows the selection when a different doctor is kept", async () => {
    await renderSheet();

    await fireEvent.press(screen.getByText("Kanesha Cole"));

    // The account did not move: it is still shown, just no longer as "Keeps".
    expect(screen.getByText("Has account #1526BK")).toBeTruthy();
    expect(screen.queryByText("Keeps account #1526BK")).toBeNull();
    // The newly kept doctor has no account, so the preview falls back to the
    // plain "nothing is created" wording rather than naming someone else's.
    expect(
      screen.getByText(/ No new doctor account or account number is created\./),
    ).toBeTruthy();
  });
});
