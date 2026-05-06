import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

interface LegacyCaseLite {
  id: string;
  caseNumber: string;
  doctorName: string;
  patientName: string;
  photos?: string[];
  ownerId?: string;
  affiliationKey?: string | null;
  affiliationName?: string | null;
  [k: string]: any;
}

interface ExtractedRx {
  doctorName?: string | null;
  patientName?: string | null;
  patientInitials?: string | null;
  caseType?: string | null;
  toothIndices?: string | null;
  shade?: string | null;
  material?: string | null;
  dueDate?: string | null;
  isRush?: boolean | null;
  notes?: string | null;
  practiceName?: string | null;
}

type Phase =
  | { kind: "idle" }
  | { kind: "draggingFile" }
  | { kind: "picking"; files: File[] }
  | { kind: "analyzing"; fileName: string }
  | { kind: "rxConfirm"; file: File; caseNumber: string }
  | { kind: "uploading"; message?: string }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

async function fileToDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error || new Error("Could not read file."));
    r.readAsDataURL(file);
  });
}

let pdfjsReady: Promise<typeof import("pdfjs-dist")> | null = null;
async function getPdfjs() {
  if (!pdfjsReady) {
    pdfjsReady = (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url"))
        .default;
      pdfjs.GlobalWorkerOptions.workerSrc = worker;
      return pdfjs;
    })();
  }
  return pdfjsReady;
}

async function pdfToJpegDataUrls(
  file: File,
  maxPages = 3,
): Promise<string[]> {
  const pdfjs = await getPdfjs();
  const ab = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(ab) }).promise;
  const pages = Math.min(doc.numPages, maxPages);
  const out: string[] = [];
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1.6 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    await (page as any).render({
      canvasContext: ctx,
      viewport,
      canvas,
    }).promise;
    out.push(canvas.toDataURL("image/jpeg", 0.85));
  }
  return out;
}

function isImage(file: File): boolean {
  return file.type.startsWith("image/");
}
function isPdf(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
}
function canReadAsRx(file: File): boolean {
  return isImage(file) || isPdf(file);
}

function nextYearCaseNumber(legacy: LegacyCaseLite[]): string {
  const yy = String(new Date().getFullYear()).slice(-2);
  let max = 0;
  for (const c of legacy) {
    const cn = c?.caseNumber || "";
    if (!cn.startsWith(`${yy}-`)) continue;
    const n = parseInt(cn.split("-")[1] ?? "", 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${yy}-${max + 1}`;
}

function generateLocalId(): string {
  return Date.now().toString() + Math.random().toString(36).slice(2, 11);
}

function initialsFromName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w[0] || "").toUpperCase() + ".")
    .join("");
}

const inputCls =
  "h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary";

export function DashboardDropZone() {
  const qc = useQueryClient();
  const { user } = useAuth();

  const legacyQuery = useQuery({
    queryKey: ["legacy-cases-for-dropzone"],
    queryFn: () =>
      apiFetch<{ cases: LegacyCaseLite[] }>("/legacy/cases"),
  });
  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<any[]>("/organizations"),
  });

  const legacy = legacyQuery.data?.cases ?? [];
  const labOrg = useMemo(
    () =>
      (orgsQuery.data ?? []).find((o: any) => o?.type === "lab") ?? null,
    [orgsQuery.data],
  );

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [caseSearch, setCaseSearch] = useState("");
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [rxDraft, setRxDraft] = useState<ExtractedRx>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const filteredCases = useMemo(() => {
    const q = caseSearch.trim().toLowerCase();
    if (!q) return legacy.slice(0, 8);
    return legacy
      .filter(
        (c) =>
          (c.caseNumber || "").toLowerCase().includes(q) ||
          (c.patientName || "").toLowerCase().includes(q) ||
          (c.doctorName || "").toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [legacy, caseSearch]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      setPhase((p) => (p.kind === "idle" ? { kind: "draggingFile" } : p));
    }
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) {
      setPhase((p) =>
        p.kind === "draggingFile" ? { kind: "idle" } : p,
      );
    }
  }, []);
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const runRxAnalyze = useCallback(
    async (file: File) => {
      setPhase({ kind: "analyzing", fileName: file.name });
      try {
        let images: string[] = [];
        if (isPdf(file)) {
          images = await pdfToJpegDataUrls(file, 3);
        } else if (isImage(file)) {
          images = [await fileToDataUrl(file)];
        }
        if (images.length === 0)
          throw new Error("Could not read this file.");
        const [primary, ...rest] = images;
        // /analyze-prescription returns either {success:true,data:{...}} (which
        // apiFetch auto-unwraps to the inner data object) OR
        // {success:false,error:"..."} which is NOT unwrapped (no `data` key).
        const resp = await apiFetch<
          ExtractedRx | { success: false; error?: string }
        >("/analyze-prescription", {
          method: "POST",
          body: JSON.stringify({
            imageBase64: primary,
            additionalImages: rest,
          }),
        });
        if (
          resp &&
          typeof resp === "object" &&
          (resp as any).success === false
        ) {
          throw new Error(
            (resp as any).error ||
              "AI could not parse this prescription.",
          );
        }
        const rx = resp as ExtractedRx;
        const caseNumber = nextYearCaseNumber(legacy);
        setRxDraft({
          doctorName: rx.doctorName ?? "",
          patientName: rx.patientName ?? "",
          patientInitials:
            rx.patientInitials ??
            (rx.patientName ? initialsFromName(rx.patientName) : ""),
          caseType: rx.caseType ?? "",
          toothIndices: rx.toothIndices ?? "",
          shade: rx.shade ?? "",
          material: rx.material ?? "",
          dueDate: rx.dueDate ?? "",
          isRush: !!rx.isRush,
          notes: rx.notes ?? "",
          practiceName: rx.practiceName ?? "",
        });
        setPhase({ kind: "rxConfirm", file, caseNumber });
      } catch (e: any) {
        setPhase({
          kind: "error",
          message: e?.message || "AI analysis failed.",
        });
        window.setTimeout(() => setPhase({ kind: "idle" }), 6000);
      }
    },
    [legacy],
  );

  const handleFiles = useCallback(
    (rawFiles: FileList | File[]) => {
      const files = Array.from(rawFiles);
      if (files.length === 0) return;
      setCaseSearch("");
      setSelectedCaseId(null);
      // Single Rx-readable file → auto-launch the AI flow (matches mobile).
      if (files.length === 1 && canReadAsRx(files[0])) {
        void runRxAnalyze(files[0]);
        return;
      }
      setPhase({ kind: "picking", files });
    },
    [runRxAnalyze],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      if (e.dataTransfer.files?.length > 0) {
        handleFiles(e.dataTransfer.files);
      } else {
        setPhase({ kind: "idle" });
      }
    },
    [handleFiles],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) handleFiles(files);
      e.target.value = "";
    },
    [handleFiles],
  );

  async function uploadFileGetUrl(file: File): Promise<string> {
    const fd = new FormData();
    fd.append("file", file);
    const resp = await apiFetch<{ url: string }>("/media/upload", {
      method: "POST",
      body: fd,
    });
    return resp.url;
  }

  async function appendPhotoToLegacyCase(caseId: string, photoUrl: string) {
    const fresh = await apiFetch<{ cases: LegacyCaseLite[] }>(
      "/legacy/cases",
    );
    const target = (fresh.cases ?? []).find((c) => c.id === caseId);
    if (!target) throw new Error("Could not find case.");
    const photos = Array.isArray(target.photos)
      ? [...target.photos, photoUrl]
      : [photoUrl];
    const updated = { ...target, photos, updatedAt: Date.now() };
    await apiFetch("/legacy/cases", {
      method: "POST",
      body: JSON.stringify({
        id: target.id,
        ownerId: target.ownerId || user?.id,
        caseData: JSON.stringify(updated),
      }),
    });
  }

  async function runAttachToCase(files: File[], caseId: string | null) {
    setPhase({ kind: "uploading", message: "Uploading…" });
    try {
      let count = 0;
      for (const file of files) {
        const url = await uploadFileGetUrl(file);
        if (caseId) {
          await appendPhotoToLegacyCase(caseId, url);
        }
        count++;
      }
      qc.invalidateQueries({ queryKey: ["legacy-cases-for-dropzone"] });
      qc.invalidateQueries({ queryKey: ["cases"] });
      setPhase({
        kind: "done",
        message: `${count} file${count === 1 ? "" : "s"} uploaded${caseId ? " and attached to case." : "."}`,
      });
      window.setTimeout(() => setPhase({ kind: "idle" }), 4000);
    } catch (e: any) {
      setPhase({
        kind: "error",
        message: e?.message || "Upload failed.",
      });
      window.setTimeout(() => setPhase({ kind: "idle" }), 5000);
    }
  }

  async function createCaseFromRx() {
    if (phase.kind !== "rxConfirm") return;
    const { file, caseNumber } = phase;
    const r = rxDraft;
    setPhase({ kind: "uploading", message: "Creating case…" });
    try {
      const ownerId = user?.id;
      if (!ownerId) throw new Error("You must be signed in.");
      const caseId = generateLocalId();
      const now = Date.now();
      const patientName =
        (r.patientName || "").trim() || "Unknown Patient";
      const affiliationKey = labOrg?.id
        ? `org:${labOrg.id}`
        : `user:${ownerId}`;
      const affiliationName = labOrg?.id
        ? labOrg.displayName || labOrg.name || null
        : null;

      // Upload original Rx file so it can live alongside the case.
      let photoUrl: string | null = null;
      try {
        photoUrl = await uploadFileGetUrl(file);
      } catch {
        photoUrl = null;
      }

      const caseData = {
        id: caseId,
        caseNumber,
        ownerId,
        doctorName: (r.doctorName || "").trim() || "Unknown Provider",
        patientName,
        patientInitials:
          (r.patientInitials || initialsFromName(patientName) || "").trim(),
        caseType: r.caseType || "",
        toothIndices: r.toothIndices || "",
        shade: r.shade || "",
        material: r.material || "",
        status: "INTAKE",
        isRush: !!r.isRush,
        notes: [
          r.practiceName ? `[${r.practiceName}]` : "",
          r.notes || "",
          "[AI Imported]",
        ]
          .filter(Boolean)
          .join(" "),
        price: 0,
        dueDate: r.dueDate || "",
        photos: photoUrl ? [photoUrl] : [],
        videos: [],
        activityLog: [
          {
            id: generateLocalId(),
            type: "created",
            timestamp: now,
            description: "Case created from AI-read prescription",
            station: "INTAKE",
          },
        ],
        affiliationKey,
        affiliationName,
        createdAt: now,
        updatedAt: now,
        routeHistory: [{ station: "INTAKE", timestamp: now }],
      };

      await apiFetch("/legacy/cases", {
        method: "POST",
        body: JSON.stringify({
          id: caseId,
          ownerId,
          caseData: JSON.stringify(caseData),
        }),
      });

      // Best-effort invoice generation (mirrors mobile). Ignored if the new
      // /cases table doesn't yet have a row for this id.
      try {
        await apiFetch(`/invoices/cases/${caseId}/generate-invoice`, {
          method: "POST",
        });
      } catch {
        /* non-fatal */
      }

      qc.invalidateQueries({ queryKey: ["legacy-cases-for-dropzone"] });
      qc.invalidateQueries({ queryKey: ["cases"] });
      setPhase({
        kind: "done",
        message: `Case ${caseNumber} created · INV-${caseNumber}.`,
      });
      window.setTimeout(() => setPhase({ kind: "idle" }), 5000);
    } catch (e: any) {
      setPhase({
        kind: "error",
        message: e?.message || "Could not create case.",
      });
      window.setTimeout(() => setPhase({ kind: "idle" }), 5000);
    }
  }

  // ── RxConfirm view ──
  if (phase.kind === "rxConfirm") {
    const r = rxDraft;
    return (
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-primary" />
            <p className="text-sm font-medium">AI read this prescription</p>
          </div>
          <button
            type="button"
            onClick={() => setPhase({ kind: "idle" })}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Cancel"
          >
            <X size={15} />
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Review or edit, then create case{" "}
          <span className="font-mono text-foreground">{phase.caseNumber}</span>
          .
        </p>
        <div className="grid grid-cols-2 gap-2">
          <input
            className={inputCls}
            placeholder="Doctor"
            value={r.doctorName || ""}
            onChange={(e) =>
              setRxDraft({ ...r, doctorName: e.target.value })
            }
          />
          <input
            className={inputCls}
            placeholder="Patient"
            value={r.patientName || ""}
            onChange={(e) =>
              setRxDraft({ ...r, patientName: e.target.value })
            }
          />
          <input
            className={inputCls}
            placeholder="Teeth (e.g. 3,5,14)"
            value={r.toothIndices || ""}
            onChange={(e) =>
              setRxDraft({ ...r, toothIndices: e.target.value })
            }
          />
          <input
            className={inputCls}
            placeholder="Material"
            value={r.material || ""}
            onChange={(e) =>
              setRxDraft({ ...r, material: e.target.value })
            }
          />
          <input
            className={inputCls}
            placeholder="Shade"
            value={r.shade || ""}
            onChange={(e) => setRxDraft({ ...r, shade: e.target.value })}
          />
          <input
            className={inputCls}
            placeholder="Due date"
            value={r.dueDate || ""}
            onChange={(e) =>
              setRxDraft({ ...r, dueDate: e.target.value })
            }
          />
          <textarea
            className={inputCls + " col-span-2 h-16 resize-none py-1.5"}
            placeholder="Notes"
            value={r.notes || ""}
            onChange={(e) => setRxDraft({ ...r, notes: e.target.value })}
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={!!r.isRush}
            onChange={(e) =>
              setRxDraft({ ...r, isRush: e.target.checked })
            }
          />
          Mark as rush
        </label>
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={() => setPhase({ kind: "idle" })}
            className="h-8 px-3 rounded-md bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() =>
              setPhase({ kind: "picking", files: [phase.file] })
            }
            className="h-8 px-3 rounded-md bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            title="Skip AI and upload this file (optionally attach to an existing case)"
          >
            Upload only
          </button>
          <button
            type="button"
            onClick={createCaseFromRx}
            className="flex-1 min-w-0 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
          >
            Create case {phase.caseNumber}
          </button>
        </div>
      </div>
    );
  }

  // ── Picking view (multi-file or non-Rx files) ──
  if (phase.kind === "picking") {
    const files = phase.files;
    const single = files.length === 1;
    return (
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">
            {files.length} file{files.length === 1 ? "" : "s"} ready
          </p>
          <button
            type="button"
            onClick={() => {
              setPhase({ kind: "idle" });
              setSelectedCaseId(null);
              setCaseSearch("");
            }}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Cancel"
          >
            <X size={15} />
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Attach to a case (optional) — or upload without linking.
        </p>
        <input
          autoFocus
          type="search"
          placeholder="Search case # or patient…"
          value={caseSearch}
          onChange={(e) => {
            setCaseSearch(e.target.value);
            setSelectedCaseId(null);
          }}
          className="w-full h-8 px-3 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
        />
        {filteredCases.length > 0 && (
          <ul className="border border-border rounded-md divide-y divide-border max-h-40 overflow-y-auto">
            {filteredCases.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedCaseId((prev) =>
                      prev === c.id ? null : c.id,
                    )
                  }
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-secondary/50 transition-colors flex items-center gap-2 ${
                    selectedCaseId === c.id ? "bg-primary/10" : ""
                  }`}
                >
                  {selectedCaseId === c.id && (
                    <CheckCircle2
                      size={13}
                      className="text-primary shrink-0"
                    />
                  )}
                  <span className="font-mono text-xs text-muted-foreground">
                    {c.caseNumber}
                  </span>
                  <span className="truncate">{c.patientName}</span>
                  <span className="text-muted-foreground ml-auto text-xs truncate">
                    {c.doctorName}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {selectedCaseId && (
          <p className="text-xs text-primary font-medium">
            Files will be attached to case{" "}
            {legacy.find((c) => c.id === selectedCaseId)?.caseNumber}.
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={() => runAttachToCase(files, null)}
            className="flex-1 min-w-0 h-8 rounded-md bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Upload only
          </button>
          {single && canReadAsRx(files[0]) && (
            <button
              type="button"
              onClick={() => runRxAnalyze(files[0])}
              className="flex-1 min-w-0 h-8 rounded-md bg-primary/15 text-primary text-xs font-medium hover:bg-primary/25 transition-colors inline-flex items-center justify-center gap-1.5"
            >
              <Sparkles size={12} /> Read as Rx
            </button>
          )}
          <button
            type="button"
            onClick={() => runAttachToCase(files, selectedCaseId)}
            className="flex-1 min-w-0 h-8 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
          >
            {selectedCaseId ? "Upload & attach" : "Upload"}
          </button>
        </div>
      </div>
    );
  }

  // ── Idle / drag / progress views ──
  const isIdle = phase.kind === "idle";
  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={isIdle ? () => fileRef.current?.click() : undefined}
      className={`relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed select-none transition-all min-h-[140px] px-6 py-8 ${
        phase.kind === "draggingFile"
          ? "border-primary bg-primary/8 scale-[1.01] cursor-copy"
          : phase.kind === "done"
            ? "border-success bg-success/5 cursor-default"
            : phase.kind === "error"
              ? "border-destructive bg-destructive/5 cursor-default"
              : phase.kind === "uploading" || phase.kind === "analyzing"
                ? "border-border bg-card cursor-wait"
                : "border-border bg-card hover:border-primary/50 hover:bg-secondary/40 cursor-pointer"
      }`}
    >
      <input
        ref={fileRef}
        type="file"
        multiple
        className="sr-only"
        onChange={handleFileInput}
        aria-label="Upload files"
      />

      {phase.kind === "analyzing" && (
        <>
          <Loader2 size={28} className="animate-spin text-primary" />
          <p className="text-sm font-medium text-primary">
            Reading prescription…
          </p>
          <p className="text-xs text-muted-foreground truncate max-w-full">
            {phase.fileName}
          </p>
        </>
      )}

      {phase.kind === "uploading" && (
        <>
          <div className="h-10 w-10 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          <p className="text-sm text-muted-foreground">
            {phase.message || "Working…"}
          </p>
        </>
      )}

      {phase.kind === "done" && (
        <>
          <div className="h-10 w-10 rounded-full bg-success/15 flex items-center justify-center">
            <CheckCircle2 size={18} className="text-success" />
          </div>
          <p className="text-sm font-medium text-success text-center">
            {phase.message}
          </p>
        </>
      )}

      {phase.kind === "error" && (
        <>
          <div className="h-10 w-10 rounded-full bg-destructive/15 flex items-center justify-center">
            <AlertTriangle size={18} className="text-destructive" />
          </div>
          <p className="text-sm text-destructive text-center">
            {phase.message}
          </p>
        </>
      )}

      {phase.kind === "draggingFile" && (
        <>
          <div className="h-10 w-10 rounded-full bg-primary/15 flex items-center justify-center">
            <Sparkles size={18} className="text-primary" />
          </div>
          <p className="text-sm font-medium text-primary">
            Drop to read with AI
          </p>
        </>
      )}

      {isIdle && (
        <>
          <div className="h-10 w-10 rounded-full bg-secondary flex items-center justify-center">
            <Upload size={18} className="text-muted-foreground" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium">
              Drop a prescription or file here
            </p>
            <p className="text-xs text-muted-foreground mt-0.5 inline-flex items-center gap-1">
              <Sparkles size={11} className="text-primary" />
              AI auto-creates a case from any Rx PDF or photo
            </p>
          </div>
          <p className="text-xs text-primary font-medium">
            or click to browse
          </p>
        </>
      )}
    </div>
  );
}
