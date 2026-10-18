import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link, useLocation } from "wouter";
import {
  AlertTriangle,
  Calendar,
  CalendarOff,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileText,
  ChevronsUpDown,
  Clock,
  Loader2,
  Plus,
  Sparkles,
  Upload,
  XCircle,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiFetch, ApiError } from "@/lib/api";
import { useAiPanel } from "@/lib/ai-panel-context";
import { usePlatformAdminGate, PlatformAdminSetupNotice } from "@/lib/platform-admin-gate";
import { retryUnlessForbidden, haltPollingIfForbidden } from "@/lib/platform-admin-query";
import { formatNextBackupTime } from "@/lib/backup-schedule";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LabCase, MeResponse } from "@/lib/types";
import { compareDueDateTime, formatDate, formatDateTime, formatDueDate, getLocalDayRange, hasUsableDueDate, isDueToday, isPastDue, relativeTime, statusLabel } from "@/lib/format";
import { deriveCaseTypeIndicator } from "@/lib/case-date-filter";
import { useDayChange } from "@/hooks/useDayChange";
import {
  getLocalCalendarDateParts,
} from "@workspace/calendar-date";
import { StatusBadge } from "@/components/StatusBadge";
import { DashboardDropZone } from "@/components/DashboardDropZone";
import { UnassignedDocumentsCard } from "@/components/UnassignedDocumentsCard";
import { ExceptionCasesCard } from "@/components/ExceptionCasesCard";
import { NewCaseModal, CaseDrawer, stepLabel } from "./cases";
import { useAuth } from "@/lib/auth-context";
import { DashboardSubscriptionBanner } from "@/components/TrialBanner";
import {
  DUE_TOMORROW_SORT_LABELS,
  sortDueTomorrowCases as sortSharedDueTomorrowCases,
  type DueTomorrowSort,
  useListLabInboxFiles,
  getListLabInboxFilesQueryKey,
} from "@workspace/api-client-react";

export { DUE_TOMORROW_SORT_LABELS };
export type { DueTomorrowSort };


interface LabLookupResult {
  id: string;
  name: string;
  displayName: string;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
}

interface MyJoinRequest {
  id: string;
  organizationId: string;
  status: string;
  organization?: {
    id: string;
    name: string;
    displayName?: string | null;
    // "lab" or "provider" — providers joining an existing practice see
    // practice-flavored copy on the waiting card.
    type?: string | null;
  } | null;
}

// Self-serve "request to join a lab" card shown to signed-up users who are not
// yet a member of any active lab. Lets them search for a lab by name/city and
// send a join request the lab admin can approve, and reflects a pending request
// back to the user.
export function JoinLabCard() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectedLabId, setSelectedLabId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const pendingQuery = useQuery({
    queryKey: ["join-requests", "mine", "pending"],
    queryFn: () =>
      apiFetch<MyJoinRequest[]>("/organizations/join-requests/mine/pending"),
    refetchInterval: 20_000,
  });
  const activeRequest = pendingQuery.data?.[0] ?? null;
  const pendingRequest =
    activeRequest?.status === "pending" ? activeRequest : null;
  const declinedRequest =
    activeRequest?.status === "rejected" ? activeRequest : null;
  const approvedRequest =
    activeRequest?.status === "approved" ? activeRequest : null;

  // The moment an admin approves the request, the polled list flips it to
  // "approved". Refetch membership (the ["auth","me"] cache that gates this
  // card) so the user immediately drops out of the waiting state and into the
  // full lab dashboard, and refresh cases for the new lab.
  useEffect(() => {
    if (!approvedRequest) return;
    void queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    void queryClient.invalidateQueries({ queryKey: ["cases"] });
  }, [approvedRequest, queryClient]);

  const lookupQuery = useQuery({
    queryKey: ["labs", "lookup", debounced],
    queryFn: () =>
      apiFetch<{ labs: LabLookupResult[] }>(
        `/labs/lookup?q=${encodeURIComponent(debounced)}`,
      ),
    enabled: debounced.length >= 2 && !activeRequest,
  });
  const labs = lookupQuery.data?.labs ?? [];

  const sendRequestMutation = useMutation({
    mutationFn: async (labId: string) => {
      setSelectedLabId(labId);
      return apiFetch(`/organizations/${labId}/join-requests`, {
        method: "POST",
        body: JSON.stringify({ requestedRole: "user" }),
      });
    },
    onSuccess: () => {
      setErrorMsg(null);
      setQuery("");
      setDebounced("");
      void queryClient.invalidateQueries({
        queryKey: ["join-requests", "mine", "pending"],
      });
    },
    onError: (err: Error) => {
      setErrorMsg(err.message || "Could not send your request. Please try again.");
    },
    onSettled: () => setSelectedLabId(null),
  });

  const cancelRequestMutation = useMutation({
    mutationFn: async (id: string) =>
      apiFetch(`/organizations/join-requests/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["join-requests", "mine", "pending"],
      });
    },
  });

  if (approvedRequest) {
    const isPractice = approvedRequest.organization?.type === "provider";
    const labName =
      approvedRequest.organization?.displayName ||
      approvedRequest.organization?.name ||
      (isPractice ? "the practice" : "the lab");
    return (
      <div className="max-w-md w-full text-center bg-card border border-border rounded-xl shadow-sm p-8">
        <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-emerald-500/10 flex items-center justify-center">
          <CheckCircle2 className="text-emerald-500" size={24} />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">
          Request approved
        </h1>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
          You've been approved to join{" "}
          <span className="font-medium text-foreground">{labName}</span>. Loading
          your dashboard…
        </p>
        <Loader2 className="mx-auto mt-5 w-5 h-5 text-muted-foreground animate-spin" />
      </div>
    );
  }

  if (pendingRequest) {
    const isPractice = pendingRequest.organization?.type === "provider";
    const labName =
      pendingRequest.organization?.displayName ||
      pendingRequest.organization?.name ||
      (isPractice ? "the practice" : "the lab");
    return (
      <div className="max-w-md w-full text-center bg-card border border-border rounded-xl shadow-sm p-8">
        <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-amber-500/10 flex items-center justify-center">
          <Clock className="text-amber-500" size={24} />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Request pending</h1>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
          Your request to join{" "}
          <span className="font-medium text-foreground">{labName}</span> has been
          sent. You'll get access as soon as {isPractice ? "a practice admin or its lab" : "a lab admin"} approves it.
        </p>
        <button
          type="button"
          onClick={() => cancelRequestMutation.mutate(pendingRequest.id)}
          disabled={cancelRequestMutation.isPending}
          className="mt-5 inline-flex items-center justify-center h-9 px-4 rounded-md border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
        >
          {cancelRequestMutation.isPending ? "Cancelling…" : "Cancel request"}
        </button>
      </div>
    );
  }

  if (declinedRequest) {
    const isPractice = declinedRequest.organization?.type === "provider";
    const labName =
      declinedRequest.organization?.displayName ||
      declinedRequest.organization?.name ||
      (isPractice ? "the practice" : "the lab");
    return (
      <div className="max-w-md w-full text-center bg-card border border-border rounded-xl shadow-sm p-8">
        <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
          <XCircle className="text-destructive" size={24} />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">
          Request declined
        </h1>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
          Your request to join{" "}
          <span className="font-medium text-foreground">{labName}</span> was
          declined. You can search for another lab to join, or wait for a lab
          admin to invite you.
        </p>
        <button
          type="button"
          onClick={() => cancelRequestMutation.mutate(declinedRequest.id)}
          disabled={cancelRequestMutation.isPending}
          className="mt-5 inline-flex items-center justify-center h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {cancelRequestMutation.isPending ? "Dismissing…" : "Find another lab"}
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-md w-full bg-card border border-border rounded-xl shadow-sm p-8">
      <div className="text-center">
        <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
          <Clock className="text-primary" size={24} />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">
          Your account is ready
        </h1>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
          Find your lab below and send a request to join, or wait for a lab admin
          to invite you.
        </p>
      </div>

      <div className="mt-6 space-y-3 text-left">
        <label className="text-xs font-medium text-muted-foreground">
          Search for your lab
        </label>
        <div className="relative">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Lab name or city"
            className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {lookupQuery.isFetching && (
            <Loader2 className="absolute right-3 top-2.5 w-5 h-5 text-muted-foreground animate-spin" />
          )}
        </div>

        {errorMsg && (
          <div className="text-xs text-destructive">{errorMsg}</div>
        )}

        {debounced.length >= 2 && (
          <ul className="border border-border rounded-md divide-y divide-border max-h-64 overflow-y-auto">
            {labs.length === 0 && !lookupQuery.isFetching && (
              <li className="px-3 py-3 text-xs text-muted-foreground text-center">
                No labs found. Try a different search.
              </li>
            )}
            {labs.map((lab) => {
              const location = [lab.addressLine1, lab.city, lab.state, lab.zip]
                .filter(Boolean)
                .join(", ");
              const sending =
                sendRequestMutation.isPending && selectedLabId === lab.id;
              return (
                <li
                  key={lab.id}
                  className="px-3 py-2.5 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">
                      {lab.displayName || lab.name}
                    </div>
                    {location && (
                      <div className="text-xs text-muted-foreground truncate">
                        {location}
                      </div>
                    )}
                    {lab.phone && (
                      <div className="text-xs text-muted-foreground truncate">
                        {lab.phone}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => sendRequestMutation.mutate(lab.id)}
                    disabled={sendRequestMutation.isPending}
                    className="shrink-0 inline-flex items-center gap-1 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {sending ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      "Request to join"
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

interface BackupScheduleSettings {
  hourUtc: number;
  lastSuccessfulBackupAt?: string | null;
  staleAfterDays?: number;
}

const DEFAULT_BACKUP_STALE_DAYS = 7;

function isBackupStale(lastSuccessfulBackupAt: string | null | undefined, staleDays: number = DEFAULT_BACKUP_STALE_DAYS): boolean {
  if (!lastSuccessfulBackupAt) return true;
  const last = new Date(lastSuccessfulBackupAt).getTime();
  if (Number.isNaN(last)) return true;
  return Date.now() - last > staleDays * 24 * 60 * 60 * 1000;
}

/**
 * Returns the number of calendar days from today to the next Monday–Friday
 * business day. Saturdays and Sundays are skipped — no holidays.
 *   Mon–Thu → 1  (tomorrow is already a weekday)
 *   Fri     → 3  (skip Sat+Sun, reach Monday)
 *   Sat     → 2  (skip Sun, reach Monday)
 *   Sun     → 1  (tomorrow Mon is a weekday)
 * Accepts an optional `now` argument so tests can freeze time via
 * vi.useFakeTimers() and still exercise the correct branch.
 */
function nextBizDayOffset(now: Date = new Date()): number {
  const dow = now.getDay(); // 0=Sun,1=Mon,...,5=Fri,6=Sat
  if (dow === 5) return 3;
  if (dow === 6) return 2;
  return 1;
}

const IN_PROGRESS_STATUSES = new Set([
  "received",
  "in_design",
  "in_milling",
  "in_porcelain",
  "qc",
]);

const COMPLETED_STATUSES = new Set(["delivered", "cancelled", "complete"]);

/**
 * Predicate used by the pastDueCases memo. Past Due uses the same effective
 * date precedence and paired-time behavior as Due Today: dueDate first, then
 * expectedDeliveryDate only when dueDate is absent.
 */
export function caseIsPastDue(
  c: Pick<LabCase, "status" | "dueDate" | "dueTime" | "expectedDeliveryDate">,
): boolean {
  if (COMPLETED_STATUSES.has(c.status)) return false;
  const usingDueDate = c.dueDate != null && c.dueDate !== "";
  const effectiveDate = c.dueDate ?? c.expectedDeliveryDate;
  const effectiveTime = usingDueDate ? c.dueTime : null;
  return isPastDue(effectiveDate, effectiveTime);
}

/**
 * Predicate used by the dueTodayCases memo.
 * Exported so regression tests can call the real production logic directly.
 * Uses dueDate as the primary field (matching what the lab slip displays);
 * falls back to expectedDeliveryDate only when dueDate is absent.
 *
 * A due-today case whose due time has already passed is excluded here and
 * appears in Past Due instead.
 */
export function caseIsDueTodayFn(c: Pick<LabCase, "status" | "dueDate" | "dueTime" | "expectedDeliveryDate">): boolean {
  const usingDueDate = c.dueDate != null && c.dueDate !== "";
  const effectiveDate = c.dueDate ?? c.expectedDeliveryDate;
  const effectiveTime = usingDueDate ? c.dueTime : null;
  if (COMPLETED_STATUSES.has(c.status)) return false;
  return isDueToday(effectiveDate) && !isPastDue(effectiveDate, effectiveTime);
}

/**
 * Predicate used by the dueTomorrowCases memo.
 * Exported so regression tests can call the real production logic directly.
 *
 * "Due tomorrow" means due on the next Monday–Friday business day (Saturdays
 * and Sundays are skipped — no holidays). On a Friday the target is Monday;
 * on any Mon–Thu the target is the following calendar day.
 *
 * Uses expectedDeliveryDate as the primary field (the doctor-requested delivery
 * date shown on the lab slip), falling back to dueDate only when
 * expectedDeliveryDate is absent. This matches mobile's caseIsDueTomorrow so
 * both platforms show the same cases in the Due Tomorrow section.
 * Completed cases are excluded.
 */
export function caseIsDueTomorrowFn(c: Pick<LabCase, "status" | "dueDate" | "expectedDeliveryDate">): boolean {
  if (COMPLETED_STATUSES.has(c.status)) return false;
  const effectiveDate = c.expectedDeliveryDate ?? c.dueDate;
  if (!effectiveDate) return false;
  const now = new Date();
  const offset = nextBizDayOffset(now);
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  // Parse "YYYY-MM-DD" (or ISO UTC string) as a UTC-midnight Date, then compare
  // its UTC components against the local calendar date of the target day — the
  // same strategy isDueToday / isPastDue in format.ts use.
  const d = new Date(effectiveDate);
  if (isNaN(d.getTime())) return false;
  return (
    d.getUTCFullYear() === target.getFullYear() &&
    d.getUTCMonth() === target.getMonth() &&
    d.getUTCDate() === target.getDate()
  );
}

function comparableDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function comparableText(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim().toLocaleLowerCase() : null;
  return normalized ? normalized : null;
}

function compareNullable(
  a: string | number | null,
  b: string | number | null,
  direction: "asc" | "desc" = "asc",
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const result =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  return direction === "desc" ? -result : result;
}

function caseTypeIndicatorKey(c: Pick<LabCase, "restorationTypes" | "restorationMaterials" | "firstRestorationSubtype">): string | null {
  return comparableText(
    deriveCaseTypeIndicator(c.restorationTypes, c.restorationMaterials, c.firstRestorationSubtype),
  );
}

function caseSortTieBreak(a: LabCase, b: LabCase): number {
  return (a.id ?? "").localeCompare(b.id ?? "", undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Shared C/D/O case-type comparison for every dashboard section that offers a
 * Case Type sort. The displayed indicator is compared, so crowns sort first,
 * then removables, then ortho/appliances ("C" < "D" < "O"), cases with no
 * derivable indicator sort last, and equal rows fall back to the deterministic
 * id tie-break so the table does not reshuffle as fresh data arrives.
 */
export function compareCaseTypeIndicator(a: LabCase, b: LabCase): number {
  return compareNullable(caseTypeIndicatorKey(a), caseTypeIndicatorKey(b)) || caseSortTieBreak(a, b);
}

export function sortDueTomorrowCases(
  cases: LabCase[],
  sort: DueTomorrowSort,
  locations: Array<{ id: string; value: string; label: string }> = [],
): LabCase[] {
  return sortSharedDueTomorrowCases(cases, sort, {
    getLocationLabel: (caseItem) =>
      caseLocationLabel(caseItem, locations),
    getTypeIndicator: (caseItem) =>
      deriveCaseTypeIndicator(
        caseItem.restorationTypes,
        caseItem.restorationMaterials,
        caseItem.firstRestorationSubtype,
      ),
  });
}

/** Prefer the station identity/name returned on the case.  A status is only a
 * fallback: multiple physical stations may intentionally share one status. */
export function caseLocationLabel(
  c: Pick<LabCase, "status" | "labLocationId" | "labLocationName">,
  locations: Array<{ id: string; value: string; label: string }> = [],
): string {
  if (c.labLocationName?.trim()) return c.labLocationName;
  if (c.labLocationId) {
    const station = locations.find((location) => location.id === c.labLocationId);
    if (station?.label) return station.label;
  }
  return c.status ? statusLabel(c.status) : "—";
}

/**
 * Sort choices shared by the Past Due and Due Today sections. Both sections
 * offer the same menu (and the mobile dashboard mirrors it), while each keeps
 * its own default selection and its own comparator details.
 */
export type SectionSort =
  | "due_date"
  | "entered"
  | "case_number"
  | "patient"
  | "doctor"
  | "status"
  | "priority"
  | "type";

export const SECTION_SORT_LABELS: Record<SectionSort, string> = {
  due_date: "Due date",
  entered: "Entered date",
  case_number: "Case #",
  patient: "Patient name",
  doctor: "Doctor",
  status: "Location / Status",
  priority: "Priority",
  type: "Case Type",
};

function compareCaseNumber(a: LabCase, b: LabCase): number {
  const na = parseInt(a.caseNumber ?? "", 10);
  const nb = parseInt(b.caseNumber ?? "", 10);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return (a.caseNumber ?? "").localeCompare(b.caseNumber ?? "");
}

function comparePatientName(a: LabCase, b: LabCase): number {
  const pa = `${a.patientLastName ?? ""} ${a.patientFirstName ?? ""}`.trim().toLowerCase();
  const pb = `${b.patientLastName ?? ""} ${b.patientFirstName ?? ""}`.trim().toLowerCase();
  return pa.localeCompare(pb);
}

function compareEnteredDate(a: LabCase, b: LabCase): number {
  return (a.createdAt || "").localeCompare(b.createdAt || "");
}

function compareRushFirst(a: LabCase, b: LabCase): number {
  const rushA = a.priority === "rush" ? 0 : 1;
  const rushB = b.priority === "rush" ? 0 : 1;
  return rushA - rushB;
}

/** Sort the already-filtered Past Due bucket. */
export function sortPastDueCases(
  cases: LabCase[],
  sort: SectionSort,
  locations: Array<{ id: string; value: string; label: string }> = [],
): LabCase[] {
  return [...cases].sort((a, b) => {
    switch (sort) {
      case "due_date":
        return compareDueDateTime(a.dueDate, a.dueTime, b.dueDate, b.dueTime); // oldest first
      case "case_number":
        return compareCaseNumber(a, b);
      case "patient":
        return comparePatientName(a, b);
      case "doctor":
        return (a.doctorName ?? "").toLowerCase().localeCompare((b.doctorName ?? "").toLowerCase());
      case "status":
        return caseLocationLabel(a, locations).toLowerCase().localeCompare(caseLocationLabel(b, locations).toLowerCase());
      case "priority":
        return (
          compareRushFirst(a, b) ||
          compareDueDateTime(a.dueDate, a.dueTime, b.dueDate, b.dueTime)
        );
      case "type":
        return compareCaseTypeIndicator(a, b);
      default:
        return compareEnteredDate(a, b);
    }
  });
}

/** Sort the already-filtered Due Today bucket. */
export function sortDueTodayCases(
  cases: LabCase[],
  sort: SectionSort,
  locations: Array<{ id: string; value: string; label: string }> = [],
): LabCase[] {
  return [...cases].sort((a, b) => {
    switch (sort) {
      case "due_date":
        return compareDueDateTime(a.dueDate, a.dueTime, b.dueDate, b.dueTime);
      case "case_number":
        return compareCaseNumber(a, b);
      case "patient":
        return comparePatientName(a, b);
      case "doctor":
        return (a.doctorName ?? "").toLowerCase().localeCompare((b.doctorName ?? "").toLowerCase());
      case "status":
        return caseLocationLabel(a, locations).toLowerCase().localeCompare(caseLocationLabel(b, locations).toLowerCase());
      case "priority":
        return compareRushFirst(a, b) || compareEnteredDate(a, b);
      case "type":
        return compareCaseTypeIndicator(a, b);
      default:
        return compareEnteredDate(a, b);
    }
  });
}

type RecentLabCase = LabCase & { latestEvent?: { eventType: string; summary: string } | null };

export function dashboardStepLabel(
  c: Pick<LabCase, "step" | "restorationTypes" | "restorationMaterials" | "firstRestorationSubtype">,
): string {
  return deriveCaseTypeIndicator(
    c.restorationTypes,
    c.restorationMaterials,
    c.firstRestorationSubtype,
  ) === "D"
    ? stepLabel(c.step)
    : "—";
}

function CaseRow({
  c,
  locations,
  onSelect,
  showTypeIndicator,
  showActivity,
  showStep,
}: {
  c: LabCase;
  locations?: Array<{ id: string; value: string; label: string }>;
  onSelect: (c: LabCase) => void;
  showTypeIndicator?: boolean;
  showActivity?: boolean;
  showStep?: boolean;
}) {
  const isRush = c.priority === "rush";
  const typeIndicator = showTypeIndicator ? deriveCaseTypeIndicator(c.restorationTypes, c.restorationMaterials, c.firstRestorationSubtype) : null;
  const activitySummary = showActivity ? (c as RecentLabCase).latestEvent?.summary ?? null : null;
  const step = showStep ? dashboardStepLabel(c) : null;
  const pan = c.casePanBarcode
    ? c.casePanBarcode.length > 12 ? c.casePanBarcode.slice(0, 12) + "…" : c.casePanBarcode
    : null;
  // Operational fields that do not fit the six reference columns stay readable
  // as a secondary line under the patient name.
  const details: string[] = [];
  details.push(`Entered ${formatDate(c.createdAt)}`);
  if (step && step !== "—") details.push(`Step ${step}`);
  if (pan) details.push(`Pan ${pan}`);
  if (activitySummary) details.push(activitySummary);
  return (
    <tr
      data-testid={`row-case-${c.id}`}
      className={`border-t border-border hover:bg-secondary/40 cursor-pointer align-top${isRush ? " bg-destructive/5" : ""}`}
      onClick={() => onSelect(c)}
    >
      <td className="pl-4 pr-2 py-2 font-mono text-xs">{c.caseNumber}</td>
      <td className="px-2 py-2 min-w-0">
        <span className={`block font-medium ${isRush ? "text-destructive" : ""}`}>{c.patientFirstName} {c.patientLastName}</span>
        <span className="block text-[11px] text-muted-foreground leading-snug break-words">{details.join(" · ")}</span>
      </td>
      <td className="px-2 py-2 text-muted-foreground">{c.doctorName}</td>
      <td className="px-2 py-2">
        <StatusBadge status={c.status} label={statusLabel(c.status)} />
      </td>
      <td className="px-2 py-2 text-muted-foreground">{caseLocationLabel(c, locations)}</td>
      <td className={`pl-2 ${showTypeIndicator ? "pr-2" : "pr-4"} py-2 ${isRush ? "text-destructive" : "text-muted-foreground"}`}>{formatDueDate(c.dueDate, c.dueTime)}</td>
      {showTypeIndicator && (
        <td className="pl-1 pr-3 py-2">
          {typeIndicator === "C" && (
            <span className="inline-flex items-center justify-center h-5 w-5 rounded text-[10px] font-bold bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">C</span>
          )}
          {typeIndicator === "D" && (
            <span className="inline-flex items-center justify-center h-5 w-5 rounded text-[10px] font-bold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">D</span>
          )}
          {typeIndicator === "O" && (
            <span className="inline-flex items-center justify-center h-5 w-5 rounded text-[10px] font-bold bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">O</span>
          )}
          {typeIndicator === null && <span className="text-muted-foreground">—</span>}
        </td>
      )}
    </tr>
  );
}

export function CasesTable({
  cases,
  locations,
  loading,
  emptyText,
  onSelect,
  showTypeIndicator,
  showActivity,
  showStep,
}: {
  cases: LabCase[];
  locations?: Array<{ id: string; value: string; label: string }>;
  loading: boolean;
  emptyText: string;
  onSelect: (c: LabCase) => void;
  showTypeIndicator?: boolean;
  showActivity?: boolean;
  showStep?: boolean;
}) {
  const colSpan = showTypeIndicator ? 7 : 6;
  return (
    <div className="dash-table-wrap">
      <table className="w-full text-sm table-fixed" data-testid="cases-table">
        <colgroup>
          <col style={{ width: "14%" }} />
          <col style={{ width: showTypeIndicator ? "22%" : "23%" }} />
          <col style={{ width: showTypeIndicator ? "12%" : "14%" }} />
          <col style={{ width: "16%" }} />
          <col style={{ width: showTypeIndicator ? "12%" : "15%" }} />
          <col style={{ width: "18%" }} />
          {showTypeIndicator && <col style={{ width: "6%" }} />}
        </colgroup>
        <thead>
          <tr className="text-[11px] text-muted-foreground">
            <th className="text-left font-medium pl-4 pr-2 py-2">Case #</th>
            <th className="text-left font-medium px-2 py-2">Patient</th>
            <th className="text-left font-medium px-2 py-2">Doctor</th>
            <th className="text-left font-medium px-2 py-2">Status</th>
            <th className="text-left font-medium px-2 py-2">Location</th>
            <th className={`text-left font-medium pl-2 ${showTypeIndicator ? "pr-2" : "pr-4"} py-2`}>Due date</th>
            {showTypeIndicator && <th className="text-left font-medium pl-1 pr-3 py-2">Type</th>}
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={colSpan} className="px-5 py-8 text-center text-sm text-muted-foreground">
                Loading…
              </td>
            </tr>
          )}
          {!loading && cases.length === 0 && (
            <tr>
              <td colSpan={colSpan} className="px-5 py-8 text-center text-sm text-muted-foreground">
                {emptyText}
              </td>
            </tr>
          )}
          {cases.map((c) => (
            <CaseRow
              key={c.id}
              c={c}
              locations={locations}
              onSelect={onSelect}
              showTypeIndicator={showTypeIndicator}
              showActivity={showActivity}
              showStep={showStep}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DashboardPage() {
  // Suppress browser navigation if a file is dropped outside the drop zone.
  useEffect(() => {
    function prevent(e: DragEvent) {
      e.preventDefault();
    }
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  const [showNewCase, setShowNewCase] = useState(false);
  const [selectedCase, setSelectedCase] = useState<LabCase | null>(null);
  const [recentCasesOpen, setRecentCasesOpen] = useState(true);
  const [pastDueOpen, setPastDueOpen] = useState(true);
  const [pastDueRevealed, setPastDueRevealed] = useState(false);
  const [pastDueSort, setPastDueSort] = useState<SectionSort>("due_date");

  const [dueTodayOpen, setDueTodayOpen] = useState(true);
  const [dueTomorrowOpen, setDueTomorrowOpen] = useState(true);
  const [dueTomorrowSort, setDueTomorrowSort] = useState<DueTomorrowSort>("entered");
  const [dueTodaySort, setDueTodaySort] = useState<SectionSort>("entered");
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const isAdminOrOwner = user?.role === "admin" || user?.role === "owner";
  const { openPanel: openAiPanel } = useAiPanel();

  const casesQuery = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
  });

  // Shares the ["auth","me"] cache with AppLayout. Used to detect users who
  // have signed up but are not yet a member of any active lab (e.g. a lab
  // employee waiting for an invite/approval) so we can show a waiting state
  // instead of the lab-only dashboard actions.
  const meQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
    enabled: !!user,
  });
  const hasActiveLabMembership = useMemo(
    () =>
      (meQuery.data?.memberships ?? []).some(
        (m) => m.status === "active" && m.organization?.type === "lab",
      ),
    [meQuery.data],
  );
  // Only treat as "no lab" once /auth/me has loaded, to avoid flashing the
  // waiting state for members during the initial fetch.
  const noActiveLabMembership = meQuery.isSuccess && !hasActiveLabMembership;

  // The org ID scoping the Today's Sales query — first active lab membership
  // where the user is admin or owner. null while /auth/me is loading.
  const adminOrgId = useMemo(
    () =>
      (meQuery.data?.memberships ?? []).find(
        (m) =>
          m.status === "active" &&
          m.organization?.type === "lab" &&
          (m.role === "admin" || m.role === "owner"),
      )?.organizationId ?? null,
    [meQuery.data],
  );

  const locationsQuery = useQuery<Array<{ id: string; value: string; label: string }>>({
    queryKey: ["locations", adminOrgId, "active"],
    enabled: !!adminOrgId,
    queryFn: () =>
      apiFetch<Array<{ id: string; code: string; name: string; status: string }>>(
        `/locations?organizationId=${adminOrgId}&activeOnly=true`,
      ).then((rows) => rows.map((row) => ({ id: row.id, value: row.status, label: row.name }))),
    staleTime: 60_000,
  });
  const locations = locationsQuery.data ?? [];

  const cases = casesQuery.data ?? [];
  const loading = casesQuery.isLoading;

  // Keep the drawer open while following remake links. Dashboard cases are
  // usually already in the ["cases"] cache, but older generations may fall
  // outside that list, so fetch a missing sibling before replacing the
  // current selection. A failed or out-of-scope lookup must not clear the
  // case that is currently displayed.
  async function handleOpenCaseId(id: string) {
    const found = casesQuery.data?.find((c) => c.id === id);
    if (found) {
      setSelectedCase(found);
      return;
    }
    try {
      const fresh = await apiFetch<LabCase>(`/cases/${id}`);
      setSelectedCase(fresh);
    } catch {
      /* ignore — case may be soft-deleted or out of scope */
    }
  }

  // Recomputes relative/due date labels when the local calendar day rolls over
  // (midnight timer) or the window wakes on a later day, so "Due today" and
  // "today" counts stay accurate on a long-running desktop session without a
  // manual refresh. Referenced in the date-derived memos below.
  const dayKey = useDayChange();

  interface TodaySalesData {
    totalSales: string;
    openBalance: string;
    invoices: number;
    paidInvoices: number;
    openInvoices: number;
  }

  // Polls today's invoiced sales total every 60 s. Only fires for admin/owner
  // users with an active lab membership. dayKey in the query key ensures the
  // date string is recalculated when the local calendar day rolls over.
  const todaySalesQuery = useQuery({
    queryKey: ["invoices", "reports", "sales", "today", adminOrgId, dayKey],
    queryFn: () => {
      const { dateFrom, dateTo } = getLocalDayRange();
      const params = new URLSearchParams({
        organizationId: adminOrgId!,
        dateFrom,
        dateTo,
      });
      return apiFetch<TodaySalesData>(`/invoices/reports/sales?${params}`);
    },
    enabled: isAdminOrOwner && !!adminOrgId,
    refetchInterval: 60_000,
  });

  const inProgressCount = cases.filter((c) =>
    IN_PROGRESS_STATUSES.has(c.status),
  ).length;
  const rushCount = cases.filter((c) => c.priority === "rush").length;

  const recentCasesQuery = useQuery({
    queryKey: ["cases", "recent"],
    queryFn: () => apiFetch<RecentLabCase[]>("/cases/recent"),
    staleTime: 30_000,
  });

  const pastDueCases = useMemo(() => {
    return sortPastDueCases(
      cases.filter(caseIsPastDue),
      pastDueSort,
      locations,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cases, dayKey, pastDueSort, locations]);

  const noDueDateCases = useMemo(() => {
    return [...cases]
      .filter((c) => {
        if (COMPLETED_STATUSES.has(c.status)) return false;
        return !hasUsableDueDate(c.dueDate);
      })
      .sort((a, b) =>
        (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cases, dayKey]);

  const [noDueDateOpen, setNoDueDateOpen] = useState(true);
  const dueTomorrowRef = useRef<HTMLElement>(null);
  const recentCasesRef = useRef<HTMLElement>(null);
  const pastDueRef = useRef<HTMLElement>(null);
  const dueTodayRef = useRef<HTMLElement>(null);
  const noDueDateRef = useRef<HTMLElement>(null);

  const dueTomorrowCases = useMemo(() => {
    return sortDueTomorrowCases(cases.filter(caseIsDueTomorrowFn), dueTomorrowSort, locations);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cases, dayKey, dueTomorrowSort, locations]);

  // Same query key/options as UnassignedDocumentsCard, so React Query shares
  // one request between the summary count and the card.
  const inboxLabId = user?.practiceOrganizationId ?? "";
  const inboxQuery = useListLabInboxFiles(
    { labOrganizationId: inboxLabId },
    {
      query: {
        queryKey: getListLabInboxFilesQueryKey({ labOrganizationId: inboxLabId }),
        enabled: !!inboxLabId,
        refetchInterval: 60_000,
      },
    },
  );
  const unassignedRef = useRef<HTMLDivElement>(null);

  function revealQueue(
    ref: RefObject<HTMLElement | null>,
    setOpen?: (v: boolean) => void,
  ) {
    setOpen?.(true);
    if (ref === unassignedRef) window.dispatchEvent(new Event("labtrax:reveal-unassigned"));
    setTimeout(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  const dueTodayCases = useMemo(() => {
    return sortDueTodayCases(cases.filter(caseIsDueTodayFn), dueTodaySort, locations);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cases, dayKey, dueTodaySort, locations]);

  function scrollToFirstRushSection() {
    const sections: Array<{
      ref: RefObject<HTMLElement | null>;
      hasRush: boolean;
      isOpen: boolean;
      setOpen: (v: boolean) => void;
    }> = [
      {
        ref: recentCasesRef,
        hasRush: (recentCasesQuery.data ?? []).some((c) => c.priority === "rush"),
        isOpen: recentCasesOpen,
        setOpen: setRecentCasesOpen,
      },
      {
        ref: pastDueRef,
        hasRush: pastDueCases.some((c) => c.priority === "rush"),
        isOpen: pastDueOpen,
        setOpen: setPastDueOpen,
      },
      {
        ref: dueTodayRef,
        hasRush: dueTodayCases.some((c) => c.priority === "rush"),
        isOpen: dueTodayOpen,
        setOpen: setDueTodayOpen,
      },
      {
        ref: dueTomorrowRef,
        hasRush: dueTomorrowCases.some((c) => c.priority === "rush"),
        isOpen: dueTomorrowOpen,
        setOpen: setDueTomorrowOpen,
      },
      {
        ref: noDueDateRef,
        hasRush: noDueDateCases.some((c) => c.priority === "rush"),
        isOpen: noDueDateOpen,
        setOpen: setNoDueDateOpen,
      },
    ];

    const target = sections.find((s) => s.hasRush);
    if (!target) return;
    if (!target.isOpen) target.setOpen(true);
    target.ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (noActiveLabMembership) {
    return (
      <div className="px-8 py-7 max-w-[1400px] mx-auto">
        <div className="flex items-center justify-center min-h-[60vh]">
          <JoinLabCard />
        </div>
      </div>
    );
  }

  return (
    <div className="lab-dash px-4 py-5 sm:py-7 max-w-[1400px] mx-auto bg-[hsl(214_40%_96%)] min-h-full" data-testid="dashboard-root">
      <DashboardSubscriptionBanner />
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h1 className="tracking-tight" data-testid="text-dashboard-title">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Your lab at a glance</p>
        </div>
          <button
            type="button"
            onClick={() => setShowNewCase(true)}
            data-testid="button-add-case"
            className="inline-flex items-center gap-2 h-10 px-5 rounded-md bg-[#1d5fd8] text-white text-sm font-semibold hover:bg-[#1850b8] transition-colors shadow-sm"
          >
            <Plus size={15} />
            Add case
          </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-4" data-testid="dashboard-secondary-strip">
            <button
              type="button"
              onClick={() => openAiPanel()}
              className="inline-flex items-center gap-2 h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors shadow-sm"
            >
              <Sparkles size={16} />
              LabTrax Assistant
            </button>
          {isAdminOrOwner && adminOrgId && (
            <Link
              href="/reports?tab=sales&preset=today"
              className="flex flex-col items-end gap-0.5 border border-border rounded-lg px-3 py-2 bg-card min-w-[120px] cursor-pointer hover:bg-muted/50 transition-colors no-underline"
            >
              {todaySalesQuery.isLoading ? (
                <div className="h-5 w-20 bg-muted animate-pulse rounded" />
              ) : todaySalesQuery.isError ? (
                <span className="text-sm font-semibold text-muted-foreground">—</span>
              ) : (
                <span className="text-sm font-semibold tabular-nums">
                  {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
                    Number(todaySalesQuery.data?.totalSales ?? 0),
                  )}
                </span>
              )}
              <span className="text-[10px] text-muted-foreground leading-none">Today's sales</span>
              {!todaySalesQuery.isLoading && !todaySalesQuery.isError && todaySalesQuery.dataUpdatedAt ? (
                <span className="text-[9px] text-muted-foreground/50 leading-none mt-0.5">
                  Updated {new Date(todaySalesQuery.dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              ) : null}
            </Link>
          )}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Clock size={12} />
              {inProgressCount} in progress
            </span>
            {rushCount > 0 && (
              <button
                type="button"
                className="flex items-center gap-1.5 text-destructive font-medium hover:text-destructive/80 transition-colors cursor-pointer"
                onClick={scrollToFirstRushSection}
              >
                <AlertTriangle size={12} />
                {rushCount} rush
              </button>
            )}
            {dueTomorrowCases.length > 0 && (
              <button
                type="button"
                className="flex items-center gap-1.5 hover:text-foreground transition-colors cursor-pointer"
                onClick={() => {
                  if (!dueTomorrowOpen) setDueTomorrowOpen(true);
                  dueTomorrowRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                <Calendar size={12} />
                {dueTomorrowCases.length} due tomorrow
              </button>
            )}
          </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5" data-testid="dashboard-summary">
        {([
          { id: "past-due", title: "Past due", sub: "Cases past their due date require attention.", color: "text-red-600", chip: "bg-red-100 text-red-600", border: "border-red-200", icon: AlertTriangle, loading: loading, error: casesQuery.isError, count: pastDueCases.length, retry: () => void casesQuery.refetch(), onClick: () => { setPastDueRevealed(true); revealQueue(pastDueRef, setPastDueOpen); } },
          { id: "due-today", title: "Due today", sub: "Cases due today for completion.", color: "text-blue-700", chip: "bg-blue-100 text-blue-700", border: "border-blue-200", icon: Clock, loading: loading, error: casesQuery.isError, count: dueTodayCases.length, retry: () => void casesQuery.refetch(), onClick: () => revealQueue(dueTodayRef, setDueTodayOpen) },
          { id: "unassigned", title: "Unassigned documents", sub: "Documents waiting to be assigned.", color: "text-slate-900", chip: "bg-amber-100 text-amber-600", border: "border-slate-200", icon: FileText, loading: meQuery.isLoading || (!!inboxLabId && inboxQuery.isLoading), error: meQuery.isError || inboxQuery.isError, count: inboxQuery.data?.data?.length ?? 0, retry: () => void (meQuery.isError ? meQuery.refetch() : inboxQuery.refetch()), onClick: () => revealQueue(unassignedRef) },
        ] as const).map((c) => {
          const Icon = c.icon;
          return (
            <button
              key={c.id}
              type="button"
              onClick={c.error ? c.retry : c.onClick}
              data-testid={`summary-card-${c.id}`}
              className={`flex items-center gap-3 text-left rounded-lg border ${c.border} bg-white px-4 py-3 hover:shadow-sm transition-shadow`}
            >
              <span className={`h-10 w-10 shrink-0 rounded-full inline-flex items-center justify-center ${c.chip}`}><Icon size={18} /></span>
              <span className="min-w-0 flex-1">
                <span className={`block text-sm font-semibold ${c.color}`}>
                  {c.title}{" "}
                  <span data-testid={`summary-count-${c.id}`} data-state={c.loading ? "loading" : c.error ? "error" : "ready"}>
                    {c.loading ? "…" : c.error ? "—" : c.count}
                  </span>
                </span>
                <span className="block text-xs text-slate-500 truncate">{c.error ? "Could not load. Tap to retry." : c.sub}</span>
              </span>
              <ChevronRight size={16} className="text-slate-400 shrink-0" />
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[250px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)] gap-4">
        <div className="flex flex-col gap-4 min-w-0">
          <div>
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Upload size={14} className="text-muted-foreground" />
              RX Drop Zone
            </h2>
            <DashboardDropZone />
          </div>

          <div ref={unassignedRef} data-testid="section-unassigned"><UnassignedDocumentsCard /></div>

          {/* Replaces the former Media Cleanup box. The cleanup job, history
              and settings still exist under Settings — only this dashboard
              surface changed. Available to every internal lab member, not
              just admins, because anyone can open an exception. */}
          <ExceptionCasesCard
            onSelectCase={handleOpenCaseId}
          />
        </div>

        <div className="flex flex-col gap-4 min-w-0" data-testid="dashboard-main-column">
          <section ref={recentCasesRef} data-testid="section-recent-cases" className="dash-section bg-card border border-slate-200 rounded-lg self-start w-full">
            <header
              className="flex items-center justify-between px-5 py-3.5 border-b border-border cursor-pointer select-none hover:bg-secondary/30 transition-colors rounded-t-xl"
              onClick={() => setRecentCasesOpen((v) => !v)}
            >
              <div>
                <h2 className="text-sm font-semibold">Recent cases</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Most recently active, excluding completed.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Link
                  href="/cases"
                  data-testid="link-view-all-recent"
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs font-medium text-[#1d5fd8] hover:underline"
                >
                  View all
                </Link>
                <button
                  type="button"
                  aria-label={recentCasesOpen ? "Collapse recent cases" : "Expand recent cases"}
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                  onClick={(e) => { e.stopPropagation(); setRecentCasesOpen((v) => !v); }}
                >
                  {recentCasesOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                </button>
              </div>
            </header>
            {recentCasesOpen && (
              <CasesTable
                cases={recentCasesQuery.data ?? []}
                locations={locations}
                loading={recentCasesQuery.isLoading}
                emptyText="No active cases."
                onSelect={setSelectedCase}
                showActivity
              />
            )}
          </section>

          {/* ── Past due ────────────────────────────────────────────────── */}
          {(loading || pastDueCases.length > 0 || pastDueRevealed) && (
            <section ref={pastDueRef} data-testid="section-past-due" className="dash-section dash-section-danger bg-card border border-red-300 rounded-lg">
              <header
                className="flex items-center justify-between px-5 py-3.5 border-b border-destructive/30 cursor-pointer select-none hover:bg-destructive/5 transition-colors rounded-t-xl"
                onClick={() => setPastDueOpen((v) => !v)}
              >
                <div className="flex items-center gap-2.5">
                  <AlertTriangle size={15} className="text-destructive shrink-0" />
                  <div>
                    <h2 className="text-sm font-semibold flex items-center gap-2 text-destructive">
                      Past due
                      {!loading && pastDueCases.length > 0 && (
                        <span
                          data-testid="dashboard-past-due-count"
                          className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full text-[10px] font-semibold bg-destructive text-destructive-foreground tabular-nums"
                        >
                          {pastDueCases.length}
                        </span>
                      )}
                    </h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {loading
                        ? "Loading…"
                        : pastDueCases.length === 0
                          ? "No active cases past due."
                          : `${pastDueCases.length} active case${pastDueCases.length === 1 ? "" : "s"} past due.`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Sort past due cases by ${SECTION_SORT_LABELS[pastDueSort]}`}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
                      >
                        <ChevronsUpDown size={11} />
                        Sort
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                      {(Object.keys(SECTION_SORT_LABELS) as SectionSort[]).map((key) => (
                        <DropdownMenuItem
                          key={key}
                          onSelect={() => setPastDueSort(key)}
                          className="flex items-center gap-2"
                        >
                          <span className="w-3.5 shrink-0">
                            {pastDueSort === key && <Check size={13} />}
                          </span>
                          {SECTION_SORT_LABELS[key]}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <button
                    type="button"
                    aria-label={pastDueOpen ? "Collapse past due" : "Expand past due"}
                    className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                    onClick={(e) => { e.stopPropagation(); setPastDueOpen((v) => !v); }}
                  >
                    {pastDueOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                  </button>
                </div>
              </header>
              {pastDueOpen && (
                <CasesTable
                  cases={pastDueCases}
                  locations={locations}
                  loading={loading}
                  emptyText="No active cases past due."
                  onSelect={setSelectedCase}
                  showTypeIndicator
                  showStep
                />
              )}
            </section>
          )}

          <section ref={dueTodayRef} data-testid="section-due-today" className="dash-section dash-section-info bg-card border border-blue-200 rounded-lg">
            <header
              className="flex items-center justify-between px-5 py-3.5 border-b border-border cursor-pointer select-none hover:bg-secondary/30 transition-colors rounded-t-xl"
              onClick={() => setDueTodayOpen((v) => !v)}
            >
              <div className="flex items-center gap-2.5">
                <Clock size={15} className="text-blue-700 shrink-0" />
                <div>
                  <h2 className="text-sm font-semibold flex items-center gap-2 text-blue-800">
                    Due today
                    {!loading && dueTodayCases.length > 0 && (
                      <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full text-[10px] font-semibold bg-primary text-primary-foreground tabular-nums">
                        {dueTodayCases.length}
                      </span>
                    )}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {loading
                      ? "Loading…"
                      : dueTodayCases.length === 0
                        ? "No active cases due today."
                        : `${dueTodayCases.length} active case${dueTodayCases.length === 1 ? "" : "s"} due today.`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Sort due today cases by ${SECTION_SORT_LABELS[dueTodaySort]}`}
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
                    >
                      <ChevronsUpDown size={11} />
                      Sort
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                    {(Object.keys(SECTION_SORT_LABELS) as SectionSort[]).map((key) => (
                      <DropdownMenuItem
                        key={key}
                        onSelect={() => setDueTodaySort(key)}
                        className="flex items-center gap-2"
                      >
                        <span className="w-3.5 shrink-0">
                          {dueTodaySort === key && <Check size={13} />}
                        </span>
                        {SECTION_SORT_LABELS[key]}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <button
                  type="button"
                  aria-label={dueTodayOpen ? "Collapse due today" : "Expand due today"}
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                  onClick={(e) => { e.stopPropagation(); setDueTodayOpen((v) => !v); }}
                >
                  {dueTodayOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                </button>
              </div>
            </header>
            {dueTodayOpen && (
              <CasesTable
                cases={dueTodayCases}
                  locations={locations}
                loading={loading}
                emptyText="No active cases due today."
                onSelect={setSelectedCase}
                showTypeIndicator
                showStep
              />
            )}
          </section>

          {/* ── Due tomorrow ─────────────────────────────────────────────── */}
          {(loading || dueTomorrowCases.length > 0) && (
            <section ref={dueTomorrowRef} data-testid="section-due-tomorrow" className="dash-section bg-card border border-slate-200 rounded-lg">
              <header
                className="flex items-center justify-between px-5 py-3.5 border-b border-border cursor-pointer select-none hover:bg-secondary/30 transition-colors rounded-t-xl"
                onClick={() => setDueTomorrowOpen((v) => !v)}
              >
                <div className="flex items-center gap-2.5">
                  <div>
                    <h2 className="text-sm font-semibold flex items-center gap-2">
                      Due tomorrow
                      {!loading && dueTomorrowCases.length > 0 && (
                        <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full text-[10px] font-semibold bg-secondary text-secondary-foreground tabular-nums">
                          {dueTomorrowCases.length}
                        </span>
                      )}
                    </h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {loading
                        ? "Loading…"
                        : dueTomorrowCases.length === 0
                          ? "No cases due on the next business day."
                          : `${dueTomorrowCases.length} case${dueTomorrowCases.length === 1 ? "" : "s"} due on the next business day.`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Sort due tomorrow cases by ${DUE_TOMORROW_SORT_LABELS[dueTomorrowSort]}`}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
                      >
                        <ChevronsUpDown size={11} />
                        Sort
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                      {(Object.keys(DUE_TOMORROW_SORT_LABELS) as DueTomorrowSort[]).map((key) => (
                        <DropdownMenuItem
                          key={key}
                          onSelect={() => setDueTomorrowSort(key)}
                          className="flex items-center gap-2"
                        >
                          <span className="w-3.5 shrink-0">
                            {dueTomorrowSort === key && <Check size={13} />}
                          </span>
                          {DUE_TOMORROW_SORT_LABELS[key]}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <button
                    type="button"
                    aria-label={dueTomorrowOpen ? "Collapse due tomorrow" : "Expand due tomorrow"}
                    className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                    onClick={(e) => { e.stopPropagation(); setDueTomorrowOpen((v) => !v); }}
                  >
                    {dueTomorrowOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                  </button>
                </div>
              </header>
              {dueTomorrowOpen && (
                <CasesTable
                  cases={dueTomorrowCases}
                  locations={locations}
                  loading={loading}
                  emptyText="No cases due on the next business day."
                  onSelect={setSelectedCase}
                  showTypeIndicator
                  showStep
                />
              )}
            </section>
          )}

          {/* ── No due date ─────────────────────────────────────────────── */}
          {noDueDateCases.length > 0 && (
            <section ref={noDueDateRef} data-testid="section-no-due-date" className="dash-section bg-card border border-slate-200 rounded-lg">
              <header
                className="flex items-center justify-between px-5 py-3.5 border-b border-border cursor-pointer select-none hover:bg-secondary/30 transition-colors rounded-t-xl"
                onClick={() => setNoDueDateOpen((v) => !v)}
              >
                <div className="flex items-center gap-2.5">
                  <CalendarOff size={15} className="text-muted-foreground shrink-0" />
                  <div>
                    <h2 className="text-sm font-semibold flex items-center gap-2">
                      No due date
                      <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full text-[10px] font-semibold bg-secondary text-secondary-foreground tabular-nums">
                        {noDueDateCases.length}
                      </span>
                    </h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Active cases with no expected delivery date set.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={noDueDateOpen ? "Collapse no due date" : "Expand no due date"}
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                  onClick={(e) => { e.stopPropagation(); setNoDueDateOpen((v) => !v); }}
                >
                  {noDueDateOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                </button>
              </header>
              {noDueDateOpen && (
                <CasesTable
                  cases={noDueDateCases}
                  locations={locations}
                  loading={loading}
                  emptyText="No active cases without a due date."
                  onSelect={setSelectedCase}
                />
              )}
            </section>
          )}
        </div>
      </div>

      {showNewCase && <NewCaseModal onClose={() => setShowNewCase(false)} />}
      {selectedCase && (
        <CaseDrawer
          labCase={selectedCase}
          onClose={() => setSelectedCase(null)}
          onOpenCaseId={handleOpenCaseId}
        />
      )}
    </div>
  );
}
