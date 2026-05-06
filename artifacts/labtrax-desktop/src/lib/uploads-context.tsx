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

export type UploadStatus = "queued" | "uploading" | "success" | "error";

export interface UploadEntry {
  id: string;
  file: File;
  note: string;
  status: UploadStatus;
  errorMessage?: string;
  serverId?: string;
  organizationId: string;
  uploaderName: string;
  progress: number;
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

export function UploadsProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<UploadEntry[]>([]);
  const entriesRef = useRef<UploadEntry[]>([]);
  const clearTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const canceledIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    const timers = clearTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const scheduleAutoClear = useCallback((id: string) => {
    const timers = clearTimersRef.current;
    const existing = timers.get(id);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      timers.delete(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    }, COMPLETED_RETAIN_MS);
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

  const uploadEntry = useCallback(
    async (entry: UploadEntry) => {
      cancelAutoClear(entry.id);
      canceledIdsRef.current.delete(entry.id);
      const controller = new AbortController();
      controllersRef.current.set(entry.id, controller);
      setEntries((prev) =>
        prev.map((e) =>
          e.id === entry.id
            ? { ...e, status: "uploading", errorMessage: undefined, progress: 0 }
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
              ? { ...e, status: "error", errorMessage: "Upload failed. Please try again." }
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
        fileName: entry.file.name,
        mimeType: entry.file.type || "application/octet-stream",
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
                }
              : e,
          ),
        );
        scheduleAutoClear(entry.id);
        return;
      }

      setEntries((prev) =>
        prev.map((e) =>
          e.id === entry.id ? { ...e, status: "success", serverId, progress: 100 } : e,
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
            note: "",
            status: "queued",
            organizationId,
            uploaderName,
            progress: 0,
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
      if (!entry || entry.status !== "error") return;
      uploadEntry(entry);
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
    }),
    [entries, activeCount, addFiles, removeEntry, cancelEntry, updateNote, commitNote, retryEntry],
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
