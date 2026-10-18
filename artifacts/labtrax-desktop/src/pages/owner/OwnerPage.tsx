import { Fragment, useState, useEffect, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import {
  AlertTriangle,
  Building2,
  Loader2,
  Users,
  BarChart3,
  Trash2,
  ArrowRightLeft,
  CheckCircle2,
  AlertCircle,
  CreditCard,
  FileText,
  Download,
  FileImage,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { MeResponse } from "@/lib/types";
import { MEMBERSHIP_ROLE_LABELS } from "@/lib/membership-roles";

type Tab = "lab-profile" | "team" | "revenue" | "danger-zone" | "billing";

function readTabFromSearch(param = "tab"): Tab {
  try {
    const p = new URLSearchParams(window.location.search);
    const t = p.get(param);
    if (
      t === "team" ||
      t === "revenue" ||
      t === "danger-zone" ||
      t === "lab-profile" ||
      t === "billing"
    )
      return t;
  } catch {}
  return "lab-profile";
}

const TABS: { id: Tab; label: string; icon: typeof Building2 }[] = [
  { id: "lab-profile", label: "Lab Profile", icon: Building2 },
  { id: "team", label: "Team & Roles", icon: Users },
  { id: "revenue", label: "Revenue Reports", icon: BarChart3 },
  { id: "billing", label: "Billing", icon: CreditCard },
  { id: "danger-zone", label: "Danger Zone", icon: AlertTriangle },
];

export default function OwnerPage({ embedded = false }: { embedded?: boolean } = {}) {
  const param = embedded ? "ownerTab" : "tab";
  const [tab, setTab] = useState<Tab>(() => readTabFromSearch(param));
  const search = useSearch();
  const params = new URLSearchParams(search);
  const transferOnly = params.get("transferOnly") === "1";
  const requestedOrgId = params.get("organizationId");
  const [, setLocation] = useLocation();
  const { user } = useAuth();

  const meQuery = useQuery<MeResponse>({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
    enabled: !!user,
  });

  const orgId = useMemo(() => {
    return (
      (meQuery.data?.memberships ?? []).find(
        (m: any) =>
          m.status === "active" &&
          (transferOnly ? m.organizationId === requestedOrgId : m.organization?.type === "lab") &&
          m.role === "owner",
      )?.organization?.id ?? null
    );
  }, [meQuery.data, transferOnly, requestedOrgId]);

  function switchTab(t: Tab) {
    if (t === "billing") {
      setLocation("/billing");
      return;
    }
    setTab(t);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set(param, t);
      window.history.replaceState({}, "", url.toString());
    } catch {}
  }

  useEffect(() => {
    if (!orgId && meQuery.isSuccess && !embedded) {
      setLocation("/");
    }
  }, [orgId, meQuery.isSuccess, embedded, setLocation]);

  return (
    <div className={embedded ? "flex h-[calc(100vh-11rem)] min-h-[480px] overflow-hidden rounded-lg border border-border" : "flex h-full"}>
      {/* Tab sidebar */}
      {!transferOnly && <aside className="w-48 shrink-0 border-r border-border bg-muted/20 py-4 px-2">
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground px-3 pb-2">
          {embedded ? "Lab owner" : "Owner Settings"}
        </div>
        <ul className="space-y-0.5">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => switchTab(t.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-foreground/75 hover:bg-secondary hover:text-foreground"
                  } ${t.id === "danger-zone" ? "mt-4 text-destructive hover:text-destructive hover:bg-destructive/10" : ""}`}
                >
                  <Icon size={15} strokeWidth={2.1} />
                  {t.label}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>}

      {/* Tab content */}
      <main className="flex-1 overflow-y-auto p-6 scrollbar-thin">
        {!orgId ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {!transferOnly && tab === "lab-profile" && <LabProfileTab orgId={orgId} />}
            {!transferOnly && tab === "team" && <TeamTab orgId={orgId} />}
            {!transferOnly && tab === "revenue" && <RevenueTab orgId={orgId} />}
            {(transferOnly || tab === "danger-zone") && <DangerZoneTab orgId={orgId} transferOnly={transferOnly} />}
            {tab === "billing" && null}
          </>
        )}
      </main>
    </div>
  );
}
// ─── Lab Profile ─────────────────────────────────────────────────────────────

interface LabProfile {
  id: string;
  name: string;
  displayName: string | null;
  billingEmail: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  licenseNumber: string | null;
}

function LabProfileTab({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const query = useQuery<LabProfile>({
    queryKey: ["owner", "lab-profile", orgId],
    queryFn: () => apiFetch<LabProfile>(`/owner/lab-profile?organizationId=${orgId}`),
  });

  const [form, setForm] = useState<Partial<LabProfile>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (query.data) setForm(query.data);
  }, [query.data]);

  const mutation = useMutation({
    mutationFn: (data: Partial<LabProfile> & { organizationId: string }) =>
      apiFetch("/owner/lab-profile", { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["owner", "lab-profile", orgId] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  function field(
    label: string,
    key: keyof LabProfile,
    type: string = "text",
    placeholder?: string
  ) {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">{label}</label>
        <input
          type={type}
          value={(form[key] as string) ?? ""}
          placeholder={placeholder}
          onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
          className="h-9 rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>
    );
  }

  if (query.isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Lab Profile</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Update your lab's name, contact information, and address.
        </p>
      </div>

      <div className="bg-card border border-border rounded-lg p-5 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          {field("Lab Name", "name")}
          {field("Display Name", "displayName", "text", "Overrides lab name in PDFs")}
        </div>
        <div className="grid grid-cols-2 gap-4">
          {field("Billing Email", "billingEmail", "email")}
          {field("Phone", "phone", "tel")}
        </div>
        {field("Address Line 1", "addressLine1")}
        {field("Address Line 2", "addressLine2")}
        <div className="grid grid-cols-3 gap-4">
          {field("City", "city")}
          {field("State", "state")}
          {field("ZIP", "zip")}
        </div>
        {field("License / Registration Number", "licenseNumber")}

        {mutation.isError && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 text-destructive px-3 py-2 text-sm">
            <AlertCircle size={14} />
            {(mutation.error as Error)?.message ?? "Failed to save changes."}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          {saved && (
            <span className="flex items-center gap-1.5 text-sm text-green-600">
              <CheckCircle2 size={14} /> Saved
            </span>
          )}
          <button
            type="button"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate({ ...form, organizationId: orgId } as any)
            }
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors"
          >
            {mutation.isPending && <Loader2 size={14} className="animate-spin" />}
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Team & Roles ─────────────────────────────────────────────────────────────

interface TeamMember {
  membershipId: string;
  userId: string;
  role: string;
  status: string;
  joinedAt: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  username: string | null;
}

const ROLE_OPTIONS = ["owner", "admin", "billing", "user", "read_only"] as const;
const ROLE_LABELS = MEMBERSHIP_ROLE_LABELS;

function TeamTab({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState("");

  const query = useQuery<TeamMember[]>({
    queryKey: ["owner", "team", orgId],
    queryFn: () => apiFetch<TeamMember[]>(`/owner/team?organizationId=${orgId}`),
  });

  const roleMutation = useMutation({
    mutationFn: ({
      userId,
      role,
    }: {
      userId: string;
      role: string;
    }) =>
      apiFetch(`/owner/team/${userId}/role`, {
        method: "PATCH",
        body: JSON.stringify({ organizationId: orgId, role }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["owner", "team", orgId] });
      qc.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) =>
      apiFetch(`/owner/team/${userId}`, {
        method: "DELETE",
        body: JSON.stringify({ organizationId: orgId }),
      }),
    onSuccess: () => {
      setConfirmRemove(null);
      setRemoveError("");
      qc.invalidateQueries({ queryKey: ["owner", "team", orgId] });
      qc.invalidateQueries({ queryKey: ["auth", "me"] });
    },
    onError: (err: Error) => {
      setRemoveError(err.message ?? "Failed to remove member.");
    },
  });

  if (query.isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  const members = query.data ?? [];

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Team & Roles</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your team members and their roles. Only you can promote someone to owner or demote an owner.
        </p>
      </div>

      {roleMutation.isError && (
        <div className="flex items-center gap-2 rounded-md bg-destructive/10 text-destructive px-3 py-2 text-sm mb-4">
          <AlertCircle size={14} />
          {(roleMutation.error as Error)?.message ?? "Failed to change role."}
        </div>
      )}

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/30">
            <tr>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Member</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Email</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Role</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {members.map((m) => {
              const displayName =
                [m.firstName, m.lastName].filter(Boolean).join(" ") ||
                m.username ||
                m.userId;
              const isPendingRemove = confirmRemove === m.userId;
              return (
                <Fragment key={m.membershipId}>
                  <tr className="hover:bg-muted/20">
                    <td className="px-4 py-3 font-medium">{displayName}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {m.email ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={m.role}
                        disabled={roleMutation.isPending || removeMutation.isPending}
                        onChange={(e) =>
                          roleMutation.mutate({ userId: m.userId, role: e.target.value })
                        }
                        className="h-7 rounded border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        {ROLE_OPTIONS.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r] ?? r}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        title="Remove member"
                        disabled={roleMutation.isPending || removeMutation.isPending}
                        onClick={() => {
                          setRemoveError("");
                          setConfirmRemove(isPendingRemove ? null : m.userId);
                        }}
                        className="inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-40 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                  {isPendingRemove && (
                    <tr key={`${m.membershipId}-confirm`} className="bg-destructive/5">
                      <td colSpan={4} className="px-4 py-3">
                        <div className="flex flex-col gap-2">
                          <p className="text-sm font-medium text-destructive">
                            Remove <span className="font-semibold">{displayName}</span> from the lab?
                          </p>
                          <p className="text-xs text-muted-foreground">
                            They will immediately lose access. This action can be undone by re-inviting them.
                          </p>
                          {removeError && (
                            <p className="text-xs text-destructive">{removeError}</p>
                          )}
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={removeMutation.isPending}
                              onClick={() => removeMutation.mutate(m.userId)}
                              className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60 transition-colors"
                            >
                              {removeMutation.isPending && (
                                <Loader2 size={11} className="animate-spin" />
                              )}
                              Remove
                            </button>
                            <button
                              type="button"
                              disabled={removeMutation.isPending}
                              onClick={() => { setConfirmRemove(null); setRemoveError(""); }}
                              className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {members.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground text-sm">
                  No team members found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Revenue Reports ──────────────────────────────────────────────────────────

type GroupBy = "month" | "practice" | "restoration_type";
type Period = "month" | "quarter" | "year";

interface RevenueItem {
  label: string;
  revenue: string;
  invoiceCount?: number;
  count?: number;
  practiceOrgId?: string | null;
}

interface RevenueReport {
  groupBy: GroupBy;
  items: RevenueItem[];
  totalRevenue: string;
}

const GROUP_BY_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "month", label: "By Month" },
  { value: "practice", label: "By Practice" },
  { value: "restoration_type", label: "By Restoration Type" },
];

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "month", label: "This Month" },
  { value: "quarter", label: "This Quarter" },
  { value: "year", label: "This Year" },
];

function fmt(amount: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(parseFloat(amount));
  } catch {
    return `$${amount}`;
  }
}

function RevenueTab({ orgId }: { orgId: string }) {
  const [period, setPeriod] = useState<Period>("month");
  const [groupBy, setGroupBy] = useState<GroupBy>("month");
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const query = useQuery<RevenueReport>({
    queryKey: ["owner", "revenue-report", orgId, period, groupBy],
    queryFn: () =>
      apiFetch<RevenueReport>(
        `/owner/revenue-report?organizationId=${orgId}&period=${period}&groupBy=${groupBy}`
      ),
  });

  const report = query.data;

  const periodLabel = PERIOD_OPTIONS.find((o) => o.value === period)?.label ?? period;
  const groupLabel = GROUP_BY_OPTIONS.find((o) => o.value === groupBy)?.label ?? groupBy;
  const colHeader =
    groupBy === "month" ? "Month" : groupBy === "practice" ? "Practice" : "Restoration Type";

  async function exportReport(format: "pdf" | "png") {
    if (!report) return;
    setExporting(true);
    setExportOpen(false);
    try {
      const items = report.items;
      const totalFmt = fmt(report.totalRevenue);
      const title = `Revenue Report — ${periodLabel} (${groupLabel})`;
      const filename = `revenue-report-${period}-${groupBy}`;
      const showChart = groupBy === "month" && items.length > 0;
      const maxVal = showChart
        ? Math.max(...items.map((i) => parseFloat(i.revenue) || 0))
        : 0;

      if (format === "pdf") {
        const { jsPDF } = await import("jspdf");
        const autoTable = (await import("jspdf-autotable")).default;
        const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
        const pageW = doc.internal.pageSize.getWidth();
        const margin = 40;

        doc.setFontSize(16);
        doc.setFont("helvetica", "bold");
        doc.text(title, margin, 50);

        doc.setFontSize(11);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(80, 80, 80);
        doc.text(`Total Revenue: ${totalFmt}`, margin, 68);

        let curY = 88;

        if (showChart) {
          const chartW = pageW - 2 * margin;
          const chartH = 150;
          const barAreaH = chartH - 24;
          const barGap = 5;
          const barW = Math.min(
            44,
            (chartW - barGap * (items.length + 1)) / items.length
          );
          const totalBarW = barW * items.length + barGap * (items.length - 1);
          const startX = margin + (chartW - totalBarW) / 2;

          doc.setFillColor(59, 130, 246);
          items.forEach((item, idx) => {
            const val = parseFloat(item.revenue) || 0;
            const bH = maxVal > 0 ? (val / maxVal) * barAreaH : 0;
            const bx = startX + idx * (barW + barGap);
            const by = curY + barAreaH - bH;
            if (bH > 0) doc.roundedRect(bx, by, barW, bH, 2, 2, "F");
            doc.setFontSize(7);
            doc.setTextColor(130, 130, 130);
            doc.text(item.label, bx + barW / 2, curY + barAreaH + 14, {
              align: "center",
            });
          });
          curY += chartH + 12;
        }

        autoTable(doc, {
          startY: curY,
          head: [[colHeader, "Revenue", "Count"]],
          body: items.map((item) => [
            item.label,
            fmt(item.revenue),
            String(item.invoiceCount ?? item.count ?? "—"),
          ]),
          foot: [["Total", totalFmt, ""]],
          styles: { fontSize: 9 },
          headStyles: { fillColor: [59, 130, 246], textColor: 255 },
          footStyles: { fontStyle: "bold", fillColor: [243, 244, 246] },
          alternateRowStyles: { fillColor: [249, 250, 251] },
          margin: { left: margin, right: margin },
        });

        doc.save(`${filename}.pdf`);
      } else {
        const dpr = 2;
        const canvasW = 800;
        const marginC = 40;
        const rowH = 28;
        const headerH = 60;
        const chartCanvasH = showChart ? 200 : 0;
        const tableH = (items.length + 2) * rowH;
        const totalH = headerH + chartCanvasH + tableH + 24;

        const canvas = document.createElement("canvas");
        canvas.width = canvasW * dpr;
        canvas.height = totalH * dpr;
        const ctx = canvas.getContext("2d")!;
        ctx.scale(dpr, dpr);

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvasW, totalH);

        ctx.font = "bold 15px system-ui, sans-serif";
        ctx.fillStyle = "#111827";
        ctx.textAlign = "left";
        ctx.fillText(title, marginC, 32);

        ctx.font = "12px system-ui, sans-serif";
        ctx.fillStyle = "#6b7280";
        ctx.fillText(`Total Revenue: ${totalFmt}`, marginC, 52);

        let cy = headerH;

        if (showChart) {
          const chartW = canvasW - 2 * marginC;
          const barAreaH = chartCanvasH - 28;
          const barGap = 5;
          const barW = Math.min(
            44,
            (chartW - barGap * (items.length + 1)) / items.length
          );
          const totalBarW = barW * items.length + barGap * (items.length - 1);
          const startX = marginC + (chartW - totalBarW) / 2;

          items.forEach((item, idx) => {
            const val = parseFloat(item.revenue) || 0;
            const bH = maxVal > 0 ? (val / maxVal) * barAreaH : 0;
            const bx = startX + idx * (barW + barGap);
            const by = cy + barAreaH - bH;
            if (bH > 0) {
              ctx.fillStyle = "#3b82f6";
              ctx.beginPath();
              (ctx as CanvasRenderingContext2D & { roundRect: Function }).roundRect(
                bx,
                by,
                barW,
                bH,
                [3, 3, 0, 0]
              );
              ctx.fill();
            }
            ctx.font = "9px system-ui, sans-serif";
            ctx.fillStyle = "#9ca3af";
            ctx.textAlign = "center";
            ctx.fillText(item.label, bx + barW / 2, cy + barAreaH + 16);
          });
          cy += chartCanvasH;
        }

        const tableX = marginC;
        const tableW = canvasW - 2 * marginC;
        const col1W = tableW * 0.5;
        const col2W = tableW * 0.3;

        ctx.fillStyle = "#3b82f6";
        ctx.fillRect(tableX, cy, tableW, rowH);
        ctx.font = "bold 11px system-ui, sans-serif";
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "left";
        ctx.fillText(colHeader, tableX + 10, cy + rowH * 0.66);
        ctx.textAlign = "right";
        ctx.fillText("Revenue", tableX + col1W + col2W - 10, cy + rowH * 0.66);
        ctx.fillText("Count", tableX + tableW - 10, cy + rowH * 0.66);
        cy += rowH;

        items.forEach((item, idx) => {
          ctx.fillStyle = idx % 2 === 0 ? "#f9fafb" : "#ffffff";
          ctx.fillRect(tableX, cy, tableW, rowH);
          ctx.font = "11px system-ui, sans-serif";
          ctx.fillStyle = "#111827";
          ctx.textAlign = "left";
          ctx.fillText(item.label, tableX + 10, cy + rowH * 0.66);
          ctx.textAlign = "right";
          ctx.fillText(fmt(item.revenue), tableX + col1W + col2W - 10, cy + rowH * 0.66);
          ctx.fillStyle = "#6b7280";
          ctx.fillText(
            String(item.invoiceCount ?? item.count ?? "—"),
            tableX + tableW - 10,
            cy + rowH * 0.66
          );
          cy += rowH;
        });

        ctx.fillStyle = "#f3f4f6";
        ctx.fillRect(tableX, cy, tableW, rowH);
        ctx.font = "bold 11px system-ui, sans-serif";
        ctx.fillStyle = "#111827";
        ctx.textAlign = "left";
        ctx.fillText("Total", tableX + 10, cy + rowH * 0.66);
        ctx.textAlign = "right";
        ctx.fillText(totalFmt, tableX + col1W + col2W - 10, cy + rowH * 0.66);

        const dataUrl = canvas.toDataURL("image/png");
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = `${filename}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Revenue Reports</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Lab-wide revenue summaries. Read-only view based on issued invoices.
        </p>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as Period)}
          className="h-8 rounded border border-border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        >
          {PERIOD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as GroupBy)}
          className="h-8 rounded border border-border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        >
          {GROUP_BY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {query.isFetching && (
          <Loader2 size={15} className="animate-spin text-muted-foreground" />
        )}
        <div className="relative ml-auto">
          <button
            type="button"
            disabled={!report || exporting}
            onClick={() => setExportOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 h-8 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-secondary disabled:opacity-50 transition-colors"
          >
            {exporting ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Download size={13} />
            )}
            Export
          </button>
          {exportOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setExportOpen(false)}
              />
              <div className="absolute right-0 top-full mt-1 z-20 w-44 rounded-md border border-border bg-popover shadow-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => exportReport("pdf")}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted transition-colors"
                >
                  <FileText size={14} className="text-muted-foreground" />
                  Export as PDF
                </button>
                <button
                  type="button"
                  onClick={() => exportReport("png")}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted transition-colors"
                >
                  <FileImage size={14} className="text-muted-foreground" />
                  Export as PNG
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {query.isError && (
        <div className="flex items-center gap-2 rounded-md bg-destructive/10 text-destructive px-3 py-2 text-sm mb-4">
          <AlertCircle size={14} />
          {(query.error as Error)?.message ?? "Failed to load report."}
        </div>
      )}

      {report && (
        <>
          <div className="bg-primary/5 border border-primary/20 rounded-lg px-4 py-3 mb-4 flex items-center gap-3">
            <BarChart3 size={18} className="text-primary shrink-0" />
            <div>
              <div className="text-xs text-muted-foreground">Total Revenue</div>
              <div className="text-xl font-semibold">{fmt(report.totalRevenue)}</div>
            </div>
          </div>

          {report.items.length > 0 && (
            <div className="bg-card border border-border rounded-lg px-4 pt-4 pb-2 mb-4">
              <div className="text-xs font-medium text-muted-foreground mb-3">
                {groupBy === "month" ? "Monthly Revenue" : groupBy === "practice" ? "Revenue by Practice" : "Revenue by Restoration Type"}
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={report.items.map((item) => ({
                    label: item.label,
                    revenue: parseFloat(item.revenue) || 0,
                  }))}
                  margin={{ top: 4, right: 8, left: 8, bottom: groupBy === "month" ? 4 : 24 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={false}
                    tickLine={false}
                    interval={0}
                    tickFormatter={(v: string) =>
                      v.length > 14 ? v.slice(0, 13) + "…" : v
                    }
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: number) =>
                      v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`
                    }
                    width={48}
                  />
                  <Tooltip
                    formatter={(value: number) => [fmt(String(value)), "Revenue"]}
                    contentStyle={{
                      fontSize: 12,
                      borderRadius: "6px",
                      border: "1px solid hsl(var(--border))",
                      background: "hsl(var(--popover))",
                      color: "hsl(var(--popover-foreground))",
                    }}
                    cursor={{ fill: "hsl(var(--muted))", opacity: 0.5 }}
                  />
                  <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={48} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/30">
                <tr>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    {groupBy === "month" ? "Month" : groupBy === "practice" ? "Practice" : "Restoration Type"}
                  </th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Revenue</th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.items.map((item, i) => (
                  <tr key={i} className="hover:bg-muted/20">
                    <td className="px-4 py-3 font-medium">{item.label}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{fmt(item.revenue)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {item.invoiceCount ?? item.count ?? "—"}
                    </td>
                  </tr>
                ))}
                {report.items.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-muted-foreground text-sm">
                      No revenue data for this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Danger Zone ──────────────────────────────────────────────────────────────

interface DangerZoneTabProps {
  orgId: string;
  transferOnly?: boolean;
}

function DangerZoneTab({ orgId, transferOnly = false }: DangerZoneTabProps) {
  const [, setLocation] = useLocation();
  const { refresh } = useAuth();
  const qc = useQueryClient();

  const meQuery = useQuery<MeResponse>({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
  });

  const labProfile = useQuery<LabProfile>({
    queryKey: ["owner", "lab-profile", orgId],
    queryFn: () => apiFetch<LabProfile>(`/owner/lab-profile?organizationId=${orgId}`),
  });

  const teamQuery = useQuery<TeamMember[]>({
    queryKey: ["owner", "team", orgId],
    queryFn: () => apiFetch<TeamMember[]>(`/owner/team?organizationId=${orgId}`),
  });

  const labName = labProfile.data
    ? (labProfile.data.displayName || labProfile.data.name)
    : "";

  const otherMembers = useMemo(() => {
    const myId = (meQuery.data as any)?.user?.id ?? "";
    return (teamQuery.data ?? []).filter((m) => m.userId !== myId && m.status === "active");
  }, [teamQuery.data, meQuery.data]);

  // Transfer state
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferTarget, setTransferTarget] = useState("");
  const [transferPhrase, setTransferPhrase] = useState("");
  const [transferError, setTransferError] = useState("");

  const transferMutation = useMutation({
    mutationFn: (data: {
      organizationId: string;
      newOwnerUserId: string;
      confirmationPhrase: string;
    }) =>
      apiFetch("/owner/transfer-ownership", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      setShowTransfer(false);
      void qc.invalidateQueries({ queryKey: ["auth", "me"] });
      void qc.invalidateQueries({ queryKey: ["lab-team"] });
      void qc.invalidateQueries({ queryKey: ["owner"] });
      void refresh().catch(() => {});
      setLocation("/");
    },
    onError: (e: Error) => setTransferError(e.message),
  });

  // Delete state
  const [showDelete, setShowDelete] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState("");
  const [deleteError, setDeleteError] = useState("");

  interface DeleteLabSummary {
    activeMembers: number;
    memberNames: string[];
    memberNamesOverflow: number;
    openCases: number;
    unpaidInvoices: number;
    unpaidInvoicesTotal: string;
  }

  const deleteSummaryQuery = useQuery<DeleteLabSummary>({
    queryKey: ["owner", "delete-lab-summary", orgId],
    queryFn: () =>
      apiFetch<DeleteLabSummary>(`/owner/delete-lab-summary?organizationId=${orgId}`),
    enabled: showDelete,
  });

  const deleteMutation = useMutation({
    mutationFn: (data: { organizationId: string; confirmationPhrase: string }) =>
      apiFetch("/owner/delete-lab", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["auth", "me"] });
      setLocation("/");
    },
    onError: (e: Error) => setDeleteError(e.message),
  });

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-destructive">{transferOnly ? "Transfer Ownership" : "Danger Zone"}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          These actions are irreversible. Proceed with caution.
        </p>
      </div>

      <div className="space-y-4">
        {/* Transfer Ownership */}
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="flex items-start gap-3">
            <ArrowRightLeft size={18} className="text-amber-500 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm">Transfer Ownership</div>
              <p className="text-xs text-muted-foreground mt-1">
                Transfer ownership of this organization to another active member. You will remain Administrator.
              </p>
              {!showTransfer ? (
                <button
                  type="button"
                  onClick={() => setShowTransfer(true)}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 transition-colors dark:bg-amber-900/20 dark:border-amber-700 dark:text-amber-400"
                >
                  Transfer Ownership…
                </button>
              ) : (
                <div className="mt-3 space-y-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">New Owner</label>
                    <select
                      aria-label="New Owner"
                      disabled={transferMutation.isPending}
                      value={transferTarget}
                      onChange={(e) => setTransferTarget(e.target.value)}
                      className="mt-1 w-full h-9 rounded border border-border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="">Select a team member…</option>
                      {otherMembers.map((m) => {
                        const name =
                          [m.firstName, m.lastName].filter(Boolean).join(" ") ||
                          m.username ||
                          m.userId;
                        return (
                          <option key={m.userId} value={m.userId}>
                            {name}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">
                      Type <strong>{labName}</strong> to confirm
                    </label>
                    <input
                      value={transferPhrase}
                      aria-label="Organization name confirmation"
                      disabled={transferMutation.isPending}
                      onChange={(e) => setTransferPhrase(e.target.value)}
                      placeholder={labName}
                      className="mt-1 w-full h-9 rounded border border-border bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  {transferError && (
                    <p className="text-xs text-destructive">{transferError}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setTransferError("");
                        transferMutation.mutate({
                          organizationId: orgId,
                          newOwnerUserId: transferTarget,
                          confirmationPhrase: transferPhrase,
                        });
                      }}
                      disabled={!otherMembers.some((m) => m.userId === transferTarget) || !transferPhrase || transferMutation.isPending}
                      className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-60 transition-colors"
                    >
                      {transferMutation.isPending && <Loader2 size={12} className="animate-spin" />}
                      Confirm Transfer
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowTransfer(false); setTransferError(""); }}
                      className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Delete Lab */}
        {!transferOnly && <div className="bg-card border border-destructive/30 rounded-lg p-5">
          <div className="flex items-start gap-3">
            <Trash2 size={18} className="text-destructive mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm text-destructive">Delete Lab</div>
              <p className="text-xs text-muted-foreground mt-1">
                Permanently deactivate this lab. All members will lose access.
                Cases, invoices, and records are preserved (soft-deleted) for compliance.
              </p>
              {!showDelete ? (
                <button
                  type="button"
                  onClick={() => setShowDelete(true)}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors"
                >
                  Delete Lab…
                </button>
              ) : (
                <div className="mt-3 space-y-3">
                  {/* Summary card */}
                  <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-3">
                    <p className="text-xs font-medium text-destructive mb-2">
                      The following will be soft-deleted and lose access:
                    </p>
                    {deleteSummaryQuery.isLoading ? (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Loader2 size={11} className="animate-spin" />
                        Loading summary…
                      </div>
                    ) : deleteSummaryQuery.data ? (
                      <div className="space-y-2">
                        <div className="grid grid-cols-3 gap-2">
                          <div className="flex flex-col items-center rounded-md bg-background border border-border px-2 py-2 gap-0.5">
                            <Users size={14} className="text-destructive mb-0.5" />
                            <span className="text-base font-bold tabular-nums leading-none">
                              {deleteSummaryQuery.data.activeMembers}
                            </span>
                            <span className="text-[10px] text-muted-foreground text-center leading-tight">
                              Active Members
                            </span>
                          </div>
                          <div className="flex flex-col items-center rounded-md bg-background border border-border px-2 py-2 gap-0.5">
                            <AlertTriangle size={14} className="text-destructive mb-0.5" />
                            <span className="text-base font-bold tabular-nums leading-none">
                              {deleteSummaryQuery.data.openCases}
                            </span>
                            <span className="text-[10px] text-muted-foreground text-center leading-tight">
                              Open Cases
                            </span>
                          </div>
                          <div className="flex flex-col items-center rounded-md bg-background border border-border px-2 py-2 gap-0.5">
                            <FileText size={14} className="text-destructive mb-0.5" />
                            <span className="text-base font-bold tabular-nums leading-none">
                              {deleteSummaryQuery.data.unpaidInvoices}
                            </span>
                            <span className="text-[10px] text-muted-foreground text-center leading-tight">
                              Unpaid Inv.
                            </span>
                            {parseFloat(deleteSummaryQuery.data.unpaidInvoicesTotal) > 0 && (
                              <span className="text-[10px] font-semibold text-destructive tabular-nums leading-tight">
                                {fmt(deleteSummaryQuery.data.unpaidInvoicesTotal)}
                              </span>
                            )}
                          </div>
                        </div>
                        {deleteSummaryQuery.data.memberNames.length > 0 && (
                          <div className="rounded-md bg-background border border-border px-2.5 py-1.5">
                            <span className="text-[10px] font-medium text-muted-foreground">Members losing access: </span>
                            <span className="text-[10px] text-foreground">
                              {deleteSummaryQuery.data.memberNames.join(", ")}
                              {deleteSummaryQuery.data.memberNamesOverflow > 0 && (
                                <span className="text-muted-foreground"> +{deleteSummaryQuery.data.memberNamesOverflow} more</span>
                              )}
                            </span>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">
                      Type <strong>{labName}</strong> to confirm deletion
                    </label>
                    <input
                      value={deletePhrase}
                      onChange={(e) => setDeletePhrase(e.target.value)}
                      placeholder={labName}
                      className="mt-1 w-full h-9 rounded border border-destructive/30 bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-destructive"
                    />
                  </div>
                  {deleteError && (
                    <p className="text-xs text-destructive">{deleteError}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteError("");
                        deleteMutation.mutate({
                          organizationId: orgId,
                          confirmationPhrase: deletePhrase,
                        });
                      }}
                      disabled={!deletePhrase || deleteMutation.isPending}
                      className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60 transition-colors"
                    >
                      {deleteMutation.isPending && <Loader2 size={12} className="animate-spin" />}
                      Delete Lab
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowDelete(false); setDeleteError(""); }}
                      className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>}
      </div>
    </div>
  );
}
