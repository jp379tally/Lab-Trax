import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckSquare,
  ChevronDown,
  ChevronUp,
  GitMerge,
  Loader2,
  Search,
  Square,
  Stethoscope,
  Undo2,
  X,
} from "lucide-react";
import {
  useMergeDoctors,
  usePreviewDoctorMerge,
  useUndoDoctorMerge,
  type DoctorMergeRequest,
  type DoctorSearchEntry,
  searchDoctors,
} from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { Invoice, LabCase, MeResponse, Organization } from "@/lib/types";
import { formatDate, formatMoney, relativeTime } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";

export interface MergeSourceInput {
  doctorName: string;
  providerOrganizationId: string | null;
  practiceName: string;
}

export interface UndoToast {
  auditLogIds: string[];
  message: string;
  expiresAt: number;
}

function normalizeForCompare(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bdr\.?\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function bigramSimilarity(a: string, b: string): number {
  const an = normalizeForCompare(a);
  const bn = normalizeForCompare(b);
  if (!an || !bn) return 0;
  if (an === bn) return 1;
  const grams = (s: string) => {
    const set = new Set<string>();
    const padded = ` ${s} `;
    for (let i = 0; i < padded.length - 1; i++) set.add(padded.slice(i, i + 2));
    return set;
  };
  const A = grams(an);
  const B = grams(bn);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface DoctorRow {
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
  const meQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
  });
  const adminLabIds = useMemo(() => {
    const set = new Set<string>();
    for (const m of meQuery.data?.memberships ?? []) {
      if (m.status !== "active") continue;
      if (!ADMIN_ROLES.has(m.role)) continue;
      if (m.organization?.type === "lab") set.add(m.organizationId);
    }
    return set;
  }, [meQuery.data]);

  const [search, setSearch] = useState("");
  const [practiceFilter, setPracticeFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("totalCases");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<DoctorRow | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [mergeDialog, setMergeDialog] = useState<{
    sources: MergeSourceInput[];
    labOrganizationId: string;
  } | null>(null);
  const [undoToast, setUndoToast] = useState<UndoToast | null>(null);
  const queryClientPage = useQueryClient();

  const undoMutation = useUndoDoctorMerge({
    mutation: {
      onSuccess: () => {
        queryClientPage.invalidateQueries({ queryKey: ["cases"] });
        queryClientPage.invalidateQueries({ queryKey: ["invoices"] });
        setUndoToast(null);
      },
    },
  });

  // Drop expired undo toasts so the button doesn't 409 the user.
  useEffect(() => {
    if (!undoToast) return;
    const remaining = undoToast.expiresAt - Date.now();
    if (remaining <= 0) {
      setUndoToast(null);
      return;
    }
    const t = window.setTimeout(() => setUndoToast(null), remaining);
    return () => window.clearTimeout(t);
  }, [undoToast]);

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
          {picked.size > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {picked.size} selected
              </span>
              <button
                type="button"
                onClick={() => setPicked(new Set())}
                className="h-9 px-3 rounded-md text-sm hover:bg-secondary"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => {
                  const sources: MergeSourceInput[] = [];
                  let labId = "";
                  for (const r of rows) {
                    if (!picked.has(r.key)) continue;
                    if (!labId) labId = r.labOrganizationId;
                    sources.push({
                      doctorName: r.doctorName,
                      providerOrganizationId: r.practiceId || null,
                      practiceName: r.practiceName,
                    });
                  }
                  if (!labId || sources.length === 0) return;
                  setMergeDialog({ sources, labOrganizationId: labId });
                }}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90"
              >
                <GitMerge size={14} />
                Merge selected
              </button>
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40">
                <th className="w-9 px-3 py-2.5"></th>
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
                  <td colSpan={8} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading doctors…
                  </td>
                </tr>
              )}
              {error && (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-destructive">
                    {error.message}
                  </td>
                </tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-muted-foreground">
                    No doctors yet. Doctors appear here as soon as cases reference them.
                  </td>
                </tr>
              )}
              {filtered.map((r) => {
                const canSelect = adminLabIds.has(r.labOrganizationId);
                const isPicked = picked.has(r.key);
                return (
                <tr
                  key={r.key}
                  onClick={() => setSelected(r)}
                  className="border-t border-border cursor-pointer hover:bg-secondary/40"
                >
                  <td
                    className="px-3 py-3"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!canSelect) return;
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (next.has(r.key)) {
                          next.delete(r.key);
                          return next;
                        }
                        // Merge runs against a single lab; if the user
                        // tries to mix labs, drop the prior selection
                        // rather than silently failing server-side.
                        const firstPickedLab = rows.find(
                          (x) => prev.has(x.key),
                        )?.labOrganizationId;
                        if (
                          firstPickedLab &&
                          firstPickedLab !== r.labOrganizationId
                        ) {
                          next.clear();
                        }
                        next.add(r.key);
                        return next;
                      });
                    }}
                  >
                    {canSelect ? (
                      isPicked ? (
                        <CheckSquare size={15} className="text-primary" />
                      ) : (
                        <Square size={15} className="text-muted-foreground" />
                      )
                    ) : null}
                  </td>
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
                );
              })}
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
          onMergeFromDrawer={(d) => {
            setMergeDialog({
              labOrganizationId: d.labOrganizationId,
              sources: [
                {
                  doctorName: d.doctorName,
                  providerOrganizationId: d.practiceId || null,
                  practiceName: d.practiceName,
                },
              ],
            });
          }}
        />
      )}

      {mergeDialog && (
        <MergeDialog
          labOrganizationId={mergeDialog.labOrganizationId}
          initialSources={mergeDialog.sources}
          onClose={() => setMergeDialog(null)}
          onMerged={(result) => {
            queryClientPage.invalidateQueries({ queryKey: ["cases"] });
            queryClientPage.invalidateQueries({ queryKey: ["invoices"] });
            setPicked(new Set());
            setSelected(null);
            setMergeDialog(null);
            setUndoToast({
              auditLogIds: result.auditLogIds,
              message: result.message,
              expiresAt: Date.now() + result.undoWindowMs,
            });
          }}
        />
      )}

      {undoToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] bg-foreground text-background rounded-lg shadow-xl px-4 py-3 flex items-center gap-3 max-w-xl">
          <div className="text-sm">{undoToast.message}</div>
          <button
            type="button"
            disabled={undoMutation.isPending}
            onClick={() => {
              for (const id of undoToast.auditLogIds) {
                undoMutation.mutate({ auditLogId: id });
              }
            }}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-background/10 text-sm font-semibold hover:bg-background/20 disabled:opacity-60"
          >
            <Undo2 size={13} />
            {undoMutation.isPending ? "Undoing…" : "Undo"}
          </button>
          <button
            type="button"
            onClick={() => setUndoToast(null)}
            className="h-8 w-8 rounded-md hover:bg-background/10 flex items-center justify-center"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
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

export function DoctorDrawer({
  doctor,
  cases,
  onClose,
  onMergeFromDrawer,
}: {
  doctor: DoctorRow;
  allDoctors: DoctorRow[];
  cases: LabCase[];
  onClose: () => void;
  onMergeFromDrawer: (d: DoctorRow) => void;
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
            <section className="border border-border rounded-md p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                    Merge into another doctor
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Move every case and pricing override from this doctor onto
                    a target. You'll see a preview before anything changes and
                    have 10 minutes to undo it.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onMergeFromDrawer(doctor)}
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border text-sm hover:bg-secondary shrink-0"
                >
                  <GitMerge size={14} />
                  Merge
                </button>
              </div>
            </section>
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

export interface MergeDialogResult {
  auditLogIds: string[];
  message: string;
  undoWindowMs: number;
}

export function MergeDialog({
  labOrganizationId,
  initialSources,
  onClose,
  onMerged,
}: {
  labOrganizationId: string;
  initialSources: MergeSourceInput[];
  onClose: () => void;
  onMerged: (r: MergeDialogResult) => void;
}) {
  const [sources, setSources] = useState<MergeSourceInput[]>(initialSources);
  const [targetMode, setTargetMode] = useState<"existing" | "new">("existing");
  const [targetName, setTargetName] = useState<string>(
    initialSources[0]?.doctorName ?? "",
  );
  const [targetProviderId, setTargetProviderId] = useState<string | null>(
    initialSources[0]?.providerOrganizationId ?? null,
  );
  const [targetPracticeName, setTargetPracticeName] = useState<string>(
    initialSources[0]?.practiceName ?? "",
  );
  const [includeSoftDeleted, setIncludeSoftDeleted] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const SEARCH_PAGE_SIZE = 100;
  const [searchOffset, setSearchOffset] = useState(0);
  const [searchAccumulated, setSearchAccumulated] = useState<DoctorSearchEntry[]>([]);
  const [searchTotal, setSearchTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Practices in this lab — used as the target practice picker for both
  // "new target" mode and to assign a practice to an existing target that
  // currently has none (practice-less doctors created from imports).
  const labPracticesQuery = useQuery({
    queryKey: ["organizations", "practices", labOrganizationId],
    queryFn: async () => {
      const all = await apiFetch<Organization[]>("/organizations");
      return all.filter(
        (o) =>
          o.type === "provider" &&
          o.parentLabOrganizationId === labOrganizationId,
      );
    },
  });
  const labPractices = labPracticesQuery.data ?? [];

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(searchInput.trim()), 200);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  // Reset paging when the search query changes.
  useEffect(() => {
    setSearchOffset(0);
    setSearchAccumulated([]);
    setSearchTotal(null);
  }, [debouncedSearch]);

  function setTargetPracticeId(id: string | null) {
    setTargetProviderId(id);
    if (!id) {
      setTargetPracticeName("");
      return;
    }
    const p = labPractices.find((x) => x.id === id);
    setTargetPracticeName(p?.displayName || p?.name || "");
  }

  // Server-backed search ranked by similarity to the first source name so
  // the picker surfaces likely duplicates first.
  const searchQuery = useQuery({
    queryKey: [
      "doctors",
      "search",
      labOrganizationId,
      debouncedSearch,
      sources[0]?.doctorName ?? "",
      searchOffset,
    ],
    queryFn: async () => {
      const res = await searchDoctors({
        labOrganizationId,
        ...(debouncedSearch ? { q: debouncedSearch } : {}),
        ...(sources[0]?.doctorName ? { like: sources[0].doctorName } : {}),
        limit: SEARCH_PAGE_SIZE,
        offset: searchOffset,
      });
      return {
        entries: res.data?.entries ?? [],
        total: res.data?.total ?? null,
      };
    },
    enabled: !!labOrganizationId,
  });

  // Accumulate paged results so "Show more" appends instead of replacing.
  useEffect(() => {
    const data = searchQuery.data;
    if (!data) return;
    if (typeof data.total === "number") setSearchTotal(data.total);
    if (searchOffset === 0) {
      setSearchAccumulated(data.entries);
    } else {
      setSearchAccumulated((prev) => {
        const seen = new Set(
          prev.map(
            (e) =>
              `${(e.doctorName ?? "").toLowerCase()}|${e.providerOrganizationId ?? ""}`,
          ),
        );
        const fresh = data.entries.filter(
          (e) =>
            !seen.has(
              `${(e.doctorName ?? "").toLowerCase()}|${e.providerOrganizationId ?? ""}`,
            ),
        );
        return [...prev, ...fresh];
      });
    }
  }, [searchQuery.data, searchOffset]);

  const sourceKeys = useMemo(() => {
    return new Set(
      sources.map(
        (s) =>
          `${s.doctorName.toLowerCase()}|${s.providerOrganizationId ?? ""}`,
      ),
    );
  }, [sources]);

  const previewBody = useMemo<DoctorMergeRequest>(
    () => ({
      labOrganizationId,
      sources: sources.map((s) => ({
        doctorName: s.doctorName,
        providerOrganizationId: s.providerOrganizationId,
      })),
      targetDoctorName: targetName.trim(),
      targetProviderOrganizationId: targetProviderId,
      includeSoftDeleted,
    }),
    [labOrganizationId, sources, targetName, targetProviderId, includeSoftDeleted],
  );

  const previewMutation = usePreviewDoctorMerge();
  useEffect(() => {
    if (!targetName.trim()) return;
    previewMutation.mutate({ data: previewBody });
    // Re-run when the body shape changes; mutation is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewBody]);
  const preview = previewMutation.data?.data;

  const mergeMutation = useMergeDoctors({
    mutation: {
      onSuccess: (res) => {
        const data = res.data;
        if (!data) {
          setError("Merge succeeded but the server returned no payload.");
          return;
        }
        const ids = (data.entries ?? [])
          .map((e) => e.auditLogId)
          .filter((x): x is string => !!x);
        const moved = data.casesMoved ?? 0;
        const ovMoved = (data.overridesMoved ?? 0) + (data.overridesCollapsed ?? 0);
        const parts = [`${moved} case${moved === 1 ? "" : "s"} merged`];
        if (ovMoved > 0) parts.push(`${ovMoved} pricing override${ovMoved === 1 ? "" : "s"}`);
        onMerged({
          auditLogIds: ids,
          message: `${parts.join(" + ")} into ${data.targetDoctorName ?? targetName}.`,
          // Server-driven undo window (DOCTOR_MERGE_UNDO_WINDOW_MINUTES);
          // falls back to 10 min if the server didn't send one.
          undoWindowMs:
            typeof data.undoWindowMs === "number" && data.undoWindowMs > 0
              ? data.undoWindowMs
              : 10 * 60 * 1000,
        });
      },
      onError: (err: unknown) => {
        const msg =
          (err as { message?: string })?.message ?? "Merge failed.";
        setError(msg);
      },
    },
  });

  function addSource(entry: DoctorSearchEntry) {
    const name = entry.doctorName ?? "";
    if (!name) return;
    const key = `${name.toLowerCase()}|${entry.providerOrganizationId ?? ""}`;
    if (sourceKeys.has(key)) return;
    setSources((prev) => [
      ...prev,
      {
        doctorName: name,
        providerOrganizationId: entry.providerOrganizationId ?? null,
        practiceName: entry.practiceName ?? "",
      },
    ]);
  }

  function removeSource(idx: number) {
    setSources((prev) => prev.filter((_, i) => i !== idx));
  }

  function pickAsTarget(entry: DoctorSearchEntry) {
    const name = entry.doctorName ?? "";
    if (!name) return;
    setTargetName(name);
    setTargetProviderId(entry.providerOrganizationId ?? null);
    setTargetPracticeName(entry.practiceName ?? "");
  }

  const targetSelfMerge = sources.some(
    (s) =>
      s.doctorName.trim().toLowerCase() === targetName.trim().toLowerCase() &&
      (s.providerOrganizationId ?? null) === (targetProviderId ?? null),
  );

  const canMerge =
    !!targetName.trim() &&
    !!targetProviderId &&
    sources.length > 0 &&
    !targetSelfMerge &&
    !mergeMutation.isPending;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/40 p-4">
      <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <header className="px-6 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Merge doctors</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              All cases and pricing overrides from the sources will be moved
              onto the target. You'll have 10 minutes to undo.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <section>
            <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2">
              Sources ({sources.length})
            </div>
            {sources.length === 0 ? (
              <div className="text-sm text-muted-foreground border border-dashed border-border rounded-md px-3 py-3">
                Add at least one source from the picker below.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {sources.map((s, i) => (
                  <li
                    key={`${s.doctorName}|${s.providerOrganizationId ?? ""}`}
                    className="flex items-center justify-between gap-2 border border-border rounded-md px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">{s.doctorName}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {s.practiceName || "(no practice)"}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeSource(i)}
                      className="h-7 w-7 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground"
                      aria-label="Remove source"
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                Target
              </div>
              <div className="flex items-center rounded-md border border-border text-xs overflow-hidden">
                <button
                  type="button"
                  onClick={() => setTargetMode("existing")}
                  className={`px-2 py-1 ${targetMode === "existing" ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-secondary/40"}`}
                >
                  Pick existing
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTargetMode("new");
                    setTargetName("");
                    setTargetPracticeId(null);
                  }}
                  className={`px-2 py-1 border-l border-border ${targetMode === "new" ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-secondary/40"}`}
                >
                  Create new
                </button>
              </div>
            </div>

            {targetMode === "existing" ? (
              <div className="border border-border rounded-md px-3 py-2 text-sm space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium truncate">
                      {targetName.trim() || "— pick a target from the list below —"}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {targetPracticeName ||
                        (targetProviderId
                          ? ""
                          : targetName.trim()
                            ? "(no practice on file — assign one below)"
                            : "")}
                    </div>
                  </div>
                  {targetSelfMerge && (
                    <span className="text-xs text-destructive ml-2 shrink-0">
                      Same as a source
                    </span>
                  )}
                </div>
                {targetName.trim() && !targetProviderId && (
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">
                      Assign a practice for this target doctor
                    </label>
                    <select
                      className="w-full h-8 px-2 rounded-md bg-secondary text-sm border border-transparent focus:border-primary focus:outline-none"
                      value=""
                      onChange={(e) =>
                        setTargetPracticeId(e.target.value || null)
                      }
                    >
                      <option value="">— choose a practice —</option>
                      {labPractices.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.displayName || p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            ) : (
              <div className="border border-border rounded-md px-3 py-2 text-sm space-y-2">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    New doctor name
                  </label>
                  <input
                    type="text"
                    value={targetName}
                    onChange={(e) => setTargetName(e.target.value)}
                    placeholder="e.g. Dr. Jane Smith"
                    className="w-full h-8 px-2 rounded-md bg-secondary text-sm border border-transparent focus:border-primary focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Practice <span className="text-destructive">*</span>
                  </label>
                  <select
                    className="w-full h-8 px-2 rounded-md bg-secondary text-sm border border-transparent focus:border-primary focus:outline-none"
                    value={targetProviderId ?? ""}
                    onChange={(e) =>
                      setTargetPracticeId(e.target.value || null)
                    }
                  >
                    <option value="">— choose a practice —</option>
                    {labPractices.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName || p.name}
                      </option>
                    ))}
                  </select>
                </div>
                {targetSelfMerge && (
                  <div className="text-xs text-destructive">
                    Same as a source — pick a different name or practice.
                  </div>
                )}
              </div>
            )}
          </section>

          <section>
            <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2">
              Find a doctor
            </div>
            <div className="relative mb-2">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search doctor or practice…"
                className="w-full h-9 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
              />
            </div>
            <div className="max-h-64 overflow-y-auto border border-border rounded-md divide-y divide-border">
              {searchQuery.isLoading && (
                <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                  <Loader2 size={14} className="inline animate-spin mr-2" />
                  Searching…
                </div>
              )}
              {!searchQuery.isLoading && searchAccumulated.length === 0 && (
                <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                  No matches.
                </div>
              )}
              {searchAccumulated.map((e, i) => {
                const k = `${(e.doctorName ?? "").toLowerCase()}|${e.providerOrganizationId ?? ""}`;
                const inSources = sourceKeys.has(k);
                const isTarget =
                  (e.doctorName ?? "").toLowerCase() ===
                    targetName.trim().toLowerCase() &&
                  (e.providerOrganizationId ?? null) === targetProviderId;
                return (
                  <div
                    key={`${k}-${i}`}
                    className="px-3 py-2 text-sm flex items-center gap-2 hover:bg-secondary/40"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">
                        {e.doctorName}{" "}
                        {(e.similarity ?? 0) > 0.6 && (
                          <span className="text-[10px] uppercase tracking-wide text-amber-600 ml-1">
                            likely match
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {e.practiceName || "(no practice)"} ·{" "}
                        {e.totalCases ?? 0} case
                        {(e.totalCases ?? 0) === 1 ? "" : "s"}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => addSource(e)}
                      disabled={inSources || isTarget}
                      className="h-7 px-2 rounded-md text-xs hover:bg-secondary disabled:opacity-40"
                    >
                      {inSources ? "Source" : "+ Source"}
                    </button>
                    <button
                      type="button"
                      onClick={() => pickAsTarget(e)}
                      disabled={inSources}
                      className={`h-7 px-2 rounded-md text-xs disabled:opacity-40 ${isTarget ? "bg-primary/10 text-primary" : "hover:bg-secondary"}`}
                    >
                      {isTarget ? "Target ✓" : "Set target"}
                    </button>
                  </div>
                );
              })}
              {searchTotal !== null && searchAccumulated.length < searchTotal && (
                <button
                  type="button"
                  disabled={searchQuery.isFetching}
                  onClick={() => setSearchOffset(searchAccumulated.length)}
                  className="w-full px-3 py-2 text-xs text-muted-foreground hover:bg-secondary/40 disabled:opacity-60"
                >
                  {searchQuery.isFetching
                    ? "Loading…"
                    : `Show more (${searchAccumulated.length} of ${searchTotal})`}
                </button>
              )}
            </div>
          </section>

          <section>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeSoftDeleted}
                onChange={(e) => setIncludeSoftDeleted(e.target.checked)}
              />
              Also remap soft-deleted cases under each source
            </label>
          </section>

          <section className="border border-border rounded-md p-4 bg-secondary/20">
            <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2">
              Preview
            </div>
            {previewMutation.isPending && !preview && (
              <div className="text-sm text-muted-foreground">
                <Loader2 size={14} className="inline animate-spin mr-2" />
                Computing…
              </div>
            )}
            {preview && (
              <div className="text-sm space-y-2">
                <div>
                  <span className="font-medium">{preview.totalCases ?? 0}</span>{" "}
                  case{(preview.totalCases ?? 0) === 1 ? "" : "s"} and{" "}
                  <span className="font-medium">
                    {preview.totalOverrides ?? 0}
                  </span>{" "}
                  pricing override
                  {(preview.totalOverrides ?? 0) === 1 ? "" : "s"} will move to{" "}
                  <span className="font-medium">{targetName}</span>{" "}
                  ({targetPracticeName || "—"}).
                  {preview.targetExists ? (
                    <span className="text-muted-foreground">
                      {" "}Target already has{" "}
                      <span className="font-medium">{preview.targetCases ?? 0}</span>{" "}
                      case{(preview.targetCases ?? 0) === 1 ? "" : "s"}.
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      {" "}Target doesn't exist yet — it'll be created on
                      first matching case.
                    </span>
                  )}
                </div>
                <ul className="text-xs text-muted-foreground space-y-1">
                  {(preview.sources ?? []).map((s, i) => (
                    <li key={`${s.doctorName}-${i}`}>
                      <span className="font-medium text-foreground">
                        {s.doctorName}
                      </span>{" "}
                      ({s.practiceName || "—"}) · {s.totalCases ?? 0} case
                      {(s.totalCases ?? 0) === 1 ? "" : "s"}
                      {(s.overridesCount ?? 0) > 0 &&
                        `, ${s.overridesCount} override${s.overridesCount === 1 ? "" : "s"}`}
                      {s.firstCaseAt && s.lastCaseAt && (
                        <>
                          {" "}· {formatDate(s.firstCaseAt)} →{" "}
                          {formatDate(s.lastCaseAt)}
                        </>
                      )}
                      {(s.recentCaseNumbers ?? []).length > 0 && (
                        <>
                          {" "}· recent: {(s.recentCaseNumbers ?? []).join(", ")}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}
        </div>

        <footer className="px-6 py-4 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-3 rounded-md text-sm hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canMerge}
            onClick={() => {
              setError(null);
              mergeMutation.mutate({ data: previewBody });
            }}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
          >
            {mergeMutation.isPending ? "Merging…" : "Merge"}
          </button>
        </footer>
      </div>
    </div>
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
