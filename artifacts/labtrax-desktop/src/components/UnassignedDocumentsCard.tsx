import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eye,
  FileText,
  Inbox,
  Loader2,
  Paperclip,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import {
  useListLabInboxFiles,
  useAssignLabInboxFile,
  useDeleteLabInboxFile,
  useBulkDeleteLabInboxFiles,
  useUpdateLabInboxFileNote,
  getListLabInboxFilesQueryKey,
} from "@workspace/api-client-react";
import type { LabInboxFile } from "@workspace/api-client-react";
import {
  ApiError,
  apiFetch,
  apiUrl,
  authedFetch,
  authedMediaFetch,
  createUploadSession,
  sendUploadChunk,
} from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { relativeTime } from "@/lib/format";
import { openFilePreviewWindow } from "@/lib/file-preview";

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

function fileIcon(mimeType: string | null | undefined): string {
  if (!mimeType) return "📎";
  if (mimeType.startsWith("image/")) return "🖼";
  if (mimeType === "application/pdf") return "📄";
  if (mimeType.includes("word") || mimeType.includes("document")) return "📝";
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return "📊";
  return "📎";
}

type QuickCase = {
  id: string;
  caseNumber: string;
  patientFirstName: string;
  patientLastName: string;
  doctorName: string;
  status: string;
};

function InboxFileRow({
  file,
  labOrganizationId,
  onAssigned,
  selectMode,
  selected,
  onToggleSelect,
  onDeleted,
}: {
  file: LabInboxFile;
  labOrganizationId: string;
  onAssigned: (caseId: string) => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onDeleted: (fileId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [assigned, setAssigned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<QuickCase[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [viewLoading, setViewLoading] = useState(false);
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(file.note ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCaseIdRef = useRef<string>("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const isNoteOnly = !file.storagePath;

  const deleteMutation = useDeleteLabInboxFile({
    mutation: {
      onSuccess: () => {
        onDeleted(file.id);
        toast({ title: isNoteOnly ? "Note deleted" : "File deleted", description: file.originalFilename ?? undefined });
      },
      onError: (err: Error) => {
        toast({
          title: "Could not delete file",
          description: err.message || "Please try again.",
          variant: "destructive",
        });
      },
    },
  });
  const qc = useQueryClient();
  const updateNoteMutation = useUpdateLabInboxFileNote({
    mutation: {
      onSuccess: () => {
        setIsEditingNote(false);
        void qc.invalidateQueries({
          queryKey: getListLabInboxFilesQueryKey({ labOrganizationId }),
        });
        toast({ title: "Note updated" });
      },
      onError: (err: Error) => {
        toast({
          title: "Could not save note",
          description: err.message || "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!open || query.length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query, labOrganizationId });
        const resp = await authedFetch(apiUrl(`/cases/quick-search?${params}`));
        if (resp.ok) {
          const json = (await resp.json()) as { ok: boolean; data: { cases: QuickCase[] } };
          setSearchResults(json.data?.cases ?? []);
        } else {
          setSearchResults([]);
        }
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open, labOrganizationId]);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

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

  const handleAssign = (caseId: string) => {
    setError(null);
    pendingCaseIdRef.current = caseId;
    assignMutation.mutate({ fileId: file.id, data: { caseId } });
    setOpen(false);
    setQuery("");
  };

  const handleView = async () => {
    if (viewLoading || isNoteOnly) return;
    setViewLoading(true);
    try {
      const resp = await authedMediaFetch(apiUrl(`/lab-inbox/${file.id}/file`));
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      const raw = await resp.blob();
      // Give the blob an explicit content type — a generic/missing type is
      // what makes browsers/Electron download instead of previewing inline.
      const contentType =
        file.mimeType ||
        resp.headers.get("content-type") ||
        "application/octet-stream";
      const blob =
        raw.type === contentType ? raw : new Blob([raw], { type: contentType });
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      // Keep the blob URL alive while the preview window uses it — it is
      // revoked on the next view or on unmount, never immediately.
      openFilePreviewWindow(url, contentType, file.originalFilename ?? "file");
    } catch {
      toast({ title: "Could not open file", description: "Please try again.", variant: "destructive" });
    } finally {
      setViewLoading(false);
    }
  };

  const uploaderName =
    file.uploaderFirstName && file.uploaderLastName
      ? `${file.uploaderFirstName} ${file.uploaderLastName}`
      : file.uploaderUsername ?? "Unknown";

  return (
    <div className="flex items-start gap-2.5 py-2.5 border-b border-border/40 last:border-0 group">
      {/* Checkbox (select mode) or file icon */}
      {selectMode ? (
        <button
          type="button"
          onClick={onToggleSelect}
          aria-label={selected ? "Deselect file" : "Select file"}
          className="shrink-0 mt-0.5 flex items-center justify-center h-4 w-4 rounded border border-border bg-background transition-colors"
          style={{ accentColor: "hsl(var(--primary))" }}
        >
          {selected && (
            <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3 text-primary" stroke="currentColor" strokeWidth={2.5}>
              <polyline points="2,6 5,9 10,3" />
            </svg>
          )}
        </button>
      ) : (
        <span
          className="text-base leading-none mt-0.5 shrink-0"
          title={file.mimeType ?? (isNoteOnly ? "Note only" : undefined)}
        >
          {isNoteOnly ? "💬" : fileIcon(file.mimeType)}
        </span>
      )}

      <div className="flex-1 min-w-0">
        {isNoteOnly ? (
          <p className="text-xs font-medium text-muted-foreground">Note only</p>
        ) : (
          <button
            type="button"
            onClick={handleView}
            disabled={viewLoading}
            className="text-xs font-medium truncate max-w-full text-left hover:underline hover:text-primary transition-colors disabled:opacity-60 disabled:cursor-wait"
            title={`Click to view: ${file.originalFilename ?? ""}`}
          >
            {viewLoading ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 size={10} className="animate-spin" />
                {file.originalFilename}
              </span>
            ) : (
              file.originalFilename
            )}
          </button>
        )}
        <p className="text-[10px] text-muted-foreground mt-0.5">
          {file.sizeBytes != null ? `${formatBytes(file.sizeBytes)} · ` : ""}{uploaderName} ·{" "}
          {relativeTime(file.createdAt)}
        </p>

        {/* Provider note — shown when the upload came from the provider portal */}
        {isEditingNote ? (
          <div className="mt-2 space-y-1.5">
            <textarea
              autoFocus
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
              placeholder="Optional note"
              maxLength={2000}
              rows={3}
              className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 text-xs placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setNoteDraft(file.note ?? "");
                  setIsEditingNote(false);
                }}
                disabled={updateNoteMutation.isPending}
                className="h-6 rounded border border-border px-2 text-[10px] font-medium hover:bg-secondary disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() =>
                  updateNoteMutation.mutate({
                    fileId: file.id,
                    data: { note: noteDraft.trim() || null },
                  })
                }
                disabled={updateNoteMutation.isPending}
                className="inline-flex h-6 min-w-12 items-center justify-center rounded bg-primary px-2 text-[10px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {updateNoteMutation.isPending ? <Loader2 size={9} className="animate-spin" /> : "Save"}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setNoteDraft(file.note ?? "");
              setIsEditingNote(true);
            }}
            className="mt-1 flex max-w-full items-center gap-1 text-left text-[10px] text-foreground/80 hover:text-primary"
            title={file.note ? "Edit note" : "Add note"}
          >
            <span className={file.note ? "italic line-clamp-3" : "text-muted-foreground"}>
              {file.note ? `“${file.note}”` : "Add note"}
            </span>
            <Pencil size={9} className="shrink-0" />
          </button>
        )}
        {(file as { linkedCaseIds?: string | null }).linkedCaseIds && (
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Cases: {(file as { linkedCaseIds?: string | null }).linkedCaseIds}
          </p>
        )}

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
              placeholder="Type to search cases…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full text-xs border border-border rounded-md px-2.5 py-1.5 bg-background placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {query.length < 2 ? (
              <div className="mt-1 rounded-md border border-border bg-popover shadow-md p-2 text-xs text-muted-foreground">
                Type at least 2 characters…
              </div>
            ) : isSearching ? (
              <div className="mt-1 rounded-md border border-border bg-popover shadow-md p-2 text-xs text-muted-foreground flex items-center gap-1.5">
                <Loader2 size={11} className="animate-spin" />
                Searching…
              </div>
            ) : searchResults.length === 0 ? (
              <div className="mt-1 rounded-md border border-border bg-popover shadow-md p-2 text-xs text-muted-foreground">
                No cases found.
              </div>
            ) : (
              <div className="mt-1 rounded-md border border-border bg-popover shadow-md overflow-hidden max-h-44 overflow-y-auto">
                {searchResults.map((c) => (
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

      {!assigned && !selectMode && (
        <div className="flex items-center gap-1 shrink-0 mt-0.5">
          {!isNoteOnly && (
            <button
              type="button"
              onClick={handleView}
              disabled={viewLoading}
              title="View file"
              className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-secondary border border-border transition-colors disabled:opacity-60 disabled:cursor-wait"
            >
              {viewLoading ? (
                <Loader2 size={9} className="animate-spin" />
              ) : (
                <Eye size={9} />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => deleteMutation.mutate({ fileId: file.id })}
            disabled={deleteMutation.isPending}
            title={isNoteOnly ? "Delete note" : "Delete file"}
            className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 border border-border transition-colors disabled:opacity-60 disabled:cursor-wait opacity-0 group-hover:opacity-100"
          >
            {deleteMutation.isPending ? (
              <Loader2 size={9} className="animate-spin" />
            ) : (
              <Trash2 size={9} />
            )}
          </button>
          {!isNoteOnly && (
            <button
              type="button"
              onClick={() => {
                setOpen((v) => !v);
                if (!open) setTimeout(() => inputRef.current?.focus(), 50);
              }}
              disabled={assignMutation.isPending}
              title={open ? "Cancel" : "Assign to case"}
              className="shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded text-[10px] font-medium border border-border bg-secondary hover:bg-secondary/70 text-foreground transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
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
      )}
    </div>
  );
}

type FileUploadState = {
  progress: number;
  error: string | null;
};

type PendingUpload = {
  file: File;
  note: string;
};

export function UnassignedDocumentsCard() {
  const { user } = useAuth();
  const labOrganizationId = user?.practiceOrganizationId ?? "";
  const qc = useQueryClient();

  const [isDragging, setIsDragging] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<string, FileUploadState>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [pendingUploadIndex, setPendingUploadIndex] = useState(0);
  const [pendingNote, setPendingNote] = useState("");
  const [showNotePrompt, setShowNotePrompt] = useState(false);

  // Multi-select state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const reveal = () => setCollapsed(false);
    window.addEventListener("labtrax:reveal-unassigned", reveal);
    return () => window.removeEventListener("labtrax:reveal-unassigned", reveal);
  }, []);

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

  const bulkDeleteMutation = useBulkDeleteLabInboxFiles({
    mutation: {
      onSuccess: (data) => {
        const n = data?.data?.deletedCount ?? 0;
        toast({
          title: `${n} file${n === 1 ? "" : "s"} deleted`,
          description: "The selected files have been removed.",
        });
        setSelectedIds(new Set());
        setSelectMode(false);
        void qc.invalidateQueries({
          queryKey: getListLabInboxFilesQueryKey({ labOrganizationId }),
        });
      },
      onError: (err: Error) => {
        toast({
          title: "Could not delete files",
          description: err.message || "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

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
    async (file: File, note = "") => {
      const key = `${file.name}-${file.size}`;

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
        const session = await createUploadSession({
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || "application/octet-stream",
        });

        let offset = session.uploadedBytes ?? 0;
        const CHUNK = 8 * 1024 * 1024;

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
            setFileProgress(key, { progress: 99, error: null });
            await apiFetch<unknown>("/lab-inbox/finalize-session", {
              method: "POST",
              body: JSON.stringify({
                storagePath: result.filename,
                originalFilename: file.name,
                mimeType: file.type || "application/octet-stream",
                sizeBytes: file.size,
                labOrganizationId,
                ...(note.trim() ? { note: note.trim() } : {}),
              }),
            });

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
      if (arr.length === 0) return;
      setPendingUploads(arr.map((file) => ({ file, note: "" })));
      setPendingUploadIndex(0);
      setPendingNote("");
      setShowNotePrompt(true);
    },
    [],
  );

  const finishPendingUpload = useCallback(async () => {
    const pending = pendingUploads[pendingUploadIndex];
    if (!pending) {
      setShowNotePrompt(false);
      setPendingUploads([]);
      setPendingUploadIndex(0);
      setPendingNote("");
      return;
    }

    const note = pendingNote.trim();
    setShowNotePrompt(false);
    await uploadFileInChunks(pending.file, note);

    const nextIndex = pendingUploadIndex + 1;
    if (nextIndex < pendingUploads.length) {
      setPendingUploadIndex(nextIndex);
      setPendingNote("");
      setShowNotePrompt(true);
    } else {
      setPendingUploads([]);
      setPendingUploadIndex(0);
      setPendingNote("");
    }
  }, [pendingNote, pendingUploadIndex, pendingUploads, uploadFileInChunks]);

  const cancelPendingUploads = useCallback(() => {
    setShowNotePrompt(false);
    setPendingUploads([]);
    setPendingUploadIndex(0);
    setPendingNote("");
  }, []);

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

  const handleFileDeleted = (fileId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(fileId);
      return next;
    });
    void qc.invalidateQueries({
      queryKey: getListLabInboxFilesQueryKey({ labOrganizationId }),
    });
  };

  const toggleSelect = (fileId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedIds.size === files.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(files.map((f) => f.id)));
    }
  };

  const handleBulkDelete = () => {
    if (selectedIds.size === 0) return;
    bulkDeleteMutation.mutate({
      data: { fileIds: Array.from(selectedIds), labOrganizationId },
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const files = filesQuery.data?.data ?? [];
  const count = files.length;
  const allSelected = count > 0 && selectedIds.size === count;

  const inFlightEntries = Object.entries(uploadProgress);
  const isUploading = inFlightEntries.some(([, s]) => s.error === null);

  return (
    <section className="dash-section bg-card border border-slate-200 rounded-lg" data-testid="unassigned-documents-card">
      {showNotePrompt && pendingUploads[pendingUploadIndex] && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="inbox-upload-note-title"
            className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-xl"
          >
            <h3 id="inbox-upload-note-title" className="text-sm font-semibold">
              Add a note to {pendingUploads[pendingUploadIndex].file.name}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {pendingUploadIndex + 1} of {pendingUploads.length} files. Notes are optional.
            </p>
            <textarea
              autoFocus
              value={pendingNote}
              onChange={(event) => setPendingNote(event.target.value)}
              placeholder="Optional note for the lab…"
              maxLength={2000}
              rows={4}
              className="mt-3 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={cancelPendingUploads}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary"
              >
                Cancel remaining
              </button>
              <button
                type="button"
                onClick={finishPendingUpload}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                {pendingNote.trim() ? "Upload with note" : "Skip note & upload"}
              </button>
            </div>
          </div>
        </div>
      )}
      <header
        className="flex items-center gap-2 px-5 py-3.5 border-b border-border cursor-pointer select-none hover:bg-secondary/30 transition-colors rounded-t-xl"
        onClick={() => setCollapsed((v) => !v)}
      >
        <Inbox size={14} className="text-[#1d5fd8] shrink-0" />
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
          aria-label={
            collapsed
              ? "Expand unassigned documents"
              : "Collapse unassigned documents"
          }
          aria-expanded={!collapsed}
          className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
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
            <>
              {/* Select mode toolbar */}
              <div className="flex items-center justify-between gap-2 min-h-[24px]">
                {selectMode ? (
                  <>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleSelectAll}
                        className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <span
                          className="inline-flex items-center justify-center h-3.5 w-3.5 rounded border border-border bg-background"
                        >
                          {allSelected && (
                            <svg viewBox="0 0 12 12" fill="none" className="h-2.5 w-2.5 text-primary" stroke="currentColor" strokeWidth={2.5}>
                              <polyline points="2,6 5,9 10,3" />
                            </svg>
                          )}
                        </span>
                        {allSelected ? "Deselect all" : "Select all"}
                      </button>
                      {selectedIds.size > 0 && (
                        <span className="text-[10px] text-muted-foreground">
                          {selectedIds.size} selected
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {selectedIds.size > 0 && (
                        <button
                          type="button"
                          onClick={handleBulkDelete}
                          disabled={bulkDeleteMutation.isPending}
                          className="inline-flex items-center gap-1 h-6 px-2 rounded text-[10px] font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          {bulkDeleteMutation.isPending ? (
                            <Loader2 size={9} className="animate-spin" />
                          ) : (
                            <Trash2 size={9} />
                          )}
                          Delete {selectedIds.size}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={exitSelectMode}
                        className="inline-flex items-center gap-1 h-6 px-2 rounded text-[10px] font-medium border border-border bg-secondary hover:bg-secondary/70 text-foreground transition-colors"
                      >
                        <X size={9} />
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectMode(true);
                    }}
                    className="ml-auto text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Select
                  </button>
                )}
              </div>

              <div className="max-h-64 overflow-y-auto -mx-1 px-1">
                {files.map((file) => (
                  <InboxFileRow
                    key={file.id}
                    file={file}
                    labOrganizationId={labOrganizationId}
                    onAssigned={handleAssigned}
                    selectMode={selectMode}
                    selected={selectedIds.has(file.id)}
                    onToggleSelect={() => toggleSelect(file.id)}
                    onDeleted={handleFileDeleted}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
