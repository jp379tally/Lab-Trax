import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle, FileText, Film, Image, Loader2, RotateCw, Upload, X, XCircle } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useUploads, type UploadRejection } from "@/lib/uploads-context";

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
  const { entries, addFiles, removeEntry, updateNote, commitNote, retryEntry } = useUploads();
  const [dragOver, setDragOver] = useState(false);
  const [rejections, setRejections] = useState<UploadRejection[]>([]);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFiles = useCallback(
    (files: FileList | File[]) => {
      if (!organizationId) return;
      const result = addFiles(files, { organizationId, uploaderName });
      setRejections(result.rejections);
    },
    [addFiles, organizationId, uploaderName],
  );

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
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
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
                className="flex items-start gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-2.5"
              >
                <div className="mt-0.5 shrink-0 text-muted-foreground">
                  <FileTypeIcon mimeType={entry.file.type} />
                </div>

                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium truncate max-w-[200px]">
                      {entry.file.name}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatBytes(entry.file.size)}
                    </span>
                  </div>

                  {entry.status === "uploading" && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 size={12} className="animate-spin" />
                      Uploading…
                    </div>
                  )}

                  {entry.status === "error" && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="flex items-center gap-1.5 text-xs text-destructive">
                        <XCircle size={12} />
                        {entry.errorMessage ?? "Upload failed"}
                      </div>
                      <button
                        type="button"
                        onClick={() => retryEntry(entry.id)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline focus:outline-none focus:ring-1 focus:ring-primary rounded-sm px-1"
                        aria-label={`Retry uploading ${entry.file.name}`}
                      >
                        <RotateCw size={11} />
                        Retry
                      </button>
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
                  aria-label={`Remove ${entry.file.name}`}
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
