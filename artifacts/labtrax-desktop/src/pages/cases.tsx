import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useAiPanel } from "@/lib/ai-panel-context";
import { useColumnWidths } from "@/hooks/useColumnWidths";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Barcode,
  Box,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FileUp,
  Filter,
  GitBranch,
  ImageOff,
  Loader2,
  Lock,
  Paperclip,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  QrCode,
  ReceiptText,
  Search,
  ScrollText,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import QRCodeSVG from "react-qr-code";
import { apiFetch, getAccessToken, getApiOrigin } from "@/lib/api";
import { uploadMediaFile } from "@/lib/upload-media-file";
import { DoctorNamePicker } from "@/components/DoctorNamePicker";
import { setNavBlocker } from "@/lib/nav-guard";
import { AuthedImage, AuthedVideo, isSameApiOrigin } from "@/components/AuthedMedia";
import type {
  CaseAttachment,
  CaseEvent,
  CaseRestoration,
  Invoice,
  LabCase,
  Organization,
  PatientSimilarityHit,
  PricingHistoryEntry,
  PricingOverride,
  PricingTier,
  RestorationPriceSource,
} from "@/lib/types";
import { formatDate, formatDateTime, formatMoney, formatPhone, formatShortDate, relativeTime, statusLabel } from "@/lib/format";
import {
  printCaseCard,
  printCaseCardAdvanced,
  printCaseHistory,
  printCaseOverview,
  printInvoice,
  printTabContent,
} from "@/lib/print";
import QRCodeLib from "qrcode";
import { useAuth } from "@/lib/auth-context";
import { printInvoicePdf, type InvoicePdfOptions } from "@/lib/export";
import {
  ToothChart,
  parseToothField,
  parseBridgeConnectors,
  formatBridgeConnectors,
} from "@/components/ToothChart";
import {
  buildHighlightedToothValue,
  deriveRxSummary,
  formatRxTeethLabel,
  formatRxTeethWithShades,
} from "@/lib/rx-summary";
import { StatusBadge } from "@/components/StatusBadge";
import { InvoiceEditor } from "./invoices";
import {
  ToothActionDialog,
  type ToothActionPayload,
} from "@/components/ToothActionDialog";
import ScanViewerModal from "@/components/ScanViewerModal";
import ScanThumbnail from "@/components/ScanThumbnail";
import type { ScanFormat } from "@workspace/scan-viewer";
import { PrintLayoutEditor } from "@/components/PrintLayoutEditor";
import { CasePrintLayoutEditor } from "@/components/CasePrintLayoutEditor";
import { PrescriptionPreview } from "@/components/PrescriptionPreview";
import {
  type PrintLayoutConfig,
  isDefaultLayout,
  loadPrintLayoutConfig,
} from "@/lib/print-layout";
import {
  coerceCasePrintTemplate,
  type CasePrintTemplate,
} from "@/lib/case-print-template";

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  { value: "received", label: "Received" },
  { value: "in_design", label: "In Design" },
  { value: "scan", label: "Scan" },
  { value: "in_milling", label: "In Milling" },
  { value: "post_mill", label: "Post Mill" },
  { value: "sintering_furnace", label: "Sintering Furnace" },
  { value: "model_room", label: "Model Room" },
  { value: "in_porcelain", label: "Porcelain" },
  { value: "qc", label: "Quality Check" },
  { value: "complete", label: "Complete" },
  { value: "shipped", label: "Shipping" },
  { value: "on_hold", label: "On Hold" },
  { value: "delivered", label: "Delivered" },
  { value: "remake", label: "Remake" },
];

type SortKey =
  | "caseNumber"
  | "doctorName"
  | "status"
  | "dueDate"
  | "createdAt"
  | "totalPrice";

function generateCaseNumber(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  return `${yy}-1`;
}

interface NewCaseFormData {
  // Optional: server assigns the case number for remake cases.
  caseNumber?: string;
  labOrganizationId: string;
  providerOrganizationId: string;
  patientFirstName: string;
  patientLastName: string;
  doctorName: string;
  dueDate: string;
  priority: "normal" | "rush";
  casePanBarcode?: string;
}

interface ProviderPickerProps {
  value: string;
  onChange: (id: string, org: Organization | null) => void;
  providers: Organization[];
  disabled?: boolean;
}

function ProviderPicker({ value, onChange, providers, disabled }: ProviderPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = providers.find((o) => o.id === value) || null;

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter((o) =>
      (o.displayName || o.name || "").toLowerCase().includes(q),
    );
  }, [providers, search]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-left flex items-center justify-between gap-2 ${
          disabled ? "opacity-60 cursor-not-allowed" : ""
        }`}
      >
        <span className={selected ? "" : "text-muted-foreground"}>
          {selected ? selected.displayName || selected.name : "Select practice…"}
        </span>
        <ChevronDown size={14} className="text-muted-foreground shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-xl overflow-hidden">
          <>
            <div className="p-2 border-b border-border">
                <input
                  autoFocus
                  type="search"
                  placeholder="Search practices…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                />
              </div>
              <ul className="max-h-56 overflow-y-auto py-1">
                {filtered.length === 0 && (
                  <li className="px-3 py-2 text-xs text-muted-foreground">
                    No practices found.
                  </li>
                )}
                {filtered.map((o) => {
                  const isSel = o.id === value;
                  return (
                    <li key={o.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onChange(o.id, o);
                          setOpen(false);
                          setSearch("");
                        }}
                        className={`w-full text-left px-3 py-1.5 text-sm hover:bg-secondary/60 flex items-center gap-2 ${
                          isSel ? "bg-primary/10" : ""
                        }`}
                      >
                        {isSel && (
                          <Check size={13} className="text-primary shrink-0" />
                        )}
                        <span className="truncate">
                          {o.displayName || o.name}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
        </div>
      )}
    </div>
  );
}


interface RemakeDecision {
  remakeOfCaseId: string;
  remakeReason: string;
  remakeCharged: boolean | null;
}

interface RemakeCaseHit {
  id: string;
  caseNumber: string;
  patientFirstName: string;
  patientLastName: string;
  doctorName: string;
  status: string;
}

/**
 * Modal that lists previously-seen cases for the same patient name and asks
 * the user whether the new case is a remake. Shown only when the server's
 * `/cases/patient-similarity` endpoint returns at least one match.
 *
 * Three exits:
 *   - "Not a remake": create the case as a normal new case.
 *   - "It's a remake of …": picks a candidate, captures reason + charge
 *     decision, creates the case linked to the original.
 *   - "Cancel": close both modals; do not create.
 */
function PossibleDuplicateModal({
  matches,
  patientFirstName,
  patientLastName,
  onCancel,
  onProceedAsNew,
  onProceedAsRemake,
  isSubmitting,
}: {
  matches: PatientSimilarityHit[];
  patientFirstName: string;
  patientLastName: string;
  onCancel: () => void;
  onProceedAsNew: () => void;
  onProceedAsRemake: (decision: RemakeDecision) => void;
  isSubmitting: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string>(
    matches[0]?.id ?? "",
  );
  const [reason, setReason] = useState("");
  const [charge, setCharge] = useState<"yes" | "no" | "">("");
  const [err, setErr] = useState<string | null>(null);

  function submitRemake() {
    if (!selectedId) return setErr("Select the prior case being remade.");
    if (!reason.trim()) {
      return setErr("Reason for remake is required.");
    }
    if (charge === "") {
      return setErr("Choose whether to charge for this remake.");
    }
    onProceedAsRemake({
      remakeOfCaseId: selectedId,
      remakeReason: reason.trim(),
      remakeCharged: charge === "yes",
    });
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label="Possible duplicate"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-amber-500" />
            <h2 className="text-base font-semibold">
              Possible duplicate / remake?
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1 space-y-4">
          <p className="text-sm text-muted-foreground">
            We found {matches.length} prior case{matches.length === 1 ? "" : "s"}{" "}
            for a patient that looks like{" "}
            <span className="font-medium text-foreground">
              {patientFirstName} {patientLastName}
            </span>
            . Is this a remake of one of them?
          </p>

          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-secondary/50">
                <tr>
                  <th className="text-left px-3 py-2 w-8"></th>
                  <th className="text-left px-3 py-2">Case #</th>
                  <th className="text-left px-3 py-2">Patient</th>
                  <th className="text-left px-3 py-2">Created</th>
                  <th className="text-left px-3 py-2">Teeth</th>
                  <th className="text-left px-3 py-2">Type</th>
                  <th className="text-left px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((m) => (
                  <tr
                    key={`${m.source}:${m.id}`}
                    onClick={() => setSelectedId(m.id)}
                    className={`border-t border-border cursor-pointer hover:bg-secondary/40 ${
                      selectedId === m.id ? "bg-primary/10" : ""
                    }`}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="radio"
                        name="dup"
                        checked={selectedId === m.id}
                        onChange={() => setSelectedId(m.id)}
                      />
                    </td>
                    <td className="px-3 py-2 font-mono">{m.caseNumber}</td>
                    <td className="px-3 py-2">
                      {m.patientFirstName} {m.patientLastName}
                      {m.matchKind !== "exact" && (
                        <span className="ml-1 text-[10px] uppercase text-muted-foreground">
                          ({m.matchKind})
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {m.createdAt ? formatDate(m.createdAt) : "—"}
                    </td>
                    <td className="px-3 py-2">{m.toothNumbers || "—"}</td>
                    <td className="px-3 py-2">{m.restorationTypes || "—"}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={m.status as any} />
                      {m.source === "legacy" && (
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          mobile
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedId && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Remake reason
                </label>
                <textarea
                  rows={2}
                  className="w-full px-3 py-2 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Shade B1 came back too dark; doctor requested A2"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Charge for this remake?
                </label>
                <div className="flex gap-2">
                  {(
                    [
                      { v: "yes", label: "Yes — invoice as usual" },
                      { v: "no", label: "No — no-charge remake" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.v}
                      type="button"
                      onClick={() => setCharge(opt.v)}
                      className={`flex-1 h-9 rounded-md text-xs font-medium transition-colors ${
                        charge === opt.v
                          ? opt.v === "no"
                            ? "bg-amber-500/15 text-amber-700 border border-amber-500/40"
                            : "bg-primary/10 text-primary border border-primary/30"
                          : "bg-secondary text-muted-foreground border border-transparent hover:bg-secondary/80"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {err && (
            <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {err}
            </p>
          )}
        </div>

        <div className="flex gap-2 px-6 py-3 border-t border-border bg-secondary/20">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="h-9 px-3 rounded-md bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onProceedAsNew}
            disabled={isSubmitting}
            className="h-9 px-3 rounded-md bg-secondary text-xs font-medium hover:bg-secondary/80 disabled:opacity-60"
          >
            Not a remake — create new
          </button>
          <button
            type="button"
            onClick={submitRemake}
            disabled={isSubmitting || !selectedId}
            className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
          >
            {isSubmitting && <Loader2 size={11} className="animate-spin" />}
            Yes, link as remake
          </button>
        </div>
      </div>
    </div>
  );
}

export function NewCaseModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
  });

  const orgs = orgsQuery.data ?? [];
  const labOrgs = orgs.filter((o) => o.type === "lab");
  const providerOrgs = orgs.filter((o) => o.type !== "lab");

  const [form, setForm] = useState<NewCaseFormData>({
    caseNumber: generateCaseNumber(),
    labOrganizationId: "",
    providerOrganizationId: "",
    patientFirstName: "",
    patientLastName: "",
    doctorName: "",
    dueDate: "",
    priority: "normal",
  });
  const [error, setError] = useState<string | null>(null);
  const [duplicateMatches, setDuplicateMatches] = useState<
    PatientSimilarityHit[] | null
  >(null);
  const [checkingDupes, setCheckingDupes] = useState(false);

  // ── Remake state ─────────────────────────────────────────────────────────
  const [isRemake, setIsRemake] = useState(false);
  const [remakeSearch, setRemakeSearch] = useState("");
  const [remakeResults, setRemakeResults] = useState<RemakeCaseHit[]>([]);
  const [remakeSearching, setRemakeSearching] = useState(false);
  const [remakeSelected, setRemakeSelected] = useState<RemakeCaseHit | null>(null);
  const [remakeReason, setRemakeReason] = useState("");
  const [remakeCharged, setRemakeCharged] = useState<"yes" | "no" | "">("");
  const remakeSearchTimerRef = useRef<number | null>(null);

  function clearRemake() {
    setIsRemake(false);
    setRemakeSearch("");
    setRemakeResults([]);
    setRemakeSearching(false);
    setRemakeSelected(null);
    setRemakeReason("");
    setRemakeCharged("");
    if (remakeSearchTimerRef.current !== null) {
      window.clearTimeout(remakeSearchTimerRef.current);
      remakeSearchTimerRef.current = null;
    }
  }

  const mutation = useMutation({
    mutationFn: (data: NewCaseFormData & Partial<RemakeDecision>) =>
      apiFetch<LabCase>("/cases", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      if (variables.remakeOfCaseId) {
        qc.invalidateQueries({ queryKey: ["case-remake-chain", variables.remakeOfCaseId] });
      }
      setDuplicateMatches(null);
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  function set<K extends keyof NewCaseFormData>(k: K, v: NewCaseFormData[K]) {
    setForm((f) => ({ ...f, [k]: v }));
    setError(null);
  }

  // Pre-fill due date from the lab's defaultCaseDueDays setting when the
  // user picks a lab and hasn't typed a date yet.
  useEffect(() => {
    if (!form.labOrganizationId || form.dueDate) return;
    const lab = labOrgs.find((o) => o.id === form.labOrganizationId);
    if (!lab?.defaultCaseDueDays) return;
    const d = new Date();
    d.setDate(d.getDate() + lab.defaultCaseDueDays);
    setForm((f) => ({ ...f, dueDate: d.toISOString().slice(0, 10) }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.labOrganizationId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.labOrganizationId)
      return setError("Please select a lab organization.");
    if (!form.providerOrganizationId)
      return setError("Please select a practice.");
    if (!form.patientFirstName.trim() || !form.patientLastName.trim())
      return setError("Patient first and last name are required.");
    if (!form.doctorName.trim()) return setError("Doctor name is required.");

    // If the user marked this as a remake, validate the remake fields and
    // submit directly — skip the auto-duplicate check to avoid double-linking.
    if (isRemake) {
      if (!remakeSelected) return setError("Select the original case being remade.");
      if (!remakeReason.trim()) return setError("Remake reason is required.");
      if (remakeCharged === "") return setError("Choose whether to charge for this remake.");
      const { caseNumber: _ignored, ...formWithoutCaseNumber } = form;
      mutation.mutate({
        ...formWithoutCaseNumber,
        remakeOfCaseId: remakeSelected.id,
        remakeReason: remakeReason.trim(),
        remakeCharged: remakeCharged === "yes",
      });
      return;
    }

    setCheckingDupes(true);
    try {
      const params = new URLSearchParams({
        patientFirstName: form.patientFirstName.trim(),
        patientLastName: form.patientLastName.trim(),
        providerOrganizationId: form.providerOrganizationId,
        labOrganizationId: form.labOrganizationId,
        doctorName: form.doctorName.trim(),
      });
      const res = await apiFetch<{ matches: PatientSimilarityHit[] }>(
        `/cases/patient-similarity?${params.toString()}`,
      );
      if (res.matches && res.matches.length > 0) {
        setDuplicateMatches(res.matches);
        setCheckingDupes(false);
        return;
      }
    } catch (err) {
      // Non-fatal: if the similarity check fails we still let the user
      // create the case rather than blocking on a flaky lookup.
      console.warn("patient-similarity check failed", err);
    }
    setCheckingDupes(false);
    mutation.mutate(form);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div
        className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg mx-4"
        role="dialog"
        aria-modal="true"
        aria-label="Add case"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-semibold">New case</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {orgsQuery.isLoading && (
            <p className="text-sm text-muted-foreground">
              Loading organizations…
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Case number
              </label>
              <div className="flex gap-2">
                <input
                  className="flex-1 h-9 px-3 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary font-mono"
                  value={form.caseNumber}
                  onChange={(e) => set("caseNumber", e.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() => set("caseNumber", generateCaseNumber())}
                  className="h-9 px-3 text-xs rounded-md bg-secondary hover:bg-secondary/80 text-muted-foreground transition-colors"
                >
                  Regenerate
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Lab organization
              </label>
              <select
                className="w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                value={form.labOrganizationId}
                onChange={(e) => set("labOrganizationId", e.target.value)}
              >
                <option value="">Select lab…</option>
                {labOrgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.displayName || o.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Practice
              </label>
              <ProviderPicker
                value={form.providerOrganizationId}
                providers={providerOrgs}
                onChange={(id) => set("providerOrganizationId", id)}
                disabled={orgsQuery.isLoading}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Patient first name
              </label>
              <input
                className="w-full h-9 px-3 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                value={form.patientFirstName}
                onChange={(e) => set("patientFirstName", e.target.value)}
                placeholder="First"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Patient last name
              </label>
              <input
                className="w-full h-9 px-3 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                value={form.patientLastName}
                onChange={(e) => set("patientLastName", e.target.value)}
                placeholder="Last"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Doctor name
              </label>
              <input
                className="w-full h-9 px-3 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                value={form.doctorName}
                onChange={(e) => set("doctorName", e.target.value)}
                placeholder="Dr. Smith"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Due date
              </label>
              <input
                type="date"
                className="w-full h-9 px-3 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                value={form.dueDate}
                onChange={(e) => set("dueDate", e.target.value)}
              />
            </div>

            <div className="col-span-2">
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Priority
              </label>
              <div className="flex gap-2">
                {(["normal", "rush"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => set("priority", p)}
                    className={`flex-1 h-9 rounded-md text-sm font-medium transition-colors ${
                      form.priority === p
                        ? p === "rush"
                          ? "bg-destructive/15 text-destructive border border-destructive/30"
                          : "bg-primary/10 text-primary border border-primary/30"
                        : "bg-secondary text-muted-foreground border border-transparent hover:bg-secondary/80"
                    }`}
                  >
                    {p === "rush" ? "Rush" : "Normal"}
                  </button>
                ))}
              </div>
            </div>

            <div className="col-span-2">
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Case pan barcode{" "}
                <span className="font-normal text-muted-foreground/70">(optional)</span>
              </label>
              <input
                className="w-full h-9 px-3 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary font-mono"
                value={form.casePanBarcode ?? ""}
                onChange={(e) => set("casePanBarcode", e.target.value || undefined)}
                placeholder="Scan or type barcode…"
                autoComplete="off"
              />
            </div>
          </div>

          {/* ── Remake section ───────────────────────────────────────────── */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Remake of an existing case?
              </span>
              <button
                type="button"
                onClick={() => {
                  if (isRemake) {
                    clearRemake();
                  } else {
                    setIsRemake(true);
                    setError(null);
                  }
                }}
                className={`h-6 px-2.5 rounded-md text-xs font-medium transition-colors ${
                  isRemake
                    ? "bg-primary/10 text-primary border border-primary/30"
                    : "bg-secondary text-muted-foreground border border-transparent hover:bg-secondary/80"
                }`}
              >
                {isRemake ? "Remake on" : "Mark as remake"}
              </button>
            </div>

            {isRemake && (
              <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
                {!remakeSelected ? (
                  <>
                    <p className="text-[11px] font-medium text-foreground">
                      Find the original case being remade
                    </p>
                    {!form.labOrganizationId && (
                      <p className="text-[11px] text-muted-foreground">
                        Select a lab organization above to search cases.
                      </p>
                    )}
                    {form.labOrganizationId && (
                      <>
                        <div className="relative">
                          <input
                            type="search"
                            placeholder="Search by case #, patient, or doctor…"
                            value={remakeSearch}
                            onChange={(e) => {
                              const q = e.target.value;
                              setRemakeSearch(q);
                              if (remakeSearchTimerRef.current !== null) {
                                window.clearTimeout(remakeSearchTimerRef.current);
                              }
                              if (q.length < 2) {
                                setRemakeResults([]);
                                setRemakeSearching(false);
                                return;
                              }
                              setRemakeSearching(true);
                              remakeSearchTimerRef.current = window.setTimeout(async () => {
                                remakeSearchTimerRef.current = null;
                                try {
                                  const result = await apiFetch<{ cases: RemakeCaseHit[] }>(
                                    `/cases/quick-search?labOrganizationId=${encodeURIComponent(form.labOrganizationId)}&q=${encodeURIComponent(q)}`,
                                  );
                                  setRemakeResults(result.cases ?? []);
                                } catch {
                                  setRemakeResults([]);
                                } finally {
                                  setRemakeSearching(false);
                                }
                              }, 280);
                            }}
                            className="w-full h-8 px-2.5 pr-7 rounded-md bg-background text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                          />
                          {remakeSearching && (
                            <Loader2
                              size={12}
                              className="absolute right-2.5 top-2 animate-spin text-muted-foreground"
                            />
                          )}
                        </div>
                        {remakeResults.length > 0 && (
                          <div className="rounded-md border border-border bg-card overflow-hidden max-h-40 overflow-y-auto divide-y divide-border">
                            {remakeResults.map((c) => (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => {
                                  setRemakeSelected(c);
                                  setRemakeSearch("");
                                  setRemakeResults([]);
                                }}
                                className="w-full px-3 py-2 text-left text-xs hover:bg-secondary/50 transition-colors"
                              >
                                <div className="font-medium font-mono">
                                  {c.caseNumber} · {c.patientFirstName} {c.patientLastName}
                                </div>
                                <div className="text-muted-foreground text-[11px]">
                                  {c.doctorName} · {c.status}
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                        {remakeSearch.length >= 2 &&
                          !remakeSearching &&
                          remakeResults.length === 0 && (
                            <p className="text-[11px] text-muted-foreground">
                              No cases found for "{remakeSearch}".
                            </p>
                          )}
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[11px] font-medium text-foreground">
                          Remaking:{" "}
                          <span className="font-mono">{remakeSelected.caseNumber}</span>
                        </p>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {remakeSelected.patientFirstName} {remakeSelected.patientLastName} ·{" "}
                          {remakeSelected.doctorName}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setRemakeSelected(null);
                          setRemakeReason("");
                          setRemakeCharged("");
                        }}
                        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                        aria-label="Clear remake selection"
                      >
                        <X size={13} />
                      </button>
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                        Remake reason (required)
                      </label>
                      <textarea
                        rows={2}
                        className="w-full px-2 py-1.5 rounded-md bg-background text-xs border border-border focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                        value={remakeReason}
                        onChange={(e) => setRemakeReason(e.target.value)}
                        placeholder="e.g. Shade B1 came back too dark; doctor requested A2"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-muted-foreground mb-1">
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
                            onClick={() => setRemakeCharged(opt.v)}
                            className={`flex-1 h-8 rounded-md text-xs font-medium transition-colors ${
                              remakeCharged === opt.v
                                ? opt.v === "no"
                                  ? "bg-amber-500/15 text-amber-700 border border-amber-500/40"
                                  : "bg-primary/10 text-primary border border-primary/30"
                                : "bg-secondary text-muted-foreground border border-transparent hover:bg-secondary/80"
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {error && (
            <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 h-9 rounded-md bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending || checkingDupes}
              className="flex-1 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-60 inline-flex items-center justify-center gap-1.5"
            >
              {(mutation.isPending || checkingDupes) && (
                <Loader2 size={12} className="animate-spin" />
              )}
              {checkingDupes
                ? "Checking…"
                : mutation.isPending
                ? "Creating…"
                : isRemake && remakeSelected
                ? "Create remake"
                : "Create case"}
            </button>
          </div>
        </form>
      </div>

      {duplicateMatches && (
        <PossibleDuplicateModal
          matches={duplicateMatches}
          patientFirstName={form.patientFirstName}
          patientLastName={form.patientLastName}
          isSubmitting={mutation.isPending}
          onCancel={() => setDuplicateMatches(null)}
          onProceedAsNew={() => {
            setDuplicateMatches(null);
            mutation.mutate(form);
          }}
          onProceedAsRemake={(decision) => {
            // Omit caseNumber so the server assigns the suffixed number
            // (e.g. "26-11B") automatically based on the original case.
            const { caseNumber: _ignored, ...formWithoutCaseNumber } = form;
            mutation.mutate({ ...formWithoutCaseNumber, ...decision });
          }}
        />
      )}
    </div>
  );
}

const CASES_FILTER_STORAGE_KEY = "cases_filters_v2";
const CASES_SCROLL_STORAGE_KEY = "cases_scroll_v1";
const CASES_ITERO_BATCH_KEY = "cases_itero_batch_v1";

type DateRangeFilter = "all" | "30" | "60" | "90" | "custom";

function readCasesFilters(): {
  search: string;
  statusFilter: string;
  priorityFilter: string;
  dateRangeFilter: DateRangeFilter;
  customStartDate: string;
  customEndDate: string;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
} {
  try {
    const raw = sessionStorage.getItem(CASES_FILTER_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    search: "",
    statusFilter: "all",
    priorityFilter: "all",
    dateRangeFilter: "all",
    customStartDate: "",
    customEndDate: "",
    sortKey: "createdAt",
    sortDir: "desc",
  };
}

function readIteroActiveBatch(): { batchId: string; caseIds: string[]; importedAt: string; label: string } | null {
  try {
    const raw = sessionStorage.getItem(CASES_ITERO_BATCH_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

export default function CasesPage() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const isPageAdmin = user?.role === "admin" || user?.role === "owner";

  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const initialFilters = useRef(readCasesFilters());

  const [search, setSearch] = useState(initialFilters.current.search);
  const [statusFilter, setStatusFilter] = useState<string>(initialFilters.current.statusFilter);
  const [priorityFilter, setPriorityFilter] = useState<string>(initialFilters.current.priorityFilter);
  const [dateRangeFilter, setDateRangeFilter] = useState<DateRangeFilter>(initialFilters.current.dateRangeFilter);
  const [customStartDate, setCustomStartDate] = useState<string>(initialFilters.current.customStartDate);
  const [customEndDate, setCustomEndDate] = useState<string>(initialFilters.current.customEndDate);
  const [sortKey, setSortKey] = useState<SortKey>(initialFilters.current.sortKey);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialFilters.current.sortDir);
  const [selected, setSelected] = useState<LabCase | null>(null);
  const [showNewCase, setShowNewCase] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showReassignModal, setShowReassignModal] = useState(false);
  const [reassignTargetId, setReassignTargetId] = useState<string>("");
  const [showBulkStatusModal, setShowBulkStatusModal] = useState(false);
  const [bulkStatusValue, setBulkStatusValue] = useState<string>("");
  const [showBulkDeleteModal, setShowBulkDeleteModal] = useState(false);

  const CASES_COL_DEFAULTS = [120, 100, 160, 140, 140, 120, 100, 90, 130, 100, 90, 200] as const;
  const { widths: caseColWidths, resizingCol: resizingCaseCol, startResize: startCaseResize, resetColumn: resetCaseColumn } =
    useColumnWidths([...CASES_COL_DEFAULTS], "labtrax_cases_col_widths_v2");
  const [iteroActiveBatch, setIteroActiveBatch] = useState<{ batchId: string; caseIds: string[]; importedAt: string; label: string } | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const scrollRestoredRef = useRef(false);
  const deepLinkOpenedRef = useRef(false);

  const qc = useQueryClient();

  const handleRefresh = () => {
    void refetch();
    qc.invalidateQueries({ queryKey: ["organizations"] });
    qc.invalidateQueries({ queryKey: ["invoice-for-case"] });
    qc.invalidateQueries({ queryKey: ["invoice-detail"] });
    if (selected?.id) {
      qc.invalidateQueries({ queryKey: ["case", selected.id] });
    }
  };

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
  });
  const providerOrgs = useMemo(
    () => (orgsQuery.data ?? []).filter((o) => o.type !== "lab"),
    [orgsQuery.data],
  );

  const bulkReassignMutation = useMutation({
    mutationFn: (body: { caseIds: string[]; providerOrganizationId: string }) =>
      apiFetch<{ updatedCount: number; skippedLegacyCount?: number }>("/cases/bulk-reassign", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      setSelectedIds(new Set());
      setShowReassignModal(false);
      setReassignTargetId("");
      const { updatedCount, skippedLegacyCount = 0 } = result;
      const base = `${updatedCount} case${updatedCount !== 1 ? "s" : ""} reassigned.`;
      setBulkToast(
        skippedLegacyCount > 0
          ? `${base} (${skippedLegacyCount} legacy case${skippedLegacyCount !== 1 ? "s" : ""} skipped)`
          : base
      );
    },
    onError: (e: Error) => {
      setBulkToastError(e.message);
    },
  });

  const bulkStatusMutation = useMutation({
    mutationFn: (body: { caseIds: string[]; status: string }) =>
      apiFetch<{ updatedCount: number; skippedLegacyCount?: number }>("/cases/bulk-status", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      setSelectedIds(new Set());
      setShowBulkStatusModal(false);
      setBulkStatusValue("");
      const label = STATUS_FILTERS.find((s) => s.value === bulkStatusValue)?.label ?? bulkStatusValue;
      const { updatedCount, skippedLegacyCount = 0 } = result;
      const base = `${updatedCount} case${updatedCount !== 1 ? "s" : ""} marked as ${label}.`;
      setBulkToast(
        skippedLegacyCount > 0
          ? `${base} (${skippedLegacyCount} legacy case${skippedLegacyCount !== 1 ? "s" : ""} skipped)`
          : base
      );
    },
    onError: (e: Error) => {
      setBulkToastError(e.message);
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (body: { caseIds: string[] }) =>
      apiFetch<{ deletedCount: number }>("/cases/bulk-delete", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      setSelectedIds(new Set());
      setShowBulkDeleteModal(false);
      setBulkToast(`${result.deletedCount} case${result.deletedCount !== 1 ? "s" : ""} deleted.`);
    },
    onError: (e: Error) => {
      setBulkToastError(e.message);
    },
  });

  const [bulkToast, setBulkToast] = useState<string | null>(null);
  const [bulkToastError, setBulkToastError] = useState<string | null>(null);

  const [barcodeInput, setBarcodeInput] = useState("");
  const [barcodeLookupError, setBarcodeLookupError] = useState<string | null>(null);
  const [barcodeLookupLoading, setBarcodeLookupLoading] = useState(false);
  const [scanMode, setScanMode] = useState(false);
  const [scanHistory, setScanHistory] = useState<LabCase[]>([]);
  const scanInputRef = useRef<HTMLInputElement>(null);

  function activateScanMode() {
    setScanMode(true);
    setBarcodeInput("");
    setBarcodeLookupError(null);
    setTimeout(() => scanInputRef.current?.focus(), 0);
  }

  function deactivateScanMode() {
    setScanMode(false);
    setBarcodeInput("");
    setBarcodeLookupError(null);
  }

  function addToScanHistory(c: LabCase) {
    setScanHistory((prev) => {
      const deduped = prev.filter((h) => h.id !== c.id);
      return [c, ...deduped].slice(0, 5);
    });
  }

  async function handleBarcodeLookup(code: string) {
    const trimmed = code.trim();
    if (!trimmed) return;
    setBarcodeLookupError(null);

    // Search loaded data first — instant, no extra round-trip needed.
    const local = (data ?? []).find((c) => c.casePanBarcode === trimmed);
    if (local) {
      setSelected(local);
      setBarcodeInput("");
      addToScanHistory(local);
      setTimeout(() => scanInputRef.current?.focus(), 50);
      return;
    }

    // Fall back to API lookup across all lab orgs the user belongs to.
    const labOrgs = (orgsQuery.data ?? []).filter((o) => o.type === "lab");
    if (!labOrgs.length) {
      setBarcodeLookupError("No case found for that pan.");
      return;
    }
    setBarcodeLookupLoading(true);
    try {
      for (const lab of labOrgs) {
        try {
          const result = await apiFetch<{ case: LabCase }>(
            `/cases/barcode/${encodeURIComponent(trimmed)}?labOrganizationId=${encodeURIComponent(lab.id)}`,
          );
          if (result.case) {
            setSelected(result.case);
            setBarcodeInput("");
            addToScanHistory(result.case);
            qc.invalidateQueries({ queryKey: ["cases"] });
            setTimeout(() => scanInputRef.current?.focus(), 50);
            return;
          }
        } catch (e: any) {
          // 404 just means this lab doesn't have it — try the next one.
          if (e?.status !== 404 && e?.message !== "No case found with that barcode.") throw e;
        }
      }
      setBarcodeLookupError("No case found for that pan.");
    } catch {
      setBarcodeLookupError("Lookup failed. Please try again.");
    } finally {
      setBarcodeLookupLoading(false);
    }
  }

  // Deep-link: if the URL contains ?caseId=<id>, auto-open that case in the drawer.
  useEffect(() => {
    if (deepLinkOpenedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const targetId = params.get("caseId");
    if (!targetId || isLoading) return;
    deepLinkOpenedRef.current = true;
    const found = data?.find((c) => c.id === targetId);
    if (found) {
      setSelected(found);
    } else {
      apiFetch<LabCase>(`/cases/${targetId}`)
        .then((fresh) => setSelected(fresh))
        .catch(() => {/* case not found or inaccessible */});
    }
  }, [data, isLoading]);

  useEffect(() => {
    const batch = readIteroActiveBatch();
    if (batch) {
      setIteroActiveBatch(batch);
      try { sessionStorage.removeItem(CASES_ITERO_BATCH_KEY); } catch {}
    }
  }, []);

  // Keyboard shortcut: Ctrl+B activates barcode scan mode.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "b" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        activateScanMode();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        CASES_FILTER_STORAGE_KEY,
        JSON.stringify({ search, statusFilter, priorityFilter, dateRangeFilter, customStartDate, customEndDate, sortKey, sortDir }),
      );
    } catch {}
  }, [search, statusFilter, priorityFilter, dateRangeFilter, customStartDate, customEndDate, sortKey, sortDir]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [search, statusFilter, priorityFilter, dateRangeFilter, customStartDate, customEndDate, iteroActiveBatch]);

  useEffect(() => {
    const el = pageRef.current?.closest("main") as HTMLElement | null;
    if (!el) return;

    const raw = sessionStorage.getItem(CASES_SCROLL_STORAGE_KEY);
    const target = raw !== null ? Number(raw) : NaN;
    if (Number.isFinite(target) && target > 0) {
      el.scrollTop = target;
      scrollRestoredRef.current = el.scrollTop >= target - 1;
    } else {
      scrollRestoredRef.current = true;
    }

    function handleScroll() {
      try {
        sessionStorage.setItem(CASES_SCROLL_STORAGE_KEY, String(el!.scrollTop));
      } catch {}
    }

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (isLoading || scrollRestoredRef.current) return;
    const el = pageRef.current?.closest("main") as HTMLElement | null;
    if (!el) return;
    const raw = sessionStorage.getItem(CASES_SCROLL_STORAGE_KEY);
    const target = raw !== null ? Number(raw) : NaN;
    if (Number.isFinite(target) && target > 0) {
      el.scrollTop = target;
    }
    scrollRestoredRef.current = true;
  }, [isLoading]);

  const filtered = useMemo(() => {
    const rows = data ?? [];
    const q = search.trim().toLowerCase();

    let startDate: Date | null = null;
    let endDate: Date | null = null;

    if (dateRangeFilter === "30" || dateRangeFilter === "60" || dateRangeFilter === "90") {
      const days = Number(dateRangeFilter);
      const now = new Date();
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1);
      endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    } else if (dateRangeFilter === "custom") {
      if (customStartDate) {
        const [y, m, d] = customStartDate.split("-").map(Number);
        startDate = new Date(y, m - 1, d);
      }
      if (customEndDate) {
        const [y, m, d] = customEndDate.split("-").map(Number);
        endDate = new Date(y, m - 1, d + 1);
      } else {
        const now = new Date();
        endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      }
    }

    const batchCaseIdSet = iteroActiveBatch ? new Set(iteroActiveBatch.caseIds) : null;

    return rows
      .filter((c) => {
        if (batchCaseIdSet && !batchCaseIdSet.has(c.id)) return false;
        if (statusFilter !== "all" && c.status !== statusFilter) return false;
        if (priorityFilter !== "all" && c.priority !== priorityFilter) return false;
        if (startDate !== null || endDate !== null) {
          if (!c.createdAt) return false;
          const d = new Date(c.createdAt);
          if (Number.isNaN(d.getTime())) return false;
          if (startDate !== null && d < startDate) return false;
          if (endDate !== null && d >= endDate) return false;
        }
        if (!q) return true;
        return (
          c.caseNumber.toLowerCase().includes(q) ||
          c.doctorName.toLowerCase().includes(q) ||
          `${c.patientFirstName} ${c.patientLastName}`.toLowerCase().includes(q) ||
          (c.casePanBarcode ?? "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        if (sortKey === "totalPrice") {
          const va = Number(a.totalPrice ?? 0);
          const vb = Number(b.totalPrice ?? 0);
          return sortDir === "asc" ? va - vb : vb - va;
        }
        const va = (a[sortKey] || "") as string;
        const vb = (b[sortKey] || "") as string;
        return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      });
  }, [data, search, statusFilter, priorityFilter, dateRangeFilter, customStartDate, customEndDate, sortKey, sortDir, iteroActiveBatch]);

  const distinctDoctorNames = useMemo(() => {
    const names = new Set<string>();
    for (const c of data ?? []) {
      if (c.doctorName?.trim()) names.add(c.doctorName.trim());
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const distinctPatientLastNames = useMemo(() => {
    const names = new Set<string>();
    for (const c of data ?? []) {
      if (c.patientLastName?.trim()) names.add(c.patientLastName.trim());
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [data]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function SortHeader({ k, children }: { k: SortKey; children: React.ReactNode }) {
    return (
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground font-medium hover:text-foreground"
      >
        {children}
        {sortKey === k && (sortDir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
      </button>
    );
  }

  return (
    <div ref={pageRef} className="px-8 py-7">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cases</h1>
          <p className="text-sm text-muted-foreground mt-1">
            All lab cases across your organizations.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-sm text-muted-foreground">
            {filtered.length} of {data?.length ?? 0}
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isFetching}
            title="Refresh cases"
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-border bg-background text-sm font-medium hover:bg-muted/50 transition-colors disabled:opacity-60"
          >
            <RefreshCw size={14} className={isFetching ? "animate-spin" : ""} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setShowNewCase(true)}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors shadow-sm"
          >
            <Plus size={14} />
            Add case
          </button>
        </div>
      </div>

      {iteroActiveBatch && (
        <div className="mb-4 flex items-center gap-3 px-4 py-2.5 rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-sm text-blue-800 dark:text-blue-200">
          <Sparkles size={14} className="shrink-0 text-blue-500" />
          <span className="flex-1">
            Filtered to iTero import session — {iteroActiveBatch.label} on{" "}
            {new Date(iteroActiveBatch.importedAt).toLocaleString()}.{" "}
            Showing {filtered.length} case{filtered.length !== 1 ? "s" : ""}.
          </span>
          <button
            type="button"
            onClick={() => setIteroActiveBatch(null)}
            className="shrink-0 p-0.5 rounded hover:bg-blue-100 dark:hover:bg-blue-900"
            title="Clear filter"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl overflow-clip">
        <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search case #, doctor, patient…"
              className="w-full h-9 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
            />
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Filter size={13} />
            Status:
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          >
            <option value="all">All priorities</option>
            <option value="normal">Normal</option>
            <option value="rush">Rush</option>
          </select>
          <select
            value={dateRangeFilter}
            onChange={(e) => {
              setDateRangeFilter(e.target.value as DateRangeFilter);
              if (e.target.value !== "custom") {
                setCustomStartDate("");
                setCustomEndDate("");
              }
            }}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          >
            <option value="all">All time</option>
            <option value="30">Last 30 days</option>
            <option value="60">Last 60 days</option>
            <option value="90">Last 90 days</option>
            <option value="custom">Custom…</option>
          </select>
          {dateRangeFilter === "custom" && (
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                value={customStartDate}
                onChange={(e) => setCustomStartDate(e.target.value)}
                className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
                aria-label="Start date"
              />
              <span className="text-muted-foreground text-xs">–</span>
              <input
                type="date"
                value={customEndDate}
                min={customStartDate || undefined}
                onChange={(e) => setCustomEndDate(e.target.value)}
                className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
                aria-label="End date"
              />
            </div>
          )}

          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            {scanMode ? (
              <>
                <div className="relative flex items-center">
                  <Barcode
                    size={14}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-primary pointer-events-none"
                  />
                  {barcodeLookupLoading && (
                    <Loader2
                      size={12}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground pointer-events-none"
                    />
                  )}
                  <input
                    ref={scanInputRef}
                    type="text"
                    value={barcodeInput}
                    onChange={(e) => {
                      setBarcodeInput(e.target.value);
                      setBarcodeLookupError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleBarcodeLookup(barcodeInput);
                      if (e.key === "Escape") deactivateScanMode();
                    }}
                    onBlur={() => {
                      if (!barcodeInput.trim() && !barcodeLookupLoading && scanHistory.length === 0) deactivateScanMode();
                    }}
                    placeholder="Scan or type barcode…"
                    autoComplete="off"
                    className="h-9 pl-8 pr-8 w-56 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-primary"
                    aria-label="Scan barcode"
                  />
                </div>
                <button
                  type="button"
                  onClick={deactivateScanMode}
                  title="Cancel scan (Esc)"
                  className="h-9 w-9 flex items-center justify-center rounded-md hover:bg-secondary/80 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X size={14} />
                </button>
                {barcodeLookupError && (
                  <span className="text-xs text-destructive whitespace-nowrap">
                    {barcodeLookupError}
                  </span>
                )}
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={activateScanMode}
                  title="Scan barcode (Ctrl+B)"
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-border bg-background text-sm font-medium hover:bg-muted/50 transition-colors"
                >
                  <Barcode size={14} />
                  Scan barcode
                </button>
                {barcodeLookupError && (
                  <span className="text-xs text-destructive whitespace-nowrap">
                    {barcodeLookupError}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        {scanMode && scanHistory.length > 0 && (
          <div className="px-4 py-2 border-b border-border bg-primary/5 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-muted-foreground shrink-0 flex items-center gap-1">
              <Barcode size={12} />
              Recently scanned:
            </span>
            {scanHistory.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelected(c)}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border bg-background hover:bg-muted/60 transition-colors text-xs"
              >
                <span className="font-mono font-medium text-foreground">{c.caseNumber}</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-foreground">
                  {c.patientFirstName || c.patientInitials
                    ? `${c.patientFirstName} ${c.patientLastName}`.trim() || c.patientInitials
                    : "—"}
                </span>
                <span className="text-muted-foreground">·</span>
                <StatusBadge status={c.status} size="sm" />
              </button>
            ))}
          </div>
        )}
        {selectedIds.size > 0 && (
          <div className="sticky top-0 z-10 px-4 py-2.5 border-b border-border bg-card/95 backdrop-blur-sm flex items-center gap-3 shadow-sm">
            <span className="text-sm font-medium">
              {selectedIds.size} case{selectedIds.size !== 1 ? "s" : ""} selected
            </span>
            <button
              type="button"
              onClick={() => {
                setReassignTargetId("");
                setShowReassignModal(true);
              }}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
            >
              Reassign
            </button>
            <button
              type="button"
              onClick={() => {
                setBulkStatusValue("");
                setShowBulkStatusModal(true);
              }}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-secondary text-foreground text-xs font-medium hover:bg-secondary/80 transition-colors border border-border"
            >
              Change Location
            </button>
            {isPageAdmin && (
              <button
                type="button"
                onClick={() => setShowBulkDeleteModal(true)}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-destructive text-destructive-foreground text-xs font-medium hover:bg-destructive/90 transition-colors"
              >
                <Trash2 size={13} />
                Delete
              </button>
            )}
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              Clear selection
            </button>
          </div>
        )}
        <div className="overflow-x-auto relative">
          {resizingCaseCol !== null && (
            <div
              className="bg-primary/50 pointer-events-none absolute top-0 bottom-0 z-10"
              style={{
                left: 36 + caseColWidths.slice(0, resizingCaseCol + 1).reduce((a, b) => a + b, 0) - 1,
                width: 2,
              }}
            />
          )}
          <table className="text-sm" style={{ width: 36 + caseColWidths.reduce((a, b) => a + b, 0), tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: 36 }} />
              {caseColWidths.map((w, i) => (
                <col key={i} style={{ width: w }} />
              ))}
            </colgroup>
            <thead>
              <tr className="bg-secondary/40">
                <th className="py-2.5 pl-3 pr-1 w-9">
                  <input
                    type="checkbox"
                    aria-label="Select all cases"
                    checked={filtered.length > 0 && filtered.every((c) => selectedIds.has(c.id))}
                    ref={(el) => {
                      if (el) {
                        el.indeterminate =
                          selectedIds.size > 0 &&
                          !filtered.every((c) => selectedIds.has(c.id)) &&
                          filtered.some((c) => selectedIds.has(c.id));
                      }
                    }}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedIds(new Set(filtered.map((c) => c.id)));
                      } else {
                        setSelectedIds(new Set());
                      }
                    }}
                    className="rounded border-border"
                  />
                </th>
                {([
                  { label: <SortHeader k="createdAt">Created</SortHeader>, align: "left" },
                  { label: <SortHeader k="caseNumber">Case #</SortHeader>, align: "left" },
                  { label: "Patient", align: "left" },
                  { label: <SortHeader k="doctorName">Doctor</SortHeader>, align: "left" },
                  { label: "Type", align: "left" },
                  { label: "Material", align: "left" },
                  { label: "Teeth", align: "left" },
                  { label: "Priority", align: "left" },
                  { label: <SortHeader k="status">Status</SortHeader>, align: "left" },
                  { label: "Pan", align: "left" },
                  { label: <SortHeader k="dueDate">Due</SortHeader>, align: "left" },
                  { label: <SortHeader k="totalPrice">Price</SortHeader>, align: "right" },
                  { label: "Notes", align: "left" },
                ] as const).map((col, i) => (
                  <th
                    key={i}
                    className={`${col.align === "right" ? "text-right" : "text-left"} ${i === 0 ? "px-5" : ""} py-2.5 relative`}
                    style={{ overflow: "hidden" }}
                  >
                    {col.label}
                    <div
                      onMouseDown={(e) => startCaseResize(i, e)}
                      onDoubleClick={() => resetCaseColumn(i)}
                      className="group/resize"
                      style={{
                        position: "absolute",
                        top: 0,
                        right: 0,
                        width: 6,
                        height: "100%",
                        cursor: "col-resize",
                        userSelect: "none",
                        display: "flex",
                        alignItems: "stretch",
                        justifyContent: "flex-end",
                      }}
                    >
                      <span
                        className={`w-0.5 transition-colors duration-100 ${resizingCaseCol === i ? "bg-primary" : "bg-border/60 group-hover/resize:bg-primary/50"}`}
                        style={{ display: "block", height: "100%" }}
                      />
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={14} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading cases…
                  </td>
                </tr>
              )}
              {error && (
                <tr>
                  <td colSpan={14} className="px-5 py-12 text-center text-destructive">
                    {(error as Error).message}
                  </td>
                </tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={14} className="px-5 py-12 text-center text-muted-foreground">
                    No cases match the current filters.
                  </td>
                </tr>
              )}
              {filtered.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => setSelected(c)}
                  className={`border-t border-border cursor-pointer hover:bg-secondary/40 ${selectedIds.has(c.id) ? "bg-primary/5" : ""}`}
                >
                  <td className="pl-3 pr-1 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select case ${c.caseNumber}`}
                      checked={selectedIds.has(c.id)}
                      onChange={(e) => {
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(c.id);
                          else next.delete(c.id);
                          return next;
                        });
                      }}
                      className="rounded border-border"
                    />
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">{formatShortDate(c.createdAt)}</td>
                  <td className="px-5 py-3 font-mono text-xs">
                    <div className="flex items-center gap-1.5">
                      {c.needsAiReview && (
                        <span
                          title={`Auto-imported from ${c.aiImportSource ?? "AI"} — needs review`}
                          className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400"
                          aria-label="Needs AI review"
                        >
                          <Sparkles size={11} />
                        </span>
                      )}
                      <span>{c.caseNumber}</span>
                    </div>
                  </td>
                  <td className="py-3">
                    {c.patientFirstName} {c.patientLastName}
                  </td>
                  <td className="py-3 text-muted-foreground">{c.doctorName}</td>
                  <td className="py-3 text-muted-foreground truncate max-w-[140px]" title={c.restorationTypes ?? ""}>
                    {c.restorationTypes || "—"}
                  </td>
                  <td className="py-3 text-muted-foreground truncate max-w-[120px]" title={c.restorationMaterials ?? ""}>
                    {c.restorationMaterials || "—"}
                  </td>
                  <td className="py-3 text-muted-foreground truncate max-w-[100px]" title={c.teeth ?? ""}>
                    {c.teeth || "—"}
                  </td>
                  <td className="py-3">
                    {c.priority === "rush" ? (
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-destructive bg-destructive/10 px-2 py-0.5 rounded-full">
                        Rush
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Normal</span>
                    )}
                  </td>
                  <td className="py-3"><StatusBadge status={c.status} /></td>
                  <td className="py-3 text-muted-foreground font-mono text-xs">
                    {c.casePanBarcode
                      ? c.casePanBarcode.length > 12
                        ? c.casePanBarcode.slice(0, 12) + "…"
                        : c.casePanBarcode
                      : "—"}
                  </td>
                  <td className="py-3 text-muted-foreground">{formatShortDate(c.dueDate)}</td>
                  <td className="py-3 text-right tabular-nums">
                    {Number(c.totalPrice ?? 0) > 0 ? formatMoney(c.totalPrice) : "—"}
                  </td>
                  <td
                    className="py-3 text-muted-foreground truncate max-w-[200px] text-xs"
                    title={c.caseNotes ?? ""}
                  >
                    {c.caseNotes || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <CaseDrawer
          labCase={selected}
          onClose={() => {
            setSelected(null);
            const params = new URLSearchParams(window.location.search);
            if (params.has("caseId")) {
              params.delete("caseId");
              const newSearch = params.toString();
              setLocation(`/cases${newSearch ? `?${newSearch}` : ""}`);
            }
          }}
          doctorNames={distinctDoctorNames}
          patientLastNames={distinctPatientLastNames}
          onOpenCaseId={async (id) => {
            const found = data?.find((c) => c.id === id);
            if (found) {
              setSelected(found);
              return;
            }
            try {
              const fresh = await apiFetch<LabCase>(`/cases/${id}`);
              setSelected(fresh);
            } catch {
              /* ignore — case may be soft-deleted or out of scope */
            }
          }}
        />
      )}
      {showNewCase && <NewCaseModal onClose={() => setShowNewCase(false)} />}

      {showReassignModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div
            className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md mx-4"
            role="dialog"
            aria-modal="true"
            aria-label="Reassign cases"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-base font-semibold">Reassign {selectedIds.size} case{selectedIds.size !== 1 ? "s" : ""}</h2>
              <button
                type="button"
                onClick={() => {
                  setShowReassignModal(false);
                  setReassignTargetId("");
                }}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                  New practice
                </label>
                <ProviderPicker
                  value={reassignTargetId}
                  onChange={(id) => setReassignTargetId(id)}
                  providers={providerOrgs}
                />
              </div>
              {bulkReassignMutation.isError && (
                <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                  {bulkReassignMutation.error instanceof Error
                    ? bulkReassignMutation.error.message
                    : "An error occurred."}
                </p>
              )}
            </div>
            <div className="flex gap-3 px-6 pb-5">
              <button
                type="button"
                onClick={() => {
                  setShowReassignModal(false);
                  setReassignTargetId("");
                }}
                className="flex-1 h-9 rounded-lg bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!reassignTargetId || bulkReassignMutation.isPending}
                onClick={() => {
                  if (!reassignTargetId) return;
                  bulkReassignMutation.mutate({
                    caseIds: Array.from(selectedIds),
                    providerOrganizationId: reassignTargetId,
                  });
                }}
                className="flex-1 h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center justify-center gap-1.5"
              >
                {bulkReassignMutation.isPending && <Loader2 size={13} className="animate-spin" />}
                Reassign
              </button>
            </div>
          </div>
        </div>
      )}

      {showBulkStatusModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div
            className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm mx-4"
            role="dialog"
            aria-modal="true"
            aria-label="Change case location"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-base font-semibold">Change Location — {selectedIds.size} case{selectedIds.size !== 1 ? "s" : ""}</h2>
              <button
                type="button"
                onClick={() => {
                  setShowBulkStatusModal(false);
                  setBulkStatusValue("");
                }}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5" htmlFor="bulk-status-select">
                  New location
                </label>
                <select
                  id="bulk-status-select"
                  value={bulkStatusValue}
                  onChange={(e) => setBulkStatusValue(e.target.value)}
                  className="w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
                >
                  <option value="" disabled>Select a status…</option>
                  {STATUS_FILTERS.filter((s) => s.value !== "all").map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              {bulkStatusMutation.isError && (
                <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                  {bulkStatusMutation.error instanceof Error
                    ? bulkStatusMutation.error.message
                    : "An error occurred."}
                </p>
              )}
            </div>
            <div className="flex gap-3 px-6 pb-5">
              <button
                type="button"
                onClick={() => {
                  setShowBulkStatusModal(false);
                  setBulkStatusValue("");
                }}
                className="flex-1 h-9 rounded-lg bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!bulkStatusValue || bulkStatusMutation.isPending}
                onClick={() => {
                  if (!bulkStatusValue) return;
                  bulkStatusMutation.mutate({
                    caseIds: Array.from(selectedIds),
                    status: bulkStatusValue,
                  });
                }}
                className="flex-1 h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center justify-center gap-1.5"
              >
                {bulkStatusMutation.isPending && <Loader2 size={13} className="animate-spin" />}
                Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {showBulkDeleteModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div
            className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm mx-4"
            role="dialog"
            aria-modal="true"
            aria-label="Delete cases"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-base font-semibold text-destructive">Delete {selectedIds.size} case{selectedIds.size !== 1 ? "s" : ""}?</h2>
              <button
                type="button"
                onClick={() => setShowBulkDeleteModal(false)}
                disabled={bulkDeleteMutation.isPending}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-3">
              <p className="text-sm text-muted-foreground">
                This will permanently remove{" "}
                <span className="font-medium text-foreground">{selectedIds.size} case{selectedIds.size !== 1 ? "s" : ""}</span>{" "}
                from the lab. This action cannot be undone.
              </p>
              {bulkDeleteMutation.isError && (
                <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                  {bulkDeleteMutation.error instanceof Error
                    ? bulkDeleteMutation.error.message
                    : "An error occurred."}
                </p>
              )}
            </div>
            <div className="flex gap-3 px-6 pb-5">
              <button
                type="button"
                onClick={() => setShowBulkDeleteModal(false)}
                disabled={bulkDeleteMutation.isPending}
                className="flex-1 h-9 rounded-lg bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={bulkDeleteMutation.isPending}
                onClick={() => {
                  bulkDeleteMutation.mutate({ caseIds: Array.from(selectedIds) });
                }}
                className="flex-1 h-9 rounded-lg bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 disabled:opacity-60 inline-flex items-center justify-center gap-1.5"
              >
                {bulkDeleteMutation.isPending && <Loader2 size={13} className="animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {bulkToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] bg-foreground text-background text-sm px-4 py-2.5 rounded-xl shadow-lg flex items-center gap-3 animate-in fade-in slide-in-from-bottom-2">
          <Check size={14} className="shrink-0 text-green-400" />
          {bulkToast}
          <button
            type="button"
            onClick={() => setBulkToast(null)}
            className="ml-1 opacity-70 hover:opacity-100"
            aria-label="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {bulkToastError && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] bg-destructive text-destructive-foreground text-sm px-4 py-2.5 rounded-xl shadow-lg flex items-center gap-3 animate-in fade-in slide-in-from-bottom-2">
          <AlertTriangle size={14} className="shrink-0" />
          {bulkToastError}
          <button
            type="button"
            onClick={() => setBulkToastError(null)}
            className="ml-1 opacity-70 hover:opacity-100"
            aria-label="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

function MobileCaseDrawer({ labCase, onClose }: { labCase: LabCase; onClose: () => void }) {
  const [rxPreviewOpen, setRxPreviewOpen] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-foreground/30" onClick={onClose} />
      <aside className="w-full max-w-[520px] bg-card border-l border-border h-full flex flex-col">
        <header className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Case · from mobile app</div>
            <div className="font-mono text-sm font-semibold">{labCase.caseNumber}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
          >
            <X size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <div className="text-xs text-muted-foreground bg-secondary/60 rounded-lg px-3 py-2">
            This case was created on the mobile app. Open LabTrax on your phone or tablet to edit it.
          </div>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Patient</div>
              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                <span className="text-sm">{`${labCase.patientFirstName} ${labCase.patientLastName}`.trim() || "—"}</span>
                <button
                  type="button"
                  onClick={() => setRxPreviewOpen(true)}
                  className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-medium text-primary/80 hover:text-primary hover:bg-primary/10 transition-colors"
                  title="Preview prescription"
                >
                  <ScrollText size={10} />
                  Preview Rx
                </button>
              </div>
            </div>
            <Field label="Doctor" value={labCase.doctorName} />
            <Field label="Status" value={statusLabel(labCase.status)} />
            <Field label="Priority" value={labCase.priority === "rush" ? "Rush" : "Normal"} />
            {labCase.restorationTypes && (
              <Field label="Type" value={labCase.restorationTypes} />
            )}
            {labCase.restorationMaterials && (
              <Field label="Material" value={labCase.restorationMaterials} />
            )}
            {labCase.teeth && (
              <Field label="Teeth" value={labCase.teeth} />
            )}
            <Field label="Due date" value={formatDate(labCase.dueDate)} />
            <Field label="Created" value={formatDate(labCase.createdAt)} />
            {Number(labCase.totalPrice ?? 0) > 0 && (
              <Field label="Price" value={formatMoney(labCase.totalPrice)} />
            )}
          </div>
        </div>
      </aside>
      {rxPreviewOpen && (
        <PrescriptionPreview
          caseId={labCase.id}
          invoiceCaseId={labCase.id}
          onClose={() => setRxPreviewOpen(false)}
        />
      )}
    </div>
  );
}

type CaseNote = {
  id: string;
  noteText?: string | null;
  visibility?: string | null;
  createdAt?: string | null;
  authorName?: string | null;
};

type DetailedCase = LabCase & {
  restorations: CaseRestoration[];
  notes: CaseNote[];
  events: CaseEvent[];
  /** Events from the original case when this case is a remake. */
  originalCaseEvents?: CaseEvent[];
  /** Events from each canonical remake child, so viewing the original case shows a unified timeline. */
  remakeChildrenEvents?: Array<{ caseId: string; caseNumber: string; events: CaseEvent[] }>;
  attachments: CaseAttachment[];
  viewerIsLabMember?: boolean;
  viewerCanManageAttachments?: boolean;
  /** Serialized bridge connector pairs, e.g. "13-14,14-15". Null when none. */
  bridgeConnectors?: string | null;
  expectedDeliveryDate?: string | null;
  statusHistory?: Array<{ status: string; occurredAt: string }>;
  remakeOriginal?: {
    id: string;
    caseNumber: string;
    patientFirstName: string;
    patientLastName: string;
    status: string;
    createdAt: string | null;
  } | null;
  remakeChildren?: Array<{
    id: string;
    caseNumber: string;
    patientFirstName: string;
    patientLastName: string;
    status: string;
    createdAt: string | null;
    remakeReason: string | null;
    remakeCharged: boolean | null;
  }>;
};

function formatEventType(eventType: string | undefined | null): string {
  if (!eventType) return "Event";
  // The "Locate Case" UI changes the case's workflow stage via
  // PATCH /cases/:id { status }, which the server records as a
  // "status_changed" event. To users that action is "locating" the
  // case at a station, so surface it as "Location Changed" in the
  // history feed (and in the printed history below).
  if (eventType === "status_changed") return "Location Changed";
  return eventType
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const RESTORATION_TYPES = [
  "Crown",
  "Bridge",
  "Veneer",
  "Implant Crown",
  "Inlay",
  "Onlay",
  "Full Denture",
  "Partial Denture",
  "Night Guard",
  "Retainer",
  "Sports Guard",
  "Snore Guard",
  "Other",
];

const MATERIALS = [
  "Zirconia",
  "PFM",
  "E.max",
  "Full Cast",
  "Composite",
  "Acrylic",
  "Metal",
  "PMMA",
  "Other",
];

const SHADES = [
  "A1", "A2", "A3", "A3.5", "A4",
  "B1", "B2", "B3", "B4",
  "C1", "C2", "C3", "C4",
  "D2", "D3", "D4",
  "BL1", "BL2", "BL3", "BL4",
];

const TIMELINE_STATUS_LABELS: Record<string, string> = {
  received: "Received",
  in_design: "Design",
  scan: "Scan",
  in_milling: "Milling",
  post_mill: "Post Mill",
  sintering_furnace: "Sintering",
  model_room: "Model Room",
  in_porcelain: "Porcelain",
  qc: "QC",
  complete: "Complete",
  shipped: "Shipped",
  delivered: "Delivered",
  on_hold: "On Hold",
  remake: "Remake",
  cancelled: "Cancelled",
};

function CaseTimelineBar({
  statusHistory,
  currentStatus,
}: {
  statusHistory: Array<{ status: string; label?: string; occurredAt: string }>;
  currentStatus: string;
}) {
  function fmtDate(s: string) {
    try {
      return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    } catch {
      return "";
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="overflow-x-auto pb-1">
        <div className="flex items-center min-w-max">
          {statusHistory.map((entry, idx) => {
            const isLast = idx === statusHistory.length - 1;
            const isCurrent = entry.status === currentStatus && idx === statusHistory.length - 1;
            const label = entry.label ?? TIMELINE_STATUS_LABELS[entry.status] ?? entry.status;
            return (
              <div key={idx} className="flex items-center">
                <div className="flex flex-col items-center gap-1.5 w-[70px]">
                  <span className="text-[9px] font-semibold text-muted-foreground text-center leading-tight line-clamp-2 h-[22px] flex items-end justify-center">
                    {label}
                  </span>
                  <div
                    className={[
                      "rounded-full border-2 border-background",
                      isCurrent
                        ? "w-3.5 h-3.5 bg-primary ring-2 ring-primary/30"
                        : "w-2.5 h-2.5 bg-primary/70",
                    ].join(" ")}
                  />
                  <span className="text-[9px] text-muted-foreground text-center">
                    {fmtDate(entry.occurredAt)}
                  </span>
                </div>
                {/* Connector */}
                {!isLast && (
                  <div className="relative h-0.5 w-7 bg-border shrink-0 overflow-hidden rounded-full">
                    <div className="absolute inset-y-0 left-0 rounded-full bg-primary/60 w-full" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

type CaseTab = "lab-slip" | "restorations" | "notes" | "files" | "invoice" | "history";

export function CaseDrawer({
  labCase,
  onClose,
  doctorNames = [],
  patientLastNames = [],
  onOpenCaseId,
}: {
  labCase: LabCase;
  onClose: () => void;
  doctorNames?: string[];
  patientLastNames?: string[];
  onOpenCaseId?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { openPanel: openAiPanel } = useAiPanel();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileDragOver, setFileDragOver] = useState(false);
  const fileDragCounterRef = useRef(0);

  const [activeTab, setActiveTab] = useState<CaseTab>("lab-slip");
  const [historySortOrder, setHistorySortOrder] = useState<"asc" | "desc">("desc");
  const [remakeChainExpanded, setRemakeChainExpanded] = useState(true);
  const [viewingInvoice, setViewingInvoice] = useState<Invoice | null>(null);
  const [lightbox, setLightbox] = useState<
    { url: string; kind: "image" | "video"; mimeType?: string } | null
  >(null);
  const setLightboxUrl = (url: string | null) => setLightbox(url ? { url, kind: "image" } : null);
  const [confirmDeleteCase, setConfirmDeleteCase] = useState(false);
  const [showPrintLayoutEditor, setShowPrintLayoutEditor] = useState(false);
  const [showCaseAdvancedEditor, setShowCaseAdvancedEditor] = useState(false);
  const [rxPreviewOpen, setRxPreviewOpen] = useState(false);
  const [printLayout, setPrintLayout] = useState<PrintLayoutConfig>(() => loadPrintLayoutConfig());

  // Per-lab advanced (drag/scale) print template. Null = no custom layout
  // yet — the Print button keeps the existing list-based lab slip.
  const advancedTemplateQuery = useQuery<{
    template: CasePrintTemplate;
    isCustom: boolean;
  }>({
    enabled: !!labCase.labOrganizationId,
    queryKey: ["casePrintTemplate", labCase.labOrganizationId],
    queryFn: async () => {
      const res = await apiFetch<
        { data: { template: unknown; isCustom: boolean } } | { template: unknown; isCustom: boolean }
      >(`/organizations/${labCase.labOrganizationId}/case-print-template`);
      const inner = (res as { data?: { template: unknown; isCustom: boolean } }).data ?? (res as { template: unknown; isCustom: boolean });
      return {
        template: coerceCasePrintTemplate(inner.template),
        isCustom: !!inner.isCustom,
      };
    },
  });
  const hasAdvancedTemplate = !!advancedTemplateQuery.data?.isCustom;

  const [editMode, setEditMode] = useState(false);
  const barcodeScanInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editMode) return;
    const id = setTimeout(() => barcodeScanInputRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, [editMode]);
  const [editForm, setEditForm] = useState({
    patientFirstName: labCase.patientFirstName || "",
    patientLastName: labCase.patientLastName || "",
    doctorName: labCase.doctorName || "",
    providerOrganizationId: labCase.providerOrganizationId || "",
    dueDate: labCase.dueDate
      ? new Date(labCase.dueDate).toISOString().split("T")[0]
      : "",
    priority: (labCase.priority || "normal") as "normal" | "rush",
    casePanBarcode: labCase.casePanBarcode || "",
  });
  const [editError, setEditError] = useState<string | null>(null);
  const [editNoteText, setEditNoteText] = useState("");

  const [routeStatus, setRouteStatus] = useState("");
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeSuccessMsg, setRouteSuccessMsg] = useState<string | null>(null);
  const [qrLinkCopied, setQrLinkCopied] = useState(false);

  const [noteText, setNoteText] = useState("");
  const [shareWithProvider, setShareWithProvider] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [notifyModal, setNotifyModal] = useState<{
    open: boolean;
    noteId: string;
    method: "email" | "sms" | null;
    step: "choose" | "confirm_save" | "success";
    sending: boolean;
    error: string | null;
  }>({ open: false, noteId: "", method: null, step: "choose", sending: false, error: null });

  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [generatingInvoice, setGeneratingInvoice] = useState(false);
  const [invError, setInvError] = useState<string | null>(null);
  const [generatePresetId, setGeneratePresetId] = useState<string>("");
  const [invoicePrintLogoDataUrl, setInvoicePrintLogoDataUrl] = useState<string | null>(null);
  const [invoicePrintQrDataUrl, setInvoicePrintQrDataUrl] = useState<string | null>(null);

  const generatePresetsQuery = useQuery({
    queryKey: ["invoice-template-presets", labCase.labOrganizationId],
    queryFn: () =>
      apiFetch<{ presets: Array<{ id: string; name: string }> }>(
        `/organizations/${labCase.labOrganizationId}/invoice-template/presets`,
      ),
    staleTime: 60_000,
  });
  const generatePresets = generatePresetsQuery.data?.presets ?? [];

  const billableItemsQuery = useQuery({
    queryKey: ["finance", "vendors", labCase.labOrganizationId, "items"],
    queryFn: () =>
      apiFetch<Array<{ id: string; name: string; unitPrice: string | null }>>(
        `/finance/vendors?organizationId=${encodeURIComponent(labCase.labOrganizationId)}&vendorType=item`,
      ),
    enabled: !!labCase.labOrganizationId,
    staleTime: 60_000,
  });
  const billableItems = billableItemsQuery.data ?? [];

  function lookupBillablePrice(name: string): string {
    if (!name) return "";
    const match = billableItems.find(
      (it) => it.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    return match?.unitPrice ? String(match.unitPrice) : "";
  }

  const [showAddRest, setShowAddRest] = useState(false);
  const [restForm, setRestForm] = useState({
    toothNumber: "",
    restorationType: "",
    customType: "",
    material: "",
    shade: "",
    quantity: 1,
    unitPrice: "",
  });
  const [restError, setRestError] = useState<string | null>(null);

  // Interactive tooth chart dialog state
  const [toothDialogId, setToothDialogId] = useState<string | null>(null);
  const [toothDialogError, setToothDialogError] = useState<string | null>(null);

  // --- Draft / pending changes state ---
  type PendingCreate = {
    localId: string;
    toothNumber: string;
    restorationType: string;
    material: string;
    shade: string;
    quantity: number;
    unitPrice: string;
  };
  type PendingUpdate = {
    restorationId: string;
    newToothNumber: string;
    material?: string;
    shade?: string;
  };
  type PendingCaseEdit = {
    patientFirstName: string;
    patientLastName: string;
    doctorName: string;
    providerOrganizationId: string;
    dueDate: string;
    priority: "normal" | "rush";
    casePanBarcode: string;
  };

  const [pendingCreates, setPendingCreates] = useState<PendingCreate[]>([]);
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(new Set());
  const [pendingUpdates, setPendingUpdates] = useState<PendingUpdate[]>([]);
  const [pendingCaseEdit, setPendingCaseEdit] = useState<PendingCaseEdit | null>(null);
  // Optimistic state for missing-tooth auto-saves (applied immediately, cleared
  // after the server round-trip + cache refetch complete so there's no flicker).
  const [optimisticMissingAdds, setOptimisticMissingAdds] = useState<Set<string>>(new Set());
  const [optimisticMissingDeletes, setOptimisticMissingDeletes] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // When unsaved edits would be lost (close, in-app route navigation, etc.) we
  // stash the action to run if the user confirms; a non-null value shows the
  // "Unsaved changes" discard confirmation.
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(
    null,
  );

  // Bridge connector state — initialised from case data once loaded
  const [connectedPairs, setConnectedPairs] = useState<Set<string>>(() =>
    parseBridgeConnectors((labCase as any).bridgeConnectors ?? null),
  );

  const { data, isLoading } = useQuery({
    queryKey: ["case", labCase.id],
    queryFn: () => apiFetch<DetailedCase>(`/cases/${labCase.id}`),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  type RemakeChainEntry = {
    id: string;
    caseNumber: string;
    status: string | null;
    remakeReason: string | null;
    remakeCharged: boolean | null;
    createdAt: string | null;
  };
  const inRemakeChain =
    !!(data?.remakeOriginal) || (data?.remakeChildren?.length ?? 0) > 0;
  const remakeChainQuery = useQuery({
    queryKey: ["case-remake-chain", labCase.id],
    queryFn: () =>
      apiFetch<{ chain: RemakeChainEntry[] }>(`/cases/${labCase.id}/remake-chain`),
    enabled: inRemakeChain,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const remakeChain = remakeChainQuery.data?.chain ?? [];

  // When the drawer is reused for a different case, remove the previous
  // case's chain from the cache so stale data never bleeds across.
  useEffect(() => {
    return () => {
      qc.removeQueries({ queryKey: ["case-remake-chain", labCase.id] });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labCase.id]);

  const drawerOrgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
  });
  const drawerProviderOrgs = useMemo(
    () => (drawerOrgsQuery.data ?? []).filter((o) => o.type !== "lab"),
    [drawerOrgsQuery.data],
  );
  const currentProviderOrg = useMemo(() => {
    const pid = data?.providerOrganizationId ?? labCase.providerOrganizationId;
    if (!pid) return null;
    return drawerProviderOrgs.find((o) => o.id === pid) ?? null;
  }, [drawerProviderOrgs, data?.providerOrganizationId, labCase.providerOrganizationId]);

  // Doctor-name suggestions for the lab-slip picker. The cases LIST view passes
  // a precomputed `doctorNames` list, but other entry points (e.g. the
  // dashboard) render this drawer without one — leaving the picker showing
  // "No doctors found." Self-fetch the lab's cases and derive distinct doctor
  // names as a fallback, mirroring the invoice editor. Only runs when the
  // parent didn't supply names, so the cases page pays no extra request.
  const selfDoctorCasesQuery = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
    staleTime: 60_000,
    enabled: doctorNames.length === 0,
  });
  const effectiveDoctorNames = useMemo(() => {
    if (doctorNames.length > 0) return doctorNames;
    const names = new Set<string>();
    for (const c of selfDoctorCasesQuery.data ?? []) {
      if (c.doctorName?.trim()) names.add(c.doctorName.trim());
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [doctorNames, selfDoctorCasesQuery.data]);
  const [aiPracticePickerOpen, setAiPracticePickerOpen] = useState(false);
  const [aiPracticeError, setAiPracticeError] = useState<string | null>(null);
  const changeAiPracticeMutation = useMutation({
    mutationFn: (providerOrganizationId: string) =>
      apiFetch(`/cases/${labCase.id}`, {
        method: "PATCH",
        body: JSON.stringify({ providerOrganizationId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      setAiPracticePickerOpen(false);
      setAiPracticeError(null);
    },
    onError: (e: Error) => setAiPracticeError(e.message),
  });

  const invoiceQuery = useQuery({
    queryKey: ["invoice-for-case", labCase.id],
    queryFn: () =>
      apiFetch<Invoice[]>(`/invoices?caseId=${encodeURIComponent(labCase.id)}`),
  });
  const caseInvoice = invoiceQuery.data?.[0] ?? null;

  // Pull the full invoice payload (with line items) when one exists so the
  // Print Invoice button has data to render. Cheap query — only runs while
  // the drawer is open and an invoice is present.
  const invoiceDetailQuery = useQuery({
    queryKey: ["invoice-detail", caseInvoice?.id],
    enabled: !!caseInvoice?.id,
    queryFn: () =>
      apiFetch<
        Invoice & {
          items: Array<{
            description: string;
            quantity: number | string;
            unitPrice: number | string;
            lineTotal: number | string;
          }>;
        }
      >(`/invoices/${caseInvoice!.id}`),
  });

  // Pre-fetch lab logo as a data URL for invoice PDF printing (mirrors
  // the same logic in InvoiceEditor so the output is identical).
  const invoicePlacementActive = !!(user?.practiceLogoplacements?.includes("invoices"));
  useEffect(() => {
    const logoUrl = user?.practiceLogoUrl;
    if (!invoicePlacementActive || !logoUrl) {
      setInvoicePrintLogoDataUrl(null);
      return;
    }
    let cancelled = false;
    fetch(logoUrl)
      .then((r) => r.blob())
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          }),
      )
      .then((dataUrl) => { if (!cancelled) setInvoicePrintLogoDataUrl(dataUrl); })
      .catch(() => { if (!cancelled) setInvoicePrintLogoDataUrl(null); });
    return () => { cancelled = true; };
  }, [invoicePlacementActive, user?.practiceLogoUrl]);

  // Pre-generate a QR code data URL for the invoice PDF print.
  useEffect(() => {
    if (!caseInvoice || !labCase.caseNumber) {
      setInvoicePrintQrDataUrl(null);
      return;
    }
    const qrUrl = `${window.location.origin}/cases/${encodeURIComponent(labCase.caseNumber)}`;
    let cancelled = false;
    QRCodeLib.toDataURL(qrUrl, { margin: 1, width: 120 })
      .then((dataUrl) => { if (!cancelled) setInvoicePrintQrDataUrl(dataUrl); })
      .catch(() => { if (!cancelled) setInvoicePrintQrDataUrl(null); });
    return () => { cancelled = true; };
  }, [caseInvoice?.id, labCase.caseNumber]);

  // Sync connectedPairs from server data when the detail query resolves
  // (bridgeConnectors is not included in the list-level LabCase, only in
  // the detail response).
  useEffect(() => {
    if (data && data.bridgeConnectors !== undefined) {
      setConnectedPairs(
        parseBridgeConnectors(data.bridgeConnectors ?? null),
      );
    }
  }, [data?.bridgeConnectors]);

  // Teeth that already have a restoration line on this case. The tooth
  // chart highlights these so the user can avoid double-billing.
  // Includes pending creates and excludes pending deletes.
  const billedTeeth = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.restorations ?? []) {
      if (pendingDeletes.has(r.id)) continue;
      if (r.restorationType === "missing") continue;
      for (const id of parseToothField(r.toothNumber)) set.add(id);
    }
    for (const c of pendingCreates) {
      if (c.restorationType === "missing") continue;
      for (const id of parseToothField(c.toothNumber)) set.add(id);
    }
    return set;
  }, [data?.restorations, pendingDeletes, pendingCreates]);

  // Missing-tooth markers — derived from server data + optimistic add/delete
  // state so the chart updates instantly even before the server round-trip
  // completes.  Missing teeth are auto-saved (not part of pending changes).
  const missingTeethIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.restorations ?? []) {
      if (r.restorationType !== "missing") continue;
      if (pendingDeletes.has(r.id)) continue;
      for (const id of parseToothField(r.toothNumber)) {
        if (!optimisticMissingDeletes.has(id)) set.add(id);
      }
    }
    for (const id of optimisticMissingAdds) set.add(id);
    return set;
  }, [data?.restorations, pendingDeletes, optimisticMissingAdds, optimisticMissingDeletes]);

  // Per-tooth restoration descriptions surfaced in the tooth-chart
  // tooltip so users immediately see what's already on the case.
  const billedTeethTypes = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const r of data?.restorations ?? []) {
      if (pendingDeletes.has(r.id)) continue;
      if (r.restorationType === "missing") continue;
      const materialShade = [r.material, r.shade].filter(Boolean).join(" · ");
      const label = [r.restorationType, materialShade].filter(Boolean).join(" / ");
      for (const id of parseToothField(r.toothNumber)) {
        const list = map.get(id) ?? [];
        if (label) list.push(label);
        map.set(id, list);
      }
    }
    for (const c of pendingCreates) {
      if (c.restorationType === "missing") continue;
      const materialShade = [c.material, c.shade].filter(Boolean).join(" · ");
      const label = [c.restorationType, materialShade].filter(Boolean).join(" / ");
      for (const id of parseToothField(c.toothNumber)) {
        const list = map.get(id) ?? [];
        if (label) list.push(`${label} (unsaved)`);
        map.set(id, list);
      }
    }
    return map;
  }, [data?.restorations, pendingDeletes, pendingCreates]);

  const crownTeeth = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.restorations ?? []) {
      if (pendingDeletes.has(r.id)) continue;
      if (r.restorationType === "missing") continue;
      if (/pontic/i.test(r.restorationType)) continue;
      for (const id of parseToothField(r.toothNumber)) set.add(id);
    }
    for (const c of pendingCreates) {
      if (c.restorationType === "missing") continue;
      if (/pontic/i.test(c.restorationType)) continue;
      for (const id of parseToothField(c.toothNumber)) set.add(id);
    }
    return set;
  }, [data?.restorations, pendingDeletes, pendingCreates]);

  const ponticTeeth = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.restorations ?? []) {
      if (pendingDeletes.has(r.id)) continue;
      if (!/pontic/i.test(r.restorationType)) continue;
      for (const id of parseToothField(r.toothNumber)) set.add(id);
    }
    for (const c of pendingCreates) {
      if (!/pontic/i.test(c.restorationType)) continue;
      for (const id of parseToothField(c.toothNumber)) set.add(id);
    }
    return set;
  }, [data?.restorations, pendingDeletes, pendingCreates]);

  const editMutation = useMutation({
    mutationFn: (updates: typeof editForm) =>
      apiFetch(`/cases/${labCase.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          patientFirstName: updates.patientFirstName,
          patientLastName: updates.patientLastName,
          doctorName: updates.doctorName,
          priority: updates.priority,
          ...(updates.dueDate ? { dueDate: updates.dueDate } : {}),
          casePanBarcode: updates.casePanBarcode || null,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      setEditMode(false);
      setEditError(null);
    },
    onError: (e: Error) => setEditError(e.message),
  });

  const routeMutation = useMutation({
    mutationFn: (status: string) =>
      apiFetch(`/cases/${labCase.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    onSuccess: (_result, status) => {
      const prevBarcode = data?.casePanBarcode ?? labCase.casePanBarcode;
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      setRouteStatus("");
      setRouteError(null);
      const msg =
        status === "complete" && !!prevBarcode
          ? "Case located successfully. Barcode released."
          : "Case located successfully.";
      setRouteSuccessMsg(msg);
      setTimeout(() => setRouteSuccessMsg(null), 3000);
    },
    onError: (e: Error) => setRouteError(e.message),
  });

  const ackAiReviewMutation = useMutation({
    mutationFn: (
      payload?: {
        remake?: {
          remakeOfCaseId: string;
          remakeReason: string;
          remakeCharged: boolean;
        };
      },
    ) =>
      apiFetch(`/cases/${labCase.id}/ai-review`, {
        method: "PATCH",
        body: JSON.stringify({ acknowledged: true, ...(payload ?? {}) }),
      }),
    onSuccess: (_data, payload) => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      qc.invalidateQueries({ queryKey: ["case-remake-chain", labCase.id] });
      if (payload?.remake?.remakeOfCaseId) {
        qc.invalidateQueries({ queryKey: ["case-remake-chain", payload.remake.remakeOfCaseId] });
      }
      setAiDupes(null);
      setAiDupeSelectedId("");
      setAiDupeReason("");
      setAiDupeCharge("");
      setAiDupeError(null);
    },
  });

  const acceptSuggestionMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/cases/${labCase.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          doctorName: data?.suggestedDoctorName,
          ...(data?.suggestedProviderOrgId
            ? {
                providerOrganizationId: data.suggestedProviderOrgId,
                providerLinkSource: "ai_suggestion",
              }
            : {}),
          clearSuggestion: true,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
    },
  });

  const dismissSuggestionMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/cases/${labCase.id}`, {
        method: "PATCH",
        body: JSON.stringify({ clearSuggestion: true }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
    },
  });

  const [aiDupes, setAiDupes] = useState<PatientSimilarityHit[] | null>(null);
  const [aiDupesLoading, setAiDupesLoading] = useState(false);
  const [aiDupeSelectedId, setAiDupeSelectedId] = useState<string>("");
  const [aiDupeReason, setAiDupeReason] = useState("");
  const [aiDupeCharge, setAiDupeCharge] = useState<"yes" | "no" | "">("");
  const [aiDupeError, setAiDupeError] = useState<string | null>(null);

  // Auto-surface possible duplicates the moment a needs-AI-review case is
  // opened, instead of requiring the reviewer to click a separate "Check
  // duplicates" button. Re-runs whenever the case changes or the patient
  // identity in `data` updates from a refetch.
  useEffect(() => {
    if (data?.needsAiReview && aiDupes === null && !aiDupesLoading) {
      void loadAiDuplicateCandidates();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.needsAiReview, data?.id, data?.patientFirstName, data?.patientLastName]);

  async function loadAiDuplicateCandidates() {
    setAiDupesLoading(true);
    setAiDupeError(null);
    try {
      const first = (data?.patientFirstName ?? labCase.patientFirstName ?? "").trim();
      const last = (data?.patientLastName ?? labCase.patientLastName ?? "").trim();
      const labOrgId = data?.labOrganizationId ?? labCase.labOrganizationId;
      const provOrgId = data?.providerOrganizationId ?? labCase.providerOrganizationId;
      if (!first || !last || !labOrgId) {
        setAiDupes([]);
        return;
      }
      const params = new URLSearchParams({
        patientFirstName: first,
        patientLastName: last,
        labOrganizationId: labOrgId,
        ...(provOrgId ? { providerOrganizationId: provOrgId } : {}),
        doctorName: (data?.doctorName ?? labCase.doctorName ?? "").trim(),
      });
      const res = await apiFetch<{ matches: PatientSimilarityHit[] }>(
        `/cases/patient-similarity?${params.toString()}`,
      );
      const filtered = (res.matches ?? []).filter((m) => m.id !== labCase.id);
      setAiDupes(filtered);
      const firstCanonical = filtered.find((m) => m.source === "canonical");
      setAiDupeSelectedId(firstCanonical?.id ?? "");
    } catch (err: any) {
      setAiDupeError(err?.message ?? "Could not load duplicate candidates.");
      setAiDupes([]);
    } finally {
      setAiDupesLoading(false);
    }
  }

  const COMM_PREF_KEY = "labtrax_note_comm_pref_v1";

  const addNoteMutation = useMutation({
    mutationFn: ({ text, shared }: { text: string; shared: boolean }) =>
      apiFetch<{ id: string; visibility: string; noteText: string }>(`/cases/${labCase.id}/notes`, {
        method: "POST",
        body: JSON.stringify({
          noteText: text,
          visibility: shared ? "shared_with_provider" : "internal_lab_only",
        }),
      }),
    onSuccess: (result, variables) => {
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      setNoteText("");
      setShareWithProvider(false);
      setNoteError(null);
      if (variables.shared && result?.id) {
        const savedPref = localStorage.getItem(COMM_PREF_KEY) as "email" | "sms" | null;
        setNotifyModal({
          open: true,
          noteId: result.id,
          method: savedPref ?? null,
          step: "choose",
          sending: false,
          error: null,
        });
      }
    },
    onError: (e: Error) => setNoteError(e.message),
  });

  async function sendNoteNotification(noteId: string, method: "email" | "sms") {
    setNotifyModal((m) => ({ ...m, sending: true, error: null }));
    try {
      await apiFetch(`/cases/${labCase.id}/notes/${noteId}/notify`, {
        method: "POST",
        body: JSON.stringify({ method }),
      });
      const savedPref = localStorage.getItem(COMM_PREF_KEY) as "email" | "sms" | null;
      if (!savedPref) {
        setNotifyModal((m) => ({ ...m, sending: false, method, step: "confirm_save" }));
      } else {
        localStorage.setItem(COMM_PREF_KEY, method);
        setNotifyModal((m) => ({ ...m, sending: false, method, step: "success" }));
      }
    } catch (e: any) {
      setNotifyModal((m) => ({ ...m, sending: false, error: e?.message ?? "Send failed." }));
    }
  }

  const addRestorationMutation = useMutation({
    mutationFn: () => {
      const typeValue =
        restForm.restorationType === "Other"
          ? restForm.customType.trim()
          : restForm.restorationType;
      return apiFetch(`/cases/${labCase.id}/restorations`, {
        method: "POST",
        body: JSON.stringify({
          toothNumber: restForm.toothNumber || "N/A",
          restorationType: typeValue,
          ...(restForm.material ? { material: restForm.material } : {}),
          ...(restForm.shade ? { shade: restForm.shade } : {}),
          quantity: restForm.quantity,
          ...(restForm.unitPrice ? { unitPrice: Number(restForm.unitPrice) } : {}),
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      qc.invalidateQueries({ queryKey: ["cases"] });
      // Server now auto-syncs the invoice from restorations, so refresh
      // the Invoice tab queries too — otherwise the user has to close
      // and re-open the drawer to see the new line item / total.
      qc.invalidateQueries({ queryKey: ["invoice-for-case", labCase.id] });
      qc.invalidateQueries({ queryKey: ["invoice-detail"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setRestForm({
        toothNumber: "",
        restorationType: "",
        customType: "",
        material: "",
        shade: "",
        quantity: 1,
        unitPrice: "",
      });
      setShowAddRest(false);
      setRestError(null);
    },
    onError: (e: Error) => setRestError(e.message),
  });

  async function invalidateAfterRestorationChange() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["case", labCase.id] }),
      qc.invalidateQueries({ queryKey: ["cases"] }),
      qc.invalidateQueries({ queryKey: ["invoice-for-case", labCase.id] }),
      qc.invalidateQueries({ queryKey: ["invoice-detail"] }),
      qc.invalidateQueries({ queryKey: ["invoices"] }),
    ]);
  }

  // Auto-save mutation for marking/unmarking a tooth as missing.
  // Missing-tooth state is persisted immediately (not queued in pending changes)
  // so the chart reflects reality for every user who opens the case next.
  const saveMissingMutation = useMutation({
    mutationFn: async (payload:
      | { kind: "add"; toothId: string }
      | { kind: "remove"; toothId: string; restorationId: string }
    ) => {
      if (payload.kind === "add") {
        await apiFetch(`/cases/${labCase.id}/restorations`, {
          method: "POST",
          body: JSON.stringify({
            toothNumber: payload.toothId,
            restorationType: "missing",
            quantity: 1,
            unitPrice: 0,
          }),
        });
      } else {
        await apiFetch(
          `/cases/${labCase.id}/restorations/${payload.restorationId}`,
          { method: "DELETE" },
        );
      }
      return payload;
    },
    onSuccess: async (payload) => {
      // Await the refetch so data is current before we clear optimistic state,
      // preventing a momentary flicker where the tooth disappears and reappears.
      await invalidateAfterRestorationChange();
      if (payload.kind === "add") {
        setOptimisticMissingAdds((prev) => {
          const next = new Set(prev);
          next.delete(payload.toothId);
          return next;
        });
      } else {
        setOptimisticMissingDeletes((prev) => {
          const next = new Set(prev);
          next.delete(payload.toothId);
          return next;
        });
      }
    },
    onError: (e: Error, payload) => {
      // Roll back optimistic state on error.
      if (payload.kind === "add") {
        setOptimisticMissingAdds((prev) => {
          const next = new Set(prev);
          next.delete(payload.toothId);
          return next;
        });
      } else {
        setOptimisticMissingDeletes((prev) => {
          const next = new Set(prev);
          next.delete(payload.toothId);
          return next;
        });
      }
      setToothDialogError(e.message);
    },
  });

  const saveConnectorsMutation = useMutation({
    mutationFn: (pairs: Set<string>) =>
      apiFetch(`/cases/${labCase.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          bridgeConnectors: formatBridgeConnectors(pairs),
        }),
      }),
    onSuccess: () => {
      invalidateAfterRestorationChange();
    },
  });

  function handleConnectedPairsChange(pairs: Set<string>) {
    setConnectedPairs(pairs);
    saveConnectorsMutation.mutate(pairs);
  }

  // --- Pending changes computed value and handlers ---

  const hasPendingChanges =
    pendingCreates.length > 0 ||
    pendingDeletes.size > 0 ||
    pendingUpdates.length > 0 ||
    pendingCaseEdit !== null;

  function handleDiscardChanges() {
    setPendingCreates([]);
    setPendingDeletes(new Set());
    setPendingUpdates([]);
    setPendingCaseEdit(null);
    setSaveError(null);
    qc.invalidateQueries({ queryKey: ["case", labCase.id] });
  }

  function handleCloseWithGuard() {
    if (hasPendingChanges) {
      setPendingDiscard(() => onClose);
    } else {
      onClose();
    }
  }

  // While the case has unsaved edits, intercept in-app route navigations (the
  // sidebar links, programmatic redirects, etc.) so the user can confirm before
  // losing work, and warn on a native window close/reload via beforeunload.
  useEffect(() => {
    if (!hasPendingChanges) {
      setNavBlocker(null);
      return;
    }
    setNavBlocker((proceed) => {
      setPendingDiscard(() => proceed);
    });
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      setNavBlocker(null);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [hasPendingChanges]);

  async function handleSaveChanges() {
    setIsSaving(true);
    setSaveError(null);

    // Snapshot state at save time so the loop iterates a stable list even
    // as we remove successful items from pending state one-by-one.  This
    // makes retries safe: only items that haven't been saved yet remain in
    // pending state after a partial failure.
    const snapshotCaseEdit = pendingCaseEdit;
    const snapshotDeletes = Array.from(pendingDeletes);
    const snapshotUpdates = [...pendingUpdates];
    const snapshotCreates = [...pendingCreates];

    const invalidateAll = () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      qc.invalidateQueries({ queryKey: ["invoice-for-case", labCase.id] });
      qc.invalidateQueries({ queryKey: ["invoice-detail"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    };

    try {
      // 1. Case detail patch (single atomic call)
      if (snapshotCaseEdit) {
        const patchBody: Record<string, unknown> = {
          patientFirstName: snapshotCaseEdit.patientFirstName,
          patientLastName: snapshotCaseEdit.patientLastName,
          doctorName: snapshotCaseEdit.doctorName,
          priority: snapshotCaseEdit.priority,
          ...(snapshotCaseEdit.dueDate ? { dueDate: snapshotCaseEdit.dueDate } : {}),
          casePanBarcode: snapshotCaseEdit.casePanBarcode || null,
        };
        if (snapshotCaseEdit.providerOrganizationId) {
          patchBody.providerOrganizationId = snapshotCaseEdit.providerOrganizationId;
        }
        await apiFetch(`/cases/${labCase.id}`, {
          method: "PATCH",
          body: JSON.stringify(patchBody),
        });
        setPendingCaseEdit(null);
      }

      // 2. Deletes — remove from pending state immediately after each success
      for (const id of snapshotDeletes) {
        await apiFetch(`/cases/${labCase.id}/restorations/${id}`, { method: "DELETE" });
        setPendingDeletes((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }

      // 3. Updates (replace_tooth) — remove from pending state after each success
      for (const upd of snapshotUpdates) {
        await apiFetch(`/cases/${labCase.id}/restorations/${upd.restorationId}`, {
          method: "PATCH",
          body: JSON.stringify({
            toothNumber: upd.newToothNumber,
            ...(upd.material ? { material: upd.material } : {}),
            ...(upd.shade ? { shade: upd.shade } : {}),
          }),
        });
        setPendingUpdates((prev) =>
          prev.filter((u) => u.restorationId !== upd.restorationId),
        );
      }

      // 4. Creates — remove from pending state after each success so a retry
      //    cannot POST the same restoration twice.
      for (const c of snapshotCreates) {
        await apiFetch(`/cases/${labCase.id}/restorations`, {
          method: "POST",
          body: JSON.stringify({
            toothNumber: c.toothNumber,
            restorationType: c.restorationType,
            ...(c.material ? { material: c.material } : {}),
            ...(c.shade ? { shade: c.shade } : {}),
            quantity: c.quantity,
            ...(c.unitPrice ? { unitPrice: Number(c.unitPrice) } : {}),
          }),
        });
        setPendingCreates((prev) => prev.filter((p) => p.localId !== c.localId));
      }

      invalidateAll();
    } catch (e: any) {
      setSaveError(e?.message ?? "Failed to save changes. Please try again.");
      // Refetch server state so the list reflects what was already saved
      // before the failure.  Remaining pending items are safe to retry.
      invalidateAll();
    } finally {
      setIsSaving(false);
    }
  }

  function handleToothDialogStage(payload: ToothActionPayload) {
    if (payload.kind === "add_crown") {
      const localId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setPendingCreates((prev) => [
        ...prev,
        {
          localId,
          toothNumber: payload.toothId,
          restorationType: payload.restorationType,
          material: payload.material,
          shade: payload.shade ?? "",
          quantity: 1,
          unitPrice: lookupBillablePrice(payload.restorationType),
        },
      ]);
      setToothDialogId(null);
      setToothDialogError(null);
    } else if (payload.kind === "add_pontic") {
      let inferredMaterial = "";
      const ponticTooth = Number(payload.toothId);
      if (
        Number.isInteger(ponticTooth) &&
        ponticTooth >= 1 &&
        ponticTooth <= 32 &&
        connectedPairs.size > 0
      ) {
        const span = new Set<number>();
        const toVisit: number[] = [ponticTooth];
        while (toVisit.length > 0) {
          const curr = toVisit.pop()!;
          if (span.has(curr)) continue;
          span.add(curr);
          for (const pair of connectedPairs) {
            const [as, bs] = pair.split("-");
            const a = Number(as);
            const b = Number(bs);
            if (a === curr && !span.has(b)) toVisit.push(b);
            if (b === curr && !span.has(a)) toVisit.push(a);
          }
        }
        const abutment = (data?.restorations ?? []).find((r) => {
          const rTooth = Number((r.toothNumber ?? "").trim());
          return span.has(rTooth) && !/pontic/i.test(r.restorationType) && r.material;
        });
        inferredMaterial = abutment?.material ?? "";
      }
      const localId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setPendingCreates((prev) => [
        ...prev,
        {
          localId,
          toothNumber: payload.toothId,
          restorationType: "Pontic",
          material: inferredMaterial,
          shade: "",
          quantity: 1,
          unitPrice: lookupBillablePrice("Pontic"),
        },
      ]);
      setToothDialogId(null);
      setToothDialogError(null);
    } else if (payload.kind === "mark_missing") {
      // Auto-save missing teeth immediately — no pending-changes save required.
      setOptimisticMissingAdds((prev) => new Set([...prev, payload.toothId]));
      setToothDialogId(null);
      setToothDialogError(null);
      saveMissingMutation.mutate({ kind: "add", toothId: payload.toothId });
    } else if (payload.kind === "remove_restoration") {
      if (payload.restorationId) {
        setPendingDeletes((prev) => {
          const next = new Set(prev);
          next.add(payload.restorationId!);
          return next;
        });
      } else if (missingTeethIds.has(payload.toothId)) {
        // Find the server-saved missing restoration for this tooth and auto-delete it.
        const serverMissingRow = (data?.restorations ?? []).find(
          (r) =>
            r.restorationType === "missing" &&
            parseToothField(r.toothNumber).has(payload.toothId),
        );
        if (serverMissingRow) {
          setOptimisticMissingDeletes((prev) => new Set([...prev, payload.toothId]));
          setToothDialogId(null);
          setToothDialogError(null);
          saveMissingMutation.mutate({
            kind: "remove",
            toothId: payload.toothId,
            restorationId: serverMissingRow.id,
          });
          return;
        } else if (optimisticMissingAdds.has(payload.toothId)) {
          // Still in-flight add — cancel the optimistic add.
          setOptimisticMissingAdds((prev) => {
            const next = new Set(prev);
            next.delete(payload.toothId);
            return next;
          });
          setToothDialogId(null);
          setToothDialogError(null);
          return;
        }
      } else {
        setPendingCreates((prev) =>
          prev.filter((c) => {
            const teeth = parseToothField(c.toothNumber);
            return !teeth.has(payload.toothId);
          }),
        );
      }
      setToothDialogId(null);
      setToothDialogError(null);
    } else if (payload.kind === "replace_tooth") {
      setPendingUpdates((prev) => [
        ...prev,
        {
          restorationId: payload.restorationId,
          newToothNumber: payload.newToothNumber,
          material: payload.material,
          shade: payload.shade,
        },
      ]);
      setToothDialogId(null);
      setToothDialogError(null);
    }
  }

  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteCaseMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/cases/${labCase.id}`, { method: "DELETE" }),
    onMutate: () => setDeleteError(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      setConfirmDeleteCase(false);
      onClose();
    },
    onError: (e: Error) => {
      setDeleteError(e?.message || "Could not delete case.");
    },
  });

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setUploadingFile(true);
    setUploadError(null);
    const errors: string[] = [];
    for (const file of files) {
      try {
        // Files >~20 MB are routed through the resumable chunked pipeline so
        // the Replit reverse proxy never silently drops them.
        const { url } = await uploadMediaFile(file);
        await apiFetch(`/cases/${labCase.id}/attachments`, {
          method: "POST",
          body: JSON.stringify({
            storageKey: url,
            fileName: file.name,
            fileType: file.type || "application/octet-stream",
          }),
        });
      } catch (err: any) {
        errors.push(`${file.name}: ${err?.message || "Upload failed."}`);
      }
    }
    qc.invalidateQueries({ queryKey: ["case", labCase.id] });
    if (errors.length > 0) setUploadError(errors.join(" · "));
    setUploadingFile(false);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    await uploadFiles(files);
  }

  function handleFileDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    fileDragCounterRef.current += 1;
    if (fileDragCounterRef.current === 1) setFileDragOver(true);
  }

  function handleFileDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    fileDragCounterRef.current -= 1;
    if (fileDragCounterRef.current === 0) setFileDragOver(false);
  }

  function handleFileDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function handleFileDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    fileDragCounterRef.current = 0;
    setFileDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) void uploadFiles(files);
  }

  async function handleGenerateInvoice() {
    setGeneratingInvoice(true);
    setInvError(null);
    try {
      const inv = await apiFetch<Invoice>(
        `/invoices/cases/${labCase.id}/generate-invoice`,
        {
          method: "POST",
          body: JSON.stringify(generatePresetId ? { layoutPresetId: generatePresetId } : {}),
        }
      );
      await invoiceQuery.refetch();
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setViewingInvoice(inv);
    } catch (err: any) {
      setInvError(err?.message || "Could not generate invoice.");
    } finally {
      setGeneratingInvoice(false);
    }
  }

  function startEdit() {
    const src = data ?? labCase;
    setEditForm({
      patientFirstName: src.patientFirstName || "",
      patientLastName: src.patientLastName || "",
      doctorName: src.doctorName || "",
      providerOrganizationId: src.providerOrganizationId || "",
      dueDate: src.dueDate
        ? new Date(src.dueDate).toISOString().split("T")[0]
        : "",
      priority: (src.priority || "normal") as "normal" | "rush",
      casePanBarcode: src.casePanBarcode || "",
    });
    setEditError(null);
    setEditMode(true);
  }

  const isAdmin = !!data?.viewerCanManageAttachments;
  const currentStatus = (data?.status ?? labCase.status) as string;
  const hasRestorations = (data?.restorations?.length ?? 0) > 0;
  const restorationCount = data?.restorations?.length ?? 0;
  const noteCount = data?.notes?.length ?? 0;
  const fileCount = data?.attachments?.length ?? 0;
  const ROUTE_STATUSES = STATUS_FILTERS.filter((s) => s.value !== "all");

  const tabs: Array<{ id: CaseTab; label: string; count?: number }> = [
    { id: "lab-slip", label: "Lab Slip" },
    { id: "restorations", label: "Restorations", count: restorationCount },
    { id: "notes", label: "Notes", count: noteCount },
    { id: "files", label: "Files", count: fileCount },
    { id: "invoice", label: "Invoice" },
    { id: "history", label: "History", count: (data?.events?.length ?? 0) + (data?.originalCaseEvents?.length ?? 0) + (data?.remakeChildrenEvents?.reduce((s, rc) => s + rc.events.length, 0) ?? 0) || undefined },
  ];

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-foreground/30" onClick={handleCloseWithGuard} />
      <aside className="w-full max-w-[700px] bg-card border-l border-border h-full flex flex-col shadow-2xl">
        {/* Header */}
        <header className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <div className="min-w-0">
            {(() => {
              const firstName = data?.patientFirstName ?? labCase.patientFirstName;
              const lastName = data?.patientLastName ?? labCase.patientLastName;
              const patientName =
                [firstName, lastName].filter(Boolean).join(" ") ||
                (data?.patientInitials ?? labCase.patientInitials ?? "");
              return patientName ? (
                <div className="text-xl font-bold leading-tight truncate max-w-[420px]">
                  {patientName}
                </div>
              ) : null;
            })()}
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-muted-foreground">Case</span>
              <span className="font-mono text-xs font-semibold text-muted-foreground">
                {labCase.caseNumber}
              </span>
              <StatusBadge status={currentStatus} />
              {(data?.priority ?? labCase.priority) === "rush" && (
                <span className="text-[10px] font-bold uppercase tracking-wide text-destructive bg-destructive/10 px-1.5 py-0.5 rounded-full">
                  Rush
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() =>
                openAiPanel({
                  caseId: labCase.id,
                  caseNumber: labCase.caseNumber ?? "",
                  patientName: [labCase.patientFirstName, labCase.patientLastName].filter(Boolean).join(" "),
                })
              }
              className="h-8 px-2.5 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary inline-flex items-center gap-1.5 text-xs font-medium transition-colors"
              title="Ask AI about this case"
            >
              <Sparkles size={14} />
              Ask AI
            </button>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setConfirmDeleteCase(true)}
                className="h-8 w-8 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive flex items-center justify-center transition-colors"
                title="Delete case"
              >
                <Trash2 size={15} />
              </button>
            )}
            <button
              type="button"
              onClick={handleCloseWithGuard}
              className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {/* Save / Discard bar — appears whenever there are staged but unsaved changes */}
        {hasPendingChanges && (
          <div className="px-5 py-2.5 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-3 shrink-0">
            <div className="flex-1 min-w-0">
              <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
                Unsaved changes
              </span>
              {saveError && (
                <span className="ml-2 text-xs text-destructive">{saveError}</span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleDiscardChanges}
                disabled={isSaving}
                className="h-7 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => void handleSaveChanges()}
                disabled={isSaving}
                className="h-7 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5 transition-colors"
              >
                {isSaving && <Loader2 size={11} className="animate-spin" />}
                {isSaving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        )}

        {/* Remake link banner: shown both ways — when this case IS a remake of
            an earlier one, and when this case HAS been remade later. */}
        {(data?.remakeOriginal || (data?.remakeChildren?.length ?? 0) > 0) && (
          <div className="px-5 py-3 border-b border-border bg-blue-500/10 flex items-start gap-3 shrink-0">
            <AlertTriangle size={16} className="text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0 space-y-1">
              {data?.remakeOriginal && (
                <div className="text-xs text-blue-700 dark:text-blue-200">
                  <span className="font-semibold">Remake of </span>
                  <button
                    type="button"
                    onClick={() => onOpenCaseId?.(data.remakeOriginal!.id)}
                    className="font-mono underline hover:text-blue-900 dark:hover:text-white"
                  >
                    {data.remakeOriginal.caseNumber}
                  </button>
                  {data.remakeReason && (
                    <span className="text-blue-700/80 dark:text-blue-200/80">
                      {" "}— {data.remakeReason}
                    </span>
                  )}
                  <span className="ml-2 inline-block text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-500/20">
                    {data.remakeCharged === false
                      ? "no charge"
                      : data.remakeCharged === true
                      ? "charged"
                      : "charge unspecified"}
                  </span>
                </div>
              )}
              {(data?.remakeChildren?.length ?? 0) > 0 && (
                <div className="text-xs text-blue-700 dark:text-blue-200">
                  <span className="font-semibold">Remade by </span>
                  {data!.remakeChildren!.map((c, i) => (
                    <span key={c.id}>
                      {i > 0 && ", "}
                      <button
                        type="button"
                        onClick={() => onOpenCaseId?.(c.id)}
                        className="font-mono underline hover:text-blue-900 dark:hover:text-white"
                      >
                        {c.caseNumber}
                      </button>
                      {c.remakeCharged === false && (
                        <span className="text-[10px] uppercase ml-1 text-blue-700/70">
                          (no charge)
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Remake history — collapsible timeline showing every generation */}
        {remakeChain.length >= 2 && (
          <div className="border-b border-border shrink-0">
            <button
              type="button"
              onClick={() => setRemakeChainExpanded((v) => !v)}
              className="w-full flex items-center gap-2 px-5 py-2.5 hover:bg-muted/50 transition-colors"
            >
              <GitBranch size={14} className="text-muted-foreground shrink-0" />
              <span className="flex-1 text-left text-xs font-medium text-foreground">
                Remake history
              </span>
              <span className="text-[10px] text-muted-foreground mr-1">
                {remakeChain.length} generation{remakeChain.length !== 1 ? "s" : ""}
              </span>
              {remakeChainExpanded ? (
                <ChevronUp size={13} className="text-muted-foreground shrink-0" />
              ) : (
                <ChevronDown size={13} className="text-muted-foreground shrink-0" />
              )}
            </button>
            {remakeChainExpanded && (
              <div className="px-5 pb-3 space-y-1.5">
                {remakeChain.map((entry, idx) => {
                  const isCurrent = entry.id === labCase.id;
                  const genLabel = String.fromCharCode(65 + idx);
                  return (
                    <div
                      key={entry.id}
                      className={[
                        "flex items-start gap-2.5 rounded-md px-2.5 py-2 transition-colors",
                        isCurrent
                          ? "bg-primary/10"
                          : "hover:bg-muted/50 cursor-pointer",
                      ].join(" ")}
                      onClick={() => {
                        if (!isCurrent && onOpenCaseId) onOpenCaseId(entry.id);
                      }}
                      role={isCurrent ? undefined : "button"}
                      tabIndex={isCurrent ? undefined : 0}
                      onKeyDown={(e) => {
                        if (!isCurrent && onOpenCaseId && (e.key === "Enter" || e.key === " ")) {
                          e.preventDefault();
                          onOpenCaseId(entry.id);
                        }
                      }}
                    >
                      <span
                        className={[
                          "flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold shrink-0 mt-0.5",
                          isCurrent
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground",
                        ].join(" ")}
                      >
                        {genLabel}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs font-medium text-foreground">
                            {entry.caseNumber}
                          </span>
                          {entry.status && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground capitalize">
                              {statusLabel(entry.status)}
                            </span>
                          )}
                          {isCurrent && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary font-medium">
                              Current
                            </span>
                          )}
                        </div>
                        {(entry.remakeReason || idx > 0) && (
                          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                            {entry.remakeReason && (
                              <span className="text-[11px] text-muted-foreground truncate">
                                {entry.remakeReason}
                              </span>
                            )}
                            {idx > 0 && (
                              <span className="inline-block text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-500/20 shrink-0">
                                {entry.remakeCharged === false
                                  ? "no charge"
                                  : entry.remakeCharged === true
                                  ? "charged"
                                  : "charge unspecified"}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* AI-import review banner */}
        {data?.needsAiReview && (
          <div className="px-5 py-3 border-b border-border bg-amber-500/10 shrink-0">
            <div className="flex items-start gap-3">
              <Sparkles size={16} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                  AI-imported — needs review
                </div>
                <div className="text-xs text-amber-700/80 dark:text-amber-200/80 mt-0.5">
                  This case was auto-created from {data.aiImportSource ?? "an external source"}. Please verify patient, doctor, restorations, and the attached Rx before routing.
                </div>
                <div className="text-xs text-amber-700/90 dark:text-amber-200/90 mt-1.5 flex items-center gap-2 flex-wrap">
                  <span>
                    Practice:{" "}
                    <span className="font-medium">
                      {currentProviderOrg
                        ? currentProviderOrg.displayName || currentProviderOrg.name
                        : "No practice"}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setAiPracticePickerOpen((v) => !v);
                      setAiPracticeError(null);
                    }}
                    className="underline hover:text-amber-900 dark:hover:text-amber-100"
                  >
                    {aiPracticePickerOpen ? "Cancel" : "Change practice"}
                  </button>
                </div>
                {aiPracticePickerOpen && (
                  <div className="mt-2 max-w-xs">
                    <ProviderPicker
                      value={
                        data.providerOrganizationId ??
                        labCase.providerOrganizationId ??
                        ""
                      }
                      providers={drawerProviderOrgs}
                      onChange={(id) => {
                        if (id) changeAiPracticeMutation.mutate(id);
                      }}
                      disabled={changeAiPracticeMutation.isPending}
                    />
                    {aiPracticeError && (
                      <div className="text-xs text-red-600 dark:text-red-400 mt-1">
                        {aiPracticeError}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={loadAiDuplicateCandidates}
                disabled={aiDupesLoading || ackAiReviewMutation.isPending}
                className="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-800 dark:text-amber-200 text-xs font-medium disabled:opacity-60"
              >
                {aiDupesLoading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                Check duplicates
              </button>
              <button
                type="button"
                onClick={() => ackAiReviewMutation.mutate(undefined)}
                disabled={ackAiReviewMutation.isPending}
                className="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium disabled:opacity-60"
              >
                {ackAiReviewMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                Mark as reviewed
              </button>
            </div>

            {/* "Did you mean?" doctor suggestion banner */}
            {data.suggestedDoctorName && (
              <div className="mt-3 ml-7 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 flex items-start gap-2.5">
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-amber-700 dark:text-amber-300">
                    Did you mean{" "}
                    <span className="font-bold">{data.suggestedDoctorName}</span>
                    {data.suggestedPracticeName ? (
                      <span className="font-normal"> at {data.suggestedPracticeName}</span>
                    ) : null}
                    ?
                  </div>
                  <div className="text-[11px] text-amber-700/70 dark:text-amber-200/60 mt-0.5">
                    The AI extracted a name that closely matches an existing doctor. Select the correct one below.
                  </div>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => acceptSuggestionMutation.mutate()}
                    disabled={acceptSuggestionMutation.isPending || dismissSuggestionMutation.isPending}
                    className="inline-flex items-center gap-1 h-7 px-2.5 rounded bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium disabled:opacity-60"
                  >
                    {acceptSuggestionMutation.isPending ? <Loader2 size={11} className="animate-spin" /> : null}
                    Use this doctor
                  </button>
                  <button
                    type="button"
                    onClick={() => dismissSuggestionMutation.mutate()}
                    disabled={acceptSuggestionMutation.isPending || dismissSuggestionMutation.isPending}
                    className="inline-flex items-center h-7 px-2.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-800 dark:text-amber-200 text-xs font-medium disabled:opacity-60"
                  >
                    Keep as-is
                  </button>
                </div>
              </div>
            )}

            {aiDupes && (
              <div className="mt-3 ml-7 rounded-md border border-amber-500/30 bg-card p-3 space-y-3">
                {aiDupes.length === 0 ? (
                  <div className="text-xs text-muted-foreground">
                    No prior cases found for this patient — safe to mark as reviewed.
                  </div>
                ) : (
                  <>
                    <div className="text-xs font-semibold text-foreground">
                      Found {aiDupes.length} possible duplicate{aiDupes.length === 1 ? "" : "s"}. If this is a remake, link it to the original below before marking reviewed.
                    </div>
                    <div className="border border-border rounded overflow-hidden">
                      <table className="w-full text-xs">
                        <thead className="bg-secondary/50">
                          <tr>
                            <th className="text-left px-2 py-1 w-8"></th>
                            <th className="text-left px-2 py-1">Case #</th>
                            <th className="text-left px-2 py-1">Patient</th>
                            <th className="text-left px-2 py-1">Created</th>
                            <th className="text-left px-2 py-1">Teeth</th>
                            <th className="text-left px-2 py-1">Type</th>
                            <th className="text-left px-2 py-1">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {aiDupes.map((m) => {
                            const isLegacy = m.source === "legacy";
                            return (
                              <tr
                                key={`${m.source}:${m.id}`}
                                onClick={() => {
                                  setAiDupeSelectedId(m.id);
                                  setAiDupeError(null);
                                }}
                                className={`border-t border-border cursor-pointer hover:bg-secondary/40 ${
                                  aiDupeSelectedId === m.id ? "bg-primary/10" : ""
                                }`}
                              >
                                <td className="px-2 py-1">
                                  <input
                                    type="radio"
                                    name="ai-dup"
                                    checked={aiDupeSelectedId === m.id}
                                    onChange={() => setAiDupeSelectedId(m.id)}
                                  />
                                </td>
                                <td className="px-2 py-1 font-mono">{m.caseNumber}</td>
                                <td className="px-2 py-1">
                                  {m.patientFirstName} {m.patientLastName}
                                  {m.matchKind !== "exact" && (
                                    <span className="ml-1 text-[10px] uppercase text-muted-foreground">
                                      ({m.matchKind})
                                    </span>
                                  )}
                                </td>
                                <td className="px-2 py-1 text-muted-foreground">
                                  {m.createdAt ? formatDate(m.createdAt) : "—"}
                                </td>
                                <td className="px-2 py-1">{m.toothNumbers || "—"}</td>
                                <td className="px-2 py-1">{m.restorationTypes || "—"}</td>
                                <td className="px-2 py-1">
                                  <StatusBadge status={m.status as any} />
                                  {isLegacy && (
                                    <span className="ml-1 text-[10px] text-muted-foreground">mobile</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                        Remake reason (required to link)
                      </label>
                      <textarea
                        rows={2}
                        className="w-full px-2 py-1.5 rounded bg-secondary text-xs border border-transparent focus:outline-none focus:ring-1 focus:ring-primary"
                        value={aiDupeReason}
                        onChange={(e) => { setAiDupeReason(e.target.value); setAiDupeError(null); }}
                        placeholder="e.g. Doctor flagged shade as too dark; remake at A2."
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-muted-foreground mb-1">
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
                            onClick={() => { setAiDupeCharge(opt.v); setAiDupeError(null); }}
                            className={`flex-1 h-8 rounded text-xs font-medium transition-colors ${
                              aiDupeCharge === opt.v
                                ? opt.v === "no"
                                  ? "bg-amber-500/15 text-amber-700 border border-amber-500/40"
                                  : "bg-primary/10 text-primary border border-primary/30"
                                : "bg-secondary text-muted-foreground border border-transparent hover:bg-secondary/80"
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    {aiDupeError && (
                      <p className="text-xs text-destructive bg-destructive/10 px-2 py-1.5 rounded">
                        {aiDupeError}
                      </p>
                    )}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setAiDupes(null)}
                        className="h-7 px-2.5 rounded bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground"
                      >
                        Close
                      </button>
                      <button
                        type="button"
                        disabled={ackAiReviewMutation.isPending}
                        onClick={() => {
                          if (!aiDupeSelectedId) {
                            setAiDupeError("Pick the prior case being remade.");
                            return;
                          }
                          if (!aiDupeReason.trim()) {
                            setAiDupeError("Reason is required to link as remake.");
                            return;
                          }
                          if (aiDupeCharge === "") {
                            setAiDupeError("Choose whether to charge for this remake.");
                            return;
                          }
                          ackAiReviewMutation.mutate({
                            remake: {
                              remakeOfCaseId: aiDupeSelectedId,
                              remakeReason: aiDupeReason.trim(),
                              remakeCharged: aiDupeCharge === "yes",
                            },
                          });
                        }}
                        className="h-7 px-2.5 rounded bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
                      >
                        {ackAiReviewMutation.isPending && <Loader2 size={11} className="animate-spin" />}
                        Link as remake & mark reviewed
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tab navigation */}
        <nav className="flex border-b border-border px-2 shrink-0 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`px-3.5 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors flex items-center gap-1.5 ${
                activeTab === tab.id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
              {tab.count != null && tab.count > 0 && (
                <span
                  className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none ${
                    activeTab === tab.id
                      ? "bg-primary/15 text-primary"
                      : "bg-secondary text-muted-foreground"
                  }`}
                >
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">

          {/* ── OVERVIEW ── */}
          {activeTab === "lab-slip" && (() => {
            const summary = deriveRxSummary(data?.restorations);
            const overviewNotes = data?.notes ?? [];
            const latestNote = [...overviewNotes].sort((a, b) => {
              const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
              const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
              return tb - ta;
            })[0];
            const latestNoteText = latestNote?.noteText ?? "";
            const notesPreview = latestNoteText
              ? (latestNoteText.length > 120 ? latestNoteText.slice(0, 120) + "…" : latestNoteText)
              : "No notes";
            const toothLabel = formatRxTeethLabel(summary) || "—";
            const shadeLabel = summary.shades.length > 0 ? summary.shades.join(", ") : "—";
            return (
            <div className="px-5 py-5 space-y-6">
              {!data?.viewerIsLabMember && data?.statusHistory && data.statusHistory.length > 0 && (
                <section>
                  <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-3">
                    Progress
                  </h3>
                  <CaseTimelineBar
                    statusHistory={data.statusHistory}
                    currentStatus={currentStatus}
                  />
                </section>
              )}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                    {editMode ? "Edit Case Details" : "Case Details"}
                  </h3>
                  <div className="flex items-center gap-2">
                    {pendingCaseEdit !== null && !editMode && (
                      <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                        Staged
                      </span>
                    )}
                    {!isDefaultLayout(printLayout) && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                        Customized
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowPrintLayoutEditor(true)}
                      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      title="Customize print layout"
                    >
                      <Settings2 size={11} />
                      Layout
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const advTemplate = advancedTemplateQuery.data;
                        if (advTemplate?.isCustom) {
                          printCaseCardAdvanced(
                            data ?? labCase,
                            {
                              restorations: data?.restorations ?? [],
                            },
                            advTemplate.template,
                          );
                        } else {
                          printCaseOverview(
                            data ?? labCase,
                            {
                              restorations: data?.restorations ?? [],
                              notes: data?.notes ?? [],
                            },
                            printLayout,
                          );
                        }
                      }}
                      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      title={hasAdvancedTemplate ? "Print using advanced layout" : "Print lab slip"}
                    >
                      <Printer size={11} />
                      Print
                    </button>
                    {!editMode && (
                      <button
                        type="button"
                        onClick={startEdit}
                        className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <Pencil size={11} /> Edit
                      </button>
                    )}
                  </div>
                </div>
                {!editMode ? (
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Patient</div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span className="text-sm break-words">
                          {`${pendingCaseEdit?.patientFirstName ?? data?.patientFirstName ?? labCase.patientFirstName} ${pendingCaseEdit?.patientLastName ?? data?.patientLastName ?? labCase.patientLastName}`.trim() || "—"}
                        </span>
                        <button
                          type="button"
                          onClick={() => setRxPreviewOpen(true)}
                          className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-medium text-primary/80 hover:text-primary hover:bg-primary/10 transition-colors shrink-0"
                          title="Preview prescription"
                        >
                          <ScrollText size={10} />
                          Preview Rx
                        </button>
                      </div>
                    </div>
                    <Field label="Doctor" value={pendingCaseEdit?.doctorName ?? data?.doctorName ?? labCase.doctorName} />
                    <Field label="Practice" value={(() => {
                      const pid = pendingCaseEdit?.providerOrganizationId ?? data?.providerOrganizationId ?? labCase.providerOrganizationId;
                      if (!pid) return "—";
                      const org = drawerProviderOrgs.find((o) => o.id === pid);
                      return org?.displayName ?? org?.name ?? "—";
                    })()} />
                    <Field label="Status" value={statusLabel(currentStatus)} />
                    <Field
                      label="Priority"
                      value={(pendingCaseEdit?.priority ?? data?.priority ?? labCase.priority) === "rush" ? "Rush" : "Normal"}
                    />
                    <Field label="Due date" value={formatDate(pendingCaseEdit?.dueDate ?? data?.dueDate ?? labCase.dueDate)} />
                    <Field label="Created" value={formatDate(data?.createdAt ?? labCase.createdAt)} />
                    <Field label="Tooth #" value={toothLabel} />
                    <Field label="Shade" value={shadeLabel} />
                    <div className="col-span-2">
                      <Field label="Notes" value={notesPreview} />
                    </div>
                    <div className="col-span-2">
                      <Field
                        label="Case pan barcode"
                        value={data?.casePanBarcode ?? labCase.casePanBarcode ?? "—"}
                      />
                    </div>
                  </div>
                ) : (
                  <div
                    className="space-y-3"
                    onPointerDownCapture={(e) => {
                      const tag = (e.target as HTMLElement).tagName;
                      if (!["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A"].includes(tag)) {
                        setTimeout(() => barcodeScanInputRef.current?.focus(), 0);
                      }
                    }}
                  >
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                          First Name
                        </label>
                        <input
                          value={editForm.patientFirstName}
                          onChange={(e) => {
                            setEditForm((f) => ({ ...f, patientFirstName: e.target.value }));
                            setEditError(null);
                          }}
                          className="mt-1 w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                          Last Name
                        </label>
                        <input
                          list="edit-patient-last-names"
                          value={editForm.patientLastName}
                          onChange={(e) => {
                            setEditForm((f) => ({ ...f, patientLastName: e.target.value }));
                            setEditError(null);
                          }}
                          className="mt-1 w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                        />
                        <datalist id="edit-patient-last-names">
                          {patientLastNames.map((n) => (
                            <option key={n} value={n} />
                          ))}
                        </datalist>
                      </div>
                    </div>
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Practice
                      </label>
                      <div className="mt-1">
                        <ProviderPicker
                          value={editForm.providerOrganizationId}
                          providers={drawerProviderOrgs}
                          onChange={(id, org) => {
                            setEditForm((f) => ({
                              ...f,
                              providerOrganizationId: id,
                              doctorName: org?.displayName || org?.name || f.doctorName,
                            }));
                            setEditError(null);
                          }}
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Doctor name
                      </label>
                      <div className="mt-1">
                        <DoctorNamePicker
                          value={editForm.doctorName}
                          onChange={(name) => {
                            setEditForm((f) => ({ ...f, doctorName: name }));
                            setEditError(null);
                          }}
                          doctorNames={effectiveDoctorNames}
                          placeholder="Select doctor…"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Due Date
                      </label>
                      <input
                        type="date"
                        value={editForm.dueDate}
                        onChange={(e) => {
                          setEditForm((f) => ({ ...f, dueDate: e.target.value }));
                          setEditError(null);
                        }}
                        className="mt-1 w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Priority
                      </label>
                      <select
                        value={editForm.priority}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            priority: e.target.value as "normal" | "rush",
                          }))
                        }
                        className="mt-1 w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                      >
                        <option value="normal">Normal</option>
                        <option value="rush">Rush</option>
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Case Pan Barcode
                      </label>
                      <div className="relative mt-1">
                        <Barcode
                          size={15}
                          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                        />
                        <input
                          ref={barcodeScanInputRef}
                          value={editForm.casePanBarcode}
                          onChange={(e) => {
                            setEditForm((f) => ({ ...f, casePanBarcode: e.target.value }));
                            setEditError(null);
                          }}
                          placeholder="Scan or type a barcode… (leave blank to clear)"
                          className="w-full h-9 pl-8 pr-2.5 rounded-md bg-secondary text-sm font-mono border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Add note
                      </label>
                      <textarea
                        value={editNoteText}
                        onChange={(e) => setEditNoteText(e.target.value)}
                        placeholder="Type a note… (saved immediately as an internal lab note)"
                        rows={3}
                        className="mt-1 w-full px-2.5 py-2 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary resize-none"
                      />
                    </div>
                    {editError && <p className="text-xs text-destructive">{editError}</p>}
                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => { setEditMode(false); setEditError(null); setEditNoteText(""); }}
                        className="flex-1 h-9 rounded-md bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPendingCaseEdit({ ...editForm });
                          if (editNoteText.trim()) {
                            addNoteMutation.mutate({ text: editNoteText.trim(), shared: false });
                            setEditNoteText("");
                          }
                          setEditMode(false);
                          setEditError(null);
                        }}
                        className="flex-1 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 inline-flex items-center justify-center gap-1.5"
                      >
                        Save changes
                      </button>
                    </div>
                  </div>
                )}
              </section>

              {/* Rx summary — at-a-glance view of what the lab is being asked
                  to make, derived from the case's restorations. Editing of
                  restorations and notes still happens in their dedicated
                  tabs; this section is read-only. */}
              {(() => {
                const highlightValue = buildHighlightedToothValue(summary);
                return (
                  <section>
                    <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-3">
                      Rx Summary
                    </h3>
                    {(
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-4 text-sm">
                          <Field
                            label="Restorative type"
                            value={summary.restorativeType ?? "Other"}
                          />
                          <Field
                            label={
                              summary.materials.length > 1
                                ? "Materials"
                                : "Material"
                            }
                            value={(() => {
                              const mat =
                                summary.materials.length > 0
                                  ? summary.materials.join(", ")
                                  : "—";
                              const shade =
                                summary.shades.length > 0
                                  ? summary.shades.join(", ")
                                  : "";
                              return shade ? `${mat} · ${shade}` : mat;
                            })()}
                          />

                          <div className="col-span-2">
                            <Field
                              label={
                                summary.isFullArch
                                  ? "Tooth coverage"
                                  : "Tooth number(s)"
                              }
                              value={formatRxTeethWithShades(
                                data?.restorations,
                                formatRxTeethLabel(summary),
                              )}
                            />
                          </div>
                          <div className="col-span-2">
                            <Field
                              label="Rx notes"
                              value={(data?.caseNotes ?? labCase.caseNotes ?? "").trim() || "—"}
                            />
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                            Notes
                          </div>
                          {(data?.notes?.length ?? 0) === 0 ? (
                            <div className="text-sm text-muted-foreground border border-dashed border-border rounded-md px-3 py-2">
                              No notes yet.
                            </div>
                          ) : (
                            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                              {[...(data?.notes ?? [])]
                                .sort((a, b) => {
                                  const ta = a.createdAt
                                    ? new Date(a.createdAt).getTime()
                                    : 0;
                                  const tb = b.createdAt
                                    ? new Date(b.createdAt).getTime()
                                    : 0;
                                  return tb - ta;
                                })
                                .map((n) => (
                                  <div
                                    key={n.id}
                                    className="border border-border rounded-md px-3 py-2 text-sm"
                                  >
                                    <p className="leading-relaxed whitespace-pre-wrap">
                                      {n.noteText || "—"}
                                    </p>
                                    <div className="flex items-center flex-wrap gap-2 mt-1">
                                      {n.visibility === "internal_lab_only" ? (
                                        <span className="inline-flex items-center gap-1 text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
                                          <Lock size={9} /> Lab only
                                        </span>
                                      ) : (
                                        <span className="inline-flex items-center gap-1 text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded bg-secondary text-muted-foreground border border-border">
                                          Shared
                                        </span>
                                      )}
                                      {n.authorName && (
                                        <span className="text-[11px] font-medium text-foreground">
                                          {n.authorName}
                                        </span>
                                      )}
                                      {n.createdAt && (
                                        <span className="text-[11px] text-muted-foreground">
                                          · {relativeTime(n.createdAt)}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>
                        <ToothChart
                          value={[highlightValue, ...Array.from(missingTeethIds)]
                            .filter(Boolean)
                            .join(",")}
                          onChange={() => {}}
                          readOnly
                          showPrimary={false}
                          crownTeeth={crownTeeth}
                          ponticTeeth={ponticTeeth}
                          missingTeeth={missingTeethIds}
                        />
                      </div>
                    )}
                  </section>
                );
              })()}

              {/* Locate Case */}
              <section>
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2">
                  Locate Case
                </h3>
                <div className="flex gap-2">
                  <select
                    value={routeStatus}
                    onChange={(e) => { setRouteStatus(e.target.value); setRouteError(null); }}
                    className="flex-1 h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                  >
                    <option value="">Select station…</option>
                    {ROUTE_STATUSES.map((s) => (
                      <option key={s.value} value={s.value} disabled={s.value === currentStatus}>
                        {s.label}{s.value === currentStatus ? " (current)" : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!routeStatus || routeMutation.isPending}
                    onClick={() => routeMutation.mutate(routeStatus)}
                    className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                  >
                    {routeMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : "Locate"}
                  </button>
                </div>
                {routeError && <p className="mt-1.5 text-xs text-destructive">{routeError}</p>}
                {routeSuccessMsg && (
                  <p className="mt-1.5 text-xs text-green-600">{routeSuccessMsg}</p>
                )}
              </section>

              {/* ── QR code ── */}
              {(() => {
                const caseQrUrl = `${window.location.origin}/cases/${labCase.caseNumber}`;
                return (
                  <section className="border border-border rounded-lg p-4 flex items-start gap-4">
                    <div className="shrink-0 bg-white p-1.5 rounded border border-border">
                      <QRCodeSVG value={caseQrUrl} size={96} level="M" />
                    </div>
                    <div className="flex flex-col gap-2 min-w-0">
                      <div>
                        <div className="text-xs font-medium text-foreground flex items-center gap-1.5">
                          <QrCode size={12} className="text-muted-foreground" />
                          Case QR Code
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                          Scan to open this case in LabTrax. Works with the mobile app or any camera.
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <code className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono truncate max-w-[220px]">
                          {caseQrUrl}
                        </code>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(caseQrUrl).catch(() => {});
                            setQrLinkCopied(true);
                            setTimeout(() => setQrLinkCopied(false), 2000);
                          }}
                          className="h-6 px-2 rounded text-[11px] font-medium inline-flex items-center gap-1 border border-border bg-card hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors shrink-0"
                          title="Copy case link"
                        >
                          {qrLinkCopied ? <Check size={11} className="text-green-600" /> : <Copy size={11} />}
                          {qrLinkCopied ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </div>
                  </section>
                );
              })()}
            </div>
            );
          })()}

          {/* ── RESTORATIONS ── */}
          {activeTab === "restorations" && (
            <div className="px-5 py-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                  Restorations
                </h3>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      printTabContent({
                        labCase: data ?? labCase,
                        tab: "restorations",
                        restorations: data?.restorations ?? [],
                        attachments: data?.attachments ?? [],
                        notes: data?.notes ?? [],
                      })
                    }
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                    title="Print restorations"
                  >
                    <Printer size={12} />
                    Print
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowAddRest((v) => !v); setRestError(null); }}
                    className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Plus size={12} />
                    {showAddRest ? "Cancel" : "Add manually"}
                  </button>
                </div>
              </div>

              {/* Interactive chart — primary entry point for the click-driven workflow */}
              <ToothChart
                value={[...Array.from(billedTeeth), ...Array.from(missingTeethIds)].join(", ")}
                onChange={() => {}}
                billedTeeth={billedTeeth}
                billedTeethTypes={billedTeethTypes}
                onToothClick={(toothId) => {
                  setToothDialogId(toothId);
                  setToothDialogError(null);
                }}
                connectedPairs={connectedPairs}
                onConnectedPairsChange={handleConnectedPairsChange}
                crownTeeth={crownTeeth}
                ponticTeeth={ponticTeeth}
                missingTeeth={missingTeethIds}
              />

              {showAddRest && (
                <div className="border border-border rounded-lg p-4 space-y-3 bg-secondary/20">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    New restoration (manual entry)
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Tooth # / Range
                      </label>
                      <input
                        placeholder="e.g. 14 or 14-16"
                        value={restForm.toothNumber}
                        onChange={(e) => setRestForm((f) => ({ ...f, toothNumber: e.target.value }))}
                        className="mt-1 w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                      <div className="mt-2">
                        <ToothChart
                          value={restForm.toothNumber}
                          onChange={(next) =>
                            setRestForm((f) => ({ ...f, toothNumber: next }))
                          }
                          billedTeeth={billedTeeth}
                          billedTeethTypes={billedTeethTypes}
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Quantity
                      </label>
                      <input
                        type="number"
                        min={1}
                        value={restForm.quantity}
                        onChange={(e) =>
                          setRestForm((f) => ({
                            ...f,
                            quantity: Math.max(1, Number(e.target.value) || 1),
                          }))
                        }
                        className="mt-1 w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                      Restoration Type *
                    </label>
                    <select
                      value={restForm.restorationType}
                      onChange={(e) => {
                        const type = e.target.value;
                        const price = lookupBillablePrice(type);
                        setRestForm((f) => ({
                          ...f,
                          restorationType: type,
                          unitPrice: price || f.unitPrice,
                        }));
                      }}
                      className="mt-1 w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="">Select type…</option>
                      {RESTORATION_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                      {billableItems
                        .filter(
                          (it) =>
                            !RESTORATION_TYPES.some(
                              (rt) => rt.toLowerCase() === it.name.toLowerCase(),
                            ),
                        )
                        .map((it) => (
                          <option key={it.id} value={it.name}>
                            {it.unitPrice != null
                              ? `${it.name} — $${Number(it.unitPrice).toFixed(2)}`
                              : it.name}
                          </option>
                        ))}
                    </select>
                    {restForm.restorationType === "Other" && (
                      <input
                        placeholder="Describe restoration type…"
                        value={restForm.customType}
                        onChange={(e) => setRestForm((f) => ({ ...f, customType: e.target.value }))}
                        className="mt-2 w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Material
                      </label>
                      <select
                        value={restForm.material}
                        onChange={(e) => setRestForm((f) => ({ ...f, material: e.target.value }))}
                        className="mt-1 w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="">Select material…</option>
                        {MATERIALS.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Shade
                      </label>
                      <select
                        value={restForm.shade}
                        onChange={(e) => setRestForm((f) => ({ ...f, shade: e.target.value }))}
                        className="mt-1 w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="">None</option>
                        {SHADES.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                      Unit Price ($) — leave blank to auto-look up from pricing
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      placeholder="Auto"
                      value={restForm.unitPrice}
                      onChange={(e) => setRestForm((f) => ({ ...f, unitPrice: e.target.value }))}
                      className="mt-1 w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  {restError && <p className="text-xs text-destructive">{restError}</p>}
                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => { setShowAddRest(false); setRestError(null); }}
                      className="flex-1 h-8 rounded-md bg-secondary text-xs text-muted-foreground hover:text-foreground font-medium"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const typeValue =
                          restForm.restorationType === "Other"
                            ? restForm.customType.trim()
                            : restForm.restorationType;
                        if (!typeValue) {
                          setRestError("Restoration type is required.");
                          return;
                        }
                        const localId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                        setPendingCreates((prev) => [
                          ...prev,
                          {
                            localId,
                            toothNumber: restForm.toothNumber || "N/A",
                            restorationType: typeValue,
                            material: restForm.material,
                            shade: restForm.shade,
                            quantity: restForm.quantity,
                            unitPrice: restForm.unitPrice,
                          },
                        ]);
                        setRestForm({
                          toothNumber: "",
                          restorationType: "",
                          customType: "",
                          material: "",
                          shade: "",
                          quantity: 1,
                          unitPrice: "",
                        });
                        setShowAddRest(false);
                        setRestError(null);
                      }}
                      className="flex-1 h-8 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 inline-flex items-center justify-center gap-1.5"
                    >
                      Add restoration
                    </button>
                  </div>
                </div>
              )}

              {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
              {!isLoading && restorationCount === 0 && pendingCreates.length === 0 && (
                <div className="text-sm text-muted-foreground">
                  No restorations yet. Use "Add restoration" to add one.
                </div>
              )}
              <div className="space-y-2">
                {data?.restorations?.map((r) => (
                  <RestorationRow
                    key={r.id}
                    restoration={r}
                    caseId={labCase.id}
                    labOrganizationId={labCase.labOrganizationId}
                    isPendingDelete={pendingDeletes.has(r.id)}
                    onPendingDelete={() => {
                      setPendingDeletes((prev) => {
                        const next = new Set(prev);
                        next.add(r.id);
                        return next;
                      });
                    }}
                    onUndoPendingDelete={() => {
                      setPendingDeletes((prev) => {
                        const next = new Set(prev);
                        next.delete(r.id);
                        return next;
                      });
                    }}
                  />
                ))}
                {pendingCreates.map((c) => (
                  <PendingRestorationRow
                    key={c.localId}
                    pending={c}
                    onRemove={() =>
                      setPendingCreates((prev) => prev.filter((p) => p.localId !== c.localId))
                    }
                  />
                ))}
              </div>
            </div>
          )}

          {/* ── NOTES ── */}
          {activeTab === "notes" && (
            <div className="px-5 py-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                  Notes
                </h3>
                <button
                  type="button"
                  onClick={() =>
                    printTabContent({
                      labCase: data ?? labCase,
                      tab: "notes",
                      restorations: data?.restorations ?? [],
                      attachments: data?.attachments ?? [],
                      notes: data?.notes ?? [],
                    })
                  }
                  className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                  title="Print notes"
                >
                  <Printer size={12} />
                  Print
                </button>
              </div>
              {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
              <div className="space-y-2">
                {!isLoading && noteCount === 0 && (
                  <div className="text-sm text-muted-foreground">No notes yet.</div>
                )}
                {data?.notes?.map((n) => (
                  <div key={n.id} className="border border-border rounded-md px-3 py-2.5 text-sm">
                    <p className="leading-relaxed whitespace-pre-wrap">{n.noteText || "—"}</p>
                    <div className="flex items-center flex-wrap gap-2 mt-1.5">
                      {n.visibility === "internal_lab_only" ? (
                        <span className="inline-flex items-center gap-1 text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
                          <Lock size={9} /> Lab only
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded bg-secondary text-muted-foreground border border-border">
                          Shared
                        </span>
                      )}
                      {n.authorName && (
                        <span className="text-[11px] font-medium text-foreground">
                          {n.authorName}
                        </span>
                      )}
                      {n.createdAt && (
                        <span className="text-[11px] text-muted-foreground">
                          · {relativeTime(n.createdAt)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="border border-border rounded-md p-3 space-y-2">
                <textarea
                  value={noteText}
                  onChange={(e) => { setNoteText(e.target.value); setNoteError(null); }}
                  placeholder="Add a note…"
                  rows={3}
                  className="w-full text-sm bg-transparent resize-none focus:outline-none placeholder:text-muted-foreground"
                />
                <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
                  <input
                    type="checkbox"
                    checked={shareWithProvider}
                    onChange={(e) => setShareWithProvider(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-border accent-primary"
                  />
                  <span className="text-xs text-muted-foreground">Share note with provider</span>
                </label>
                <div className="flex items-center justify-end gap-2 pt-1.5 border-t border-border">
                  <button
                    type="button"
                    disabled={!noteText.trim() || addNoteMutation.isPending}
                    onClick={() => addNoteMutation.mutate({ text: noteText, shared: shareWithProvider })}
                    className="h-7 px-3 rounded bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                  >
                    {addNoteMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : "Add note"}
                  </button>
                </div>
                {noteError && <p className="text-xs text-destructive">{noteError}</p>}
              </div>

              {/* ── NOTIFY MODAL ── */}
              {notifyModal.open && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { if (!notifyModal.sending) setNotifyModal((m) => ({ ...m, open: false })); }}>
                  <div className="bg-background border border-border rounded-lg shadow-xl w-full max-w-sm mx-4 p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold">Notify provider?</h3>
                      <button type="button" onClick={() => { if (!notifyModal.sending) setNotifyModal((m) => ({ ...m, open: false })); }} className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Close">
                        <X size={16} />
                      </button>
                    </div>

                    {notifyModal.step === "choose" && notifyModal.method === null && (
                      <div className="space-y-3">
                        <p className="text-xs text-muted-foreground">The note was shared with the provider. How would you like to notify them?</p>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={notifyModal.sending}
                            onClick={() => void sendNoteNotification(notifyModal.noteId, "email")}
                            className="flex-1 h-9 rounded-md border border-border bg-secondary hover:bg-secondary/80 text-sm font-medium transition-colors disabled:opacity-50"
                          >
                            {notifyModal.sending ? <Loader2 size={13} className="animate-spin mx-auto" /> : "Email"}
                          </button>
                          <button
                            type="button"
                            disabled={notifyModal.sending}
                            onClick={() => void sendNoteNotification(notifyModal.noteId, "sms")}
                            className="flex-1 h-9 rounded-md border border-border bg-secondary hover:bg-secondary/80 text-sm font-medium transition-colors disabled:opacity-50"
                          >
                            {notifyModal.sending ? <Loader2 size={13} className="animate-spin mx-auto" /> : "Text message"}
                          </button>
                        </div>
                        {notifyModal.error && <p className="text-xs text-destructive">{notifyModal.error}</p>}
                        <button type="button" onClick={() => setNotifyModal((m) => ({ ...m, open: false }))} className="text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-center">Skip for now</button>
                      </div>
                    )}

                    {notifyModal.step === "choose" && notifyModal.method !== null && (
                      <div className="space-y-3">
                        <p className="text-xs text-muted-foreground">The note was shared with the provider. Send a notification?</p>
                        <button
                          type="button"
                          disabled={notifyModal.sending}
                          onClick={() => void sendNoteNotification(notifyModal.noteId, notifyModal.method!)}
                          className="w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-2"
                        >
                          {notifyModal.sending ? <Loader2 size={13} className="animate-spin" /> : `Send ${notifyModal.method === "email" ? "email" : "text message"}`}
                        </button>
                        {notifyModal.error && <p className="text-xs text-destructive">{notifyModal.error}</p>}
                        <button
                          type="button"
                          onClick={() => {
                            const other: "email" | "sms" = notifyModal.method === "email" ? "sms" : "email";
                            setNotifyModal((m) => ({ ...m, method: other, error: null }));
                          }}
                          className="text-xs text-primary hover:underline w-full text-center"
                        >
                          Communication option: switch to {notifyModal.method === "email" ? "text message" : "email"}
                        </button>
                        <button type="button" onClick={() => setNotifyModal((m) => ({ ...m, open: false }))} className="text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-center">Skip for now</button>
                      </div>
                    )}

                    {notifyModal.step === "confirm_save" && (
                      <div className="space-y-3">
                        <p className="text-xs text-muted-foreground">
                          <Check size={12} className="inline text-green-600 mr-1" />
                          {notifyModal.method === "email" ? "Email sent." : "Text message sent."} Save this as your default notification method?
                        </p>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              localStorage.setItem(COMM_PREF_KEY, notifyModal.method!);
                              setNotifyModal((m) => ({ ...m, open: false }));
                            }}
                            className="flex-1 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                          >
                            Yes
                          </button>
                          <button
                            type="button"
                            onClick={() => setNotifyModal((m) => ({ ...m, open: false }))}
                            className="flex-1 h-9 rounded-md border border-border bg-secondary hover:bg-secondary/80 text-sm font-medium transition-colors"
                          >
                            No
                          </button>
                        </div>
                      </div>
                    )}

                    {notifyModal.step === "success" && (
                      <div className="space-y-3">
                        <p className="text-xs text-muted-foreground">
                          <Check size={12} className="inline text-green-600 mr-1" />
                          {notifyModal.method === "email" ? "Email sent." : "Text message sent."}
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            const other: "email" | "sms" = notifyModal.method === "email" ? "sms" : "email";
                            setNotifyModal((m) => ({ ...m, method: other, step: "choose", error: null }));
                          }}
                          className="text-xs text-primary hover:underline w-full text-center"
                        >
                          Communication option: switch to {notifyModal.method === "email" ? "text message" : "email"}
                        </button>
                        <button type="button" onClick={() => setNotifyModal((m) => ({ ...m, open: false }))} className="w-full h-8 rounded-md border border-border bg-secondary hover:bg-secondary/80 text-sm transition-colors">Close</button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── FILES ── */}
          {activeTab === "files" && (
            <div
              className="relative px-5 py-5 space-y-4"
              onDragEnter={labCase._source !== "mobile" ? handleFileDragEnter : undefined}
              onDragLeave={labCase._source !== "mobile" ? handleFileDragLeave : undefined}
              onDragOver={labCase._source !== "mobile" ? handleFileDragOver : undefined}
              onDrop={labCase._source !== "mobile" ? handleFileDrop : undefined}
            >
              {fileDragOver && labCase._source !== "mobile" && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-primary/8 pointer-events-none">
                  <FileUp size={24} className="text-primary" />
                  <p className="text-sm font-medium text-primary">Drop to attach files</p>
                </div>
              )}
              <div className="flex items-center justify-between">
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                  Attachments
                </h3>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      printTabContent({
                        labCase: data ?? labCase,
                        tab: "files",
                        restorations: data?.restorations ?? [],
                        attachments: data?.attachments ?? [],
                        notes: data?.notes ?? [],
                      })
                    }
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    title="Print file list"
                  >
                    <Printer size={12} />
                    Print
                  </button>
                  {labCase._source !== "mobile" && (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadingFile}
                      className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
                    >
                      {uploadingFile ? <Loader2 size={12} className="animate-spin" /> : <FileUp size={12} />}
                      {uploadingFile ? "Uploading…" : "Attach file"}
                    </button>
                  )}
                </div>
              </div>
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
              {uploadError && <p className="text-xs text-destructive">{uploadError}</p>}
              {labCase._source === "mobile" && (
                <p className="text-xs text-muted-foreground">
                  This case was created in the mobile app. File attachments can be added from the mobile app.
                </p>
              )}
              {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
              {!isLoading && fileCount === 0 && !uploadingFile && labCase._source !== "mobile" && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full flex flex-col items-center justify-center gap-2 py-10 rounded-lg border-2 border-dashed border-muted-foreground/30 hover:border-primary/50 hover:bg-primary/5 transition-colors cursor-pointer text-center"
                >
                  <FileUp size={28} className="text-muted-foreground/50" />
                  <p className="text-sm font-medium text-muted-foreground">Drop files here or click to attach</p>
                  <p className="text-xs text-muted-foreground/60">Any file type supported</p>
                </button>
              )}
              {(() => {
                const images = data?.attachments?.filter((a) => (a.fileType || "").startsWith("image/")) ?? [];
                const videos = data?.attachments?.filter((a) => (a.fileType || "").startsWith("video/")) ?? [];
                const others = data?.attachments?.filter((a) => {
                  const t = a.fileType || "";
                  return !t.startsWith("image/") && !t.startsWith("video/");
                }) ?? [];
                return (
                  <>
                    {images.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-[11px] text-muted-foreground font-medium">
                          Photos & Images ({images.length})
                        </p>
                        {images.map((a) => (
                          <AttachmentRow
                            key={a.id}
                            caseId={labCase.id}
                            attachment={a}
                            canManage={!!data?.viewerCanManageAttachments}
                            onImageClick={(url) => setLightboxUrl(url)}
                          />
                        ))}
                      </div>
                    )}
                    {others.length > 0 && (
                      <div className="space-y-2">
                        {images.length > 0 && (
                          <p className="text-[11px] text-muted-foreground font-medium">
                            Documents & Files ({others.length})
                          </p>
                        )}
                        {others.map((a) => (
                          <AttachmentRow
                            key={a.id}
                            caseId={labCase.id}
                            attachment={a}
                            canManage={!!data?.viewerCanManageAttachments}
                          />
                        ))}
                      </div>
                    )}
                    {videos.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-[11px] text-muted-foreground font-medium">
                          Videos ({videos.length})
                        </p>
                        {videos.map((a) => (
                          <AttachmentRow
                            key={a.id}
                            caseId={labCase.id}
                            attachment={a}
                            canManage={!!data?.viewerCanManageAttachments}
                            onVideoClick={(url, mimeType) => setLightbox({ url, kind: "video", mimeType })}
                          />
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}
              {!isLoading && !!data?.viewerCanManageAttachments && fileCount > 0 && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  onDragEnter={handleFileDragEnter}
                  onDragLeave={handleFileDragLeave}
                  onDragOver={handleFileDragOver}
                  onDrop={handleFileDrop}
                  className={`w-full flex items-center justify-center gap-2 py-3 rounded-lg border-2 border-dashed transition-colors cursor-pointer text-center ${
                    fileDragOver
                      ? "border-primary bg-primary/8 text-primary"
                      : "border-muted-foreground/30 hover:border-primary/50 hover:bg-primary/5 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <FileUp size={14} className={fileDragOver ? "text-primary" : "text-muted-foreground/60"} />
                  <span className="text-xs font-medium">Drop files here or click to browse</span>
                </button>
              )}
            </div>
          )}

          {/* ── INVOICE ── */}
          {activeTab === "invoice" && (
            <div className="px-5 py-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                  Invoice
                </h3>
                {caseInvoice && (
                  <button
                    type="button"
                    onClick={() => {
                      const lc = data ?? labCase;
                      const inv = invoiceDetailQuery.data ?? caseInvoice;
                      const dm = inv.displayMetadata ?? inv.displayMetadataJson;
                      const opts: InvoicePdfOptions = {
                        invoiceNumber: inv.invoiceNumber,
                        labName: inv.labOrganization?.name ?? caseInvoice.labOrganization?.name ?? "",
                        practiceName: inv.providerOrganization?.name ?? caseInvoice.providerOrganization?.name ?? "",
                        patientName: dm?.patientName ?? (`${lc.patientFirstName ?? ""} ${lc.patientLastName ?? ""}`.trim() || null),
                        billTo: dm?.billTo ?? inv.providerOrganization?.name ?? null,
                        teeth: dm?.teeth ?? lc.teeth ?? null,
                        shade: dm?.shade ?? null,
                        caseNotes: dm?.caseNotes ?? lc.caseNotes ?? null,
                        issuedAt: inv.issuedAt ?? null,
                        dueAt: inv.dueDate ?? inv.dueAt ?? null,
                        status: inv.status,
                        items: (invoiceDetailQuery.data?.items ?? []).map((it) => ({
                          description: it.description,
                          quantity: it.quantity,
                          unitPrice: it.unitPrice,
                          lineTotal: it.lineTotal,
                        })),
                        subtotal: inv.subtotal ?? 0,
                        total: inv.total ?? 0,
                        balanceDue: inv.balanceDue ?? null,
                        notes: inv.notes ?? null,
                        generatedAt: new Date(),
                        logoUrl: invoicePrintLogoDataUrl,
                        logoPdfSize: (user?.practiceLogoSize as "small" | "medium" | "large" | null) ?? null,
                        caseNumber: lc.caseNumber ?? null,
                        qrCodeDataUrl: invoicePrintQrDataUrl,
                      };
                      printInvoicePdf(opts);
                    }}
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                    title="Print invoice"
                  >
                    <Printer size={12} />
                    Print
                  </button>
                )}
              </div>
              {invoiceQuery.isLoading ? (
                <div className="text-sm text-muted-foreground flex items-center gap-1.5">
                  <Loader2 size={13} className="animate-spin" />
                  Loading…
                </div>
              ) : caseInvoice ? (
                <div className="border border-border rounded-lg p-4 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold">{caseInvoice.invoiceNumber}</span>
                      <StatusBadge status={caseInvoice.status} />
                    </div>
                    <button
                      type="button"
                      onClick={() => setViewingInvoice(caseInvoice)}
                      className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors inline-flex items-center gap-1.5"
                    >
                      <ReceiptText size={13} />
                      Open in editor
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <Field label="Total" value={formatMoney(caseInvoice.total)} />
                    <Field label="Balance due" value={formatMoney(caseInvoice.balanceDue)} />
                    {caseInvoice.issuedAt && (
                      <Field label="Issued" value={formatDate(caseInvoice.issuedAt)} />
                    )}
                    {caseInvoice.dueDate && (
                      <Field label="Due" value={formatDate(caseInvoice.dueDate)} />
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    No invoice has been generated for this case yet.
                  </p>
                  {generatePresets.length > 0 && (
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground font-medium">
                        Layout preset <span className="font-normal">(optional)</span>
                      </label>
                      <select
                        value={generatePresetId}
                        onChange={(e) => setGeneratePresetId(e.target.value)}
                        disabled={generatingInvoice}
                        className="w-full h-8 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50"
                      >
                        <option value="">Default layout</option>
                        {generatePresets.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <button
                    type="button"
                    disabled={!hasRestorations || generatingInvoice || isLoading}
                    onClick={handleGenerateInvoice}
                    className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-secondary hover:bg-secondary/80 text-sm font-medium disabled:opacity-50 transition-colors"
                  >
                    {generatingInvoice ? <Loader2 size={13} className="animate-spin" /> : <ReceiptText size={14} />}
                    {generatingInvoice ? "Generating…" : "Generate Invoice"}
                  </button>
                  {!isLoading && !hasRestorations && (
                    <p className="text-xs text-muted-foreground">
                      Add restorations in the Restorations tab first — invoices are generated from restoration line items.
                    </p>
                  )}
                  {invError && <p className="text-xs text-destructive">{invError}</p>}
                </div>
              )}
            </div>
          )}

          {/* ── HISTORY ── */}
          {activeTab === "history" && (
            <div className="px-5 py-5">
              {(() => {
                const histSummary = deriveRxSummary(data?.restorations);
                const histPatient = `${data?.patientFirstName ?? labCase.patientFirstName ?? ""} ${data?.patientLastName ?? labCase.patientLastName ?? ""}`.trim();
                const histDoctor = data?.doctorName ?? labCase.doctorName ?? "";
                const histMaterial = histSummary.materials.length > 0 ? histSummary.materials.join(", ") : "—";
                const histShade = histSummary.shades.length > 0 ? histSummary.shades.join(", ") : "—";
                const histTeeth = formatRxTeethWithShades(data?.restorations, formatRxTeethLabel(histSummary)) || "—";
                const histRxNotes = (data?.caseNotes ?? labCase.caseNotes ?? "").trim() || "—";
                return (
                  <section className="mb-5 rounded-lg border border-border bg-secondary/20 px-4 py-3">
                    <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2">
                      Rx Summary
                    </h3>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <Field label="Patient" value={histPatient || "—"} />
                      <Field label="Doctor" value={histDoctor || "—"} />
                      <Field label="Restorative type" value={histSummary.restorativeType ?? "—"} />
                      <Field label={histSummary.materials.length > 1 ? "Materials" : "Material"} value={histMaterial} />
                      <Field label={histSummary.shades.length > 1 ? "Shades" : "Shade"} value={histShade} />
                      <Field label={histSummary.isFullArch ? "Tooth coverage" : "Tooth number(s)"} value={histTeeth} />
                      <div className="col-span-2">
                        <Field label="Rx notes" value={histRxNotes} />
                      </div>
                    </div>
                  </section>
                );
              })()}
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                  Case History
                </h3>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setHistorySortOrder((o) => (o === "asc" ? "desc" : "asc"))
                    }
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                    title={
                      historySortOrder === "asc"
                        ? "Showing oldest first — click for newest first"
                        : "Showing newest first — click for oldest first"
                    }
                  >
                    {historySortOrder === "asc" ? (
                      <ArrowUp size={12} />
                    ) : (
                      <ArrowDown size={12} />
                    )}
                    {historySortOrder === "asc" ? "Oldest first" : "Newest first"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      printCaseHistory(data ?? labCase, [
                        ...(data?.originalCaseEvents ?? []),
                        ...(data?.events ?? []),
                        ...(data?.remakeChildrenEvents?.flatMap((rc) => rc.events) ?? []),
                      ])
                    }
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                    title="Print case history"
                  >
                    <Printer size={12} />
                    Print history
                  </button>
                </div>
              </div>
              {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
              {!isLoading && (data?.events?.length ?? 0) === 0 && (data?.originalCaseEvents?.length ?? 0) === 0 && (data?.remakeChildrenEvents?.every((rc) => rc.events.length === 0) ?? true) && (
                <div className="text-sm text-muted-foreground">No activity logged yet.</div>
              )}
              {(() => {
                const hasOriginalEvents = (data?.originalCaseEvents?.length ?? 0) > 0;

                type TaggedEvent = CaseEvent & { _source: "original" | "remake" | "child"; _sourceCaseNumber?: string };

                const taggedOriginal: TaggedEvent[] = (data?.originalCaseEvents ?? []).map(
                  (e) => ({ ...e, _source: "original" as const }),
                );
                const taggedRemake: TaggedEvent[] = (data?.events ?? []).map(
                  (e) => ({ ...e, _source: "remake" as const }),
                );
                const childEvents: TaggedEvent[] = (data?.remakeChildrenEvents ?? []).flatMap((rc) =>
                  rc.events.map((e) => ({ ...e, _source: "child" as const, _sourceCaseNumber: rc.caseNumber }))
                );

                const allEvents: TaggedEvent[] = [...taggedOriginal, ...taggedRemake, ...childEvents].sort(
                  (a, b) => {
                    const ta = new Date(a.occurredAt || a.createdAt || 0).getTime();
                    const tb = new Date(b.occurredAt || b.createdAt || 0).getTime();
                    return historySortOrder === "asc" ? ta - tb : tb - ta;
                  },
                );

                return (
                  <div>
                    {allEvents.map((e, idx) => {
                      const isLast = idx === allEvents.length - 1;
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
                      const isBackfilledInvoice =
                        eventType === "invoice_generated" && metadata.source === "backfill";
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

                      const isFirstRemake =
                        hasOriginalEvents &&
                        (e._source === "remake" || e._source === "child") &&
                        (idx === 0 || allEvents[idx - 1]?._source === "original");

                      return (
                        <div key={e.id || idx}>
                          {isFirstRemake && (
                            <div className="flex items-center gap-2 my-3">
                              <div className="flex-1 h-px bg-border" />
                              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground px-1 whitespace-nowrap">
                                Case {data?.caseNumber}
                              </span>
                              <div className="flex-1 h-px bg-border" />
                            </div>
                          )}
                          <div className="flex gap-3 pb-5">
                            <div className="flex flex-col items-center shrink-0 mt-0.5">
                              <div
                                className="w-2.5 h-2.5 rounded-full shrink-0"
                                style={{
                                  backgroundColor: dotColor,
                                  opacity: e._source === "original" ? 0.55 : 1,
                                }}
                              />
                              {!isLast && <div className="w-px flex-1 bg-border mt-1.5" />}
                            </div>
                            <div
                              className="flex-1 min-w-0 -mt-0.5"
                              style={{ opacity: e._source === "original" ? 0.7 : 1 }}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="text-sm font-medium flex items-center gap-1.5">
                                  <span>{formatEventType(e.eventType)}</span>
                                  {isBackfilledInvoice && (
                                    <span
                                      title="Generated by the missing-invoice backfill"
                                      className="inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-inset ring-amber-200"
                                    >
                                      Backfilled
                                    </span>
                                  )}
                                  {e._source === "original" && (
                                    <span className="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 ring-1 ring-inset ring-slate-200">
                                      {data?.remakeOriginal?.caseNumber ?? "Original"}
                                    </span>
                                  )}
                                  {e._source === "child" && e._sourceCaseNumber && (
                                    <span className="inline-flex items-center rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 ring-1 ring-inset ring-blue-200">
                                      {e._sourceCaseNumber}
                                    </span>
                                  )}
                                </div>
                                <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
                                  {formatDateTime(e.occurredAt || e.createdAt)}
                                </span>
                              </div>
                              {(e.actorInitials || (metadata.user as string | undefined)) && (
                                <div className="text-xs text-muted-foreground mt-0.5">
                                  {e.actorInitials || String(metadata.user)}
                                </div>
                              )}
                              {isStatus && (e.metadataJson as any)?.fromStatus && (e.metadataJson as any)?.toStatus && (
                                <div className="flex items-center gap-1.5 mt-1">
                                  <StatusBadge status={String((e.metadataJson as any).fromStatus)} />
                                  <span className="text-xs text-muted-foreground">→</span>
                                  <StatusBadge status={String((e.metadataJson as any).toStatus)} />
                                </div>
                              )}
                              {isNote && (e.metadataJson as any)?.visibility && (
                                <div className="text-xs text-muted-foreground mt-0.5">
                                  {(e.metadataJson as any).visibility === "internal_lab_only"
                                    ? "Internal (lab only)"
                                    : "Shared with provider"}
                                </div>
                              )}
                              {isNote && (metadata.noteText || metadata.description) && (
                                <div className="mt-1.5 text-sm bg-secondary/50 border border-border rounded-md px-3 py-2 whitespace-pre-wrap break-words">
                                  {String(metadata.noteText ?? metadata.description)}
                                </div>
                              )}
                              {isAttachment && (() => {
                                const fileType = String(metadata.fileType ?? "");
                                const mediaKind = String(metadata.mediaKind ?? "");
                                const isImg = fileType.startsWith("image/") || mediaKind === "photo";
                                const isVid = fileType.startsWith("video/") || mediaKind === "video";
                                // Prefer the legacy/mobile imageUri (works without auth headers,
                                // including data: URIs) when present. Fall back to the canonical
                                // /file route for desktop-created attachments.
                                const directSrc = metadata.imageUri ? String(metadata.imageUri) : null;
                                const apiSrc = metadata.attachmentId
                                  ? `${getApiOrigin()}/api/cases/${labCase.id}/attachments/${String(metadata.attachmentId)}/file`
                                  : null;
                                const src = directSrc || apiSrc;
                                if (!src) {
                                  return metadata.fileName ? (
                                    <div className="mt-1.5">
                                      <span className="text-xs text-muted-foreground">{String(metadata.fileName)}</span>
                                    </div>
                                  ) : null;
                                }
                                const mime = fileType || (isVid ? "video/mp4" : isImg ? "image/jpeg" : undefined);
                                return (
                                  <div className="mt-1.5">
                                    {isImg ? (
                                      <button
                                        type="button"
                                        onClick={() => setLightbox({ url: src, kind: "image" })}
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
                                        onClick={() => setLightbox({ url: src, kind: "video", mimeType: mime })}
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
                                          <span className="h-7 w-7 rounded-full bg-black/60 text-white flex items-center justify-center text-[10px] font-bold">▶</span>
                                        </span>
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={async () => {
                                          if (src.startsWith("data:") || src.startsWith("blob:")) {
                                            window.open(src, "_blank");
                                            return;
                                          }
                                          try {
                                            const token = getAccessToken();
                                            const sameOrigin = isSameApiOrigin(src);
                                            const resp = await fetch(
                                              src,
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
                                            window.open(src, "_blank");
                                          }
                                        }}
                                        className="inline-flex items-center gap-1.5 text-xs text-primary underline hover:text-primary/80"
                                        title={`Open ${metadata.fileName ?? "file"}`}
                                      >
                                        <Paperclip size={12} />
                                        {String(metadata.fileName ?? "Open file")}
                                      </button>
                                    )}
                                  </div>
                                );
                              })()}
                              {eventType === "remade_by" && metadata.remakeCaseId && (
                                <div className="mt-1">
                                  <button
                                    type="button"
                                    onClick={() => onOpenCaseId?.(String(metadata.remakeCaseId))}
                                    className="text-xs text-blue-600 dark:text-blue-400 underline hover:text-blue-800 dark:hover:text-blue-200 font-mono"
                                  >
                                    {data?.remakeChildren?.find((c) => c.id === metadata.remakeCaseId)?.caseNumber ?? "Open remake →"}
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      </aside>

      {/* Image / Video lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center"
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

      {/* Invoice editor overlay */}
      {viewingInvoice && (
        <InvoiceEditor invoice={viewingInvoice} onClose={() => setViewingInvoice(null)} />
      )}

      {/* Print Layout Editor */}
      {showPrintLayoutEditor && (
        <PrintLayoutEditor
          onClose={() => setShowPrintLayoutEditor(false)}
          config={printLayout}
          onChange={(next) => setPrintLayout(next)}
          hasCustomAdvancedTemplate={hasAdvancedTemplate}
          onOpenAdvanced={() => {
            setShowPrintLayoutEditor(false);
            setShowCaseAdvancedEditor(true);
          }}
        />
      )}

      {/* Advanced (drag & resize) per-lab Print Layout Editor */}
      {showCaseAdvancedEditor && (
        <CasePrintLayoutEditor
          onClose={() => setShowCaseAdvancedEditor(false)}
        />
      )}

      {/* Prescription preview */}
      {rxPreviewOpen && (
        <PrescriptionPreview
          caseId={labCase.id}
          invoiceCaseId={labCase.id}
          onClose={() => setRxPreviewOpen(false)}
        />
      )}

      {/* Delete case confirmation */}
      {confirmDeleteCase && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/40"
          onClick={() => {
            if (deleteCaseMutation.isPending) return;
            setConfirmDeleteCase(false);
            setDeleteError(null);
          }}
        >
          <div
            className="bg-card rounded-xl border border-border p-6 max-w-sm mx-4 space-y-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 rounded-full bg-destructive/15 flex items-center justify-center shrink-0">
                <AlertTriangle size={17} className="text-destructive" />
              </div>
              <div>
                <h3 className="font-semibold">Delete case {labCase.caseNumber}?</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  This will permanently delete the case and all its restorations, notes, and attachments. This cannot be undone.
                </p>
              </div>
            </div>
            {deleteError && (
              <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
                {deleteError}
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setConfirmDeleteCase(false);
                  setDeleteError(null);
                }}
                disabled={deleteCaseMutation.isPending}
                className="flex-1 h-9 rounded-md bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => deleteCaseMutation.mutate()}
                disabled={deleteCaseMutation.isPending}
                className="flex-1 h-9 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 disabled:opacity-60 inline-flex items-center justify-center gap-1.5"
              >
                {deleteCaseMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tooth chart action dialog */}
      {toothDialogId !== null && (
        <ToothActionDialog
          toothId={toothDialogId}
          restorations={(data?.restorations ?? []).filter(
            (r) => r.restorationType !== "missing",
          )}
          isPending={false}
          error={toothDialogError}
          onClose={() => {
            setToothDialogId(null);
            setToothDialogError(null);
          }}
          onConfirm={(payload) => handleToothDialogStage(payload)}
          locallySelectedType={
            missingTeethIds.has(toothDialogId)
              ? "missing"
              : pendingCreates.some(
                  (c) =>
                    parseToothField(c.toothNumber).has(toothDialogId) &&
                    /pontic/i.test(c.restorationType),
                )
              ? "pontic"
              : pendingCreates.some(
                  (c) =>
                    parseToothField(c.toothNumber).has(toothDialogId) &&
                    !/pontic/i.test(c.restorationType),
                )
              ? "crown"
              : undefined
          }
        />
      )}

      {/* Discard confirm overlay — shown when closing or navigating away with unsaved changes */}
      {pendingDiscard && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-foreground/40"
          onClick={() => setPendingDiscard(null)}
        >
          <div
            className="bg-card rounded-xl border border-border p-6 max-w-sm mx-4 space-y-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 rounded-full bg-amber-500/15 flex items-center justify-center shrink-0">
                <AlertTriangle size={17} className="text-amber-600" />
              </div>
              <div>
                <h3 className="font-semibold">Unsaved changes</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  You have unsaved changes to this case. Do you want to discard them?
                </p>
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setPendingDiscard(null)}
                className="flex-1 h-9 rounded-md bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={() => {
                  const proceed = pendingDiscard;
                  handleDiscardChanges();
                  setPendingDiscard(null);
                  proceed?.();
                }}
                className="flex-1 h-9 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90"
              >
                Discard changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const PRICE_SOURCE_STYLES: Record<
  RestorationPriceSource,
  { label: string; className: string; title: string }
> = {
  manual: {
    label: "Manual",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    title: "Price was entered manually on this case.",
  },
  override: {
    label: "Override",
    className: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    title: "Came from a per-doctor pricing override.",
  },
  tier: {
    label: "Tier",
    className: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
    title: "Came from the practice's assigned pricing tier.",
  },
  default: {
    label: "Default tier",
    className: "bg-secondary text-muted-foreground",
    title: "Fell back to the lab's default tier.",
  },
};

function PendingRestorationRow({
  pending,
  onRemove,
}: {
  pending: {
    localId: string;
    toothNumber: string;
    restorationType: string;
    material: string;
    shade: string;
    quantity: number;
    unitPrice: string;
  };
  onRemove: () => void;
}) {
  return (
    <div className="border border-amber-500/40 bg-amber-500/5 rounded-md px-3 py-2 text-sm flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          {pending.restorationType}
          <span className="text-muted-foreground"> · Tooth {pending.toothNumber}</span>
        </div>
        {(pending.material || pending.shade) && (
          <div className="text-xs text-muted-foreground">
            {[pending.material, pending.shade].filter(Boolean).join(" · ")}
          </div>
        )}
        <div className="mt-1.5">
          <span className="text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-300">
            Unsaved
          </span>
        </div>
      </div>
      <div className="flex items-start gap-2 shrink-0">
        <div className="text-right whitespace-nowrap">
          <div className="text-xs text-muted-foreground tabular-nums">Qty {pending.quantity}</div>
          <div className="text-sm tabular-nums font-medium text-muted-foreground">
            {pending.unitPrice ? `$${Number(pending.unitPrice).toFixed(2)}` : "Auto"}
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="h-7 w-7 rounded hover:bg-destructive/10 flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors mt-0.5"
          title="Remove (not saved yet)"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

function RestorationRow({
  restoration: r,
  caseId,
  labOrganizationId,
  isPendingDelete,
  onPendingDelete,
  onUndoPendingDelete,
}: {
  restoration: CaseRestoration;
  caseId: string;
  labOrganizationId: string;
  isPendingDelete?: boolean;
  onPendingDelete?: () => void;
  onUndoPendingDelete?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const source = (r.priceSource ?? null) as RestorationPriceSource | null;
  const style = source ? PRICE_SOURCE_STYLES[source] : null;
  const hasHistorySource =
    source === "tier" || source === "override" || source === "default";

  return (
    <div
      className={`border rounded-md px-3 py-2 text-sm transition-colors ${
        isPendingDelete
          ? "border-amber-500/40 bg-amber-500/5 opacity-70"
          : confirmDelete
          ? "border-destructive/40 bg-destructive/5"
          : "border-border"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className={`font-medium ${isPendingDelete ? "line-through text-muted-foreground" : ""}`}>
            {r.restorationType}
            <span className="text-muted-foreground"> · Tooth {r.toothNumber}</span>
          </div>
          {(r.material || r.shade) && (
            <div className="text-xs text-muted-foreground">
              {[r.material, r.shade].filter(Boolean).join(" · ")}
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {isPendingDelete && (
              <span className="text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-300">
                Pending delete
              </span>
            )}
            {!isPendingDelete && style && (
              <span
                title={style.title}
                className={`text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded ${style.className}`}
              >
                {style.label}
                {source !== "manual" && r.priceSourceName
                  ? ` · ${r.priceSourceName}`
                  : ""}
              </span>
            )}
            {!isPendingDelete && !style && (
              <span className="text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                Unknown source
              </span>
            )}
          </div>
        </div>
        <div className="flex items-start gap-2 shrink-0">
          <div className="text-right whitespace-nowrap">
            <div className="text-xs text-muted-foreground tabular-nums">Qty {r.quantity}</div>
            <div className="text-sm tabular-nums font-medium">{formatMoney(r.unitPrice)}</div>
          </div>
          {isPendingDelete ? (
            <button
              type="button"
              onClick={() => { onUndoPendingDelete?.(); setConfirmDelete(false); }}
              className="h-7 px-2 rounded text-[11px] font-medium bg-secondary hover:bg-secondary/80 text-muted-foreground hover:text-foreground transition-colors mt-0.5"
              title="Undo — this deletion hasn't been saved yet"
            >
              Undo
            </button>
          ) : !confirmDelete ? (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="h-7 w-7 rounded hover:bg-destructive/10 flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors mt-0.5"
              title="Delete restoration"
            >
              <Trash2 size={13} />
            </button>
          ) : (
            <div className="flex items-center gap-1 mt-0.5">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="h-6 px-1.5 rounded text-[11px] text-muted-foreground hover:text-foreground bg-secondary"
              >
                Keep
              </button>
              <button
                type="button"
                onClick={() => { onPendingDelete?.(); setConfirmDelete(false); }}
                className="h-6 px-1.5 rounded text-[11px] font-medium text-destructive-foreground bg-destructive hover:bg-destructive/90 inline-flex items-center gap-0.5"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
      {hasHistorySource && r.priceSourceId && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setExpanded((x) => !x)}
            className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            Price history
          </button>
          {expanded && (
            <PriceHistoryPanel
              labOrganizationId={labOrganizationId}
              source={source as "tier" | "override" | "default"}
              sourceId={r.priceSourceId}
              priceKey={r.priceKey ?? null}
              capturedUnitPrice={Number(r.unitPrice ?? 0)}
              capturedAt={r.createdAt ?? null}
            />
          )}
        </div>
      )}
    </div>
  );
}

function PriceHistoryPanel({
  labOrganizationId,
  source,
  sourceId,
  priceKey,
  capturedUnitPrice,
  capturedAt,
}: {
  labOrganizationId: string;
  source: "tier" | "override" | "default";
  sourceId: string;
  priceKey: string | null;
  capturedUnitPrice: number;
  capturedAt: string | null;
}) {
  const endpointType = source === "override" ? "overrides" : "tiers";

  const history = useQuery({
    queryKey: ["pricing-history", endpointType, sourceId],
    queryFn: () =>
      apiFetch<{ entries: PricingHistoryEntry[] }>(
        `/pricing/${endpointType}/${sourceId}/history`
      ),
  });

  const currentList = useQuery({
    queryKey: ["pricing-current", endpointType, labOrganizationId],
    queryFn: async () => {
      if (endpointType === "tiers") {
        return apiFetch<{ tiers: PricingTier[] }>(
          `/pricing/tiers?labOrganizationId=${encodeURIComponent(labOrganizationId)}`
        );
      }
      return apiFetch<{ overrides: PricingOverride[] }>(
        `/pricing/overrides?labOrganizationId=${encodeURIComponent(labOrganizationId)}`
      );
    },
  });

  if (history.isLoading || currentList.isLoading) {
    return (
      <div className="mt-1.5 text-[11px] text-muted-foreground">Loading price history…</div>
    );
  }
  if (history.error) {
    return (
      <div className="mt-1.5 text-[11px] text-muted-foreground">
        Couldn't load price history.
      </div>
    );
  }

  const capturedTs = capturedAt ? new Date(capturedAt).getTime() : 0;
  const entries = (history.data?.entries ?? []).filter((e) => {
    if (!priceKey) return true;
    const before = e.beforePrices?.[priceKey];
    const after = e.afterPrices?.[priceKey];
    return Number(before ?? 0) !== Number(after ?? 0);
  });
  const changesSinceCase = entries.filter((e) => {
    const t = e.createdAt ? new Date(e.createdAt).getTime() : 0;
    return t > capturedTs;
  });

  let currentPrice: number | null = null;
  if (priceKey) {
    if (endpointType === "tiers") {
      const tier = (currentList.data as { tiers?: PricingTier[] } | undefined)
        ?.tiers?.find((t) => t.id === sourceId);
      const v = Number(tier?.prices?.[priceKey]);
      if (Number.isFinite(v) && v > 0) currentPrice = v;
    } else {
      const ov = (
        currentList.data as { overrides?: PricingOverride[] } | undefined
      )?.overrides?.find((o) => o.id === sourceId);
      const v = Number(ov?.prices?.[priceKey]);
      if (Number.isFinite(v) && v > 0) currentPrice = v;
    }
  }

  const sourceLabel = source === "override" ? "Override" : "Tier";

  return (
    <div className="mt-2 border border-border rounded bg-secondary/30 p-2 space-y-1.5">
      {currentPrice !== null && Math.abs(currentPrice - capturedUnitPrice) > 0.005 && (
        <div className="text-[11px] text-foreground">
          {sourceLabel} price changed{" "}
          <span className="tabular-nums">
            {formatMoney(capturedUnitPrice)} → {formatMoney(currentPrice)}
          </span>{" "}
          since this case was billed.
        </div>
      )}
      {currentPrice !== null && Math.abs(currentPrice - capturedUnitPrice) <= 0.005 && (
        <div className="text-[11px] text-muted-foreground">
          {sourceLabel} price hasn't changed since this case was billed.
        </div>
      )}
      {changesSinceCase.length === 0 && entries.length > 0 && (
        <div className="text-[11px] text-muted-foreground">
          No edits since this case was created.
        </div>
      )}
      {changesSinceCase.length > 0 && (
        <ul className="space-y-1">
          {changesSinceCase.slice(0, 5).map((e) => {
            const before = priceKey ? e.beforePrices?.[priceKey] : undefined;
            const after = priceKey ? e.afterPrices?.[priceKey] : undefined;
            const beforeNum = Number(before ?? 0);
            const afterNum = Number(after ?? 0);
            return (
              <li key={e.id} className="text-[11px] text-muted-foreground">
                <span className="text-foreground tabular-nums">
                  {beforeNum > 0 ? formatMoney(beforeNum) : "—"} →{" "}
                  {afterNum > 0 ? formatMoney(afterNum) : "—"}
                </span>
                <span> · {relativeTime(e.createdAt)}</span>
                {e.userName && <span> · {e.userName}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {entries.length === 0 && currentPrice === null && (
        <div className="text-[11px] text-muted-foreground">
          No pricing changes recorded.
        </div>
      )}
    </div>
  );
}

async function openFileAuthenticated(url: string): Promise<void> {
  const token = getAccessToken();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    window.alert("Could not open file. Please try again.");
    return;
  }
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.target = "_blank";
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
}

async function previewAttachmentInElectron(
  caseId: string,
  attachment: CaseAttachment,
): Promise<void> {
  const electronAPI = (window as any).electronAPI;
  if (!electronAPI?.previewFile || !attachment.id) return;
  const href = `${getApiOrigin()}/api/cases/${caseId}/attachments/${attachment.id}/file`;
  const token = getAccessToken();
  const res = await fetch(href, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Failed to fetch file: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const mimeType =
    attachment.fileType || res.headers.get("content-type") || "application/octet-stream";
  await electronAPI.previewFile(buffer, mimeType, `attachment:${attachment.id}`);
}

function AttachmentRow({
  caseId,
  attachment,
  canManage,
  onImageClick,
  onVideoClick,
}: {
  caseId: string;
  attachment: CaseAttachment;
  canManage: boolean;
  onImageClick?: (url: string) => void;
  onVideoClick?: (url: string, mimeType?: string) => void;
}) {
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [scanViewerOpen, setScanViewerOpen] = useState(false);
  const queryClient = useQueryClient();
  const deleteMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/cases/${caseId}/attachments/${attachment.id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["case", caseId] });
    },
    onError: (err: Error) => {
      window.alert(err.message || "Couldn't delete attachment.");
    },
  });

  const visibility = attachment.visibility || "shared_with_provider";
  const isInternal = visibility === "internal_lab_only";
  const nextVisibility = isInternal ? "shared_with_provider" : "internal_lab_only";

  const visibilityMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/cases/${caseId}/attachments/${attachment.id}`, {
        method: "PATCH",
        body: JSON.stringify({ visibility: nextVisibility }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["case", caseId] });
    },
    onError: (err: Error) => {
      window.alert(err.message || "Couldn't update attachment visibility.");
    },
  });

  const isImage = (attachment.fileType || "").startsWith("image/");
  const isVideo = (attachment.fileType || "").startsWith("video/");

  const SCAN_MIME_TYPES = new Set(["model/stl", "model/obj", "model/ply", "application/sla"]);
  const SCAN_EXTENSIONS = new Set([".stl", ".obj", ".ply", ".dcm", ".3ds", ".dae"]);
  function is3dScan(mimeType: string, fileName?: string): boolean {
    if (SCAN_MIME_TYPES.has(mimeType)) return true;
    if (fileName) {
      const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
      if (SCAN_EXTENSIONS.has(ext)) return true;
    }
    return false;
  }
  const isScan = is3dScan(attachment.fileType || "", attachment.fileName);
  // The desktop has an in-app three.js viewer for STL/OBJ/PLY; other 3D
  // formats (.dcm, .3ds, .dae) fall through to the existing preview/open
  // behaviour.
  function inAppScanFormat(fileName?: string): ScanFormat | null {
    if (!fileName) return null;
    const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
    if (ext === "stl" || ext === "obj" || ext === "ply") return ext;
    return null;
  }
  const inAppFormat = inAppScanFormat(attachment.fileName);
  // Always use the canonical authenticated file endpoint rather than the raw
  // storageKey URL, which is a host-specific URL saved at upload time and may
  // be stale after a domain change or redeployment.
  const href = attachment.id
    ? `${getApiOrigin()}/api/cases/${caseId}/attachments/${attachment.id}/file`
    : attachment.storageKey;

  function onDelete() {
    if (deleteMutation.isPending) return;
    if (!window.confirm(`Delete "${attachment.fileName}"?`)) return;
    deleteMutation.mutate();
  }

  function onToggleVisibility() {
    if (visibilityMutation.isPending) return;
    visibilityMutation.mutate();
  }

  const electronAPI = (window as any).electronAPI;
  const canElectronPreview = !!(electronAPI?.previewFile && attachment.id);

  async function handleElectronPreview() {
    if (inAppFormat) {
      setScanViewerOpen(true);
      return;
    }
    if (isImage && onImageClick && href) {
      onImageClick(href);
      return;
    }
    if (isVideo && onVideoClick && href) {
      onVideoClick(href, attachment.fileType || "video/mp4");
      return;
    }
    if (isPreviewing) return;
    setIsPreviewing(true);
    try {
      await previewAttachmentInElectron(caseId, attachment);
    } catch {
      if (href) await openFileAuthenticated(href);
    } finally {
      setIsPreviewing(false);
    }
  }

  function handleScanFallback() {
    // If the in-app viewer can't render the scan, fall back to the existing
    // Electron preview window or external open.
    if (canElectronPreview) {
      void (async () => {
        try {
          await previewAttachmentInElectron(caseId, attachment);
        } catch {
          if (href) await openFileAuthenticated(href);
        }
      })();
    } else if (href) {
      void openFileAuthenticated(href);
    }
  }

  const rowBody = (
    <>
      {inAppFormat && href ? (
        <ScanThumbnail
          cacheKey={`att:${attachment.id}`}
          fileUrl={href}
          format={inAppFormat}
          authToken={getAccessToken()}
          size={44}
        />
      ) : isImage && href ? (
        <div className="mt-0.5 h-11 w-11 shrink-0 overflow-hidden rounded bg-secondary">
          <AuthedImage
            url={href}
            alt={attachment.fileName}
            className="h-full w-full object-cover"
            fallback={
              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                <ImageOff size={14} />
              </div>
            }
          />
        </div>
      ) : (
        <div className="mt-0.5 text-muted-foreground">
          {isScan ? <Box size={14} /> : <Paperclip size={14} />}
        </div>
      )}
      <div className="min-w-0 flex-1 text-left">
        <div className="font-medium truncate flex items-center gap-2" title={attachment.fileName}>
          <span className="truncate">{attachment.fileName}</span>
          <span
            className={
              "shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide " +
              (isInternal
                ? "bg-amber-100 text-amber-800 border border-amber-200"
                : "bg-secondary text-muted-foreground border border-border")
            }
            title={
              isInternal
                ? "Only visible to lab staff"
                : "Visible to the provider"
            }
          >
            {isInternal ? <Lock size={10} /> : <Eye size={10} />}
            {isInternal ? "Lab only" : "Shared"}
          </span>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {isScan ? "3D Scan" : isImage ? "Image" : attachment.fileType || "File"}
          {attachment.uploaderName ? ` · ${attachment.uploaderName}` : ""}
          {attachment.createdAt ? ` · ${relativeTime(attachment.createdAt)}` : ""}
        </div>
      </div>
    </>
  );

  return (
    <div className="border border-border rounded-md px-3 py-2 text-sm flex items-start gap-3">
      {href ? (
        inAppFormat ? (
          <button
            type="button"
            onClick={() => setScanViewerOpen(true)}
            className="flex items-start gap-3 flex-1 min-w-0 -mx-1 -my-0.5 px-1 py-0.5 rounded hover:bg-secondary/60 transition-colors cursor-pointer text-left"
            title={`View "${attachment.fileName}"`}
          >
            {rowBody}
          </button>
        ) : canElectronPreview ? (
          <button
            type="button"
            onClick={handleElectronPreview}
            disabled={isPreviewing}
            className="flex items-start gap-3 flex-1 min-w-0 -mx-1 -my-0.5 px-1 py-0.5 rounded hover:bg-secondary/60 transition-colors cursor-pointer disabled:opacity-60 text-left"
            title={`Preview "${attachment.fileName}"`}
          >
            {rowBody}
          </button>
        ) : isImage && onImageClick ? (
          <button
            type="button"
            onClick={() => onImageClick(href)}
            className="flex items-start gap-3 flex-1 min-w-0 -mx-1 -my-0.5 px-1 py-0.5 rounded hover:bg-secondary/60 transition-colors cursor-pointer text-left"
            title={`View "${attachment.fileName}"`}
          >
            {rowBody}
          </button>
        ) : isVideo && onVideoClick ? (
          <button
            type="button"
            onClick={() => onVideoClick(href, attachment.fileType || "video/mp4")}
            className="flex items-start gap-3 flex-1 min-w-0 -mx-1 -my-0.5 px-1 py-0.5 rounded hover:bg-secondary/60 transition-colors cursor-pointer text-left"
            title={`Play "${attachment.fileName}"`}
          >
            {rowBody}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void openFileAuthenticated(href)}
            className="flex items-start gap-3 flex-1 min-w-0 -mx-1 -my-0.5 px-1 py-0.5 rounded hover:bg-secondary/60 transition-colors cursor-pointer text-left"
            title={`Open "${attachment.fileName}"`}
          >
            {rowBody}
          </button>
        )
      ) : (
        <div className="flex items-start gap-3 flex-1 min-w-0">{rowBody}</div>
      )}
      <div className="flex items-center gap-1">
        {canManage && (
          <button
            type="button"
            onClick={onToggleVisibility}
            disabled={visibilityMutation.isPending}
            className="h-7 w-7 rounded hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-50"
            title={
              isInternal
                ? "Share with the provider"
                : "Mark as lab-only"
            }
          >
            {visibilityMutation.isPending ? (
              <Loader2 size={13} className="animate-spin" />
            ) : isInternal ? (
              <Eye size={13} />
            ) : (
              <EyeOff size={13} />
            )}
          </button>
        )}
        {href && (
          inAppFormat ? (
            <button
              type="button"
              onClick={() => setScanViewerOpen(true)}
              className="h-7 w-7 rounded hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground"
              title="Open in 3D viewer"
            >
              <ExternalLink size={13} />
            </button>
          ) : canElectronPreview ? (
            <button
              type="button"
              onClick={handleElectronPreview}
              disabled={isPreviewing}
              className="h-7 w-7 rounded hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-50"
              title="Preview file"
            >
              {isPreviewing ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <ExternalLink size={13} />
              )}
            </button>
          ) : (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="h-7 w-7 rounded hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground"
              title="Open file"
            >
              <ExternalLink size={13} />
            </a>
          )
        )}
        <button
          type="button"
          onClick={onDelete}
          disabled={deleteMutation.isPending}
          className="h-7 w-7 rounded hover:bg-destructive/10 flex items-center justify-center text-muted-foreground hover:text-destructive disabled:opacity-50"
          title="Delete attachment"
        >
          {deleteMutation.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Trash2 size={13} />
          )}
        </button>
      </div>
      {inAppFormat && href && (
        <ScanViewerModal
          open={scanViewerOpen}
          fileUrl={href}
          fileName={attachment.fileName}
          format={inAppFormat}
          authToken={getAccessToken()}
          onClose={() => setScanViewerOpen(false)}
          onFallback={handleScanFallback}
        />
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
        {label}
      </div>
      <div className="text-sm mt-0.5">{value || "—"}</div>
    </div>
  );
}
