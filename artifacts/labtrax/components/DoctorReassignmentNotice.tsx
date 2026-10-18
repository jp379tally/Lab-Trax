import React, { useRef, useState } from "react";
import { Text } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { undoCaseDoctorReassignment, refreshCaseDoctorQueries, type CaseDoctorReassignmentResult } from "@workspace/api-client-react";
import { FormSheet } from "@/components/ui/FormSheet";
import { useTheme } from "@/lib/theme-context";
import { Typography } from "@/constants/tokens";

/** Expo web has no native Alert UI. Keep its audited Undo in an actual sheet. */
export function DoctorReassignmentNotice({ result, refreshFailed, onClose }: {
  result: CaseDoctorReassignmentResult["data"];
  refreshFailed: boolean;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [undone, setUndone] = useState<CaseDoctorReassignmentResult["data"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(refreshFailed);
  const expiresAt = Date.parse(result.undoExpiresAt ?? "");
  const expired = !Number.isFinite(expiresAt) || Date.now() >= expiresAt;
  const close = () => { if (!inFlight.current) onClose(); };
  async function undo() {
    if (inFlight.current || undone) return;
    if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) { setError("The doctor reassignment undo window has expired."); return; }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    let response: CaseDoctorReassignmentResult;
    try {
      response = await undoCaseDoctorReassignment(result.assignment.caseId, result.auditLogId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not undo. The case may have changed, or the undo window has passed.");
      inFlight.current = false;
      setBusy(false);
      return;
    }
    setUndone(response.data);
    setNeedsRefresh(!await refreshCaseDoctorQueries(qc, response.data.assignment));
    inFlight.current = false;
    setBusy(false);
  }
  return (
    <FormSheet visible
      title={undone ? "Reassignment undone" : "Doctor changed for this case only"}
      onClose={close} onSubmit={() => { void undo(); }}
      cancelLabel="Done" submitLabel={undone ? "Undone" : "Undo"}
      submitDisabled={!!undone || expired} submitting={busy} testIDPrefix="doctor-reassign-notice"
    >
      <Text style={{ ...Typography.body, color: colors.text }}>
        {undone
          ? `Case ${undone.assignment.caseNumber}: doctor restored to ${undone.assignment.doctorName}.`
          : `Case ${result.assignment.caseNumber}: ${result.previousDoctorName} → ${result.assignment.doctorName}.`}
      </Text>
      <Text style={{ ...Typography.caption, color: colors.textSecondary }}>
        Other cases and saved invoices are unchanged. Undo is available for a short time unless this case changes again.
      </Text>
      {needsRefresh && <Text accessibilityRole="alert" style={{ ...Typography.caption, color: colors.textSecondary }}>
        {undone ? "Undo saved." : "Doctor change saved."} Reload the case to refresh its history and lists. Do not submit the change again.
      </Text>}
      {error && <Text accessibilityRole="alert" style={{ ...Typography.caption, color: colors.error }}>{error}</Text>}
      {expired && !undone && <Text style={{ ...Typography.caption, color: colors.textSecondary }}>The undo window has expired.</Text>}
    </FormSheet>
  );
}
