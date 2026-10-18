/** @vitest-environment jsdom */
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CaseDoctorReassignDialog } from "@/components/CaseDoctorReassignDialog";
// This is the actual notification host mounted by App, not a toast-call spy.
import { Toaster } from "@/components/ui/toaster";

const mocks = vi.hoisted(() => ({ save: vi.fn(), undo: vi.fn() }));
const assignment = {
  caseId: "visible-undo-case", recordType: "canonical", caseNumber: "CASE-UNDO",
  labOrganizationId: "lab", providerOrganizationId: "practice", practiceName: "Practice",
  doctorName: "Original Doctor", revision: "before", updatedAt: null,
};
vi.mock("@workspace/api-client-react", async (original) => {
  const actual = await original<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetCaseDoctorCandidates: () => ({
      data: { ok: true, data: { assignment, entries: [{ key: "user:zero", doctorName: "Zero Cases Doctor", userId: "zero", platformAccountNumber: null }], total: 1, nextOffset: null } },
      isFetching: false, isError: false,
    }),
    useReassignCaseDoctor: () => ({ mutateAsync: mocks.save }),
    undoCaseDoctorReassignment: mocks.undo,
    refreshCaseDoctorQueries: vi.fn(async () => true),
  };
});
afterEach(() => cleanup());

it("renders a real success notice and clickable case-only Undo after the dialog unmounts", async () => {
  mocks.save.mockResolvedValue({ ok: true, data: {
    assignment: { ...assignment, doctorName: "Zero Cases Doctor", revision: "after" },
    previousDoctorName: assignment.doctorName, auditLogId: "case-audit",
    undoExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  } });
  mocks.undo.mockResolvedValue({ ok: true, data: {
    assignment, previousDoctorName: "Zero Cases Doctor", auditLogId: "undo-audit", undoExpiresAt: null,
  } });
  function Surface() {
    const [open, setOpen] = useState(true);
    return <>
      {open && <CaseDoctorReassignDialog caseId={assignment.caseId} caseNumber={assignment.caseNumber}
        currentDoctorName={assignment.doctorName} currentPracticeId={assignment.providerOrganizationId}
        onClose={() => setOpen(false)} />}
      <Toaster />
    </>;
  }
  render(<QueryClientProvider client={new QueryClient()}><Surface /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("radio", { name: /Zero Cases Doctor/ }));
  fireEvent.click(screen.getByRole("button", { name: "Change doctor for this case only" }));
  expect(await screen.findByText("Doctor changed for this case only")).toBeVisible();
  expect(screen.getByText("Case CASE-UNDO: Original Doctor → Zero Cases Doctor. This case only.")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() => expect(mocks.undo).toHaveBeenCalledExactlyOnceWith(assignment.caseId, "case-audit"));
  expect(await screen.findByText("Reassignment undone")).toBeVisible();
  expect(screen.getByText("Case CASE-UNDO: doctor restored to Original Doctor.")).toBeVisible();
});
