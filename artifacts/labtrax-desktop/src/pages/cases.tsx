import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
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
  ReceiptText,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import type {
  CaseAttachment,
  CaseEvent,
  CaseRestoration,
  Invoice,
  LabCase,
  Organization,
  PricingHistoryEntry,
  PricingOverride,
  PricingTier,
  RestorationPriceSource,
} from "@/lib/types";
import { formatDate, formatMoney, relativeTime, statusLabel } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import { InvoiceEditor } from "./invoices";

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  { value: "received", label: "Received" },
  { value: "in_design", label: "In Design" },
  { value: "in_milling", label: "In Milling" },
  { value: "in_porcelain", label: "Porcelain" },
  { value: "qc", label: "QC" },
  { value: "shipped", label: "Shipped" },
  { value: "delivered", label: "Delivered" },
  { value: "on_hold", label: "On Hold" },
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
  caseNumber: string;
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
                placeholder="Phone (optional)"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
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

  const mutation = useMutation({
    mutationFn: (data: NewCaseFormData) =>
      apiFetch<LabCase>("/cases", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  function set<K extends keyof NewCaseFormData>(k: K, v: NewCaseFormData[K]) {
    setForm((f) => ({ ...f, [k]: v }));
    setError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.labOrganizationId)
      return setError("Please select a lab organization.");
    if (!form.providerOrganizationId)
      return setError("Please select a practice.");
    if (!form.patientFirstName.trim() || !form.patientLastName.trim())
      return setError("Patient first and last name are required.");
    if (!form.doctorName.trim()) return setError("Doctor name is required.");
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
              disabled={mutation.isPending}
              className="flex-1 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {mutation.isPending ? "Creating…" : "Create case"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function CasesPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
  });

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<LabCase | null>(null);
  const [showNewCase, setShowNewCase] = useState(false);

  const filtered = useMemo(() => {
    const rows = data ?? [];
    const q = search.trim().toLowerCase();
    return rows
      .filter((c) => {
        if (statusFilter !== "all" && c.status !== statusFilter) return false;
        if (priorityFilter !== "all" && c.priority !== priorityFilter) return false;
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
  }, [data, search, statusFilter, priorityFilter, sortKey, sortDir]);

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
    <div className="px-8 py-7">
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
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40">
                <th className="text-left px-5 py-2.5"><SortHeader k="caseNumber">Case #</SortHeader></th>
                <th className="text-left py-2.5">Patient</th>
                <th className="text-left py-2.5"><SortHeader k="doctorName">Doctor</SortHeader></th>
                <th className="text-left py-2.5">Type</th>
                <th className="text-left py-2.5">Material</th>
                <th className="text-left py-2.5">Teeth</th>
                <th className="text-left py-2.5">Priority</th>
                <th className="text-left py-2.5"><SortHeader k="status">Status</SortHeader></th>
                <th className="text-left py-2.5"><SortHeader k="dueDate">Due</SortHeader></th>
                <th className="text-right py-2.5"><SortHeader k="totalPrice">Price</SortHeader></th>
                <th className="text-left px-5 py-2.5"><SortHeader k="createdAt">Created</SortHeader></th>
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
                  <td className="px-5 py-3 font-mono text-xs">{c.caseNumber}</td>
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
                  <td className="px-5 py-3 text-muted-foreground">{relativeTime(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <CaseDrawer
          labCase={selected}
          onClose={() => setSelected(null)}
          doctorNames={distinctDoctorNames}
          patientLastNames={distinctPatientLastNames}
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
};

type DetailedCase = LabCase & {
  restorations: CaseRestoration[];
  notes: CaseNote[];
  events: CaseEvent[];
  attachments: CaseAttachment[];
  viewerIsLabMember?: boolean;
  viewerCanManageAttachments?: boolean;
};

function formatEventType(eventType: string | undefined | null): string {
  if (!eventType) return "Event";
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
}: {
  labCase: LabCase;
  onClose: () => void;
  doctorNames?: string[];
  patientLastNames?: string[];
}) {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  const [routeSuccess, setRouteSuccess] = useState(false);

  const [noteText, setNoteText] = useState("");
  const [noteVis, setNoteVis] = useState<"internal_lab_only" | "shared_with_provider">(
    "shared_with_provider"
  );
  const [noteError, setNoteError] = useState<string | null>(null);

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

  const { data, isLoading } = useQuery({
    queryKey: ["case", labCase.id],
    queryFn: () => apiFetch<DetailedCase>(`/cases/${labCase.id}`),
  });

  const invoiceQuery = useQuery({
    queryKey: ["invoice-for-case", labCase.id],
    queryFn: () =>
      apiFetch<Invoice[]>(`/invoices?caseId=${encodeURIComponent(labCase.id)}`),
  });
  const caseInvoice = invoiceQuery.data?.[0] ?? null;

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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      setRouteStatus("");
      setRouteError(null);
      setRouteSuccess(true);
      setTimeout(() => setRouteSuccess(false), 3000);
    },
    onError: (e: Error) => setRouteError(e.message),
  });

  const addNoteMutation = useMutation({
    mutationFn: ({ text, visibility }: { text: string; visibility: string }) =>
      apiFetch(`/cases/${labCase.id}/notes`, {
        method: "POST",
        body: JSON.stringify({ noteText: text, visibility }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      setNoteText("");
      setNoteError(null);
    },
    onError: (e: Error) => setNoteError(e.message),
  });

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

  const deleteCaseMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/cases/${labCase.id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      onClose();
    },
    onError: (e: Error) => {
      window.alert(e.message || "Could not delete case.");
      setConfirmDeleteCase(false);
    },
  });

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setUploadingFile(true);
    setUploadError(null);
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
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
    } catch (err: any) {
      setUploadError(err?.message || "Upload failed.");
    } finally {
      setUploadingFile(false);
    }
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
    { id: "history", label: "History", count: data?.events?.length },
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

              {/* Route Case */}
              <section>
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2">
                  Route Case
                </h3>
                <div className="flex gap-2">
                  <select
                    value={routeStatus}
                    onChange={(e) => { setRouteStatus(e.target.value); setRouteError(null); }}
                    className="flex-1 h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                  >
                    <option value="">Move to station…</option>
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
                    {routeMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : "Route"}
                  </button>
                </div>
                {routeError && <p className="mt-1.5 text-xs text-destructive">{routeError}</p>}
                {routeSuccess && (
                  <p className="mt-1.5 text-xs text-green-600">Status updated successfully.</p>
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
                <button
                  type="button"
                  onClick={() => { setShowAddRest((v) => !v); setRestError(null); }}
                  className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Plus size={12} />
                  {showAddRest ? "Cancel" : "Add restoration"}
                </button>
              </div>

              {showAddRest && (
                <div className="border border-border rounded-lg p-4 space-y-3 bg-secondary/20">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    New restoration
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
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ── NOTES ── */}
          {activeTab === "notes" && (
            <div className="px-5 py-5 space-y-4">
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                Notes
              </h3>
              {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
              <div className="space-y-2">
                {!isLoading && noteCount === 0 && (
                  <div className="text-sm text-muted-foreground">No notes yet.</div>
                )}
                {data?.notes?.map((n) => (
                  <div key={n.id} className="border border-border rounded-md px-3 py-2.5 text-sm">
                    <p className="leading-relaxed whitespace-pre-wrap">{n.noteText || "—"}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      {n.visibility === "internal_lab_only" ? (
                        <span className="inline-flex items-center gap-1 text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
                          <Lock size={9} /> Lab only
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded bg-secondary text-muted-foreground border border-border">
                          Shared
                        </span>
                      )}
                      {n.createdAt && (
                        <span className="text-[11px] text-muted-foreground">
                          {relativeTime(n.createdAt)}
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
                <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-border">
                  <select
                    value={noteVis}
                    onChange={(e) =>
                      setNoteVis(e.target.value as "internal_lab_only" | "shared_with_provider")
                    }
                    className="h-7 px-2 rounded bg-secondary text-xs border border-transparent focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <option value="shared_with_provider">Shared with provider</option>
                    <option value="internal_lab_only">Internal only</option>
                  </select>
                  <button
                    type="button"
                    disabled={!noteText.trim() || addNoteMutation.isPending}
                    onClick={() => addNoteMutation.mutate({ text: noteText, visibility: noteVis })}
                    className="h-7 px-3 rounded bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                  >
                    {addNoteMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : "Add note"}
                  </button>
                </div>
                {noteError && <p className="text-xs text-destructive">{noteError}</p>}
              </div>
            </div>
          )}

          {/* ── FILES ── */}
          {activeTab === "files" && (
            <div className="px-5 py-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                  Attachments
                </h3>
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
              <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange} />
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
                          {images.map((a) => (
                            <div key={a.id} className="relative group">
                              <button
                                type="button"
                                onClick={() => setLightboxUrl(a.storageKey)}
                                className="relative w-full aspect-square rounded-lg overflow-hidden bg-secondary block"
                                title={a.fileName}
                              >
                                <img
                                  src={a.storageKey}
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
                          ))}
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
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                Invoice
              </h3>
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
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-4">
                Activity Log
              </h3>
              {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
              {!isLoading && (data?.events?.length ?? 0) === 0 && (
                <div className="text-sm text-muted-foreground">No activity logged yet.</div>
              )}
              <div>
                {data?.events?.map((e, idx, arr) => {
                  const isLast = idx === arr.length - 1;
                  const eventType = e.eventType || "";
                  const isStatus = eventType === "status_changed";
                  const isNote = eventType === "note_added";
                  const isAttachment = eventType.includes("attachment");
                  const isInvoice = eventType.includes("invoice");
                  const isRestoration = eventType.includes("restoration");
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
                        {!isLast && <div className="w-px flex-1 bg-border mt-1.5" />}
                      </div>
                      <div className="flex-1 min-w-0 -mt-0.5">
                        <div className="flex items-start justify-between gap-2">
                          <div className="text-sm font-medium">{formatEventType(e.eventType)}</div>
                          <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
                            {relativeTime(e.occurredAt || e.createdAt)}
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
                      </div>
                    </div>
                  );
                })}
              </div>
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
          onClick={() => !deleteCaseMutation.isPending && setConfirmDeleteCase(false)}
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
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setConfirmDeleteCase(false)}
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
            {r.shade && <span className="text-muted-foreground"> · {r.shade}</span>}
          </div>
          {r.material && (
            <div className="text-xs text-muted-foreground">{r.material}</div>
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

function AttachmentRow({
  caseId,
  attachment,
  canManage,
}: {
  caseId: string;
  attachment: CaseAttachment;
  canManage: boolean;
}) {
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
  const href = attachment.storageKey;

  function onDelete() {
    if (deleteMutation.isPending) return;
    if (!window.confirm(`Delete "${attachment.fileName}"?`)) return;
    deleteMutation.mutate();
  }

  function onToggleVisibility() {
    if (visibilityMutation.isPending) return;
    visibilityMutation.mutate();
  }

  return (
    <div className="border border-border rounded-md px-3 py-2 text-sm flex items-start gap-3">
      <div className="mt-0.5 text-muted-foreground">
        <Paperclip size={14} />
      </div>
      <div className="min-w-0 flex-1">
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
          {isImage ? "Image" : attachment.fileType || "File"}
          {attachment.uploaderName ? ` · ${attachment.uploaderName}` : ""}
          {attachment.createdAt ? ` · ${relativeTime(attachment.createdAt)}` : ""}
        </div>
      </div>
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
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="h-7 w-7 rounded hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground"
            title="Open file"
          >
            <ExternalLink size={13} />
          </a>
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
