import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
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
  Eye,
  GitMerge,
  Loader2,
  Plus,
  Receipt,
  Search,
  Square,
  Stethoscope,
  Undo2,
  Users,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/StatusBadge";
import { useUndoDoctorMerge } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { Invoice, LabCase, MeResponse, Organization, OrgMemberRow } from "@/lib/types";
import { formatDate, formatMoney, relativeTime } from "@/lib/format";
import type { DoctorRow, MergeSourceInput, UndoToast, MergeDialogResult } from "@/pages/doctors";
import { DoctorDrawer, MergeDialog } from "@/pages/doctors";
import { PracticeEditor, AddPracticeDialog } from "@/pages/practices";
import { InvoiceEditor } from "@/pages/invoices";

const EXPANDED_STORAGE_KEY = "accounts_expanded_v1";
const SCROLL_STORAGE_KEY = "accounts_scroll_v1";
const SEARCH_STORAGE_KEY = "accounts_search_v1";
const SHOW_ARCHIVED_STORAGE_KEY = "accounts_show_archived_v1";

interface AdminUser {
  id: string;
  username: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  role?: string | null;
  isActive?: boolean;
  practiceName?: string | null;
  lastLoginAt?: string | null;
}

type PageView = "practices" | "directory";

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

// Mirror of practices.tsx's normalizeDoctorName: strip the "Dr." honorific and
// all non-alphanumerics so a case-history free-text name can be matched against
// the lab's "Unassigned doctors" holding area regardless of formatting.
function normalizeDoctorName(name: string): string {
  return (name || "")
    .toLowerCase()
    .replace(/^dr\.?\s+/, "")
    .replace(/[^a-z0-9]/g, "");
}

interface UnassignedDoctorRow {
  userId: string | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  doctorName: string | null;
}

interface PracticeStats {
  caseCount: number;
  openBalance: number;
  totalBilled: number;
}

export default function AccountsPage() {
  const orgsQuery = useQuery({
    queryKey: ["organizations", { includeArchived: true, includeLabPractices: true }],
    queryFn: () =>
      apiFetch<Organization[]>(
        "/organizations?includeArchived=true&includeLabPractices=true"
      ),
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
  const [caseView, setCaseView] = useState<"open" | "all">("open");
  const [, navigate] = useLocation();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [selectedPracticeIds, setSelectedPracticeIds] = useState<Set<string>>(new Set());
  const [invoicePanelOpen, setInvoicePanelOpen] = useState(false);
  const [viewingInvoice, setViewingInvoice] = useState<Invoice | null>(null);
  const [invoiceTab, setInvoiceTab] = useState<"all" | "open" | "closed" | "overdue">("all");
  const [mergeDialog, setMergeDialog] = useState<{
    sources: MergeSourceInput[];
    labOrganizationId: string;
  } | null>(null);
  const [undoToast, setUndoToast] = useState<UndoToast | null>(null);
  const [pageView, setPageView] = useState<PageView>("practices");
  const [dirSearch, setDirSearch] = useState("");
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

  const isAdmin = adminLabIds.size > 0;

  const usersQuery = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => apiFetch<{ users: AdminUser[] } | AdminUser[]>("/auth/users"),
    enabled: isAdmin && pageView === "directory",
  });

  const directoryUsers = useMemo(() => {
    const d = usersQuery.data;
    const list: AdminUser[] = !d ? [] : Array.isArray(d) ? d : (d.users ?? []);
    const q = dirSearch.trim().toLowerCase();
    return list
      .filter((u) => {
        if (!q) return true;
        return (
          u.username.toLowerCase().includes(q) ||
          (u.email || "").toLowerCase().includes(q) ||
          [u.firstName, u.lastName].filter(Boolean).join(" ").toLowerCase().includes(q) ||
          (u.practiceName || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.username.localeCompare(b.username));
  }, [usersQuery.data, dirSearch]);

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

  const practiceOrgIds = useMemo(
    () => orgs.filter((o) => o.type === "provider" || o.type === "lab").map((o) => o.id),
    [orgs],
  );

  const memberAccountsQuery = useQuery({
    queryKey: ["practice-members-accounts", practiceOrgIds],
    queryFn: async () => {
      const results = await Promise.all(
        practiceOrgIds.map((orgId) =>
          apiFetch<OrgMemberRow[]>(`/organizations/${orgId}/members`)
            .then((members) => ({ orgId, members }))
            .catch(() => ({ orgId, members: [] as OrgMemberRow[] })),
        ),
      );
      return results;
    },
    enabled: practiceOrgIds.length > 0,
  });

  const doctorAccountMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const { orgId, members } of memberAccountsQuery.data ?? []) {
      for (const m of members) {
        if (!m.user?.platformAccountNumber) continue;
        const firstName = m.user.firstName ?? "";
        const lastName = m.user.lastName ?? "";
        const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
        if (fullName) {
          map.set(`${fullName.toLowerCase()}|${orgId}`, m.user.platformAccountNumber);
        }
      }
    }
    return map;
  }, [memberAccountsQuery.data]);

  // Per-lab "Unassigned doctors" holding area. A doctor moved here must vanish
  // from every practice's doctor list (their cases/invoices stay behind) — this
  // mirrors the exclusion PracticeDoctorsSection applies in the practice editor,
  // so the Customer Center table and a practice's own overview stay in sync.
  const unassignedQuery = useQuery({
    queryKey: ["unassigned-doctors-accounts", adminLabOrgIds],
    queryFn: async () => {
      const results = await Promise.all(
        adminLabOrgIds.map((labId) =>
          apiFetch<UnassignedDoctorRow[]>(`/organizations/${labId}/unassigned-doctors`)
            .then((rows) => ({ labId, rows }))
            .catch(() => ({ labId, rows: [] as UnassignedDoctorRow[] })),
        ),
      );
      return results;
    },
    enabled: adminLabOrgIds.length > 0,
  });

  const excludedNamesByLab = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const { labId, rows } of unassignedQuery.data ?? []) {
      const set = map.get(labId) ?? new Set<string>();
      for (const r of rows) {
        const candidates = [
          [r.firstName, r.lastName].filter(Boolean).join(" "),
          r.doctorName ?? "",
          r.username ?? "",
        ];
        for (const c of candidates) {
          const n = normalizeDoctorName(c);
          if (n) set.add(n);
        }
      }
      map.set(labId, set);
    }
    return map;
  }, [unassignedQuery.data]);

  // Names of doctors with an ACTIVE membership at a given practice — a shared
  // name must never hide a doctor who is genuinely assigned here.
  const activeRegisteredNamesByPractice = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const { orgId, members } of memberAccountsQuery.data ?? []) {
      const set = map.get(orgId) ?? new Set<string>();
      for (const m of members) {
        const name =
          [m.user?.firstName, m.user?.lastName].filter(Boolean).join(" ").trim() ||
          (m.user?.username ?? "");
        const n = normalizeDoctorName(name);
        if (n) set.add(n);
      }
      map.set(orgId, set);
    }
    return map;
  }, [memberAccountsQuery.data]);

  // Resolve each practice (provider org) to its parent lab so the correct
  // per-lab unassigned set applies even when a (legacy) case lacks labOrganizationId.
  const practiceLabId = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of orgs) {
      if (o.type === "lab") map.set(o.id, o.id);
      else if (o.parentLabOrganizationId) map.set(o.id, o.parentLabOrganizationId);
    }
    return map;
  }, [orgs]);

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
      // Drop doctors that were moved to the lab's "Unassigned" holding area so
      // this table matches the practice editor's roster. Their cases still count
      // toward practice-level stats (see practiceStats), only the doctor row goes.
      const norm = normalizeDoctorName(doc);
      const labId = c.labOrganizationId || practiceLabId.get(practiceId) || "";
      if (
        norm &&
        excludedNamesByLab.get(labId)?.has(norm) &&
        !activeRegisteredNamesByPractice.get(practiceId)?.has(norm)
      ) {
        continue;
      }
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
          hasAiImportedCase: !!(c.aiImportSource || c.needsAiReview),
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
  }, [
    cases,
    invoices,
    orgs,
    excludedNamesByLab,
    activeRegisteredNamesByPractice,
    practiceLabId,
  ]);

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

  function togglePractice(id: string) {
    setSelectedPracticeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const totalSelected = picked.size + selectedPracticeIds.size;

  const selectedInvoices = useMemo<Invoice[]>(() => {
    const invoiceSet = new Set<string>();
    const result: Invoice[] = [];
    for (const inv of invoices) {
      if (selectedPracticeIds.has(inv.providerOrganizationId)) {
        if (!invoiceSet.has(inv.id)) {
          invoiceSet.add(inv.id);
          result.push(inv);
        }
      }
    }
    for (const doctorKey of picked) {
      const doctor = doctorRows.find((d) => d.key === doctorKey);
      if (!doctor) continue;
      const doctorCaseIds = new Set(
        cases
          .filter(
            (c) =>
              (c.doctorName || "").toLowerCase() === doctor.doctorName.toLowerCase() &&
              c.providerOrganizationId === doctor.practiceId,
          )
          .map((c) => c.id),
      );
      for (const inv of invoices) {
        if (invoiceSet.has(inv.id)) continue;
        const matches = inv.caseId
          ? doctorCaseIds.has(inv.caseId)
          : doctor.practiceId
          ? inv.providerOrganizationId === doctor.practiceId
          : false;
        if (matches) {
          invoiceSet.add(inv.id);
          result.push(inv);
        }
      }
    }
    return result;
  }, [invoices, selectedPracticeIds, picked, doctorRows, cases]);

  const filteredInvoices = useMemo<Invoice[]>(() => {
    const now = new Date();
    return selectedInvoices
      .filter((inv) => {
        if (invoiceTab === "open") {
          return inv.status === "open" || inv.status === "partially_paid";
        }
        if (invoiceTab === "overdue") {
          const isOpen = inv.status === "open" || inv.status === "partially_paid";
          if (!isOpen) return false;
          const bal = Number(inv.balanceDue ?? 0);
          if (bal <= 0) return false;
          const due = inv.dueAt ?? inv.dueDate;
          if (!due) return false;
          return new Date(due) < now;
        }
        if (invoiceTab === "closed") {
          if (inv.status === "paid") return true;
          return Number(inv.balanceDue ?? 0) <= 0;
        }
        return true;
      })
      .sort((a, b) =>
        (b.issuedAt || b.createdAt || "").localeCompare(a.issuedAt || a.createdAt || ""),
      );
  }, [selectedInvoices, invoiceTab]);

  const invoiceTabCounts = useMemo(() => {
    const now = new Date();
    let open = 0, overdue = 0, closed = 0;
    for (const inv of selectedInvoices) {
      const isOpen = inv.status === "open" || inv.status === "partially_paid";
      if (isOpen) {
        open++;
        const bal = Number(inv.balanceDue ?? 0);
        const due = inv.dueAt ?? inv.dueDate;
        if (bal > 0 && due && new Date(due) < now) overdue++;
      }
      if (inv.status === "paid" || Number(inv.balanceDue ?? 0) <= 0) closed++;
    }
    return { all: selectedInvoices.length, open, overdue, closed };
  }, [selectedInvoices]);

  return (
    <div ref={pageRef} className="px-8 py-7">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Customer Center</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {pageView === "directory"
              ? "All LabTrax accounts associated with your lab."
              : "Practices and doctors your lab works with. Select rows to view their invoices."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isAdmin && (
            <div className="inline-flex rounded-lg border border-border overflow-hidden text-xs font-medium">
              <button
                type="button"
                onClick={() => setPageView("practices")}
                className={`px-3 py-2 transition-colors inline-flex items-center gap-1.5 ${
                  pageView === "practices"
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground hover:text-foreground"
                }`}
              >
                <Building2 size={13} />
                Practices & Doctors
              </button>
              <button
                type="button"
                onClick={() => setPageView("directory")}
                className={`px-3 py-2 border-l border-border transition-colors inline-flex items-center gap-1.5 ${
                  pageView === "directory"
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground hover:text-foreground"
                }`}
              >
                <Users size={13} />
                Account Directory
              </button>
            </div>
          )}
          {pageView === "practices" && (
            <>
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
            </>
          )}
        </div>
      </div>

      {pageView === "directory" && isAdmin && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-3">
            <div className="relative flex-1 min-w-[220px] max-w-md">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={dirSearch}
                onChange={(e) => setDirSearch(e.target.value)}
                placeholder="Search by name, email, or practice…"
                className="w-full h-9 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
                autoFocus
              />
            </div>
            <div className="text-xs text-muted-foreground ml-auto">
              {usersQuery.isLoading
                ? "Loading…"
                : `${directoryUsers.length} of ${
                    (() => {
                      const d = usersQuery.data;
                      return !d ? 0 : Array.isArray(d) ? d.length : (d.users?.length ?? 0);
                    })()
                  }`}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="text-left font-medium px-4 py-2.5">User</th>
                  <th className="text-left font-medium py-2.5">Email</th>
                  <th className="text-left font-medium py-2.5">Practice</th>
                  <th className="text-left font-medium py-2.5">Role</th>
                  <th className="text-left font-medium py-2.5">Status</th>
                  <th className="text-left font-medium px-4 py-2.5">Last login</th>
                </tr>
              </thead>
              <tbody>
                {usersQuery.isLoading && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                      <Loader2 size={16} className="inline animate-spin mr-2" />
                      Loading accounts…
                    </td>
                  </tr>
                )}
                {usersQuery.error && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-destructive text-sm">
                      {(usersQuery.error as Error).message}
                    </td>
                  </tr>
                )}
                {!usersQuery.isLoading && !usersQuery.error && directoryUsers.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                      {dirSearch.trim() ? "No accounts match your search." : "No accounts found."}
                    </td>
                  </tr>
                )}
                {directoryUsers.map((u) => (
                  <tr key={u.id} className="border-t border-border hover:bg-secondary/40">
                    <td className="px-4 py-2.5">
                      <div className="font-medium">
                        {[u.firstName, u.lastName].filter(Boolean).join(" ") || u.username}
                      </div>
                      <div className="text-xs text-muted-foreground">@{u.username}</div>
                    </td>
                    <td className="py-2.5 text-muted-foreground text-xs">
                      {u.email || "—"}
                    </td>
                    <td className="py-2.5 text-muted-foreground text-xs">
                      {u.practiceName || "—"}
                    </td>
                    <td className="py-2.5">
                      <span className="text-[11px] uppercase tracking-wide bg-secondary text-secondary-foreground rounded-full px-2 py-0.5">
                        {u.role || "user"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[11px] px-2 py-0.5 rounded-full ${
                        u.isActive === false
                          ? "bg-warning/20 text-warning"
                          : "bg-success/15 text-success"
                      }`}>
                        {u.isActive === false ? "Inactive" : "Active"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                      {u.lastLoginAt ? (
                        <span title={new Date(u.lastLoginAt).toLocaleString()}>
                          {relativeTime(u.lastLoginAt)}
                        </span>
                      ) : (
                        <span className="italic">Never</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {pageView === "practices" && <div className="bg-card border border-border rounded-xl overflow-hidden">
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

          <div className="inline-flex rounded-md border border-border overflow-hidden text-xs font-medium">
            <button
              type="button"
              onClick={() => setCaseView("open")}
              className={`px-2.5 py-1.5 transition-colors ${caseView === "open" ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}
            >
              Open
            </button>
            <button
              type="button"
              onClick={() => setCaseView("all")}
              className={`px-2.5 py-1.5 border-l border-border transition-colors ${caseView === "all" ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}
            >
              All
            </button>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {totalSelected > 0 && (
              <span className="text-xs text-muted-foreground">
                {[
                  selectedPracticeIds.size > 0 && `${selectedPracticeIds.size} practice${selectedPracticeIds.size === 1 ? "" : "s"}`,
                  picked.size > 0 && `${picked.size} doctor${picked.size === 1 ? "" : "s"}`,
                ].filter(Boolean).join(", ")} selected
              </span>
            )}
            <button
              type="button"
              disabled={totalSelected === 0}
              onClick={() => {
                setInvoiceTab("all");
                setInvoicePanelOpen(true);
              }}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Eye size={14} />
              View invoices for selected
            </button>
            {totalSelected > 0 && (
              <button
                type="button"
                onClick={() => {
                  setPicked(new Set());
                  setSelectedPracticeIds(new Set());
                }}
                className="h-9 px-3 rounded-md text-sm hover:bg-secondary"
              >
                Clear
              </button>
            )}
            {picked.size > 0 && (
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
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border text-sm font-semibold hover:bg-secondary"
              >
                <GitMerge size={14} />
                Merge doctors
              </button>
            )}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="w-8"></th>
                <th className="text-left font-medium px-4 py-2.5">Practice / Doctor</th>
                <th className="text-left font-medium py-2.5">Account #</th>
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
                  <td colSpan={11} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading accounts…
                  </td>
                </tr>
              )}
              {!isLoading && filteredPractices.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-5 py-12 text-center text-muted-foreground">
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
                      className="pl-3 py-3 w-14"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          className="shrink-0 h-5 w-5 flex items-center justify-center"
                          aria-label={selectedPracticeIds.has(org.id) ? "Deselect practice" : "Select practice"}
                          onClick={() => togglePractice(org.id)}
                        >
                          {selectedPracticeIds.has(org.id) ? (
                            <CheckSquare size={14} className="text-primary" />
                          ) : (
                            <Square size={14} className="text-muted-foreground" />
                          )}
                        </button>
                        {hasDoctors ? (
                          <button
                            type="button"
                            onClick={() => toggleExpanded(org.id)}
                            className="h-6 w-6 rounded hover:bg-secondary flex items-center justify-center text-muted-foreground"
                            aria-label={isOpen ? "Collapse" : "Expand"}
                          >
                            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        ) : (
                          <div className="w-6" />
                        )}
                      </div>
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
                      {org.accountNumber || "—"}
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
                        <td className="py-2.5 text-muted-foreground text-xs font-mono">
                          {doctorAccountMap.get(`${doctor.doctorName.toLowerCase()}|${doctor.practiceId}`) || "—"}
                        </td>
                        <td className="py-2.5 text-muted-foreground text-xs">—</td>
                        <td className="py-2.5 text-muted-foreground text-xs">—</td>
                        <td className="py-2.5 text-right tabular-nums text-sm">{doctor.totalCases}</td>
                        <td
                          className="py-2.5 text-right"
                          onClick={(e) => {
                            e.stopPropagation();
                            const count = caseView === "open" ? doctor.openCases : doctor.totalCases;
                            if (count > 0) setSelectedDoctor(doctor);
                          }}
                        >
                          {(caseView === "open" ? doctor.openCases : doctor.totalCases) > 0 ? (
                            <span
                              title={caseView === "open" ? "Open cases — click to view" : "All cases — click to view"}
                              className="inline-flex items-center justify-center min-w-[2rem] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-semibold tabular-nums cursor-pointer hover:bg-primary/20 transition-colors"
                            >
                              {caseView === "open" ? doctor.openCases : doctor.totalCases}
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-sm tabular-nums">0</span>
                          )}
                        </td>
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
      </div>}

      {editing && <PracticeEditor org={editing} onClose={() => setEditing(null)} />}

      {adding && (
        <AddPracticeDialog
          adminLabOrgIds={adminLabOrgIds}
          onClose={() => setAdding(false)}
          onNavigateToPractice={(orgId) => {
            setAdding(false);
            setExpanded((prev) => {
              const next = new Set(prev);
              next.add(orgId);
              return next;
            });
          }}
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
          invoices={(() => {
            const doctorCaseIds = new Set(
              cases
                .filter((c) => (c.doctorName || "").toLowerCase() === selectedDoctor.doctorName.toLowerCase() && c.providerOrganizationId === selectedDoctor.practiceId)
                .map((c) => c.id),
            );
            return invoices.filter((inv) =>
              inv.caseId
                ? doctorCaseIds.has(inv.caseId)
                : selectedDoctor.practiceId
                ? inv.providerOrganizationId === selectedDoctor.practiceId
                : false,
            );
          })()}
          caseView={caseView}
          onNavigateToCases={() => {
            const qs = selectedDoctor.doctorName
              ? `?search=${encodeURIComponent(selectedDoctor.doctorName)}`
              : "";
            navigate(`/cases${qs}`);
            setSelectedDoctor(null);
          }}
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

      <Dialog open={invoicePanelOpen} onOpenChange={setInvoicePanelOpen}>
        <DialogContent className="max-w-4xl w-full max-h-[80vh] flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 pt-5 pb-4 border-b border-border shrink-0">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <Receipt size={16} className="text-primary" />
              Invoices for selected
              {selectedPracticeIds.size > 0 && (
                <span className="text-xs font-normal text-muted-foreground">
                  ({[...selectedPracticeIds].map((id) => {
                    const org = orgs.find((o) => o.id === id);
                    return org ? (org.displayName || org.name) : id;
                  }).join(", ")}
                  {picked.size > 0 && ` + ${picked.size} doctor${picked.size === 1 ? "" : "s"}`}
                  )
                </span>
              )}
              {selectedPracticeIds.size === 0 && picked.size > 0 && (
                <span className="text-xs font-normal text-muted-foreground">
                  ({picked.size} doctor{picked.size === 1 ? "" : "s"})
                </span>
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="px-6 pt-3 pb-2 border-b border-border shrink-0">
            <div className="inline-flex rounded-md border border-border overflow-hidden text-xs font-medium">
              {(["all", "open", "overdue", "closed"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setInvoiceTab(tab)}
                  className={`px-3 py-1.5 border-l border-border first:border-l-0 transition-colors ${
                    invoiceTab === tab
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {tab === "all" && `All (${invoiceTabCounts.all})`}
                  {tab === "open" && `Open (${invoiceTabCounts.open})`}
                  {tab === "overdue" && `Overdue (${invoiceTabCounts.overdue})`}
                  {tab === "closed" && `Closed (${invoiceTabCounts.closed})`}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0">
            {filteredInvoices.length === 0 ? (
              <div className="py-16 text-center text-muted-foreground text-sm">
                <Receipt size={28} className="mx-auto mb-3 opacity-30" />
                <p>No invoices found for this selection and filter.</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-secondary/80 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="text-left font-medium px-4 py-2.5">Invoice #</th>
                    <th className="text-left font-medium py-2.5">Practice</th>
                    <th className="text-left font-medium py-2.5">Patient</th>
                    <th className="text-left font-medium py-2.5">Issued</th>
                    <th className="text-left font-medium py-2.5">Due</th>
                    <th className="text-left font-medium py-2.5">Status</th>
                    <th className="text-right font-medium px-4 py-2.5">Total</th>
                    <th className="text-right font-medium px-4 py-2.5">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInvoices.map((inv) => {
                    const meta = (inv.displayMetadata ?? inv.displayMetadataJson ?? {}) as { patientName?: string };
                    const due = inv.dueAt ?? inv.dueDate;
                    const now = new Date();
                    const isOverdue =
                      (inv.status === "open" || inv.status === "partially_paid") &&
                      Number(inv.balanceDue ?? 0) > 0 &&
                      !!due &&
                      new Date(due) < now;
                    return (
                      <tr
                        key={inv.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          setInvoicePanelOpen(false);
                          setViewingInvoice(inv);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setInvoicePanelOpen(false);
                            setViewingInvoice(inv);
                          }
                        }}
                        className="border-t border-border cursor-pointer hover:bg-secondary/40 focus:outline-none focus-visible:bg-secondary/40"
                      >
                        <td className="px-4 py-2.5 font-mono text-xs font-medium">{inv.invoiceNumber}</td>
                        <td className="py-2.5 text-xs text-muted-foreground max-w-[160px] truncate">
                          {inv.providerOrganization?.name ?? "—"}
                        </td>
                        <td className="py-2.5 text-xs text-muted-foreground max-w-[140px] truncate">
                          {meta.patientName ?? "—"}
                        </td>
                        <td className="py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                          {inv.issuedAt ? formatDate(inv.issuedAt) : "—"}
                        </td>
                        <td className={`py-2.5 text-xs whitespace-nowrap ${isOverdue ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                          {due ? formatDate(due) : "—"}
                        </td>
                        <td className="py-2.5">
                          <StatusBadge status={inv.status} />
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                          {formatMoney(Number(inv.total ?? 0))}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {Number(inv.balanceDue ?? 0) > 0 ? (
                            <span className={isOverdue ? "text-destructive font-medium" : "text-warning font-medium"}>
                              {formatMoney(Number(inv.balanceDue))}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">{formatMoney(0)}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {viewingInvoice && (
        <InvoiceEditor
          key={viewingInvoice.id}
          invoice={viewingInvoice}
          onClose={() => {
            setViewingInvoice(null);
            setInvoicePanelOpen(true);
          }}
          onGoToCase={() => {
            const caseId = viewingInvoice.caseId;
            setViewingInvoice(null);
            if (caseId) {
              navigate(`/cases?caseId=${encodeURIComponent(caseId)}`);
            } else {
              setInvoicePanelOpen(true);
            }
          }}
        />
      )}
    </div>
  );
}
