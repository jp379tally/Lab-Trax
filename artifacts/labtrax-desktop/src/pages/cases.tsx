import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Box,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  EyeOff,
  FileUp,
  Filter,
  Loader2,
  Lock,
  Maximize2,
  Paperclip,
  Pencil,
  Plus,
  Printer,
  ReceiptText,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { apiFetch, getAccessToken, getApiOrigin } from "@/lib/api";
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
import { formatDate, formatDateTime, formatMoney, formatPhone, relativeTime, statusLabel } from "@/lib/format";
import {
  printCaseCard,
  printCaseHistory,
  printCaseOverview,
  printInvoice,
  printTabContent,
} from "@/lib/print";
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
}

interface ProviderPickerProps {
  value: string;
  onChange: (id: string, org: Organization | null) => void;
  providers: Organization[];
  disabled?: boolean;
}

function ProviderPicker({ value, onChange, providers, disabled }: ProviderPickerProps) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = providers.find((o) => o.id === value) || null;

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setAdding(false);
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

  const createMutation = useMutation({
    mutationFn: async () => {
      const body = {
        type: "provider" as const,
        name: newName.trim(),
        ...(newPhone.trim() ? { phone: newPhone.trim() } : {}),
        ...(newEmail.trim() ? { billingEmail: newEmail.trim() } : {}),
        ...(newAddress.trim() ? { addressLine1: newAddress.trim() } : {}),
      };
      return apiFetch<Organization>("/organizations", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["organizations"] });
      onChange(created.id, created);
      setOpen(false);
      setAdding(false);
      setNewName("");
      setNewPhone("");
      setNewEmail("");
      setNewAddress("");
      setSearch("");
      setCreateError(null);
    },
    onError: (e: Error) => setCreateError(e.message),
  });

  function startAddingFromSearch() {
    setNewName(search.trim());
    setAdding(true);
    setCreateError(null);
  }

  function submitNew(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) {
      setCreateError("Practice name is required.");
      return;
    }
    createMutation.mutate();
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen((o) => !o);
          setAdding(false);
        }}
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
          {!adding && (
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
              <button
                type="button"
                onClick={startAddingFromSearch}
                className="w-full px-3 py-2 text-sm font-medium text-primary border-t border-border hover:bg-primary/5 flex items-center gap-2"
              >
                <Plus size={13} /> Add new practice
                {search.trim() && (
                  <span className="text-muted-foreground font-normal truncate">
                    "{search.trim()}"
                  </span>
                )}
              </button>
            </>
          )}

          {adding && (
            <form onSubmit={submitNew} className="p-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                New practice
              </p>
              <input
                autoFocus
                placeholder="Practice / office name *"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              />
              <input
                placeholder="Phone (optional, 000-000-0000)"
                value={newPhone}
                onChange={(e) => setNewPhone(formatPhone(e.target.value))}
                className="w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              />
              <input
                placeholder="Email (optional)"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                className="w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              />
              <input
                placeholder="Address (optional)"
                value={newAddress}
                onChange={(e) => setNewAddress(e.target.value)}
                className="w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              />
              {createError && (
                <p className="text-xs text-destructive">{createError}</p>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setCreateError(null);
                  }}
                  className="flex-1 h-8 rounded-md bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="flex-1 h-8 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center justify-center gap-1.5"
                >
                  {createMutation.isPending && (
                    <Loader2 size={11} className="animate-spin" />
                  )}
                  Add practice
                </button>
              </div>
            </form>
          )}
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

  const mutation = useMutation({
    mutationFn: (data: NewCaseFormData & Partial<RemakeDecision>) =>
      apiFetch<LabCase>("/cases", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      setDuplicateMatches(null);
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  function set<K extends keyof NewCaseFormData>(k: K, v: NewCaseFormData[K]) {
    setForm((f) => ({ ...f, [k]: v }));
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.labOrganizationId)
      return setError("Please select a lab organization.");
    if (!form.providerOrganizationId)
      return setError("Please select a practice.");
    if (!form.patientFirstName.trim() || !form.patientLastName.trim())
      return setError("Patient first and last name are required.");
    if (!form.doctorName.trim()) return setError("Doctor name is required.");

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

  const { data, isLoading, error } = useQuery({
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
  const [iteroActiveBatch, setIteroActiveBatch] = useState<{ batchId: string; caseIds: string[]; importedAt: string; label: string } | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const scrollRestoredRef = useRef(false);
  const deepLinkOpenedRef = useRef(false);

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

  useEffect(() => {
    try {
      sessionStorage.setItem(
        CASES_FILTER_STORAGE_KEY,
        JSON.stringify({ search, statusFilter, priorityFilter, dateRangeFilter, customStartDate, customEndDate, sortKey, sortDir }),
      );
    } catch {}
  }, [search, statusFilter, priorityFilter, dateRangeFilter, customStartDate, customEndDate, sortKey, sortDir]);

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
          `${c.patientFirstName} ${c.patientLastName}`.toLowerCase().includes(q)
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

      <div className="bg-card border border-border rounded-xl overflow-hidden">
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
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40">
                <th className="text-left px-5 py-2.5"><SortHeader k="createdAt">Created</SortHeader></th>
                <th className="text-left py-2.5"><SortHeader k="caseNumber">Case #</SortHeader></th>
                <th className="text-left py-2.5">Patient</th>
                <th className="text-left py-2.5"><SortHeader k="doctorName">Doctor</SortHeader></th>
                <th className="text-left py-2.5">Type</th>
                <th className="text-left py-2.5">Material</th>
                <th className="text-left py-2.5">Teeth</th>
                <th className="text-left py-2.5">Priority</th>
                <th className="text-left py-2.5"><SortHeader k="status">Status</SortHeader></th>
                <th className="text-left py-2.5"><SortHeader k="dueDate">Due</SortHeader></th>
                <th className="text-right py-2.5"><SortHeader k="totalPrice">Price</SortHeader></th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={11} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading cases…
                  </td>
                </tr>
              )}
              {error && (
                <tr>
                  <td colSpan={11} className="px-5 py-12 text-center text-destructive">
                    {(error as Error).message}
                  </td>
                </tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-5 py-12 text-center text-muted-foreground">
                    No cases match the current filters.
                  </td>
                </tr>
              )}
              {filtered.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => setSelected(c)}
                  className="border-t border-border cursor-pointer hover:bg-secondary/40"
                >
                  <td className="px-5 py-3 text-muted-foreground">{relativeTime(c.createdAt)}</td>
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
                  <td className="py-3 text-muted-foreground">{formatDate(c.dueDate)}</td>
                  <td className="py-3 text-right tabular-nums">
                    {Number(c.totalPrice ?? 0) > 0 ? formatMoney(c.totalPrice) : "—"}
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
    </div>
  );
}

function MobileCaseDrawer({ labCase, onClose }: { labCase: LabCase; onClose: () => void }) {
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
            <Field label="Patient" value={`${labCase.patientFirstName} ${labCase.patientLastName}`} />
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
  attachments: CaseAttachment[];
  viewerIsLabMember?: boolean;
  viewerCanManageAttachments?: boolean;
  /** Serialized bridge connector pairs, e.g. "13-14,14-15". Null when none. */
  bridgeConnectors?: string | null;
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

type CaseTab = "overview" | "restorations" | "notes" | "files" | "invoice" | "history";

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileDragOver, setFileDragOver] = useState(false);
  const fileDragCounterRef = useRef(0);

  const [activeTab, setActiveTab] = useState<CaseTab>("overview");
  const [viewingInvoice, setViewingInvoice] = useState<Invoice | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [confirmDeleteCase, setConfirmDeleteCase] = useState(false);

  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState({
    patientFirstName: labCase.patientFirstName || "",
    patientLastName: labCase.patientLastName || "",
    doctorName: labCase.doctorName || "",
    dueDate: labCase.dueDate
      ? new Date(labCase.dueDate).toISOString().split("T")[0]
      : "",
    priority: (labCase.priority || "normal") as "normal" | "rush",
  });
  const [editError, setEditError] = useState<string | null>(null);

  const [routeStatus, setRouteStatus] = useState("");
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeSuccessMsg, setRouteSuccessMsg] = useState<string | null>(null);

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
  const billedTeeth = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.restorations ?? []) {
      for (const id of parseToothField(r.toothNumber)) set.add(id);
    }
    return set;
  }, [data?.restorations]);

  // Per-tooth restoration descriptions surfaced in the tooth-chart
  // tooltip so users immediately see what's already on the case.
  const billedTeethTypes = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const r of data?.restorations ?? []) {
      const materialShade = [r.material, r.shade].filter(Boolean).join(" · ");
      const label = [r.restorationType, materialShade].filter(Boolean).join(" / ");
      for (const id of parseToothField(r.toothNumber)) {
        const list = map.get(id) ?? [];
        if (label) list.push(label);
        map.set(id, list);
      }
    }
    return map;
  }, [data?.restorations]);

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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
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

  function invalidateAfterRestorationChange() {
    qc.invalidateQueries({ queryKey: ["case", labCase.id] });
    qc.invalidateQueries({ queryKey: ["cases"] });
    qc.invalidateQueries({ queryKey: ["invoice-for-case", labCase.id] });
    qc.invalidateQueries({ queryKey: ["invoice-detail"] });
    qc.invalidateQueries({ queryKey: ["invoices"] });
  }

  const toothDialogMutation = useMutation({
    mutationFn: async (payload: ToothActionPayload) => {
      if (payload.kind === "add_crown") {
        await apiFetch(`/cases/${labCase.id}/restorations`, {
          method: "POST",
          body: JSON.stringify({
            toothNumber: payload.toothId,
            restorationType: payload.restorationType,
            material: payload.material,
            ...(payload.shade ? { shade: payload.shade } : {}),
            quantity: 1,
          }),
        });
      } else if (payload.kind === "add_pontic") {
        // Infer material from the nearest abutment crown in the same bridge
        // span so the price resolves immediately rather than showing $0.00.
        let inferredMaterial: string | undefined;
        const ponticTooth = Number(payload.toothId);
        if (
          Number.isInteger(ponticTooth) &&
          ponticTooth >= 1 &&
          ponticTooth <= 32 &&
          connectedPairs.size > 0
        ) {
          // BFS through connectedPairs to find all teeth in the same span.
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
          // Find the first non-pontic restoration in the span with a material.
          const abutment = (data?.restorations ?? []).find((r) => {
            const rTooth = Number((r.toothNumber ?? "").trim());
            return (
              span.has(rTooth) &&
              !/pontic/i.test(r.restorationType) &&
              r.material
            );
          });
          inferredMaterial = abutment?.material ?? undefined;
        }
        await apiFetch(`/cases/${labCase.id}/restorations`, {
          method: "POST",
          body: JSON.stringify({
            toothNumber: payload.toothId,
            restorationType: "Pontic",
            quantity: 1,
            ...(inferredMaterial ? { material: inferredMaterial } : {}),
          }),
        });
      } else if (payload.kind === "mark_missing") {
        // Missing is visual-only — toggle the tooth into the "selected" set
        // on the current restForm so it shows on the chart; no server call.
        return { kind: "missing", toothId: payload.toothId };
      } else if (payload.kind === "replace_tooth") {
        await apiFetch(
          `/cases/${labCase.id}/restorations/${payload.restorationId}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              toothNumber: payload.newToothNumber,
              ...(payload.material ? { material: payload.material } : {}),
              ...(payload.shade ? { shade: payload.shade } : {}),
            }),
          },
        );
      }
      return null;
    },
    onSuccess: (result) => {
      if (result && (result as any).kind === "missing") {
        // Mark-missing is local-only: add to the form tooth field so it
        // appears highlighted on the chart.
        const existing = parseToothField(restForm.toothNumber);
        existing.add((result as any).toothId);
        setRestForm((f) => ({
          ...f,
          toothNumber: Array.from(existing).join(", "),
        }));
      } else {
        invalidateAfterRestorationChange();
      }
      setToothDialogId(null);
      setToothDialogError(null);
    },
    onError: (e: Error) => setToothDialogError(e.message),
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
        const fd = new FormData();
        fd.append("file", file);
        const { url } = await apiFetch<{ url: string }>("/media/upload", {
          method: "POST",
          body: fd,
        });
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
        { method: "POST" }
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
      dueDate: src.dueDate
        ? new Date(src.dueDate).toISOString().split("T")[0]
        : "",
      priority: (src.priority || "normal") as "normal" | "rush",
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
    { id: "overview", label: "Overview" },
    { id: "restorations", label: "Restorations", count: restorationCount },
    { id: "notes", label: "Notes", count: noteCount },
    { id: "files", label: "Files", count: fileCount },
    { id: "invoice", label: "Invoice" },
    { id: "history", label: "History", count: (data?.events?.length ?? 0) + (data?.originalCaseEvents?.length ?? 0) || undefined },
  ];

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-foreground/30" onClick={onClose} />
      <aside className="w-full max-w-[700px] bg-card border-l border-border h-full flex flex-col shadow-2xl">
        {/* Header */}
        <header className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <div>
            <div className="text-xs text-muted-foreground">Case</div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="font-mono text-sm font-semibold">
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
                printCaseCard(data ?? labCase, {
                  restorations: data?.restorations ?? [],
                  notes: data?.notes ?? [],
                })
              }
              className="h-8 px-2.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs font-medium"
              title="Print case label"
            >
              <Printer size={14} />
              Label
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
              onClick={onClose}
              className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
            >
              <X size={16} />
            </button>
          </div>
        </header>

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
          {activeTab === "overview" && (
            <div className="px-5 py-5 space-y-6">
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                    {editMode ? "Edit Case Details" : "Case Details"}
                  </h3>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        printCaseOverview(data ?? labCase, {
                          restorations: data?.restorations ?? [],
                          notes: data?.notes ?? [],
                        })
                      }
                      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      title="Print overview"
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
                    <Field
                      label="Patient"
                      value={`${data?.patientFirstName ?? labCase.patientFirstName} ${data?.patientLastName ?? labCase.patientLastName}`}
                    />
                    <Field label="Doctor" value={data?.doctorName ?? labCase.doctorName} />
                    <Field label="Status" value={statusLabel(currentStatus)} />
                    <Field
                      label="Priority"
                      value={(data?.priority ?? labCase.priority) === "rush" ? "Rush" : "Normal"}
                    />
                    <Field label="Due date" value={formatDate(data?.dueDate ?? labCase.dueDate)} />
                    <Field label="Created" value={formatDate(data?.createdAt ?? labCase.createdAt)} />
                    {(data?.casePanBarcode ?? labCase.casePanBarcode) && (
                      <div className="col-span-2">
                        <Field
                          label="Case pan barcode"
                          value={data?.casePanBarcode ?? labCase.casePanBarcode ?? ""}
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
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
                        Doctor
                      </label>
                      <input
                        list="edit-doctor-names"
                        value={editForm.doctorName}
                        onChange={(e) => {
                          setEditForm((f) => ({ ...f, doctorName: e.target.value }));
                          setEditError(null);
                        }}
                        placeholder="Type or select a doctor…"
                        className="mt-1 w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                      />
                      <datalist id="edit-doctor-names">
                        {doctorNames.map((n) => (
                          <option key={n} value={n} />
                        ))}
                      </datalist>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
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
                    </div>
                    {editError && <p className="text-xs text-destructive">{editError}</p>}
                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => { setEditMode(false); setEditError(null); }}
                        className="flex-1 h-9 rounded-md bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => editMutation.mutate(editForm)}
                        disabled={editMutation.isPending}
                        className="flex-1 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center justify-center gap-1.5"
                      >
                        {editMutation.isPending && <Loader2 size={13} className="animate-spin" />}
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
                const summary = deriveRxSummary(data?.restorations);
                const hasAny =
                  summary.restorativeType ||
                  summary.materials.length > 0 ||
                  summary.shades.length > 0 ||
                  summary.teeth.length > 0 ||
                  summary.isFullArch !== null;
                const highlightValue = buildHighlightedToothValue(summary);
                return (
                  <section>
                    <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-3">
                      Rx Summary
                    </h3>
                    {!hasAny ? (
                      <div className="border border-dashed border-border rounded-md px-3 py-4 text-sm text-muted-foreground">
                        No restorations on this case yet. Add one in the
                        Restorations tab to populate this summary.
                      </div>
                    ) : (
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
                            value={
                              summary.materials.length > 0
                                ? summary.materials.join(", ")
                                : "—"
                            }
                          />
                          {summary.shades.length > 0 && (
                            <Field
                              label={
                                summary.shades.length > 1 ? "Shades" : "Shade"
                              }
                              value={summary.shades.join(", ")}
                            />
                          )}
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
                          value={highlightValue}
                          onChange={() => {}}
                          readOnly
                          showPrimary={false}
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
            </div>
          )}

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
                value={Array.from(billedTeeth).join(", ")}
                onChange={() => {}}
                billedTeeth={billedTeeth}
                billedTeethTypes={billedTeethTypes}
                onToothClick={(toothId) => {
                  setToothDialogId(toothId);
                  setToothDialogError(null);
                }}
                connectedPairs={connectedPairs}
                onConnectedPairsChange={handleConnectedPairsChange}
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
                      onChange={(e) => setRestForm((f) => ({ ...f, restorationType: e.target.value }))}
                      className="mt-1 w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="">Select type…</option>
                      {RESTORATION_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
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
                        addRestorationMutation.mutate();
                      }}
                      disabled={addRestorationMutation.isPending}
                      className="flex-1 h-8 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center justify-center gap-1.5"
                    >
                      {addRestorationMutation.isPending && <Loader2 size={11} className="animate-spin" />}
                      Add restoration
                    </button>
                  </div>
                </div>
              )}

              {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
              {!isLoading && restorationCount === 0 && (
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
                    onDeleted={() => {
                      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
                      qc.invalidateQueries({ queryKey: ["cases"] });
                      // Server keeps the invoice in sync, so refresh
                      // the Invoice tab queries too.
                      qc.invalidateQueries({
                        queryKey: ["invoice-for-case", labCase.id],
                      });
                      qc.invalidateQueries({ queryKey: ["invoice-detail"] });
                      qc.invalidateQueries({ queryKey: ["invoices"] });
                    }}
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
              onDragEnter={handleFileDragEnter}
              onDragLeave={handleFileDragLeave}
              onDragOver={handleFileDragOver}
              onDrop={handleFileDrop}
            >
              {fileDragOver && (
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
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingFile}
                    className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
                  >
                    {uploadingFile ? <Loader2 size={12} className="animate-spin" /> : <FileUp size={12} />}
                    {uploadingFile ? "Uploading…" : "Attach file"}
                  </button>
                </div>
              </div>
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
              {uploadError && <p className="text-xs text-destructive">{uploadError}</p>}
              {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
              {!isLoading && fileCount === 0 && !uploadingFile && (
                <div className="text-sm text-muted-foreground">No files attached yet.</div>
              )}
              {(() => {
                const images = data?.attachments?.filter((a) => (a.fileType || "").startsWith("image/")) ?? [];
                const others = data?.attachments?.filter((a) => !(a.fileType || "").startsWith("image/")) ?? [];
                return (
                  <>
                    {images.length > 0 && (
                      <div>
                        <p className="text-[11px] text-muted-foreground mb-2 font-medium">
                          Photos & Images ({images.length})
                        </p>
                        <div className="grid grid-cols-3 gap-2">
                          {images.map((a) => {
                            const imgUrl = a.id
                              ? `${getApiOrigin()}/api/cases/${labCase.id}/attachments/${a.id}/file`
                              : a.storageKey;
                            return (
                            <div key={a.id} className="relative group">
                              <button
                                type="button"
                                onClick={async () => {
                                  const electronAPI = (window as any).electronAPI;
                                  if (electronAPI?.previewFile && a.id) {
                                    try {
                                      await previewAttachmentInElectron(labCase.id, a);
                                    } catch {
                                      setLightboxUrl(imgUrl);
                                    }
                                  } else {
                                    setLightboxUrl(imgUrl);
                                  }
                                }}
                                className="relative w-full aspect-square rounded-lg overflow-hidden bg-secondary block"
                                title={a.fileName}
                              >
                                <img
                                  src={imgUrl}
                                  alt={a.fileName}
                                  className="w-full h-full object-cover"
                                  loading="lazy"
                                />
                                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                                  <Maximize2 size={18} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                                </div>
                              </button>
                              <p className="mt-1 text-[10px] text-muted-foreground truncate" title={a.fileName}>
                                {a.fileName}
                              </p>
                            </div>
                            );
                          })}
                        </div>
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
                  </>
                );
              })()}
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
                    onClick={() =>
                      printInvoice(
                        caseInvoice,
                        data ?? labCase,
                        { items: invoiceDetailQuery.data?.items ?? [] },
                      )
                    }
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
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                  Activity Log
                </h3>
                <button
                  type="button"
                  onClick={() =>
                    printCaseHistory(data ?? labCase, [
                      ...(data?.originalCaseEvents ?? []),
                      ...(data?.events ?? []),
                    ])
                  }
                  className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                  title="Print case history"
                >
                  <Printer size={12} />
                  Print history
                </button>
              </div>
              {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
              {!isLoading && (data?.events?.length ?? 0) === 0 && (data?.originalCaseEvents?.length ?? 0) === 0 && (
                <div className="text-sm text-muted-foreground">No activity logged yet.</div>
              )}
              {(() => {
                const hasOriginalEvents = (data?.originalCaseEvents?.length ?? 0) > 0;

                type TaggedEvent = CaseEvent & { _source: "original" | "remake" };

                const sortByTime = (evts: CaseEvent[]): CaseEvent[] =>
                  [...evts].sort((a, b) => {
                    const ta = new Date(a.occurredAt || a.createdAt || 0).getTime();
                    const tb = new Date(b.occurredAt || b.createdAt || 0).getTime();
                    return ta - tb;
                  });

                const originalEvents: TaggedEvent[] = sortByTime(data?.originalCaseEvents ?? []).map(
                  (e) => ({ ...e, _source: "original" as const }),
                );
                const remakeEvents: TaggedEvent[] = sortByTime(data?.events ?? []).map(
                  (e) => ({ ...e, _source: "remake" as const }),
                );

                const allEvents: TaggedEvent[] = [...originalEvents, ...remakeEvents];

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
                        e._source === "remake" &&
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
                                </div>
                                <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
                                  {formatDateTime(e.occurredAt || e.createdAt)}
                                </span>
                              </div>
                              {e.actorInitials && (
                                <div className="text-xs text-muted-foreground mt-0.5">{e.actorInitials}</div>
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

      {/* Image lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center"
          onClick={() => setLightboxUrl(null)}
        >
          <button
            type="button"
            onClick={() => setLightboxUrl(null)}
            className="absolute top-4 right-4 h-10 w-10 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20 transition-colors"
          >
            <X size={20} />
          </button>
          <img
            src={lightboxUrl}
            alt="Preview"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Invoice editor overlay */}
      {viewingInvoice && (
        <InvoiceEditor invoice={viewingInvoice} onClose={() => setViewingInvoice(null)} />
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
          restorations={data?.restorations ?? []}
          isPending={toothDialogMutation.isPending}
          error={toothDialogError}
          onClose={() => {
            setToothDialogId(null);
            setToothDialogError(null);
          }}
          onConfirm={(payload) => toothDialogMutation.mutate(payload)}
        />
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

function RestorationRow({
  restoration: r,
  caseId,
  labOrganizationId,
  onDeleted,
}: {
  restoration: CaseRestoration;
  caseId: string;
  labOrganizationId: string;
  onDeleted?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const source = (r.priceSource ?? null) as RestorationPriceSource | null;
  const style = source ? PRICE_SOURCE_STYLES[source] : null;
  const hasHistorySource =
    source === "tier" || source === "override" || source === "default";

  const deleteMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/cases/${caseId}/restorations/${r.id}`, { method: "DELETE" }),
    onSuccess: () => {
      onDeleted?.();
    },
    onError: (err: Error) => {
      window.alert(err.message || "Couldn't delete restoration.");
      setConfirmDelete(false);
    },
  });

  return (
    <div
      className={`border rounded-md px-3 py-2 text-sm transition-colors ${
        confirmDelete ? "border-destructive/40 bg-destructive/5" : "border-border"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            {r.restorationType}
            <span className="text-muted-foreground"> · Tooth {r.toothNumber}</span>
          </div>
          {(r.material || r.shade) && (
            <div className="text-xs text-muted-foreground">
              {[r.material, r.shade].filter(Boolean).join(" · ")}
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {style && (
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
            {!style && (
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
          {!confirmDelete ? (
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
                disabled={deleteMutation.isPending}
                className="h-6 px-1.5 rounded text-[11px] text-muted-foreground hover:text-foreground bg-secondary disabled:opacity-50"
              >
                Keep
              </button>
              <button
                type="button"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                className="h-6 px-1.5 rounded text-[11px] font-medium text-destructive-foreground bg-destructive hover:bg-destructive/90 disabled:opacity-60 inline-flex items-center gap-0.5"
              >
                {deleteMutation.isPending ? <Loader2 size={10} className="animate-spin" /> : "Delete"}
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
}: {
  caseId: string;
  attachment: CaseAttachment;
  canManage: boolean;
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
    if (isPreviewing) return;
    setIsPreviewing(true);
    try {
      await previewAttachmentInElectron(caseId, attachment);
    } catch {
      if (href) window.open(href, "_blank", "noopener,noreferrer");
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
          if (href) window.open(href, "_blank", "noopener,noreferrer");
        }
      })();
    } else if (href) {
      window.open(href, "_blank", "noopener,noreferrer");
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
        ) : (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="flex items-start gap-3 flex-1 min-w-0 -mx-1 -my-0.5 px-1 py-0.5 rounded hover:bg-secondary/60 transition-colors cursor-pointer"
            title={`Open "${attachment.fileName}"`}
          >
            {rowBody}
          </a>
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
