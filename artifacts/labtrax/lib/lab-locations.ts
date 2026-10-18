// Shared fetch/state machine for a lab's locate ("station") list.
//
// Mobile has three independent locate surfaces — the case-detail "Locate Case"
// card, the shared LocateCaseSheet (case list / bulk / dashboard / related
// cases), and barcode batch-locate. Each used to roll its own fetch and each
// silently substituted the built-in CASE_STATIONS list whenever the request
// was still in flight or came back empty, so a lab's real (often larger, often
// custom) location list could quietly be replaced by a shorter built-in one
// with no indication anything was amiss — the mobile/desktop mismatch.
//
// This hook keeps the three states the UI must never conflate distinct:
//   loading → the request is in flight (or the org isn't resolved yet)
//   error   → the request failed; callers show a retry affordance
//   loaded  → the server answered; `locations` is exactly what it returned
//             (possibly an empty list, which callers surface explicitly)
//
// There is deliberately no built-in fallback list here: a station list that is
// merely still loading must never be shown or selected as if it were final.
import { useCallback, useEffect, useState } from "react";
import { getJson } from "@/lib/read-api";

/** A row from `GET /api/locations` — the canonical shape desktop reads too. */
export interface LabLocation {
  id: string;
  name: string;
  code: string;
  /**
   * Mapped workflow stage — a valid case status. This (never `code`) is what
   * gets written to the case-update / bulk-status endpoints.
   */
  status: string;
  isActive: boolean;
  sortOrder: number;
}

export type LabLocationsStatus = "loading" | "error" | "loaded";

export interface UseLabLocations {
  /**
   * Active locations for the lab, in the lab's own `sortOrder` (the same order
   * desktop shows). Empty while loading and after a failure — callers key off
   * `status`, not emptiness, to tell those apart from a genuinely empty lab.
   */
  locations: LabLocation[];
  status: LabLocationsStatus;
  /** Re-issues the fetch; wired to the retry affordance on each surface. */
  retry: () => void;
}

/**
 * Loads the active locations for `orgId` (the lab that owns the case(s) being
 * located). Pass `active: false` to hold the fetch until the surface is
 * actually on screen (e.g. a bottom sheet that is currently hidden).
 */
export function useLabLocations(
  orgId: string | null | undefined,
  active = true,
): UseLabLocations {
  const [locations, setLocations] = useState<LabLocation[]>([]);
  const [status, setStatus] = useState<LabLocationsStatus>("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active) return;
    // No lab resolved yet — still "loading" rather than a misleading empty or
    // error state; the effect re-runs as soon as the caller derives one.
    if (!orgId) {
      setStatus("loading");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    getJson<LabLocation[]>(
      `/api/locations?organizationId=${encodeURIComponent(orgId)}&activeOnly=true`,
    )
      .then((rows) => {
        if (cancelled) return;
        setLocations(
          Array.isArray(rows)
            ? rows.slice().sort((a, b) => a.sortOrder - b.sortOrder)
            : [],
        );
        setStatus("loaded");
      })
      .catch(() => {
        if (cancelled) return;
        setLocations([]);
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [orgId, active, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { locations, status, retry };
}
