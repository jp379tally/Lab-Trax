import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileText,
  Inbox,
  Loader2,
  Paperclip,
  X,
} from "lucide-react";
import {
  useListLabInboxFiles,
  useAssignLabInboxFile,
  getListLabInboxFilesQueryKey,
} from "@workspace/api-client-react";
import type { LabInboxFile } from "@workspace/api-client-react";
import {
  apiFetch,
  ApiError,
  createUploadSession,
  sendUploadChunk,
} from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { relativeTime } from "@/lib/format";
import type { LabCase } from "@/lib/types";

const MAX_FILE_BYTES = 200 * 1024 * 1024;
const SIZE_ERROR = "File is too large. Max upload size is 200 MB.";
const GENERIC_ERROR = "Upload failed. Please try again.";

function sanitizeUploadError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 413) return SIZE_ERROR;
    const msg = err.message ?? "";
    if (isHtml(msg)) return GENERIC_ERROR;
    return msg || GENERIC_ERROR;
  }
  if (err instanceof Error) {
    const msg = err.message ?? "";
    if (isHtml(msg)) return GENERIC_ERROR;
    return msg || GENERIC_ERROR;
  }
  const msg = String(err ?? "");
  if (isHtml(msg)) return GENERIC_ERROR;
  return msg || GENERIC_ERROR;
}

function isHtml(s: string): boolean {
  const t = s.trimStart().toLowerCase();
  return t.startsWith("<html") || t.startsWith("<!doctype");
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

function fileIcon(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "🖼";
  if (mimeType === "application/pdf") return "📄";
  if (mimeType.includes("word") || mimeType.includes("document")) return "📝";
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return "📊";
  return "📎";
}

function InboxFileRow({
  file,
  cases,
  casesLoading,
  onAssigned,
}: {
  file: LabInboxFile;
  cases: LabCase[];
  casesLoading: boolean;
  onAssigned: (caseId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [assigned, setAssigned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCaseIdRef = useRef<string>("");

  const assignMutation = useAssignLabInboxFile({
    mutation: {
      onSuccess: () => {
        setAssigned(true);
        setTimeout(() => onAssigned(pendingCaseIdRef.current), 800);
      },
      onError: (err: Error) => {
        setError(err.message || "Failed to assign.");
      },
    },
  });

  const filtered = cases.filter((c) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      (c.caseNumber ?? "").toLowerCase().includes(q) ||
      (c.patientFirstName ?? "").toLowerCase().includes(q) ||
      (c.patientLastName ?? "").toLowerCase().includes(q) ||
      (c.doctorName ?? "").toLowerCase().includes(q)
    );
  });

  const handleAssign = (caseId: string) => {
    setError(null);
    pendingCaseIdRef.current = caseId;
    assignMutation.mutate({ fileId: file.id, data: { caseId } });
    setOpen(false);
    setQuery("");
  };

  const uploaderName =
    file.uploaderFirstName && file.uploaderLastName
      ? `${file.uploaderFirstName} ${file.uploaderLastName}`
      : file.uploaderUsername ?? "Unknown";

  return (
    <div className="flex items-start gap-2.5 py-2.5 border-b border-border/40 last:border-0 group">
      <span
        className="text-base leading-none mt-0.5 shrink-0"
        title={file.mimeType}
      >
        {fileIcon(file.mimeType)}
      </span>

      <div className="flex-1 min-w-0">
        <p
          className="text-xs font-medium truncate"
          title={file.originalFilename}
        >
          {file.originalFilename}
        </p>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          {formatBytes(file.sizeBytes)} · {uploaderName} ·{" "}
          {relativeTime(file.createdAt)}
        </p>

        {assigned ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-green-600 dark:text-green-400 mt-1">
            <CheckCircle2 size={10} />
            Assigned
          </span>
        ) : error ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-destructive mt-1">
            <AlertCircle size={10} />
            {error}
          </span>
        ) : null}

        {open && (
          <div className="mt-2 relative">
            <input
              ref={inputRef}
              autoFocus
              type="text"
              placeholder="Search cases…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full text-xs border border-border rounded-md px-2.5 py-1.5 bg-background placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {casesLoading ? (
              <div className="mt-1 rounded-md border border-border bg-popover shadow-md p-2 text-xs text-muted-foreground flex items-center gap-1.5">
                <Loader2 size={11} className="animate-spin" />
                Loading cases…
              </div>
            ) : filtered.length === 0 ? (
              <div className="mt-1 rounded-md border border-border bg-popover shadow-md p-2 text-xs text-muted-foreground">
                No cases found.
              </div>
            ) : (
              <div className="mt-1 rounded-md border border-border bg-popover shadow-md overflow-hidden max-h-44 overflow-y-auto">
                {filtered.slice(0, 20).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => handleAssign(c.id)}
                    disabled={assignMutation.isPending}
                    className="w-full text-left px-2.5 py-2 text-xs hover:bg-secondary transition-colors disabled:opacity-60 flex flex-col gap-0.5"
                  >
                    <span className="font-medium">
                      {c.caseNumber ? `#${c.caseNumber}` : c.id.slice(0, 8)}{" "}
                      {c.patientFirstName} {c.patientLastName}
                    </span>
                    {c.doctorName && (
                      <span className="text-muted-foreground text-[10px]">
                        {c.doctorName}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {!assigned && (
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            if (!open) setTimeout(() => inputRef.current?.focus(), 50);
          }}
          disabled={assignMutation.isPending}
          title={open ? "Cancel" : "Assign to case"}
          className="shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded text-[10px] font-medium border border-border bg-secondary hover:bg-secondary/70 text-foreground transition-colors disabled:opacity-60 disabled:cursor-not-allowed mt-0.5"
        >
          {assignMutation.isPending ? (
            <Loader2 size={9} className="animate-spin" />
          ) : open ? (
            <X size={9} />
          ) : (
            <Paperclip size={9} />
          )}
          {open ? "Cancel" : "Assign"}
        </button>
      )}
    </div>
  );
}

type FileUploadState = {
  progress: number;
  error: string | null;
};

export function UnassignedDocumentsCard() {
  const { user } = useAuth();
  const labOrganizationId = user?.practiceOrganizationId ?? "";
  const qc = useQueryClient();

  const [isDragging, setIsDragging] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<string, FileUploadState>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const filesQuery = useListLabInboxFiles(
    { labOrganizationId },
    {
      query: {
        queryKey: getListLabInboxFilesQueryKey({ labOrganizationId }),
        enabled: !!labOrganizationId,
        refetchInterval: 60_000,
      },
    },
  );

  const [cases, setCases] = useState<LabCase[]>([]);
  const [casesLoading, setCasesLoading] = useState(false);
  const casesLoadedRef = useRef(false);

  const ensureCasesLoaded = useCallback(() => {
    if (casesLoadedRef.current) return;
    casesLoadedRef.current = true;
    setCasesLoading(true);
    apiFetch<LabCase[]>("/cases")
      .then((data) => setCases(data))
      .catch(() => setCases([]))
      .finally(() => setCasesLoading(false));
  }, []);

  const setFileProgress = useCallback(
    (key: string, state: FileUploadState | null) => {
      setUploadProgress((prev) => {
        if (state === null) {
          const next = { ...prev };
          delete next[key];
          return next;
        }
        return { ...prev, [key]: state };
      });
    },
    [],
  );

  const uploadFileInChunks = useCallback(
    async (file: File) => {
      const key = `${file.name}-${file.size}`;

      // Client-side size guard: show friendly error before hitting the network.
      if (file.size > MAX_FILE_BYTES) {
        setFileProgress(key, { progress: 0, error: SIZE_ERROR });
        return;
      }

      if (!labOrganizationId) {
        setFileProgress(key, { progress: 0, error: "No lab organization found." });
        return;
      }

      setFileProgress(key, { progress: 0, error: null });

      try {
        // 1. Create a resumable session.
        const session = await createUploadSession({
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || "application/octet-stream",
        });

        let offset = session.uploadedBytes ?? 0;
        const CHUNK = 8 * 1024 * 1024;

        // 2. Send chunks.
        while (offset < file.size) {
          const end = Math.min(offset + CHUNK, file.size);
          const blob = file.slice(offset, end);

          const result = await sendUploadChunk(session.sessionId, blob, offset, {
            onChunkProgress: (bytesInChunk) => {
              const totalSoFar = offset + bytesInChunk;
              setFileProgress(key, {
                progress: Math.min(98, Math.round((totalSoFar / file.size) * 100)),
                error: null,
              });
            },
          });

          offset = result.uploadedBytes;

          if (result.complete) {
            // 3. Register the completed file in the inbox.
            setFileProgress(key, { progress: 99, error: null });
            await apiFetch("/lab-inbox/finalize-session", {
              method: "POST",
              body: JSON.stringify({
                storagePath: result.filename,
                originalFilename: file.name,
                mimeType: file.type || "application/octet-stream",
                sizeBytes: file.size,
                labOrganizationId,
              }),
            });

            // 4. Success: remove progress entry and refresh inbox list.
            setFileProgress(key, null);
            void qc.invalidateQueries({
              queryKey: getListLabInboxFilesQueryKey({ labOrganizationId }),
            });
            return;
          }
        }
      } catch (err: unknown) {
        setFileProgress(key, { progress: 0, error: sanitizeUploadError(err) });
      }
    },
    [labOrganizationId, qc, setFileProgress],
  );

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      const arr = Array.from(files);
      for (const file of arr) {
        void uploadFileInChunks(file);
      }
    },
    [uploadFileInChunks],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles],
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
      e.target.value = "";
    }
  };

  const handleAssigned = (caseId: string) => {
    void qc.invalidateQueries({
      queryKey: getListLabInboxFilesQueryKey({ labOrganizationId }),
    });
    if (caseId) {
      void qc.invalidateQueries({ queryKey: ["case", caseId] });
    }
    toast({
      title: "Document assigned",
      description: "The file has been added to the case.",
    });
  };

  const files = filesQuery.data?.data ?? [];
  const count = files.length;

  const inFlightEntries = Object.entries(uploadProgress);
  const isUploading = inFlightEntries.some(([, s]) => s.error === null);

  return (
    <section className="bg-card border border-border rounded-xl">
      <header
        className="flex items-center gap-2 px-5 py-3.5 border-b border-border cursor-pointer select-none hover:bg-secondary/30 transition-colors rounded-t-xl"
        onClick={() => setCollapsed((v) => !v)}
      >
        <Inbox size={14} className="text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            Unassigned Documents
            {count > 0 && (
              <span className="inline-flex items-center justify-center h-4.5 min-w-[18px] px-1 rounded-full text-[10px] font-semibold bg-amber-500 text-white tabular-nums leading-none">
                {count}
              </span>
            )}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {filesQuery.isLoading
              ? "Loading…"
              : count === 0
              ? "No files waiting"
              : `${count} file${count === 1 ? "" : "s"} waiting to be assigned`}
          </p>
        </div>
        <button
          type="button"
          aria-label={collapsed ? "Expand" : "Collapse"}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((v) => !v);
          }}
        >
          {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
      </header>

      {!collapsed && (
        <div className="px-5 py-4 space-y-3">
          {/* Drop zone */}
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileInputRef.current?.click()}
            className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed cursor-pointer transition-colors py-5 ${
              isDragging
                ? "border-primary bg-primary/5"
                : "border-border/60 hover:border-border hover:bg-secondary/30"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="sr-only"
              onChange={handleFileInput}
            />
            {isUploading ? (
              <Loader2
                size={18}
                className="animate-spin text-muted-foreground"
              />
            ) : (
              <FileText size={18} className="text-muted-foreground" />
            )}
            <p className="text-xs text-muted-foreground text-center">
              {isUploading
                ? "Uploading…"
                : isDragging
                ? "Drop to upload"
                : "Add a file or a picture"}
            </p>
          </div>

          {/* Per-file upload progress */}
          {inFlightEntries.length > 0 && (
            <div className="space-y-2">
              {inFlightEntries.map(([key, state]) => {
                const displayName = key.replace(/-\d+$/, "");
                return (
                  <div key={key} className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] text-muted-foreground truncate flex-1 min-w-0">
                        {displayName}
                      </span>
                      {state.error ? (
                        <span className="text-[10px] text-destructive shrink-0">
                          Error
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                          {state.progress}%
                        </span>
                      )}
                    </div>
                    {state.error ? (
                      <div className="flex items-start gap-1.5 text-xs text-destructive">
                        <AlertCircle size={12} className="shrink-0 mt-0.5" />
                        {state.error}
                      </div>
                    ) : (
                      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                        <div
                          className="h-full rounded-full bg-primary transition-all duration-200"
                          style={{ width: `${state.progress}%` }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* File list */}
          {filesQuery.isLoading && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground py-2">
              <Loader2 size={12} className="animate-spin" />
              Loading…
            </div>
          )}

          {!filesQuery.isLoading && count === 0 && (
            <p className="text-xs text-muted-foreground py-1">
              No unassigned documents yet.
            </p>
          )}

          {count > 0 && (
            <div
              className="max-h-64 overflow-y-auto -mx-1 px-1"
              onClick={ensureCasesLoaded}
            >
              {files.map((file) => (
                <InboxFileRow
                  key={file.id}
                  file={file}
                  cases={cases}
                  casesLoading={casesLoading}
                  onAssigned={handleAssigned}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
