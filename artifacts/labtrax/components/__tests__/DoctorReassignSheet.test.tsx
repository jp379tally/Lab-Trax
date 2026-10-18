import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Alert, Platform } from "react-native";
import { DoctorReassignSheet } from "../DoctorReassignSheet";
import {
  resetMockAppState, setMockAppState, mockGetCaseDoctorCandidates,
  mockReassignCaseDoctorMutateAsync, mockUndoCaseDoctorReassignment,
  mockInvalidateQueries, mockSearchDoctors, mockMergeDoctorsMutate,
} from "../../vitest.setup";
import type { CaseDoctorAssignment, CaseDoctorCandidate } from "@workspace/api-client-react";

const assignment: CaseDoctorAssignment = {
  caseId: "case-mobile", recordType: "canonical", caseNumber: "26-mobile",
  labOrganizationId: "case-lab", providerOrganizationId: "saved-practice", practiceName: "Saved Practice",
  doctorName: "Original Doctor", revision: "saved-revision", updatedAt: null,
};
const target: CaseDoctorCandidate = {
  key: "user:zero-cases", doctorName: "Zero Cases Doctor", userId: "zero-cases", platformAccountNumber: null,
};
const response = () => ({
  ok: true, data: {
    assignment: { ...assignment, doctorName: target.doctorName, revision: "changed-revision" },
    previousDoctorName: assignment.doctorName, auditLogId: "case-only-audit",
    undoExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  },
});
const props = {
  visible: true, caseId: assignment.caseId, caseNumber: assignment.caseNumber,
  currentDoctorName: assignment.doctorName, currentPracticeId: assignment.providerOrganizationId,
};
async function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
  const onClose = vi.fn();
  const app = (overrides: Partial<typeof props> = {}) => (
    <QueryClientProvider client={qc}><DoctorReassignSheet {...props} {...overrides} onClose={onClose} /></QueryClientProvider>
  );
  const screen = await render(app());
  return { ...screen, qc, onClose, app };
}
beforeEach(() => {
  vi.clearAllMocks();
  resetMockAppState();
  setMockAppState({ liveDoctorSearchQueries: true });
  mockGetCaseDoctorCandidates.mockImplementation(async () => ({
    ok: true, data: { assignment, entries: [target], total: 1, nextOffset: null },
  }));
  mockReassignCaseDoctorMutateAsync.mockResolvedValue(response());
  mockUndoCaseDoctorReassignment.mockResolvedValue({
    ok: true, data: { ...response().data, assignment, undoExpiresAt: null },
  });
  mockInvalidateQueries.mockResolvedValue(undefined);
  vi.spyOn(Alert, "alert").mockImplementation(() => {});
});
afterEach(async () => { await cleanup(); resetMockAppState(); vi.restoreAllMocks(); });

describe("case-only mobile reassignment", () => {
  it("confirms the case and old/new names, submits its exact saved identity, and uses only case Undo", async () => {
    const screen = await setup();
    await fireEvent.press(await screen.findByTestId("doctor-reassign-option"));
    expect(screen.getByText("Change doctor for this case only.")).toBeTruthy();
    expect(screen.getByText("Case 26-mobile: Original Doctor → Zero Cases Doctor.")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("doctor-reassign-save"));
    await waitFor(() => expect(screen.onClose).toHaveBeenCalledOnce());
    expect(mockReassignCaseDoctorMutateAsync).toHaveBeenCalledExactlyOnceWith({
      caseId: assignment.caseId,
      data: { recordType: "canonical", expectedDoctorName: assignment.doctorName,
        expectedPracticeId: assignment.providerOrganizationId, expectedRevision: assignment.revision, candidateKey: target.key },
    });
    await waitFor(() => expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["cases", assignment.caseId] }, { throwOnError: true }));
    const success = vi.mocked(Alert.alert).mock.calls.find(([title]) => title === "Doctor changed for this case only");
    expect(success?.[1]).toContain("Original Doctor → Zero Cases Doctor");
    const undo = success?.[2]?.find((button) => button.text === "Undo");
    expect(undo).toBeTruthy();
    await screen.rerender(screen.app({ caseId: "different-open-case", visible: false }));
    undo?.onPress?.();
    undo?.onPress?.();
    await waitFor(() => expect(mockUndoCaseDoctorReassignment).toHaveBeenCalledExactlyOnceWith(assignment.caseId, "case-only-audit"));
    expect(mockSearchDoctors).not.toHaveBeenCalled();
    expect(mockMergeDoctorsMutate).not.toHaveBeenCalled();
  });

  it("pages beyond 100 doctors and searches the complete practice roster, including name-only entries", async () => {
    const all = Array.from({ length: 126 }, (_, i) => ({
      key: `name:${i}`, doctorName: `Roster ${String(i).padStart(3, "0")}`, userId: null, platformAccountNumber: null,
    }));
    mockGetCaseDoctorCandidates.mockImplementation(async (_caseId, raw) => {
      const { q, offset, limit } = raw as { q?: string; offset: number; limit: number };
      const matches = q ? all.filter((entry) => entry.doctorName.includes(q)) : all;
      return { ok: true, data: {
        assignment, entries: matches.slice(offset, offset + limit), total: matches.length,
        nextOffset: offset + limit < matches.length ? offset + limit : null,
      } };
    });
    const screen = await setup();
    await screen.findByText("Roster 000");
    await fireEvent.press(screen.getByLabelText("Next doctors"));
    await screen.findByText("Roster 050");
    await fireEvent.press(screen.getByLabelText("Next doctors"));
    await screen.findByText("Roster 125");
    await fireEvent.changeText(screen.getByPlaceholderText("Type a doctor name…"), "Roster 125");
    await waitFor(() => expect(screen.getAllByTestId("doctor-reassign-option")).toHaveLength(1));
    expect(mockGetCaseDoctorCandidates).toHaveBeenLastCalledWith(assignment.caseId, { q: "Roster 125", offset: 0, limit: 50 });
    await fireEvent.press(screen.getByText("Roster 125"));
    await fireEvent.press(screen.getByTestId("doctor-reassign-save"));
    expect(mockReassignCaseDoctorMutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      caseId: assignment.caseId, data: expect.objectContaining({ candidateKey: "name:125" }),
    }));
  });

  it("offers Retry for search failures, not an empty roster or an account-creation shortcut", async () => {
    mockGetCaseDoctorCandidates.mockRejectedValueOnce(new Error("Roster temporarily unavailable"));
    const screen = await setup();
    expect(await screen.findByText("Roster temporarily unavailable")).toBeTruthy();
    expect(screen.queryByText(/No other eligible doctors/)).toBeNull();
    await fireEvent.press(screen.getByTestId("doctor-reassign-retry"));
    await screen.findByText(target.doctorName);
    expect(screen.getByText(/their association must be managed separately/)).toBeTruthy();
  });

  it("keeps a refused write retryable without changing the confirmed doctor or refreshing caches", async () => {
    mockReassignCaseDoctorMutateAsync.mockRejectedValueOnce(new Error("That doctor was removed from this practice."));
    const screen = await setup();
    screen.qc.setQueryData(["cases", assignment.caseId], { id: assignment.caseId, doctorName: assignment.doctorName, rxNotes: "Keep" });
    await fireEvent.press(await screen.findByTestId("doctor-reassign-option"));
    await fireEvent.press(screen.getByTestId("doctor-reassign-save"));
    expect(await screen.findByText("That doctor was removed from this practice.")).toBeTruthy();
    expect(screen.getByTestId("doctor-reassign-save").props.disabled).toBe(false);
    expect(screen.onClose).not.toHaveBeenCalled();
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
    expect(screen.qc.getQueryData(["cases", assignment.caseId])).toEqual({ id: assignment.caseId, doctorName: assignment.doctorName, rxNotes: "Keep" });
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it("blocks duplicate submissions and closing during save, and treats refresh failures as already saved", async () => {
    let resolve!: (value: unknown) => void;
    mockReassignCaseDoctorMutateAsync.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    mockInvalidateQueries.mockRejectedValue(new Error("Refresh is offline"));
    const screen = await setup();
    await fireEvent.press(await screen.findByTestId("doctor-reassign-option"));
    await fireEvent.press(screen.getByTestId("doctor-reassign-save"));
    await fireEvent.press(screen.getByTestId("doctor-reassign-save"));
    await fireEvent.press(screen.getByTestId("doctor-reassign-cancel"));
    expect(screen.onClose).not.toHaveBeenCalled();
    expect(mockReassignCaseDoctorMutateAsync).toHaveBeenCalledOnce();
    resolve(response());
    await waitFor(() => expect(screen.onClose).toHaveBeenCalledOnce());
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith(
      "Doctor change saved", expect.stringContaining("Do not submit"),
      expect.arrayContaining([expect.objectContaining({ text: "Undo" })]),
    ));
    expect(screen.getByTestId("doctor-reassign-save").props.disabled).toBe(true);
  });

  it("cancels without a write and resets drafts on case/practice change or reopen", async () => {
    const screen = await setup();
    await fireEvent.press(await screen.findByTestId("doctor-reassign-option"));
    await fireEvent.press(screen.getByTestId("doctor-reassign-cancel"));
    expect(screen.onClose).toHaveBeenCalledOnce();
    expect(mockReassignCaseDoctorMutateAsync).not.toHaveBeenCalled();
    await screen.rerender(screen.app({ visible: false }));
    await screen.rerender(screen.app());
    expect(screen.getByTestId("doctor-reassign-save").props.disabled).toBe(true);
    await fireEvent.changeText(screen.getByPlaceholderText("Type a doctor name…"), "Different");
    await screen.rerender(screen.app({ caseId: "another-case", currentPracticeId: "another-practice" }));
    expect(screen.getByPlaceholderText("Type a doctor name…").props.value).toBe("");
    expect(screen.getByTestId("doctor-reassign-save").props.disabled).toBe(true);
    expect(await screen.findByText(/saved doctor or practice changed/)).toBeTruthy();
  });

  it("shows a useful refused Undo error without retrying the original write", async () => {
    mockUndoCaseDoctorReassignment.mockRejectedValueOnce(new Error("This case changed after reassignment."));
    const screen = await setup();
    await fireEvent.press(await screen.findByTestId("doctor-reassign-option"));
    await fireEvent.press(screen.getByTestId("doctor-reassign-save"));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    const success = vi.mocked(Alert.alert).mock.calls.find(([title]) => title === "Doctor changed for this case only");
    success?.[2]?.find((button) => button.text === "Undo")?.onPress?.();
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith("Couldn't undo", "This case changed after reassignment."));
    expect(mockReassignCaseDoctorMutateAsync).toHaveBeenCalledOnce();
  });

  it("renders an actual web Undo sheet after closing the picker, even if refreshing failed", async () => {
    const platform = Platform.OS;
    Object.defineProperty(Platform, "OS", { value: "web", configurable: true });
    try {
      mockInvalidateQueries.mockRejectedValue(new Error("Refresh offline"));
      const screen = await setup();
      await fireEvent.press(await screen.findByTestId("doctor-reassign-option"));
      await fireEvent.press(screen.getByTestId("doctor-reassign-save"));
      await waitFor(() => expect(screen.onClose).toHaveBeenCalledOnce());
      // Mirrors the parent closing the picker and receiving the saved doctor.
      await screen.rerender(screen.app({ visible: false, currentDoctorName: target.doctorName }));
      expect(await screen.findByText("Doctor changed for this case only")).toBeTruthy();
      expect(screen.getByText(/Doctor change saved.*Reload the case/)).toBeTruthy();
      expect(screen.getByText("Done")).toBeTruthy();
      expect(Alert.alert).not.toHaveBeenCalled();
      mockInvalidateQueries.mockResolvedValue(undefined);
      await fireEvent.press(screen.getByTestId("doctor-reassign-notice-save"));
      await waitFor(() => expect(mockUndoCaseDoctorReassignment).toHaveBeenCalledExactlyOnceWith(assignment.caseId, "case-only-audit"));
      expect(await screen.findByText("Reassignment undone")).toBeTruthy();
      expect(screen.getByText("Case 26-mobile: doctor restored to Original Doctor.")).toBeTruthy();
      expect(screen.getByTestId("doctor-reassign-notice-save").props.disabled).toBe(true);
      await fireEvent.press(screen.getByTestId("doctor-reassign-notice-cancel"));
      expect(screen.queryByText("Reassignment undone")).toBeNull();
    } finally {
      Object.defineProperty(Platform, "OS", { value: platform, configurable: true });
    }
  });

  it("retains the web notice on unauthorized/conflicting Undo and binds it to the original audited case", async () => {
    const platform = Platform.OS;
    Object.defineProperty(Platform, "OS", { value: "web", configurable: true });
    try {
      const screen = await setup();
      await fireEvent.press(await screen.findByTestId("doctor-reassign-option"));
      await fireEvent.press(screen.getByTestId("doctor-reassign-save"));
      await screen.findByText("Doctor changed for this case only");
      await screen.rerender(screen.app({ visible: false, caseId: "another-case" }));
      mockUndoCaseDoctorReassignment.mockRejectedValueOnce(new Error("This case changed; Undo was refused."));
      await fireEvent.press(screen.getByTestId("doctor-reassign-notice-save"));
      expect(await screen.findByText("This case changed; Undo was refused.")).toBeTruthy();
      expect(mockUndoCaseDoctorReassignment).toHaveBeenCalledExactlyOnceWith(assignment.caseId, "case-only-audit");
      expect(screen.queryByText("Reassignment undone")).toBeNull();
    } finally {
      Object.defineProperty(Platform, "OS", { value: platform, configurable: true });
    }
  });
});
