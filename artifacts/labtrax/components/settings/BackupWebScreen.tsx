import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
  StyleSheet,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  disableBackupSchedule,
  getBackupSchedule,
  getGoogleDriveBackupStatus,
  getOneDriveBackupStatus,
  getRestoreStatus,
  runBackupNow,
  getBackupRunStatus,
  followManualBackup,
  saveBackupSchedule,
} from "@workspace/api-client-react";
import { SettingsSection } from "@/components/settings/SettingsRow";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { useTheme } from "@/lib/theme-context";
import { getPlatformAdminSessionHeaders } from "@/lib/platform-admin-session";
import { resilientFetch, getApiUrl, refreshAndGetAccessToken, getCsrfToken } from "@/lib/query-client";
import { chooseBackupSaveFile, readBoundedBrowserBackup, streamCompleteBackupToFile } from "@/lib/backup-browser-download";
import { DismissKeyboardView, scrollKeyboardDismissMode } from "@/components/ui/DismissKeyboardView";

type Destination = "local" | "network" | "onedrive" | "google-drive";
type Unit = "minutes" | "hours";
type ScheduleFrequency = { interval: number; unit: Unit; label: string };
type BackupSchedule = {
  sourceEnvironment?: "development" | "production";
  ok?: boolean;
  interval: number | null;
  unit: Unit | null;
  destination: Destination | null;
  path: string | null;
  enabled: boolean;
  lastSuccessfulBackupAt: string | null;
  staleAlertThresholdDays: number;
  staleAlertRateLimitDays: number;
  staleAfterDays: number;
  effectiveIntervalMinutes?: number | null;
  effectiveDestination?: Destination | null;
  scheduleIntervalMinutes?: number | null;
  offsite?: {
    enabled: boolean;
    running: boolean;
    intervalMinutes: number;
    lastVerifiedAt: string | null;
    stale?: boolean;
    ageMinutes?: number | null;
    windowMinutes?: number;
    source?: "onedrive" | "database" | "none";
    reason?: string | null;
    destinationUnreadable?: boolean;
  } | null;
  alertDelivery?: {
    undelivered: { channel: string; source: string; detail: string | null; at: string } | null;
    recent: Array<{ channel: string; source: string; detail: string | null; at: string }>;
  } | null;
  fullArchiveIntervalMinutes?: number | null;
  nextDueAt?: string | null;
  lastAttemptAt?: string | null;
  newestArchive?: { name: string; createdAt: string; sizeBytes: number; ageMinutes: number } | null;
  newestArchiveError?: string | null;
  newestArchiveErrorMessage?: string | null;
  newestArchiveErrorDiagnostic?: string | null;
  archiveCount?: number | null;
};
type OneDriveStatus = {
  ok?: boolean;
  connected: boolean;
  accountName: string | null;
  accountEmail: string | null;
  folder: string;
  error: string | null;
  userMessage?: string | null;
  diagnostic?: string | null;
  manageUrl: string | null;
};
type GoogleDriveStatus = {
  connected: boolean;
  accountName: string | null;
  accountEmail: string | null;
  folder: string;
  error: string | null;
  manageUrl: string | null;
};
type BackupRun = {
  id: number;
  triggeredBy: string;
  destination: string;
  path: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  status: string;
  error: string | null;
  userMessage?: string | null;
  completedAt: string;
  mediaFileCount: number | null;
  attachmentRowCount: number | null;
  partialFailure: boolean | null;
  warnings: string | null;
  archiveKind?: string | null;
};
type Retention = {
  retentionDays: number;
  dbRetentionDays?: number | null;
  envRetentionDays?: number;
  maxRows: number;
  dbMaxRows?: number | null;
  envMaxRows?: number;
};
type RunResult = {
  size: number;
  completedAt: string;
  fileName: string;
  partialFailure?: boolean;
  warnings?: string | null;
  warningMessage?: string | null;
  viaBrowser?: boolean;
};
type RestorePhase =
  | "idle" | "uploading" | "validating" | "decrypting" | "restoring_db"
  | "clearing_sessions" | "restoring_media" | "done" | "error";

const FREQUENCIES: ScheduleFrequency[] = [
  { interval: 5, unit: "minutes", label: "5 minutes" },
  { interval: 10, unit: "minutes", label: "10 minutes" },
  { interval: 15, unit: "minutes", label: "15 minutes" },
  { interval: 1, unit: "hours", label: "1 hour" },
];
const CHUNK_SIZE = 1024 * 1024;
const RESTORE_LABELS: Record<RestorePhase, string> = {
  idle: "Idle",
  uploading: "Uploading backup",
  validating: "Validating archive",
  decrypting: "Decrypting archive",
  restoring_db: "Restoring database",
  clearing_sessions: "Clearing active sessions",
  restoring_media: "Restoring media files",
  done: "Restore complete",
  error: "Restore failed",
};

function apiError(body: any, status: number): Error {
  const error = new Error(body?.error || body?.message || `Request failed (${status}).`);
  (error as Error & { diagnostic?: string }).diagnostic =
    typeof body?.diagnostic === "string" ? body.diagnostic : undefined;
  return error;
}

async function jsonRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const adminHeaders = await getPlatformAdminSessionHeaders();
  const response = await resilientFetch(`/api/admin/backup${path}`, {
    ...options,
    headers: { ...adminHeaders, ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw apiError(body, response.status);
  return body as T;
}

function intervalMinutes(interval: number | null | undefined, unit: Unit | null | undefined) {
  if (interval == null || !unit) return null;
  return unit === "hours" ? interval * 60 : interval;
}

function intervalLabel(minutes: number | null | undefined): string {
  if (!minutes || minutes < 1) return "Not configured";
  if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

function dateLabel(value?: string | null): string {
  if (!value) return "No successful run recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function ageLabel(minutes?: number | null): string {
  if (minutes == null) return "Age unavailable";
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function sizeLabel(bytes?: number | null): string {
  if (bytes == null) return "Size unavailable";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function isDatabaseOnly(run: BackupRun) {
  return run.archiveKind === "database-only";
}

export default function BackupWebScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const queryClient = useQueryClient();
  const restorePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restoreInFlightRef = useRef(false);
  const [manualDestination, setManualDestination] = useState<Destination>("local");
  const [manualPath, setManualPath] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualPhase, setManualPhase] = useState<string | null>(null);
  const [manualResult, setManualResult] = useState<RunResult | null>(null);
  const [scheduleFrequency, setScheduleFrequency] = useState<ScheduleFrequency>(FREQUENCIES[2]);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleDestination, setScheduleDestination] = useState<Destination>("local");
  const [schedulePath, setSchedulePath] = useState("");
  const [staleDays, setStaleDays] = useState("7");
  const [alertThreshold, setAlertThreshold] = useState("7");
  const [alertRateLimit, setAlertRateLimit] = useState("3");
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleMessage, setScheduleMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [scheduleRunBusy, setScheduleRunBusy] = useState(false);
  const [scheduleRunResult, setScheduleRunResult] = useState<RunResult | null>(null);
  const [scheduleRunError, setScheduleRunError] = useState<string | null>(null);
  const [retentionDays, setRetentionDays] = useState("90");
  const [maxRows, setMaxRows] = useState("500");
  const [retentionBusy, setRetentionBusy] = useState(false);
  const [retentionMessage, setRetentionMessage] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [historyRestoreBusy, setHistoryRestoreBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [confirmStep, setConfirmStep] = useState<0 | 1 | 2>(0);
  const [restorePhase, setRestorePhase] = useState<RestorePhase>("idle");
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreDiagnostic, setRestoreDiagnostic] = useState<string | null>(null);
  const [restoreProgress, setRestoreProgress] = useState(0);
  const [restoreSuccess, setRestoreSuccess] = useState(false);
  const restoreBusy = !["idle", "done", "error"].includes(restorePhase);

  const scheduleQuery = useQuery({
    queryKey: ["admin", "backup-schedule-web"],
    queryFn: async () => {
      const headers = await getPlatformAdminSessionHeaders();
      const data = await getBackupSchedule({ headers });
      // Generated response schema predates operational HUD fields. Preserve
      // the complete live response without narrowing away server evidence.
      return data as BackupSchedule;
    },
    staleTime: 30_000,
    retry: false,
  });
  const oneDriveQuery = useQuery({
    queryKey: ["admin", "backup-onedrive-status-web"],
    queryFn: async () => {
      const data = await getOneDriveBackupStatus({ headers: await getPlatformAdminSessionHeaders() });
      return data as OneDriveStatus;
    },
    staleTime: 60_000,
    retry: false,
  });
  const googleDriveQuery = useQuery({
    queryKey: ["admin", "backup-google-drive-status-web"],
    queryFn: async () => {
      const data = await getGoogleDriveBackupStatus({
        headers: await getPlatformAdminSessionHeaders(),
      });
      return data as GoogleDriveStatus;
    },
    staleTime: 60_000,
    retry: false,
  });
  const historyQuery = useQuery({
    queryKey: ["admin", "backup-history-web"],
    queryFn: () => jsonRequest<{ ok?: boolean; runs?: BackupRun[] }>("/history"),
    staleTime: 30_000,
    retry: false,
  });
  const retentionQuery = useQuery({
    queryKey: ["admin", "backup-retention-web"],
    queryFn: () => jsonRequest<Retention>("/history-retention"),
    staleTime: 60_000,
    retry: false,
  });
  const schedule = scheduleQuery.data;
  const backupSourceHeaders: Record<string, string> = schedule?.sourceEnvironment
    ? { "X-LabTrax-Backup-Source": schedule.sourceEnvironment }
    : {};
  const history = historyQuery.data?.runs ?? [];
  const hasSavedFrequency = schedule?.interval != null && schedule.unit != null;
  const savedFrequencyMinutes = intervalMinutes(schedule?.interval, schedule?.unit);
  const legacyFrequency: ScheduleFrequency | null =
    hasSavedFrequency && !FREQUENCIES.some((entry) => entry.interval === schedule?.interval && entry.unit === schedule?.unit)
      ? { interval: schedule!.interval!, unit: schedule!.unit!, label: `Current saved · ${schedule!.interval} ${schedule!.unit}` }
      : null;
  const availableFrequencies = legacyFrequency ? [...FREQUENCIES, legacyFrequency] : FREQUENCIES;
  const offsite = schedule?.offsite ?? null;
  const effectiveCadence = schedule?.effectiveIntervalMinutes ?? (schedule?.enabled ? savedFrequencyMinutes : null);
  const effectiveDestination = schedule?.effectiveDestination ?? schedule?.destination;
  const newestArchive = schedule?.newestArchive ?? null;
  const overdue = schedule?.lastSuccessfulBackupAt
    ? Date.now() - new Date(schedule.lastSuccessfulBackupAt).getTime() > (schedule.staleAfterDays || 7) * 86_400_000
    : true;
  const selectedRun = history.find((run) => run.id === selectedRunId) ?? null;
  const localErrorRun = history.find((run) => run.destination === "local" && run.status === "error");

  useEffect(() => {
    if (!schedule) return;
    if (schedule.interval != null && schedule.unit) {
      const found = FREQUENCIES.find((option) => option.interval === schedule.interval && option.unit === schedule.unit);
      setScheduleFrequency(found ?? {
        interval: schedule.interval,
        unit: schedule.unit,
        label: `Current saved · ${schedule.interval} ${schedule.unit}`,
      });
    } else {
      setScheduleFrequency(FREQUENCIES[2]);
    }
    setScheduleEnabled(schedule.enabled ?? false);
    setScheduleDestination(schedule.destination ?? "local");
    setSchedulePath(schedule.path ?? "");
    setStaleDays(String(schedule.staleAfterDays ?? 7));
    setAlertThreshold(String(schedule.staleAlertThresholdDays ?? 7));
    setAlertRateLimit(String(schedule.staleAlertRateLimitDays ?? 3));
  }, [schedule]);

  useEffect(() => {
    if (!retentionQuery.data) return;
    setRetentionDays(String(retentionQuery.data.retentionDays ?? 90));
    setMaxRows(String(retentionQuery.data.maxRows ?? 500));
  }, [retentionQuery.data]);

  const refreshBackupQueries = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "backup-schedule-web"] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "backup-history-web"] });
  }, [queryClient]);

  useEffect(() => () => {
    if (restorePollRef.current) clearInterval(restorePollRef.current);
  }, []);

  async function startManualBackup() {
    setManualBusy(true);
    setManualError(null);
    setManualPhase(null);
    setManualResult(null);
    try {
      if (manualDestination === "local") {
        const selectedFile = await chooseBackupSaveFile();
        const headers = await getPlatformAdminSessionHeaders();
        const token = await refreshAndGetAccessToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        const csrf = getCsrfToken();
        if (csrf) headers["X-CSRF-Token"] = csrf;
        const requestUrl = `${getApiUrl()}api/admin/backup/generate`;
        const options = { method: "POST", credentials: "include" as const, headers: { ...headers, ...backupSourceHeaders } };
        if (selectedFile) {
          const size = await streamCompleteBackupToFile(requestUrl, options, await selectedFile.createWritable());
          setManualResult({
            size, completedAt: new Date().toISOString(), fileName: selectedFile.name,
            viaBrowser: true,
          });
          return;
        }
        const { buffer, headers: responseHeaders } = await readBoundedBrowserBackup(requestUrl, options);
        const disposition = responseHeaders.get("Content-Disposition") ?? "";
        const fileName = /filename="([^"]+)"/i.exec(disposition)?.[1] ?? "labtrax-backup.zip.enc";
        const url = URL.createObjectURL(new Blob([buffer], { type: "application/octet-stream" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        setManualResult({ size: buffer.byteLength, completedAt: new Date().toISOString(), fileName, viaBrowser: true });
      } else {
        const headers = { ...await getPlatformAdminSessionHeaders(), ...backupSourceHeaders };
        const runId = globalThis.crypto.randomUUID();
        const result = await followManualBackup(
          runId,
          () => runBackupNow(
            { destination: manualDestination, path: manualPath.trim(), runId, respondAsync: true },
            { headers },
          ),
          () => getBackupRunStatus(runId, { headers }),
          status => setManualPhase(status.phase),
        );
        setManualResult({
          size: result.size ?? 0,
          completedAt: result.completedAt ?? new Date().toISOString(),
          fileName: result.fileName ?? "backup.zip.enc",
          partialFailure: (result as any).partialFailure ?? false,
          warnings: (result as any).warnings ?? null,
        });
      }
      refreshBackupQueries();
    } catch (error) {
      setManualError(error instanceof Error ? error.message : "Backup failed.");
      void queryClient.invalidateQueries({ queryKey: ["admin", "backup-history-web"] });
    } finally {
      setManualBusy(false);
      setManualPhase(null);
    }
  }

  async function saveRoutineSchedule() {
    setScheduleBusy(true);
    setScheduleMessage(null);
    try {
      const payload = {
        interval: scheduleFrequency.interval,
        unit: scheduleFrequency.unit,
        destination: scheduleDestination,
        path: scheduleDestination === "onedrive" || scheduleDestination === "google-drive"
          ? null
          : schedulePath.trim() || null,
        enabled: scheduleEnabled,
        staleAfterDays: Number(staleDays),
        staleAlertThresholdDays: Number(alertThreshold),
        staleAlertRateLimitDays: Number(alertRateLimit),
      };
      const headers = await getPlatformAdminSessionHeaders();
      await saveBackupSchedule(payload as any, { headers: { ...headers, ...backupSourceHeaders } });
      setScheduleMessage({ tone: "success", text: "Routine schedule saved. Off-site protection remains on its independent timer." });
      refreshBackupQueries();
    } catch (error) {
      setScheduleMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not save the schedule." });
    } finally {
      setScheduleBusy(false);
    }
  }

  async function disableRoutineSchedule() {
    setScheduleBusy(true);
    setScheduleMessage(null);
    try {
      await disableBackupSchedule({ headers: await getPlatformAdminSessionHeaders() });
      setScheduleEnabled(false);
      setScheduleMessage({ tone: "success", text: "Routine schedule disabled. The independent off-site job is unchanged." });
      refreshBackupQueries();
    } catch (error) {
      setScheduleMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not disable schedule." });
    } finally {
      setScheduleBusy(false);
    }
  }

  async function runScheduledBackupNow() {
    setScheduleRunBusy(true);
    setScheduleRunError(null);
    setScheduleRunResult(null);
    try {
      const result = await jsonRequest<RunResult & { destination?: string }>("/schedule/run-now", {
        method: "POST", headers: backupSourceHeaders,
      });
      setScheduleRunResult(result);
      refreshBackupQueries();
    } catch (error) {
      setScheduleRunError(error instanceof Error ? error.message : "Scheduled backup failed.");
    } finally {
      setScheduleRunBusy(false);
    }
  }

  async function saveRetention() {
    setRetentionBusy(true);
    setRetentionMessage(null);
    try {
      const days = Number(retentionDays);
      const rows = Number(maxRows);
      if (!Number.isInteger(days) || days < 1 || !Number.isInteger(rows) || rows < 1) {
        throw new Error("Enter positive whole numbers for both retention limits.");
      }
      await jsonRequest<Retention>("/history-retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retentionDays: days, maxRows: rows }),
      });
      setRetentionMessage("Retention settings saved.");
      void queryClient.invalidateQueries({ queryKey: ["admin", "backup-retention-web"] });
    } catch (error) {
      setRetentionMessage(error instanceof Error ? error.message : "Could not save retention.");
    } finally {
      setRetentionBusy(false);
    }
  }

  function downloadBlob(buffer: ArrayBuffer, fileName: string) {
    const url = URL.createObjectURL(new Blob([buffer], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function downloadHistoryRun(run: BackupRun): Promise<File> {
    if (run.status !== "success") throw new Error("Only successful backup runs can be downloaded.");
    if (run.destination !== "onedrive") {
      throw new Error(run.destination === "local" || run.destination === "network"
        ? "This browser cannot read a backup from a local or network path. Choose the encrypted file below, or use LabTrax Desktop."
        : "This backup destination cannot be downloaded here.");
    }
    const headers = await getPlatformAdminSessionHeaders();
    const response = await resilientFetch(`/api/admin/backup/history/${run.id}/download`, { headers });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw apiError(body, response.status);
    }
    const buffer = await response.arrayBuffer();
    return new File([buffer], run.fileName ?? "labtrax-backup.zip.enc", { type: "application/octet-stream" });
  }

  async function restoreSelectedHistory() {
    if (!selectedRun || restoreBusy || restoreInFlightRef.current) return;
    setHistoryRestoreBusy(true);
    setHistoryError(null);
    try {
      if (isDatabaseOnly(selectedRun)) throw new Error("This database-only archive cannot be used as a full restore source.");
      const file = await downloadHistoryRun(selectedRun);
      setSelectedFile(file);
      setRestoreOpen(true);
      setRestoreError(null);
      setRestoreSuccess(false);
      setConfirmStep(1);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Could not load the selected archive.");
    } finally {
      setHistoryRestoreBusy(false);
    }
  }

  function chooseBackupFile() {
    if (restoreBusy || Platform.OS !== "web" || typeof document === "undefined") return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".enc,.zip.enc,application/octet-stream";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) {
        setSelectedFile(file);
        setRestoreError(null);
        setRestoreSuccess(false);
      }
    };
    input.click();
  }

  async function beginRestore() {
    if (!selectedFile || restoreInFlightRef.current) return;
    restoreInFlightRef.current = true;
    const file = selectedFile;
    setConfirmStep(0);
    setRestorePhase("uploading");
    setRestoreMessage("Preparing a secure upload session…");
    setRestoreError(null);
    setRestoreSuccess(false);
    setRestoreProgress(0);
    try {
      const session = await jsonRequest<{ sessionId: string; uploadedBytes: number }>("/restore-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, fileSize: file.size }),
      });
      let offset = session.uploadedBytes ?? 0;
      while (offset < file.size) {
        const chunk = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
        const adminHeaders = await getPlatformAdminSessionHeaders();
        const response = await resilientFetch(`/api/admin/backup/restore-session/${encodeURIComponent(session.sessionId)}`, {
          method: "PATCH",
          headers: {
            ...adminHeaders,
            "Content-Type": "application/octet-stream",
            "Upload-Offset": String(offset),
          },
          body: chunk,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw apiError(body, response.status);
        offset = Number(body.uploadedBytes ?? file.size);
        setRestoreProgress(Math.min(100, Math.round((offset / file.size) * 100)));
        setRestoreMessage(body.complete ? "Upload complete. Restore pipeline started." : `Uploaded ${sizeLabel(offset)} of ${sizeLabel(file.size)}.`);
      }
      setRestorePhase("validating");
      setRestoreMessage("The archive is being validated and restored.");
      restorePollRef.current = setInterval(async () => {
        try {
          const state = await getRestoreStatus({ headers: await getPlatformAdminSessionHeaders() }) as { phase?: RestorePhase; message?: string | null; diagnosticMessage?: string | null };
          const phase = state.phase ?? "uploading";
          setRestorePhase(phase);
          setRestoreMessage(state.message ?? RESTORE_LABELS[phase]);
          if (phase === "done" || phase === "error") {
            if (restorePollRef.current) clearInterval(restorePollRef.current);
            restorePollRef.current = null;
             restoreInFlightRef.current = false;
            if (phase === "done") {
              setRestoreSuccess(true);
              setRestoreProgress(100);
              refreshBackupQueries();
            } else {
              setRestoreError(state.message || "Restore failed.");
              setRestoreDiagnostic(state.diagnosticMessage ?? null);
            }
          }
        } catch {
          setRestoreMessage("Restore status is temporarily unavailable. The server may still be restoring; do not start another restore. Retrying status…");
        }
      }, 1500);
    } catch (error) {
      if (restorePollRef.current) clearInterval(restorePollRef.current);
      restorePollRef.current = null;
      restoreInFlightRef.current = false;
      setRestorePhase("error");
      setRestoreError(error instanceof Error ? error.message : "Restore failed.");
      setRestoreDiagnostic((error as Error & { diagnostic?: string })?.diagnostic ?? null);
    }
  }

  function openOneDriveManage() {
    if (oneDriveQuery.data?.manageUrl && Platform.OS === "web" && typeof window !== "undefined") {
      window.open(oneDriveQuery.data.manageUrl, "_blank", "noopener,noreferrer");
    }
  }

  function openGoogleDriveManage() {
    if (googleDriveQuery.data?.manageUrl && Platform.OS === "web" && typeof window !== "undefined") {
      window.open(googleDriveQuery.data.manageUrl, "_blank", "noopener,noreferrer");
    }
  }

  const oneDriveConnected = oneDriveQuery.data?.connected === true;
  const googleDriveConnected = googleDriveQuery.data?.connected === true;
  const manualReady = !manualBusy && (
    manualDestination === "local" ||
    (manualDestination === "onedrive" && oneDriveConnected) ||
    (manualDestination === "google-drive" && googleDriveConnected) ||
    (manualDestination === "network" && manualPath.trim().startsWith("sftp://"))
  );
  const canRunSavedSchedule =
    schedule?.destination === "onedrive" ||
    schedule?.destination === "google-drive" ||
    (schedule?.destination === "network" && schedule.path?.trim().startsWith("sftp://"));
  const newestSuccessfulRun = history.find((run) => run.status === "success");
  const latestPartialRun = newestSuccessfulRun?.partialFailure ? newestSuccessfulRun : null;

  return (
    <DismissKeyboardView style={{ flex: 1 }}>
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled" keyboardDismissMode={scrollKeyboardDismissMode}>
      <View style={styles.heading}>
        <View style={styles.headingMark}><Ionicons name="shield-checkmark-outline" size={21} color={colors.tint} /></View>
        <View style={styles.headingCopy}>
          <Text style={[styles.title, { color: colors.text }]}>Backup</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>Encrypted recovery points, live destination evidence, and restore controls.</Text>
        </View>
      </View>

      {scheduleQuery.isLoading ? (
        <View style={[styles.loadingCard, { backgroundColor: colors.surface, borderColor: colors.border }]} testID="backup-status-loading">
          <ActivityIndicator color={colors.tint} />
          <Text style={[styles.bodyText, { color: colors.textSecondary }]}>Reading live backup configuration…</Text>
        </View>
      ) : scheduleQuery.isError ? (
        <Notice styles={styles} colors={colors} tone="error" testID="backup-status-error">
          Backup status could not be loaded. Check your connection and use Retry to check again.
          <InlineAction label="Retry" onPress={() => void scheduleQuery.refetch()} testID="backup-status-retry" styles={styles} colors={colors} />
        </Notice>
      ) : null}

      {localErrorRun ? (
        <Notice styles={styles} colors={colors} tone="error" testID="local-backup-error-banner">
          <Text style={[styles.noticeTitle, { color: colors.error }]}>Local folder backup failed</Text>
          <Text style={[styles.bodyText, { color: colors.error }]}>
            {localErrorRun.userMessage ?? "The backup did not complete, so no new complete recovery point was created. Check the destination and failure details."}
          </Text>
          {localErrorRun.path ? <Text style={[styles.helperText, { color: colors.textSecondary }]}>Folder: {localErrorRun.path}</Text> : null}
          {localErrorRun.error ? <DiagnosticDetails text={localErrorRun.error} styles={styles} colors={colors} /> : null}
        </Notice>
      ) : null}
      {schedule && (offsite?.enabled ? offsite.stale || offsite.destinationUnreadable : overdue) ? (
        <Notice styles={styles} colors={colors} tone="warning" testID="backup-stale-banner">
          <Text style={[styles.noticeTitle, { color: colors.warning }]}>
            {offsite?.enabled ? "No OneDrive archive confirmed within the freshness window" : "Backup overdue"}
          </Text>
          <Text style={[styles.bodyText, { color: colors.warning }]}>
            {offsite?.reason ?? `Last successful run on record: ${dateLabel(schedule.lastSuccessfulBackupAt)}. A database run record alone does not confirm an archive exists at its destination.`}
          </Text>
        </Notice>
      ) : null}
      {schedule?.alertDelivery?.undelivered ? (
        <Notice styles={styles} colors={colors} tone="error" testID="backup-alert-undelivered-notice">
          <Text style={[styles.noticeTitle, { color: colors.error }]}>A backup alert could not be delivered</Text>
          <Text style={[styles.bodyText, { color: colors.error }]}>
            {schedule.alertDelivery.undelivered.channel} alert from {schedule.alertDelivery.undelivered.source} failed
            {schedule.alertDelivery.undelivered.detail ? `: ${schedule.alertDelivery.undelivered.detail}` : "."}
          </Text>
        </Notice>
      ) : null}
      {latestPartialRun ? (
        <Notice styles={styles} colors={colors} tone="warning" testID="backup-partial-warning">
          <Text style={[styles.noticeTitle, { color: colors.warning }]}>Latest recorded archive is partial</Text>
          <Text style={[styles.bodyText, { color: colors.warning }]}>
            {latestPartialRun.warnings ?? "Some content could not be included. Restoring this archive will not bring back dropped content."}
          </Text>
        </Notice>
      ) : null}

      <SettingsSection title="Operations status">
        {schedule ? (
          <View style={styles.hud} testID="backup-server-status">
            <View style={styles.hudTop}>
              <Text style={[styles.hudEyebrow, { color: colors.textTertiary }]}>SERVER-REPORTED · LIVE VALUES</Text>
              <Pressable onPress={() => { void scheduleQuery.refetch(); void oneDriveQuery.refetch(); void googleDriveQuery.refetch(); void historyQuery.refetch(); }} testID="backup-refresh-status" style={styles.refreshButton}>
                <Ionicons name="refresh-outline" size={14} color={colors.tint} />
                <Text style={[styles.refreshText, { color: colors.tint }]}>Refresh</Text>
              </Pressable>
            </View>
            <View style={styles.hudGrid}>
              <HudValue label="Effective cadence" value={intervalLabel(effectiveCadence)} id="backup-effective-interval" styles={styles} colors={colors} />
              <HudValue label="Effective destination" value={effectiveDestination === "onedrive" ? "OneDrive" : effectiveDestination === "network" ? "Network · SFTP" : effectiveDestination === "local" ? "Local / USB" : schedule.enabled ? "Not configured" : "Paused"} id="backup-effective-destination" styles={styles} colors={colors} />
              <HudValue label="Editable routine" value={`${schedule.enabled ? "Enabled · " : "Disabled · "}${intervalLabel(savedFrequencyMinutes)}`} id="backup-routine-cadence" styles={styles} colors={colors} />
              <HudValue label="Full-media archive" value={intervalLabel(schedule.fullArchiveIntervalMinutes)} id="backup-full-archive-interval" styles={styles} colors={colors} />
            </View>
            <View style={[styles.hudDivider, { backgroundColor: colors.border }]} />
            <View style={styles.offsiteRow}>
              <View style={styles.offsiteCopy}>
                <Text style={[styles.fieldLabel, { color: colors.text }]}>Dedicated off-site protection</Text>
                <Text style={[styles.helperText, { color: colors.textSecondary }]} testID="backup-offsite-state">
                  {offsite ? `${offsite.enabled ? "Enabled" : "Disabled"} · ${offsite.running ? "running" : "stopped"} · ${intervalLabel(offsite.intervalMinutes)}` : "Live off-site status unavailable"}
                </Text>
              </View>
              <Badge text={offsite?.enabled && offsite.running ? "LIVE" : "CHECK"} tone={offsite?.enabled && offsite.running ? "success" : "warning"} styles={styles} colors={colors} />
            </View>
            {offsite && (offsite.enabled !== true || offsite.running !== true || offsite.intervalMinutes !== 15) ? (
              <Text style={[styles.warningText, { color: colors.warning }]} testID="backup-offsite-warning">
                {offsite.enabled !== true ? "Off-site protection is disabled." : offsite.running !== true ? "Off-site protection is enabled but not running." : `Off-site cadence is ${offsite.intervalMinutes} minutes; expected production cadence is 15 minutes.`}
                {" "}This timer is independent of the editable routine schedule.
              </Text>
            ) : null}
            {offsite?.stale || offsite?.destinationUnreadable ? (
              <Text style={[styles.warningText, { color: colors.warning }]} testID="backup-offsite-stale">
                {offsite.reason ?? (offsite.destinationUnreadable ? "The OneDrive destination could not be read." : "The confirmed off-site archive is stale.")}
              </Text>
            ) : null}
            <View style={[styles.hudDivider, { backgroundColor: colors.border }]} />
            <View testID="backup-newest-archive">
              <Text style={[styles.fieldLabel, { color: colors.text }]}>Newest archive confirmed in OneDrive</Text>
              {schedule.newestArchiveError ? (
                <View>
                  <Text style={[styles.warningText, { color: colors.error }]}>
                    {schedule.newestArchiveErrorMessage ?? "LabTrax could not check the OneDrive backup folder, so a complete recovery point could not be confirmed. Check the OneDrive connection and review the details."}
                  </Text>
                  {schedule.newestArchiveErrorDiagnostic ? <DiagnosticDetails text={schedule.newestArchiveErrorDiagnostic} styles={styles} colors={colors} /> : null}
                </View>
              ) : newestArchive ? (
                <View style={styles.archiveEvidence}>
                  <Text style={[styles.archiveName, { color: colors.text }]} numberOfLines={2}>{newestArchive.name}</Text>
                  <Text style={[styles.helperText, { color: colors.textSecondary }]}>
                    {sizeLabel(newestArchive.sizeBytes)} · {ageLabel(newestArchive.ageMinutes)} · {schedule.archiveCount ?? "—"} retained
                  </Text>
                  <Text style={[styles.helperText, { color: colors.textTertiary }]}>Created {dateLabel(newestArchive.createdAt)}</Text>
                </View>
              ) : (
                <Text style={[styles.warningText, { color: colors.warning }]}>
                  {schedule.newestArchiveError ? "OneDrive listing unavailable." : "No archives found in the OneDrive folder. A successful database run is not proof of a stored object."}
                </Text>
              )}
              {offsite?.source === "database" ? (
                <Text style={[styles.warningText, { color: colors.warning }]} testID="backup-database-evidence-warning">
                  Freshness is based on the last database run only; the OneDrive folder itself could not be verified.
                </Text>
              ) : null}
              {schedule.lastAttemptAt ? <Text style={[styles.helperText, { color: colors.textTertiary }]}>Last attempt · {dateLabel(schedule.lastAttemptAt)}</Text> : null}
              {schedule.nextDueAt ? <Text style={[styles.helperText, { color: colors.textTertiary }]}>Next routine run · {dateLabel(schedule.nextDueAt)}</Text> : null}
            </View>
          </View>
        ) : (
          <View style={styles.emptyState} testID="backup-status-empty">
            <Ionicons name="cloud-offline-outline" size={22} color={colors.textTertiary} />
            <Text style={[styles.bodyText, { color: colors.textSecondary }]}>No schedule status is available yet.</Text>
          </View>
        )}
      </SettingsSection>

      <SettingsSection title="OneDrive connection">
        {oneDriveQuery.isLoading ? (
          <View style={styles.inlineLoading}><ActivityIndicator size="small" color={colors.tint} /><Text style={[styles.bodyText, { color: colors.textSecondary }]}>Checking OneDrive…</Text></View>
        ) : oneDriveQuery.isError ? (
          <View style={styles.stack}>
            <Text style={[styles.bodyText, { color: colors.error }]} testID="onedrive-status-error">{(oneDriveQuery.error as Error)?.message ?? "Could not check OneDrive."}</Text>
            <ActionButton label="Check again" icon="refresh-outline" onPress={() => void oneDriveQuery.refetch()} testID="onedrive-check-again-button" styles={styles} colors={colors} variant="secondary" />
          </View>
        ) : oneDriveConnected ? (
          <View style={styles.stack} testID="onedrive-status-connected">
            <View style={styles.connectionRow}><Badge text="CONNECTED" tone="success" styles={styles} colors={colors} /><Text style={[styles.bodyText, { color: colors.text }]}>{oneDriveQuery.data?.accountName ?? oneDriveQuery.data?.accountEmail ?? "Microsoft account linked"}</Text></View>
            {oneDriveQuery.data?.accountEmail && oneDriveQuery.data?.accountName ? <Text style={[styles.helperText, { color: colors.textSecondary }]}>{oneDriveQuery.data.accountEmail}</Text> : null}
            <Text style={[styles.helperText, { color: colors.textSecondary }]}>Backup folder · <Text style={[styles.mono, { color: colors.text }]}>{oneDriveQuery.data?.folder ?? "—"}</Text></Text>
            <View style={styles.buttonRow}>
              {oneDriveQuery.data?.manageUrl ? <ActionButton label="Manage / reconnect" icon="open-outline" onPress={openOneDriveManage} testID="onedrive-reconnect-button" styles={styles} colors={colors} variant="secondary" /> : null}
              <ActionButton label="Check again" icon="refresh-outline" onPress={() => void oneDriveQuery.refetch()} testID="onedrive-check-again-button" styles={styles} colors={colors} variant="secondary" />
            </View>
          </View>
        ) : (
          <View style={styles.stack} testID="onedrive-status-disconnected">
            <Text style={[styles.noticeTitle, { color: colors.warning }]}>OneDrive is not connected</Text>
            <Text style={[styles.bodyText, { color: colors.textSecondary }]}>
              {oneDriveQuery.data?.userMessage ?? "OneDrive is not connected. Connect the Microsoft integration or reconnect the account, then check again."}
            </Text>
            {oneDriveQuery.data?.diagnostic ? <DiagnosticDetails text={oneDriveQuery.data.diagnostic} styles={styles} colors={colors} /> : null}
            <View style={styles.buttonRow}>
              {oneDriveQuery.data?.manageUrl ? <ActionButton label="Connect OneDrive" icon="open-outline" onPress={openOneDriveManage} testID="onedrive-connect-button" styles={styles} colors={colors} variant="secondary" /> : null}
              <ActionButton label="Check again" icon="refresh-outline" onPress={() => void oneDriveQuery.refetch()} testID="onedrive-check-again-button" styles={styles} colors={colors} variant="secondary" />
            </View>
          </View>
        )}
      </SettingsSection>

      <SettingsSection title="Google Drive connection">
        {googleDriveQuery.isLoading ? (
          <View style={styles.inlineLoading}><ActivityIndicator size="small" color={colors.tint} /><Text style={[styles.bodyText, { color: colors.textSecondary }]}>Checking Google Drive…</Text></View>
        ) : googleDriveQuery.isError ? (
          <View style={styles.stack}>
            <Text style={[styles.bodyText, { color: colors.error }]} testID="google-drive-status-error">{(googleDriveQuery.error as Error)?.message ?? "Could not check Google Drive."}</Text>
            <ActionButton label="Check again" icon="refresh-outline" onPress={() => void googleDriveQuery.refetch()} testID="google-drive-check-again-button" styles={styles} colors={colors} variant="secondary" />
          </View>
        ) : googleDriveConnected ? (
          <View style={styles.stack} testID="google-drive-status-connected">
            <View style={styles.connectionRow}><Badge text="CONNECTED" tone="success" styles={styles} colors={colors} /><Text style={[styles.bodyText, { color: colors.text }]}>{googleDriveQuery.data?.accountName ?? googleDriveQuery.data?.accountEmail ?? "Google account linked"}</Text></View>
            {googleDriveQuery.data?.accountEmail && googleDriveQuery.data?.accountName ? <Text style={[styles.helperText, { color: colors.textSecondary }]}>{googleDriveQuery.data.accountEmail}</Text> : null}
            <Text style={[styles.helperText, { color: colors.textSecondary }]}>Backup folder · <Text style={[styles.mono, { color: colors.text }]}>{googleDriveQuery.data?.folder ?? "—"}</Text></Text>
            <View style={styles.buttonRow}>
              {googleDriveQuery.data?.manageUrl ? <ActionButton label="Manage / reconnect" icon="open-outline" onPress={openGoogleDriveManage} testID="google-drive-reconnect-button" styles={styles} colors={colors} variant="secondary" /> : null}
              <ActionButton label="Check again" icon="refresh-outline" onPress={() => void googleDriveQuery.refetch()} testID="google-drive-check-again-button" styles={styles} colors={colors} variant="secondary" />
            </View>
          </View>
        ) : (
          <View style={styles.stack} testID="google-drive-status-disconnected">
            <Text style={[styles.noticeTitle, { color: colors.warning }]}>Google Drive is not connected</Text>
            <Text style={[styles.bodyText, { color: colors.textSecondary }]}>
              {googleDriveQuery.data?.error ?? "Connect Google Drive in the LabTrax hosting workspace, then check again."}
            </Text>
            <View style={styles.buttonRow}>
              {googleDriveQuery.data?.manageUrl ? <ActionButton label="Connect Google Drive" icon="open-outline" onPress={openGoogleDriveManage} testID="google-drive-connect-button" styles={styles} colors={colors} variant="secondary" /> : null}
              <ActionButton label="Check again" icon="refresh-outline" onPress={() => void googleDriveQuery.refetch()} testID="google-drive-check-again-button" styles={styles} colors={colors} variant="secondary" />
            </View>
          </View>
        )}
      </SettingsSection>

      <SettingsSection title="Back up LabTrax data now">
        <Text testID="backup-source-label" style={{ color: colors.text }}>
          Database source: {schedule?.sourceEnvironment === "production" ? "Production" :
            schedule?.sourceEnvironment === "development" ? "Development" : "Not confirmed by this server"}
        </Text>
        <Text style={{ color: colors.text }}>
          Backups and schedules use this app's connected database and files. For development use the Replit preview; for production use the published app. Desktop uses its configured server. Changing a destination does not change the database source.
        </Text>
        <Text style={[styles.bodyText, { color: colors.textSecondary }]}>Creates an encrypted archive of LabTrax records and available media attachments.</Text>
        <View style={styles.stack}>
          <Text style={[styles.label, { color: colors.textSecondary }]}>Destination</Text>
          <ChoiceRow options={[
            { value: "local", label: "Local / USB" },
            { value: "network", label: "Network · SFTP" },
            { value: "onedrive", label: "OneDrive" },
            { value: "google-drive", label: "Google Drive" },
          ]} value={manualDestination} onChange={(value: Destination) => { setManualDestination(value); setManualError(null); setManualResult(null); }} testID="manual-backup-destination" styles={styles} colors={colors} />
          {manualDestination === "local" ? (
            <Notice styles={styles} colors={colors} tone="info" testID="browser-local-backup-note">
              Browser local / USB backup downloads the encrypted archive through your browser. It cannot write to an arbitrary folder, USB drive, or UNC/SMB share. Direct folder selection requires LabTrax Desktop. When a local schedule is enabled, Desktop can keep its per-user background companion running from the system tray while its window is closed.
            </Notice>
          ) : null}
          {manualDestination === "network" ? (
            <View style={styles.stack}>
              <Text style={[styles.label, { color: colors.textSecondary }]}>SFTP destination URL</Text>
              <TextInput value={manualPath} onChangeText={setManualPath} placeholder="sftp://user@host/path" autoCapitalize="none" autoCorrect={false} testID="manual-backup-path" style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]} placeholderTextColor={colors.textTertiary} />
              <Text style={[styles.helperText, { color: colors.textTertiary }]}>Server-side SFTP only. Browser backups cannot write to UNC/SMB paths. Do not embed a password in the URL.</Text>
            </View>
          ) : null}
          {manualDestination === "onedrive" ? (
            <Notice styles={styles} colors={colors} tone={oneDriveConnected ? "success" : "warning"} testID="manual-onedrive-status">
              {oneDriveConnected ? `Manual run uploads to ${oneDriveQuery.data?.folder ?? "the connected OneDrive folder"}.` : "Connect OneDrive before running a manual backup."}
            </Notice>
          ) : null}
          {manualDestination === "google-drive" ? (
            <Notice styles={styles} colors={colors} tone={googleDriveConnected ? "success" : "warning"} testID="manual-google-drive-status">
              {googleDriveConnected ? `Manual run uploads to ${googleDriveQuery.data?.folder ?? "the connected Google Drive folder"}.` : "Connect Google Drive before running a manual backup."}
            </Notice>
          ) : null}
          {manualBusy && manualPhase ? <Text testID="manual-backup-progress" style={[styles.bodyText, { color: colors.textSecondary }]}>{manualPhase}</Text> : null}
          {manualError ? <Notice styles={styles} colors={colors} tone="error" testID="manual-backup-error">{manualError}</Notice> : null}
          {manualResult ? (
            <Notice styles={styles} colors={colors} tone={manualResult.partialFailure ? "warning" : "success"} testID="manual-backup-result">
              <Text style={[styles.noticeTitle, { color: manualResult.partialFailure ? colors.warning : colors.tint }]}>{manualResult.partialFailure ? "Backup completed with warnings" : "Backup complete"}</Text>
              <Text style={[styles.bodyText, { color: colors.text }]}>
                {manualResult.viaBrowser ? "Browser download started" : "Server-side backup finished"} · {manualResult.fileName} · {sizeLabel(manualResult.size)} · {dateLabel(manualResult.completedAt)}
              </Text>
              {manualResult.partialFailure ? (
                <View>
                  <Text style={[styles.warningText, { color: colors.warning }]}>
                    {manualResult.warningMessage ?? "The backup finished, but some content was left out. This is not a complete recovery point, and restoring it will not recover the missing content."}
                  </Text>
                  {manualResult.warnings ? <DiagnosticDetails text={manualResult.warnings} styles={styles} colors={colors} /> : null}
                </View>
              ) : null}
            </Notice>
          ) : null}
          <ActionButton
            label={manualBusy ? "Backing up…" : "Back up now"}
            icon={manualBusy ? undefined : "cloud-download-outline"}
            busy={manualBusy}
            disabled={!manualReady}
            onPress={() => void startManualBackup()}
            testID="manual-backup-run"
            styles={styles}
            colors={colors}
          />
        </View>
      </SettingsSection>

      <SettingsSection title="Routine backup schedule">
        <Text style={[styles.bodyText, { color: colors.textSecondary }]}>Configure the editable routine independently from the dedicated off-site protection job shown above.</Text>
        {scheduleQuery.isLoading ? <View style={styles.inlineLoading}><ActivityIndicator size="small" color={colors.tint} /><Text style={[styles.bodyText, { color: colors.textSecondary }]}>Loading saved schedule…</Text></View> : (
          <View style={styles.stack}>
            <View style={styles.toggleLine}>
              <View style={styles.flex}>
                <Text style={[styles.fieldLabel, { color: colors.text }]}>Enable routine backups</Text>
                <Text style={[styles.helperText, { color: colors.textSecondary }]}>New schedules remain off until you explicitly enable and save them.</Text>
              </View>
              <Switch value={scheduleEnabled} onValueChange={setScheduleEnabled} trackColor={{ false: colors.border, true: colors.tint }} thumbColor="#fff" testID="schedule-enabled-switch" />
            </View>
            <Text style={[styles.label, { color: colors.textSecondary }]}>Frequency</Text>
            <ChoiceRow options={availableFrequencies.map((frequency) => ({ value: `${frequency.interval}_${frequency.unit}`, label: frequency.label }))} value={`${scheduleFrequency.interval}_${scheduleFrequency.unit}`} onChange={(value: string) => {
              const selected = availableFrequencies.find((frequency) => `${frequency.interval}_${frequency.unit}` === value);
              if (selected) setScheduleFrequency(selected);
            }} testID="schedule-frequency" styles={styles} colors={colors} />
            {legacyFrequency ? <Text style={[styles.helperText, { color: colors.warning }]} testID="schedule-legacy-frequency">The saved interval is not one of the current choices. It is preserved as-is until you select a different interval and save.</Text> : null}
            <View style={styles.stack}>
              <Text style={[styles.label, { color: colors.textSecondary }]}>Routine destination</Text>
              <ChoiceRow options={[
                { value: "local", label: "Local folder / USB" },
                { value: "network", label: "Network · SFTP" },
                { value: "onedrive", label: "OneDrive" },
                { value: "google-drive", label: "Google Drive" },
              ]} value={scheduleDestination} onChange={setScheduleDestination} testID="schedule-destination" styles={styles} colors={colors} />
            </View>
            {scheduleDestination !== "onedrive" && scheduleDestination !== "google-drive" ? (
              <View style={styles.stack}>
                <Text style={[styles.label, { color: colors.textSecondary }]}>{scheduleDestination === "local" ? "Folder path" : "SFTP URL"}</Text>
                <TextInput value={schedulePath} onChangeText={setSchedulePath} placeholder={scheduleDestination === "local" ? "C:\\Backups\\LabTrax" : "sftp://user@host/backups"} autoCapitalize="none" autoCorrect={false} testID="schedule-path" style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]} placeholderTextColor={colors.textTertiary} />
                <Text style={[styles.helperText, { color: colors.textTertiary }]}>
                  {scheduleDestination === "local"
                     ? "Local / USB schedules are executed by the LabTrax Desktop background companion while your laptop account is signed in. Close the window to keep it in the system tray; sleep, sign-out, shutdown, or a disconnected drive pauses the run."
                    : "Server-side scheduled network backups support SFTP only. UNC/SMB is not writable from the server."}
                </Text>
              </View>
            ) : (
              <Text style={[styles.helperText, { color: colors.textSecondary }]}>{scheduleDestination === "onedrive" ? "OneDrive routine runs are server-side." : "Google Drive routine runs are server-side."} This cadence remains independent from off-site protection.</Text>
            )}
            <View style={styles.numberGrid}>
              <NumberField label="Overdue after" suffix="days" value={staleDays} onChange={setStaleDays} testID="schedule-stale-days" styles={styles} colors={colors} />
              <NumberField label="Alert threshold" suffix="days" value={alertThreshold} onChange={setAlertThreshold} testID="schedule-alert-threshold" styles={styles} colors={colors} />
              <NumberField label="Re-alert every" suffix="days" value={alertRateLimit} onChange={setAlertRateLimit} testID="schedule-alert-rate-limit" styles={styles} colors={colors} />
            </View>
            {scheduleMessage ? <Notice styles={styles} colors={colors} tone={scheduleMessage.tone} testID="schedule-save-message">{scheduleMessage.text}</Notice> : null}
            <View style={styles.buttonRow}>
              <ActionButton label={scheduleBusy ? "Saving…" : "Save schedule"} busy={scheduleBusy} icon="save-outline" disabled={scheduleBusy || !schedule || ((scheduleDestination !== "onedrive" && scheduleDestination !== "google-drive") && !schedulePath.trim())} onPress={() => void saveRoutineSchedule()} testID="schedule-save" styles={styles} colors={colors} />
              {schedule?.enabled ? <ActionButton label="Disable routine" icon="pause-outline" disabled={scheduleBusy} onPress={() => void disableRoutineSchedule()} testID="schedule-disable" styles={styles} colors={colors} variant="secondary" /> : null}
            </View>
            <View style={[styles.runNowPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <Text style={[styles.fieldLabel, { color: colors.text }]}>Test saved schedule</Text>
              <Text style={[styles.helperText, { color: colors.textSecondary }]}>Run now uses the saved server destination. Local folder / USB schedules require the Desktop app and cannot be triggered from this browser.</Text>
              {scheduleRunError ? <Text style={[styles.warningText, { color: colors.error }]} testID="schedule-run-error">{scheduleRunError}</Text> : null}
              {scheduleRunResult ? (
                <Notice styles={styles} colors={colors} tone={scheduleRunResult.partialFailure ? "warning" : "success"} testID="schedule-run-result">
                  {scheduleRunResult.partialFailure ? "Scheduled backup completed with warnings" : "Scheduled backup complete"} · {scheduleRunResult.fileName} · {sizeLabel(scheduleRunResult.size)}
                  {scheduleRunResult.partialFailure ? (
                    <View>
                      <Text style={[styles.warningText, { color: colors.warning }]}>
                        {scheduleRunResult.warningMessage ?? "The backup finished, but some content was left out. This is not a complete recovery point."}
                      </Text>
                      {scheduleRunResult.warnings ? <DiagnosticDetails text={scheduleRunResult.warnings} styles={styles} colors={colors} /> : null}
                    </View>
                  ) : null}
                </Notice>
              ) : null}
              <ActionButton label={scheduleRunBusy ? "Running…" : "Run now"} icon={scheduleRunBusy ? undefined : "play-outline"} busy={scheduleRunBusy} disabled={scheduleRunBusy || !canRunSavedSchedule || !schedule?.enabled} onPress={() => void runScheduledBackupNow()} testID="schedule-run-now" styles={styles} colors={colors} variant="secondary" />
            </View>
          </View>
        )}
      </SettingsSection>

      <SettingsSection title="History retention">
        {retentionQuery.isLoading ? <View style={styles.inlineLoading}><ActivityIndicator size="small" color={colors.tint} /><Text style={[styles.bodyText, { color: colors.textSecondary }]}>Loading retention…</Text></View> : retentionQuery.isError ? (
          <Notice styles={styles} colors={colors} tone="error" testID="retention-load-error">Retention controls could not be loaded. {(retentionQuery.error as Error)?.message}</Notice>
        ) : (
          <View style={styles.stack}>
            <View style={styles.numberGrid}>
              <NumberField label="Keep history for" suffix="days" value={retentionDays} onChange={setRetentionDays} testID="retention-days" styles={styles} colors={colors} />
              <NumberField label="Maximum history" suffix="rows" value={maxRows} onChange={setMaxRows} testID="retention-max-rows" styles={styles} colors={colors} />
            </View>
            <Text style={[styles.helperText, { color: colors.textTertiary }]}>Older entries are pruned automatically after a backup run; whichever limit removes more rows wins.</Text>
            {retentionMessage ? <Text style={[styles.helperText, { color: retentionMessage.includes("saved") ? colors.tint : colors.error }]} testID="retention-save-message">{retentionMessage}</Text> : null}
            <ActionButton label={retentionBusy ? "Saving…" : "Save retention"} icon="save-outline" busy={retentionBusy} disabled={retentionBusy} onPress={() => void saveRetention()} testID="retention-save" styles={styles} colors={colors} variant="secondary" />
          </View>
        )}
      </SettingsSection>

      <SettingsSection title={`Recent backups${historyQuery.data?.runs ? ` · ${history.length}` : ""}`}>
        {historyQuery.isLoading ? (
          <View style={styles.inlineLoading} testID="history-loading"><ActivityIndicator size="small" color={colors.tint} /><Text style={[styles.bodyText, { color: colors.textSecondary }]}>Loading recent runs…</Text></View>
        ) : historyQuery.isError ? (
          <View style={styles.stack}>
            <Text style={[styles.bodyText, { color: colors.error }]} testID="history-error">Could not load backup history: {(historyQuery.error as Error)?.message}</Text>
            <ActionButton label="Retry history" icon="refresh-outline" onPress={() => void historyQuery.refetch()} testID="history-retry" styles={styles} colors={colors} variant="secondary" />
          </View>
        ) : history.length === 0 ? (
          <View style={styles.emptyState} testID="history-empty">
            <Ionicons name="archive-outline" size={22} color={colors.textTertiary} />
            <Text style={[styles.fieldLabel, { color: colors.text }]}>No backups recorded yet</Text>
            <Text style={[styles.helperText, { color: colors.textSecondary }]}>Run an encrypted backup to create the first recovery point.</Text>
          </View>
        ) : (
          <View style={styles.stack}>
            {history.slice(0, 20).map((run) => (
              <HistoryRow key={run.id} run={run} selected={selectedRunId === run.id} onSelect={() => { setSelectedRunId(selectedRunId === run.id ? null : run.id); setHistoryError(null); }} styles={styles} colors={colors} />
            ))}
            {historyError ? <Text style={[styles.warningText, { color: colors.error }]} testID="history-restore-error">{historyError}</Text> : null}
            <View style={styles.buttonRow}>
              <ActionButton
                label={historyRestoreBusy ? "Loading archive…" : "Restore selected"}
                icon={historyRestoreBusy ? undefined : "refresh-outline"}
                busy={historyRestoreBusy}
                disabled={!selectedRun || selectedRun.status !== "success" || historyRestoreBusy || restoreBusy || isDatabaseOnly(selectedRun)}
                onPress={() => void restoreSelectedHistory()}
                testID="history-restore-selected"
                styles={styles}
                colors={colors}
                variant="danger"
              />
              {selectedRun?.destination === "onedrive" ? <ActionButton label="Download archive" icon="download-outline" disabled={!selectedRun || selectedRun.status !== "success"} onPress={async () => {
                if (!selectedRun) return;
                try {
                  const file = await downloadHistoryRun(selectedRun);
                  downloadBlob(await file.arrayBuffer(), file.name);
                } catch (error) {
                  setHistoryError(error instanceof Error ? error.message : "Download failed.");
                }
              }} testID="history-download" styles={styles} colors={colors} variant="secondary" /> : null}
            </View>
            {selectedRun && isDatabaseOnly(selectedRun) ? <Text style={[styles.warningText, { color: colors.warning }]} testID="history-database-only-refusal">Database-only archive — no media. This record cannot be used as a full restore source.</Text> : null}
          </View>
        )}
      </SettingsSection>

      <SettingsSection title="Restore from backup">
        <View style={styles.stack}>
          <Text style={[styles.bodyText, { color: colors.textSecondary }]}>Restore a LabTrax encrypted .zip.enc archive. All current lab data and media will be replaced, and signed-in users will be logged out.</Text>
          <View style={styles.buttonRow}>
            <ActionButton label="Choose backup file" icon="document-outline" disabled={restoreBusy} onPress={chooseBackupFile} testID="restore-choose-file" styles={styles} colors={colors} variant="secondary" />
            {selectedFile ? <Text style={[styles.mono, styles.flex]} numberOfLines={1}>{selectedFile.name}</Text> : null}
          </View>
          <ActionButton label="Restore file" icon="refresh-outline" disabled={!selectedFile || restoreBusy} onPress={() => { setRestoreError(null); setConfirmStep(1); setRestoreOpen(true); }} testID="restore-file-start" styles={styles} colors={colors} variant="danger" />
          {restoreOpen ? (
            <View style={[styles.restorePanel, { backgroundColor: colors.background, borderColor: colors.border }]} testID="restore-panel">
              <Text style={[styles.noticeTitle, { color: colors.error }]}>Confirm replacement of all lab data</Text>
              <Text style={[styles.bodyText, { color: colors.textSecondary }]}>Source: {selectedFile?.name ?? "No file selected"}. All cases, patients, doctors, financial records, attachments, users, and organization settings may be replaced. Users will be signed out.</Text>
              {confirmStep === 1 ? (
                <View style={styles.buttonRow}>
                  <ActionButton label="Cancel" onPress={() => { setConfirmStep(0); setRestoreOpen(false); }} testID="restore-cancel" styles={styles} colors={colors} variant="secondary" />
                  <ActionButton label="I understand — continue" onPress={() => setConfirmStep(2)} testID="restore-confirm-step-one" styles={styles} colors={colors} variant="danger" />
                </View>
              ) : confirmStep === 2 ? (
                <View style={styles.buttonRow}>
                  <ActionButton label="Cancel" onPress={() => { setConfirmStep(0); setRestoreOpen(false); }} testID="restore-cancel-final" styles={styles} colors={colors} variant="secondary" />
                  <ActionButton label="Yes, restore now" disabled={!selectedFile} onPress={() => void beginRestore()} testID="restore-confirm-final" styles={styles} colors={colors} variant="danger" />
                </View>
              ) : null}
            </View>
          ) : null}
          {restoreError ? (
            <Notice styles={styles} colors={colors} tone="error" testID="restore-error">
              <Text style={[styles.bodyText, { color: colors.error }]}>{restoreError}</Text>
              {restoreDiagnostic ? <DiagnosticDetails text={restoreDiagnostic} styles={styles} colors={colors} /> : null}
            </Notice>
          ) : null}
          {restorePhase !== "idle" ? (
            <View style={styles.stack} testID="restore-progress">
              <Text style={[styles.fieldLabel, { color: restorePhase === "error" ? colors.error : colors.text }]}>{RESTORE_LABELS[restorePhase]}{restorePhase === "uploading" ? ` · ${restoreProgress}%` : ""}</Text>
              {restoreMessage ? <Text style={[styles.helperText, { color: colors.textSecondary }]}>{restoreMessage}</Text> : null}
              {restorePhase === "uploading" ? <View style={[styles.progressTrack, { backgroundColor: colors.border }]}><View style={[styles.progressFill, { backgroundColor: colors.tint, width: `${restoreProgress}%` }]} /></View> : null}
            </View>
          ) : null}
          {restoreSuccess ? <Notice styles={styles} colors={colors} tone="success" testID="restore-success">Restore complete. Sign in again to continue. The server restore job is complete.</Notice> : null}
        </View>
      </SettingsSection>
      <Text style={[styles.footer, { color: colors.textTertiary }]}>LabTrax backup operations are protected by the platform-admin session. Local and USB destinations are only written by LabTrax Desktop or downloaded through this browser.</Text>
    </ScrollView>
    </DismissKeyboardView>
  );
}

function Notice({ children, styles, colors, tone, testID }: any) {
  const border = tone === "error" ? colors.error : tone === "warning" ? colors.warning : tone === "success" ? colors.tint : colors.border;
  return <View style={[styles.notice, { backgroundColor: tone === "info" ? colors.surfaceAlt : `${border}14`, borderColor: `${border}66` }]} testID={testID}>{React.Children.map(children, (child) => typeof child === "string" || typeof child === "number" ? <Text style={[styles.bodyText, { color: colors.text }]}>{child}</Text> : child)}</View>;
}

function InlineAction({ label, onPress, testID, styles, colors }: any) {
  return <Pressable onPress={onPress} testID={testID} style={styles.inlineAction}><Text style={[styles.inlineActionText, { color: colors.tint }]}>{label}</Text></Pressable>;
}

function DiagnosticDetails({ text, styles, colors }: { text: string; styles: any; colors: any }) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable onPress={() => setOpen((value) => !value)} accessibilityRole="button">
        <Text style={[styles.helperText, { color: colors.tint }]}>
          {open ? "Hide failure details" : "Show failure details"}
        </Text>
      </Pressable>
      {open ? <Text style={[styles.helperText, { color: colors.textTertiary }]}>{text}</Text> : null}
    </View>
  );
}

function ActionButton({ label, icon, onPress, disabled, busy, testID, styles, colors, variant = "primary" }: any) {
  const danger = variant === "danger";
  const secondary = variant === "secondary";
  return (
    <Pressable onPress={onPress} disabled={disabled || busy} testID={testID} accessibilityRole="button" accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }} style={({ pressed }) => [
      styles.actionButton,
      { backgroundColor: danger ? `${colors.error}18` : secondary ? colors.surfaceAlt : colors.tint, borderColor: danger ? `${colors.error}75` : secondary ? colors.border : colors.tint },
      (disabled || busy) && styles.disabled,
      pressed && !disabled && styles.pressed,
    ]}>
      {busy ? <ActivityIndicator size="small" color={secondary ? colors.tint : danger ? colors.error : "#fff"} /> : icon ? <Ionicons name={icon} size={15} color={danger ? colors.error : secondary ? colors.tint : "#fff"} /> : null}
      <Text style={[styles.buttonText, { color: danger ? colors.error : secondary ? colors.text : "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

function ChoiceRow({ options, value, onChange, testID, styles, colors }: any) {
  return <View style={styles.choiceRow} testID={testID}>
    {options.map((option: { value: string; label: string }) => {
      const selected = value === option.value;
      return <Pressable key={option.value} onPress={() => onChange(option.value)} accessibilityRole="radio" accessibilityState={{ selected }} testID={`${testID}-${option.value.replace(/[^a-z0-9]+/gi, "-")}`} style={[styles.choice, { backgroundColor: selected ? `${colors.tint}18` : colors.surfaceAlt, borderColor: selected ? colors.tint : colors.border }]}>
        <Text style={[styles.choiceText, { color: selected ? colors.tint : colors.textSecondary }]}>{option.label}</Text>
      </Pressable>;
    })}
  </View>;
}

function NumberField({ label, suffix, value, onChange, testID, styles, colors }: any) {
  return <View style={styles.numberField}>
    <Text style={[styles.label, { color: colors.textSecondary }]}>{label}</Text>
    <View style={styles.numberLine}>
      <TextInput value={value} onChangeText={onChange} keyboardType="number-pad" testID={testID} style={[styles.input, styles.numberInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]} />
      <Text style={[styles.helperText, { color: colors.textSecondary }]}>{suffix}</Text>
    </View>
  </View>;
}

function HudValue({ label, value, id, styles, colors }: any) {
  return <View style={styles.hudValue} testID={id}>
    <Text style={[styles.hudLabel, { color: colors.textTertiary }]}>{label}</Text>
    <Text style={[styles.hudValueText, { color: colors.text }]}>{value}</Text>
  </View>;
}

function Badge({ text, tone, styles, colors }: any) {
  const color = tone === "success" ? colors.tint : colors.warning;
  return <View style={[styles.badge, { backgroundColor: `${color}1c`, borderColor: `${color}55` }]}><Text style={[styles.badgeText, { color }]}>{text}</Text></View>;
}

function HistoryRow({ run, selected, onSelect, styles, colors }: { run: BackupRun; selected: boolean; onSelect: () => void; styles: any; colors: any }) {
  const isSuccess = run.status === "success";
  const noMedia = isSuccess && run.attachmentRowCount != null && run.attachmentRowCount > 0 && run.mediaFileCount === 0;
  const unknownEvidence = isSuccess && run.mediaFileCount == null && run.attachmentRowCount == null;
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  return (
    <View style={[styles.historyItem, { borderColor: selected ? colors.tint : colors.border, backgroundColor: selected ? `${colors.tint}10` : colors.surfaceAlt }]} testID={`backup-history-${run.id}`}>
      <Pressable onPress={onSelect} accessibilityRole="radio" accessibilityState={{ selected }} testID={`backup-history-select-${run.id}`} style={styles.historySelect}>
        <View style={[styles.selectionMark, { borderColor: selected ? colors.tint : colors.textTertiary, backgroundColor: selected ? colors.tint : "transparent" }]} />
        <View style={styles.flex}>
          <View style={styles.historyHeadline}>
            <Text style={[styles.historyStatus, { color: isSuccess ? colors.tint : colors.error }]}>{isSuccess ? "OK" : run.status === "skipped" ? "SKIPPED" : "ERROR"}</Text>
            <Text style={[styles.helperText, { color: colors.textSecondary }]}>{dateLabel(run.completedAt)}</Text>
          </View>
          <Text style={[styles.historyFile, { color: colors.text }]} numberOfLines={1}>{run.fileName ?? "Archive name unavailable"}</Text>
          <Text style={[styles.helperText, { color: colors.textSecondary }]}>{run.destination}{run.path ? ` · ${run.path}` : ""} · {sizeLabel(run.sizeBytes)} · {run.triggeredBy}</Text>
          <View style={styles.badgeRow}>
            {run.partialFailure ? <EvidenceBadge text="PARTIAL" tone="warning" styles={styles} colors={colors} testID={`backup-partial-${run.id}`} /> : null}
            {isDatabaseOnly(run) ? <EvidenceBadge text="DATABASE ONLY · NO MEDIA" tone="warning" styles={styles} colors={colors} testID={`backup-database-only-${run.id}`} /> : null}
            {noMedia ? <EvidenceBadge text="NO MEDIA FOUND" tone="warning" styles={styles} colors={colors} testID={`backup-no-media-${run.id}`} /> : null}
            {unknownEvidence ? <EvidenceBadge text="MEDIA EVIDENCE UNKNOWN" tone="neutral" styles={styles} colors={colors} testID={`backup-media-unknown-${run.id}`} /> : null}
          </View>
          {run.error ? (
            <View style={styles.stack}>
              <Text style={[styles.warningText, { color: colors.error }]}>
                {run.userMessage ?? "The backup did not complete, so no new complete recovery point was created."}
              </Text>
              <Pressable onPress={() => setShowErrorDetails((visible) => !visible)} accessibilityRole="button">
                <Text style={[styles.helperText, { color: colors.tint }]}>
                  {showErrorDetails ? "Hide failure details" : "Show failure details"}
                </Text>
              </Pressable>
              {showErrorDetails ? <Text style={[styles.helperText, { color: colors.textTertiary }]}>{run.error}</Text> : null}
            </View>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}

function EvidenceBadge({ text, tone, styles, colors, testID }: any) {
  const color = tone === "warning" ? colors.warning : colors.textSecondary;
  return <View style={[styles.evidenceBadge, { backgroundColor: `${color}18`, borderColor: `${color}44` }]} testID={testID}><Text style={[styles.evidenceText, { color }]}>{text}</Text></View>;
}

function makeStyles(colors: any) {
  return StyleSheet.create({
    page: { padding: Spacing.lg, paddingBottom: Spacing.xxxl, gap: Spacing.lg, maxWidth: 1080, width: "100%", alignSelf: "center" },
    heading: { flexDirection: "row", alignItems: "center", gap: Spacing.md, paddingBottom: Spacing.xs },
    headingMark: { width: 42, height: 42, borderRadius: Radius.md, backgroundColor: `${colors.tint}18`, alignItems: "center", justifyContent: "center" },
    headingCopy: { flex: 1, gap: 2 },
    title: { ...Typography.h1 },
    subtitle: { ...Typography.caption },
    bodyText: { ...Typography.caption, lineHeight: 19 },
    noticeTitle: { ...Typography.bodyMedium },
    helperText: { ...Typography.caption, lineHeight: 17 },
    label: { ...Typography.captionMedium },
    fieldLabel: { ...Typography.bodyMedium },
    mono: { ...Typography.caption, fontFamily: "monospace" },
    stack: { gap: Spacing.md, padding: Spacing.md },
    loadingCard: { minHeight: 64, borderWidth: 1, borderRadius: Radius.md, flexDirection: "row", alignItems: "center", gap: Spacing.md, padding: Spacing.lg },
    inlineLoading: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, padding: Spacing.md },
    notice: { borderWidth: 1, borderRadius: Radius.md, padding: Spacing.md, gap: Spacing.xs },
    hud: { padding: Spacing.md, gap: Spacing.md },
    hudTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    hudEyebrow: { ...Typography.captionMedium, letterSpacing: 1.1, fontSize: 10 },
    refreshButton: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 5, paddingHorizontal: 7 },
    refreshText: { ...Typography.captionMedium },
    hudGrid: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.md },
    hudValue: { flexGrow: 1, flexBasis: 190, gap: 4, padding: Spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: Radius.sm, backgroundColor: colors.surfaceAlt },
    hudLabel: { ...Typography.caption, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.7 },
    hudValueText: { ...Typography.bodySemibold },
    hudDivider: { height: StyleSheet.hairlineWidth },
    offsiteRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: Spacing.md },
    offsiteCopy: { flex: 1, gap: 3 },
    warningText: { ...Typography.caption, lineHeight: 18 },
    archiveEvidence: { marginTop: Spacing.xs, padding: Spacing.md, borderRadius: Radius.sm, backgroundColor: colors.surfaceAlt, gap: 4 },
    archiveName: { ...Typography.bodySemibold, fontFamily: "monospace" },
    emptyState: { alignItems: "center", gap: Spacing.sm, padding: Spacing.xl },
    connectionRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    buttonRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: Spacing.sm },
    actionButton: { minHeight: 38, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Spacing.xs },
    buttonText: { ...Typography.captionMedium },
    disabled: { opacity: 0.48 },
    pressed: { opacity: 0.8 },
    inlineAction: { paddingTop: Spacing.xs, alignSelf: "flex-start" },
    inlineActionText: { ...Typography.captionMedium, textDecorationLine: "underline" },
    choiceRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
    choice: { borderWidth: 1, borderRadius: Radius.full, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
    choiceText: { ...Typography.captionMedium },
    toggleLine: { flexDirection: "row", alignItems: "center", gap: Spacing.md, paddingHorizontal: Spacing.sm, paddingVertical: Spacing.xs },
    flex: { flex: 1, minWidth: 0 },
    input: { minHeight: 40, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, ...Typography.body },
    numberGrid: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.md },
    numberField: { flexGrow: 1, flexBasis: 150, gap: Spacing.xs },
    numberLine: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    numberInput: { width: 82, minHeight: 38 },
    runNowPanel: { borderWidth: 1, borderRadius: Radius.md, padding: Spacing.md, gap: Spacing.sm },
    badge: { borderWidth: 1, borderRadius: Radius.full, paddingHorizontal: Spacing.sm, paddingVertical: 4 },
    badgeText: { ...Typography.captionMedium, fontSize: 9, letterSpacing: 0.7 },
    historyItem: { borderWidth: 1, borderRadius: Radius.md, padding: Spacing.md },
    historySelect: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.md },
    selectionMark: { height: 17, width: 17, borderRadius: Radius.full, borderWidth: 1, marginTop: 2 },
    historyHeadline: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: Spacing.sm },
    historyStatus: { ...Typography.captionMedium, fontSize: 10, letterSpacing: 0.6 },
    historyFile: { ...Typography.captionMedium, fontFamily: "monospace", marginTop: 3 },
    badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: Spacing.xs },
    evidenceBadge: { borderWidth: 1, borderRadius: Radius.full, paddingHorizontal: 7, paddingVertical: 3 },
    evidenceText: { ...Typography.captionMedium, fontSize: 9, letterSpacing: 0.4 },
    restorePanel: { borderWidth: 1, borderRadius: Radius.md, padding: Spacing.md, gap: Spacing.md },
    progressTrack: { height: 5, borderRadius: Radius.full, overflow: "hidden" },
    progressFill: { height: "100%", borderRadius: Radius.full },
    footer: { ...Typography.caption, lineHeight: 17, textAlign: "center", paddingHorizontal: Spacing.md },
  });
}
