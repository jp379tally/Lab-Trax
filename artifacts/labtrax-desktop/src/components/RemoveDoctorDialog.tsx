import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, UserMinus, X } from "lucide-react";
import {
  useRemoveDoctorFromPractice,
  useReassignUnassignedDoctor,
  getListUnassignedDoctorsQueryKey,
} from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import type { Organization } from "@/lib/types";

interface PracticeMemberLite {
  userId: string;
  user: {
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  } | null;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bdr\.?\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function memberDisplayName(m: PracticeMemberLite): string {
  const full = [m.user?.firstName, m.user?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return full || m.user?.username || "";
}

/**
 * Invalidate every cache touched by a detach / reassign so the doctor, their
 * cases, invoices, pricing overrides and the per-lab Unassigned list all
 * refresh together. Shared by both dialogs below.
 */
function invalidateAfterMove(
  queryClient: ReturnType<typeof useQueryClient>,
  labOrganizationId: string,
  practiceIds: string[],
) {
  queryClient.invalidateQueries({ queryKey: ["cases"] });
  queryClient.invalidateQueries({ queryKey: ["invoices"] });
  queryClient.invalidateQueries({ queryKey: ["organizations"] });
  queryClient.invalidateQueries({ queryKey: ["pricing-overrides"] });
  queryClient.invalidateQueries({
    queryKey: getListUnassignedDoctorsQueryKey(labOrganizationId),
  });
  for (const id of practiceIds) {
    if (!id) continue;
    queryClient.invalidateQueries({
      queryKey: ["organization", id, "members"],
    });
  }
}

const overlayCls =
  "fixed inset-0 z-[80] flex items-center justify-center bg-foreground/40 p-4";
const cardCls =
  "w-full max-w-md bg-card border border-border rounded-lg shadow-xl flex flex-col max-h-[90vh]";
const selectCls =
  "w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary";

/**
 * Remove (detach) a doctor from a practice. The doctor either moves to a
 * sibling practice or lands in the per-lab "Unassigned doctors" holding area.
 * Sending to Unassigned always leaves existing cases/invoices behind; only a
 * reassignment to a destination can move them. Lab-admin only.
 */
export function RemoveDoctorDialog({
  practiceId,
  practiceName,
  labOrganizationId,
  doctorName,
  onClose,
  onDone,
}: {
  practiceId: string;
  practiceName: string;
  labOrganizationId: string;
  doctorName: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const queryClient = useQueryClient();
  const [destination, setDestination] = useState<string>("unassigned");
  const [existingCases, setExistingCases] = useState<"leave" | "move">("leave");
  const [error, setError] = useState<string | null>(null);

  // Resolve the doctor's real provider user id (if any) so the server drops
  // the existing membership instead of promoting a duplicate account.
  const membersQuery = useQuery({
    queryKey: ["organization", practiceId, "members"],
    queryFn: () =>
      apiFetch<PracticeMemberLite[]>(`/organizations/${practiceId}/members`),
  });
  const resolvedUserId = useMemo<string | null>(() => {
    const target = normalizeName(doctorName);
    for (const m of membersQuery.data ?? []) {
      if (normalizeName(memberDisplayName(m)) === target) return m.userId;
    }
    return null;
  }, [membersQuery.data, doctorName]);

  // Sibling provider practices under the same lab (the reassign targets).
  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
  });
  const siblingPractices = useMemo(() => {
    return (orgsQuery.data ?? [])
      .filter(
        (o) =>
          o.type === "provider" &&
          o.parentLabOrganizationId === labOrganizationId &&
          o.id !== practiceId &&
          !o.deletedAt,
      )
      .sort((a, b) =>
        (a.displayName || a.name || "").localeCompare(
          b.displayName || b.name || "",
        ),
      );
  }, [orgsQuery.data, labOrganizationId, practiceId]);

  const removeMutation = useRemoveDoctorFromPractice({
    mutation: {
      onSuccess: () => {
        invalidateAfterMove(queryClient, labOrganizationId, [
          practiceId,
          destination === "unassigned" ? "" : destination,
        ]);
        onDone?.();
        onClose();
      },
      onError: (err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Could not remove the doctor.",
        );
      },
    },
  });

  const toUnassigned = destination === "unassigned";

  function handleSubmit() {
    setError(null);
    removeMutation.mutate({
      organizationId: practiceId,
      data: {
        doctorName,
        userId: resolvedUserId,
        destinationOrganizationId: toUnassigned ? null : destination,
        existingCases: toUnassigned ? "leave" : existingCases,
      },
    });
  }

  return (
    <div className={overlayCls} onClick={onClose}>
      <div className={cardCls} onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <UserMinus size={16} className="text-destructive" />
            <h2 className="text-sm font-semibold">Remove doctor from practice</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          <p className="text-sm text-muted-foreground">
            Detach <span className="font-medium text-foreground">{doctorName}</span>{" "}
            from{" "}
            <span className="font-medium text-foreground">{practiceName}</span>.
            This does not delete the doctor — they keep their account.
          </p>

          <div>
            <label className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
              Where should they go?
            </label>
            <select
              className={`${selectCls} mt-1.5`}
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            >
              <option value="unassigned">
                Unassigned doctors (holding area)
              </option>
              {siblingPractices.map((p) => (
                <option key={p.id} value={p.id}>
                  Reassign to {p.displayName || p.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
              Existing cases &amp; invoices
            </label>
            {toUnassigned ? (
              <p className="text-xs text-muted-foreground mt-1.5 border border-border rounded-md px-3 py-2">
                Cases and invoices stay with {practiceName}. They can only be
                moved when you reassign the doctor to another practice.
              </p>
            ) : (
              <div className="mt-1.5 space-y-2">
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="existingCases"
                    className="mt-0.5"
                    checked={existingCases === "leave"}
                    onChange={() => setExistingCases("leave")}
                  />
                  <span>
                    <span className="font-medium">Leave with {practiceName}</span>
                    <span className="block text-xs text-muted-foreground">
                      Existing cases and invoices stay attached to this practice.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="existingCases"
                    className="mt-0.5"
                    checked={existingCases === "move"}
                    onChange={() => setExistingCases("move")}
                  />
                  <span>
                    <span className="font-medium">Move with the doctor</span>
                    <span className="block text-xs text-muted-foreground">
                      Reassign this doctor's existing cases and invoices to the
                      destination practice.
                    </span>
                  </span>
                </label>
              </div>
            )}
          </div>

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-3 rounded-md border border-border text-sm hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={removeMutation.isPending || membersQuery.isLoading}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 disabled:opacity-60"
          >
            {removeMutation.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <UserMinus size={14} />
            )}
            {toUnassigned ? "Remove" : "Reassign"}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Reassign a doctor out of the per-lab Unassigned holding area to a practice,
 * choosing whether their cases/invoices at the practice they were removed from
 * follow them. Lab-admin only.
 */
export function ReassignUnassignedDialog({
  labOrganizationId,
  userId,
  doctorName,
  onClose,
  onDone,
}: {
  labOrganizationId: string;
  userId: string;
  doctorName: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const queryClient = useQueryClient();
  const [destination, setDestination] = useState<string>("");
  const [existingCases, setExistingCases] = useState<"leave" | "move">("leave");
  const [error, setError] = useState<string | null>(null);

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
  });
  const practices = useMemo(() => {
    return (orgsQuery.data ?? [])
      .filter(
        (o) =>
          o.type === "provider" &&
          o.parentLabOrganizationId === labOrganizationId &&
          !o.deletedAt,
      )
      .sort((a, b) =>
        (a.displayName || a.name || "").localeCompare(
          b.displayName || b.name || "",
        ),
      );
  }, [orgsQuery.data, labOrganizationId]);

  const reassignMutation = useReassignUnassignedDoctor({
    mutation: {
      onSuccess: () => {
        invalidateAfterMove(queryClient, labOrganizationId, [destination]);
        onDone?.();
        onClose();
      },
      onError: (err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Could not reassign the doctor.",
        );
      },
    },
  });

  function handleSubmit() {
    setError(null);
    if (!destination) {
      setError("Choose a destination practice.");
      return;
    }
    reassignMutation.mutate({
      data: {
        labOrganizationId,
        userId,
        destinationOrganizationId: destination,
        existingCases,
      },
    });
  }

  return (
    <div className={overlayCls} onClick={onClose}>
      <div className={cardCls} onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold">Reassign doctor to a practice</h2>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          <p className="text-sm text-muted-foreground">
            Attach{" "}
            <span className="font-medium text-foreground">{doctorName}</span> to a
            practice.
          </p>

          <div>
            <label className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
              Destination practice
            </label>
            <select
              className={`${selectCls} mt-1.5`}
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            >
              <option value="">— Select a practice —</option>
              {practices.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName || p.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
              Existing cases &amp; invoices
            </label>
            <div className="mt-1.5 space-y-2">
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="reassignExistingCases"
                  className="mt-0.5"
                  checked={existingCases === "leave"}
                  onChange={() => setExistingCases("leave")}
                />
                <span>
                  <span className="font-medium">
                    Leave with the original practice
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Cases and invoices stay where they are.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="reassignExistingCases"
                  className="mt-0.5"
                  checked={existingCases === "move"}
                  onChange={() => setExistingCases("move")}
                />
                <span>
                  <span className="font-medium">Move with the doctor</span>
                  <span className="block text-xs text-muted-foreground">
                    Reassign cases and invoices from the practice this doctor was
                    removed from to the destination.
                  </span>
                </span>
              </label>
            </div>
          </div>

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-3 rounded-md border border-border text-sm hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={reassignMutation.isPending}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
          >
            {reassignMutation.isPending && (
              <Loader2 size={14} className="animate-spin" />
            )}
            Reassign
          </button>
        </footer>
      </div>
    </div>
  );
}
