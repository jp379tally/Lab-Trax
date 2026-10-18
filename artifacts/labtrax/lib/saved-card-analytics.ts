import { sendJson } from "@/lib/read-api";

export type SavedCardSetupOutcome = "started" | "succeeded" | "expired";

/** Best-effort only: telemetry must never affect setup or reconciliation. */
export function trackSavedCardSetup(outcome: SavedCardSetupOutcome): void {
  void sendJson("POST", "/api/analytics/saved-card-setup", { outcome }).catch(() => {});
}