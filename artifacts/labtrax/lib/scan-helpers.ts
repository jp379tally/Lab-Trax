export type ScanPhase = "camera" | "scanning" | "detected" | "review" | "form";

export type ManualEntryDecision =
  | { kind: "fire"; nextLastNonce: string | null }
  | { kind: "reset" }
  | { kind: "noop" };

/**
 * Decide what the Scan tab's focus effect should do given the current deep-link
 * params and the in-memory guard ref. Pulled out so tests can assert that:
 *   - `?mode=manual` triggers handleManualEntry exactly once per nonce
 *   - re-focusing the tab without a new nonce does NOT re-fire it
 *   - when manual mode is not requested and we're not already on the form,
 *     the tab resets to the camera phase
 */
export function decideManualEntry(input: {
  manualModeRequested: boolean;
  currentNonce: string | null;
  lastAppliedNonce: string | null;
  phase: ScanPhase;
}): ManualEntryDecision {
  const { manualModeRequested, currentNonce, lastAppliedNonce, phase } = input;
  if (manualModeRequested && lastAppliedNonce !== currentNonce) {
    return { kind: "fire", nextLastNonce: currentNonce };
  }
  if (phase !== "form") return { kind: "reset" };
  return { kind: "noop" };
}

/**
 * Guard for the one-shot auto-analyze that fires when the scanner enters the
 * review phase. The guard ref is flipped to true the first time it returns
 * true, so subsequent re-renders of the same review session do nothing.
 */
export function shouldAutoAnalyze(input: {
  cancelled: boolean;
  alreadyFired: boolean;
}): boolean {
  return !input.cancelled && !input.alreadyFired;
}

export type CloseAction =
  | { kind: "discard-review" }
  | { kind: "router-back" }
  | { kind: "router-replace"; path: "/(tabs)" };

/**
 * Decide what the camera/review close button should do. From the camera phase
 * it should return to the dashboard (router.back if possible, otherwise
 * replace to /(tabs)). From the review phase it should discard the captured
 * pages and stay on the scan tab.
 */
export function resolveCloseAction(input: {
  phase: ScanPhase;
  canGoBack: boolean;
}): CloseAction {
  if (input.phase === "review") return { kind: "discard-review" };
  if (input.canGoBack) return { kind: "router-back" };
  return { kind: "router-replace", path: "/(tabs)" };
}

/**
 * Resolve the raw URI returned by the capture cascade in handleTakePhoto.
 * The camera ref is tried first, then the web canvas fallback, then the
 * native ImagePicker fallback. If all three return null the caller must
 * surface a visible error and abort — never silently swallow.
 */
export function pickRawCaptureUri(sources: {
  cameraUri?: string | null;
  webCanvasUri?: string | null;
  imagePickerUri?: string | null;
}): { ok: true; uri: string } | { ok: false } {
  const uri = sources.cameraUri || sources.webCanvasUri || sources.imagePickerUri;
  if (uri) return { ok: true, uri };
  return { ok: false };
}
