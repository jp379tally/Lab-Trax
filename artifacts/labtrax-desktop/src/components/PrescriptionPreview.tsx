import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FileText,
  GitBranch,
  ImageOff,
  Loader2,
  Paperclip,
  ScrollText,
  X,
} from "lucide-react";
import { apiFetch, getApiOrigin, getAccessToken } from "@/lib/api";
import { AuthedImage, AuthedVideo, isSameApiOrigin } from "@/components/AuthedMedia";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDateTime, statusLabel } from "@/lib/format";
import {
  deriveRxSummary,
  formatRxTeethLabel,
  formatRxTeethWithShades,
} from "@/lib/rx-summary";
import type {
  CaseAttachment,
  CaseEvent,
  CaseRestoration,
  LabCase,
} from "@/lib/types";

// Subset of the case-detail payload (GET /api/cases/:caseId) that the
// prescription preview needs. The endpoint returns the full case with
// restorations, attachments, and the event timeline.
type PreviewCase = LabCase & {
  restorations?: CaseRestoration[];
  attachments?: CaseAttachment[];
  events?: CaseEvent[];
  caseNotes?: string | null;
};

type RemakeChainEntry = {
  id: string;
  caseNumber: string;
  status: string | null;
  remakeReason: string | null;
  remakeCharged: boolean | null;
  createdAt: string | null;
};

type Lightbox =
  | { url: string; kind: "image" | "video"; mimeType?: string }
  | null;

function formatEventType(eventType: string | undefined | null): string {
  if (!eventType) return "Event";
  if (eventType === "status_changed") return "Location Changed";
  return eventType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function openFileInNewTab(url: string) {
  if (url.startsWith("data:") || url.startsWith("blob:")) {
    window.open(url, "_blank");
    return;
  }
  try {
    const token = getAccessToken();
    const sameOrigin = isSameApiOrigin(url);
    const resp = await fetch(
      url,
      sameOrigin && token
        ? { headers: { Authorization: `Bearer ${token}` } }
        : undefined,
    );
    if (!resp.ok) throw new Error(String(resp.status));
    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    window.open(objUrl, "_blank");
    setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
  } catch {
    window.open(url, "_blank");
  }
}

function Field({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
        {label}
      </div>
      <div className="text-sm mt-0.5 whitespace-pre-wrap break-words">
        {value || "—"}
      </div>
    </div>
  );
}

function AttachmentThumb({
  caseId,
  attachment,
  onLightbox,
}: {
  caseId: string;
  attachment: CaseAttachment;
  onLightbox: (lb: Lightbox) => void;
}) {
  const fileType = attachment.fileType || "";
  const isImg = fileType.startsWith("image/");
  const isVid = fileType.startsWith("video/");
  const src = `${getApiOrigin()}/api/cases/${caseId}/attachments/${attachment.id}/file`;

  if (isImg) {
    return (
      <button
        type="button"
        onClick={() => onLightbox({ url: src, kind: "image" })}
        className="block group"
        title={`View ${attachment.fileName}`}
      >
        <AuthedImage
          url={src}
          alt={attachment.fileName}
          className="w-20 h-20 object-cover rounded-md border border-border group-hover:border-primary/50 transition-colors"
          fallback={
            <div className="w-20 h-20 flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border bg-secondary text-muted-foreground">
              <ImageOff size={16} />
              <span className="text-[9px] leading-tight">Unavailable</span>
            </div>
          }
        />
      </button>
    );
  }
  if (isVid) {
    return (
      <button
        type="button"
        onClick={() =>
          onLightbox({ url: src, kind: "video", mimeType: fileType || "video/mp4" })
        }
        className="block group relative"
        title={`Play ${attachment.fileName}`}
      >
        <AuthedVideo
          url={src}
          className="w-20 h-20 object-cover rounded-md border border-border group-hover:border-primary/50 transition-colors bg-black"
          muted
          playsInline
          preload="metadata"
        />
        <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="h-7 w-7 rounded-full bg-black/60 text-white flex items-center justify-center text-[10px] font-bold">
            ▶
          </span>
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void openFileInNewTab(src)}
      className="w-20 h-20 flex flex-col items-center justify-center gap-1 rounded-md border border-border bg-secondary text-muted-foreground hover:border-primary/50 hover:text-foreground transition-colors px-1"
      title={`Open ${attachment.fileName}`}
    >
      <Paperclip size={16} />
      <span className="text-[9px] leading-tight text-center line-clamp-2 break-all">
        {attachment.fileName}
      </span>
    </button>
  );
}

// Renders an attachment referenced inline from a history event's metadata.
function HistoryEventMedia({
  caseId,
  metadata,
  onLightbox,
}: {
  caseId: string;
  metadata: Record<string, unknown>;
  onLightbox: (lb: Lightbox) => void;
}) {
  const fileType = String(metadata.fileType ?? "");
  const mediaKind = String(metadata.mediaKind ?? "");
  const isImg = fileType.startsWith("image/") || mediaKind === "photo";
  const isVid = fileType.startsWith("video/") || mediaKind === "video";
  const directSrc = metadata.imageUri ? String(metadata.imageUri) : null;
  const apiSrc = metadata.attachmentId
    ? `${getApiOrigin()}/api/cases/${caseId}/attachments/${String(metadata.attachmentId)}/file`
    : null;
  const src = directSrc || apiSrc;
  if (!src) {
    return metadata.fileName ? (
      <div className="mt-1.5">
        <span className="text-xs text-muted-foreground">
          {String(metadata.fileName)}
        </span>
      </div>
    ) : null;
  }
  const mime = fileType || (isVid ? "video/mp4" : isImg ? "image/jpeg" : undefined);
  return (
    <div className="mt-1.5">
      {isImg ? (
        <button
          type="button"
          onClick={() => onLightbox({ url: src, kind: "image" })}
          className="block group"
          title={`View ${metadata.fileName ?? "image"}`}
        >
          <AuthedImage
            url={src}
            alt={String(metadata.fileName ?? "attachment")}
            className="w-20 h-20 object-cover rounded-md border border-border group-hover:border-primary/50 transition-colors"
            fallback={
              <div className="w-20 h-20 flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border bg-secondary text-muted-foreground">
                <ImageOff size={16} />
                <span className="text-[9px] leading-tight">Unavailable</span>
              </div>
            }
          />
        </button>
      ) : isVid ? (
        <button
          type="button"
          onClick={() => onLightbox({ url: src, kind: "video", mimeType: mime })}
          className="block group relative"
          title={`Play ${metadata.fileName ?? "video"}`}
        >
          <AuthedVideo
            url={src}
            className="w-20 h-20 object-cover rounded-md border border-border group-hover:border-primary/50 transition-colors bg-black"
            muted
            playsInline
            preload="metadata"
          />
          <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="h-7 w-7 rounded-full bg-black/60 text-white flex items-center justify-center text-[10px] font-bold">
              ▶
            </span>
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void openFileInNewTab(src)}
          className="inline-flex items-center gap-1.5 text-xs text-primary underline hover:text-primary/80"
          title={`Open ${metadata.fileName ?? "file"}`}
        >
          <Paperclip size={12} />
          {String(metadata.fileName ?? "Open file")}
        </button>
      )}
    </div>
  );
}

export function PrescriptionPreview({
  caseId,
  invoiceCaseId,
  onClose,
}: {
  /** The case whose prescription chain is being previewed. */
  caseId: string;
  /** The case the invoice is tied to — marked "This invoice" in the chain. */
  invoiceCaseId: string;
  onClose: () => void;
}) {
  const [selectedCaseId, setSelectedCaseId] = useState(caseId);
  const [lightbox, setLightbox] = useState<Lightbox>(null);

  // Close on Escape (lightbox first, then the whole panel).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (lightbox) setLightbox(null);
      else onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, onClose]);

  const chainQuery = useQuery({
    queryKey: ["prescription-preview-chain", caseId],
    queryFn: () =>
      apiFetch<{ chain: RemakeChainEntry[] }>(`/cases/${caseId}/remake-chain`),
    staleTime: 30_000,
  });
  const chain = chainQuery.data?.chain ?? [];
  const hasChain = chain.length >= 2;

  const detailQuery = useQuery({
    queryKey: ["prescription-preview-case", selectedCaseId],
    queryFn: () => apiFetch<PreviewCase>(`/cases/${selectedCaseId}`),
    enabled: !!selectedCaseId,
  });
  const data = detailQuery.data ?? null;

  const summary = useMemo(
    () => deriveRxSummary(data?.restorations),
    [data?.restorations],
  );
  const teethLabel = useMemo(
    () =>
      formatRxTeethWithShades(data?.restorations, formatRxTeethLabel(summary)),
    [data?.restorations, summary],
  );

  const attachments = data?.attachments ?? [];
  const images = attachments.filter((a) => (a.fileType || "").startsWith("image/"));
  const videos = attachments.filter((a) => (a.fileType || "").startsWith("video/"));
  const others = attachments.filter((a) => {
    const t = a.fileType || "";
    return !t.startsWith("image/") && !t.startsWith("video/");
  });

  const events = useMemo(
    () =>
      [...(data?.events ?? [])].sort((a, b) => {
        const ta = new Date(a.occurredAt || a.createdAt || 0).getTime();
        const tb = new Date(b.occurredAt || b.createdAt || 0).getTime();
        return ta - tb;
      }),
    [data?.events],
  );

  const patientName =
    `${data?.patientFirstName ?? ""} ${data?.patientLastName ?? ""}`.trim() ||
    data?.patientInitials ||
    "—";

  return (
    <div
      className="fixed inset-0 z-[55] flex items-stretch justify-end bg-foreground/40"
      onClick={onClose}
    >
      <div
        className="relative bg-card border-l border-border h-full w-full max-w-2xl overflow-y-auto scrollbar-thin"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 z-10 bg-card border-b border-border px-6 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <ScrollText size={16} className="text-primary shrink-0" />
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">
                Prescription preview
              </div>
              <div className="font-mono text-sm font-semibold truncate">
                {data?.caseNumber ?? "…"}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-9 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground shrink-0"
            title="Close preview"
          >
            <X size={18} />
          </button>
        </header>

        <div className="px-6 py-5 space-y-6">
          {/* Remake / subsequent prescription navigation */}
          {hasChain && (
            <section>
              <h3 className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2">
                <GitBranch size={13} /> Prescriptions in this case
              </h3>
              <div className="flex flex-wrap gap-2">
                {chain.map((entry, idx) => {
                  const isSelected = entry.id === selectedCaseId;
                  const isInvoiceCase = entry.id === invoiceCaseId;
                  const genLabel = String.fromCharCode(65 + idx);
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setSelectedCaseId(entry.id)}
                      className={[
                        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors",
                        isSelected
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border hover:bg-secondary text-muted-foreground hover:text-foreground",
                      ].join(" ")}
                      title={entry.remakeReason ?? undefined}
                    >
                      <span
                        className={[
                          "flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-bold shrink-0",
                          isSelected
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground",
                        ].join(" ")}
                      >
                        {genLabel}
                      </span>
                      <span className="font-mono font-medium">
                        {entry.caseNumber}
                      </span>
                      {idx === 0 && (
                        <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                          Original
                        </span>
                      )}
                      {isInvoiceCase && (
                        <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-medium">
                          This invoice
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {detailQuery.isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <Loader2 size={14} className="animate-spin" /> Loading prescription…
            </div>
          )}

          {detailQuery.isError && (
            <div className="text-sm text-destructive py-8 text-center">
              Couldn't load this prescription.
            </div>
          )}

          {data && (
            <>
              {/* Prescription summary */}
              <section>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  Prescription
                  {data.status && <StatusBadge status={data.status} />}
                </h3>
                <div className="rounded-lg border border-border bg-secondary/20 px-4 py-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Field label="Patient" value={patientName} />
                  <Field label="Doctor" value={data.doctorName} />
                  <Field
                    label="Restorative Type"
                    value={summary.restorativeType ?? "—"}
                  />
                  <Field
                    label={summary.materials.length > 1 ? "Materials" : "Material"}
                    value={
                      summary.materials.length > 0
                        ? summary.materials.join(", ")
                        : "—"
                    }
                  />
                  <Field
                    label={summary.shades.length > 1 ? "Shades" : "Shade"}
                    value={
                      summary.shades.length > 0 ? summary.shades.join(", ") : "—"
                    }
                  />
                  <Field
                    label={
                      summary.isFullArch ? "Tooth Coverage" : "Tooth Number(s)"
                    }
                    value={teethLabel || "—"}
                  />
                  <div className="md:col-span-2">
                    <Field label="Rx Notes" value={(data.caseNotes ?? "").trim()} />
                  </div>
                </div>

                {/* Per-restoration detail */}
                {(data.restorations?.length ?? 0) > 0 && (
                  <div className="mt-3 overflow-hidden rounded-lg border border-border">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-secondary/40 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                          <th className="px-3 py-2 font-medium">Tooth</th>
                          <th className="px-3 py-2 font-medium">Type</th>
                          <th className="px-3 py-2 font-medium">Material</th>
                          <th className="px-3 py-2 font-medium">Shade</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.restorations!.map((r) => (
                          <tr key={r.id} className="border-t border-border">
                            <td className="px-3 py-2 font-mono">
                              {r.toothNumber || "—"}
                            </td>
                            <td className="px-3 py-2">
                              {r.restorationType || "—"}
                            </td>
                            <td className="px-3 py-2">{r.material || "—"}</td>
                            <td className="px-3 py-2">{r.shade || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* Files */}
              <section>
                <h3 className="flex items-center gap-1.5 text-sm font-semibold mb-3">
                  <FileText size={15} /> Files
                  <span className="text-xs font-normal text-muted-foreground">
                    ({attachments.length})
                  </span>
                </h3>
                {attachments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No files attached to this prescription.
                  </p>
                ) : (
                  <div className="space-y-4">
                    {images.length > 0 && (
                      <div>
                        <p className="text-[11px] text-muted-foreground font-medium mb-2">
                          Photos &amp; Images ({images.length})
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {images.map((a) => (
                            <AttachmentThumb
                              key={a.id}
                              caseId={selectedCaseId}
                              attachment={a}
                              onLightbox={setLightbox}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                    {videos.length > 0 && (
                      <div>
                        <p className="text-[11px] text-muted-foreground font-medium mb-2">
                          Videos ({videos.length})
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {videos.map((a) => (
                            <AttachmentThumb
                              key={a.id}
                              caseId={selectedCaseId}
                              attachment={a}
                              onLightbox={setLightbox}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                    {others.length > 0 && (
                      <div>
                        <p className="text-[11px] text-muted-foreground font-medium mb-2">
                          Documents &amp; Files ({others.length})
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {others.map((a) => (
                            <AttachmentThumb
                              key={a.id}
                              caseId={selectedCaseId}
                              attachment={a}
                              onLightbox={setLightbox}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* Case History */}
              <section>
                <h3 className="text-sm font-semibold mb-3">Case History</h3>
                {events.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No activity logged yet.
                  </p>
                ) : (
                  <div>
                    {events.map((e, idx) => {
                      const isLast = idx === events.length - 1;
                      const eventType = e.eventType || "";
                      const isStatus = eventType === "status_changed";
                      const isNote = eventType === "note_added";
                      const isAttachment = eventType.includes("attachment");
                      const isInvoice = eventType.includes("invoice");
                      const isRestoration = eventType.includes("restoration");
                      const metadata: Record<string, unknown> =
                        e.metadataJson && typeof e.metadataJson === "object"
                          ? (e.metadataJson as Record<string, unknown>)
                          : {};
                      const dotColor = isStatus
                        ? "#3B82F6"
                        : isNote
                        ? "#F59E0B"
                        : isAttachment
                        ? "#8B5CF6"
                        : isInvoice
                        ? "#10B981"
                        : isRestoration
                        ? "#6366F1"
                        : "#94A3B8";
                      return (
                        <div key={e.id || idx} className="flex gap-3 pb-5">
                          <div className="flex flex-col items-center shrink-0 mt-0.5">
                            <div
                              className="w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: dotColor }}
                            />
                            {!isLast && (
                              <div className="w-px flex-1 bg-border mt-1.5" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0 -mt-0.5">
                            <div className="flex items-start justify-between gap-2">
                              <div className="text-sm font-medium">
                                {formatEventType(e.eventType)}
                              </div>
                              <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
                                {formatDateTime(e.occurredAt || e.createdAt)}
                              </span>
                            </div>
                            {(e.actorInitials ||
                              (metadata.user as string | undefined)) && (
                              <div className="text-xs text-muted-foreground mt-0.5">
                                {e.actorInitials || String(metadata.user)}
                              </div>
                            )}
                            {isStatus &&
                              (metadata.fromStatus as string | undefined) &&
                              (metadata.toStatus as string | undefined) && (
                                <div className="flex items-center gap-1.5 mt-1">
                                  <StatusBadge
                                    status={String(metadata.fromStatus)}
                                  />
                                  <span className="text-xs text-muted-foreground">
                                    →
                                  </span>
                                  <StatusBadge
                                    status={String(metadata.toStatus)}
                                  />
                                </div>
                              )}
                            {isNote &&
                              Boolean(metadata.noteText || metadata.description) && (
                                <div className="mt-1.5 text-sm bg-secondary/50 border border-border rounded-md px-3 py-2 whitespace-pre-wrap break-words">
                                  {String(
                                    metadata.noteText ?? metadata.description,
                                  )}
                                </div>
                              )}
                            {isAttachment && (
                              <HistoryEventMedia
                                caseId={selectedCaseId}
                                metadata={metadata}
                                onLightbox={setLightbox}
                              />
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>

      {/* Image / Video lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[70] bg-black/90 flex items-center justify-center"
          onClick={() => setLightbox(null)}
        >
          <button
            type="button"
            onClick={() => setLightbox(null)}
            className="absolute top-4 right-4 h-10 w-10 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20 transition-colors"
          >
            <X size={20} />
          </button>
          {lightbox.kind === "video" ? (
            <AuthedVideo
              url={lightbox.url}
              controls
              autoPlay
              mimeType={lightbox.mimeType}
              className="max-w-[90vw] max-h-[90vh] rounded-lg bg-black"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <AuthedImage
              url={lightbox.url}
              alt="Preview"
              className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      )}
    </div>
  );
}
