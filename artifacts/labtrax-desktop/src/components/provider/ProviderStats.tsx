import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

interface ProviderStatsData {
  totalCases: number;
  remakeCount: number;
  remakePct: number;
  reasonCounts: Array<{ reason: string; count: number }>;
}

export function ProviderStats() {
  const [stats, setStats] = useState<ProviderStatsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<ProviderStatsData>("/provider/stats")
      .then(setStats)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to load stats.");
      });
  }, []);

  if (error) {
    return (
      <div>
        <div className="mb-4">
          <h2 className="text-base font-semibold">Remake Stats</h2>
        </div>
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-4 py-3 text-sm"
        >
          {error}
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div>
        <div className="mb-4">
          <h2 className="text-base font-semibold">Remake Stats</h2>
        </div>
        <div className="text-sm text-muted-foreground">Loading stats…</div>
      </div>
    );
  }

  const { totalCases, remakeCount, remakePct, reasonCounts } = stats;
  const maxCount = reasonCounts.length > 0 ? reasonCounts[0].count : 1;

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-base font-semibold">Remake Stats</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Computed from your complete case history
        </p>
      </div>

      {/* Summary card */}
      <div className="rounded-md border border-border bg-card px-5 py-4 mb-6 flex items-center gap-8">
        <div className="text-center">
          <div className="text-3xl font-bold tabular-nums">{remakeCount}</div>
          <div className="text-xs text-muted-foreground mt-0.5">Total remakes</div>
        </div>
        <div className="h-10 w-px bg-border" />
        <div className="text-center">
          <div className="text-3xl font-bold tabular-nums">{remakePct}%</div>
          <div className="text-xs text-muted-foreground mt-0.5">of all cases</div>
        </div>
        <div className="h-10 w-px bg-border" />
        <div className="text-center">
          <div className="text-3xl font-bold tabular-nums">{totalCases}</div>
          <div className="text-xs text-muted-foreground mt-0.5">Total cases</div>
        </div>
      </div>

      {/* Remake reasons */}
      {remakeCount === 0 ? (
        <div className="rounded-md border border-border px-6 py-12 text-center">
          <div className="text-2xl mb-2">✅</div>
          <p className="text-sm font-medium text-muted-foreground">
            No remakes on record
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            When a case is remade, the reason and count will appear here.
          </p>
        </div>
      ) : (
        <div>
          <h3 className="text-sm font-medium mb-3">Remake reasons</h3>
          <div className="rounded-md border border-border overflow-hidden">
            {reasonCounts.map(({ reason, count }, idx) => (
              <div
                key={reason}
                className={`px-4 py-3 flex items-center gap-4 ${
                  idx > 0 ? "border-t border-border" : ""
                }`}
              >
                <div className="w-36 shrink-0 text-sm truncate" title={reason}>
                  {reason}
                </div>
                <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary/60"
                    style={{
                      width: `${Math.round((count / maxCount) * 100)}%`,
                    }}
                  />
                </div>
                <div className="w-8 text-right text-sm font-medium tabular-nums shrink-0">
                  {count}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
