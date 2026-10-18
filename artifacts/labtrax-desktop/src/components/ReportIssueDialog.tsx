import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent } from "react";
import { ImagePlus, Loader2, Paperclip, X } from "lucide-react";
import { apiFetchFormData } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const MAX_FILES = 5;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_TOTAL_SIZE = 10 * 1024 * 1024;
const ACCEPTED = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf", "text/plain",
]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

type Attachment = { file: File; url: string; image: boolean };
export type ReportIssuePortal = "lab" | "provider";
export function canReportIssueRole(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}
export function canReportIssueMembership(
  membership: { role?: string | null; status?: string | null } | null | undefined,
): boolean {
  return membership?.status === "active" && canReportIssueRole(membership.role);
}
export function canReportIssueForSelectedOrganization(
  memberships: Array<{ organizationId: string; role?: string | null; status?: string | null }>,
  selectedOrganizationId: string | null,
): boolean {
  return !!selectedOrganizationId &&
    canReportIssueMembership(memberships.find((membership) => membership.organizationId === selectedOrganizationId));
}

function newSubmissionKey(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `support-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Could not submit your report.";
  return message.replace(/(?:https?:\/\/|\/api\/)[^\s]+/gi, "").trim() || "Could not submit your report.";
}

export function ReportIssueDialog({
  open,
  onOpenChange,
  portal,
  kind = "issue",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  portal: ReportIssuePortal;
  kind?: "issue" | "feedback";
}) {
  const [description, setDescription] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "success">("idle");
  const [preview, setPreview] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previewWasOpenRef = useRef(false);
  const attachmentsRef = useRef<Attachment[]>([]);
  const submissionKeyRef = useRef<string | null>(null);

  const revoke = useCallback((items: Attachment[]) => {
    items.forEach((item) => URL.revokeObjectURL(item.url));
  }, []);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  useLayoutEffect(() => {
    if (!preview && previewWasOpenRef.current) triggerRef.current?.focus();
    previewWasOpenRef.current = !!preview;
  }, [preview]);
  useEffect(() => () => revoke(attachmentsRef.current), [revoke]);
  useEffect(() => {
    if (!open) {
      submissionKeyRef.current = null;
      revoke(attachments);
      setAttachments([]);
      setDescription("");
      setError(null);
      setStatus("idle");
      setPreview(null);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const closePreview = () => setPreview(null);

  const addFiles = (files: File[]) => {
    submissionKeyRef.current = null;
    setError(null);
    const next = [...attachments];
    for (const file of files) {
      if (next.length >= MAX_FILES) { setError(`You can attach up to ${MAX_FILES} files.`); break; }
      if (!ACCEPTED.has(file.type)) { setError(`${file.name} is not a supported file type.`); continue; }
      if (file.size > MAX_FILE_SIZE) { setError(`${file.name} is larger than 5 MiB.`); continue; }
      if (next.reduce((sum, item) => sum + item.file.size, 0) + file.size > MAX_TOTAL_SIZE) {
        setError("Attachments must be 10 MiB or smaller in total."); break;
      }
      next.push({ file, url: URL.createObjectURL(file), image: IMAGE_TYPES.has(file.type) });
    }
    setAttachments(next);
  };
  const remove = (index: number) => {
    submissionKeyRef.current = null;
    const item = attachments[index];
    if (preview === item.url) {
      closePreview();
      triggerRef.current?.focus();
    }
    URL.revokeObjectURL(item.url);
    setAttachments((items) => items.filter((_, i) => i !== index));
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const image = Array.from(event.clipboardData.files).find((file) => IMAGE_TYPES.has(file.type));
    if (!image) return;
    event.preventDefault();
    const name = `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    addFiles([new File([image], name, { type: image.type })]);
  };
  const submit = async () => {
    if (!description.trim()) { setError("Please describe the issue."); return; }
    setError(null);
    setStatus("loading");
    const form = new FormData();
    form.append("description", description.trim());
    attachments.forEach(({ file }) => form.append("attachments", file, file.name));
    submissionKeyRef.current ??= newSubmissionKey();
    try {
      await apiFetchFormData(`/support-reports?portal=${portal}${kind === "feedback" ? "&kind=feedback" : ""}`, form, {
        headers: { "Idempotency-Key": submissionKeyRef.current },
      });
      setStatus("success");
      submissionKeyRef.current = null;
    } catch (submissionError) {
      // Preserve the key when no response arrived: the server may already have
      // accepted the report. A definite server rejection is safe to resubmit
      // as a new intake attempt.
      if (
        submissionError
        && typeof submissionError === "object"
        && "status" in submissionError
        && typeof submissionError.status === "number"
        && submissionError.status > 0
      ) {
        submissionKeyRef.current = null;
      }
      setStatus("idle");
      setError(cleanError(submissionError));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="dialog-report-issue" aria-busy={status === "loading"}>
        <DialogHeader>
          <DialogTitle>Report an Issue</DialogTitle>
          <DialogDescription>Tell us what went wrong. You can attach up to 5 files (10 MiB total).</DialogDescription>
        </DialogHeader>
        {status === "loading" && <div role="status" aria-live="polite" data-testid="status-report-pending">Submitting report…</div>}
        {status === "success" ? (
          <div role="status" data-testid="status-report-success" className="rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-800">
            Your report was submitted. Thank you for helping improve LabTrax.
          </div>
        ) : (
          <>
            <label htmlFor="report-issue-description" className="text-sm font-medium">Description <span aria-hidden="true">*</span></label>
            <textarea
              id="report-issue-description"
              data-testid="input-report-description"
              value={description}
              onChange={(event) => {
                submissionKeyRef.current = null;
                setDescription(event.target.value);
              }}
              onPaste={onPaste}
              aria-invalid={!!error && !description.trim()}
              aria-describedby={error ? "report-issue-error" : undefined}
              className="min-h-28 rounded-md border border-input bg-background p-3 text-sm"
              placeholder="Describe the problem and what you expected to happen"
              disabled={status === "loading"}
            />
            <input ref={inputRef} type="file" multiple hidden accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.txt,image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
            <button type="button" data-testid="button-attach-files" onClick={() => inputRef.current?.click()} disabled={status === "loading"} className="flex w-fit items-center gap-2 rounded-md border border-input px-3 py-2 text-sm hover:bg-muted">
              <Paperclip size={15} /> Attach files
            </button>
            <div className="grid grid-cols-2 gap-2" data-testid="list-report-attachments">
              {attachments.map((attachment, index) => (
                <div key={`${attachment.file.name}-${index}`} className="relative rounded-md border border-border p-2 text-xs">
                  {attachment.image ? (
                    <button type="button" data-testid={`button-preview-attachment-${index}`} onClick={(event) => { triggerRef.current = event.currentTarget; setPreview(attachment.url); }} className="block w-full text-left">
                      <img src={attachment.url} alt={attachment.file.name} className="mb-1 h-20 w-full rounded object-cover" />
                    </button>
                  ) : <div className="mb-1 flex h-20 items-center justify-center bg-muted">{attachment.file.type === "application/pdf" ? "PDF" : "Text file"}</div>}
                  <span className="block truncate">{attachment.file.name}</span>
                  <button type="button" data-testid={`button-remove-attachment-${index}`} aria-label={`Remove ${attachment.file.name}`} onClick={() => remove(index)} className="absolute right-1 top-1 rounded bg-background p-1"><X size={13} /></button>
                </div>
              ))}
            </div>
            {error && <div id="report-issue-error" role="alert" data-testid="error-report-issue" className="text-sm text-destructive">{error}</div>}
          </>
        )}
        <DialogFooter>
          {status === "success" ? <button type="button" data-testid="button-close-report-success" onClick={() => onOpenChange(false)} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">Done</button> : <button type="button" data-testid="button-submit-report-issue" onClick={() => void submit()} disabled={status === "loading"} className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">{status === "loading" && <Loader2 size={15} className="animate-spin" />} {status === "loading" ? "Submitting…" : "Submit report"}</button>}
        </DialogFooter>
      </DialogContent>
       <Dialog open={!!preview} onOpenChange={(nextOpen) => { if (!nextOpen) closePreview(); }}>
         {preview && (
           <DialogContent
             data-testid="dialog-report-image-preview"
             aria-modal="true"
             className="z-[60] flex h-[90vh] max-w-5xl items-center justify-center border-0 bg-black/95 p-12"
             onCloseAutoFocus={(event) => {
               event.preventDefault();
               triggerRef.current?.focus();
             }}
           >
             <DialogHeader className="sr-only">
               <DialogTitle>Image preview</DialogTitle>
               <DialogDescription>Enlarged preview of the selected issue attachment.</DialogDescription>
             </DialogHeader>
             <button type="button" data-testid="button-close-report-image-preview" aria-label="Close image preview" className="absolute right-10 top-4 rounded bg-white/10 px-3 py-2 text-white" onClick={closePreview}>Close</button>
             <img src={preview} alt="Enlarged attachment preview" className="max-h-full max-w-full object-contain" />
           </DialogContent>
         )}
       </Dialog>
    </Dialog>
  );
}

export function ReportIssueAction({ portal }: { portal: ReportIssuePortal }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-testid={`button-report-issue-${portal}`} onClick={() => setOpen(true)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"><ImagePlus size={16} /> Report an Issue</button>
      <ReportIssueDialog open={open} onOpenChange={setOpen} portal={portal} />
    </>
  );
}
export function FeedbackAction({ portal }: { portal: ReportIssuePortal }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-testid={`button-feedback-${portal}`} onClick={() => setOpen(true)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"><Paperclip size={16} /> Feedback</button>
      <ReportIssueDialog open={open} onOpenChange={setOpen} portal={portal} kind="feedback" />
    </>
  );
}
