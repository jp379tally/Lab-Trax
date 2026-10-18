import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { LabCase } from "@/lib/types";
import { ProviderPortalLayout } from "@/components/ProviderPortalLayout";

/**
 * Provider-portal entry point (Account epic Phase 5+).
 *
 * Fetches the provider's cases once at the top level and passes them down to
 * the ProviderPortalLayout, which shares the data between the Dashboard tab
 * (case list with open balances) and the Message My Lab tab (case picker).
 */

type ProviderCase = LabCase & {
  restorationTypes?: string | null;
  providerAccountNumber?: string | null;
  labName?: string | null;
  openInvoiceAmount?: number | null;
};

export default function ProviderCasesPage() {
  const [cases, setCases] = useState<ProviderCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  async function fetchCases() {
    const requestGeneration = ++generation.current;
    setError(null);
    try {
      const rows = await apiFetch<ProviderCase[]>("/cases/provider");
      if (requestGeneration !== generation.current) return;
      setCases(rows);
    } catch (e) {
      if (requestGeneration !== generation.current) return;
      setError(e instanceof Error ? e.message : "Failed to load cases.");
    }
  }

  useEffect(() => {
    // Layout owns bootstrap and calls refresh only after a confirmed selection.
    return () => { generation.current += 1; };
  }, []);

  return (
    <ProviderPortalLayout
      cases={cases}
      casesError={error}
      onProviderSwitch={() => {
        generation.current += 1;
        setCases(null);
        setError(null);
      }}
      onRefreshCases={fetchCases}
    />
  );
}
