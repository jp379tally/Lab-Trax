// Mobile client for the shared Exception Cases workflow.
//
// The server (artifacts/api-server/src/routes/case-exceptions.ts) owns every
// permission decision: any active lab member may create/review, only an
// owner/admin may resolve. The helpers here never gate on their own — the
// mobile UI only hides controls the server would reject anyway.
//
// resilientFetch is a pass-through, so every body here is read as
// `body.data.X` (the server's ok() envelope), never `body.X`.
import { resilientFetch } from "@/lib/query-client";

export type CaseExceptionStatus = "active" | "resolved";

export interface CaseExceptionSummary {
  id: string;
  labOrganizationId: string;
  /** Canonical `cases.id` or the legacy `lab_cases.id` — whichever backs it. */
  caseId: string;
  caseKind: "canonical" | "legacy";
  status: CaseExceptionStatus;
  issueText: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: string;
  resolvedByUserId: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  resolutionLabLocationId: string | null;
  resolutionStatus: string | null;
  previousStatus: string | null;
  /** Current case location, returned on the lab-only exception detail. */
  currentLocationId: string | null;
  currentLocationName: string | null;
  currentLocationStatus: string | null;
}

export interface CaseExceptionQueueItem extends CaseExceptionSummary {
  caseNumber: string | null;
  patientFirstName: string | null;
  patientLastName: string | null;
  doctorName: string | null;
  caseStatus: string | null;
  mediaCount: number;
  hasMedia: boolean;
  noteCount: number;
  latestNoteText: string | null;
  latestNoteAuthorName: string | null;
  latestNoteCreatedAt: string | null;
}

export interface CaseExceptionNote {
  id: string;
  noteText: string;
  authorName: string | null;
  createdAt: string;
  attachments?: CaseExceptionAttachment[];
}

export interface CaseExceptionAttachment {
  id: string;
  fileName: string;
  fileType: string | null;
  uploaderName: string | null;
  createdAt: string;
}

export interface CaseExceptionHistoryEntry {
  type: string;
  occurredAt: string | null;
  actorName: string | null;
  detail: string | null;
}

export interface CaseExceptionDetail extends CaseExceptionSummary {
  notes: CaseExceptionNote[];
  attachments: CaseExceptionAttachment[];
  history: CaseExceptionHistoryEntry[];
  /** Server's verdict on whether this viewer may resolve (owner/admin). */
  viewerCanResolve: boolean;
}

/** Shared React Query key for the dashboard queue, so mutations can refresh it. */
export const EXCEPTION_QUEUE_QUERY_KEY = ["case-exceptions", "active"] as const;

export function exceptionDetailQueryKey(exceptionId: string) {
  return ["case-exceptions", "detail", exceptionId] as const;
}

async function readEnvelope<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    let message = "";
    try {
      const body = (await res.json()) as {
        error?: { message?: string };
        message?: string;
      };
      message = body?.error?.message ?? body?.message ?? "";
    } catch {
      // Non-JSON error body — fall through to the generic message.
    }
    const err = new Error(message || `${fallback} (${res.status})`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }
  const body = (await res.json()) as { data: T };
  return body.data;
}

export async function fetchActiveExceptions(): Promise<
  CaseExceptionQueueItem[]
> {
  const res = await resilientFetch("/api/case-exceptions/active");
  const data = await readEnvelope<{ exceptions: CaseExceptionQueueItem[] }>(
    res,
    "Could not load exception cases",
  );
  return data.exceptions ?? [];
}

export async function fetchExceptionDetail(
  exceptionId: string,
): Promise<CaseExceptionDetail> {
  const res = await resilientFetch(
    `/api/case-exceptions/${encodeURIComponent(exceptionId)}`,
  );
  return readEnvelope<CaseExceptionDetail>(
    res,
    "Could not load this exception",
  );
}

export async function createCaseException(params: {
  caseId: string;
  issueText?: string;
  /** Whether creation should move the case to the lab's On Hold location. */
  putOnHold: boolean;
  /** Required by the API when `putOnHold` is false. */
  labLocationId?: string;
}): Promise<CaseExceptionSummary> {
  const res = await resilientFetch("/api/case-exceptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      caseId: params.caseId,
      ...(params.issueText?.trim()
        ? { issueText: params.issueText.trim() }
        : {}),
      putOnHold: params.putOnHold,
      ...(!params.putOnHold && params.labLocationId
        ? { labLocationId: params.labLocationId }
        : {}),
    }),
  });
  return readEnvelope<CaseExceptionSummary>(
    res,
    "Could not create this exception case",
  );
}

export async function addExceptionNote(
  exceptionId: string,
  noteText: string,
  attachments: Array<{
    storageKey: string;
    fileName: string;
    fileType: string;
  }> = [],
): Promise<CaseExceptionNote> {
  const res = await resilientFetch(
    `/api/case-exceptions/${encodeURIComponent(exceptionId)}/notes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteText, attachments }),
    },
  );
  return readEnvelope<CaseExceptionNote>(res, "Could not add the note");
}

/**
 * Resolve an exception. The resolution note is required by the server — an
 * exception can only be closed with a record of how it was resolved. The
 * destination location stays optional.
 */
export async function resolveCaseException(params: {
  exceptionId: string;
  labLocationId?: string;
  resolutionNote: string;
}): Promise<CaseExceptionSummary> {
  const res = await resilientFetch(
    `/api/case-exceptions/${encodeURIComponent(params.exceptionId)}/resolve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(params.labLocationId
          ? { labLocationId: params.labLocationId }
          : {}),
        resolutionNote: params.resolutionNote.trim(),
      }),
    },
  );
  return readEnvelope<CaseExceptionSummary>(
    res,
    "Could not resolve this exception",
  );
}

export function exceptionPatientLabel(item: {
  patientFirstName: string | null;
  patientLastName: string | null;
  caseNumber: string | null;
}): string {
  const name =
    `${item.patientFirstName ?? ""} ${item.patientLastName ?? ""}`.trim();
  if (name) return name;
  return item.caseNumber ? `Case #${item.caseNumber}` : "Unnamed case";
}
