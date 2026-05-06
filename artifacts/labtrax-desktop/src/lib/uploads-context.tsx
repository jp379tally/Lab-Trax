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
import { apiFetch, apiUploadWithProgress } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

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
    files: FileList | File[],
    opts: { organizationId: string; uploaderName: string },
  ) => AddFilesResult;
  removeEntry: (id: string) => void;
  cancelEntry: (id: string) => void;
  updateNote: (id: string, note: string) => void;
  commitNote: (id: string) => void;
  retryEntry: (id: string) => void;
  resumeEntry: (id: string, file: File) => ResumeResult;
}

const UploadsContext = createContext<UploadsContextValue | null>(null);

function isAcceptedType(mime: string): boolean {
  if (ACCEPTED_MIME_TYPES.has(mime)) return true;
  if (mime.startsWith("image/")) return true;
  if (mime.startsWith("video/")) return true;
  return false;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateFile(file: File): string | null {
  if (!isAcceptedType(file.type)) {
    return "File type not accepted. Please upload images, videos, or PDFs.";
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `File is too large (${formatBytes(file.size)}). Maximum size is 10 MB.`;
  }
  return null;
}

async function uploadFileToServer(
  file: File,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<string | null> {
  const formData = new FormData();
  formData.append("file", file, file.name);
  try {
    const result = await apiUploadWithProgress<{ url: string }>(
      "/media/upload",
      formData,
      { onProgress, signal },
    );
    return typeof result?.url === "string" ? result.url : null;
  } catch {
    return null;
  }
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
      restored.push({
        id: item.id,
        file: null,
        progress: 0,
        fileName: item.fileName,
        fileSize: typeof item.fileSize === "number" ? item.fileSize : 0,
        mimeType: typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream",
        note: typeof item.note === "string" ? item.note : "",
        status,
        errorMessage:
          status === "interrupted"
            ? "Upload interrupted by page refresh. Re-pick the file to retry."
            : item.errorMessage,
        serverId: typeof item.serverId === "string" ? item.serverId : undefined,
        organizationId: item.organizationId,
        uploaderName: typeof item.uploaderName === "string" ? item.uploaderName : "",
        createdAt: typeof item.createdAt === "number" ? item.createdAt : now,
        completedAt: typeof item.completedAt === "number" ? item.completedAt : undefined,
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
      setEntries((prev) =>
        prev.map((e) =>
          e.id === entry.id
            ? { ...e, status: "uploading", errorMessage: undefined, progress: 0, completedAt: undefined }
            : e,
        ),
      );

      const fileUrl = await uploadFileToServer(
        entry.file,
        (percent) => {
          setEntries((prev) =>
            prev.map((e) =>
              e.id === entry.id && e.status === "uploading" && percent > e.progress
                ? { ...e, progress: percent }
                : e,
            ),
          );
        },
        controller.signal,
      );
      controllersRef.current.delete(entry.id);

      if (canceledIdsRef.current.has(entry.id) || controller.signal.aborted) {
        canceledIdsRef.current.delete(entry.id);
        setEntries((prev) => prev.filter((e) => e.id !== entry.id));
        return;
      }

      if (!fileUrl) {
        setEntries((prev) =>
          prev.map((e) =>
            e.id === entry.id
              ? {
                  ...e,
                  status: "error",
                  errorMessage: "Upload failed. Please try again.",
                  completedAt: Date.now(),
                }
              : e,
          ),
        );
        scheduleAutoClear(entry.id);
        return;
      }

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
              }
            : e,
        ),
      );
      scheduleAutoClear(entry.id);
    },
    [cancelAutoClear, scheduleAutoClear],
  );

  const addFiles = useCallback<UploadsContextValue["addFiles"]>(
    (files, { organizationId, uploaderName }) => {
      const list = Array.from(files);
      const valid: UploadEntry[] = [];
      const rejections: UploadRejection[] = [];

      for (const file of list) {
        const error = validateFile(file);
        if (error) {
          rejections.push({ id: genId(), name: file.name, reason: error });
        } else {
          valid.push({
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
          });
        }
      }

      if (valid.length > 0) {
        setEntries((prev) => [...prev, ...valid]);
        for (const entry of valid) {
          uploadEntry(entry);
        }
      }

      return { accepted: valid.length, rejections };
    },
    [uploadEntry],
  );

  const removeEntry = useCallback(
    (id: string) => {
      cancelAutoClear(id);
      const controller = controllersRef.current.get(id);
      if (controller) {
        canceledIdsRef.current.add(id);
        controller.abort();
        return;
      }
      setEntries((prev) => prev.filter((e) => e.id !== id));
    },
    [cancelAutoClear],
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
      setEntries((prev) => prev.filter((e) => e.id !== id));
    },
    [cancelAutoClear],
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
    }),
    [entries, activeCount, addFiles, removeEntry, cancelEntry, updateNote, commitNote, retryEntry, resumeEntry],
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
