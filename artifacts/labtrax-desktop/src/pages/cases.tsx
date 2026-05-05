import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  Filter,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { LabCase } from "@/lib/types";
import { formatDate, relativeTime, statusLabel } from "@/lib/format";
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

type SortKey = "caseNumber" | "doctorName" | "status" | "dueDate" | "createdAt";

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
        <div className="text-sm text-muted-foreground">
          {filtered.length} of {data?.length ?? 0}
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
                <th className="text-left py-2.5">Priority</th>
                <th className="text-left py-2.5"><SortHeader k="status">Status</SortHeader></th>
                <th className="text-left py-2.5"><SortHeader k="dueDate">Due</SortHeader></th>
                <th className="text-left px-5 py-2.5"><SortHeader k="createdAt">Created</SortHeader></th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading cases…
                  </td>
                </tr>
              )}
              {error && (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-destructive">
                    {(error as Error).message}
                  </td>
                </tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-muted-foreground">
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
                  <td className="px-5 py-3 text-muted-foreground">{relativeTime(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && <CaseDrawer labCase={selected} onClose={() => setSelected(null)} />}
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
      apiFetch<LabCase & { restorations: any[]; notes: any[]; events: any[] }>(
        `/cases/${labCase.id}`,
      ),
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
              {data?.restorations?.map((r: any) => (
                <div
                  key={r.id}
                  className="border border-border rounded-md px-3 py-2 text-sm flex items-center justify-between"
                >
                  <div>
                    <div className="font-medium">
                      {r.restorationType}
                      <span className="text-muted-foreground"> · Tooth {r.toothNumber}</span>
                    </div>
                    {r.material && (
                      <div className="text-xs text-muted-foreground">{r.material}</div>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    Qty {r.quantity}
                  </div>
                </div>
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
              {data?.events?.slice(0, 8).map((e: any) => (
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
