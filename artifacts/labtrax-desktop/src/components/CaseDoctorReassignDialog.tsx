import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCaseDoctorCandidates, getGetCaseDoctorCandidatesQueryKey, useReassignCaseDoctor, undoCaseDoctorReassignment,
  refreshCaseDoctorQueries, type CaseDoctorCandidate, type CaseDoctorReassignmentResult,
} from "@workspace/api-client-react";
import { formatAccountNumberForDisplay } from "@workspace/account-number";
import { Loader2 } from "lucide-react";
import { toast as notify } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface CaseDoctorReassignDialogProps {
  caseId: string;
  caseNumber: string;
  currentDoctorName: string;
  currentPracticeId: string;
  onClose: () => void;
}

export function CaseDoctorReassignDialog(props: CaseDoctorReassignDialogProps) {
  // Remount state immediately if the persisted case/assignment changes.
  return <ReassignDialogContent key={JSON.stringify([props.caseId, props.currentDoctorName, props.currentPracticeId])} {...props} />;
}

function ReassignDialogContent({ caseId, caseNumber, currentDoctorName, currentPracticeId, onClose }: CaseDoctorReassignDialogProps) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [selection, setSelection] = useState<{ candidate: CaseDoctorCandidate; revision: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const params = { q: search.trim() || undefined, offset, limit: 50 };
  const roster = useGetCaseDoctorCandidates(caseId, params, {
    query: { queryKey: getGetCaseDoctorCandidatesQueryKey(caseId, params), retry: false, staleTime: 0 },
  });
  const mutation = useReassignCaseDoctor();
  const page = roster.data?.data;
  const assignment = page?.assignment;
  const assignmentMatches = assignment?.caseId === caseId &&
    assignment.doctorName === currentDoctorName && assignment.providerOrganizationId === currentPracticeId;
  const candidates = (page?.entries ?? []).filter((entry) => entry.doctorName !== currentDoctorName);
  const canSave = !!selection && assignmentMatches && selection.revision === assignment?.revision &&
    !roster.isFetching && !roster.isError && !saving;

  function close() {
    if (!inFlight.current) onClose();
  }

  function showSuccess(result: CaseDoctorReassignmentResult["data"]) {
    let undoing = false;
    const duration = Math.max(0, Date.parse(result.undoExpiresAt ?? "") - Date.now());
    return notify({
      title: "Doctor changed for this case only",
      description: `Case ${result.assignment.caseNumber}: ${result.previousDoctorName} → ${result.assignment.doctorName}. This case only.`,
      duration: Number.isFinite(duration) ? duration : 5000,
      ...(duration > 0 ? {
        action: (
          <ToastAction altText={`Undo doctor assignment for case ${result.assignment.caseNumber}`} onClick={() => {
            if (undoing) return;
            undoing = true;
            void (async () => {
              let response: CaseDoctorReassignmentResult;
              try {
                response = await undoCaseDoctorReassignment(result.assignment.caseId, result.auditLogId);
              } catch (err) {
                undoing = false;
                notify({ variant: "destructive", title: "Couldn't undo", description: err instanceof Error ? err.message : "Could not undo the case's doctor change." });
                return;
              }
              notify({ title: "Reassignment undone", description: `Case ${response.data.assignment.caseNumber}: doctor restored to ${response.data.assignment.doctorName}.` });
              if (!await refreshCaseDoctorQueries(qc, response.data.assignment)) {
                notify({ title: "Undo saved", description: "Reload the case to refresh its history and lists." });
              }
            })();
          }}>Undo</ToastAction>
        ),
      } : {}),
    });
  }

  async function save() {
    if (inFlight.current || !canSave || !assignment || !selection) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    let response: CaseDoctorReassignmentResult;
    try {
      response = await mutation.mutateAsync({
        caseId,
        data: {
          recordType: assignment.recordType, expectedDoctorName: currentDoctorName,
          expectedPracticeId: currentPracticeId, expectedRevision: selection.revision,
          candidateKey: selection.candidate.key,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the doctor. The saved assignment was not changed.");
      inFlight.current = false;
      setSaving(false);
      return;
    }
    // Everything after this point is post-commit; never offer another save.
    const notification = showSuccess(response.data);
    onClose();
    if (!await refreshCaseDoctorQueries(qc, response.data.assignment)) {
      // Keep the original Undo action available even if refreshing fails.
      notification.update({
        id: notification.id, title: "Doctor change saved",
        description: `Case ${response.data.assignment.caseNumber}: ${response.data.previousDoctorName} → ${response.data.assignment.doctorName}. Reload the case to refresh its history and lists.`,
      });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto" onEscapeKeyDown={(event) => { if (saving) event.preventDefault(); }} onPointerDownOutside={(event) => { if (saving) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>Reassign doctor</DialogTitle>
          <DialogDescription>
            Change doctor for this case only. Case {caseNumber} currently has {currentDoctorName}.
            Other cases, pricing, accounts, and saved invoices stay unchanged.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {assignment?.practiceName ? `Practice: ${assignment.practiceName}. ` : ""}
            Only existing doctors associated with this practice are available. If the intended doctor is missing, their association must be managed separately; this action cannot change practices or create accounts.
          </p>
          <label className="block text-sm font-medium">
            Search this practice&apos;s doctors
            <input
              className="mt-1 w-full h-9 rounded border border-border bg-secondary px-3 text-sm"
              placeholder="Type a doctor name…"
              value={search}
              disabled={saving}
              onChange={(event) => { setSearch(event.target.value); setOffset(0); setSelection(null); setError(null); }}
            />
          </label>
          {roster.isError ? (
            <div role="alert" className="space-y-2 text-sm text-destructive">
              <p>{roster.error instanceof Error ? roster.error.message : "Could not load this practice's doctors."}</p>
              <button type="button" className="underline" disabled={roster.isFetching || saving} onClick={() => { void roster.refetch(); }}>Retry doctor search</button>
            </div>
          ) : roster.isFetching ? (
            <p role="status" className="text-sm text-muted-foreground">Loading doctors…</p>
          ) : assignment && !assignmentMatches ? (
            <p role="alert" className="text-sm text-destructive">The saved doctor or practice changed. Close and reopen this case before reassigning.</p>
          ) : (
            <>
              <div className="max-h-60 overflow-y-auto space-y-1" aria-label="Practice doctors">
                {candidates.map((candidate) => (
                  <label key={candidate.key} className="flex items-center gap-3 rounded border border-border px-3 py-2 text-sm cursor-pointer">
                    <input
                      type="radio" name="case-doctor" checked={selection?.candidate.key === candidate.key}
                      disabled={saving}
                      onChange={() => { if (assignment) setSelection({ candidate, revision: assignment.revision }); setError(null); }}
                    />
                    <span>
                      <span className="block font-medium">{candidate.doctorName}</span>
                      <span className="text-xs text-muted-foreground">
                        {candidate.platformAccountNumber ? `Account ${formatAccountNumberForDisplay(candidate.platformAccountNumber)}` : candidate.userId ? "Registered doctor" : "Name-only practice roster entry"}
                      </span>
                    </span>
                  </label>
                ))}
                {candidates.length === 0 && <p className="text-sm text-muted-foreground">No other eligible doctors on this page. Search or check the next page; a missing doctor must already be associated with this practice.</p>}
              </div>
              <div className="flex justify-between items-center text-xs">
                <button type="button" disabled={offset === 0 || saving} className="disabled:opacity-40" onClick={() => { setOffset(Math.max(0, offset - 50)); setSelection(null); }}>Previous doctors</button>
                <span>{page?.total ?? 0} eligible doctors</span>
                <button type="button" disabled={page?.nextOffset == null || saving} className="disabled:opacity-40" onClick={() => { if (page?.nextOffset != null) { setOffset(page.nextOffset); setSelection(null); } }}>Next doctors</button>
              </div>
            </>
          )}
          <div className="rounded border border-border bg-secondary/50 p-3 text-sm space-y-1" aria-live="polite">
            <p className="font-medium">Change doctor for this case only.</p>
            <p>Case {caseNumber}: {currentDoctorName} → {selection?.candidate.doctorName ?? "Select a doctor"}.</p>
            <p className="text-xs text-muted-foreground">Undo is available for a short time unless this case changes again.</p>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {selection && assignmentMatches && selection.revision !== assignment?.revision && (
            <p role="alert" className="text-sm text-destructive">This case was updated while you were choosing. Select the doctor again to confirm.</p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={saving} className="h-9 px-4 rounded border border-border text-sm" onClick={close}>Cancel</button>
          <button type="button" disabled={!canSave} className="h-9 px-4 rounded bg-primary text-primary-foreground text-sm disabled:opacity-50 inline-flex items-center gap-2" onClick={() => { void save(); }}>
            {saving && <Loader2 size={14} className="animate-spin" />}
            {saving ? "Saving…" : "Change doctor for this case only"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
