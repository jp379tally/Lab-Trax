import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Paperclip, Send, X, FileText } from "lucide-react";
import { apiFetch, apiUrl, authedMediaFetch, ApiError, getProviderOrganizationId } from "@/lib/api";
import { openFilePreviewWindow } from "@/lib/file-preview";
import { formatDateTime } from "@/lib/format";
import { toast } from "@/hooks/use-toast";

type SentInboxEntry = {
  id: string;
  note: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  linkedCaseIds: string | null;
  createdAt: string;
};

const ACCEPTED_FILE_TYPES =
  "application/pdf,image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif";
const acceptedFileTypes = new Set(ACCEPTED_FILE_TYPES.split(","));

interface ProviderSentNotesProps {
  labOrganizationId: string;
  labName?: string;
}

/**
 * Lets a provider send a one-off note and/or file to the lab's inbox
 * (POST /lab-inbox/provider-upload) and see a history of what they've
 * previously sent (GET /lab-inbox/provider-sent), scoped to their own
 * submissions only. This is a separate, one-way drop-box feature from the
 * live "Chat" tab — see the "Provider one-way lab-inbox drop vs live
 * messenger" note if extending this further.
 */
export function ProviderSentNotes({ labOrganizationId, labName }: ProviderSentNotesProps) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [openingEntryId, setOpeningEntryId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const objectUrlRef = useRef<string | null>(null);

  // The preview window keeps using the blob URL after this handler returns,
  // so it is revoked on the next open or on unmount — never immediately.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  const queryKey = ["lab-inbox", "provider-sent", getProviderOrganizationId(), labOrganizationId];

  const sentQuery = useQuery<SentInboxEntry[]>({
    queryKey,
    queryFn: () =>
      apiFetch<SentInboxEntry[]>(
        `/lab-inbox/provider-sent?labOrganizationId=${encodeURIComponent(labOrganizationId)}`,
      ),
  });

  const sendMutation = useMutation({
    mutationFn: async ({ note: noteText, file: attachedFile }: { note: string; file: File | null }) => {
      const formData = new FormData();
      if (noteText) formData.append("note", noteText);
      if (attachedFile) formData.append("file", attachedFile);
      return apiFetch(
        `/lab-inbox/provider-upload?labOrganizationId=${encodeURIComponent(labOrganizationId)}`,
        { method: "POST", body: formData },
      );
    },
    onSuccess: () => {
      setNote("");
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setSendError(null);
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: unknown) => {
      setSendError(
        err instanceof ApiError ? err.message : "Failed to send. Please try again.",
      );
    },
  });

  const canSend = (note.trim().length > 0 || file !== null) && !sendMutation.isPending;

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const nextFile = e.target.files?.[0] ?? null;
    if (nextFile && !acceptedFileTypes.has(nextFile.type.toLowerCase())) {
      setFile(null);
      setSendError(
        "That file type is not supported. Please attach a PDF or image (JPEG, PNG, GIF, WebP, or HEIC).",
      );
      e.target.value = "";
      return;
    }
    setFile(nextFile);
    setSendError(null);
  }

  function handleSubmit() {
    if (!canSend) return;
    sendMutation.mutate({ note: note.trim(), file });
  }

  /**
   * Re-open a file this provider already sent. The bytes come back through
   * the same protected media path the lab uses (GET /lab-inbox/:id/file),
   * which now also answers the provider who submitted the row.
   */
  async function handleOpen(entry: SentInboxEntry) {
    if (!entry.originalFilename || openingEntryId) return;
    setOpeningEntryId(entry.id);
    try {
      const resp = await authedMediaFetch(apiUrl(`/lab-inbox/${entry.id}/file`));
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      const raw = await resp.blob();
      // Give the blob an explicit content type — a generic/missing type is
      // what makes browsers/Electron download instead of previewing inline.
      const contentType =
        entry.mimeType || resp.headers.get("content-type") || "application/octet-stream";
      const blob = raw.type === contentType ? raw : new Blob([raw], { type: contentType });
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      openFilePreviewWindow(url, contentType, entry.originalFilename);
    } catch {
      toast({
        title: "Could not open file",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setOpeningEntryId(null);
    }
  }

  const entries = sentQuery.data ?? [];

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Compose */}
      <div className="shrink-0 border-b border-border p-4 space-y-2">
        <h3 className="text-sm font-semibold">Send a note or file to {labName ?? "the lab"}</h3>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Type a note for the lab…"
          rows={2}
          disabled={sendMutation.isPending}
          className="w-full resize-none rounded-md border border-border bg-muted/30 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 placeholder:text-muted-foreground/60"
        />
        {file && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Paperclip size={12} />
            <span className="truncate max-w-[240px]">{file.name}</span>
            <button
              type="button"
              onClick={() => {
                setFile(null);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
              aria-label="Remove attachment"
              className="hover:text-destructive"
            >
              <X size={12} />
            </button>
          </div>
        )}
        {sendError && <p className="text-xs text-destructive">{sendError}</p>}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sendMutation.isPending}
            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground border border-border transition-colors disabled:opacity-50"
          >
            <Paperclip size={13} />
            Attach file
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_FILE_TYPES}
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSend}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium bg-primary text-primary-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90 transition-colors"
          >
            {sendMutation.isPending ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Send size={13} />
            )}
            Send
          </button>
        </div>
      </div>

      {/* Sent history */}
      <div className="shrink-0 px-4 pt-3 pb-1">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Sent
        </h4>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4 min-h-0">
        {sentQuery.isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 size={16} className="animate-spin text-muted-foreground" />
          </div>
        )}

        {sentQuery.isError && (
          <p className="text-xs text-destructive py-2">
            Could not load your sent history. Please try again.
          </p>
        )}

        {!sentQuery.isLoading && !sentQuery.isError && entries.length === 0 && (
          <p className="text-xs text-muted-foreground py-2">
            You haven&rsquo;t sent any notes yet.
          </p>
        )}

        {entries.map((entry) => (
          <div key={entry.id} className="py-2.5 border-b border-border/40 last:border-0">
            <p className="text-[11px] text-muted-foreground">{formatDateTime(entry.createdAt)}</p>
            {entry.note && (
              <p className="text-xs text-foreground mt-1 line-clamp-3">{entry.note}</p>
            )}
            {entry.originalFilename && (
              <button
                type="button"
                onClick={() => void handleOpen(entry)}
                disabled={openingEntryId === entry.id}
                title={`Open ${entry.originalFilename}`}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground mt-1 rounded hover:text-foreground hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60 disabled:cursor-wait transition-colors"
              >
                {openingEntryId === entry.id ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <FileText size={11} />
                )}
                {entry.originalFilename}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
