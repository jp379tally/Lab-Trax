import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";
import {
  resetMockAppState,
  setMockAppState,
  mockCreateAiMemoryMutateAsync,
  mockUpdateAiMemoryMutateAsync,
  mockDeleteAiMemoryMutateAsync,
  mockApproveAiMemoryCandidateMutateAsync,
  mockRejectAiMemoryCandidateMutateAsync,
} from "../../../vitest.setup";

import AiKnowledgeScreen from "@/app/manage/ai-knowledge";

// The screen reads the signed-in user's memberships via `useMe()` (a
// `useQuery({ queryKey: ["auth-me"] })` consumer), which the global vitest
// mock drives from `mockAppOverrides.current.meMemberships`. Edit gating is
// admin-only (owner/admin of the primary lab); reads are available to any
// active lab member. Entries come from `useGetAiMemory`, driven by
// `mockAppOverrides.current.aiMemory`.

const LAB_ORG = { id: "lab-1", type: "lab", name: "Acme Dental Lab" };

function labMembership(role: string) {
  return [
    {
      id: "mem-1",
      role,
      status: "active",
      organizationId: "lab-1",
      organization: LAB_ORG,
    },
  ];
}

const PROVIDER_MEMBERSHIP = [
  {
    id: "mem-prov",
    role: "owner",
    status: "active",
    organizationId: "prov-1",
    organization: { id: "prov-1", type: "provider", name: "Downtown Dental" },
  },
];

const GLOSSARY_ENTRY = {
  id: "ai-1",
  labOrganizationId: "lab-1",
  kind: "glossary" as const,
  key: "PFZ",
  value: "Porcelain fused to zirconia",
  source: "manual" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  resetMockAppState();
  vi.clearAllMocks();
});

describe("AiKnowledgeScreen — read access for all active lab members", () => {
  it("shows entries to a non-admin lab member but renders no add/edit/delete controls", () => {
    setMockAppState({
      meMemberships: labMembership("user"),
      aiMemory: [GLOSSARY_ENTRY],
    });

    const { getByText, queryByTestId } = render(<AiKnowledgeScreen />);

    // The entry is visible (reads are allowed for any active member)…
    expect(getByText("PFZ")).toBeTruthy();
    expect(getByText("Porcelain fused to zirconia")).toBeTruthy();

    // …but no edit affordances: no per-kind add buttons, and the row is not
    // pressable into the editor.
    expect(queryByTestId("add-glossary")).toBeNull();
    expect(queryByTestId("add-preference")).toBeNull();
    expect(queryByTestId("add-fact")).toBeNull();

    // Pressing the entry card does nothing for a non-admin (no onPress wired),
    // so the editor never opens.
    fireEvent.press(queryByTestId("entry-ai-1") as never);
    expect(queryByTestId("form-save")).toBeNull();
  });
});

describe("AiKnowledgeScreen — admin edit flows", () => {
  it("lets an admin open the new-entry editor and create a glossary term", async () => {
    setMockAppState({ meMemberships: labMembership("admin"), aiMemory: [] });

    const { getByTestId, getByText, getByPlaceholderText } = render(
      <AiKnowledgeScreen />,
    );

    fireEvent.press(getByTestId("add-glossary"));

    await waitFor(() => expect(getByText("New glossary entry")).toBeTruthy());

    fireEvent.changeText(getByPlaceholderText("Term"), "PFM");
    fireEvent.changeText(
      getByPlaceholderText("Definition"),
      "Porcelain fused to metal",
    );
    fireEvent.press(getByTestId("form-save"));

    await waitFor(() => {
      expect(mockCreateAiMemoryMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(mockCreateAiMemoryMutateAsync).toHaveBeenCalledWith({
      data: {
        labOrganizationId: "lab-1",
        kind: "glossary",
        key: "PFM",
        value: "Porcelain fused to metal",
      },
    });
  });

  it("lets an admin open an existing entry and save an update", async () => {
    setMockAppState({
      meMemberships: labMembership("owner"),
      aiMemory: [GLOSSARY_ENTRY],
    });

    const { getByTestId, getByText, getByDisplayValue } = render(
      <AiKnowledgeScreen />,
    );

    fireEvent.press(getByTestId("entry-ai-1"));

    await waitFor(() => expect(getByText("Edit glossary entry")).toBeTruthy());

    fireEvent.changeText(
      getByDisplayValue("Porcelain fused to zirconia"),
      "Porcelain fused to zirconia (updated)",
    );
    fireEvent.press(getByTestId("form-save"));

    await waitFor(() => {
      expect(mockUpdateAiMemoryMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(mockUpdateAiMemoryMutateAsync).toHaveBeenCalledWith({
      id: "ai-1",
      data: { key: "PFZ", value: "Porcelain fused to zirconia (updated)" },
    });
  });

  it("lets an admin confirm a delete from the editor", async () => {
    setMockAppState({
      meMemberships: labMembership("admin"),
      aiMemory: [GLOSSARY_ENTRY],
    });

    const { getByTestId, getByText } = render(<AiKnowledgeScreen />);

    fireEvent.press(getByTestId("entry-ai-1"));
    await waitFor(() => expect(getByText("Edit glossary entry")).toBeTruthy());

    fireEvent.press(getByTestId("form-delete"));

    // Deletion is gated behind a confirm dialog; pull the destructive button
    // out of the Alert call and invoke it.
    expect(Alert.alert).toHaveBeenCalledTimes(1);
    const buttons = vi.mocked(Alert.alert).mock.calls[0][2] as
      | Array<{ text?: string; style?: string; onPress?: () => void }>
      | undefined;
    const deleteBtn = buttons?.find((b) => b.style === "destructive");
    expect(deleteBtn).toBeTruthy();
    deleteBtn?.onPress?.();

    await waitFor(() => {
      expect(mockDeleteAiMemoryMutateAsync).toHaveBeenCalledWith({ id: "ai-1" });
    });
  });
});

const GLOSSARY_CANDIDATE = {
  id: "cand-1",
  labOrganizationId: "lab-1",
  kind: "glossary" as const,
  key: "Zr",
  value: "Zirconia",
  status: "pending" as const,
  sourceUserId: null,
  reviewedByUserId: null,
  reviewedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("AiKnowledgeScreen — AI suggestion review (admin only)", () => {
  it("hides the suggestions surface from non-admin lab members", () => {
    setMockAppState({
      meMemberships: labMembership("user"),
      aiMemory: [],
      aiCandidates: [GLOSSARY_CANDIDATE],
    });

    const { queryByTestId } = render(<AiKnowledgeScreen />);

    expect(queryByTestId("ai-candidates")).toBeNull();
    expect(queryByTestId("candidate-cand-1")).toBeNull();
  });

  it("lets an admin approve a suggestion", async () => {
    setMockAppState({
      meMemberships: labMembership("admin"),
      aiMemory: [],
      aiCandidates: [GLOSSARY_CANDIDATE],
    });

    const { getByText, getByTestId } = render(<AiKnowledgeScreen />);

    expect(getByText("Suggested by AI")).toBeTruthy();
    expect(getByText("Zr")).toBeTruthy();

    fireEvent.press(getByTestId("candidate-approve-cand-1"));

    await waitFor(() => {
      expect(mockApproveAiMemoryCandidateMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(mockApproveAiMemoryCandidateMutateAsync).toHaveBeenCalledWith({
      id: "cand-1",
      data: {},
    });
  });

  it("lets an admin dismiss a suggestion", async () => {
    setMockAppState({
      meMemberships: labMembership("owner"),
      aiMemory: [],
      aiCandidates: [GLOSSARY_CANDIDATE],
    });

    const { getByTestId } = render(<AiKnowledgeScreen />);

    fireEvent.press(getByTestId("candidate-dismiss-cand-1"));

    await waitFor(() => {
      expect(mockRejectAiMemoryCandidateMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(mockRejectAiMemoryCandidateMutateAsync).toHaveBeenCalledWith({
      id: "cand-1",
    });
  });
});

describe("AiKnowledgeScreen — provider-only user", () => {
  it("shows the 'No lab available' empty state when the user has no lab membership", () => {
    setMockAppState({
      meMemberships: PROVIDER_MEMBERSHIP,
      aiMemory: [GLOSSARY_ENTRY],
    });

    const { getByText, queryByTestId } = render(<AiKnowledgeScreen />);

    expect(getByText("No lab available")).toBeTruthy();
    // No sections, no add controls, and entries are never loaded for a
    // provider-only user.
    expect(queryByTestId("add-glossary")).toBeNull();
    expect(queryByTestId("entry-ai-1")).toBeNull();
  });
});
