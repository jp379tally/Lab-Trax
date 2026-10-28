// Returned-case wizard — the ordered question chain the lab is walked through
// after a case is located from a "complete family" status back to an "intake
// family" status (i.e. the case came back and work is starting again).
//
// The locate itself is applied first and is never blocked by this chain; each
// answer applies immediately and dismissing any panel skips the rest.
//
// This module holds only the pure pieces (stage order + a tiny cross-screen
// handoff store) so screens and tests can reason about the sequence without
// rendering the UI. The panels themselves live in
// components/ReturnedCaseWizard.tsx.

/** Statuses that mean "the lab was finished with this case". */
export const RETURN_COMPLETE_STATUSES = new Set(["complete", "completed", "delivered", "done"]);
/** Statuses that mean "the case is back at the front of the workflow". */
export const RETURN_INTAKE_STATUSES = new Set(["received", "intake", "new", "pending"]);

/** Removable workflow steps offered by the "Is this a removable case?" stage. */
export const RETURN_STEP_OPTIONS: { value: string; label: string }[] = [
  { value: "custom_tray", label: "Custom Tray" },
  { value: "rims_and_plates", label: "Rims and Plates" },
  { value: "wax_setup", label: "Wax Setup" },
  { value: "process", label: "Process" },
];

/**
 * True when moving `fromStatus` → `toStatus` is a "case came back" transition.
 * Both clients use the same two status families, so this is the single gate
 * for starting the wizard no matter which surface performed the locate.
 */
export function isReturnedLocate(
  fromStatus: string | null | undefined,
  toStatus: string | null | undefined,
): boolean {
  const from = (fromStatus ?? "").toLowerCase();
  const to = (toStatus ?? "").toLowerCase();
  return RETURN_COMPLETE_STATUSES.has(from) && RETURN_INTAKE_STATUSES.has(to);
}

export type ReturnedWizardStage =
  | "dueDate"
  | "rxScan"
  | "remake"
  | "removable"
  | "notes"
  | "printLabSlip"
  | "printCaseLabel";

/**
 * The questions, in the order they are asked. Every branch converges back into
 * this list — answering the remake or removable question does not end the
 * sequence early, so the closing notes/print questions are always reached.
 */
export const RETURNED_WIZARD_ORDER: readonly ReturnedWizardStage[] = [
  "dueDate",
  "rxScan",
  "remake",
  "removable",
  "notes",
  "printLabSlip",
  "printCaseLabel",
] as const;

export interface ReturnedWizardOptions {
  /**
   * Whether the viewer is allowed to change the case's workflow step. When
   * false the removable question is skipped entirely (not shown read-only).
   */
  canChangeStep: boolean;
}

function isStageAvailable(
  stage: ReturnedWizardStage,
  opts: ReturnedWizardOptions,
): boolean {
  if (stage === "removable") return opts.canChangeStep;
  return true;
}

/** The stage the wizard opens on. */
export function firstReturnedWizardStage(
  opts: ReturnedWizardOptions,
): ReturnedWizardStage | null {
  return RETURNED_WIZARD_ORDER.find((s) => isStageAvailable(s, opts)) ?? null;
}

/**
 * The stage that follows `current`, skipping any stage the viewer can't act
 * on. Returns null when the sequence is finished.
 */
export function nextReturnedWizardStage(
  current: ReturnedWizardStage,
  opts: ReturnedWizardOptions,
): ReturnedWizardStage | null {
  const idx = RETURNED_WIZARD_ORDER.indexOf(current);
  if (idx < 0) return null;
  for (let i = idx + 1; i < RETURNED_WIZARD_ORDER.length; i++) {
    const stage = RETURNED_WIZARD_ORDER[i]!;
    if (isStageAvailable(stage, opts)) return stage;
  }
  return null;
}

// ── Cross-screen handoff ─────────────────────────────────────────────────────
// The wizard always runs on the case-detail screen, but it can be *started*
// elsewhere (the Cases list / Dashboard locate sheet) and it is *suspended*
// while the user is off in the AI reader or has just been routed to a freshly
// created remake case. Those hand-offs park the next stage here; the case
// screen picks it up on focus. A module-level slot (rather than a route param)
// keeps the payload out of the URL and self-clears on consumption.

interface PendingReturnedWizard {
  caseId: string;
  stage: ReturnedWizardStage;
}

let pendingReturnedWizard: PendingReturnedWizard | null = null;

/** Park `stage` so the given case's detail screen resumes there on focus. */
export function setPendingReturnedWizard(
  caseId: string,
  stage: ReturnedWizardStage,
): void {
  pendingReturnedWizard = { caseId, stage };
}

/**
 * Take the parked stage for `caseId`, if any. Consuming clears the slot so a
 * later focus of the same screen doesn't re-open the wizard.
 */
export function consumePendingReturnedWizard(
  caseId: string,
): ReturnedWizardStage | null {
  if (!pendingReturnedWizard || pendingReturnedWizard.caseId !== caseId) return null;
  const { stage } = pendingReturnedWizard;
  pendingReturnedWizard = null;
  return stage;
}

/** Read the parked stage without consuming it (tests / diagnostics). */
export function peekPendingReturnedWizard(): PendingReturnedWizard | null {
  return pendingReturnedWizard;
}

/** Drop any parked stage — used when the user dismisses the wizard. */
export function clearPendingReturnedWizard(): void {
  pendingReturnedWizard = null;
}
