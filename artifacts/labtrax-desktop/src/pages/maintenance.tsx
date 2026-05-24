import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, AlertTriangle, CheckCircle2, Clock, Info, Loader2, Play, RefreshCw, Search, XCircle } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { usePlatformAdminGate, PlatformAdminSetupNotice } from "@/lib/platform-admin-gate";
import { TriggeredByBadge } from "@/components/TriggeredByBadge";

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

interface CleanupResult {
  ok: boolean;
  runId: string;
  dryRun: boolean;
  status: string;
  errorMessage: string | null;
  scannedFiles: number;
  orphanCount: number;
  removedCount: number;
  freedBytes: number;
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

function formatDuration(start: string, end: string | null, now?: number): string {
  const endMs = end ? new Date(end).getTime() : (now ?? Date.now());
  const ms = endMs - new Date(start).getTime();
  if (ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}



type RunState =
  | { kind: "idle" }
  | { kind: "running"; dryRun: boolean }
  | { kind: "done"; result: CleanupResult }
  | { kind: "error"; message: string; status: number; dryRun: boolean };

export default function MaintenancePage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [limit, setLimit] = useState(50);
  const [runState, setRunState] = useState<RunState>({ kind: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const qc = useQueryClient();

  const runsQuery = useQuery({
    queryKey: ["admin", "cleanup-runs", limit],
    queryFn: () =>
      apiFetch<{ runs: CleanupRun[] }>(
        `/admin/cleanup/orphaned-media/runs?limit=${limit}`,
      ),
    enabled: isAdmin,
    refetchInterval: (query) => {
      const runs = query.state.data?.runs ?? [];
      return runs.some((r) => r.status === "running") ? 3000 : 10000;
    },
  });

  const hasActiveRuns =
    (runsQuery.data?.runs ?? []).some((r) => r.status === "running") ||
    runState.kind === "running";

  useEffect(() => {
    if (!hasActiveRuns) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasActiveRuns]);

  async function triggerCleanup(dryRun: boolean) {
    setRunState({ kind: "running", dryRun });
    try {
      const result = await apiFetch<CleanupResult>(
        "/admin/cleanup/orphaned-media",
        {
          method: "POST",
          body: JSON.stringify({ dryRun }),
        },
      );
      setRunState({ kind: "done", result });
      await runsQuery.refetch();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : "An unexpected error occurred.";
      const status = err instanceof ApiError ? err.status : 0;
      setRunState({ kind: "error", message, status, dryRun });
    }
  }

  const cancelMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean }>("/admin/cleanup/orphaned-media/cancel", {
        method: "POST",
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "cleanup-runs"] });
    },
    onError: () => {
      // Silently ignore cancel errors — the run may have finished already.
    },
  });

  const isRunning = runState.kind === "running";

  const runStateError =
    runState.kind === "error"
      ? new ApiError(runState.message, runState.status)
      : null;
  const gate = usePlatformAdminGate([
    runsQuery.error,
    cancelMutation.error,
    runStateError,
  ]);

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
            Manage and review orphaned file cleanup runs.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => triggerCleanup(true)}
            disabled={isRunning}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-border hover:bg-secondary transition-colors disabled:opacity-50"
            title="Scan for orphaned files without moving or deleting anything"
          >
            {isRunning && runState.dryRun ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Search size={13} />
            )}
            Dry run
          </button>
          <button
            type="button"
            onClick={() => triggerCleanup(false)}
            disabled={isRunning}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            title="Move orphaned files to the trash folder (safe — they can be recovered)"
          >
            {isRunning && !runState.dryRun ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Play size={13} />
            )}
            Run now
          </button>
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
      </div>

      <div className="mb-5 flex items-start gap-3 px-4 py-3 rounded-lg border border-border bg-secondary/40 text-sm text-muted-foreground">
        <Info size={15} className="flex-shrink-0 mt-0.5" />
        <p>
          <strong className="text-foreground font-medium">What are orphaned files?</strong>{" "}
          Orphaned files are leftover files from interrupted or failed uploads — the file reached the server but the upload didn't complete, so no case record points to it.
          Cases and their attachments are kept forever and are never flagged as orphaned.
          Cleanup moves these leftover files to a safe trash folder — they are <em>not</em> permanently deleted and can be recovered if needed.
        </p>
      </div>

      {runState.kind === "running" && (
        <div className="mb-4 flex items-center gap-2 px-4 py-3 rounded-lg border border-border bg-secondary/40 text-sm text-muted-foreground">
          <Loader2 size={15} className="animate-spin flex-shrink-0" />
          <span className="flex-1">
            {runState.dryRun
              ? "Scanning for orphaned files…"
              : "Deleting orphaned files…"}
          </span>
          <button
            type="button"
            onClick={() => cancelMutation.mutate()}
            disabled={cancelMutation.isPending}
            title="Cancel cleanup run"
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium border border-destructive/40 bg-destructive/10 hover:bg-destructive/20 text-destructive disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            <XCircle size={11} />
            {cancelMutation.isPending ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      )}

      {runState.kind === "done" && (
        <div
          className={`mb-4 px-4 py-3 rounded-lg border text-sm ${
            runState.result.status === "ok"
              ? runState.result.dryRun
                ? "border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/40"
                : "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/40"
              : runState.result.status === "cancelled"
              ? "border-border bg-secondary/40"
              : "border-destructive/30 bg-destructive/5"
          }`}
        >
          <div className="flex items-start gap-2">
            {runState.result.status === "ok" ? (
              runState.result.dryRun ? (
                <Info size={15} className="flex-shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" />
              ) : (
                <CheckCircle2 size={15} className="flex-shrink-0 mt-0.5 text-green-600 dark:text-green-400" />
              )
            ) : runState.result.status === "cancelled" ? (
              <XCircle size={15} className="flex-shrink-0 mt-0.5 text-muted-foreground" />
            ) : (
              <AlertCircle size={15} className="flex-shrink-0 mt-0.5 text-destructive" />
            )}
            <div className="flex-1 min-w-0">
              {runState.result.status === "cancelled" ? (
                <>
                  <p className="font-medium text-foreground">Run cancelled</p>
                  <p className="mt-0.5 text-muted-foreground">
                    The cleanup run was cancelled.
                    {runState.result.scannedFiles > 0 && (
                      <> {runState.result.scannedFiles.toLocaleString()} files had been scanned before it stopped.</>
                    )}
                  </p>
                </>
              ) : runState.result.dryRun ? (
                <>
                  <p className="font-medium text-blue-700 dark:text-blue-300">
                    Dry run complete
                  </p>
                  <p className="mt-0.5 text-blue-600/80 dark:text-blue-400/80">
                    Found{" "}
                    <strong>{runState.result.orphanCount.toLocaleString()}</strong>{" "}
                    orphaned{" "}
                    {runState.result.orphanCount === 1 ? "file" : "files"} out of{" "}
                    <strong>{runState.result.scannedFiles.toLocaleString()}</strong>{" "}
                    scanned
                    {runState.result.freedBytes > 0 && (
                      <>
                        {" "}—{" "}
                        <strong>{formatBytes(runState.result.freedBytes)}</strong>{" "}
                        would be freed
                      </>
                    )}
                    . No files were deleted.
                  </p>
                </>
              ) : runState.result.status === "ok" ? (
                <>
                  <p className="font-medium text-green-700 dark:text-green-300">
                    Cleanup complete
                  </p>
                  <p className="mt-0.5 text-green-600/80 dark:text-green-400/80">
                    Removed{" "}
                    <strong>{runState.result.removedCount.toLocaleString()}</strong>{" "}
                    orphaned{" "}
                    {runState.result.removedCount === 1 ? "file" : "files"}
                    {runState.result.freedBytes > 0 && (
                      <>
                        {", "}
                        freeing{" "}
                        <strong>{formatBytes(runState.result.freedBytes)}</strong>
                      </>
                    )}
                    {runState.result.removedCount > 0 && (
                      <> (moved to trash — not permanently deleted)</>
                    )}
                    .
                  </p>
                </>
              ) : (
                <>
                  <p className="font-medium text-destructive">Cleanup failed</p>
                  {runState.result.errorMessage && (
                    <p className="mt-0.5 text-destructive/80">
                      {runState.result.errorMessage}
                    </p>
                  )}
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => setRunState({ kind: "idle" })}
              className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors text-xs"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {gate.blocked && (
        <div className="mb-4">
          <PlatformAdminSetupNotice />
        </div>
      )}

      {runState.kind === "error" && !gate.blocked && (
        <div className="mb-4 flex items-start gap-2 px-4 py-3 rounded-lg border border-destructive/30 bg-destructive/5 text-sm">
          <AlertCircle size={15} className="flex-shrink-0 mt-0.5 text-destructive" />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-destructive">
              {runState.dryRun ? "Dry run failed" : "Cleanup failed"}
            </p>
            <p className="mt-0.5 text-destructive/80">{runState.message}</p>
          </div>
          <button
            type="button"
            onClick={() => setRunState({ kind: "idle" })}
            className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors text-xs"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {runsQuery.isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">Loading cleanup history…</span>
        </div>
      ) : runsQuery.isError && !gate.blocked ? (
        <div className="flex items-center gap-2 text-destructive text-sm py-10">
          <AlertCircle size={16} />
          Failed to load cleanup history.
        </div>
      ) : runsQuery.isError && gate.blocked ? null : runs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
          <Clock size={32} className="mb-3 opacity-30" />
          <p className="text-sm font-medium">No cleanup runs recorded yet.</p>
          <p className="text-xs mt-1">
            Use the buttons above or wait for the nightly scheduler.
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
                  <th
                    className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-help"
                    title="Files found on disk that are not linked to any case"
                  >
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
                  <tr
                    key={run.id}
                    className={`transition-colors ${
                      run.status === "running"
                        ? "bg-primary/5 hover:bg-primary/10"
                        : "hover:bg-secondary/30"
                    }`}
                  >
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
                      {formatDuration(run.startedAt, run.finishedAt, run.status === "running" ? now : undefined)}
                    </td>
                    <td className="px-4 py-3">
                      {run.status === "running" ? (
                        <span className="inline-flex items-center gap-1.5 text-primary">
                          <Loader2 size={13} className="animate-spin" />
                          <span className="text-xs font-medium">Running</span>
                        </span>
                      ) : run.status === "ok" ? (
                        <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                          <CheckCircle2 size={13} />
                          <span className="text-xs font-medium">OK</span>
                        </span>
                      ) : run.status === "cancelled" ? (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <XCircle size={13} />
                          <span className="text-xs font-medium">Cancelled</span>
                        </span>
                      ) : run.status === "error" && run.errorMessage?.toLowerCase().includes("interrupted") ? (
                        <div>
                          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                            <AlertTriangle size={13} />
                            <span className="text-xs font-medium">Interrupted</span>
                          </span>
                          <div className="mt-0.5 text-[11px] text-amber-600/80 dark:text-amber-400/80">
                            {run.errorMessage}
                          </div>
                        </div>
                      ) : (
                        <div>
                          <span className="inline-flex items-center gap-1 text-destructive">
                            <AlertCircle size={13} />
                            <span className="text-xs font-medium">Error</span>
                          </span>
                          {run.errorMessage && (
                            <div className="mt-0.5 text-[11px] text-destructive/70">
                              {run.errorMessage}
                            </div>
                          )}
                        </div>
                      )}
                      {run.errorCount > 0 && (
                        <div className="mt-0.5 text-[11px] text-destructive/70">
                          {run.errorCount} file error{run.errorCount !== 1 ? "s" : ""}
                        </div>
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
                      <TriggeredByBadge triggeredBy={run.triggeredBy} run={run} />
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
