import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  apiFetch,
  ApiError,
  createUploadSession,
  deleteUploadSession,
  getUploadSessionStatus,
  sendUploadChunk,
} from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import {
  deleteHandle,
  loadHandle,
  saveHandle,
  type PersistedHandle,
} from "@/lib/upload-handles";

export type FileWithHandle = { file: File; handle?: PersistedHandle };

const ACCEPTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/bmp",
  "image/tiff",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
  "application/pdf",
  // 3D scan formats
  "model/stl",
  "model/obj",
  "model/ply",
  "application/octet-stream",
  "application/sla",
  "application/vnd.ms-pki.stl",
]);

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const COMPLETED_RETAIN_MS = 60_000;
const STORAGE_KEY_PREFIX = "labtrax-desktop:uploads:v2:";
const LEGACY_STORAGE_KEY = "labtrax-desktop:uploads:v1";
const INTERRUPTED_RETAIN_MS = 24 * 60 * 60 * 1000;

function storageKeyFor(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

function cleanupLegacyStorage(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export type UploadStatus =
  | "queued"
  | "uploading"
  | "success"
  | "error"
  | "interrupted";

export interface UploadEntry {
  id: string;
  file: File | null;
  fileName: string;
  fileSize: number;
  mimeType: string;
  note: string;
  status: UploadStatus;
  errorMessage?: string;
  serverId?: string;
  organizationId: string;
  uploaderName: string;
  progress: number;
  createdAt: number;
  completedAt?: number;
  // Resumable upload state. `sessionId` survives reloads via localStorage so
  // that re-picking the file resumes from `uploadedBytes` instead of byte 0.
  sessionId?: string;
  uploadedBytes?: number;
}

export interface UploadRejection {
  id: string;
  name: string;
  reason: string;
}

interface AddFilesResult {
  accepted: number;
  rejections: UploadRejection[];
}

interface ResumeResult {
  ok: boolean;
  reason?: string;
}

interface UploadsContextValue {
  entries: UploadEntry[];
  activeCount: number;
  addFiles: (
    files: FileList | File[] | FileWithHandle[],
    opts: { organizationId: string; uploaderName: string },
  ) => AddFilesResult;
  removeEntry: (id: string) => void;
  cancelEntry: (id: string) => void;
  updateNote: (id: string, note: string) => void;
  commitNote: (id: string) => void;
  retryEntry: (id: string) => void;
  resumeEntry: (id: string, file: File) => ResumeResult;
  /**
   * Ask the browser for read permission on the saved File System Access
   * handle for an interrupted entry, then auto-resume the upload from the
   * server's confirmed offset. Returns false when the browser/handle/permission
   * isn't available; caller should fall back to the manual file picker.
   */
  requestResumePermission: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * True when an interrupted entry has a saved file handle we can use to
   * resume without a file picker. Used by the UI to choose between the
   * "Resume" button and the "Re-pick file to resume" fallback.
   */
  hasResumeHandle: (id: string) => boolean;
}

const UploadsContext = createContext<UploadsContextValue | null>(null);

function isAcceptedType(mime: string): boolean {
  // Accept files with no MIME type (common for .stl / .obj on Windows)
  if (!mime || mime === "") return true;
  if (ACCEPTED_MIME_TYPES.has(mime)) return true;
  if (mime.startsWith("image/")) return true;
  if (mime.startsWith("video/")) return true;
  if (mime.startsWith("model/")) return true;
  return false;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateFile(file: File): string | null {
  if (!isAcceptedType(file.type)) {
    return "File type not accepted. Please upload images, videos, PDFs, or 3D scans.";
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `File is too large (${formatBytes(file.size)}). Maximum size is 10 MB.`;
  }
  return null;
}

const CHUNK_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB
const MAX_CHUNK_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ResumableUploadResult {
  url: string | null;
  sessionId: string | null;
  /** True when the user/code aborted, so callers can suppress error UI. */
  aborted: boolean;
  /** Highest server-confirmed offset reached; useful for "interrupted" state. */
  uploadedBytes: number;
  /** True when the session is gone server-side (404) and we should drop it. */
  sessionLost: boolean;
}

interface ResumableUploadInput {
  file: File;
  initialSessionId?: string;
  initialUploadedBytes?: number;
  onProgress: (uploadedBytes: number) => void;
  /**
   * Fired as soon as we know the sessionId we'll be uploading against —
   * either the resumed one (after status check) or a freshly created one.
   * Callers persist this immediately so a refresh mid-upload can resume.
   */
  onSessionReady: (sessionId: string) => void;
  /**
   * Fired after every chunk the SERVER has confirmed (i.e. the offset
   * advanced). Callers persist this so resume starts from the last known
   * server-confirmed byte after a refresh.
   */
  onChunkCommitted: (uploadedBytes: number) => void;
  signal: AbortSignal;
}

/**
 * Upload a file in 1 MB chunks against the resumable /media/upload-session
 * endpoints. Survives transient network errors by re-querying the server's
 * confirmed offset and resuming from there. The caller persists the
 * `sessionId` so a page refresh can resume from the last server-confirmed
 * byte instead of restarting at zero.
 */
async function uploadFileResumable(input: ResumableUploadInput): Promise<ResumableUploadResult> {
  const { file, onProgress, onSessionReady, onChunkCommitted, signal } = input;
  let sessionId = input.initialSessionId ?? null;
  let confirmedBytes = input.initialUploadedBytes ?? 0;
  // Track the last sessionId we have already announced so we don't fire the
  // callback (and trigger React re-renders / localStorage writes) for every
  // single chunk loop iteration.
  let announcedSessionId: string | null = null;
  const announceSession = (id: string) => {
    if (announcedSessionId === id) return;
    announcedSessionId = id;
    onSessionReady(id);
  };

  const isAborted = () => signal.aborted;

  // Make sure we have a session, and reconcile the offset with the server.
  if (sessionId) {
    // Re-announce the resumed session right away so the entry's persisted
    // sessionId stays correct even before the first chunk lands.
    announceSession(sessionId);
    try {
      const status = await getUploadSessionStatus(sessionId);
      confirmedBytes = Math.min(status.uploadedBytes, file.size);
      if (status.fileSize !== file.size) {
        // The picked file doesn't match the saved session; start fresh.
        await deleteUploadSession(sessionId);
        sessionId = null;
        confirmedBytes = 0;
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        sessionId = null;
        confirmedBytes = 0;
      } else if (isAborted()) {
        return { url: null, sessionId, aborted: true, uploadedBytes: confirmedBytes, sessionLost: false };
      } else {
        // Treat unknown errors as transient — fall through and try to create a
        // new session below.
        sessionId = null;
        confirmedBytes = 0;
      }
    }
  }

  if (!sessionId) {
    try {
      const created = await createUploadSession({
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || "application/octet-stream",
      });
      sessionId = created.sessionId;
      confirmedBytes = created.uploadedBytes ?? 0;
      // Persist the new session id IMMEDIATELY so a refresh that happens
      // before the first chunk completes can still resume.
      announceSession(sessionId);
    } catch (err) {
      if (isAborted()) {
        return { url: null, sessionId: null, aborted: true, uploadedBytes: 0, sessionLost: false };
      }
      return { url: null, sessionId: null, aborted: false, uploadedBytes: 0, sessionLost: false };
    }
  }

  onProgress(confirmedBytes);

  let consecutiveFailures = 0;

  while (confirmedBytes < file.size) {
    if (isAborted()) {
      return { url: null, sessionId, aborted: true, uploadedBytes: confirmedBytes, sessionLost: false };
    }
    const chunkEnd = Math.min(confirmedBytes + CHUNK_SIZE_BYTES, file.size);
    const blob = file.slice(confirmedBytes, chunkEnd);
    const chunkStart = confirmedBytes;
    try {
      const result = await sendUploadChunk(sessionId, blob, chunkStart, {
        signal,
        onChunkProgress: (bytesInChunk) => {
          // Report best-effort live progress. The "confirmed" advance only
          // happens once the chunk request succeeds.
          onProgress(Math.min(file.size, chunkStart + bytesInChunk));
        },
      });
      confirmedBytes = Math.min(file.size, result.uploadedBytes);
      onProgress(confirmedBytes);
      // Persist the new server-confirmed offset so a refresh resumes from the
      // most recent committed byte, not from zero.
      onChunkCommitted(confirmedBytes);
      consecutiveFailures = 0;
      if (result.complete) {
        return {
          url: result.url ?? null,
          sessionId,
          aborted: false,
          uploadedBytes: confirmedBytes,
          sessionLost: false,
        };
      }
    } catch (err) {
      if (isAborted()) {
        return { url: null, sessionId, aborted: true, uploadedBytes: confirmedBytes, sessionLost: false };
      }
      // 404 means the session was reaped or never existed; fail hard so the
      // caller can decide to start a brand new session next time.
      if (err instanceof ApiError && err.status === 404) {
        return { url: null, sessionId: null, aborted: false, uploadedBytes: 0, sessionLost: true };
      }
      // 409 = client/server offset mismatch. The server attached the real
      // offset to the error so we can resync and keep going.
      if (err instanceof ApiError && err.status === 409) {
        const reportedOffset = (err as ApiError & { uploadedBytes?: number }).uploadedBytes;
        if (typeof reportedOffset === "number") {
          confirmedBytes = Math.min(file.size, reportedOffset);
          onProgress(confirmedBytes);
          continue;
        }
      }
      consecutiveFailures += 1;
      if (consecutiveFailures > MAX_CHUNK_RETRIES) {
        return { url: null, sessionId, aborted: false, uploadedBytes: confirmedBytes, sessionLost: false };
      }
      // Re-query the server to find out how much actually landed before the
      // failure, then back off and retry from there.
      try {
        const status = await getUploadSessionStatus(sessionId);
        confirmedBytes = Math.min(file.size, status.uploadedBytes);
        onProgress(confirmedBytes);
      } catch (statusErr) {
        if (statusErr instanceof ApiError && statusErr.status === 404) {
          return { url: null, sessionId: null, aborted: false, uploadedBytes: 0, sessionLost: true };
        }
        // Ignore — we'll retry the chunk anyway after the backoff.
      }
      await delay(RETRY_BASE_DELAY_MS * Math.pow(2, consecutiveFailures - 1));
    }
  }

  // Body is fully uploaded but server didn't return `complete:true` (e.g.
  // because the last chunk landed during a retry). Ask the server to confirm.
  try {
    const status = await getUploadSessionStatus(sessionId);
    if (status.uploadedBytes >= file.size) {
      // Session still exists but file isn't finalized; treat as failure so the
      // caller surfaces an error rather than silently dropping the file.
      return { url: null, sessionId, aborted: false, uploadedBytes: file.size, sessionLost: false };
    }
  } catch {
    /* ignore */
  }
  return { url: null, sessionId, aborted: false, uploadedBytes: confirmedBytes, sessionLost: false };
}

async function registerPendingFile(params: {
  organizationId: string;
  fileUrl: string;
  fileName: string;
  mimeType: string;
  notes: string;
  uploaderName: string;
}): Promise<string | null> {
  try {
    const result = await apiFetch<{ file?: { id: string } }>("/lab-pending-files", {
      method: "POST",
      body: JSON.stringify(params),
    });
    return result?.file?.id ?? null;
  } catch {
    return null;
  }
}

async function patchPendingFileNote(serverId: string, notes: string): Promise<void> {
  try {
    await apiFetch(`/lab-pending-files/${serverId}`, {
      method: "PATCH",
      body: JSON.stringify({ notes }),
    });
  } catch {
    // best-effort
  }
}

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type PersistedEntry = Omit<UploadEntry, "file" | "progress">;

function isPersistableStatus(_status: UploadStatus): boolean {
  return true;
}

function loadPersisted(userId: string | null): UploadEntry[] {
  if (typeof window === "undefined" || !userId) return [];
  try {
    const raw = window.localStorage.getItem(storageKeyFor(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    const restored: UploadEntry[] = [];
    for (const item of parsed as PersistedEntry[]) {
      if (
        !item ||
        typeof item.id !== "string" ||
        typeof item.fileName !== "string" ||
        typeof item.organizationId !== "string"
      ) {
        continue;
      }
      // In-flight entries from a previous session are now interrupted.
      let status: UploadStatus = item.status;
      if (status !== "success" && status !== "error" && status !== "interrupted") {
        status = "interrupted";
      }
      // Drop expired completions/errors so the indicator stays clean.
      if (status === "success" && item.completedAt && now - item.completedAt > COMPLETED_RETAIN_MS) {
        continue;
      }
      if (status === "error" && item.completedAt && now - item.completedAt > COMPLETED_RETAIN_MS) {
        continue;
      }
      if (status === "interrupted" && item.createdAt && now - item.createdAt > INTERRUPTED_RETAIN_MS) {
        continue;
      }
      const fileSize = typeof item.fileSize === "number" ? item.fileSize : 0;
      const uploadedBytes =
        typeof item.uploadedBytes === "number"
          ? Math.max(0, Math.min(item.uploadedBytes, fileSize))
          : 0;
      const restoredProgress =
        status === "success"
          ? 100
          : fileSize > 0
            ? Math.min(99, Math.floor((uploadedBytes / fileSize) * 100))
            : 0;
      restored.push({
        id: item.id,
        file: null,
        progress: restoredProgress,
        fileName: item.fileName,
        fileSize,
        mimeType: typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream",
        note: typeof item.note === "string" ? item.note : "",
        status,
        errorMessage:
          status === "interrupted"
            ? typeof item.sessionId === "string" && uploadedBytes > 0
              ? `Upload paused at ${Math.round((uploadedBytes / Math.max(1, fileSize)) * 100)}%. Re-pick the file to resume.`
              : "Upload interrupted by page refresh. Re-pick the file to retry."
            : item.errorMessage,
        serverId: typeof item.serverId === "string" ? item.serverId : undefined,
        organizationId: item.organizationId,
        uploaderName: typeof item.uploaderName === "string" ? item.uploaderName : "",
        createdAt: typeof item.createdAt === "number" ? item.createdAt : now,
        completedAt: typeof item.completedAt === "number" ? item.completedAt : undefined,
        sessionId: typeof item.sessionId === "string" ? item.sessionId : undefined,
        uploadedBytes,
      });
    }
    return restored;
  } catch {
    return [];
  }
}

function persistEntries(entries: UploadEntry[], userId: string | null): void {
  if (typeof window === "undefined" || !userId) return;
  const key = storageKeyFor(userId);
  try {
    const toSave = entries
      .filter((e) => isPersistableStatus(e.status))
      .map<PersistedEntry>((e) => ({
        id: e.id,
        fileName: e.fileName,
        fileSize: e.fileSize,
        mimeType: e.mimeType,
        note: e.note,
        status: e.status,
        errorMessage: e.errorMessage,
        serverId: e.serverId,
        organizationId: e.organizationId,
        uploaderName: e.uploaderName,
        createdAt: e.createdAt,
        completedAt: e.completedAt,
        sessionId: e.sessionId,
        uploadedBytes: e.uploadedBytes,
      }));
    if (toSave.length === 0) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(toSave));
    }
  } catch {
    // ignore quota errors etc.
  }
}

export function UploadsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const userIdRef = useRef<string | null>(userId);
  const [entries, setEntries] = useState<UploadEntry[]>(() => loadPersisted(userId));
  const entriesRef = useRef<UploadEntry[]>(entries);
  const clearTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const canceledIdsRef = useRef<Set<string>>(new Set());
  // In-memory cache of File System Access handles (also persisted in
  // IndexedDB) so the UI can synchronously decide whether to show "Resume"
  // vs the "Re-pick file" fallback for an interrupted entry.
  const handleCacheRef = useRef<Map<string, PersistedHandle>>(new Map());
  // Mirrors the keys of handleCacheRef in component state so UI consumers
  // (e.g. `hasResumeHandle`) re-render when handles are loaded asynchronously
  // from IndexedDB at startup.
  const [handleIds, setHandleIds] = useState<Set<string>>(() => new Set());
  const rememberHandle = useCallback((id: string, handle: PersistedHandle) => {
    handleCacheRef.current.set(id, handle);
    setHandleIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);
  const forgetHandle = useCallback((id: string) => {
    if (!handleCacheRef.current.has(id) && !handleIds.has(id)) return;
    handleCacheRef.current.delete(id);
    setHandleIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, [handleIds]);
  const startupResumeAttemptedRef = useRef(false);

  // One-time cleanup of any pre-scoping persisted data.
  useEffect(() => {
    cleanupLegacyStorage();
  }, []);

  useEffect(() => {
    entriesRef.current = entries;
    persistEntries(entries, userIdRef.current);
  }, [entries]);

  // When the authenticated user changes (login, logout, switch), reset
  // in-memory state and reload from the new user's scoped storage so we
  // don't leak filenames/notes across accounts on a shared browser.
  useEffect(() => {
    // Cancel any pending auto-clear timers from the previous user's session.
    const timers = clearTimersRef.current;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();

    userIdRef.current = userId;
    const next = loadPersisted(userId);
    entriesRef.current = next;
    setEntries(next);
  }, [userId]);

  useEffect(() => {
    const timers = clearTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const scheduleAutoClear = useCallback((id: string, delay = COMPLETED_RETAIN_MS) => {
    const timers = clearTimersRef.current;
    const existing = timers.get(id);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      timers.delete(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    }, Math.max(0, delay));
    timers.set(id, handle);
  }, []);

  const cancelAutoClear = useCallback((id: string) => {
    const timers = clearTimersRef.current;
    const existing = timers.get(id);
    if (existing) {
      clearTimeout(existing);
      timers.delete(id);
    }
  }, []);

  // After mount, re-arm auto-clear timers for restored success/error entries.
  useEffect(() => {
    const now = Date.now();
    for (const entry of entriesRef.current) {
      if ((entry.status === "success" || entry.status === "error") && entry.completedAt) {
        const remaining = COMPLETED_RETAIN_MS - (now - entry.completedAt);
        scheduleAutoClear(entry.id, remaining);
      }
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uploadEntry = useCallback(
    async (entry: UploadEntry) => {
      if (!entry.file) return;
      const file = entry.file;
      cancelAutoClear(entry.id);
      canceledIdsRef.current.delete(entry.id);
      const controller = new AbortController();
      controllersRef.current.set(entry.id, controller);
      const initialUploadedBytes = Math.min(entry.uploadedBytes ?? 0, file.size);
      const initialProgress =
        file.size > 0 ? Math.min(99, Math.floor((initialUploadedBytes / file.size) * 100)) : 0;
      setEntries((prev) =>
        prev.map((e) =>
          e.id === entry.id
            ? {
                ...e,
                status: "uploading",
                errorMessage: undefined,
                progress: initialProgress,
                uploadedBytes: initialUploadedBytes,
                completedAt: undefined,
              }
            : e,
        ),
      );

      const result = await uploadFileResumable({
        file,
        initialSessionId: entry.sessionId,
        initialUploadedBytes,
        signal: controller.signal,
        onProgress: (uploadedBytes) => {
          const clamped = Math.max(0, Math.min(uploadedBytes, file.size));
          const percent =
            file.size > 0 ? Math.min(99, Math.floor((clamped / file.size) * 100)) : 0;
          setEntries((prev) =>
            prev.map((e) => {
              if (e.id !== entry.id) return e;
              if (e.status !== "uploading") return e;
              const next: UploadEntry = { ...e };
              if (percent > e.progress) next.progress = percent;
              if (clamped > (e.uploadedBytes ?? 0)) next.uploadedBytes = clamped;
              return next;
            }),
          );
        },
        // Persist the sessionId the moment we know it, so a refresh that
        // happens BEFORE the upload finishes can still resume from the
        // server's tracked state instead of re-uploading from byte 0.
        onSessionReady: (sid) => {
          setEntries((prev) =>
            prev.map((e) => (e.id === entry.id && e.sessionId !== sid ? { ...e, sessionId: sid } : e)),
          );
        },
        // Persist the latest server-confirmed offset after every chunk so
        // resume after refresh starts at the last committed byte.
        onChunkCommitted: (uploadedBytes) => {
          const clamped = Math.max(0, Math.min(uploadedBytes, file.size));
          setEntries((prev) =>
            prev.map((e) =>
              e.id === entry.id && (e.uploadedBytes ?? 0) < clamped
                ? { ...e, uploadedBytes: clamped }
                : e,
            ),
          );
        },
      });
      controllersRef.current.delete(entry.id);

      if (canceledIdsRef.current.has(entry.id) || controller.signal.aborted || result.aborted) {
        canceledIdsRef.current.delete(entry.id);
        // Reap the partial server-side session so we don't leak storage
        // until the 7-day pruner runs. Use the freshest sessionId we know:
        // either the one the upload reported back, or whatever the entry
        // had persisted before the cancel.
        const sidToReap = result.sessionId ?? entry.sessionId;
        if (sidToReap) {
          void deleteUploadSession(sidToReap);
        }
        forgetHandle(entry.id);
        void deleteHandle(entry.id);
        setEntries((prev) => prev.filter((e) => e.id !== entry.id));
        return;
      }

      // Persist whatever progress / sessionId the server confirmed so the
      // next attempt (retry, resume after refresh) can pick up from there.
      const persistedSessionId = result.sessionLost ? undefined : result.sessionId ?? undefined;
      const persistedUploadedBytes = result.sessionLost ? 0 : result.uploadedBytes;

      if (!result.url) {
        setEntries((prev) =>
          prev.map((e) =>
            e.id === entry.id
              ? {
                  ...e,
                  status: "error",
                  errorMessage:
                    persistedUploadedBytes > 0 && persistedSessionId
                      ? `Upload paused at ${Math.round((persistedUploadedBytes / Math.max(1, file.size)) * 100)}% — connection issue. Retry to continue.`
                      : "Upload failed. Please try again.",
                  completedAt: Date.now(),
                  sessionId: persistedSessionId,
                  uploadedBytes: persistedUploadedBytes,
                }
              : e,
          ),
        );
        scheduleAutoClear(entry.id);
        return;
      }
      const fileUrl = result.url;

      const currentNote =
        entriesRef.current.find((e) => e.id === entry.id)?.note ?? "";

      const serverId = await registerPendingFile({
        organizationId: entry.organizationId,
        fileUrl,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        notes: currentNote,
        uploaderName: entry.uploaderName,
      });

      if (!serverId) {
        setEntries((prev) =>
          prev.map((e) =>
            e.id === entry.id
              ? {
                  ...e,
                  status: "error",
                  errorMessage:
                    "File uploaded but could not be registered. Please retry.",
                  completedAt: Date.now(),
                }
              : e,
          ),
        );
        scheduleAutoClear(entry.id);
        return;
      }

      setEntries((prev) =>
        prev.map((e) =>
          e.id === entry.id
            ? {
                ...e,
                status: "success",
                serverId,
                progress: 100,
                completedAt: Date.now(),
                // Session was finalized server-side; clear the local handle.
                sessionId: undefined,
                uploadedBytes: file.size,
              }
            : e,
        ),
      );
      // Once finalized, the persisted file handle is no longer needed.
      forgetHandle(entry.id);
      void deleteHandle(entry.id);
      scheduleAutoClear(entry.id);
    },
    [cancelAutoClear, scheduleAutoClear, forgetHandle],
  );

  const addFiles = useCallback<UploadsContextValue["addFiles"]>(
    (files, { organizationId, uploaderName }) => {
      // Normalize the input so callers can pass plain Files or
      // {file, handle} pairs (handle is the FileSystemFileHandle from
      // showOpenFilePicker / drop's getAsFileSystemHandle()).
      const list: FileWithHandle[] = [];
      const raw = Array.from(files as ArrayLike<File | FileWithHandle>);
      for (const item of raw) {
        if (item instanceof File) {
          list.push({ file: item });
        } else if (item && typeof item === "object" && "file" in item) {
          list.push({ file: item.file, handle: item.handle });
        }
      }

      const valid: Array<{ entry: UploadEntry; handle?: PersistedHandle }> = [];
      const rejections: UploadRejection[] = [];

      for (const { file, handle } of list) {
        const error = validateFile(file);
        if (error) {
          rejections.push({ id: genId(), name: file.name, reason: error });
        } else {
          valid.push({
            entry: {
              id: genId(),
              file,
              fileName: file.name,
              fileSize: file.size,
              mimeType: file.type || "application/octet-stream",
              note: "",
              status: "queued",
              organizationId,
              uploaderName,
              progress: 0,
              createdAt: Date.now(),
            },
            handle,
          });
        }
      }

      if (valid.length > 0) {
        setEntries((prev) => [...prev, ...valid.map((v) => v.entry)]);
        for (const { entry, handle } of valid) {
          if (handle) {
            // Persist the handle so a refresh mid-upload can re-bind the
            // file blob without making the user pick it again.
            void saveHandle(entry.id, handle);
            rememberHandle(entry.id, handle);
          }
          uploadEntry(entry);
        }
      }

      return { accepted: valid.length, rejections };
    },
    [uploadEntry, rememberHandle],
  );

  const dropEntry = useCallback((id: string) => {
    const entry = entriesRef.current.find((e) => e.id === id);
    if (entry?.sessionId && entry.status !== "success") {
      // Clean up the partial file on the server so we don't leak storage.
      void deleteUploadSession(entry.sessionId);
    }
    forgetHandle(id);
    void deleteHandle(id);
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }, [forgetHandle]);

  const removeEntry = useCallback(
    (id: string) => {
      cancelAutoClear(id);
      const controller = controllersRef.current.get(id);
      if (controller) {
        canceledIdsRef.current.add(id);
        controller.abort();
        return;
      }
      dropEntry(id);
    },
    [cancelAutoClear, dropEntry],
  );

  const cancelEntry = useCallback(
    (id: string) => {
      cancelAutoClear(id);
      const controller = controllersRef.current.get(id);
      if (controller) {
        canceledIdsRef.current.add(id);
        controller.abort();
        return;
      }
      dropEntry(id);
    },
    [cancelAutoClear, dropEntry],
  );

  const updateNote = useCallback((id: string, note: string) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, note } : e)));
  }, []);

  const commitNote = useCallback((id: string) => {
    const entry = entriesRef.current.find((e) => e.id === id);
    if (entry?.status === "success" && entry.serverId) {
      patchPendingFileNote(entry.serverId, entry.note);
    }
  }, []);

  const retryEntry = useCallback(
    (id: string) => {
      const entry = entriesRef.current.find((e) => e.id === id);
      if (!entry || entry.status !== "error" || !entry.file) return;
      uploadEntry(entry);
    },
    [uploadEntry],
  );

  const resumeEntry = useCallback<UploadsContextValue["resumeEntry"]>(
    (id, file) => {
      const entry = entriesRef.current.find((e) => e.id === id);
      if (!entry) return { ok: false, reason: "Upload no longer available." };
      if (entry.status !== "interrupted") {
        return { ok: false, reason: "Upload is not interrupted." };
      }
      if (file.name !== entry.fileName) {
        return {
          ok: false,
          reason: `Please pick the same file (${entry.fileName}).`,
        };
      }
      if (entry.fileSize > 0 && file.size !== entry.fileSize) {
        return {
          ok: false,
          reason: "Picked file size doesn't match the interrupted upload.",
        };
      }
      const validation = validateFile(file);
      if (validation) return { ok: false, reason: validation };

      const refreshed: UploadEntry = {
        ...entry,
        file,
        mimeType: file.type || entry.mimeType,
        fileSize: file.size,
        status: "queued",
        progress: 0,
        errorMessage: undefined,
      };
      setEntries((prev) => prev.map((e) => (e.id === id ? refreshed : e)));
      uploadEntry(refreshed);
      return { ok: true };
    },
    [uploadEntry],
  );

  // Try to resume an interrupted entry without making the user pick the file
  // again, by re-binding the saved File System Access handle. Returns false if
  // the browser doesn't support it, the handle is gone, or permission was
  // denied — the caller should fall back to the manual file picker.
  const resumeFromHandle = useCallback(
    async (id: string, requestPermissionIfNeeded: boolean): Promise<{ ok: boolean; reason?: string }> => {
      const entry = entriesRef.current.find((e) => e.id === id);
      if (!entry || entry.status !== "interrupted") {
        return { ok: false, reason: "Upload is not interrupted." };
      }
      let handle = handleCacheRef.current.get(id) ?? null;
      if (!handle) {
        handle = await loadHandle(id);
        if (handle) rememberHandle(id, handle);
      }
      if (!handle) return { ok: false, reason: "no-handle" };

      try {
        const queryOpts = { mode: "read" as const };
        let perm: PermissionState | undefined =
          (await handle.queryPermission?.(queryOpts)) ?? "prompt";
        if (perm !== "granted" && requestPermissionIfNeeded) {
          perm = (await handle.requestPermission?.(queryOpts)) ?? "denied";
        }
        if (perm !== "granted") return { ok: false, reason: "permission-denied" };

        const file = await handle.getFile();
        if (entry.fileSize > 0 && file.size !== entry.fileSize) {
          return { ok: false, reason: "File on disk no longer matches the interrupted upload." };
        }
        const refreshed: UploadEntry = {
          ...entry,
          file,
          mimeType: file.type || entry.mimeType,
          fileSize: file.size,
          status: "queued",
          progress: 0,
          errorMessage: undefined,
        };
        setEntries((prev) => prev.map((e) => (e.id === id ? refreshed : e)));
        uploadEntry(refreshed);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, reason: err?.message || "Could not access the saved file." };
      }
    },
    [uploadEntry, rememberHandle],
  );

  const requestResumePermission = useCallback<UploadsContextValue["requestResumePermission"]>(
    (id) => resumeFromHandle(id, true),
    [resumeFromHandle],
  );

  // Reads from the reactive `handleIds` Set so consumers re-render when
  // handles get loaded asynchronously from IndexedDB after mount.
  const hasResumeHandle = useCallback<UploadsContextValue["hasResumeHandle"]>(
    (id) => handleIds.has(id),
    [handleIds],
  );

  // After mount, look at every "interrupted" entry that still has a saved
  // sessionId and try to silently re-bind the file via its persisted File
  // System Access handle. If the browser still considers permission "granted"
  // (typical for handles obtained via showOpenFilePicker in the same origin
  // session window), the upload resumes from the server's confirmed offset
  // immediately — no user interaction at all.
  useEffect(() => {
    if (startupResumeAttemptedRef.current) return;
    startupResumeAttemptedRef.current = true;
    let cancelled = false;
    void (async () => {
      const snapshot = entriesRef.current;
      for (const entry of snapshot) {
        if (cancelled) return;
        if (entry.status !== "interrupted") continue;
        if (!entry.sessionId) continue;
        const handle = await loadHandle(entry.id);
        if (!handle) continue;
        rememberHandle(entry.id, handle);
        // Only try the silent path here — `requestPermission` requires a user
        // gesture, and we want page load to be passive.
        await resumeFromHandle(entry.id, false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeCount = useMemo(
    () => entries.filter((e) => e.status === "queued" || e.status === "uploading").length,
    [entries],
  );

  const value = useMemo<UploadsContextValue>(
    () => ({
      entries,
      activeCount,
      addFiles,
      removeEntry,
      cancelEntry,
      updateNote,
      commitNote,
      retryEntry,
      resumeEntry,
      requestResumePermission,
      hasResumeHandle,
    }),
    [
      entries,
      activeCount,
      addFiles,
      removeEntry,
      cancelEntry,
      updateNote,
      commitNote,
      retryEntry,
      resumeEntry,
      requestResumePermission,
      hasResumeHandle,
    ],
  );

  return <UploadsContext.Provider value={value}>{children}</UploadsContext.Provider>;
}

export function useUploads(): UploadsContextValue {
  const ctx = useContext(UploadsContext);
  if (!ctx) {
    throw new Error("useUploads must be used inside an UploadsProvider");
  }
  return ctx;
}
