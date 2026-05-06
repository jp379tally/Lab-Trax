import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Clock, Loader2, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

interface CleanupRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  dryRun: boolean;
  status: string;
  errorMessage: string | null;
  scannedFiles: number;
  referencedFiles: number;
  orphanCount: number;
  removedCount: number;
  freedBytes: number;
  errorCount: number;
  triggeredBy: string;
  createdAt: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val % 1 === 0 ? val : val.toFixed(1)} ${units[i]}`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function TriggeredByBadge({ value }: { value: string }) {
  const isScheduler = value === "scheduler";
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${
        isScheduler
          ? "bg-secondary text-muted-foreground"
          : "bg-primary/10 text-primary"
      }`}
    >
      {isScheduler ? "Scheduled" : value.replace(/^admin:/, "")}
    </span>
  );
}

export default function MaintenancePage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [limit, setLimit] = useState(50);

  const runsQuery = useQuery({
    queryKey: ["admin", "cleanup-runs", limit],
    queryFn: () =>
      apiFetch<{ runs: CleanupRun[] }>(
        `/admin/cleanup/orphaned-media/runs?limit=${limit}`,
      ),
    enabled: isAdmin,
  });

  if (!isAdmin) {
    return (
      <div className="px-8 py-7 max-w-[900px] mx-auto">
        <p className="text-sm text-muted-foreground">
          This page is only available to admins.
        </p>
      </div>
    );
  }

  const runs = runsQuery.data?.runs ?? [];

  return (
    <div className="px-8 py-7 max-w-[1000px] mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Maintenance</h1>
          <p className="text-sm text-muted-foreground mt-1">
            History of nightly orphaned file cleanup runs.
          </p>
        </div>
        <button
          type="button"
          onClick={() => runsQuery.refetch()}
          disabled={runsQuery.isFetching}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-border hover:bg-secondary transition-colors disabled:opacity-50"
        >
          <RefreshCw
            size={13}
            className={runsQuery.isFetching ? "animate-spin" : ""}
          />
          Refresh
        </button>
      </div>

      {runsQuery.isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">Loading cleanup history…</span>
        </div>
      ) : runsQuery.isError ? (
        <div className="flex items-center gap-2 text-destructive text-sm py-10">
          <AlertCircle size={16} />
          Failed to load cleanup history.
        </div>
      ) : runs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
          <Clock size={32} className="mb-3 opacity-30" />
          <p className="text-sm font-medium">No cleanup runs recorded yet.</p>
          <p className="text-xs mt-1">
            The nightly scheduler will record runs here automatically.
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/50">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Started
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Duration
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Status
                  </th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Scanned
                  </th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Orphans
                  </th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Removed
                  </th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Freed
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Triggered by
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runs.map((run) => (
                  <tr key={run.id} className="hover:bg-secondary/30 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="font-medium tabular-nums">
                        {formatDateTime(run.startedAt)}
                      </div>
                      {run.dryRun && (
                        <span className="text-[10px] text-muted-foreground">
                          dry run
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap tabular-nums text-muted-foreground">
                      {formatDuration(run.startedAt, run.finishedAt)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {run.status === "ok" ? (
                        <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                          <CheckCircle2 size={13} />
                          <span className="text-xs font-medium">OK</span>
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 text-destructive cursor-help"
                          title={run.errorMessage ?? "Unknown error"}
                        >
                          <AlertCircle size={13} />
                          <span className="text-xs font-medium">Error</span>
                        </span>
                      )}
                      {run.errorCount > 0 && (
                        <span className="ml-2 text-[11px] text-destructive/70">
                          ({run.errorCount} file error{run.errorCount !== 1 ? "s" : ""})
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {run.scannedFiles.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {run.orphanCount > 0 ? (
                        <span className="text-amber-600 dark:text-amber-400 font-medium">
                          {run.orphanCount.toLocaleString()}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {run.removedCount > 0 ? (
                        <span className="font-medium">
                          {run.removedCount.toLocaleString()}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {run.freedBytes > 0 ? (
                        <span className="font-medium text-green-600 dark:text-green-400">
                          {formatBytes(run.freedBytes)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <TriggeredByBadge value={run.triggeredBy} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {runs.length >= limit && (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={() => setLimit((prev) => prev + 50)}
                className="px-4 py-2 text-sm border border-border rounded-md hover:bg-secondary transition-colors"
              >
                Load more
              </button>
            </div>
          )}

          <p className="mt-3 text-xs text-muted-foreground text-right">
            Showing {runs.length} run{runs.length !== 1 ? "s" : ""}
          </p>
        </>
      )}
    </div>
  );
}
