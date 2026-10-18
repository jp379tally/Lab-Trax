type AnalyticsData = Record<string, string | number | boolean>;
import { apiFetch } from "@/lib/api";

export type SavedCardSetupOutcome = "started" | "succeeded" | "expired";

/** Best-effort first-party aggregate; never awaited by product flows. */
export function trackSavedCardSetup(outcome: SavedCardSetupOutcome): void {
  void apiFetch("/analytics/saved-card-setup", {
    method: "POST",
    body: JSON.stringify({ outcome }),
  }).catch(() => {});
}

declare global {
  interface Window {
    umami?: {
      track(name: string, data?: AnalyticsData): void;
    };
  }
}

export function trackEvent(name: string, data?: AnalyticsData): void {
  if (typeof window === "undefined") return;

  try {
    // Replit's publishing proxy injects this tracker for published website
    // artifacts. Do not bootstrap a script or website ID in application code.
    window.umami?.track(name, data);
  } catch {
    // Analytics must never break the app.
  }
}