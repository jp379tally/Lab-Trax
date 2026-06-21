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
  useUploadLabInboxFile,
  useAssignLabInboxFile,
  getListLabInboxFilesQueryKey,
} from "@workspace/api-client-react";
import type { LabInboxFile } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { relativeTime } from "@/lib/format";
import type { LabCase } from "@/lib/types";

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

export function UnassignedDocumentsCard() {
  const { user } = useAuth();
  const labOrganizationId = user?.practiceOrganizationId ?? "";
  const qc = useQueryClient();

  const [isDragging, setIsDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
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

  const uploadMutation = useUploadLabInboxFile({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({
          queryKey: getListLabInboxFilesQueryKey({ labOrganizationId }),
        });
        setUploadError(null);
      },
      onError: (err: Error) => {
        setUploadError(err.message || "Upload failed.");
      },
    },
  });

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      setUploadError(null);
      if (!labOrganizationId) {
        setUploadError("No lab organization found.");
        return;
      }
      const arr = Array.from(files);
      for (const file of arr) {
        if (file.size > 200 * 1024 * 1024) {
          setUploadError(`${file.name} exceeds 200 MB limit.`);
          continue;
        }
        uploadMutation.mutate({ data: { file, labOrganizationId } });
      }
    },
    [labOrganizationId, uploadMutation],
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
            {uploadMutation.isPending ? (
              <Loader2
                size={18}
                className="animate-spin text-muted-foreground"
              />
            ) : (
              <FileText size={18} className="text-muted-foreground" />
            )}
            <p className="text-xs text-muted-foreground text-center">
              {uploadMutation.isPending
                ? "Uploading…"
                : isDragging
                ? "Drop to upload"
                : "Add a file or a picture"}
            </p>
          </div>

          {uploadError && (
            <div className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle size={12} className="shrink-0 mt-0.5" />
              {uploadError}
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
