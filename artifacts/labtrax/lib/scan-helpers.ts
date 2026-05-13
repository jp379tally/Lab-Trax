export type ScanPhase = "camera" | "scanning" | "detected" | "review" | "form";

export function getActivityIcon(type: string): { name: string; color: string } {
  switch (type) {
    case "photo":
      return { name: "camera", color: "#8B5CF6" };
    case "scan":
      return { name: "scan", color: "#2563EB" };
    case "note":
      return { name: "document-text", color: "#F59E0B" };
    case "station_change":
      return { name: "swap-horizontal", color: "#06B6D4" };
    case "created":
      return { name: "add-circle", color: "#22C55E" };
    default:
      return { name: "ellipse", color: "#9CA3AF" };
  }
}

// Format like "Mar 15, 2:05 PM".
export function formatActivityTimestamp(ts: number): string {
  const d = new Date(ts);
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  const hours = d.getHours();
  const mins = d.getMinutes().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const h = hours % 12 || 12;
  return `${month} ${day}, ${h}:${mins} ${ampm}`;
}

export type ManualEntryDecision =
  | { kind: "fire"; nextLastNonce: string | null }
  | { kind: "reset" }
  | { kind: "noop" };

// Drives the Scan tab's focus effect: fire manual entry once per nonce,
// otherwise reset to camera (unless already on the form).
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

// One-shot guard for auto-analyze on review-phase entry.
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

// Camera/review close-button behaviour: review → discard;
// camera → router.back if possible, else replace to /(tabs).
export function resolveCloseAction(input: {
  phase: ScanPhase;
  canGoBack: boolean;
}): CloseAction {
  if (input.phase === "review") return { kind: "discard-review" };
  if (input.canGoBack) return { kind: "router-back" };
  return { kind: "router-replace", path: "/(tabs)" };
}

// handleTakePhoto capture cascade: camera → web canvas → ImagePicker.
export function pickRawCaptureUri(sources: {
  cameraUri?: string | null;
  webCanvasUri?: string | null;
  imagePickerUri?: string | null;
}): { ok: true; uri: string } | { ok: false } {
  const uri = sources.cameraUri || sources.webCanvasUri || sources.imagePickerUri;
  if (uri) return { ok: true, uri };
  return { ok: false };
}
