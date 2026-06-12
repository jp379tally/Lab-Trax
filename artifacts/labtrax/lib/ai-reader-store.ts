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
  doctorName: string | null;
  patientName: string | null;
  patientInitials: string | null;
  caseType: string | null;
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
}

export interface AiReaderRestoration {
  toothNumber: string;
  restorationType: string;
  material?: string;
  shade?: string;
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
