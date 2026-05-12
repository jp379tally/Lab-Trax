import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  GitMerge,
  Loader2,
  Search,
  Stethoscope,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { Invoice, LabCase, Organization } from "@/lib/types";
import { formatDate, formatMoney, relativeTime } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";

interface DoctorRow {
  key: string;
  doctorName: string;
  practiceName: string;
  practiceId: string;
  labOrganizationId: string;
  totalCases: number;
  openCases: number;
  rushCases: number;
  totalBilled: number;
  lastCaseAt: string | null;
}

type SortKey =
  | "doctorName"
  | "practiceName"
  | "totalCases"
  | "openCases"
  | "totalBilled"
  | "lastCaseAt";

const OPEN_STATUSES = new Set([
  "received",
  "in_design",
  "in_milling",
  "in_porcelain",
  "qc",
  "on_hold",
  "remake",
]);

const ADMIN_ROLES = new Set(["owner", "admin"]);

interface PracticeMember {
  id: string;
  role: string;
  status: string;
  userId: string;
}

export default function DoctorsPage() {
  const casesQuery = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
  });
  const invoicesQuery = useQuery({
    queryKey: ["invoices"],
    queryFn: () => apiFetch<Invoice[]>("/invoices"),
  });
  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
  });

  const [search, setSearch] = useState("");
  const [practiceFilter, setPracticeFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("totalCases");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<DoctorRow | null>(null);

  const cases = casesQuery.data ?? [];
  const invoices = invoicesQuery.data ?? [];
  const orgs = orgsQuery.data ?? [];

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
          labOrganizationId: c.labOrganizationId || "",
          totalCases: 1,
          openCases: OPEN_STATUSES.has(c.status) ? 1 : 0,
          rushCases: c.priority === "rush" ? 1 : 0,
          totalBilled: billed,
          lastCaseAt: created,
        });
      }
    }
    // Annotate practice names from /organizations first (most authoritative,
    // and reflects edits made from this page immediately), falling back to
    // names embedded in invoices for orgs the current user can't read.
    const orgNames = new Map<string, string>();
    for (const o of orgs) {
      orgNames.set(o.id, o.displayName || o.name);
    }
    for (const inv of invoices) {
      if (inv.providerOrganization?.id && inv.providerOrganization?.name && !orgNames.has(inv.providerOrganization.id)) {
        orgNames.set(inv.providerOrganization.id, inv.providerOrganization.name);
      }
    }
    for (const r of map.values()) {
      r.practiceName = orgNames.get(r.practiceId) || "Unknown practice";
    }
    return Array.from(map.values());
  }, [cases, invoices, orgs]);

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
          allDoctors={rows}
          cases={cases.filter((c) => (c.doctorName || "").toLowerCase() === selected.doctorName.toLowerCase() && c.providerOrganizationId === selected.practiceId)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

interface PracticeFields {
  name: string;
  displayName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  accountNumber: string;
}

function DoctorDrawer({
  doctor,
  allDoctors,
  cases,
  onClose,
}: {
  doctor: DoctorRow;
  allDoctors: DoctorRow[];
  cases: LabCase[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const sorted = [...cases].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const practiceQuery = useQuery({
    queryKey: ["organization", doctor.practiceId],
    queryFn: () => apiFetch<Organization>(`/organizations/${doctor.practiceId}`),
    enabled: !!doctor.practiceId,
  });
  const practice = practiceQuery.data;
  const labId = practice?.parentLabOrganizationId || doctor.labOrganizationId;

  const labMembersQuery = useQuery({
    queryKey: ["organization", labId, "members"],
    queryFn: () => apiFetch<PracticeMember[]>(`/organizations/${labId}/members`),
    enabled: !!labId,
  });
  const myMembership = labMembersQuery.data?.find((m) => m.userId === user?.id);
  const isLabAdmin = !!myMembership && ADMIN_ROLES.has(myMembership.role);

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-foreground/30" onClick={onClose} />
      <aside className="w-full max-w-[560px] bg-card border-l border-border h-full flex flex-col">
        <header className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Doctor</div>
            <div className="text-sm font-semibold">{doctor.doctorName}</div>
          </div>
          <button type="button" onClick={onClose} className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center">
            <X size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <Field label="Practice" value={doctor.practiceName} />
            <Field label="Total cases" value={String(doctor.totalCases)} />
            <Field label="Open cases" value={String(doctor.openCases)} />
            <Field label="Rush cases" value={String(doctor.rushCases)} />
            <Field label="Total billed" value={formatMoney(doctor.totalBilled)} />
            <Field label="Last case" value={formatDate(doctor.lastCaseAt)} />
          </div>

          {isLabAdmin && practice && (
            <EditPracticeSection
              practice={practice}
              onSaved={() => {
                queryClient.invalidateQueries({ queryKey: ["organizations"] });
                queryClient.invalidateQueries({ queryKey: ["organization", doctor.practiceId] });
                queryClient.invalidateQueries({ queryKey: ["invoices"] });
              }}
            />
          )}

          {isLabAdmin && (
            <MergeDoctorSection
              source={doctor}
              candidates={allDoctors.filter((d) => d.key !== doctor.key && d.labOrganizationId === doctor.labOrganizationId)}
              onMerged={() => {
                queryClient.invalidateQueries({ queryKey: ["cases"] });
                queryClient.invalidateQueries({ queryKey: ["invoices"] });
                onClose();
              }}
            />
          )}

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

const inputCls =
  "w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary";

function EditPracticeSection({
  practice,
  onSaved,
}: {
  practice: Organization;
  onSaved: () => void;
}) {
  const [fields, setFields] = useState<PracticeFields>({
    name: practice.name || "",
    displayName: practice.displayName || "",
    addressLine1: practice.addressLine1 || "",
    addressLine2: practice.addressLine2 || "",
    city: practice.city || "",
    state: practice.state || "",
    zip: practice.zip || "",
    phone: practice.phone || "",
    accountNumber: practice.accountNumber || "",
  });
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setFields({
      name: practice.name || "",
      displayName: practice.displayName || "",
      addressLine1: practice.addressLine1 || "",
      addressLine2: practice.addressLine2 || "",
      city: practice.city || "",
      state: practice.state || "",
      zip: practice.zip || "",
      phone: practice.phone || "",
      accountNumber: practice.accountNumber || "",
    });
  }, [practice]);

  const canEditAccountNumber =
    practice.type === "provider" && !!practice.parentLabOrganizationId;

  const saveMutation = useMutation({
    mutationFn: () => {
      const { accountNumber, ...rest } = fields;
      const payload: Record<string, unknown> = { ...rest };
      if (canEditAccountNumber) payload.accountNumber = accountNumber;
      return apiFetch<Organization>(`/organizations/${practice.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      setError(null);
      setSavedAt(Date.now());
      onSaved();
    },
    onError: (err: Error) => {
      setSavedAt(null);
      setError(err.message || "Save failed.");
    },
  });

  function update<K extends keyof PracticeFields>(key: K, value: PracticeFields[K]) {
    setFields((p) => ({ ...p, [key]: value }));
  }

  return (
    <section className="border border-border rounded-md p-4">
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-3">
        Edit practice
      </h3>

      {error && (
        <div className="mb-3 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
          {error}
        </div>
      )}
      {savedAt && !error && (
        <div className="mb-3 text-sm text-emerald-600 bg-emerald-500/10 px-3 py-2 rounded-md">
          Practice updated.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <FormField label="Legal name">
          <input value={fields.name} onChange={(e) => update("name", e.target.value)} className={inputCls} />
        </FormField>
        <FormField label="Display name">
          <input value={fields.displayName} onChange={(e) => update("displayName", e.target.value)} className={inputCls} />
        </FormField>
        <FormField label="Address line 1" full>
          <input value={fields.addressLine1} onChange={(e) => update("addressLine1", e.target.value)} className={inputCls} />
        </FormField>
        <FormField label="Address line 2" full>
          <input value={fields.addressLine2} onChange={(e) => update("addressLine2", e.target.value)} className={inputCls} />
        </FormField>
        <FormField label="City">
          <input value={fields.city} onChange={(e) => update("city", e.target.value)} className={inputCls} />
        </FormField>
        <FormField label="State">
          <input value={fields.state} onChange={(e) => update("state", e.target.value)} className={inputCls} />
        </FormField>
        <FormField label="ZIP">
          <input value={fields.zip} onChange={(e) => update("zip", e.target.value)} className={inputCls} />
        </FormField>
        <FormField label="Phone">
          <input value={fields.phone} onChange={(e) => update("phone", e.target.value)} className={inputCls} />
        </FormField>
        {canEditAccountNumber && (
          <FormField label="Account number" full>
            <input
              value={fields.accountNumber}
              onChange={(e) => update("accountNumber", e.target.value)}
              className={inputCls}
              placeholder="e.g. 123-JS-1"
            />
            <div className="text-[11px] text-muted-foreground mt-1">
              Must be unique within your lab.
            </div>
          </FormField>
        )}
      </div>

      <div className="flex justify-end mt-4">
        <button
          type="button"
          onClick={() => {
            setError(null);
            setSavedAt(null);
            saveMutation.mutate();
          }}
          disabled={saveMutation.isPending}
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
        >
          {saveMutation.isPending ? "Saving…" : "Save practice"}
        </button>
      </div>
    </section>
  );
}

function MergeDoctorSection({
  source,
  candidates,
  onMerged,
}: {
  source: DoctorRow;
  candidates: DoctorRow[];
  onMerged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<DoctorRow | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates.slice(0, 50);
    return candidates
      .filter(
        (d) =>
          d.doctorName.toLowerCase().includes(q) ||
          d.practiceName.toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [candidates, search]);

  const mergeMutation = useMutation({
    mutationFn: () => {
      if (!target) throw new Error("Pick a target doctor first.");
      return apiFetch<{ casesMoved: number }>(`/doctors/merge`, {
        method: "POST",
        body: JSON.stringify({
          sourceDoctorName: source.doctorName,
          sourceProviderOrganizationId: source.practiceId,
          targetDoctorName: target.doctorName,
          targetProviderOrganizationId: target.practiceId,
        }),
      });
    },
    onSuccess: () => {
      setError(null);
      setConfirming(false);
      setOpen(false);
      onMerged();
    },
    onError: (err: Error) => setError(err.message || "Merge failed."),
  });

  return (
    <section className="border border-border rounded-md p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
            Merge into another doctor
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Combine duplicate spellings of the same doctor. Every case moves to the
            target; this doctor disappears from the list.
          </p>
        </div>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border text-sm hover:bg-secondary"
          >
            <GitMerge size={14} />
            Merge
          </button>
        )}
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setTarget(null);
              }}
              placeholder="Search doctor or practice…"
              className="w-full h-9 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
            />
          </div>

          <div className="max-h-64 overflow-y-auto border border-border rounded-md divide-y divide-border">
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                No other doctors in this lab.
              </div>
            )}
            {filtered.map((d) => (
              <button
                type="button"
                key={d.key}
                onClick={() => setTarget(d)}
                className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-secondary/60 ${target?.key === d.key ? "bg-secondary" : ""}`}
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">{d.doctorName}</div>
                  <div className="text-xs text-muted-foreground truncate">{d.practiceName}</div>
                </div>
                <div className="text-xs text-muted-foreground tabular-nums ml-2 shrink-0">
                  {d.totalCases} case{d.totalCases === 1 ? "" : "s"}
                </div>
              </button>
            ))}
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setSearch("");
                setTarget(null);
                setError(null);
              }}
              className="h-9 px-3 rounded-md text-sm hover:bg-secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!target}
              onClick={() => {
                setError(null);
                setConfirming(true);
              }}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {confirming && target && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/40">
          <div className="bg-card border border-border rounded-lg shadow-xl max-w-md w-full p-6">
            <h4 className="text-base font-semibold">Merge doctors?</h4>
            <p className="text-sm text-muted-foreground mt-2">
              Move <span className="font-medium text-foreground">{source.totalCases}</span>{" "}
              case{source.totalCases === 1 ? "" : "s"} from{" "}
              <span className="font-medium text-foreground">{source.doctorName}</span>{" "}
              ({source.practiceName}) to{" "}
              <span className="font-medium text-foreground">{target.doctorName}</span>{" "}
              ({target.practiceName}).
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              The source doctor will disappear from the doctors list. This action is
              recorded in the audit log but cannot be undone in one click.
            </p>
            {error && (
              <div className="mt-3 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={mergeMutation.isPending}
                className="h-9 px-3 rounded-md text-sm hover:bg-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => mergeMutation.mutate()}
                disabled={mergeMutation.isPending}
                className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
              >
                {mergeMutation.isPending ? "Merging…" : "Merge doctors"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function FormField({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={full ? "col-span-2" : ""}>
      <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
        {label}
      </label>
      {children}
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
