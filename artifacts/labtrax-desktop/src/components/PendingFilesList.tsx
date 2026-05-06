import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle,
  Download,
  ExternalLink,
  FileText,
  Film,
  Image as ImageIcon,
  Inbox,
  Link2,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatDate, relativeTime } from "@/lib/format";
import type { LabCase } from "@/lib/types";

export interface PendingFile {
  id: string;
  organizationId: string;
  uploaderUserId: string | null;
  uploaderName: string | null;
  fileUrl: string;
  fileName: string;
  mimeType: string;
  notes: string;
  notesUpdatedAt: string | null;
  notesEditedByUserId: string | null;
  notesEditedByName: string | null;
  createdAt: string;
}

function FileTypeIcon({
  mimeType,
  className,
}: {
  mimeType: string;
  className?: string;
}) {
  if (mimeType === "application/pdf")
    return <FileText size={18} className={className} />;
  if (mimeType.startsWith("video/"))
    return <Film size={18} className={className} />;
  return <ImageIcon size={18} className={className} />;
}

interface AttachDialogProps {
  file: PendingFile;
  onClose: () => void;
  onAttached: () => void;
}

function AttachDialog({ file, onClose, onAttached }: AttachDialogProps) {
  const [search, setSearch] = useState("");
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const casesQuery = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
  });

  const eligibleCases = useMemo(() => {
    const all = casesQuery.data ?? [];
    return all.filter((c) => c.labOrganizationId === file.organizationId);
  }, [casesQuery.data, file.organizationId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sorted = [...eligibleCases].sort((a, b) =>
      (b.createdAt || "").localeCompare(a.createdAt || ""),
    );
    if (!q) return sorted.slice(0, 50);
    return sorted
      .filter((c) => {
        const name = `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.toLowerCase();
        return (
          name.includes(q) ||
          (c.caseNumber || "").toLowerCase().includes(q) ||
          (c.doctorName || "").toLowerCase().includes(q)
        );
      })
      .slice(0, 50);
  }, [eligibleCases, search]);

  const attachMutation = useMutation({
    mutationFn: async (caseId: string) => {
      await apiFetch(`/lab-pending-files/${file.id}/attach`, {
        method: "POST",
        body: JSON.stringify({ caseId }),
      });
    },
    onSuccess: () => {
      onAttached();
      onClose();
    },
    onError: (e: unknown) => {
      const msg =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Could not attach this file. Please try again.";
      setError(msg);
    },
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4">
      <div className="bg-card border border-border rounded-xl shadow-lg w-full max-w-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold">Attach to a case</h3>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {file.fileName}
          </p>
        </div>
        <div className="p-5 space-y-3">
          <input
            type="search"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by patient, case number, or doctor"
            className="w-full h-9 px-3 rounded-md border border-border bg-background text-sm placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="border border-border rounded-md max-h-72 overflow-y-auto scrollbar-thin">
            {casesQuery.isLoading && (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                Loading cases…
              </div>
            )}
            {!casesQuery.isLoading && filtered.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                No matching cases in this lab.
              </div>
            )}
            <ul className="divide-y divide-border">
              {filtered.map((c) => {
                const active = selectedCaseId === c.id;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedCaseId(c.id)}
                      className={`w-full text-left px-3 py-2.5 flex items-start gap-3 hover:bg-secondary/60 ${
                        active ? "bg-primary/10" : ""
                      }`}
                    >
                      <div className="font-mono text-xs text-muted-foreground mt-0.5 shrink-0 w-20 truncate">
                        {c.caseNumber}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">
                          {c.patientFirstName} {c.patientLastName}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {c.doctorName}
                          {c.dueDate ? ` · due ${formatDate(c.dueDate)}` : ""}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          {error && (
            <div className="text-xs text-destructive flex items-start gap-1.5">
              <XCircle size={13} className="mt-0.5 shrink-0" />
              {error}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-md hover:bg-secondary"
            disabled={attachMutation.isPending}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => selectedCaseId && attachMutation.mutate(selectedCaseId)}
            disabled={!selectedCaseId || attachMutation.isPending}
            className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground font-medium disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {attachMutation.isPending ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                Attaching…
              </>
            ) : (
              <>
                <CheckCircle size={13} />
                Attach
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PreviewDialogProps {
  file: PendingFile;
  onClose: () => void;
  onAttachClick: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}

function PreviewBody({ file }: { file: PendingFile }) {
  const { mimeType, fileUrl, fileName } = file;

  if (mimeType.startsWith("image/")) {
    return (
      <div className="flex items-center justify-center bg-black/5 dark:bg-black/30 min-h-[20rem] max-h-[70vh] overflow-auto">
        <img
          src={fileUrl}
          alt={fileName}
          className="max-w-full max-h-[70vh] object-contain"
        />
      </div>
    );
  }

  if (mimeType === "application/pdf") {
    return (
      <iframe
        src={fileUrl}
        title={fileName}
        className="w-full h-[70vh] bg-background"
      />
    );
  }

  if (mimeType.startsWith("video/")) {
    return (
      <div className="flex items-center justify-center bg-black min-h-[20rem] max-h-[70vh]">
        <video
          src={fileUrl}
          controls
          className="max-w-full max-h-[70vh]"
        >
          <track kind="captions" />
        </video>
      </div>
    );
  }

  if (mimeType.startsWith("audio/")) {
    return (
      <div className="flex items-center justify-center bg-secondary/40 py-12 px-6">
        <audio src={fileUrl} controls className="w-full max-w-md" />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center text-center gap-3 py-16 px-6 bg-secondary/30">
      <FileTypeIcon
        mimeType={mimeType}
        className="text-muted-foreground"
      />
      <div>
        <p className="text-sm font-medium">No inline preview available</p>
        <p className="text-xs text-muted-foreground mt-1">
          This file type ({mimeType || "unknown"}) can't be previewed here.
        </p>
      </div>
      <a
        href={fileUrl}
        download={fileName}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium"
      >
        <Download size={13} />
        Download file
      </a>
    </div>
  );
}

function PreviewDialog({
  file,
  onClose,
  onAttachClick,
  onDelete,
  isDeleting,
}: PreviewDialogProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3.5 border-b border-border flex items-start gap-3">
          <div className="mt-0.5 shrink-0 text-muted-foreground">
            <FileTypeIcon mimeType={file.mimeType} />
          </div>
          <div className="min-w-0 flex-1">
            <h3
              className="text-sm font-semibold truncate"
              title={file.fileName}
            >
              {file.fileName}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {file.uploaderName || "Unknown uploader"} ·{" "}
              {relativeTime(file.createdAt)} ·{" "}
              <span className="uppercase tracking-wide">
                {file.mimeType.split("/")[1] || file.mimeType}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground shrink-0"
            aria-label="Close preview"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
          <div className="flex-1 min-w-0 overflow-auto">
            <PreviewBody file={file} />
          </div>
          <aside className="w-full md:w-72 md:border-l border-t md:border-t-0 border-border bg-card flex flex-col">
            <div className="px-4 py-3 border-b border-border">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Notes
              </h4>
              {file.notes ? (
                <p className="text-sm text-foreground/90 mt-1.5 whitespace-pre-wrap break-words">
                  {file.notes}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground mt-1.5 italic">
                  No notes added.
                </p>
              )}
            </div>
            <div className="px-4 py-3 flex-1">
              <a
                href={file.fileUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <ExternalLink size={12} />
                Open in new tab
              </a>
            </div>
          </aside>
        </div>

        <footer className="px-5 py-3 border-t border-border flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onDelete}
            disabled={isDeleting}
            className="px-3 py-1.5 text-sm rounded-md text-destructive hover:bg-destructive/10 inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            {isDeleting ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Trash2 size={13} />
            )}
            Delete
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded-md hover:bg-secondary"
            >
              Close
            </button>
            <button
              type="button"
              onClick={onAttachClick}
              className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground font-medium inline-flex items-center gap-1.5"
            >
              <Link2 size={13} />
              Attach to case
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export function PendingFilesList() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [attachTarget, setAttachTarget] = useState<PendingFile | null>(null);
  const [previewTarget, setPreviewTarget] = useState<PendingFile | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function startEdit(file: PendingFile) {
    setEditingId(file.id);
    setEditValue(file.notes ?? "");
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValue("");
    setEditError(null);
  }

  function flashError(msg: string) {
    setActionError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setActionError(null), 4000);
  }

  useEffect(
    () => () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    },
    [],
  );

  const filesQuery = useQuery({
    queryKey: ["lab-pending-files"],
    queryFn: async () => {
      const res = await apiFetch<{ files: PendingFile[] }>(
        "/lab-pending-files",
      );
      return res?.files ?? [];
    },
    enabled: !!user,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const updateNotesMutation = useMutation({
    mutationFn: async ({ id, notes }: { id: string; notes: string }) => {
      const res = await apiFetch<{
        success: boolean;
        notesUpdatedAt: string | null;
        notesEditedByUserId: string | null;
        notesEditedByName: string | null;
      }>(`/lab-pending-files/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ notes }),
      });
      return { notes, meta: res };
    },
    onSuccess: ({ notes, meta }, { id }) => {
      queryClient.setQueryData<PendingFile[]>(
        ["lab-pending-files"],
        (prev) =>
          prev?.map((f) =>
            f.id === id
              ? {
                  ...f,
                  notes,
                  notesUpdatedAt: meta?.notesUpdatedAt ?? f.notesUpdatedAt,
                  notesEditedByUserId:
                    meta?.notesEditedByUserId ?? f.notesEditedByUserId,
                  notesEditedByName:
                    meta?.notesEditedByName ?? f.notesEditedByName,
                }
              : f,
          ) ?? prev,
      );
      queryClient.invalidateQueries({ queryKey: ["lab-pending-files"] });
      cancelEdit();
    },
    onError: (e: unknown) => {
      const msg =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Could not save the note. Please try again.";
      setEditError(msg);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiFetch(`/lab-pending-files/${id}`, { method: "DELETE" });
    },
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: ["lab-pending-files"] });
      const previous = queryClient.getQueryData<PendingFile[]>([
        "lab-pending-files",
      ]);
      queryClient.setQueryData<PendingFile[]>(
        ["lab-pending-files"],
        (prev) => prev?.filter((f) => f.id !== id) ?? [],
      );
      return { previous };
    },
    onError: (e, _id, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(["lab-pending-files"], ctx.previous);
      }
      const msg =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Could not delete the file.";
      flashError(msg);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["lab-pending-files"] });
    },
  });

  const files = filesQuery.data ?? [];
  const isLoading = filesQuery.isLoading;
  const isFetching = filesQuery.isFetching && !isLoading;

  // Keep the preview target in sync when the underlying list refreshes
  // (e.g. after attaching, the file disappears and we should close the modal).
  useEffect(() => {
    if (!previewTarget) return;
    const stillExists = files.some((f) => f.id === previewTarget.id);
    if (!stillExists) setPreviewTarget(null);
  }, [files, previewTarget]);

  return (
    <section className="bg-card border border-border rounded-xl overflow-hidden">
      <header className="flex items-center justify-between px-5 py-3.5 border-b border-border">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Inbox size={14} className="text-muted-foreground" />
            Shared file inbox
            <span className="text-xs font-normal text-muted-foreground">
              ({files.length})
            </span>
          </h2>
          <p className="text-xs text-muted-foreground">
            Files uploaded by your team that haven't been attached to a case yet.
          </p>
        </div>
        <button
          type="button"
          onClick={() => filesQuery.refetch()}
          className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground"
          aria-label="Refresh inbox"
          disabled={isFetching}
        >
          <RefreshCw
            size={14}
            className={isFetching ? "animate-spin" : ""}
          />
        </button>
      </header>

      {actionError && (
        <div className="px-5 py-2 bg-destructive/10 text-destructive text-xs flex items-start gap-2 border-b border-border">
          <XCircle size={13} className="mt-0.5 shrink-0" />
          {actionError}
        </div>
      )}

      <div>
        {isLoading && (
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">
            Loading inbox…
          </div>
        )}
        {!isLoading && files.length === 0 && (
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">
            No pending files. Drop something above to share it with your team.
          </div>
        )}
        {!isLoading && files.length > 0 && (
          <ul className="divide-y divide-border">
            {files.map((f) => (
              <li key={f.id} className="px-5 py-3.5 flex items-start gap-3 hover:bg-secondary/30">
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => setPreviewTarget(f)}
                    className="flex items-start gap-3 w-full text-left"
                    title={`Preview ${f.fileName}`}
                  >
                    <span className="mt-0.5 shrink-0 text-muted-foreground">
                      <FileTypeIcon mimeType={f.mimeType} />
                    </span>
                    <span className="min-w-0 flex-1 block">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span
                          className="text-sm font-medium truncate hover:underline"
                          title={f.fileName}
                        >
                          {f.fileName}
                        </span>
                        <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
                          {f.mimeType.split("/")[1] || f.mimeType}
                        </span>
                      </span>
                      <span className="block text-xs text-muted-foreground mt-0.5">
                        {f.uploaderName || "Unknown uploader"} ·{" "}
                        {relativeTime(f.createdAt)}
                      </span>
                    </span>
                  </button>
                  {editingId === f.id ? (
                    <div className="mt-1.5 ml-[30px] space-y-1.5">
                      <textarea
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            cancelEdit();
                          } else if (
                            e.key === "Enter" &&
                            (e.metaKey || e.ctrlKey)
                          ) {
                            e.preventDefault();
                            updateNotesMutation.mutate({
                              id: f.id,
                              notes: editValue.trim(),
                            });
                          }
                        }}
                        rows={3}
                        placeholder="Add a note for your team…"
                        className="w-full px-2.5 py-1.5 rounded-md border border-border bg-background text-xs placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-primary resize-y"
                        disabled={updateNotesMutation.isPending}
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            updateNotesMutation.mutate({
                              id: f.id,
                              notes: editValue.trim(),
                            })
                          }
                          disabled={
                            updateNotesMutation.isPending ||
                            editValue.trim() === (f.notes ?? "").trim()
                          }
                          className="h-7 px-2.5 rounded-md text-xs font-medium bg-primary text-primary-foreground disabled:opacity-50 inline-flex items-center gap-1.5"
                        >
                          {updateNotesMutation.isPending ? (
                            <>
                              <Loader2 size={12} className="animate-spin" />
                              Saving…
                            </>
                          ) : (
                            "Save"
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={updateNotesMutation.isPending}
                          className="h-7 px-2.5 rounded-md text-xs hover:bg-secondary"
                        >
                          Cancel
                        </button>
                        {editError && (
                          <span className="text-xs text-destructive inline-flex items-start gap-1">
                            <XCircle size={12} className="mt-0.5 shrink-0" />
                            {editError}
                          </span>
                        )}
                      </div>
                    </div>
                  ) : f.notes ? (
                    <div className="ml-[30px]">
                      <div className="text-xs text-foreground/80 mt-1 whitespace-pre-wrap break-words">
                        {f.notes}
                      </div>
                      {f.notesUpdatedAt && (
                        <div className="text-[11px] text-muted-foreground mt-0.5 italic">
                          edited by{" "}
                          {f.notesEditedByName || "someone"} ·{" "}
                          {relativeTime(f.notesUpdatedAt)}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
                <div className="shrink-0 flex items-center gap-1">
                  {editingId !== f.id && (
                    <button
                      type="button"
                      onClick={() => startEdit(f)}
                      className="h-8 px-2.5 rounded-md text-xs font-medium hover:bg-secondary inline-flex items-center gap-1.5 text-foreground"
                      title={f.notes ? "Edit note" : "Add note"}
                    >
                      <Pencil size={13} />
                      {f.notes ? "Edit note" : "Add note"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setAttachTarget(f)}
                    className="h-8 px-2.5 rounded-md text-xs font-medium hover:bg-secondary inline-flex items-center gap-1.5 text-foreground"
                    title="Attach to a case"
                  >
                    <Link2 size={13} />
                    Attach
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete "${f.fileName}" from the inbox? This cannot be undone.`,
                        )
                      ) {
                        deleteMutation.mutate(f.id);
                      }
                    }}
                    className="h-8 w-8 rounded-md hover:bg-destructive/10 hover:text-destructive flex items-center justify-center text-muted-foreground"
                    aria-label={`Delete ${f.fileName}`}
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {previewTarget && (
        <PreviewDialog
          file={previewTarget}
          onClose={() => setPreviewTarget(null)}
          onAttachClick={() => setAttachTarget(previewTarget)}
          onDelete={() => {
            if (
              window.confirm(
                `Delete "${previewTarget.fileName}" from the inbox? This cannot be undone.`,
              )
            ) {
              deleteMutation.mutate(previewTarget.id, {
                onSuccess: () => setPreviewTarget(null),
              });
            }
          }}
          isDeleting={
            deleteMutation.isPending &&
            deleteMutation.variables === previewTarget.id
          }
        />
      )}

      {attachTarget && (
        <AttachDialog
          file={attachTarget}
          onClose={() => setAttachTarget(null)}
          onAttached={() => {
            queryClient.invalidateQueries({
              queryKey: ["lab-pending-files"],
            });
          }}
        />
      )}
    </section>
  );
}
