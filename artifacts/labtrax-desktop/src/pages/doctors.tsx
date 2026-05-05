import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Loader2, Search, Stethoscope, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { Invoice, LabCase } from "@/lib/types";
import { formatDate, formatMoney, relativeTime } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";

interface DoctorRow {
  key: string;
  doctorName: string;
  practiceName: string;
  practiceId: string;
  totalCases: number;
  openCases: number;
  rushCases: number;
  totalBilled: number;
  lastCaseAt: string | null;
}

type SortKey = "doctorName" | "practiceName" | "totalCases" | "openCases" | "totalBilled" | "lastCaseAt";

const OPEN_STATUSES = new Set([
  "received",
  "in_design",
  "in_milling",
  "in_porcelain",
  "qc",
  "on_hold",
  "remake",
]);

export default function DoctorsPage() {
  const casesQuery = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
  });
  const invoicesQuery = useQuery({
    queryKey: ["invoices"],
    queryFn: () => apiFetch<Invoice[]>("/invoices"),
  });

  const [search, setSearch] = useState("");
  const [practiceFilter, setPracticeFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("totalCases");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<DoctorRow | null>(null);

  const cases = casesQuery.data ?? [];
  const invoices = invoicesQuery.data ?? [];

  const rows = useMemo<DoctorRow[]>(() => {
    const billedByCase = new Map<string, number>();
    for (const inv of invoices) {
      if (!inv.caseId) continue;
      billedByCase.set(inv.caseId, (billedByCase.get(inv.caseId) ?? 0) + Number(inv.total ?? 0));
    }
    const map = new Map<string, DoctorRow>();
    for (const c of cases) {
      const doc = (c.doctorName || "—").trim();
      const practiceId = c.providerOrganizationId || "";
      const key = `${doc.toLowerCase()}|${practiceId}`;
      const billed = billedByCase.get(c.id) ?? Number(c.totalPrice ?? 0);
      const created = c.createdAt || null;
      const existing = map.get(key);
      if (existing) {
        existing.totalCases += 1;
        if (OPEN_STATUSES.has(c.status)) existing.openCases += 1;
        if (c.priority === "rush") existing.rushCases += 1;
        existing.totalBilled += billed;
        if (created && (!existing.lastCaseAt || created > existing.lastCaseAt)) {
          existing.lastCaseAt = created;
        }
      } else {
        map.set(key, {
          key,
          doctorName: doc,
          practiceName: "",
          practiceId,
          totalCases: 1,
          openCases: OPEN_STATUSES.has(c.status) ? 1 : 0,
          rushCases: c.priority === "rush" ? 1 : 0,
          totalBilled: billed,
          lastCaseAt: created,
        });
      }
    }
    // Annotate practice names from invoices.providerOrganization where possible
    const orgNames = new Map<string, string>();
    for (const inv of invoices) {
      if (inv.providerOrganization?.id && inv.providerOrganization?.name) {
        orgNames.set(inv.providerOrganization.id, inv.providerOrganization.name);
      }
    }
    for (const r of map.values()) {
      r.practiceName = orgNames.get(r.practiceId) || "Unknown practice";
    }
    return Array.from(map.values());
  }, [cases, invoices]);

  const practices = useMemo(() => {
    const set = new Map<string, string>();
    for (const r of rows) set.set(r.practiceId, r.practiceName);
    return Array.from(set.entries()).map(([id, name]) => ({ id, name }));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) => {
        if (practiceFilter !== "all" && r.practiceId !== practiceFilter) return false;
        if (!q) return true;
        return (
          r.doctorName.toLowerCase().includes(q) ||
          r.practiceName.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const va = a[sortKey];
        const vb = b[sortKey];
        if (typeof va === "number" && typeof vb === "number") {
          return sortDir === "asc" ? va - vb : vb - va;
        }
        const sa = (va ?? "") as string;
        const sb = (vb ?? "") as string;
        return sortDir === "asc" ? sa.localeCompare(sb) : sb.localeCompare(sa);
      });
  }, [rows, search, practiceFilter, sortKey, sortDir]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  }

  function SortHeader({ k, children, align = "left" }: { k: SortKey; children: React.ReactNode; align?: "left" | "right" }) {
    return (
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className={`inline-flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground font-medium hover:text-foreground ${align === "right" ? "justify-end" : ""}`}
      >
        {children}
        {sortKey === k && (sortDir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
      </button>
    );
  }

  const isLoading = casesQuery.isLoading || invoicesQuery.isLoading;
  const error = (casesQuery.error || invoicesQuery.error) as Error | null;

  return (
    <div className="px-8 py-7">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Doctors</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every doctor your lab is producing for, with billing rolled up across cases.
          </p>
        </div>
        <div className="text-sm text-muted-foreground">
          {filtered.length} of {rows.length}
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search doctor or practice…"
              className="w-full h-9 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
            />
          </div>
          <select
            value={practiceFilter}
            onChange={(e) => setPracticeFilter(e.target.value)}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          >
            <option value="all">All practices</option>
            {practices.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40">
                <th className="text-left px-5 py-2.5"><SortHeader k="doctorName">Doctor</SortHeader></th>
                <th className="text-left py-2.5"><SortHeader k="practiceName">Practice</SortHeader></th>
                <th className="text-right py-2.5"><SortHeader k="totalCases" align="right">Cases</SortHeader></th>
                <th className="text-right py-2.5"><SortHeader k="openCases" align="right">Open</SortHeader></th>
                <th className="text-right py-2.5">Rush</th>
                <th className="text-right py-2.5"><SortHeader k="totalBilled" align="right">Billed</SortHeader></th>
                <th className="text-left px-5 py-2.5"><SortHeader k="lastCaseAt">Last case</SortHeader></th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading doctors…
                  </td>
                </tr>
              )}
              {error && (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-destructive">
                    {error.message}
                  </td>
                </tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-muted-foreground">
                    No doctors yet. Doctors appear here as soon as cases reference them.
                  </td>
                </tr>
              )}
              {filtered.map((r) => (
                <tr
                  key={r.key}
                  onClick={() => setSelected(r)}
                  className="border-t border-border cursor-pointer hover:bg-secondary/40"
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="h-7 w-7 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                        <Stethoscope size={13} />
                      </div>
                      <div className="font-medium">{r.doctorName}</div>
                    </div>
                  </td>
                  <td className="py-3 text-muted-foreground">{r.practiceName}</td>
                  <td className="py-3 text-right tabular-nums">{r.totalCases}</td>
                  <td className="py-3 text-right tabular-nums">{r.openCases}</td>
                  <td className="py-3 text-right tabular-nums">
                    {r.rushCases > 0 ? (
                      <span className="text-destructive font-medium">{r.rushCases}</span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </td>
                  <td className="py-3 text-right tabular-nums font-medium">{formatMoney(r.totalBilled)}</td>
                  <td className="px-5 py-3 text-muted-foreground">{relativeTime(r.lastCaseAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <DoctorDrawer
          doctor={selected}
          cases={cases.filter((c) => (c.doctorName || "").toLowerCase() === selected.doctorName.toLowerCase() && c.providerOrganizationId === selected.practiceId)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function DoctorDrawer({ doctor, cases, onClose }: { doctor: DoctorRow; cases: LabCase[]; onClose: () => void }) {
  const sorted = [...cases].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-foreground/30" onClick={onClose} />
      <aside className="w-full max-w-[520px] bg-card border-l border-border h-full flex flex-col">
        <header className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Doctor</div>
            <div className="text-sm font-semibold">{doctor.doctorName}</div>
          </div>
          <button type="button" onClick={onClose} className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center">
            <X size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <Field label="Practice" value={doctor.practiceName} />
            <Field label="Total cases" value={String(doctor.totalCases)} />
            <Field label="Open cases" value={String(doctor.openCases)} />
            <Field label="Rush cases" value={String(doctor.rushCases)} />
            <Field label="Total billed" value={formatMoney(doctor.totalBilled)} />
            <Field label="Last case" value={formatDate(doctor.lastCaseAt)} />
          </div>

          <section>
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2">Recent cases</h3>
            {sorted.length === 0 && <div className="text-sm text-muted-foreground">No cases.</div>}
            <ul className="space-y-1.5">
              {sorted.slice(0, 12).map((c) => (
                <li key={c.id} className="flex items-center justify-between border border-border rounded-md px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="font-mono text-xs">{c.caseNumber}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {c.patientFirstName} {c.patientLastName} · {relativeTime(c.createdAt)}
                    </div>
                  </div>
                  <StatusBadge status={c.status} />
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
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{label}</div>
      <div className="text-sm mt-0.5">{value || "—"}</div>
    </div>
  );
}
