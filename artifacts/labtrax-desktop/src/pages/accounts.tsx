import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Building2,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  GitMerge,
  Loader2,
  Plus,
  Search,
  Square,
  Stethoscope,
  Undo2,
  X,
} from "lucide-react";
import { useUndoDoctorMerge } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { Invoice, LabCase, MeResponse, Organization } from "@/lib/types";
import { formatMoney, relativeTime } from "@/lib/format";
import type { DoctorRow, MergeSourceInput, UndoToast, MergeDialogResult } from "@/pages/doctors";
import { DoctorDrawer, MergeDialog } from "@/pages/doctors";
import { PracticeEditor, AddPracticeDialog } from "@/pages/practices";

const EXPANDED_STORAGE_KEY = "accounts_expanded_v1";
const SCROLL_STORAGE_KEY = "accounts_scroll_v1";
const SEARCH_STORAGE_KEY = "accounts_search_v1";
const SHOW_ARCHIVED_STORAGE_KEY = "accounts_show_archived_v1";

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

interface PracticeStats {
  caseCount: number;
  openBalance: number;
  totalBilled: number;
}

export default function AccountsPage() {
  const orgsQuery = useQuery({
    queryKey: ["organizations", { includeArchived: true }],
    queryFn: () => apiFetch<Organization[]>("/organizations?includeArchived=true"),
  });
  const casesQuery = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
  });
  const invoicesQuery = useQuery({
    queryKey: ["invoices"],
    queryFn: () => apiFetch<Invoice[]>("/invoices"),
  });
  const meQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
  });

  const [search, setSearch] = useState(() => {
    try {
      return sessionStorage.getItem(SEARCH_STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [showArchived, setShowArchived] = useState(() => {
    try {
      return sessionStorage.getItem(SHOW_ARCHIVED_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [openCasesOnly, setOpenCasesOnly] = useState(false);
  const [doctorSortKey, setDoctorSortKey] = useState<"totalCases" | "openCases" | "totalBilled" | "lastCaseAt">("totalCases");
  const [doctorSortDir, setDoctorSortDir] = useState<"asc" | "desc">("desc");
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const stored = sessionStorage.getItem(EXPANDED_STORAGE_KEY);
      if (stored) return new Set(JSON.parse(stored) as string[]);
    } catch {}
    return new Set();
  });
  const [editing, setEditing] = useState<Organization | null>(null);
  const [adding, setAdding] = useState(false);
  const [selectedDoctor, setSelectedDoctor] = useState<DoctorRow | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [mergeDialog, setMergeDialog] = useState<{
    sources: MergeSourceInput[];
    labOrganizationId: string;
  } | null>(null);
  const [undoToast, setUndoToast] = useState<UndoToast | null>(null);
  const queryClient = useQueryClient();
  const pageRef = useRef<HTMLDivElement>(null);

  const adminLabIds = useMemo(() => {
    const set = new Set<string>();
    for (const m of meQuery.data?.memberships ?? []) {
      if (m.status !== "active") continue;
      if (!ADMIN_ROLES.has(m.role)) continue;
      if (m.organization?.type === "lab") set.add(m.organizationId);
    }
    return set;
  }, [meQuery.data]);

  const adminLabOrgIds = useMemo(() => Array.from(adminLabIds), [adminLabIds]);
  const canAddPractice = adminLabOrgIds.length > 0;

  const undoMutation = useUndoDoctorMerge({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["cases"] });
        queryClient.invalidateQueries({ queryKey: ["invoices"] });
        setUndoToast(null);
      },
    },
  });

  const isLoading = orgsQuery.isLoading || casesQuery.isLoading || invoicesQuery.isLoading;

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

  useEffect(() => {
    try {
      sessionStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(expanded)));
    } catch {}
  }, [expanded]);

  useEffect(() => {
    try {
      sessionStorage.setItem(SEARCH_STORAGE_KEY, search);
    } catch {}
  }, [search]);

  useEffect(() => {
    try {
      sessionStorage.setItem(SHOW_ARCHIVED_STORAGE_KEY, String(showArchived));
    } catch {}
  }, [showArchived]);

  const scrollRestoredRef = useRef(false);

  useEffect(() => {
    const el = pageRef.current?.closest("main") as HTMLElement | null;
    if (!el) return;

    const raw = sessionStorage.getItem(SCROLL_STORAGE_KEY);
    const target = raw !== null ? Number(raw) : NaN;
    if (Number.isFinite(target) && target > 0) {
      el.scrollTop = target;
      scrollRestoredRef.current = el.scrollTop >= target - 1;
    } else {
      scrollRestoredRef.current = true;
    }

    function handleScroll() {
      try {
        sessionStorage.setItem(SCROLL_STORAGE_KEY, String(el!.scrollTop));
      } catch {}
    }

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (isLoading || scrollRestoredRef.current) return;
    const el = pageRef.current?.closest("main") as HTMLElement | null;
    if (!el) return;
    const raw = sessionStorage.getItem(SCROLL_STORAGE_KEY);
    const target = raw !== null ? Number(raw) : NaN;
    if (Number.isFinite(target) && target > 0) {
      el.scrollTop = target;
    }
    scrollRestoredRef.current = true;
  }, [isLoading]);

  const orgs = orgsQuery.data ?? [];
  const cases = casesQuery.data ?? [];
  const invoices = invoicesQuery.data ?? [];

  const practiceStats = useMemo<Map<string, PracticeStats>>(() => {
    const map = new Map<string, PracticeStats>();
    for (const c of cases) {
      const id = c.providerOrganizationId;
      const cur = map.get(id) ?? { caseCount: 0, openBalance: 0, totalBilled: 0 };
      cur.caseCount += 1;
      map.set(id, cur);
    }
    for (const inv of invoices) {
      const id = inv.providerOrganizationId;
      const cur = map.get(id) ?? { caseCount: 0, openBalance: 0, totalBilled: 0 };
      cur.totalBilled += Number(inv.total ?? 0);
      cur.openBalance += Number(inv.balanceDue ?? 0);
      map.set(id, cur);
    }
    return map;
  }, [cases, invoices]);

  const doctorRows = useMemo<DoctorRow[]>(() => {
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
    const orgNames = new Map<string, string>();
    for (const o of orgs) orgNames.set(o.id, o.displayName || o.name);
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

  const doctorsByPractice = useMemo<Map<string, DoctorRow[]>>(() => {
    const map = new Map<string, DoctorRow[]>();
    for (const r of doctorRows) {
      const list = map.get(r.practiceId) ?? [];
      list.push(r);
      map.set(r.practiceId, list);
    }
    return map;
  }, [doctorRows]);

  const archivedCount = useMemo(() => orgs.filter((o) => !!o.deletedAt).length, [orgs]);

  function handleDoctorSortClick(key: typeof doctorSortKey) {
    if (doctorSortKey === key) {
      setDoctorSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setDoctorSortKey(key);
      setDoctorSortDir("desc");
    }
  }

  const { filteredPractices, autoExpandedIds } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const practiceOrgs = orgs.filter((o) => o.type === "provider" || o.type === "lab");
    const autoExp = new Set<string>();

    const result = practiceOrgs.filter((o) => {
      if (!showArchived && o.deletedAt) return false;

      const doctors = doctorsByPractice.get(o.id) ?? [];

      if (openCasesOnly) {
        const hasVisibleDoctor = doctors.some((d) => {
          if (d.openCases === 0) return false;
          if (!q) return true;
          return d.doctorName.toLowerCase().includes(q) || d.practiceName.toLowerCase().includes(q);
        });
        if (!hasVisibleDoctor) {
          const nameMatch =
            o.name.toLowerCase().includes(q) ||
            (o.displayName || "").toLowerCase().includes(q);
          if (!nameMatch) return false;
          const anyOpenDoc = doctors.some((d) => d.openCases > 0);
          if (!anyOpenDoc) return false;
        }
      }

      if (!q) return true;
      const nameMatch =
        o.name.toLowerCase().includes(q) ||
        (o.displayName || "").toLowerCase().includes(q);
      if (nameMatch) return true;
      const doctorMatch = doctors.some((d) => d.doctorName.toLowerCase().includes(q));
      if (doctorMatch) autoExp.add(o.id);
      return doctorMatch;
    }).sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));

    return { filteredPractices: result, autoExpandedIds: autoExp };
  }, [orgs, search, showArchived, openCasesOnly, doctorsByPractice]);

  const effectiveExpanded = useMemo(() => {
    const combined = new Set(expanded);
    for (const id of autoExpandedIds) combined.add(id);
    return combined;
  }, [expanded, autoExpandedIds]);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (effectiveExpanded.has(id)) {
        next.delete(id);
        autoExpandedIds.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div ref={pageRef} className="px-8 py-7">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Practices your lab works with, with their associated doctors.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-sm text-muted-foreground">
            {filteredPractices.length} of {orgs.filter((o) => o.type === "provider" || o.type === "lab").length}
          </div>
          {canAddPractice && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 inline-flex items-center gap-1.5"
            >
              <Plus size={14} /> Add practice
            </button>
          )}
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
              placeholder="Search practice or doctor…"
              className="w-full h-9 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
            />
          </div>
          <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground select-none cursor-pointer">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Show archived{archivedCount > 0 ? ` (${archivedCount})` : ""}
          </label>
          <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground select-none cursor-pointer">
            <input
              type="checkbox"
              checked={openCasesOnly}
              onChange={(e) => setOpenCasesOnly(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            With open cases only
          </label>

          {picked.size > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{picked.size} doctor{picked.size === 1 ? "" : "s"} selected</span>
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
                  for (const r of doctorRows) {
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
              <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="w-8"></th>
                <th className="text-left font-medium px-4 py-2.5">Practice / Doctor</th>
                <th className="text-left font-medium py-2.5">Contact</th>
                <th className="text-left font-medium py-2.5">Location</th>
                <th className="text-right font-medium py-2.5">
                  <button
                    type="button"
                    onClick={() => handleDoctorSortClick("totalCases")}
                    className="inline-flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
                    title="Sort doctors by Cases"
                  >
                    Cases
                    {doctorSortKey === "totalCases" ? (
                      doctorSortDir === "desc" ? <ArrowDown size={11} /> : <ArrowUp size={11} />
                    ) : (
                      <ArrowUpDown size={11} className="opacity-40" />
                    )}
                  </button>
                </th>
                <th className="text-right font-medium py-2.5">
                  <button
                    type="button"
                    onClick={() => handleDoctorSortClick("openCases")}
                    className="inline-flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
                    title="Sort doctors by Open cases"
                  >
                    Open
                    {doctorSortKey === "openCases" ? (
                      doctorSortDir === "desc" ? <ArrowDown size={11} /> : <ArrowUp size={11} />
                    ) : (
                      <ArrowUpDown size={11} className="opacity-40" />
                    )}
                  </button>
                </th>
                <th className="text-right font-medium py-2.5">Rush</th>
                <th className="text-right font-medium py-2.5">
                  <button
                    type="button"
                    onClick={() => handleDoctorSortClick("totalBilled")}
                    className="inline-flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
                    title="Sort doctors by Billed amount"
                  >
                    Billed
                    {doctorSortKey === "totalBilled" ? (
                      doctorSortDir === "desc" ? <ArrowDown size={11} /> : <ArrowUp size={11} />
                    ) : (
                      <ArrowUpDown size={11} className="opacity-40" />
                    )}
                  </button>
                </th>
                <th className="text-right font-medium py-2.5">Balance</th>
                <th className="text-left font-medium px-5 py-2.5">
                  <button
                    type="button"
                    onClick={() => handleDoctorSortClick("lastCaseAt")}
                    className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                    title="Sort doctors by Last case date"
                  >
                    Last case
                    {doctorSortKey === "lastCaseAt" ? (
                      doctorSortDir === "desc" ? <ArrowDown size={11} /> : <ArrowUp size={11} />
                    ) : (
                      <ArrowUpDown size={11} className="opacity-40" />
                    )}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={10} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading accounts…
                  </td>
                </tr>
              )}
              {!isLoading && filteredPractices.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-5 py-12 text-center text-muted-foreground">
                    No practices match the current filters.
                  </td>
                </tr>
              )}
              {filteredPractices.map((org) => {
                const s = practiceStats.get(org.id) ?? { caseCount: 0, openBalance: 0, totalBilled: 0 };
                const isOpen = effectiveExpanded.has(org.id);
                const q = search.trim().toLowerCase();
                const orgDoctors = (doctorsByPractice.get(org.id) ?? [])
                  .filter((d) => {
                    if (openCasesOnly && d.openCases === 0) return false;
                    if (!q) return true;
                    return (
                      d.doctorName.toLowerCase().includes(q) ||
                      d.practiceName.toLowerCase().includes(q)
                    );
                  })
                  .sort((a, b) => {
                    let cmp = 0;
                    if (doctorSortKey === "lastCaseAt") {
                      const aVal = a.lastCaseAt ?? "";
                      const bVal = b.lastCaseAt ?? "";
                      cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
                    } else {
                      cmp = a[doctorSortKey] - b[doctorSortKey];
                    }
                    return doctorSortDir === "desc" ? -cmp : cmp;
                  });
                const hasDoctors = orgDoctors.length > 0;
                const visibleDoctors = orgDoctors;

                return [
                  <tr
                    key={org.id}
                    onClick={() => setEditing(org)}
                    className="border-t border-border cursor-pointer hover:bg-secondary/40"
                  >
                    <td
                      className="pl-4 py-3 w-8"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (hasDoctors) toggleExpanded(org.id);
                      }}
                    >
                      {hasDoctors ? (
                        <button
                          type="button"
                          className="h-6 w-6 rounded hover:bg-secondary flex items-center justify-center text-muted-foreground"
                          aria-label={isOpen ? "Collapse" : "Expand"}
                        >
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="h-7 w-7 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                          <Building2 size={13} />
                        </div>
                        <div>
                          <div className="font-medium flex items-center gap-2">
                            <span className={org.deletedAt ? "text-muted-foreground" : ""}>
                              {org.displayName || org.name}
                            </span>
                            {org.deletedAt && (
                              <span className="text-[10px] uppercase tracking-wide bg-secondary text-muted-foreground rounded px-1.5 py-0.5 flex items-center gap-1">
                                <Archive size={9} /> Archived
                              </span>
                            )}
                            {!search.trim() && orgDoctors.length > 0 && (
                              <span className="text-[10px] font-normal bg-primary/10 text-primary rounded-full px-2 py-0.5 tabular-nums">
                                {orgDoctors.length} {orgDoctors.length === 1 ? "doctor" : "doctors"}
                              </span>
                            )}
                          </div>
                          {org.displayName && (
                            <div className="text-xs text-muted-foreground">{org.name}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="py-3 text-muted-foreground text-xs">
                      <div>{org.billingEmail || "—"}</div>
                      <div>{org.phone || ""}</div>
                    </td>
                    <td className="py-3 text-muted-foreground text-xs">
                      {[org.city, org.state].filter(Boolean).join(", ") || "—"}
                    </td>
                    <td className="py-3 text-right tabular-nums">{s.caseCount}</td>
                    <td className="py-3 text-right tabular-nums text-muted-foreground">—</td>
                    <td className="py-3 text-right tabular-nums text-muted-foreground">—</td>
                    <td className="py-3 text-right tabular-nums font-medium">{formatMoney(s.totalBilled)}</td>
                    <td className="py-3 text-right tabular-nums">
                      {s.openBalance > 0 ? (
                        <span className="text-warning font-medium">{formatMoney(s.openBalance)}</span>
                      ) : (
                        <span className="text-muted-foreground">{formatMoney(0)}</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-muted-foreground text-xs">—</td>
                  </tr>,

                  isOpen && visibleDoctors.map((doctor) => {
                    const canSelect = adminLabIds.has(doctor.labOrganizationId);
                    const isPicked = picked.has(doctor.key);
                    return (
                      <tr
                        key={doctor.key}
                        onClick={() => setSelectedDoctor(doctor)}
                        className="border-t border-border/50 cursor-pointer hover:bg-secondary/30 bg-secondary/10"
                      >
                        <td className="pl-4 py-2.5 w-8">
                          <div className="w-6 flex items-center justify-center">
                            <div className="w-px h-4 bg-border mx-auto" />
                          </div>
                        </td>
                        <td
                          className="px-4 py-2.5"
                          onClick={(e) => {
                            if (canSelect) {
                              e.stopPropagation();
                              setPicked((prev) => {
                                const next = new Set(prev);
                                if (next.has(doctor.key)) {
                                  next.delete(doctor.key);
                                  return next;
                                }
                                const firstPickedLab = doctorRows.find((x) => prev.has(x.key))?.labOrganizationId;
                                if (firstPickedLab && firstPickedLab !== doctor.labOrganizationId) next.clear();
                                next.add(doctor.key);
                                return next;
                              });
                            }
                          }}
                        >
                          <div className="flex items-center gap-2.5 pl-6">
                            {canSelect ? (
                              <div className="shrink-0">
                                {isPicked ? (
                                  <CheckSquare size={14} className="text-primary" />
                                ) : (
                                  <Square size={14} className="text-muted-foreground" />
                                )}
                              </div>
                            ) : (
                              <div className="h-5 w-5 rounded-full bg-primary/8 text-primary flex items-center justify-center shrink-0">
                                <Stethoscope size={11} />
                              </div>
                            )}
                            <span className="text-sm font-medium">{doctor.doctorName}</span>
                          </div>
                        </td>
                        <td className="py-2.5 text-muted-foreground text-xs">—</td>
                        <td className="py-2.5 text-muted-foreground text-xs">—</td>
                        <td className="py-2.5 text-right tabular-nums text-sm">{doctor.totalCases}</td>
                        <td className="py-2.5 text-right tabular-nums text-sm">{doctor.openCases}</td>
                        <td className="py-2.5 text-right tabular-nums text-sm">
                          {doctor.rushCases > 0 ? (
                            <span className="text-destructive font-medium">{doctor.rushCases}</span>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </td>
                        <td className="py-2.5 text-right tabular-nums text-sm font-medium">{formatMoney(doctor.totalBilled)}</td>
                        <td className="py-2.5 text-right tabular-nums text-muted-foreground">—</td>
                        <td className="px-5 py-2.5 text-xs text-muted-foreground">
                          {relativeTime(doctor.lastCaseAt)}
                        </td>
                      </tr>
                    );
                  }),
                ].flat().filter(Boolean);
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editing && <PracticeEditor org={editing} onClose={() => setEditing(null)} />}

      {adding && (
        <AddPracticeDialog
          adminLabOrgIds={adminLabOrgIds}
          onClose={() => setAdding(false)}
        />
      )}

      {selectedDoctor && (
        <DoctorDrawer
          doctor={selectedDoctor}
          allDoctors={doctorRows}
          cases={cases.filter(
            (c) =>
              (c.doctorName || "").toLowerCase() === selectedDoctor.doctorName.toLowerCase() &&
              c.providerOrganizationId === selectedDoctor.practiceId,
          )}
          onClose={() => setSelectedDoctor(null)}
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
          onMerged={(result: MergeDialogResult) => {
            queryClient.invalidateQueries({ queryKey: ["cases"] });
            queryClient.invalidateQueries({ queryKey: ["invoices"] });
            setPicked(new Set());
            setSelectedDoctor(null);
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
