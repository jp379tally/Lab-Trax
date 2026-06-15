import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { LabCase } from "@/lib/types";

/**
 * Minimal provider-portal case list (Account epic Phase 5).
 *
 * Shown to provider-type users instead of the lab-facing app shell. Renders a
 * read-only list of the provider's own assigned cases, served by the strictly
 * provider-scoped GET /cases/provider endpoint. Intentionally minimal —
 * advanced provider features and cross-platform parity are later phases.
 */
function statusLabel(status: string): string {
  return status
    .split(/[_\s]+/)
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(" ");
}

export default function ProviderCasesPage() {
  const { user, logout } = useAuth();
  const [cases, setCases] = useState<LabCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await apiFetch<LabCase[]>("/cases/provider");
        if (!cancelled) setCases(rows);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load cases.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">My Cases</h1>
          <p className="text-xs text-muted-foreground">
            {user?.firstName || user?.username || "Provider"}
            {user?.platformAccountNumber
              ? ` · ${user.platformAccountNumber}`
              : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void logout()}
          className="text-sm px-3 py-1.5 rounded-md border border-border hover:bg-muted"
        >
          Sign out
        </button>
      </header>

      <main className="px-6 py-6 max-w-5xl mx-auto">
        {error ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-4 py-3 text-sm"
          >
            {error}
          </div>
        ) : cases === null ? (
          <div className="text-sm text-muted-foreground">Loading cases…</div>
        ) : cases.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            You have no assigned cases yet.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Case #</th>
                  <th className="px-4 py-2 font-medium">Patient</th>
                  <th className="px-4 py-2 font-medium">Restorations</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Due</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="px-4 py-2 font-mono text-xs">
                      {c.caseNumber}
                    </td>
                    <td className="px-4 py-2">
                      {c.patientFirstName || c.patientLastName
                        ? `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim()
                        : (c.patientInitials ?? "—")}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {c.restorationTypes ?? "—"}
                    </td>
                    <td className="px-4 py-2">{statusLabel(c.status)}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {c.dueDate
                        ? new Date(c.dueDate).toLocaleDateString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
