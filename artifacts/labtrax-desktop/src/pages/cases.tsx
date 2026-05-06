import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  Filter,
  Loader2,
  Plus,
  Search,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import type {
  CaseEvent,
  CaseRestoration,
  LabCase,
  Organization,
  PricingHistoryEntry,
  PricingOverride,
  PricingTier,
  RestorationPriceSource,
} from "@/lib/types";
import { formatDate, formatMoney, relativeTime, statusLabel } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";

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
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const rand = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0");
  return `LT-${yy}${mm}${dd}-${rand}`;
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
              <select
                className="w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                value={form.providerOrganizationId}
                onChange={(e) => set("providerOrganizationId", e.target.value)}
              >
                <option value="">Select practice…</option>
                {providerOrgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.displayName || o.name}
                  </option>
                ))}
              </select>
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

      {selected && <CaseDrawer labCase={selected} onClose={() => setSelected(null)} />}
      {showNewCase && <NewCaseModal onClose={() => setShowNewCase(false)} />}
    </div>
  );
}

function CaseDrawer({
  labCase,
  onClose,
}: {
  labCase: LabCase;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["case", labCase.id],
    queryFn: () =>
      apiFetch<
        LabCase & {
          restorations: CaseRestoration[];
          notes: Array<{ id: string; body?: string | null; createdAt?: string | null }>;
          events: CaseEvent[];
        }
      >(`/cases/${labCase.id}`),
  });

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-foreground/30" onClick={onClose} />
      <aside className="w-full max-w-[520px] bg-card border-l border-border h-full flex flex-col">
        <header className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Case</div>
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
          <div className="grid grid-cols-2 gap-4 text-sm">
            <Field label="Patient" value={`${labCase.patientFirstName} ${labCase.patientLastName}`} />
            <Field label="Doctor" value={labCase.doctorName} />
            <Field label="Status" value={statusLabel(labCase.status)} />
            <Field label="Priority" value={labCase.priority === "rush" ? "Rush" : "Normal"} />
            <Field label="Due date" value={formatDate(labCase.dueDate)} />
            <Field label="Created" value={formatDate(labCase.createdAt)} />
          </div>

          <section>
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2">
              Restorations
            </h3>
            {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
            {!isLoading && (data?.restorations?.length ?? 0) === 0 && (
              <div className="text-sm text-muted-foreground">No restorations on this case.</div>
            )}
            <div className="space-y-2">
              {data?.restorations?.map((r) => (
                <RestorationRow
                  key={r.id}
                  restoration={r}
                  labOrganizationId={labCase.labOrganizationId}
                />
              ))}
            </div>
          </section>

          <section>
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2">
              Recent activity
            </h3>
            {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
            {!isLoading && (data?.events?.length ?? 0) === 0 && (
              <div className="text-sm text-muted-foreground">No activity logged.</div>
            )}
            <ul className="space-y-1.5">
              {data?.events?.slice(0, 8).map((e) => (
                <li
                  key={e.id}
                  className="text-sm flex items-start justify-between gap-3 border-l-2 border-primary/40 pl-3"
                >
                  <div>
                    <div className="font-medium">{e.eventType?.replace(/_/g, " ")}</div>
                    <div className="text-xs text-muted-foreground">
                      {e.actorInitials || "—"}
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {relativeTime(e.occurredAt || e.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </aside>
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
  labOrganizationId,
}: {
  restoration: CaseRestoration;
  labOrganizationId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const source = (r.priceSource ?? null) as RestorationPriceSource | null;
  const style = source ? PRICE_SOURCE_STYLES[source] : null;
  const hasHistorySource =
    source === "tier" || source === "override" || source === "default";

  return (
    <div className="border border-border rounded-md px-3 py-2 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">
            {r.restorationType}
            <span className="text-muted-foreground"> · Tooth {r.toothNumber}</span>
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
        <div className="text-right whitespace-nowrap">
          <div className="text-xs text-muted-foreground tabular-nums">
            Qty {r.quantity}
          </div>
          <div className="text-sm tabular-nums">
            {formatMoney(r.unitPrice)}
          </div>
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
