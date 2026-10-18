// In-memory session store for the AI Reader intake flow.
//
// Screens share state through this module rather than router params because
// base64-encoded page images are far too large to serialize into URL params.
// The store is cleared when a new session starts (via clearAiReaderSession()
// called from the dashboard "Scan Rx" button action) and can be read by any
// subsequent screen without re-fetching.
//
// IMPORTANT: clearAiReaderSession() must only be called at the start of a
// brand-new intake flow (e.g., from dashboard "Scan Rx"). The capture screen
// re-uses the existing session when the user navigates back from review to
// add more pages.

export interface CapturedPage {
  uri: string;
  base64: string;
}

export interface ExtractedRx {
  toothAssignments?: unknown;
  doctorName: string | null;
  patientName: string | null;
  patientInitials: string | null;
  caseType: string | null;
  arch?: "upper" | "lower" | "both" | null;
  toothIndices: string | null;
  shade: string | null;
  material: string | null;
  dueDate: string | null;
  isRush: boolean | null;
  notes: string | null;
  practiceName: string | null;
  practiceAddress: string | null;
  practicePhone: string | null;
  confidence: number | null;
  step: "custom_tray" | "rims_and_plates" | "wax_setup" | "process" | null;
  /** Gingival/tissue shade for removable cases — null for non-removable or when not on the Rx. */
  gingivialShade: string | null;
}

export interface AiReaderRestoration {
  toothNumber: string;
  restorationType: string;
  material?: string;
  shade?: string;
}

/**
 * Fields the user has manually edited on the extracted.tsx form.
 * When present (even as an empty string), the override takes precedence
 * over whatever the AI extracted, so re-scanning cannot silently overwrite
 * an intentional edit.
 */
export interface AiReaderUserOverrides {
  shade?: string;
  material?: string;
  caseType?: string;
  arch?: "upper" | "lower" | "both" | null;
  toothIndices?: string;
  /** Per-tooth assignments explicitly confirmed by the operator. */
  assignmentRoles?: Record<string, "Crown" | "Pontic">;
  assignmentOverridesManual?: boolean;
  assignmentValues?: Record<string, { material?: string; shade?: string; restorationSubtype?: string }>;
  bridgeConnectors?: string;
  doctorName?: string;
  patientFirst?: string;
  patientLast?: string;
  dueDate?: string;
  notes?: string;
  priority?: "normal" | "rush";
  step?: "custom_tray" | "rims_and_plates" | "wax_setup" | "process" | null;
  gingivialShade?: string;
}

export interface AiReaderSession {
  pages: CapturedPage[];
  extracted: ExtractedRx | null;
  caseId: string | null;
  caseNumber: string | null;
  /** Final restorations as submitted to the server (for label printing). */
  restorations: AiReaderRestoration[];
  /** Lab org ID at time of case creation (for fetching org print template). */
  labOrgId: string | null;
  /** Lab name at time of case creation (for label printing). */
  labName: string | null;
  /** Provider/doctor name as submitted (for label printing). */
  doctorName: string | null;
  /** Patient full name as submitted (for label printing). */
  patientName: string | null;
  /** Due date ISO string as submitted (for label printing). */
  dueDate: string | null;
  /** Gingival shade as submitted (for label printing — removable cases only). */
  gingivialShade: string | null;
  /**
   * Fields the user has explicitly edited on the extracted form.
   * These survive a re-scan (setAiReaderSession({ extracted: … })) so the AI
   * never silently overwrites a value the user intentionally changed.
   * Cleared only by clearAiReaderSession() (i.e. a brand-new intake flow).
   */
  userOverrides: AiReaderUserOverrides;
  /**
   * Attach-to-existing-case mode. When set, the reader analyses the captured
   * pages and uploads them to THIS case as attachments instead of walking on
   * to the create-a-new-case form. Set by the returned-case wizard before it
   * pushes the capture screen; cleared by clearAiReaderSession() so a normal
   * "Scan Rx" intake never inherits it.
   */
  attachToCaseId: string | null;
  /** Stable identity for an attach-to-existing scan across retry attempts. */
  rxSubmissionId: string | null;
  /** Page submission identities already registered for this scan. */
  attachedRxPageIds: string[];
}

let _session: AiReaderSession = _emptySession();

function _emptySession(): AiReaderSession {
  return {
    pages: [],
    extracted: null,
    caseId: null,
    caseNumber: null,
    restorations: [],
    labOrgId: null,
    labName: null,
    doctorName: null,
    patientName: null,
    dueDate: null,
    gingivialShade: null,
    userOverrides: {},
    attachToCaseId: null,
    rxSubmissionId: null,
    attachedRxPageIds: [],
  };
}

export function getAiReaderSession(): AiReaderSession {
  return _session;
}

export function setAiReaderSession(patch: Partial<AiReaderSession>): void {
  _session = { ..._session, ...patch };
}

export function clearAiReaderSession(): void {
  _session = _emptySession();
}
