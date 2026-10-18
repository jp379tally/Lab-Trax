// Active-practice selection for the mobile provider portal.
//
// Every provider request is tenant-scoped by `x-provider-organization-id`, so
// the selected practice is a tenant boundary, not a display preference:
//   * the header is stamped on every request (JSON + multipart) by the shared
//     request layer, so nothing can escape the boundary;
//   * a switch clears the header and the cached provider data BEFORE the new
//     practice is confirmed, so the previous practice's rows never linger;
//   * the commit is serialized through a single reconciler with generation
//     counters, so a rapid double-switch cannot land out of order;
//   * a failed switch rolls back to the previously committed practice and
//     surfaces the error instead of leaving the portal half-switched.
//
// This mirrors the desktop ProviderPortalLayout selection reconciler; the
// shapes and failure behavior are deliberately identical.
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState } from "react-native";
import { providerStartupRequest } from "@/lib/provider-startup-request";
import { useQueryClient } from "@tanstack/react-query";
import { setProviderOrganizationId } from "@/lib/query-client";
import {
  setProviderSelectionRequiredHandler,
} from "@/lib/provider-api";

export const PROVIDER_PRACTICE_STORAGE_KEY = "@labtrax_provider_practice_v1";

export interface ProviderPractice {
  id: string;
  name: string;
  accountNumber?: string | null;
  parentLabOrganizationId?: string | null;
}

// Query-key prefixes whose data belongs to one practice. Removed (not merely
// invalidated) on a switch so a section cannot paint the old practice's rows
// while the new ones load.
export const PRACTICE_SCOPED_QUERY_PREFIXES = [
  "provider-portal",
  "provider-cases",
  "provider-case",
  "provider-billing",
  "provider-statements",
  "provider-payment-history",
  "provider-autopay-authorizations",
  "provider-autopay-authorization-prepare",
  "provider-messenger",
  "provider-stats",
] as const;

interface SelectionIntent {
  id: string;
  generation: number;
  rollback: boolean;
  errorMessage?: string;
}

export interface ProviderPracticeValue {
  practices: ProviderPractice[];
  selectedPracticeId: string | null;
  selectedPractice: ProviderPractice | null;
  /** True while the practice list (and any persisted selection) is loading. */
  isLoading: boolean;
  /** The practice list could not be loaded at all. */
  loadError: string | null;
  /** A switch failed, or the server refused the selection. */
  switchError: string | null;
  /** The user must pick before the portal can show practice-scoped data. */
  needsSelection: boolean;
  selectPractice: (id: string) => void;
  clearSwitchError: () => void;
  reload: () => void;
}

const ProviderPracticeContext = createContext<ProviderPracticeValue | null>(null);

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ProviderPracticeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const [practices, setPractices] = useState<ProviderPractice[]>([]);
  const [selectedPracticeId, setSelectedPracticeId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [selectionRequired, setSelectionRequired] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const selectionGeneration = useRef(0);
  const committedPracticeId = useRef<string | null>(null);
  const desiredSelection = useRef<SelectionIntent | null>(null);
  const confirmedServerPracticeId = useRef<string | null>(null);
  const reconciler = useRef<Promise<void> | null>(null);
  const lifecycle = useRef(0);
  const practicesRef = useRef<ProviderPractice[]>([]);

  // Drop every practice-scoped cache entry. Called before a switch commits so
  // the outgoing practice's data cannot be shown under the incoming one.
  const purgePracticeScopedCaches = useCallback(() => {
    for (const prefix of PRACTICE_SCOPED_QUERY_PREFIXES) {
      queryClient.removeQueries({ queryKey: [prefix] });
    }
  }, [queryClient]);

  // ── Serialized switch reconciler ─────────────────────────────────────────
  const startReconciler = useCallback(() => {
    if (reconciler.current) return;
    const run = (async () => {
      while (desiredSelection.current) {
        const intent = desiredSelection.current;
        const epoch = lifecycle.current;
        if (confirmedServerPracticeId.current === intent.id) {
          // A newer intent superseded this one while it was settling.
          if (desiredSelection.current?.generation !== intent.generation) continue;
          committedPracticeId.current = intent.id;
          setProviderOrganizationId(intent.id);
          setSelectedPracticeId(intent.id);
          setSwitchError(intent.errorMessage ?? null);
          if (!intent.errorMessage) setSelectionRequired(false);
          void AsyncStorage.setItem(
            PROVIDER_PRACTICE_STORAGE_KEY,
            intent.id,
          ).catch(() => {});
          desiredSelection.current = null;
          return;
        }

        try {
          await providerStartupRequest("/api/provider/selection", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ providerOrganizationId: intent.id }),
          });
          if (epoch !== lifecycle.current) continue;
          confirmedServerPracticeId.current = intent.id;
        } catch (error) {
          if (epoch !== lifecycle.current) continue;
          confirmedServerPracticeId.current = null;
          if (desiredSelection.current?.generation !== intent.generation) continue;
          const message = messageOf(error, "Could not switch practice.");
          if (intent.rollback) {
            desiredSelection.current = null;
            setSwitchError(`Could not restore the previous practice. ${message}`);
            setSelectionRequired(true);
            return;
          }
          const previousId = committedPracticeId.current;
          if (!previousId) {
            desiredSelection.current = null;
            setSwitchError(message);
            setSelectionRequired(true);
            return;
          }
          desiredSelection.current = {
            id: previousId,
            generation: ++selectionGeneration.current,
            rollback: true,
            errorMessage: message,
          };
        }
      }
    })();
    reconciler.current = run;
    void run.finally(() => {
      if (reconciler.current === run) reconciler.current = null;
      if (desiredSelection.current) startReconciler();
    });
  }, []);

  const selectPractice = useCallback(
    (id: string) => {
      if (!practicesRef.current.some((row) => row.id === id)) return;
      desiredSelection.current = {
        id,
        generation: ++selectionGeneration.current,
        rollback: false,
      };
      confirmedServerPracticeId.current = null;
      // Clear the boundary FIRST: no request may go out carrying the old
      // practice while the new one is being confirmed, and no cached row from
      // the old practice may stay on screen.
      setProviderOrganizationId(null);
      setSelectedPracticeId(null);
      purgePracticeScopedCaches();
      setSwitchError(null);
      startReconciler();
    },
    [purgePracticeScopedCaches, startReconciler],
  );

  // Bootstrap and user switches use the SAME server-confirmed reconciler.
  // Invalidate outstanding success AND failure results before a reload.
  useEffect(() => {
    let cancelled = false;
    const epoch = ++lifecycle.current;
    desiredSelection.current = null;
    committedPracticeId.current = null;
    confirmedServerPracticeId.current = null;
    setProviderOrganizationId(null);
    setSelectedPracticeId(null);
    purgePracticeScopedCaches();
    setIsLoading(true);
    setLoadError(null);
    setSwitchError(null);
    setSelectionRequired(false);
    (async () => {
      const [persisted, rows] = await Promise.all([
        AsyncStorage.getItem(PROVIDER_PRACTICE_STORAGE_KEY).catch(() => null),
        providerStartupRequest<ProviderPractice[]>("/api/provider/organizations"),
      ]);
      if (cancelled || epoch !== lifecycle.current) return;
      if (!Array.isArray(rows)) throw new Error("Could not load practices. Please try again.");
      practicesRef.current = rows;
      setPractices(rows);
      const restored = rows.find((row) => row.id === persisted)?.id;
      if (persisted && !restored) {
        void AsyncStorage.removeItem(PROVIDER_PRACTICE_STORAGE_KEY).catch(() => {});
      }
      const initialId = rows.length === 1 ? rows[0].id : restored;
      if (initialId) selectPractice(initialId);
      else setSelectionRequired(rows.length > 1);
      setIsLoading(false);
    })().catch((error) => {
      if (cancelled || epoch !== lifecycle.current) return;
      setLoadError(messageOf(error, "Could not load your practices."));
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
      lifecycle.current += 1;
      desiredSelection.current = null;
      setProviderOrganizationId(null);
    };
  }, [reloadToken, purgePracticeScopedCaches, selectPractice]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setReloadToken((token) => token + 1);
    });
    return () => subscription.remove();
  }, []);

  // A provider request answered 409 PROVIDER_ORGANIZATION_REQUIRED — the
  // server cannot resolve a practice, so show the picker rather than an error.
  // The local selection is dropped as well: whatever we believed was active is
  // not what the server will accept, and leaving it set would keep the portal
  // rendering sections whose every request fails the same way.
  useEffect(() => {
    setProviderSelectionRequiredHandler(() => {
      lifecycle.current += 1;
      committedPracticeId.current = null;
      confirmedServerPracticeId.current = null;
      desiredSelection.current = null;
      setProviderOrganizationId(null);
      setSelectedPracticeId(null);
      setSelectionRequired(true);
      purgePracticeScopedCaches();
    });
    return () => setProviderSelectionRequiredHandler(null);
  }, [purgePracticeScopedCaches]);

  // Never leave a stale practice on the request layer once the portal unmounts
  // (sign-out, or a switch back to the lab shell).
  useEffect(() => {
    return () => setProviderOrganizationId(null);
  }, []);

  const value = useMemo<ProviderPracticeValue>(() => {
    const selectedPractice =
      practices.find((row) => row.id === selectedPracticeId) ?? null;
    return {
      practices,
      selectedPracticeId,
      selectedPractice,
      isLoading,
      loadError,
      switchError,
      needsSelection:
        !isLoading && !selectedPracticeId && (selectionRequired || practices.length > 1),
      selectPractice,
      clearSwitchError: () => setSwitchError(null),
      reload: () => setReloadToken((token) => token + 1),
    };
  }, [
    practices,
    selectedPracticeId,
    isLoading,
    loadError,
    switchError,
    selectionRequired,
    selectPractice,
  ]);

  return (
    <ProviderPracticeContext.Provider value={value}>
      {children}
    </ProviderPracticeContext.Provider>
  );
}

export function useProviderPractice(): ProviderPracticeValue {
  const value = useContext(ProviderPracticeContext);
  if (!value) {
    throw new Error(
      "useProviderPractice must be used inside <ProviderPracticeProvider>.",
    );
  }
  return value;
}
