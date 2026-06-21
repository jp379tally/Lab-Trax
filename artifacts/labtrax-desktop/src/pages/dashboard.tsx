import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  HardDrive,
  Loader2,
  Play,
  Plus,
  Sparkles,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";
import { useAiPanel } from "@/lib/ai-panel-context";
import { usePlatformAdminGate, PlatformAdminSetupNotice } from "@/lib/platform-admin-gate";
import { formatNextCleanupTime } from "@/lib/cleanup-schedule";
import { TriggeredByBadge } from "@/components/TriggeredByBadge";
import { formatNextBackupTime } from "@/lib/backup-schedule";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LabCase } from "@/lib/types";
import { formatDate, formatDateTime, relativeTime } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import { DashboardDropZone } from "@/components/DashboardDropZone";
import { NewCaseModal, CaseDrawer } from "./cases";
import { useAuth } from "@/lib/auth-context";
import { DashboardSubscriptionBanner } from "@/components/TrialBanner";

interface MediaCleanupRun {
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
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

interface CleanupScheduleSettings {
  hourUtc: number;
}

interface BackupScheduleSettings {
  hourUtc: number;
  lastSuccessfulBackupAt?: string | null;
  staleAfterDays?: number;
}

const DEFAULT_BACKUP_STALE_DAYS = 7;

function isBackupStale(lastSuccessfulBackupAt: string | null | undefined, staleDays: number = DEFAULT_BACKUP_STALE_DAYS): boolean {
  if (!lastSuccessfulBackupAt) return true;
  const last = new Date(lastSuccessfulBackupAt).getTime();
  if (Number.isNaN(last)) return true;
  return Date.now() - last > staleDays * 24 * 60 * 60 * 1000;
}

interface RunNowResult {
  ok: boolean;
  status: string;
  errorMessage: string | null;
  removedCount: number;
  freedBytes: number;
}

type CleanupStage = "idle" | "scanning" | "checking-references" | "removing" | "finishing";

interface CleanupProgress {
  stage: CleanupStage;
  scannedFiles?: number;
  orphanCount?: number;
}

function stageBadgeLabel(progress: CleanupProgress | null | undefined): string {
  if (!progress || progress.stage === "idle") return "Running\u2026";
  switch (progress.stage) {
    case "scanning":           return "Scanning\u2026";
    case "checking-references": return "Checking\u2026";
    case "removing":           return "Removing\u2026";
    case "finishing":          return "Finishing\u2026";
    default:                   return "Running\u2026";
  }
}

const CLEANUP_STAGES: CleanupStage[] = ["scanning", "checking-references", "removing", "finishing"];
const STAGE_LABELS: Record<CleanupStage, string> = {
  idle: "Starting",
  scanning: "Scan",
  "checking-references": "Check",
  removing: "Remove",
  finishing: "Finish",
};

function stageIndex(stage: CleanupStage): number {
  const idx = CLEANUP_STAGES.indexOf(stage);
  return idx === -1 ? -1 : idx;
}

function CleanupProgressBar({ progress }: { progress: CleanupProgress | null | undefined }) {
  const stage = progress?.stage ?? "idle";
  const activeIdx = stageIndex(stage);

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {CLEANUP_STAGES.map((s, i) => {
          const isCompleted = activeIdx > i;
          const isActive = activeIdx === i;
          const isPending = activeIdx < i && activeIdx !== -1;
          const isIndeterminate = activeIdx === -1;
          return (
            <div key={s} className="flex-1 flex flex-col gap-1 items-start">
              <div
                className={`w-full h-1.5 rounded-full overflow-hidden ${
                  isCompleted
                    ? "bg-primary"
                    : isActive
                    ? "bg-primary/30"
                    : "bg-border"
                }`}
              >
                {(isActive || isIndeterminate) && (
                  <div
                    className="h-full rounded-full bg-primary origin-left animate-[cleanup-pulse_1.4s_ease-in-out_infinite]"
                    style={{ width: "60%" }}
                  />
                )}
                {isCompleted && <div className="h-full w-full bg-primary" />}
              </div>
              <span
                className={`text-[10px] leading-none font-medium transition-colors ${
                  isCompleted
                    ? "text-primary"
                    : isActive || isIndeterminate
                    ? "text-foreground"
                    : isPending
                    ? "text-muted-foreground/50"
                    : "text-muted-foreground/40"
                }`}
              >
                {STAGE_LABELS[s]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function stageDetailLabel(progress: CleanupProgress | null | undefined): string {
  if (!progress || progress.stage === "idle") return "Starting\u2026";
  switch (progress.stage) {
    case "scanning":
      return "Scanning files on disk\u2026";
    case "checking-references":
      return progress.scannedFiles != null
        ? `Checking ${progress.scannedFiles.toLocaleString()} file${progress.scannedFiles === 1 ? "" : "s"} against the database\u2026`
        : "Checking references in database\u2026";
    case "removing":
      return progress.orphanCount != null && progress.orphanCount > 0
        ? `Removing ${progress.orphanCount.toLocaleString()} orphan${progress.orphanCount === 1 ? "" : "s"}\u2026`
        : "No orphans found — finishing\u2026";
    case "finishing":
      return "Saving results\u2026";
    default:
      return "Running\u2026";
  }
}

function ElapsedTimer({ startedAt }: { startedAt: string | null }) {
  const [elapsed, setElapsed] = useState<number | null>(() => {
    if (!startedAt) return null;
    return Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  });

  useEffect(() => {
    if (!startedAt) {
      setElapsed(null);
      return;
    }
    const start = new Date(startedAt).getTime();
    setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    const id = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (elapsed === null) return null;

  const display =
    elapsed < 60
      ? `${elapsed} s`
      : elapsed < 3600
      ? `${Math.floor(elapsed / 60)} m ${elapsed % 60} s`
      : `${Math.floor(elapsed / 3600)} h ${Math.floor((elapsed % 3600) / 60)} m`;

  return (
    <p className="text-[11px] text-muted-foreground/70">Running for {display}</p>
  );
}

type ManualRunFeedback =
  | { kind: "success"; removedCount: number; freedBytes: number }
  | { kind: "error"; message: string };


const HISTORY_LIMIT = 20;


function RunHistoryTable({ runs }: { runs: MediaCleanupRun[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-muted-foreground border-b border-border/60">
            <th className="text-left font-medium py-2 pr-3 whitespace-nowrap">When</th>
            <th className="text-left font-medium py-2 pr-3 whitespace-nowrap">Source</th>
            <th className="text-right font-medium py-2 pr-3 whitespace-nowrap">Removed</th>
            <th className="text-right font-medium py-2 pr-3 whitespace-nowrap">Freed</th>
            <th className="text-left font-medium py-2 whitespace-nowrap">Status</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const isError = run.status === "error";
            const isRunningRow = run.status === "running";
            const isCancelled = run.status === "cancelled";
            const isDash = isRunningRow || isCancelled;
            return (
              <tr key={run.id} className="border-b border-border/40 last:border-0 hover:bg-secondary/30">
                <td className="py-1.5 pr-3 text-muted-foreground whitespace-nowrap" title={formatDateTime(run.startedAt)}>
                  {relativeTime(run.startedAt)}
                </td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <TriggeredByBadge triggeredBy={run.triggeredBy} run={run} />
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {isDash ? "—" : run.removedCount.toLocaleString()}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                  {isDash ? "—" : formatBytes(run.freedBytes)}
                </td>
                <td className="py-1.5">
                  {isRunningRow ? (
                    <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                      <Loader2 size={11} className="animate-spin" />
                      Running
                    </span>
                  ) : isCancelled ? (
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <XCircle size={11} />
                      Cancelled
                    </span>
                  ) : isError && run.errorMessage?.toLowerCase().includes("interrupted") ? (
                    <div>
                      <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                        <AlertTriangle size={11} />
                        <span>Interrupted</span>
                      </span>
                      <div className="mt-0.5 text-[10px] text-amber-600/80 dark:text-amber-400/80 leading-tight">
                        {run.errorMessage}
                      </div>
                    </div>
                  ) : isError ? (
                    <div>
                      <span className="inline-flex items-center gap-1 text-destructive">
                        <AlertCircle size={11} />
                        <span>Error</span>
                      </span>
                      {run.errorMessage && (
                        <div className="mt-0.5 text-[10px] text-destructive/70 leading-tight">
                          {run.errorMessage}
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                      <CheckCircle2 size={11} />
                      OK
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MediaCleanupCard() {
  const qc = useQueryClient();
  const [feedback, setFeedback] = useState<ManualRunFeedback | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleDismiss = () => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    dismissTimer.current = setTimeout(() => setFeedback(null), 6000);
  };

  const dismissFeedback = () => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    setFeedback(null);
  };

  useEffect(() => () => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
  }, []);

  const runsQuery = useQuery({
    queryKey: ["admin", "cleanup", "runs", HISTORY_LIMIT],
    queryFn: () =>
      apiFetch<{ runs: MediaCleanupRun[] }>(
        `/admin/cleanup/orphaned-media/runs?limit=${HISTORY_LIMIT}`,
      ),
    refetchInterval: (query) => {
      const latest = query.state.data?.runs?.[0];
      return latest?.status === "running" ? 5_000 : 5 * 60 * 1000;
    },
  });

  const scheduleQuery = useQuery({
    queryKey: ["admin", "cleanup-schedule"],
    queryFn: () => apiFetch<CleanupScheduleSettings>("/admin/settings/cleanup-schedule"),
    staleTime: 5 * 60 * 1000,
  });

  const runNowMutation = useMutation({
    mutationFn: () =>
      apiFetch<RunNowResult>("/admin/cleanup/orphaned-media/run", {
        method: "POST",
      }),
    onMutate: () => {
      dismissFeedback();
    },
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["admin", "cleanup", "runs"] });
      if (data.status === "cancelled") {
        setFeedback({ kind: "error", message: "Cleanup run was cancelled." });
        scheduleDismiss();
      } else if (data.status === "error" || !data.ok) {
        setFeedback({
          kind: "error",
          message: data.errorMessage ?? "Cleanup run failed.",
        });
        scheduleDismiss();
      } else {
        setFeedback({
          kind: "success",
          removedCount: data.removedCount,
          freedBytes: data.freedBytes,
        });
        scheduleDismiss();
      }
    },
    onError: (err: Error) => {
      setFeedback({
        kind: "error",
        message: err.message || "Cleanup run failed.",
      });
      scheduleDismiss();
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean; message: string }>("/admin/cleanup/orphaned-media/cancel", {
        method: "POST",
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "cleanup"] });
    },
    onError: () => {
      // Silently ignore cancel errors — the run may have finished already.
    },
  });

  const backupScheduleQuery = useQuery({
    queryKey: ["admin", "backup-schedule"],
    queryFn: () => apiFetch<BackupScheduleSettings>("/admin/settings/backup-schedule"),
    staleTime: 5 * 60 * 1000,
  });

  const allRuns = runsQuery.data?.runs ?? [];
  const lastRun = allRuns[0] ?? null;
  const isRunningFromQuery = lastRun?.status === "running";

  const cleanupStatusQuery = useQuery({
    queryKey: ["admin", "cleanup", "status"],
    queryFn: () => apiFetch<CleanupProgress>("/admin/cleanup/orphaned-media/status"),
    refetchInterval: (query) => {
      const stage = query.state.data?.stage;
      return runNowMutation.isPending || isRunningFromQuery || (stage && stage !== "idle")
        ? 1500
        : 5_000;
    },
  });

  const isRunningFromProgress =
    cleanupStatusQuery.data != null && cleanupStatusQuery.data.stage !== "idle";

  const isAlreadyRunning =
    runNowMutation.error instanceof ApiError && runNowMutation.error.status === 409;

  const hasError = lastRun?.status === "error";
  const nextRunLabel =
    scheduleQuery.data != null ? formatNextCleanupTime(scheduleQuery.data.hourUtc) : null;
  const isRunning = runNowMutation.isPending || isRunningFromQuery || isRunningFromProgress;

  useEffect(() => {
    if (!isRunning) setShowCancelConfirm(false);
  }, [isRunning]);

  const nextBackupLabel =
    backupScheduleQuery.data != null ? formatNextBackupTime(backupScheduleQuery.data.hourUtc) : null;

  const gate = usePlatformAdminGate([
    runsQuery.error,
    scheduleQuery.error,
    backupScheduleQuery.error,
    cleanupStatusQuery.error,
    runNowMutation.error,
  ]);

  return (
    <section className="bg-card border border-border rounded-xl">
      <header className="flex items-center gap-2 px-5 py-3.5 border-b border-border">
        <HardDrive size={14} className="text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold">Media Cleanup</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Last nightly orphaned-media run
          </p>
        </div>
        {isRunning ? (
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium border border-border bg-secondary text-foreground opacity-60">
              <Loader2 size={11} className="animate-spin" />
              {stageBadgeLabel(cleanupStatusQuery.data)}
            </span>
            <button
              type="button"
              onClick={() => setShowCancelConfirm(true)}
              disabled={cancelMutation.isPending}
              title="Cancel cleanup run"
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium border border-destructive/40 bg-destructive/10 hover:bg-destructive/20 text-destructive disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              <XCircle size={11} />
              {cancelMutation.isPending ? "Cancelling…" : "Cancel"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => runNowMutation.mutate()}
            title="Run cleanup now"
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium border border-border bg-secondary hover:bg-secondary/80 text-foreground transition-colors shrink-0"
          >
            <Play size={11} />
            Run now
          </button>
        )}
      </header>

      <div className="px-5 py-4 space-y-3 text-sm">
        {showCancelConfirm && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3 space-y-2.5">
            <div className="flex items-start gap-2">
              <AlertTriangle size={13} className="shrink-0 mt-0.5 text-destructive" />
              <div className="space-y-0.5">
                <p className="text-xs font-medium text-destructive">
                  {cleanupStatusQuery.data?.stage === "removing"
                    ? "Cancel while removing?"
                    : "Cancel this cleanup run?"}
                </p>
                <p className="text-xs text-muted-foreground leading-snug">
                  {cleanupStatusQuery.data?.stage === "removing"
                    ? "Files are being deleted right now. Stopping mid-run may leave some orphans removed and others not — any files already removed will not be restored."
                    : "Are you sure you want to stop this run? Any files already removed will not be restored."}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 justify-end">
              <button
                type="button"
                onClick={() => setShowCancelConfirm(false)}
                className="inline-flex items-center h-6 px-2.5 rounded text-xs font-medium border border-border bg-secondary hover:bg-secondary/80 text-foreground transition-colors"
              >
                Keep running
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCancelConfirm(false);
                  cancelMutation.mutate();
                }}
                disabled={cancelMutation.isPending}
                className="inline-flex items-center h-6 px-2.5 rounded text-xs font-medium border border-destructive/40 bg-destructive/10 hover:bg-destructive/20 text-destructive disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                {cancelMutation.isPending ? "Cancelling…" : "Cancel run"}
              </button>
            </div>
          </div>
        )}

        {feedback && (
          <div
            className={`flex items-start gap-2 rounded-md border px-3 py-2.5 text-xs ${
              feedback.kind === "success"
                ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400"
                : "border-destructive/30 bg-destructive/5 text-destructive"
            }`}
          >
            {feedback.kind === "success" ? (
              <CheckCircle2 size={13} className="shrink-0 mt-px" />
            ) : (
              <AlertCircle size={13} className="shrink-0 mt-px" />
            )}
            <span className="flex-1">
              {feedback.kind === "success"
                ? feedback.removedCount === 0
                  ? "No orphaned files found — nothing to remove."
                  : `Removed ${feedback.removedCount} orphan${feedback.removedCount === 1 ? "" : "s"}, freed ${formatBytes(feedback.freedBytes)}.`
                : feedback.message}
            </span>
            <button
              type="button"
              onClick={dismissFeedback}
              className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
              aria-label="Dismiss"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {isRunning && (
          <div className="space-y-2">
            <CleanupProgressBar progress={cleanupStatusQuery.data} />
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 size={11} className="animate-spin shrink-0" />
              <span>{stageDetailLabel(cleanupStatusQuery.data)}</span>
            </div>
            {isRunningFromQuery && (() => {
              return (
                <div className="flex items-center gap-2">
                  <ElapsedTimer startedAt={lastRun.startedAt} />
                  {lastRun.triggeredBy && (
                    <TriggeredByBadge triggeredBy={lastRun.triggeredBy} run={lastRun} />
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {gate.blocked && <PlatformAdminSetupNotice />}

        {runsQuery.isLoading && !gate.blocked && (
          <p className="text-muted-foreground text-xs">Loading…</p>
        )}

        {runsQuery.isError && !gate.blocked && (
          <div className="flex items-center gap-2 text-destructive text-xs">
            <AlertCircle size={13} className="shrink-0" />
            Failed to load cleanup history.
          </div>
        )}

        {isAlreadyRunning && (
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 text-xs">
            <AlertTriangle size={13} className="shrink-0" />
            Cleanup already in progress — please wait for it to finish.
          </div>
        )}

        {runNowMutation.isError && !isAlreadyRunning && !gate.blocked && (
          <div className="flex items-center gap-2 text-destructive text-xs">
            <AlertCircle size={13} className="shrink-0" />
            {runNowMutation.error instanceof Error
              ? runNowMutation.error.message
              : "Failed to start cleanup."}
          </div>
        )}

        {!runsQuery.isLoading && !runsQuery.isError && !lastRun && (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <Clock size={13} />
            Not yet run — no cleanup has completed yet.
          </div>
        )}

        {lastRun && !isRunningFromQuery && !isRunningFromProgress && (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {hasError ? (
                <AlertCircle size={13} className="text-destructive shrink-0" />
              ) : (
                <CheckCircle2 size={13} className="text-green-600 dark:text-green-400 shrink-0" />
              )}
              <span>
                Ran {relativeTime(lastRun.startedAt)}{" "}
                <span className="text-foreground/50">·</span>{" "}
                {formatDateTime(lastRun.startedAt)}
              </span>
              {lastRun.triggeredBy && (
                <TriggeredByBadge triggeredBy={lastRun.triggeredBy} run={lastRun} />
              )}
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-md bg-secondary/50 px-3 py-2.5">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                  Scanned
                </div>
                <div className="font-semibold text-base tabular-nums">
                  {lastRun.scannedFiles.toLocaleString()}
                </div>
                <div className="text-[11px] text-muted-foreground">files</div>
              </div>
              <div className="rounded-md bg-secondary/50 px-3 py-2.5">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                  Removed
                </div>
                <div className="font-semibold text-base tabular-nums">
                  {lastRun.removedCount.toLocaleString()}
                </div>
                <div className="text-[11px] text-muted-foreground">orphans</div>
              </div>
              <div className="rounded-md bg-secondary/50 px-3 py-2.5">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                  Freed
                </div>
                <div className="font-semibold text-base tabular-nums">
                  {formatBytes(lastRun.freedBytes)}
                </div>
                <div className="text-[11px] text-muted-foreground">disk space</div>
              </div>
            </div>

            {(hasError || lastRun.errorCount > 0) && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs space-y-1">
                <div className="font-medium text-destructive flex items-center gap-1.5">
                  <AlertCircle size={12} />
                  {hasError
                    ? "Cleanup run failed"
                    : `${lastRun.errorCount} error${lastRun.errorCount === 1 ? "" : "s"} during cleanup`}
                </div>
                {lastRun.errorMessage && (
                  <p className="text-muted-foreground truncate">{lastRun.errorMessage}</p>
                )}
              </div>
            )}
          </>
        )}

        {allRuns.length > 0 && (
          <div className="pt-1 border-t border-border/60">
            <button
              type="button"
              onClick={() => setShowHistory((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full py-1"
            >
              {showHistory ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              <span className="font-medium">
                {showHistory ? "Hide" : "Show"} run history
              </span>
              <span className="ml-auto text-[10px]">
                {allRuns.length} run{allRuns.length === 1 ? "" : "s"}
              </span>
            </button>

            {showHistory && (
              <div className="mt-2">
                <RunHistoryTable runs={allRuns} />
              </div>
            )}
          </div>
        )}

        {backupScheduleQuery.isSuccess && isBackupStale(backupScheduleQuery.data?.lastSuccessfulBackupAt, backupScheduleQuery.data?.staleAfterDays) && !gate.blocked && (
          <div className="flex items-start gap-2 rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-3 py-2.5 text-amber-800 dark:text-amber-300">
            <AlertTriangle size={13} className="shrink-0 mt-px" />
            <div className="text-xs leading-snug">
              <span className="font-semibold">
                {backupScheduleQuery.data?.lastSuccessfulBackupAt ? "Backup overdue — " : "No backup on record — "}
              </span>
              {backupScheduleQuery.data?.lastSuccessfulBackupAt
                ? `last successful backup was ${Math.floor((Date.now() - new Date(backupScheduleQuery.data.lastSuccessfulBackupAt).getTime()) / (24 * 60 * 60 * 1000))} day(s) ago.`
                : "no successful backup has been recorded."}
              {" "}
              <Link
                to="/settings?tab=backup"
                className="underline underline-offset-2 hover:opacity-80"
              >
                Go to Backup settings
              </Link>
            </div>
          </div>
        )}

        {(nextRunLabel || nextBackupLabel || (backupScheduleQuery.isSuccess && backupScheduleQuery.data?.lastSuccessfulBackupAt && !isBackupStale(backupScheduleQuery.data.lastSuccessfulBackupAt, backupScheduleQuery.data?.staleAfterDays))) && (
          <div className="pt-1 border-t border-border/60 space-y-1">
            {nextRunLabel && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock size={11} className="shrink-0" />
                Next cleanup: <span className="text-foreground font-medium">{nextRunLabel}</span>
              </div>
            )}
            {nextBackupLabel && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock size={11} className="shrink-0" />
                Next backup: <span className="text-foreground font-medium">{nextBackupLabel}</span>
              </div>
            )}
            {backupScheduleQuery.isSuccess && backupScheduleQuery.data?.lastSuccessfulBackupAt && !isBackupStale(backupScheduleQuery.data.lastSuccessfulBackupAt, backupScheduleQuery.data?.staleAfterDays) && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 size={11} className="shrink-0 text-green-600 dark:text-green-400" />
                Last backup: <span className="text-foreground font-medium">{relativeTime(backupScheduleQuery.data.lastSuccessfulBackupAt)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function isToday(d?: string | null): boolean {
  if (!d) return false;
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

const IN_PROGRESS_STATUSES = new Set([
  "received",
  "in_design",
  "in_milling",
  "in_porcelain",
  "qc",
]);

const COMPLETED_STATUSES = new Set(["delivered", "cancelled"]);

function CaseRow({ c, onSelect }: { c: LabCase; onSelect: (c: LabCase) => void }) {
  return (
    <tr
      className="border-t border-border hover:bg-secondary/40 cursor-pointer"
      onClick={() => onSelect(c)}
    >
      <td className="px-5 py-3 text-muted-foreground whitespace-nowrap">{formatDate(c.createdAt)}</td>
      <td className="py-3 font-mono text-xs">{c.caseNumber}</td>
      <td className="py-3">
        {c.patientFirstName} {c.patientLastName}
      </td>
      <td className="py-3 text-muted-foreground">{c.doctorName}</td>
      <td className="py-3">
        <StatusBadge status={c.status} />
      </td>
      <td className="py-3 font-mono text-xs text-muted-foreground">
        {c.casePanBarcode
          ? c.casePanBarcode.length > 12
            ? c.casePanBarcode.slice(0, 12) + "…"
            : c.casePanBarcode
          : "—"}
      </td>
      <td className="py-3 text-muted-foreground pr-5">{formatDate(c.dueDate)}</td>
    </tr>
  );
}

function CasesTable({
  cases,
  loading,
  emptyText,
  onSelect,
}: {
  cases: LabCase[];
  loading: boolean;
  emptyText: string;
  onSelect: (c: LabCase) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="text-left font-medium px-5 py-2.5">Entered</th>
            <th className="text-left font-medium py-2.5">Case #</th>
            <th className="text-left font-medium py-2.5">Patient</th>
            <th className="text-left font-medium py-2.5">Doctor</th>
            <th className="text-left font-medium py-2.5">Location</th>
            <th className="text-left font-medium py-2.5">Pan</th>
            <th className="text-left font-medium py-2.5 pr-5">Due</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={7} className="px-5 py-8 text-center text-sm text-muted-foreground">
                Loading…
              </td>
            </tr>
          )}
          {!loading && cases.length === 0 && (
            <tr>
              <td colSpan={7} className="px-5 py-8 text-center text-sm text-muted-foreground">
                {emptyText}
              </td>
            </tr>
          )}
          {cases.map((c) => (
            <CaseRow key={c.id} c={c} onSelect={onSelect} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DashboardPage() {
  // Suppress browser navigation if a file is dropped outside the drop zone.
  useEffect(() => {
    function prevent(e: DragEvent) {
      e.preventDefault();
    }
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  const [showNewCase, setShowNewCase] = useState(false);
  const [selectedCase, setSelectedCase] = useState<LabCase | null>(null);
  const [dueTodayOpen, setDueTodayOpen] = useState(true);
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { openPanel: openAiPanel } = useAiPanel();

  const casesQuery = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
  });

  const cases = casesQuery.data ?? [];
  const loading = casesQuery.isLoading;

  const todayCases = cases.filter((c) => isToday(c.createdAt));
  const inProgressCount = cases.filter((c) =>
    IN_PROGRESS_STATUSES.has(c.status),
  ).length;
  const rushCount = cases.filter((c) => c.priority === "rush").length;

  const recentCases = useMemo(
    () =>
      [...cases]
        .filter((c) => !COMPLETED_STATUSES.has(c.status))
        .sort((a, b) =>
          (b.updatedAt || b.createdAt || "").localeCompare(
            a.updatedAt || a.createdAt || "",
          ),
        )
        .slice(0, 6),
    [cases],
  );

  const dueTodayCases = useMemo(
    () =>
      [...cases]
        .filter((c) => isToday(c.dueDate) && !COMPLETED_STATUSES.has(c.status))
        .sort((a, b) =>
          (a.updatedAt || a.createdAt || "").localeCompare(
            b.updatedAt || b.createdAt || "",
          ),
        ),
    [cases],
  );

  return (
    <div className="px-8 py-7 max-w-[1400px] mx-auto">
      <DashboardSubscriptionBanner />
      <div className="flex items-end justify-between mb-7">
        <div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => openAiPanel()}
              className="inline-flex items-center gap-2 h-12 px-5 rounded-xl bg-primary text-primary-foreground text-base font-semibold hover:bg-primary/90 transition-colors shadow-sm"
            >
              <Sparkles size={20} />
              Maynard
            </button>
            <h1 className="text-2xl font-semibold tracking-tight">
              Dashboard
              {user?.practiceName && (
                <span className="ml-2 text-muted-foreground font-normal">
                  — {user.practiceName}
                </span>
              )}
            </h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Your lab at a glance.
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Clock size={12} />
              {inProgressCount} in progress
            </span>
            {rushCount > 0 && (
              <span className="flex items-center gap-1.5 text-destructive font-medium">
                <AlertTriangle size={12} />
                {rushCount} rush
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowNewCase(true)}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors shadow-sm"
          >
            <Plus size={15} />
            Add case
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 flex flex-col gap-6">
          <div>
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Upload size={14} className="text-muted-foreground" />
              Drop zone
            </h2>
            <DashboardDropZone />
          </div>

          {isAdmin && <MediaCleanupCard />}

          <section className="bg-card border border-border rounded-xl">
            <header className="px-5 py-3.5 border-b border-border">
              <h2 className="text-sm font-semibold">Logged today</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {loading
                  ? "Loading…"
                  : todayCases.length === 0
                    ? "No cases yet today"
                    : `${todayCases.length} case${todayCases.length === 1 ? "" : "s"} received`}
              </p>
            </header>
            <CasesTable
              cases={todayCases}
              loading={loading}
              emptyText="No cases logged today."
              onSelect={setSelectedCase}
            />
          </section>
        </div>

        <div className="lg:col-span-2 flex flex-col gap-6">
          <section className="bg-card border border-border rounded-xl self-start">
            <header className="flex items-center justify-between px-5 py-3.5 border-b border-border">
              <div>
                <h2 className="text-sm font-semibold">Recent cases</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Most recently active, excluding completed.
                </p>
              </div>
              <Link
                href="/cases"
                className="text-xs font-medium text-primary inline-flex items-center gap-1 hover:underline"
              >
                View all <ArrowRight size={12} />
              </Link>
            </header>
            <CasesTable
              cases={recentCases}
              loading={loading}
              emptyText="No active cases."
              onSelect={setSelectedCase}
            />
          </section>

          <section className="bg-card border border-border rounded-xl">
            <header
              className="flex items-center justify-between px-5 py-3.5 border-b border-border cursor-pointer select-none hover:bg-secondary/30 transition-colors rounded-t-xl"
              onClick={() => setDueTodayOpen((v) => !v)}
            >
              <div className="flex items-center gap-2.5">
                <div>
                  <h2 className="text-sm font-semibold flex items-center gap-2">
                    Due today
                    {!loading && dueTodayCases.length > 0 && (
                      <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full text-[10px] font-semibold bg-primary text-primary-foreground tabular-nums">
                        {dueTodayCases.length}
                      </span>
                    )}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {loading
                      ? "Loading…"
                      : dueTodayCases.length === 0
                        ? "No active cases due today."
                        : `${dueTodayCases.length} active case${dueTodayCases.length === 1 ? "" : "s"} due today.`}
                  </p>
                </div>
              </div>
              <button
                type="button"
                aria-label={dueTodayOpen ? "Collapse due today" : "Expand due today"}
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                onClick={(e) => { e.stopPropagation(); setDueTodayOpen((v) => !v); }}
              >
                {dueTodayOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </button>
            </header>
            {dueTodayOpen && (
              <CasesTable
                cases={dueTodayCases}
                loading={loading}
                emptyText="No active cases due today."
                onSelect={setSelectedCase}
              />
            )}
          </section>
        </div>
      </div>

      {showNewCase && <NewCaseModal onClose={() => setShowNewCase(false)} />}
      {selectedCase && (
        <CaseDrawer
          labCase={selectedCase}
          onClose={() => setSelectedCase(null)}
        />
      )}
    </div>
  );
}
