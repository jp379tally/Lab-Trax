import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle, FileText, Film, Image, RotateCw, Upload, X, XCircle } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useUploads, type FileWithHandle, type UploadRejection } from "@/lib/uploads-context";
import { supportsDropHandles, supportsFilePicker } from "@/lib/upload-handles";

const PICKER_TYPES = [
  {
    description: "Images, videos, and PDFs",
    accept: {
      "image/*": [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".bmp", ".tif", ".tiff"],
      "video/*": [".mp4", ".mov", ".webm", ".avi"],
      "application/pdf": [".pdf"],
    },
  },
];

function FileTypeIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType === "application/pdf") return <FileText size={16} className={className} />;
  if (mimeType.startsWith("video/")) return <Film size={16} className={className} />;
  return <Image size={16} className={className} />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface DesktopFileDropZoneProps {
  organizationId: string | null;
  uploaderName: string;
}

function DesktopFileDropZoneInner({ organizationId, uploaderName }: DesktopFileDropZoneProps) {
  const {
    entries,
    addFiles,
    removeEntry,
    cancelEntry,
    updateNote,
    commitNote,
    retryEntry,
    resumeEntry,
    requestResumePermission,
    hasResumeHandle,
  } = useUploads();
  const [dragOver, setDragOver] = useState(false);
  const [rejections, setRejections] = useState<UploadRejection[]>([]);
  const [resumeErrors, setResumeErrors] = useState<Record<string, string>>({});
  const [resumingIds, setResumingIds] = useState<Record<string, boolean>>({});
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resumeInputsRef = useRef<Map<string, HTMLInputElement>>(new Map());

  const processItems = useCallback(
    (items: FileWithHandle[]) => {
      if (!organizationId || items.length === 0) return;
      const result = addFiles(items, { organizationId, uploaderName });
      setRejections(result.rejections);
    },
    [addFiles, organizationId, uploaderName],
  );

  const processFiles = useCallback(
    (files: FileList | File[]) => {
      processItems(Array.from(files).map((file) => ({ file })));
    },
    [processItems],
  );

  const openFilePicker = useCallback(async () => {
    if (!organizationId) return;
    if (supportsFilePicker()) {
      try {
        const handles: any[] = await (window as any).showOpenFilePicker({
          multiple: true,
          excludeAcceptAllOption: false,
          types: PICKER_TYPES,
        });
        const items: FileWithHandle[] = [];
        for (const handle of handles) {
          try {
            const file = await handle.getFile();
            items.push({ file, handle });
          } catch {
            /* skip unreadable handles */
          }
        }
        processItems(items);
        return;
      } catch (err: any) {
        if (err?.name === "AbortError") return; // user dismissed picker
        // Fall through to the legacy <input type="file"> picker.
      }
    }
    fileInputRef.current?.click();
  }, [organizationId, processItems]);

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) setDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setDragOver(false);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setDragOver(false);
    // When the browser supports it, use DataTransferItem.getAsFileSystemHandle
    // so we can persist the handle and silently resume after a refresh.
    if (supportsDropHandles() && e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      const items = Array.from(e.dataTransfer.items);
      void (async () => {
        const collected: FileWithHandle[] = [];
        for (const item of items) {
          if (item.kind !== "file") continue;
          let handle: any = null;
          try {
            handle = await (item as any).getAsFileSystemHandle?.();
          } catch {
            handle = null;
          }
          if (handle && handle.kind === "file") {
            try {
              const file = await handle.getFile();
              collected.push({ file, handle });
              continue;
            } catch {
              /* fall through to plain file */
            }
          }
          const file = item.getAsFile();
          if (file) collected.push({ file });
        }
        processItems(collected);
      })();
      return;
    }
    if (e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
    }
    e.target.value = "";
  }

  function handleResumeChange(id: string, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const result = resumeEntry(id, file);
    setResumeErrors((prev) => {
      const next = { ...prev };
      if (result.ok) {
        delete next[id];
      } else {
        next[id] = result.reason ?? "Could not resume upload.";
      }
      return next;
    });
  }

  const disabled = !organizationId;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-3.5 border-b border-border">
        <h2 className="text-sm font-semibold">Pending file inbox</h2>
        <p className="text-xs text-muted-foreground">
          Drop files here to share them with your lab team.
        </p>
      </div>

      <div className="p-5 space-y-4">
        {!organizationId && (
          <div className="text-xs text-muted-foreground text-center py-3">
            Join a lab organization to use the shared file inbox.
          </div>
        )}

        {organizationId && (
          <div
            role="button"
            tabIndex={0}
            aria-label="Drop files here or click to pick files"
            onClick={() => void openFilePicker()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") void openFilePicker();
            }}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            className={[
              "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 cursor-pointer select-none transition-colors",
              dragOver
                ? "border-primary bg-primary/8 text-primary"
                : "border-border hover:border-primary/50 hover:bg-secondary/40",
            ].join(" ")}
          >
            <Upload size={22} className={dragOver ? "text-primary" : "text-muted-foreground"} />
            <div className="text-center">
              <p className="text-sm font-medium">
                {dragOver ? "Release to upload" : "Drop files or click to browse"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Images, videos, PDFs &mdash; up to 10 MB each
              </p>
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*,application/pdf"
          className="hidden"
          onChange={handleInputChange}
          disabled={disabled}
        />

        {rejections.length > 0 && (
          <div className="space-y-1">
            {rejections.map((r) => (
              <div
                key={r.id}
                className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-md px-3 py-2"
              >
                <XCircle size={13} className="mt-0.5 shrink-0" />
                <span>
                  <span className="font-medium">{r.name}</span> &mdash; {r.reason}
                </span>
              </div>
            ))}
          </div>
        )}

        {entries.length > 0 && (
          <ul className="space-y-2">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className={[
                  "flex items-start gap-3 rounded-lg border px-3 py-2.5",
                  entry.status === "interrupted"
                    ? "border-destructive/40 bg-destructive/5"
                    : "border-border bg-secondary/30",
                ].join(" ")}
              >
                <div className="mt-0.5 shrink-0 text-muted-foreground">
                  <FileTypeIcon mimeType={entry.mimeType} />
                </div>

                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium truncate max-w-[200px]">
                      {entry.fileName}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatBytes(entry.fileSize)}
                    </span>
                  </div>

                  {(entry.status === "uploading" || entry.status === "queued") && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>
                          {entry.status === "queued" ? "Waiting…" : "Uploading…"}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="tabular-nums">{entry.progress}%</span>
                          <button
                            type="button"
                            onClick={() => cancelEntry(entry.id)}
                            className="text-xs font-medium text-primary hover:underline focus:outline-none focus:ring-1 focus:ring-primary rounded-sm px-1"
                            aria-label={`Cancel upload of ${entry.fileName}`}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                      <div
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={entry.progress}
                        aria-label={`Upload progress for ${entry.fileName}`}
                        className="h-1.5 w-full rounded-full bg-secondary overflow-hidden"
                      >
                        <div
                          className="h-full bg-primary transition-[width] duration-150 ease-out"
                          style={{ width: `${entry.progress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {entry.status === "error" && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="flex items-center gap-1.5 text-xs text-destructive">
                        <XCircle size={12} />
                        {entry.errorMessage ?? "Upload failed"}
                      </div>
                      {entry.file && (
                        <button
                          type="button"
                          onClick={() => retryEntry(entry.id)}
                          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline focus:outline-none focus:ring-1 focus:ring-primary rounded-sm px-1"
                          aria-label={`Retry uploading ${entry.fileName}`}
                        >
                          <RotateCw size={11} />
                          Retry
                        </button>
                      )}
                    </div>
                  )}

                  {entry.status === "interrupted" && (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5 text-xs text-destructive">
                        <XCircle size={12} />
                        Upload was interrupted by a page refresh.
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        {hasResumeHandle(entry.id) ? (
                          <button
                            type="button"
                            disabled={!!resumingIds[entry.id]}
                            onClick={async () => {
                              setResumingIds((prev) => ({ ...prev, [entry.id]: true }));
                              const result = await requestResumePermission(entry.id);
                              setResumingIds((prev) => {
                                const next = { ...prev };
                                delete next[entry.id];
                                return next;
                              });
                              setResumeErrors((prev) => {
                                const next = { ...prev };
                                if (result.ok) {
                                  delete next[entry.id];
                                } else if (result.reason === "no-handle") {
                                  // Handle was lost (e.g. cleared storage); fall back to re-pick.
                                  delete next[entry.id];
                                  resumeInputsRef.current.get(entry.id)?.click();
                                } else if (result.reason === "permission-denied") {
                                  next[entry.id] = "Permission to read the file was denied.";
                                } else {
                                  next[entry.id] = result.reason ?? "Could not resume upload.";
                                }
                                return next;
                              });
                            }}
                            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline focus:outline-none focus:ring-1 focus:ring-primary rounded-sm px-1 disabled:opacity-50"
                            aria-label={`Resume upload of ${entry.fileName}`}
                          >
                            <RotateCw size={11} />
                            {resumingIds[entry.id] ? "Resuming…" : "Resume upload"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => resumeInputsRef.current.get(entry.id)?.click()}
                            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline focus:outline-none focus:ring-1 focus:ring-primary rounded-sm px-1"
                            aria-label={`Re-pick ${entry.fileName} to resume upload`}
                          >
                            <RotateCw size={11} />
                            Re-pick file to resume
                          </button>
                        )}
                        <input
                          ref={(el) => {
                            if (el) resumeInputsRef.current.set(entry.id, el);
                            else resumeInputsRef.current.delete(entry.id);
                          }}
                          type="file"
                          accept="image/*,video/*,application/pdf"
                          className="hidden"
                          onChange={(e) => handleResumeChange(entry.id, e)}
                        />
                      </div>
                      {resumeErrors[entry.id] && (
                        <div className="text-xs text-destructive">
                          {resumeErrors[entry.id]}
                        </div>
                      )}
                    </div>
                  )}

                  {entry.status === "success" && (
                    <div className="flex items-center gap-1.5 text-xs text-success">
                      <CheckCircle size={12} />
                      Added to shared inbox
                    </div>
                  )}

                  {(entry.status === "queued" || entry.status === "success") && (
                    <input
                      type="text"
                      placeholder="Add a note (optional)"
                      value={entry.note}
                      onChange={(e) => updateNote(entry.id, e.target.value)}
                      onBlur={() => commitNote(entry.id)}
                      className="w-full text-xs rounded-md border border-border bg-background px-2.5 py-1.5 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  )}
                </div>

                <button
                  onClick={() => removeEntry(entry.id)}
                  className="shrink-0 mt-0.5 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label={`Remove ${entry.fileName}`}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function DesktopFileDropZone() {
  const { user } = useAuth();

  const [orgId, setOrgId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!user) return;
    apiFetch<{ id: string; type?: string; name?: string }[]>("/organizations")
      .then((orgs) => {
        const labOrg = Array.isArray(orgs)
          ? orgs.find((o) => !o.type || o.type === "lab")
          : null;
        setOrgId(labOrg?.id ?? null);
      })
      .catch(() => setOrgId(null));
  }, [user]);

  const uploaderName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    user?.username ||
    "Lab member";

  if (orgId === undefined) {
    return (
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="text-xs text-muted-foreground">Loading inbox…</div>
      </div>
    );
  }

  return <DesktopFileDropZoneInner organizationId={orgId} uploaderName={uploaderName} />;
}
