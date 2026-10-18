import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("AiKnowledgeScreen — product branding", () => {
  it("uses LabTrax Assistant terminology throughout explanatory copy", async () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "..", "app", "manage", "ai-knowledge.tsx"),
      "utf8",
    );
    expect(source).toContain("LabTrax Assistant");
    expect(source).not.toContain("Maynard");
  });
});

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
  it("shows entries to a non-admin lab member but renders no add/edit/delete controls", async () => {
    setMockAppState({
      meMemberships: labMembership("user"),
      aiMemory: [GLOSSARY_ENTRY],
    });

    const { getByText, queryByTestId } = await render(<AiKnowledgeScreen />);

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
    await fireEvent.press(queryByTestId("entry-ai-1") as never);
    expect(queryByTestId("form-save")).toBeNull();
  });
});

describe("AiKnowledgeScreen — admin edit flows", () => {
  it("lets an admin open the new-entry editor and create a glossary term", async () => {
    setMockAppState({ meMemberships: labMembership("admin"), aiMemory: [] });

    const { getByTestId, getByText, getByPlaceholderText } = await render(
      <AiKnowledgeScreen />,
    );

    await fireEvent.press(getByTestId("add-glossary"));

    await waitFor(() => expect(getByText("New glossary entry")).toBeTruthy());

    await fireEvent.changeText(getByPlaceholderText("Term"), "PFM");
    await fireEvent.changeText(
      getByPlaceholderText("Definition"),
      "Porcelain fused to metal",
    );
    await fireEvent.press(getByTestId("form-save"));

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

    const { getByTestId, getByText, getByDisplayValue } = await render(
      <AiKnowledgeScreen />,
    );

    await fireEvent.press(getByTestId("entry-ai-1"));

    await waitFor(() => expect(getByText("Edit glossary entry")).toBeTruthy());

    await fireEvent.changeText(
      getByDisplayValue("Porcelain fused to zirconia"),
      "Porcelain fused to zirconia (updated)",
    );
    await fireEvent.press(getByTestId("form-save"));

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

    const { getByTestId, getByText } = await render(<AiKnowledgeScreen />);

    await fireEvent.press(getByTestId("entry-ai-1"));
    await waitFor(() => expect(getByText("Edit glossary entry")).toBeTruthy());

    await fireEvent.press(getByTestId("form-delete"));

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
  it("hides the suggestions surface from non-admin lab members", async () => {
    setMockAppState({
      meMemberships: labMembership("user"),
      aiMemory: [],
      aiCandidates: [GLOSSARY_CANDIDATE],
    });

    const { queryByTestId } = await render(<AiKnowledgeScreen />);

    expect(queryByTestId("ai-candidates")).toBeNull();
    expect(queryByTestId("candidate-cand-1")).toBeNull();
  });

  it("lets an admin approve a suggestion", async () => {
    setMockAppState({
      meMemberships: labMembership("admin"),
      aiMemory: [],
      aiCandidates: [GLOSSARY_CANDIDATE],
    });

    const { getByText, getByTestId } = await render(<AiKnowledgeScreen />);

    expect(getByText("Suggested by AI")).toBeTruthy();
    expect(getByText("Zr")).toBeTruthy();

    await fireEvent.press(getByTestId("candidate-approve-cand-1"));

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

    const { getByTestId } = await render(<AiKnowledgeScreen />);

    await fireEvent.press(getByTestId("candidate-dismiss-cand-1"));

    await waitFor(() => {
      expect(mockRejectAiMemoryCandidateMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(mockRejectAiMemoryCandidateMutateAsync).toHaveBeenCalledWith({
      id: "cand-1",
    });
  });

  it("opens an editor pre-filled with the candidate and approves only the changed override", async () => {
    setMockAppState({
      meMemberships: labMembership("admin"),
      aiMemory: [],
      aiCandidates: [GLOSSARY_CANDIDATE],
    });

    const { getByTestId, getByText, getByDisplayValue } = await render(
      <AiKnowledgeScreen />,
    );

    await fireEvent.press(getByTestId("candidate-edit-cand-1"));

    await waitFor(() =>
      expect(getByText("Review glossary suggestion")).toBeTruthy(),
    );

    // Pre-filled with the candidate's key/value.
    expect(getByDisplayValue("Zr")).toBeTruthy();
    expect(getByDisplayValue("Zirconia")).toBeTruthy();

    // Reword the definition, leave the term untouched.
    await fireEvent.changeText(getByDisplayValue("Zirconia"), "Zirconium dioxide");
    await fireEvent.press(getByTestId("form-save"));

    await waitFor(() => {
      expect(mockApproveAiMemoryCandidateMutateAsync).toHaveBeenCalledTimes(1);
    });
    // Only the edited field is sent as an override.
    expect(mockApproveAiMemoryCandidateMutateAsync).toHaveBeenCalledWith({
      id: "cand-1",
      data: { value: "Zirconium dioxide" },
    });
  });

  it("approves with no overrides when the candidate is unedited", async () => {
    setMockAppState({
      meMemberships: labMembership("admin"),
      aiMemory: [],
      aiCandidates: [GLOSSARY_CANDIDATE],
    });

    const { getByTestId, getByText } = await render(<AiKnowledgeScreen />);

    await fireEvent.press(getByTestId("candidate-edit-cand-1"));
    await waitFor(() =>
      expect(getByText("Review glossary suggestion")).toBeTruthy(),
    );

    await fireEvent.press(getByTestId("form-save"));

    await waitFor(() => {
      expect(mockApproveAiMemoryCandidateMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(mockApproveAiMemoryCandidateMutateAsync).toHaveBeenCalledWith({
      id: "cand-1",
      data: {},
    });
  });

  it("lets an admin dismiss from the editor", async () => {
    setMockAppState({
      meMemberships: labMembership("admin"),
      aiMemory: [],
      aiCandidates: [GLOSSARY_CANDIDATE],
    });

    const { getByTestId, getByText } = await render(<AiKnowledgeScreen />);

    await fireEvent.press(getByTestId("candidate-edit-cand-1"));
    await waitFor(() =>
      expect(getByText("Review glossary suggestion")).toBeTruthy(),
    );

    await fireEvent.press(getByTestId("form-delete"));

    // Dismiss is gated behind a confirm dialog.
    expect(Alert.alert).toHaveBeenCalledTimes(1);
    const buttons = vi.mocked(Alert.alert).mock.calls[0][2] as
      | Array<{ text?: string; style?: string; onPress?: () => void }>
      | undefined;
    const dismissBtn = buttons?.find((b) => b.style === "destructive");
    expect(dismissBtn).toBeTruthy();
    dismissBtn?.onPress?.();

    await waitFor(() => {
      expect(mockRejectAiMemoryCandidateMutateAsync).toHaveBeenCalledWith({
        id: "cand-1",
      });
    });
  });
});

describe("AiKnowledgeScreen — provider-only user", () => {
  it("shows the 'No lab available' empty state when the user has no lab membership", async () => {
    setMockAppState({
      meMemberships: PROVIDER_MEMBERSHIP,
      aiMemory: [GLOSSARY_ENTRY],
    });

    const { getByText, queryByTestId } = await render(<AiKnowledgeScreen />);

    expect(getByText("No lab available")).toBeTruthy();
    // No sections, no add controls, and entries are never loaded for a
    // provider-only user.
    expect(queryByTestId("add-glossary")).toBeNull();
    expect(queryByTestId("entry-ai-1")).toBeNull();
  });
});
