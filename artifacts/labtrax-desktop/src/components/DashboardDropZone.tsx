import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
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
  practiceAddress?: string | null;
  practicePhone?: string | null;
}

interface NewPracticeDraft {
  name: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zip: string;
  doctorName: string;
}

// Best-effort split of a free-text address into line1 / city / state / zip.
// Accepts patterns like "123 Main St, Springfield, IL 62701" or
// "123 Main St\nSpringfield, IL 62701". Anything we can't parse just lands
// in addressLine1 so the user can clean it up before saving.
function parseAddress(raw: string | null | undefined): {
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
} {
  const empty = { addressLine1: "", city: "", state: "", zip: "" };
  const s = (raw || "").trim();
  if (!s) return empty;
  const parts = s
    .split(/\n|,/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { ...empty, addressLine1: s };
  const last = parts[parts.length - 1];
  const stateZip = last.match(/^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (stateZip && parts.length >= 2) {
    // "Street, City, ST ZIP" → line1=Street, city=City
    // "City, ST ZIP"          → line1="",     city=City  (don't duplicate)
    return {
      addressLine1: parts.length >= 3 ? parts.slice(0, -2).join(", ") : "",
      city: parts.length >= 3 ? parts[parts.length - 2] : parts[0],
      state: stateZip[1].toUpperCase(),
      zip: stateZip[2],
    };
  }
  const zipOnly = last.match(/^(\d{5}(?:-\d{4})?)$/);
  if (zipOnly && parts.length >= 2) {
    return {
      addressLine1: parts.slice(0, -1).join(", "),
      city: "",
      state: "",
      zip: zipOnly[1],
    };
  }
  return { ...empty, addressLine1: s };
}

interface OrgLite {
  id: string;
  name?: string;
  displayName?: string | null;
  type?: string;
}

function splitPatientName(full: string | null | undefined): {
  first: string;
  last: string;
} {
  const trimmed = (full || "").trim();
  if (!trimmed) return { first: "Unknown", last: "Patient" };
  // "Last, First" → swap
  if (trimmed.includes(",")) {
    const [last, first] = trimmed.split(",").map((s) => s.trim());
    return {
      first: first || "Unknown",
      last: last || "Patient",
    };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return {
    first: parts.slice(0, -1).join(" "),
    last: parts[parts.length - 1],
  };
}

interface DuplicateHit {
  id: string;
  caseNumber: string;
  matchKind: string;
  source: "canonical" | "legacy";
  patientFirstName: string;
  patientLastName: string;
  status?: string;
  createdAt?: string | null;
  toothNumbers?: string;
  restorationTypes?: string;
}

type Phase =
  | { kind: "idle" }
  | { kind: "draggingFile" }
  | { kind: "picking"; files: File[] }
  | { kind: "analyzing"; fileName: string }
  | { kind: "rxConfirm"; file: File; caseNumber: string }
  | {
      kind: "duplicatePrompt";
      file: File;
      caseNumber: string;
      matches: DuplicateHit[];
      patientName: string;
    }
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

function initialsFromName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w[0] || "").toUpperCase() + ".")
    .join("");
}

const inputCls =
  "h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary";

interface DuplicatePromptPhase {
  kind: "duplicatePrompt";
  file: File;
  caseNumber: string;
  matches: DuplicateHit[];
  patientName: string;
}

function DuplicatePromptPanel({
  phase,
  onBack,
  onCancel,
  onCreateAsNew,
  onCreateAsRemake,
}: {
  phase: DuplicatePromptPhase;
  onBack: () => void;
  onCancel: () => void;
  onCreateAsNew: () => void;
  onCreateAsRemake: (remake: {
    remakeOfCaseId: string;
    remakeReason: string;
    remakeCharged: boolean;
  }) => void;
}) {
  const { matches, patientName } = phase;
  const [selectedId, setSelectedId] = useState<string>(
    matches.find((m) => m.source === "canonical")?.id ?? matches[0]?.id ?? "",
  );
  const [reason, setReason] = useState("");
  const [charge, setCharge] = useState<"yes" | "no" | "">("");
  const [err, setErr] = useState<string | null>(null);

  // Legacy/mobile cases can't be linked as a remake (the modern
  // remakeOfCaseId column references the canonical cases table).
  const selectedMatch = matches.find((m) => m.id === selectedId);
  const canLinkSelection = selectedMatch?.source === "canonical";

  function submitRemake() {
    if (!selectedId) {
      setErr("Pick the prior case being remade.");
      return;
    }
    if (!canLinkSelection) {
      setErr(
        "That case was created on the mobile app and can't be linked here. Pick a website-created case, or use 'Create as new case anyway'.",
      );
      return;
    }
    if (!reason.trim()) {
      setErr("Reason is required to link as a remake.");
      return;
    }
    if (charge === "") {
      setErr("Choose whether to charge for this remake.");
      return;
    }
    onCreateAsRemake({
      remakeOfCaseId: selectedId,
      remakeReason: reason.trim(),
      remakeCharged: charge === "yes",
    });
  }

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <AlertTriangle size={15} className="text-amber-600" />
          <p className="text-sm font-medium text-amber-900">
            Possible duplicate / remake?
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="text-amber-700 hover:text-amber-900"
          aria-label="Back to review"
        >
          <X size={15} />
        </button>
      </div>
      <p className="text-xs text-amber-900">
        Found {matches.length} prior case{matches.length === 1 ? "" : "s"} for{" "}
        <span className="font-semibold">{patientName}</span> in this lab. If this
        is a remake of one of them, link it below so you can flag whether to
        charge.
      </p>

      <div className="max-h-48 overflow-y-auto rounded-md border border-amber-200 bg-white divide-y divide-amber-100">
        {matches.map((m) => {
          const isSelected = selectedId === m.id;
          const isLegacy = m.source === "legacy";
          return (
            <label
              key={`${m.source}:${m.id}`}
              className={`px-3 py-2 text-xs flex items-center gap-2 cursor-pointer ${
                isSelected ? "bg-amber-100" : "hover:bg-amber-50"
              }`}
            >
              <input
                type="radio"
                name="dropzone-dup"
                checked={isSelected}
                onChange={() => {
                  setSelectedId(m.id);
                  setErr(null);
                }}
              />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-foreground truncate">
                  {m.caseNumber || "—"} · {m.patientFirstName}{" "}
                  {m.patientLastName}
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {[
                    m.status,
                    m.toothNumbers ? `teeth ${m.toothNumbers}` : null,
                    m.restorationTypes,
                    m.createdAt
                      ? new Date(m.createdAt).toLocaleDateString()
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              {isLegacy && (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  mobile
                </span>
              )}
              <span className="shrink-0 inline-flex items-center rounded-full bg-amber-100 text-amber-800 border border-amber-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                {m.matchKind}
              </span>
            </label>
          );
        })}
      </div>

      <div>
        <label className="block text-[11px] font-medium text-amber-900 mb-1">
          Remake reason (required to link)
        </label>
        <textarea
          rows={2}
          className="w-full px-2 py-1.5 rounded bg-white text-xs border border-amber-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setErr(null);
          }}
          placeholder="e.g. Shade B1 came back too dark; doctor requested A2"
        />
      </div>

      <div>
        <label className="block text-[11px] font-medium text-amber-900 mb-1">
          Charge for this remake?
        </label>
        <div className="flex gap-2">
          {(
            [
              { v: "yes" as const, label: "Yes — invoice as usual" },
              { v: "no" as const, label: "No — no-charge remake" },
            ]
          ).map((opt) => (
            <button
              key={opt.v}
              type="button"
              onClick={() => {
                setCharge(opt.v);
                setErr(null);
              }}
              className={`flex-1 h-8 rounded text-xs font-medium transition-colors ${
                charge === opt.v
                  ? opt.v === "no"
                    ? "bg-amber-200 text-amber-900 border border-amber-400"
                    : "bg-primary/10 text-primary border border-primary/30"
                  : "bg-white text-muted-foreground border border-amber-200 hover:bg-amber-50"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <p className="text-xs text-destructive bg-destructive/10 px-2 py-1.5 rounded">
          {err}
        </p>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          onClick={onBack}
          className="h-8 px-3 rounded-md bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          Back to review
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-8 px-3 rounded-md bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onCreateAsNew}
          className="h-8 px-3 rounded-md bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          title="Create a brand-new case unrelated to any of the matches above"
        >
          Not a remake — create new
        </button>
        <button
          type="button"
          onClick={submitRemake}
          className="flex-1 min-w-0 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
        >
          Link as remake
        </button>
      </div>
    </div>
  );
}

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
    queryFn: () => apiFetch<OrgLite[]>("/organizations"),
  });

  const legacy = legacyQuery.data?.cases ?? [];
  const labOrgs = useMemo(
    () => (orgsQuery.data ?? []).filter((o) => o?.type === "lab"),
    [orgsQuery.data],
  );
  const providerOrgs = useMemo(
    () => (orgsQuery.data ?? []).filter((o) => o?.type !== "lab"),
    [orgsQuery.data],
  );
  const labOrg = labOrgs[0] ?? null;

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [caseSearch, setCaseSearch] = useState("");
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [rxDraft, setRxDraft] = useState<ExtractedRx>({});
  // Selected lab + practice when creating a modern /api/cases case from
  // an AI-read Rx. Lab defaults to the only lab the user belongs to.
  const [rxLabOrgId, setRxLabOrgId] = useState<string>("");
  const [rxProviderOrgId, setRxProviderOrgId] = useState<string>("");

  // Auto-pick the lab as soon as the membership list loads. This
  // matters for single-lab users (the lab <select> is hidden in that
  // case) — without this effect, dragging a file before the orgs query
  // resolves would leave `rxLabOrgId` empty and the user would be
  // stuck on the "Pick a lab" error with no UI to fix it.
  useEffect(() => {
    if (!rxLabOrgId && labOrg?.id) {
      setRxLabOrgId(labOrg.id);
    }
  }, [labOrg?.id, rxLabOrgId]);
  const [rxProviderSearch, setRxProviderSearch] = useState("");
  // When set, the inline "Add practice" form is shown inside the rxConfirm
  // panel instead of the practice <select>. Pre-filled from the AI-extracted
  // Rx fields (name/phone/address) the first time it opens.
  const [newPracticeDraft, setNewPracticeDraft] =
    useState<NewPracticeDraft | null>(null);
  const [creatingPractice, setCreatingPractice] = useState(false);
  const [newPracticeError, setNewPracticeError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  function openAddPracticeForm() {
    const r = rxDraft;
    const parsed = parseAddress(r.practiceAddress);
    setNewPracticeError(null);
    setNewPracticeDraft({
      name: (r.practiceName || rxProviderSearch || "").trim(),
      phone: (r.practicePhone || "").trim(),
      addressLine1: parsed.addressLine1,
      addressLine2: "",
      city: parsed.city,
      state: parsed.state,
      zip: parsed.zip,
      doctorName: (r.doctorName || "").trim(),
    });
  }

  async function submitNewPractice() {
    if (!newPracticeDraft) return;
    const draft = newPracticeDraft;
    if (!draft.name.trim()) {
      setNewPracticeError("Practice name is required.");
      return;
    }
    if (!rxLabOrgId) {
      setNewPracticeError("Pick a lab first.");
      return;
    }
    setCreatingPractice(true);
    setNewPracticeError(null);
    try {
      const created = await apiFetch<{ id: string; name?: string }>(
        "/organizations",
        {
          method: "POST",
          body: JSON.stringify({
            type: "provider",
            name: draft.name.trim(),
            displayName: draft.name.trim(),
            parentLabOrganizationId: rxLabOrgId,
            ...(draft.phone.trim() ? { phone: draft.phone.trim() } : {}),
            ...(draft.addressLine1.trim()
              ? { addressLine1: draft.addressLine1.trim() }
              : {}),
            ...(draft.addressLine2.trim()
              ? { addressLine2: draft.addressLine2.trim() }
              : {}),
            ...(draft.city.trim() ? { city: draft.city.trim() } : {}),
            ...(draft.state.trim() ? { state: draft.state.trim() } : {}),
            ...(draft.zip.trim() ? { zip: draft.zip.trim() } : {}),
            ...(draft.doctorName.trim()
              ? { doctorName: draft.doctorName.trim() }
              : {}),
          }),
        },
      );
      // Refresh the orgs list so the new practice shows up in the dropdown,
      // then auto-select it and close the inline form.
      await qc.invalidateQueries({ queryKey: ["organizations"] });
      if (created?.id) setRxProviderOrgId(created.id);
      setRxProviderSearch("");
      setNewPracticeDraft(null);
    } catch (e: any) {
      setNewPracticeError(
        e?.message || "Could not create practice. Please try again.",
      );
    } finally {
      setCreatingPractice(false);
    }
  }

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
          practiceAddress: rx.practiceAddress ?? "",
          practicePhone: rx.practicePhone ?? "",
        });
        // Pre-select lab + try to match a practice from the AI-detected
        // practiceName so the user can confirm in one click in the common
        // case where the practice already exists.
        if (!rxLabOrgId && labOrg?.id) setRxLabOrgId(labOrg.id);
        if (!rxProviderOrgId && rx.practiceName) {
          const needle = rx.practiceName.trim().toLowerCase();
          const match = providerOrgs.find((p) =>
            (p.displayName || p.name || "").toLowerCase().includes(needle),
          );
          if (match) setRxProviderOrgId(match.id);
          else setRxProviderSearch(rx.practiceName);
        }
        setPhase({ kind: "rxConfirm", file, caseNumber });
      } catch (e: any) {
        setPhase({
          kind: "error",
          message: e?.message || "AI analysis failed.",
        });
        window.setTimeout(() => setPhase({ kind: "idle" }), 6000);
      }
    },
    [
      legacy,
      labOrg?.id,
      providerOrgs,
      rxLabOrgId,
      rxProviderOrgId,
    ],
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

  async function fetchPatientSimilarity(
    first: string,
    last: string,
  ): Promise<DuplicateHit[]> {
    if (!first || !last || !rxLabOrgId) return [];
    const qs = new URLSearchParams({
      patientFirstName: first,
      patientLastName: last,
      labOrganizationId: rxLabOrgId,
    });
    if (rxProviderOrgId) qs.set("providerOrganizationId", rxProviderOrgId);
    const doctor = (rxDraft.doctorName || "").trim();
    if (doctor) qs.set("doctorName", doctor);
    try {
      const body = await apiFetch<{ matches?: DuplicateHit[] } | DuplicateHit[]>(
        `/cases/patient-similarity?${qs.toString()}`,
      );
      const matches = Array.isArray(body)
        ? body
        : (body?.matches ?? []);
      return Array.isArray(matches) ? matches : [];
    } catch {
      return [];
    }
  }

  async function createCaseFromRx() {
    if (phase.kind !== "rxConfirm") return;
    const r = rxDraft;
    if (!user?.id) {
      setPhase({ kind: "error", message: "You must be signed in." });
      return;
    }
    if (!rxLabOrgId) {
      setPhase({ kind: "error", message: "Pick a lab to create the case in." });
      return;
    }
    if (!rxProviderOrgId) {
      setPhase({
        kind: "error",
        message: "Pick a practice (provider) for this case.",
      });
      return;
    }

    // Duplicate-patient check (mirrors mobile scan flow). If the same
    // patient already has a case under this provider/doctor in this lab,
    // pause and let the user confirm before creating a second one.
    const { first: pf, last: pl } = splitPatientName(r.patientName);
    const cleanFirst = (pf || "").trim();
    const cleanLast = (pl || "").trim();
    if (cleanFirst && cleanLast) {
      setPhase({ kind: "uploading", message: "Checking for duplicates…" });
      const matches = await fetchPatientSimilarity(cleanFirst, cleanLast);
      if (matches.length > 0) {
        setPhase({
          kind: "duplicatePrompt",
          file: phase.file,
          caseNumber: phase.caseNumber,
          matches,
          patientName: r.patientName?.trim() || `${cleanFirst} ${cleanLast}`,
        });
        return;
      }
    }

    await proceedCreateCase(phase.file, phase.caseNumber);
  }

  async function proceedCreateCase(
    file: File,
    requestedCaseNumber: string,
    remake?: {
      remakeOfCaseId: string;
      remakeReason: string;
      remakeCharged: boolean;
    },
  ) {
    const r = rxDraft;
    if (!user?.id || !rxLabOrgId || !rxProviderOrgId) return;
    setPhase({ kind: "uploading", message: "Creating case…" });
    try {
      // 1. Reserve a fresh case number from the modern endpoint so we
      //    don't collide with cases created elsewhere on the same lab.
      let caseNumber = requestedCaseNumber;
      try {
        const next = await apiFetch<{ caseNumber: string }>(
          `/cases/next-case-number?labOrganizationId=${encodeURIComponent(
            rxLabOrgId,
          )}`,
        );
        if (next?.caseNumber) caseNumber = next.caseNumber;
      } catch {
        /* fall back to client-computed number */
      }

      // 2. Split AI-detected patient name into first/last (the modern
      //    schema requires both).
      const { first, last } = splitPatientName(r.patientName);

      // 3. Build a `restorations[]` array from the AI-extracted Rx so
      //    the server can (a) insert one row per tooth into
      //    case_restorations, (b) auto-look-up unit prices via the
      //    lab's pricing tier / per-doctor overrides, and (c) auto-
      //    generate invoice line items from those restorations. Without
      //    this, the auto-generated invoice has zero line items and a
      //    $0 subtotal even though the AI saw the teeth + material.
      //
      //    Mapping:
      //      • toothNumber  — each tooth in r.toothIndices (split on
      //                       commas / whitespace, trimmed)
      //      • restorationType — r.caseType from the AI ("Crown &
      //                       Bridge", "Removable", "Implant", etc.).
      //                       Defaults to "Other" when the AI didn't
      //                       extract a case type.
      //      • material/shade — straight from the AI extraction
      //      • quantity     — 1 per tooth (matches the iTero importer
      //                       convention in cases.ts)
      //      • unitPrice    — 0 so the server price-lookup runs
      const teethList = (r.toothIndices || "")
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      const restorations =
        teethList.length > 0
          ? teethList.map((toothNumber) => ({
              toothNumber,
              restorationType: (r.caseType || "Other").trim() || "Other",
              ...(r.material ? { material: r.material } : {}),
              ...(r.shade ? { shade: r.shade } : {}),
              quantity: 1,
              unitPrice: 0,
            }))
          : undefined;

      // 4. Create the case via the modern /api/cases endpoint.
      const created = await apiFetch<{ id: string; caseNumber: string }>(
        "/cases",
        {
          method: "POST",
          body: JSON.stringify({
            caseNumber,
            labOrganizationId: rxLabOrgId,
            providerOrganizationId: rxProviderOrgId,
            patientFirstName: first || "Unknown",
            patientLastName: last || "Patient",
            doctorName:
              (r.doctorName || "").trim() || "Unknown Provider",
            priority: r.isRush ? "rush" : "normal",
            ...(r.dueDate ? { dueDate: r.dueDate } : {}),
            ...(restorations ? { restorations } : {}),
            ...(r.notes && r.notes.trim() ? { notes: r.notes.trim() } : {}),
            ...(remake ?? {}),
          }),
        },
      );

      // 5. Upload the Rx file and attach it as a case_attachment so
      //    it shows up in the Files tab and writes a case_event.
      let rxAttached = false;
      try {
        const fd = new FormData();
        fd.append("file", file);
        const upload = await apiFetch<{
          url: string;
          filename: string;
          size: number;
        }>("/media/upload", {
          method: "POST",
          body: fd,
          // Let the browser set the multipart boundary.
          headers: {},
        });
        if (upload?.url) {
          await apiFetch(`/cases/${created.id}/attachments`, {
            method: "POST",
            body: JSON.stringify({
              storageKey: upload.url,
              fileName: file.name || upload.filename || "Rx.pdf",
              fileType: file.type || "application/pdf",
              visibility: "shared_with_provider",
            }),
          });
          rxAttached = true;
        }
      } catch (e: any) {
        console.warn("Rx attachment upload failed:", e);
      }

      // 6. Invoice auto-generation is handled server-side inside
      //    POST /api/cases (creates a draft invoice + invoice_generated
      //    case event). No client-side call needed — issuing a second
      //    /generate-invoice request would create duplicate History
      //    entries.

      qc.invalidateQueries({ queryKey: ["legacy-cases-for-dropzone"] });
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setPhase({
        kind: "done",
        message: rxAttached
          ? `Case ${created.caseNumber} created · Rx attached · draft invoice ready.`
          : `Case ${created.caseNumber} created · draft invoice ready. (Rx file could not be attached — please add it manually in the Files tab.)`,
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

  // ── Duplicate-patient prompt ──
  if (phase.kind === "duplicatePrompt") {
    return (
      <DuplicatePromptPanel
        phase={phase}
        onBack={() =>
          setPhase({ kind: "rxConfirm", file: phase.file, caseNumber: phase.caseNumber })
        }
        onCancel={() => setPhase({ kind: "idle" })}
        onCreateAsNew={() => proceedCreateCase(phase.file, phase.caseNumber)}
        onCreateAsRemake={(remake) =>
          proceedCreateCase(phase.file, phase.caseNumber, remake)
        }
      />
    );
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
          Review or edit, then create the case. The Rx will be attached and a
          draft invoice will be generated automatically.
        </p>
        {labOrgs.length > 1 && (
          <label className="block text-xs text-muted-foreground space-y-1">
            <span>Lab</span>
            <select
              className={inputCls + " w-full"}
              value={rxLabOrgId}
              onChange={(e) => setRxLabOrgId(e.target.value)}
            >
              <option value="">Select a lab…</option>
              {labOrgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.displayName || o.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {!newPracticeDraft && (
          <label className="block text-xs text-muted-foreground space-y-1">
            <span>
              Practice (provider)
              {r.practiceName && !rxProviderOrgId ? (
                <span className="ml-1 text-amber-500">
                  · AI saw "{r.practiceName}" — pick the matching practice or
                  add it
                </span>
              ) : null}
            </span>
            <div className="flex items-stretch gap-2">
              <select
                className={inputCls + " flex-1 min-w-0"}
                value={rxProviderOrgId}
                onChange={(e) => {
                  if (e.target.value === "__add_new__") {
                    openAddPracticeForm();
                    return;
                  }
                  setRxProviderOrgId(e.target.value);
                }}
              >
                <option value="">Select a practice…</option>
                <option value="__add_new__">
                  + Add new practice
                  {r.practiceName ? ` ("${r.practiceName}")` : "…"}
                </option>
                {providerOrgs
                  .slice()
                  .sort((a, b) =>
                    (a.displayName || a.name || "").localeCompare(
                      b.displayName || b.name || "",
                    ),
                  )
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.displayName || o.name}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                onClick={openAddPracticeForm}
                className="shrink-0 h-8 px-2.5 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 transition-colors inline-flex items-center gap-1"
                title={
                  r.practiceName
                    ? `Add "${r.practiceName}" as a new practice`
                    : "Add a new practice"
                }
              >
                + Add practice
              </button>
            </div>
            {rxProviderSearch && !rxProviderOrgId && (
              <span className="block text-[10px] text-muted-foreground">
                No exact match for "{rxProviderSearch}". Pick the closest
                practice or tap "+ Add practice" to create it.
              </span>
            )}
          </label>
        )}
        {newPracticeDraft && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-primary">
                New practice — confirm details
              </p>
              <button
                type="button"
                onClick={() => {
                  setNewPracticeDraft(null);
                  setNewPracticeError(null);
                }}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Cancel adding practice"
                disabled={creatingPractice}
              >
                <X size={13} />
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Pre-filled from the prescription. Edit anything that looks off,
              then save to add this practice and use it for the case.
            </p>
            <input
              className={inputCls + " w-full"}
              placeholder="Practice name *"
              value={newPracticeDraft.name}
              onChange={(e) =>
                setNewPracticeDraft({
                  ...newPracticeDraft,
                  name: e.target.value,
                })
              }
              disabled={creatingPractice}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                className={inputCls}
                placeholder="Phone"
                value={newPracticeDraft.phone}
                onChange={(e) =>
                  setNewPracticeDraft({
                    ...newPracticeDraft,
                    phone: e.target.value,
                  })
                }
                disabled={creatingPractice}
              />
              <input
                className={inputCls}
                placeholder="Primary doctor"
                value={newPracticeDraft.doctorName}
                onChange={(e) =>
                  setNewPracticeDraft({
                    ...newPracticeDraft,
                    doctorName: e.target.value,
                  })
                }
                disabled={creatingPractice}
              />
            </div>
            <input
              className={inputCls + " w-full"}
              placeholder="Address line 1"
              value={newPracticeDraft.addressLine1}
              onChange={(e) =>
                setNewPracticeDraft({
                  ...newPracticeDraft,
                  addressLine1: e.target.value,
                })
              }
              disabled={creatingPractice}
            />
            <input
              className={inputCls + " w-full"}
              placeholder="Address line 2 (optional)"
              value={newPracticeDraft.addressLine2}
              onChange={(e) =>
                setNewPracticeDraft({
                  ...newPracticeDraft,
                  addressLine2: e.target.value,
                })
              }
              disabled={creatingPractice}
            />
            <div className="grid grid-cols-3 gap-2">
              <input
                className={inputCls}
                placeholder="City"
                value={newPracticeDraft.city}
                onChange={(e) =>
                  setNewPracticeDraft({
                    ...newPracticeDraft,
                    city: e.target.value,
                  })
                }
                disabled={creatingPractice}
              />
              <input
                className={inputCls}
                placeholder="State"
                value={newPracticeDraft.state}
                onChange={(e) =>
                  setNewPracticeDraft({
                    ...newPracticeDraft,
                    state: e.target.value,
                  })
                }
                disabled={creatingPractice}
              />
              <input
                className={inputCls}
                placeholder="ZIP"
                value={newPracticeDraft.zip}
                onChange={(e) =>
                  setNewPracticeDraft({
                    ...newPracticeDraft,
                    zip: e.target.value,
                  })
                }
                disabled={creatingPractice}
              />
            </div>
            {newPracticeError && (
              <p className="text-[11px] text-destructive">
                {newPracticeError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setNewPracticeDraft(null);
                  setNewPracticeError(null);
                }}
                disabled={creatingPractice}
                className="h-7 px-2.5 rounded-md bg-secondary text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitNewPractice}
                disabled={creatingPractice || !newPracticeDraft.name.trim()}
                className="flex-1 h-7 px-2.5 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
              >
                {creatingPractice ? (
                  <>
                    <Loader2 size={11} className="animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save practice & use it"
                )}
              </button>
            </div>
          </div>
        )}
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
        <button
          type="button"
          onClick={() => {
            const url = URL.createObjectURL(phase.file);
            const w = window.open(url, "_blank", "noopener,noreferrer");
            // Revoke after a delay so the new tab has time to load it.
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
            if (!w) {
              window.alert(
                "Couldn't open a preview window — check your pop-up blocker.",
              );
            }
          }}
          className="w-full h-8 px-3 rounded-md border border-border bg-secondary/60 text-xs font-medium text-foreground hover:bg-secondary inline-flex items-center justify-center gap-1.5 transition-colors"
          title="Open the uploaded file in a new tab to audit the AI's reading"
        >
          <FileText size={13} />
          Preview document ({phase.file.name})
        </button>
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
