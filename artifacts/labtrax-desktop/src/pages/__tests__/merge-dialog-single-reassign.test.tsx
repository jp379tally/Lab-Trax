/** @vitest-environment jsdom */
// Regression replacement: case reassignment must NEVER use MergeDialog.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CaseDoctorReassignDialog } from "@/components/CaseDoctorReassignDialog";
import type { CaseDoctorAssignment, CaseDoctorCandidate } from "@workspace/api-client-react";
import { toast as notify } from "@/hooks/use-toast";

const mocks = vi.hoisted(() => ({
  candidates: vi.fn(), save: vi.fn(), undo: vi.fn(),
  previewMerge: vi.fn(), merge: vi.fn(), undoMerge: vi.fn(), updateNotice: vi.fn(),
}));
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn(() => ({ id: "case-notice", update: mocks.updateNotice })) }));
vi.mock("@workspace/api-client-react", async (original) => {
  const actual = await original<typeof import("@workspace/api-client-react")>();
  const { useQuery, useMutation } = await import("@tanstack/react-query");
  return {
    ...actual,
    useGetCaseDoctorCandidates: (caseId: string, params: unknown) => useQuery({
      queryKey: actual.getGetCaseDoctorCandidatesQueryKey(caseId, params as any),
      queryFn: () => mocks.candidates(caseId, params), retry: false,
    }),
    useReassignCaseDoctor: () => useMutation({ mutationFn: mocks.save, retry: false }),
    undoCaseDoctorReassignment: mocks.undo,
    usePreviewDoctorMerge: mocks.previewMerge, useMergeDoctors: mocks.merge, undoDoctorMerge: mocks.undoMerge,
  };
});

const assignment: CaseDoctorAssignment = {
  caseId: "case-exact", recordType: "canonical", caseNumber: "26-5177",
  doctorName: "Wrong Doctor", providerOrganizationId: "practice-a", practiceName: "Practice A",
  labOrganizationId: "lab-a", revision: "persisted-revision", updatedAt: "2026-01-01T00:00:00Z",
};
const candidate: CaseDoctorCandidate = {
  key: "user:zero-case-doctor", doctorName: "Zero Case Doctor", userId: "zero-case-doctor", platformAccountNumber: null,
};
function result(doctorName = candidate.doctorName) {
  return { ok: true, data: {
    assignment: { ...assignment, doctorName, revision: "next-revision" },
    previousDoctorName: assignment.doctorName, auditLogId: "case-assignment-audit",
    undoExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  } };
}
const props = {
  caseId: assignment.caseId, caseNumber: assignment.caseNumber,
  currentDoctorName: assignment.doctorName, currentPracticeId: assignment.providerOrganizationId,
};
function setup(overrides: Partial<typeof props> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 }, mutations: { retry: false } } });
  const onClose = vi.fn();
  const renderDialog = (changes: Partial<typeof props> = {}) => (
    <QueryClientProvider client={qc}><CaseDoctorReassignDialog {...props} {...overrides} {...changes} onClose={onClose} /></QueryClientProvider>
  );
  const view = render(renderDialog());
  return { ...view, qc, onClose, renderDialog };
}
async function select() {
  fireEvent.click(await screen.findByRole("radio", { name: /Zero Case Doctor/ }));
}
function saveButton() { return screen.getByRole("button", { name: "Change doctor for this case only" }); }

beforeEach(() => {
  vi.clearAllMocks();
  mocks.candidates.mockImplementation(async (caseId: string) => ({
    ok: true, data: { assignment: { ...assignment, caseId }, entries: [candidate], total: 1, nextOffset: null },
  }));
  mocks.save.mockResolvedValue(result());
  mocks.undo.mockResolvedValue(result(assignment.doctorName));
});

describe("case-only reassignment dialog", () => {
  it("names the case and old/new doctor, uses the exact persisted identity, and never previews/merges doctors", async () => {
    const { onClose, qc } = setup();
    qc.setQueryData(["case", assignment.caseId], { id: assignment.caseId, doctorName: assignment.doctorName, shade: "A2" });
    await select();
    expect(screen.getByText(`Case ${assignment.caseNumber}: Wrong Doctor → Zero Case Doctor.`)).toBeInTheDocument();
    expect(screen.getByText("Change doctor for this case only.")).toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(mocks.save).toHaveBeenCalledWith({
      caseId: assignment.caseId,
      data: {
        recordType: "canonical", expectedDoctorName: assignment.doctorName, expectedPracticeId: "practice-a",
        expectedRevision: "persisted-revision", candidateKey: candidate.key,
      },
    }, expect.anything());
    await waitFor(() => expect(qc.getQueryData(["case", assignment.caseId])).toMatchObject({ doctorName: candidate.doctorName, shade: "A2" }));
    expect(mocks.previewMerge).not.toHaveBeenCalled();
    expect(mocks.merge).not.toHaveBeenCalled();
    expect(mocks.undoMerge).not.toHaveBeenCalled();
  });

  it("reaches candidates after the first 100 and searches the entire server-scoped roster", async () => {
    const entries = Array.from({ length: 123 }, (_, i) => ({
      ...candidate, key: `user:doctor-${i}`, userId: `doctor-${i}`, doctorName: `Doctor ${String(i).padStart(3, "0")}`,
    }));
    mocks.candidates.mockImplementation(async (_caseId, { q, offset, limit }) => {
      const matches = q ? entries.filter((entry) => entry.doctorName.includes(q)) : entries;
      return { ok: true, data: { assignment, entries: matches.slice(offset, offset + limit), total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null } };
    });
    setup();
    await screen.findByRole("radio", { name: /Doctor 000/ });
    fireEvent.click(screen.getByRole("button", { name: "Next doctors" }));
    await screen.findByRole("radio", { name: /Doctor 050/ });
    fireEvent.click(screen.getByRole("button", { name: "Next doctors" }));
    await screen.findByRole("radio", { name: /Doctor 122/ });
    fireEvent.change(screen.getByPlaceholderText("Type a doctor name…"), { target: { value: "Doctor 122" } });
    await waitFor(() => expect(screen.getAllByRole("radio")).toHaveLength(1));
    expect(mocks.candidates).toHaveBeenLastCalledWith(assignment.caseId, { q: "Doctor 122", offset: 0, limit: 50 });
    expect(saveButton()).toBeDisabled();
  });

  it("shows a retry state for search errors rather than an empty practice", async () => {
    mocks.candidates.mockRejectedValueOnce(new Error("Practice roster unavailable"));
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("Practice roster unavailable");
    expect(screen.queryByText(/No other eligible doctors/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry doctor search" }));
    await select();
    expect(saveButton()).toBeEnabled();
  });

  it("retains the confirmed doctor and selection after a refused write, with no refresh or success", async () => {
    const { qc, onClose } = setup();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    qc.setQueryData(["case", assignment.caseId], { id: assignment.caseId, doctorName: assignment.doctorName });
    mocks.save.mockRejectedValueOnce(new Error("That doctor is no longer associated with this practice."));
    await select();
    fireEvent.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer associated");
    expect(saveButton()).toBeEnabled();
    expect(qc.getQueryData(["case", assignment.caseId])).toMatchObject({ doctorName: assignment.doctorName });
    expect(invalidate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("cancels without writing; resets selection/search when the open case or practice changes", async () => {
    const view = setup();
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(view.onClose).toHaveBeenCalledOnce();
    expect(mocks.save).not.toHaveBeenCalled();
    view.rerender(view.renderDialog({ caseId: "different-case" }));
    await screen.findByRole("radio");
    expect(saveButton()).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("Type a doctor name…"), { target: { value: "Something" } });
    view.rerender(view.renderDialog({ caseId: "different-case", currentPracticeId: "practice-b" }));
    expect(screen.getByPlaceholderText("Type a doctor name…")).toHaveValue("");
    expect(saveButton()).toBeDisabled();
  });

  it("blocks duplicate saves and closing while the write is pending", async () => {
    let resolve!: (value: unknown) => void;
    mocks.save.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const view = setup();
    await select();
    fireEvent.click(saveButton());
    fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(view.onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    resolve(result());
    await waitFor(() => expect(view.onClose).toHaveBeenCalledOnce());
  });

  it("Undo is bound to the audited case, not the current screen or a directory merge", async () => {
    const view = setup();
    const invalidation = vi.spyOn(view.qc, "invalidateQueries");
    await select();
    fireEvent.click(saveButton());
    await waitFor(() => expect(notify).toHaveBeenCalled());
    const options = vi.mocked(notify).mock.calls[0][0] as unknown as { action: { props: { onClick: () => void } } };
    view.rerender(view.renderDialog({ caseId: "another-open-case" }));
    options.action.props.onClick();
    options.action.props.onClick();
    await waitFor(() => expect(mocks.undo).toHaveBeenCalledOnce());
    expect(mocks.undo).toHaveBeenCalledWith(assignment.caseId, "case-assignment-audit");
    await waitFor(() => expect(invalidation).toHaveBeenCalledWith({ queryKey: ["case", assignment.caseId] }, { throwOnError: true }));
    expect(mocks.undoMerge).not.toHaveBeenCalled();
  });

  it("never turns a committed write plus refresh error into a retryable save failure", async () => {
    const view = setup();
    vi.spyOn(view.qc, "invalidateQueries").mockRejectedValue(new Error("refresh offline"));
    await select();
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.updateNotice).toHaveBeenCalledWith(expect.objectContaining({ title: "Doctor change saved" })));
    expect(view.onClose).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledOnce();
  });

  it("refuses to submit when server assignment no longer matches the persisted open case", async () => {
    mocks.candidates.mockResolvedValue({ ok: true, data: { assignment: { ...assignment, doctorName: "Someone Later" }, entries: [candidate], total: 1, nextOffset: null } });
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("saved doctor or practice changed");
    expect(saveButton()).toBeDisabled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
