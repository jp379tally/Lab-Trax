import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Box, CheckCircle, CheckCircle2, FileText, Film, Image, Link2, Loader2, PackageOpen, RotateCw, Search, Upload, X, XCircle } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useUploads, type FileWithHandle, type UploadRejection } from "@/lib/uploads-context";
import { supportsDropHandles, supportsFilePicker } from "@/lib/upload-handles";

const PICKER_TYPES = [
  {
    description: "Images, videos, PDFs, and 3D scans",
    accept: {
      "image/*": [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".bmp", ".tif", ".tiff"],
      "video/*": [".mp4", ".mov", ".webm", ".avi"],
      "application/pdf": [".pdf"],
      "model/stl": [".stl"],
      "model/obj": [".obj"],
      "model/ply": [".ply"],
      "application/octet-stream": [".stl", ".obj", ".ply", ".dcm", ".3ds", ".dae"],
    },
  },
];

const SCAN_MIME_TYPES = new Set([
  "model/stl",
  "model/obj",
  "model/ply",
  "application/sla",
]);
const SCAN_EXTENSIONS = new Set([".stl", ".obj", ".ply", ".dcm", ".3ds", ".dae"]);

function is3dScan(mimeType: string, fileName?: string): boolean {
  if (SCAN_MIME_TYPES.has(mimeType)) return true;
  if (fileName) {
    const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
    if (SCAN_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

function isZipFile(file: File): boolean {
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  return ext === ".zip" || file.type === "application/zip" || file.type === "application/x-zip-compressed";
}

function FileTypeIcon({ mimeType, fileName, className }: { mimeType: string; fileName?: string; className?: string }) {
  if (is3dScan(mimeType, fileName)) return <Box size={16} className={className} />;
  if (mimeType === "application/pdf") return <FileText size={16} className={className} />;
  if (mimeType.startsWith("video/")) return <Film size={16} className={className} />;
  return <Image size={16} className={className} />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface OrgLite {
  id: string;
  name?: string;
  type?: string;
}

interface CaseSearchResult {
  id: string;
  caseNumber: string;
  patientFirstName: string;
  patientLastName: string;
  doctorName: string;
  status: string;
}

interface ZipBatchEntry {
  id: string;
  filename: string;
  status: "pending" | "processing" | "created" | "deduped" | "error" | "needs_case_selection" | "attached";
  caseId?: string;
  caseNumber?: string;
  extraFilesAttached?: number;
  attachedCount?: number;
  error?: string;
  /** AI-extracted doctor name from the Rx */
  aiDoctorName?: string | null;
  /** Server-suggested provider org for this ZIP's doctor */
  suggestedProviderOrgId?: string | null;
  suggestedDoctorName?: string | null;
  /** Provider org currently linked on the created case */
  linkedProviderOrgId?: string | null;
  /** True while a PATCH is in flight for this entry */
  patchingProvider?: boolean;
  /** Error message from the last PATCH attempt (if any) */
  patchError?: string | null;
}

interface PendingZip {
  /** Stable local id for React keys */
  id: string;
  file: File;
  /** Per-ZIP practice assignment (may be "" to mean "no practice") */
  providerId: string;
}

interface DesktopFileDropZoneProps {
  organizationId: string | null;
  uploaderName: string;
  onOpenCase?: (caseId: string) => void;
}

function DesktopFileDropZoneInner({ organizationId, uploaderName, onOpenCase }: DesktopFileDropZoneProps) {
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

  // Batch ZIP import state
  const [providerOrgs, setProviderOrgs] = useState<OrgLite[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [pendingZips, setPendingZips] = useState<PendingZip[]>([]);
  const [zipBatchEntries, setZipBatchEntries] = useState<ZipBatchEntry[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);

  // Generic bundle case picker state (for ZIPs that have no iTero Rx)
  const genericZipFilesRef = useRef<Map<string, File>>(new Map());
  const [genericQuery, setGenericQuery] = useState("");
  const [genericResults, setGenericResults] = useState<CaseSearchResult[]>([]);
  const [selectedGenericCase, setSelectedGenericCase] = useState<CaseSearchResult | null>(null);
  const [genericSearchLoading, setGenericSearchLoading] = useState(false);
  const [genericBundleRunning, setGenericBundleRunning] = useState(false);

  useEffect(() => {
    if (!organizationId) return;
    apiFetch<OrgLite[]>("/organizations")
      .then((orgs) => {
        if (Array.isArray(orgs)) {
          const providers = orgs.filter((o) => o.type && o.type !== "lab");
          setProviderOrgs(providers);
          if (providers.length > 0 && !selectedProviderId) {
            setSelectedProviderId(providers[0]!.id);
          }
        }
      })
      .catch(() => {});
  }, [organizationId]);

  // Debounced case search for generic bundle picker
  useEffect(() => {
    const q = genericQuery.trim();
    if (!organizationId || q.length < 2) {
      setGenericResults([]);
      return;
    }
    setGenericSearchLoading(true);
    const timer = setTimeout(() => {
      apiFetch<{ cases: CaseSearchResult[] }>(
        `/cases/quick-search?labOrganizationId=${encodeURIComponent(organizationId)}&q=${encodeURIComponent(q)}`,
      )
        .then((data) => {
          if (Array.isArray(data?.cases)) setGenericResults(data.cases);
        })
        .catch(() => {})
        .finally(() => setGenericSearchLoading(false));
    }, 350);
    return () => {
      clearTimeout(timer);
      setGenericSearchLoading(false);
    };
  }, [organizationId, genericQuery]);

  const processItems = useCallback(
    (items: FileWithHandle[]) => {
      if (!organizationId || items.length === 0) return;

      const zipItems = items.filter((i) => isZipFile(i.file));
      const nonZipItems = items.filter((i) => !isZipFile(i.file));

      if (zipItems.length > 0) {
        setPendingZips((prev) => [
          ...prev,
          ...zipItems.map((i) => ({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            file: i.file,
            providerId: selectedProviderId,
          })),
        ]);
      }

      if (nonZipItems.length > 0) {
        const result = addFiles(nonZipItems, { organizationId, uploaderName });
        setRejections(result.rejections);
      }
    },
    [addFiles, organizationId, uploaderName, selectedProviderId],
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
        if (err?.name === "AbortError") return;
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

  function removePendingZip(id: string) {
    setPendingZips((prev) => prev.filter((z) => z.id !== id));
  }

  function updatePendingZipProvider(id: string, providerId: string) {
    setPendingZips((prev) =>
      prev.map((z) => (z.id === id ? { ...z, providerId } : z))
    );
  }

  function clearBatch() {
    setPendingZips([]);
    setZipBatchEntries([]);
    genericZipFilesRef.current.clear();
    setGenericQuery("");
    setGenericResults([]);
    setSelectedGenericCase(null);
  }

  async function patchCasePractice(entryId: string, caseId: string, newProviderId: string) {
    setZipBatchEntries((prev) =>
      prev.map((e) => (e.id === entryId ? { ...e, patchingProvider: true, patchError: null } : e))
    );
    try {
      await apiFetch(`/cases/${caseId}`, {
        method: "PATCH",
        body: JSON.stringify({
          providerOrganizationId: newProviderId || null,
          clearSuggestion: true,
        }),
        headers: { "Content-Type": "application/json" },
      });
      setZipBatchEntries((prev) =>
        prev.map((e) =>
          e.id === entryId
            ? { ...e, patchingProvider: false, linkedProviderOrgId: newProviderId || null, patchError: null }
            : e
        )
      );
    } catch (err: any) {
      setZipBatchEntries((prev) =>
        prev.map((e) =>
          e.id === entryId
            ? { ...e, patchingProvider: false, patchError: err?.message || "Could not update practice." }
            : e
        )
      );
    }
  }

  async function runBatchImport() {
    if (!organizationId || pendingZips.length === 0 || batchRunning) return;

    // Snapshot pending zips before clearing state so the loop closure still sees them.
    const pendingZipsSnapshot = pendingZips;
    const initialEntries: ZipBatchEntry[] = pendingZipsSnapshot.map((pz) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filename: pz.file.name,
      status: "pending",
    }));
    setZipBatchEntries(initialEntries);
    setPendingZips([]);
    setBatchRunning(true);

    for (let i = 0; i < initialEntries.length; i++) {
      const entry = initialEntries[i]!;
      const pz = pendingZipsSnapshot[i]!;

      setZipBatchEntries((prev) =>
        prev.map((e) => (e.id === entry.id ? { ...e, status: "processing" } : e))
      );

      try {
        const fd = new FormData();
        fd.append("files[]", pz.file);
        fd.append("labOrganizationId", organizationId);
        if (pz.providerId) fd.append("providerOrganizationId", pz.providerId);

        const result = await apiFetch<{
          results: Array<{
            filename: string;
            status: "created" | "deduped" | "error";
            caseId?: string;
            caseNumber?: string;
            extraFilesAttached?: number;
            error?: string;
            aiDoctorName?: string | null;
            suggestedProviderOrgId?: string | null;
            suggestedDoctorName?: string | null;
            linkedProviderOrgId?: string | null;
          }>;
        }>("/cases/import-from-itero-zip-batch", {
          method: "POST",
          body: fd,
          headers: {},
        });

        const fileResult = result?.results?.[0];
        if (!fileResult) throw new Error("No result returned from server.");

        const isNoRxError =
          fileResult.status === "error" &&
          fileResult.error?.includes("No iTero Rx file found");

        if (isNoRxError) {
          genericZipFilesRef.current.set(entry.id, pz.file);
          setZipBatchEntries((prev) =>
            prev.map((e) =>
              e.id === entry.id
                ? { ...e, status: "needs_case_selection", error: undefined }
                : e
            )
          );
        } else {
          setZipBatchEntries((prev) =>
            prev.map((e) =>
              e.id === entry.id
                ? {
                    ...e,
                    status: fileResult.status,
                    caseId: fileResult.caseId ?? undefined,
                    caseNumber: fileResult.caseNumber ?? undefined,
                    extraFilesAttached: fileResult.extraFilesAttached,
                    error: fileResult.error,
                    aiDoctorName: fileResult.aiDoctorName,
                    suggestedProviderOrgId: fileResult.suggestedProviderOrgId,
                    suggestedDoctorName: fileResult.suggestedDoctorName,
                    linkedProviderOrgId: fileResult.linkedProviderOrgId,
                  }
                : e
            )
          );
        }
      } catch (err: any) {
        setZipBatchEntries((prev) =>
          prev.map((e) =>
            e.id === entry.id
              ? { ...e, status: "error", error: err?.message || "Import failed." }
              : e
          )
        );
      }
    }

    setBatchRunning(false);
  }

  async function runGenericBundleAttach() {
    if (!organizationId || !selectedGenericCase || genericBundleRunning) return;

    const pendingEntries = zipBatchEntries.filter(
      (e) => e.status === "needs_case_selection",
    );
    if (pendingEntries.length === 0) return;

    setGenericBundleRunning(true);

    for (const entry of pendingEntries) {
      const file = genericZipFilesRef.current.get(entry.id);
      if (!file) {
        setZipBatchEntries((prev) =>
          prev.map((e) =>
            e.id === entry.id
              ? { ...e, status: "error", error: "File reference lost — please re-drop the ZIP." }
              : e
          )
        );
        continue;
      }

      setZipBatchEntries((prev) =>
        prev.map((e) => (e.id === entry.id ? { ...e, status: "processing" } : e))
      );

      try {
        const fd = new FormData();
        fd.append("files[]", file);
        fd.append("labOrganizationId", organizationId);
        fd.append("caseId", selectedGenericCase.id);

        const result = await apiFetch<{
          results: Array<{
            filename: string;
            status: "attached" | "error";
            attachedCount?: number;
            failedCount?: number;
            error?: string;
          }>;
        }>("/cases/import-generic-zip-bundle", {
          method: "POST",
          body: fd,
          headers: {},
        });

        const fileResult = result?.results?.[0];
        if (!fileResult) throw new Error("No result returned from server.");

        setZipBatchEntries((prev) =>
          prev.map((e) =>
            e.id === entry.id
              ? {
                  ...e,
                  status: fileResult.status === "attached" ? "attached" : "error",
                  caseId: fileResult.status === "attached" ? selectedGenericCase.id : undefined,
                  caseNumber:
                    fileResult.status === "attached" ? selectedGenericCase.caseNumber : undefined,
                  attachedCount: fileResult.attachedCount,
                  error: fileResult.error,
                }
              : e
          )
        );

        if (fileResult.status === "attached") {
          genericZipFilesRef.current.delete(entry.id);
        }
      } catch (err: any) {
        setZipBatchEntries((prev) =>
          prev.map((e) =>
            e.id === entry.id
              ? { ...e, status: "needs_case_selection", error: err?.message || "Attach failed." }
              : e
          )
        );
      }
    }

    setGenericBundleRunning(false);
  }

  const disabled = !organizationId;
  const hasBatchResults = zipBatchEntries.length > 0;
  const hasNeedsCaseSelection = zipBatchEntries.some((e) => e.status === "needs_case_selection");
  const batchDone =
    hasBatchResults &&
    !batchRunning &&
    !genericBundleRunning &&
    zipBatchEntries.every(
      (e) =>
        e.status !== "processing" &&
        e.status !== "pending" &&
        e.status !== "needs_case_selection",
    );

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-3.5 border-b border-border">
        <h2 className="text-sm font-semibold">Pending file inbox</h2>
        <p className="text-xs text-muted-foreground">
          Drop files here to share them with your lab team. Drop iTero ZIPs to batch-import cases.
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
                Images, videos, PDFs, 3D scans &mdash; or iTero ZIPs to create cases
              </p>
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*,application/pdf,.stl,.obj,.ply,.dcm,.3ds,.dae"
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

        {/* ── Pending ZIP panel ─────────────────────────────────────────── */}
        {pendingZips.length > 0 && !hasBatchResults && (
          <div className="rounded-lg border border-border bg-secondary/20 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <PackageOpen size={15} className="text-primary shrink-0" />
              <p className="text-sm font-medium">
                {pendingZips.length} ZIP{pendingZips.length === 1 ? "" : "s"} ready to import
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              iTero ZIPs will create new cases automatically. Non-iTero ZIPs (3Shape, Dental Wings, etc.) will ask you to pick an existing case to attach their files to.
            </p>

            <ul className="space-y-2">
              {pendingZips.map((pz) => (
                <li key={pz.id} className="rounded-md border border-border bg-background/60 px-3 py-2 space-y-1.5">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <FileText size={12} className="shrink-0" />
                    <span className="truncate flex-1">{pz.file.name}</span>
                    <span className="shrink-0">{formatBytes(pz.file.size)}</span>
                    <button
                      type="button"
                      onClick={() => removePendingZip(pz.id)}
                      className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                      aria-label={`Remove ${pz.file.name}`}
                    >
                      <X size={12} />
                    </button>
                  </div>
                  {providerOrgs.length > 0 && (
                    <select
                      value={pz.providerId}
                      onChange={(e) => updatePendingZipProvider(pz.id, e.target.value)}
                      className="w-full text-xs rounded border border-border bg-background px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="">— No practice —</option>
                      {providerOrgs.map((o) => (
                        <option key={o.id} value={o.id}>{o.name ?? o.id}</option>
                      ))}
                    </select>
                  )}
                </li>
              ))}
            </ul>

            {providerOrgs.length > 0 && pendingZips.length > 1 && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">
                  Set practice for all
                </label>
                <select
                  value=""
                  onChange={(e) => {
                    const val = e.target.value;
                    setSelectedProviderId(val);
                    setPendingZips((prev) => prev.map((z) => ({ ...z, providerId: val })));
                  }}
                  className="w-full text-xs rounded-md border border-border bg-background px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="">— Apply a practice to all ZIPs —</option>
                  {providerOrgs.map((o) => (
                    <option key={o.id} value={o.id}>{o.name ?? o.id}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void runBatchImport()}
                disabled={batchRunning}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                Import {pendingZips.length} ZIP{pendingZips.length === 1 ? "" : "s"}
              </button>
              <button
                type="button"
                onClick={clearBatch}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* ── Batch progress results ────────────────────────────────────── */}
        {hasBatchResults && (
          <div className="rounded-lg border border-border bg-secondary/20 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <PackageOpen size={15} className="text-primary shrink-0" />
                <p className="text-sm font-medium">
                  {batchRunning
                    ? "Batch import in progress…"
                    : hasNeedsCaseSelection
                      ? "Batch import complete — action needed"
                      : "Batch import complete"}
                </p>
              </div>
              {batchDone && (
                <button
                  type="button"
                  onClick={clearBatch}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Dismiss
                </button>
              )}
            </div>

            <ul className="space-y-1.5">
              {zipBatchEntries.map((entry) => (
                <li
                  key={entry.id}
                  className={[
                    "rounded-md px-3 py-2 text-xs border",
                    entry.status === "error"
                      ? "bg-destructive/10 border-destructive/20"
                      : entry.status === "created" || entry.status === "attached"
                        ? "bg-success/10 border-success/20"
                        : entry.status === "deduped"
                          ? "bg-muted/50 border-border"
                          : entry.status === "needs_case_selection"
                            ? "bg-amber-500/10 border-amber-500/30"
                            : "bg-background border-border",
                  ].join(" ")}
                >
                  <div className="flex items-start gap-2.5">
                    <div className="mt-0.5 shrink-0">
                      {(entry.status === "pending" || entry.status === "processing") && (
                        <Loader2 size={13} className="animate-spin text-muted-foreground" />
                      )}
                      {(entry.status === "created" || entry.status === "attached") && (
                        <CheckCircle2 size={13} className="text-success" />
                      )}
                      {entry.status === "deduped" && (
                        <CheckCircle size={13} className="text-muted-foreground" />
                      )}
                      {entry.status === "error" && (
                        <XCircle size={13} className="text-destructive" />
                      )}
                      {entry.status === "needs_case_selection" && (
                        <AlertTriangle size={13} className="text-amber-500" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate text-foreground">{entry.filename}</p>
                      {entry.status === "pending" && (
                        <p className="text-muted-foreground">Waiting…</p>
                      )}
                      {entry.status === "processing" && (
                        <p className="text-muted-foreground">Processing…</p>
                      )}
                      {entry.status === "created" && (
                        <p className="text-success">
                          Case #{entry.caseNumber} created
                          {typeof entry.extraFilesAttached === "number" && entry.extraFilesAttached > 0
                            ? ` · ${entry.extraFilesAttached} scan${entry.extraFilesAttached === 1 ? "" : "s"} attached`
                            : ""}
                          {entry.caseId && onOpenCase && (
                            <>
                              {" · "}
                              <button
                                type="button"
                                onClick={() => onOpenCase(entry.caseId!)}
                                className="underline underline-offset-2 hover:no-underline"
                              >
                                Open
                              </button>
                            </>
                          )}
                        </p>
                      )}
                      {entry.status === "attached" && (
                        <p className="text-success">
                          {entry.attachedCount ?? 0} file{(entry.attachedCount ?? 0) === 1 ? "" : "s"} attached to Case #{entry.caseNumber}
                          {entry.caseId && onOpenCase && (
                            <>
                              {" · "}
                              <button
                                type="button"
                                onClick={() => onOpenCase(entry.caseId!)}
                                className="underline underline-offset-2 hover:no-underline"
                              >
                                Open
                              </button>
                            </>
                          )}
                        </p>
                      )}
                      {entry.status === "deduped" && (
                        <p className="text-muted-foreground">
                          Already imported — Case #{entry.caseNumber ?? entry.caseId}
                          {entry.caseId && onOpenCase && (
                            <>
                              {" · "}
                              <button
                                type="button"
                                onClick={() => onOpenCase(entry.caseId!)}
                                className="underline underline-offset-2 hover:no-underline"
                              >
                                Open
                              </button>
                            </>
                          )}
                        </p>
                      )}
                      {entry.status === "needs_case_selection" && (
                        <p className="text-amber-600 dark:text-amber-400">
                          No iTero Rx found — select a case below to attach its files
                        </p>
                      )}
                      {entry.status === "error" && (
                        <p className="text-destructive">{entry.error || "Import failed."}</p>
                      )}
                    </div>
                  </div>

                  {/* Per-ZIP practice assignment — shown for created cases only */}
                  {entry.status === "created" && entry.caseId && providerOrgs.length > 0 && (
                    <div className="mt-2 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="flex-1 min-w-0">
                          {entry.aiDoctorName && (
                            <p className="text-muted-foreground mb-1 truncate">
                              AI extracted: <span className="font-medium text-foreground">{entry.aiDoctorName}</span>
                              {entry.suggestedDoctorName && entry.suggestedDoctorName !== entry.aiDoctorName && (
                                <span className="ml-1">(similar to <em>{entry.suggestedDoctorName}</em>)</span>
                              )}
                            </p>
                          )}
                          <select
                            disabled={!!entry.patchingProvider}
                            value={entry.linkedProviderOrgId ?? ""}
                            onChange={(e) => {
                              if (entry.caseId) {
                                void patchCasePractice(entry.id, entry.caseId, e.target.value);
                              }
                            }}
                            className="w-full rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                          >
                            <option value="">— No practice —</option>
                            {providerOrgs.map((o) => (
                              <option key={o.id} value={o.id}>{o.name ?? o.id}</option>
                            ))}
                          </select>
                        </div>
                        {entry.patchingProvider && (
                          <Loader2 size={12} className="animate-spin text-muted-foreground shrink-0" />
                        )}
                      </div>
                      {entry.patchError && (
                        <p className="text-destructive flex items-center gap-1">
                          <XCircle size={11} className="shrink-0" />
                          {entry.patchError}
                        </p>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── Generic bundle case picker ────────────────────────────────── */}
        {hasBatchResults && hasNeedsCaseSelection && !batchRunning && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Link2 size={15} className="text-amber-500 shrink-0" />
              <p className="text-sm font-medium">Attach scan bundle to an existing case</p>
            </div>
            <p className="text-xs text-muted-foreground">
              The ZIP{zipBatchEntries.filter((e) => e.status === "needs_case_selection").length === 1 ? "" : "s"} above
              {" "}don't contain an iTero prescription. Search for the case you'd like to attach their files to.
            </p>

            {selectedGenericCase ? (
              <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs">
                <CheckCircle2 size={13} className="text-success shrink-0" />
                <span className="flex-1 truncate font-medium">
                  Case #{selectedGenericCase.caseNumber} — {selectedGenericCase.patientFirstName} {selectedGenericCase.patientLastName}
                </span>
                <button
                  type="button"
                  onClick={() => { setSelectedGenericCase(null); setGenericQuery(""); }}
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Change selected case"
                >
                  <X size={12} />
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  <input
                    type="text"
                    value={genericQuery}
                    onChange={(e) => setGenericQuery(e.target.value)}
                    placeholder="Search by case # or patient name…"
                    className="w-full text-xs rounded-md border border-border bg-background pl-7 pr-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  {genericSearchLoading && (
                    <Loader2 size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground" />
                  )}
                </div>
                {genericResults.length > 0 && (
                  <ul className="rounded-md border border-border bg-background divide-y divide-border max-h-44 overflow-y-auto">
                    {genericResults.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => { setSelectedGenericCase(c); setGenericQuery(""); setGenericResults([]); }}
                          className="w-full text-left px-3 py-2 text-xs hover:bg-secondary/50 transition-colors"
                        >
                          <span className="font-medium">Case #{c.caseNumber}</span>
                          {" — "}
                          <span>{c.patientFirstName} {c.patientLastName}</span>
                          {c.doctorName && (
                            <span className="text-muted-foreground"> · {c.doctorName}</span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {genericQuery.trim().length >= 2 && !genericSearchLoading && genericResults.length === 0 && (
                  <p className="text-xs text-muted-foreground px-1">No cases found.</p>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => void runGenericBundleAttach()}
              disabled={!selectedGenericCase || genericBundleRunning}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {genericBundleRunning ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Attaching…
                </>
              ) : (
                <>
                  <Link2 size={12} />
                  Attach {zipBatchEntries.filter((e) => e.status === "needs_case_selection").length} file bundle{zipBatchEntries.filter((e) => e.status === "needs_case_selection").length === 1 ? "" : "s"} to case
                </>
              )}
            </button>
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
                  <FileTypeIcon mimeType={entry.mimeType} fileName={entry.fileName} />
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
                          accept="image/*,video/*,application/pdf,.stl,.obj,.ply,.dcm,.3ds,.dae"
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

export function DesktopFileDropZone({ onOpenCase }: { onOpenCase?: (caseId: string) => void }) {
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

  return <DesktopFileDropZoneInner organizationId={orgId} uploaderName={uploaderName} onOpenCase={onOpenCase} />;
}
