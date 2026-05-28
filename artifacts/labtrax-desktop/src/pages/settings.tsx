import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Building2, Check, ChevronDown, ChevronRight, Clock, Copy, CreditCard, Download, ExternalLink, FileDown, Github, History, KeyRound, LayoutList, Loader2, LogOut, Monitor, Package, Pencil, Play, RotateCcw, RefreshCcw, Search, ShieldCheck, Smartphone, Sparkles, Trash2, Upload, User as UserIcon, UserMinus, Wrench, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { apiFetch, apiFetchArrayBuffer, ApiError, notifySessionCleared, getApiOrigin } from "@/lib/api";
import {
  DEFAULT_DUP_SIMILARITY_THRESHOLD,
  buildDuplicateClusters,
  resolveLabDupThreshold,
  type DoctorRow,
} from "@/pages/doctors";
import {
  DEFAULT_PRACTICE_DUP_SIMILARITY_THRESHOLD,
  buildPracticeDuplicateClusters,
} from "@/pages/practices";
import type { LabCase, Invoice } from "@/lib/types";
import { usePlatformAdminGate, PlatformAdminSetupNotice } from "@/lib/platform-admin-gate";
import { getSessionSecret, clearSessionSecret, useSessionSecretVersion } from "@/lib/platform-admin-session";
import { formatPhone } from "@/lib/format";
import { useAuth } from "@/lib/auth-context";
import type { MeResponse, Organization, OrgMemberRow } from "@/lib/types";
import { InvoiceLayoutPanel } from "@/pages/invoice-layout-panel";
import { StatementLayoutPanel } from "@/pages/statement-layout-panel";
import { CorrespondenceLayoutPanel } from "@/pages/correspondence-layout-panel";

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

type TabKey = "profile" | "password" | "two-factor" | "sessions" | "organizations" | "users" | "backup" | "desktop" | "mobile" | "itero" | "platform-admin" | "subscriptions" | "notifications" | "templates" | "statement-layout" | "correspondence-layout" | "invoice-layout";

const VALID_TAB_KEYS: TabKey[] = ["profile", "password", "two-factor", "sessions", "organizations", "users", "backup", "desktop", "mobile", "itero", "platform-admin", "subscriptions", "notifications", "templates", "statement-layout", "correspondence-layout", "invoice-layout"];

function readInitialTab(): TabKey {
  if (typeof window === "undefined") return "profile";
  try {
    const search = new URLSearchParams(window.location.search);
    const requested = search.get("tab") as TabKey | null;
    if (requested && VALID_TAB_KEYS.includes(requested)) return requested;
  } catch {
    /* ignore */
  }
  return "profile";
}

export default function SettingsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const hasPlatformAdminBridge = typeof window !== "undefined" &&
    !!(window as { electronAPI?: { platformAdmin?: unknown } }).electronAPI?.platformAdmin;
  const tabs: Array<{ key: TabKey; label: string; icon: typeof UserIcon; show: boolean; parentKey?: TabKey }> = [
    { key: "profile", label: "Profile", icon: UserIcon, show: true },
    { key: "password", label: "Password", icon: KeyRound, show: true },
    { key: "two-factor", label: "Two-factor auth", icon: ShieldCheck, show: true },
    { key: "sessions", label: "Active sessions", icon: Monitor, show: true },
    { key: "organizations", label: "Organizations", icon: Building2, show: true },
    { key: "users", label: "Users", icon: ShieldCheck, show: isAdmin },
    { key: "backup", label: "Backup", icon: ShieldCheck, show: isAdmin },
    { key: "desktop", label: "Desktop app", icon: Download, show: true },
    { key: "templates", label: "Templates", icon: LayoutList, show: isAdmin },
    { key: "invoice-layout", label: "Invoice layout", icon: LayoutList, show: isAdmin, parentKey: "templates" },
    { key: "statement-layout", label: "Statement layout", icon: LayoutList, show: isAdmin, parentKey: "templates" },
    { key: "correspondence-layout", label: "Correspondence layout", icon: LayoutList, show: isAdmin, parentKey: "templates" },
    { key: "mobile", label: "Mobile app", icon: Smartphone, show: isAdmin },
    { key: "itero", label: "iTero auto-import", icon: Sparkles, show: isAdmin && typeof window !== "undefined" && !!(window as { electronAPI?: { itero?: unknown } }).electronAPI?.itero },
    { key: "platform-admin", label: "Platform admin", icon: Wrench, show: isAdmin },
    { key: "subscriptions", label: "Subscriptions", icon: CreditCard, show: isAdmin },
    { key: "notifications", label: "Notifications", icon: Monitor, show: true },
  ];
  const [tab, setTab] = useState<TabKey>(readInitialTab);

  const backupScheduleQuery = useQuery<{ lastSuccessfulBackupAt?: string | null; staleAfterDays?: number }>({
    enabled: isAdmin,
    queryKey: ["admin", "backup-schedule-v2"],
    queryFn: () => apiFetch("/admin/backup/schedule"),
    staleTime: 5 * 60 * 1000,
  });
  const backupOverdue = isAdmin && backupScheduleQuery.isSuccess && (() => {
    const last = backupScheduleQuery.data?.lastSuccessfulBackupAt;
    if (!last) return true;
    const t = new Date(last).getTime();
    const staleDays = backupScheduleQuery.data?.staleAfterDays ?? 7;
    return Number.isNaN(t) ? true : Date.now() - t > staleDays * 24 * 60 * 60 * 1000;
  })();

  return (
    <div className="px-8 py-7 max-w-[1100px] mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Admin Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your profile, password, and lab workspace.
        </p>
      </div>

      <div className="flex gap-6">
        <nav className="w-48 shrink-0">
          <ul className="space-y-1">
            {tabs.filter((t) => t.show && !t.parentKey).map((t) => {
              const Icon = t.icon;
              const active = tab === t.key;
              const children = tabs.filter((c) => c.show && c.parentKey === t.key);
              const childActive = children.some((c) => c.key === tab);
              return (
                <li key={t.key}>
                  <button
                    type="button"
                    onClick={() => {
                      if (children.length > 0) {
                        setTab(children[0].key);
                      } else {
                        setTab(t.key);
                      }
                    }}
                    title={t.key === "backup" && backupOverdue ? "Backup overdue — check backup settings" : undefined}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                      active ? "bg-primary/10 text-primary" : childActive ? "text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                    }`}
                  >
                    <Icon size={14} />
                    <span className="flex-1 text-left">{t.label}</span>
                    {t.key === "backup" && backupOverdue && (
                      <AlertTriangle size={13} className="shrink-0 text-amber-400" aria-label="Backup overdue" />
                    )}
                  </button>
                  {children.length > 0 && (
                    <ul className="mt-0.5 ml-3 border-l border-border/50 space-y-0.5 pl-2">
                      {children.map((c) => {
                        const childIsActive = tab === c.key;
                        return (
                          <li key={c.key}>
                            <button
                              type="button"
                              onClick={() => setTab(c.key)}
                              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
                                childIsActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                              }`}
                            >
                              <span className="flex-1 text-left">{c.label}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="flex-1 min-w-0 bg-card border border-border rounded-xl">
          {tab === "profile" && <ProfilePanel />}
          {tab === "password" && <PasswordPanel />}
          {tab === "two-factor" && <TwoFactorPanel />}
          {tab === "sessions" && <SessionsPanel />}
          {tab === "organizations" && <OrganizationsPanel />}
          {tab === "users" && isAdmin && <UsersPanel />}
          {tab === "backup" && isAdmin && <BackupPanel />}
          {tab === "desktop" && (isAdmin ? <DesktopInstallerPanel /> : <DesktopAppUserPanel />)}
          {tab === "invoice-layout" && isAdmin && <InvoiceLayoutPanel />}
          {tab === "statement-layout" && isAdmin && <StatementLayoutPanel />}
          {tab === "correspondence-layout" && isAdmin && <CorrespondenceLayoutPanel />}
          {tab === "mobile" && isAdmin && <MobileBuildPanel />}
          {tab === "itero" && isAdmin && <IteroPanel />}
          {tab === "platform-admin" && isAdmin && <PlatformAdminPanel />}
          {tab === "subscriptions" && isAdmin && <SubscriptionsPanel />}
          {tab === "notifications" && <NotificationsPanel isAdmin={isAdmin} />}
        </div>
      </div>
    </div>
  );
}

// Work-status presence values used by the API. UI labels them as
// "At work" / "On break" / "On lunch" / "Out of office".
const WORK_STATUS_OPTIONS: Array<{
  value: "available" | "break" | "lunch" | "out_of_office";
  label: string;
  dot: string;
}> = [
  { value: "available", label: "At work", dot: "bg-emerald-500" },
  { value: "break", label: "On break", dot: "bg-amber-500" },
  { value: "lunch", label: "On lunch", dot: "bg-orange-500" },
  { value: "out_of_office", label: "Out of office", dot: "bg-slate-400" },
];

function workStatusMeta(status: string | null | undefined) {
  return (
    WORK_STATUS_OPTIONS.find((s) => s.value === status) ??
    WORK_STATUS_OPTIONS[0]
  );
}

interface LabTeamMember {
  id: string;
  username: string;
  firstName?: string | null;
  lastName?: string | null;
  initials?: string | null;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
  workStatus: string;
  labNames: string[];
  isSelf: boolean;
}

const LOGO_PLACEMENT_OPTIONS = [
  { key: "invoices", label: "Invoices", desc: "Show logo on invoice PDFs sent to practices" },
  { key: "statements", label: "Statements", desc: "Show logo on monthly billing statement PDFs" },
  { key: "emails", label: "General emails", desc: "Include logo in outgoing email headers" },
  { key: "welcome_emails", label: "Invite & welcome emails", desc: "Show logo in team invitation emails" },
  { key: "payment_receipts", label: "Payment receipts", desc: "Show logo in payment confirmation emails" },
  { key: "case_exports", label: "Case export PDFs", desc: "Show logo on work order and case summary exports" },
  { key: "quotes", label: "Quotes & estimates", desc: "Show logo on quote documents" },
  { key: "sms", label: "SMS (text messages)", desc: "Include logo reference in text notifications" },
] as const;

function ProfilePanel() {
  const { user, refresh } = useAuth();
  const queryClient = useQueryClient();
  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [practiceName, setPracticeName] = useState(user?.practiceName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [showPlacementsModal, setShowPlacementsModal] = useState(false);
  const [placementsSelection, setPlacementsSelection] = useState<string[]>([]);
  const [placementsError, setPlacementsError] = useState<string | null>(null);

  useEffect(() => {
    setFirstName(user?.firstName ?? "");
    setLastName(user?.lastName ?? "");
    setEmail(user?.email ?? "");
    setPhone(user?.phone ?? "");
    setPracticeName(user?.practiceName ?? "");
  }, [user?.id]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error("Not signed in.");
      return apiFetch(`/auth/users/${user.id}/profile`, {
        method: "PUT",
        body: JSON.stringify({
          firstName,
          lastName,
          email,
          phone,
          practiceName,
        }),
      });
    },
    onSuccess: async () => {
      setSuccess(true);
      setError(null);
      await refresh();
      setTimeout(() => setSuccess(false), 2500);
    },
    onError: (err: Error) => {
      setSuccess(false);
      setError(err.message || "Could not save profile.");
    },
  });

  // Status selector — fires on click, no Save needed. Other lab
  // teammates see the new status the next time they re-fetch.
  const statusMutation = useMutation({
    mutationFn: async (next: (typeof WORK_STATUS_OPTIONS)[number]["value"]) => {
      return apiFetch(`/auth/me/status`, {
        method: "PATCH",
        body: JSON.stringify({ workStatus: next }),
      });
    },
    onSuccess: async () => {
      await refresh();
      void queryClient.invalidateQueries({ queryKey: ["lab-team"] });
    },
  });

  const teamQuery = useQuery<{ team: LabTeamMember[] }>({
    queryKey: ["lab-team"],
    queryFn: () => apiFetch("/auth/lab-team"),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const placementsMutation = useMutation({
    mutationFn: async (placements: string[]) => {
      if (!user?.practiceOrganizationId) throw new Error("No lab organization linked.");
      return apiFetch(
        `/organizations/${user.practiceOrganizationId}/logo-placements`,
        { method: "PATCH", body: JSON.stringify({ placements }) }
      );
    },
    onSuccess: async () => {
      setPlacementsError(null);
      await refresh();
      setShowPlacementsModal(false);
    },
    onError: (err: Error) => {
      setPlacementsError(err.message || "Could not save logo placement preferences.");
    },
  });

  const logoSizeMutation = useMutation({
    mutationFn: async (size: "small" | "medium" | "large") => {
      if (!user?.practiceOrganizationId) throw new Error("No lab organization linked.");
      const allPlacements = user?.practiceLogoplacements ?? ["invoices","statements","sms","emails","case_exports","quotes","welcome_emails","payment_receipts"];
      return apiFetch(
        `/organizations/${user.practiceOrganizationId}/logo-placements`,
        { method: "PATCH", body: JSON.stringify({ placements: allPlacements, logoPdfSize: size }) }
      );
    },
    onSuccess: async () => {
      await refresh();
    },
  });

  async function handleLogoFile(file: File) {
    setLogoError(null);
    if (!user?.practiceOrganizationId) {
      setLogoError("No lab organization linked to your profile yet.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setLogoError("Logo must be 5 MB or smaller.");
      return;
    }
    setLogoUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      await apiFetch(
        `/organizations/${user.practiceOrganizationId}/logo`,
        // apiFetch sets JSON headers by default; pass FormData and let
        // the browser set the multipart boundary automatically.
        { method: "POST", body: fd, headers: {} as any },
      );
      await refresh();
    } catch (err) {
      setLogoError(
        err instanceof ApiError
          ? (err.body as any)?.error || err.message
          : (err as Error).message || "Could not upload logo.",
      );
    } finally {
      setLogoUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const currentStatus = workStatusMeta(user?.workStatus);

  return (
    <>
    <PanelShell title="Profile" subtitle="Your personal info shown across LabTrax.">
      {error && <Alert tone="danger">{error}</Alert>}
      {success && <Alert tone="success">Profile saved.</Alert>}

      {/* Lab logo */}
      <div className="rounded-lg border border-border bg-secondary/20 p-4 mb-2">
        <div className="flex items-center gap-4">
          <div className="w-20 h-20 rounded-lg bg-background border border-border overflow-hidden flex items-center justify-center text-xs text-muted-foreground">
            {user?.practiceLogoUrl ? (
              <img
                src={user.practiceLogoUrl}
                alt="Lab logo"
                className="max-w-full max-h-full object-contain"
              />
            ) : (
              "No logo"
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">Lab logo</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Shown on invoices, statements, and the desktop header. PNG,
              JPG, SVG, or WebP, up to 5 MB.
            </p>
            {logoError && (
              <p className="text-xs text-destructive mt-1">{logoError}</p>
            )}
            <div className="mt-2 flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleLogoFile(f);
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={logoUploading || !user?.practiceOrganizationId}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-60"
              >
                <Upload size={12} />
                {logoUploading
                  ? "Uploading…"
                  : user?.practiceLogoUrl
                  ? "Replace logo"
                  : "Add a logo"}
              </button>
              <button
                type="button"
                onClick={() => {
                  const allPlacements = ["invoices","statements","sms","emails","case_exports","quotes","welcome_emails","payment_receipts"];
                  setPlacementsSelection(
                    user?.practiceLogoplacements ??
                    (user?.practiceLogoUrl ? allPlacements : [])
                  );
                  setPlacementsError(null);
                  setShowPlacementsModal(true);
                }}
                disabled={!user?.practiceLogoUrl || !user?.practiceOrganizationId}
                title={!user?.practiceLogoUrl ? "Upload a logo first to set placement preferences" : "Choose where the lab logo appears"}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-input bg-background text-xs font-semibold hover:bg-secondary disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <LayoutList size={12} />
                Add logo to documents
              </button>
            </div>
            {user?.practiceLogoUrl && (
              <div className="mt-3 flex items-center gap-2">
                <span className="text-xs text-muted-foreground">PDF logo size:</span>
                {(["small", "medium", "large"] as const).map((size) => {
                  const active = (user?.practiceLogoSize ?? "medium") === size;
                  return (
                    <button
                      key={size}
                      type="button"
                      onClick={() => logoSizeMutation.mutate(size)}
                      disabled={logoSizeMutation.isPending || !user?.practiceOrganizationId}
                      className={`h-7 px-3 rounded-md text-xs font-medium border transition-colors disabled:opacity-60 capitalize ${
                        active
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background border-input hover:bg-secondary"
                      }`}
                    >
                      {size}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Status pills */}
      <div className="rounded-lg border border-border bg-secondary/20 p-4 mb-2">
        <div className="flex items-center justify-between mb-2">
          <div>
            <div className="text-sm font-semibold">Status</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Visible to everyone in your lab.
            </p>
          </div>
          <div className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${currentStatus.dot}`} />
            {currentStatus.label}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {WORK_STATUS_OPTIONS.map((opt) => {
            const active = (user?.workStatus ?? "available") === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => statusMutation.mutate(opt.value)}
                disabled={statusMutation.isPending}
                className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-medium border transition-colors disabled:opacity-60 ${
                  active
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background border-input hover:bg-secondary"
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${opt.dot}`} />
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Editable profile fields */}
      <div className="grid grid-cols-2 gap-4">
        <Field label="First name">
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Last name">
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Phone">
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(formatPhone(e.target.value))}
            placeholder="000-000-0000"
            className={inputCls}
          />
        </Field>
        <Field label="Practice / lab name" full>
          <input value={practiceName} onChange={(e) => setPracticeName(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Username">
          <input value={user?.username ?? ""} disabled className={`${inputCls} bg-secondary/40 text-muted-foreground cursor-not-allowed`} />
        </Field>
        <Field label="Role">
          <input value={user?.role ?? ""} disabled className={`${inputCls} bg-secondary/40 text-muted-foreground cursor-not-allowed capitalize`} />
        </Field>
      </div>
      <div className="flex justify-end pt-1">
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
        >
          {mutation.isPending ? "Saving…" : "Save profile"}
        </button>
      </div>

      {/* Team status list */}
      <div className="rounded-lg border border-border mt-4">
        <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
          <div className="text-sm font-semibold">Lab team status</div>
          <div className="text-xs text-muted-foreground">
            {teamQuery.data?.team.length ?? 0} member
            {(teamQuery.data?.team.length ?? 0) === 1 ? "" : "s"}
          </div>
        </div>
        <ul className="divide-y divide-border">
          {teamQuery.isLoading && (
            <li className="px-4 py-3 text-xs text-muted-foreground">Loading…</li>
          )}
          {teamQuery.data?.team.map((m) => {
            const meta = workStatusMeta(m.workStatus);
            const name =
              [m.firstName, m.lastName].filter(Boolean).join(" ") || m.username;
            return (
              <li
                key={m.id}
                className="px-4 py-2.5 flex items-center justify-between text-sm"
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">
                    {name}
                    {m.isSelf && (
                      <span className="ml-1.5 text-xs text-muted-foreground font-normal">
                        (you)
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {m.role || "user"}
                    {m.email ? ` · ${m.email}` : ""}
                  </div>
                </div>
                <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
                  <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
                  {meta.label}
                </div>
              </li>
            );
          })}
          {!teamQuery.isLoading &&
            (teamQuery.data?.team.length ?? 0) === 0 && (
              <li className="px-4 py-3 text-xs text-muted-foreground">
                No teammates found.
              </li>
            )}
        </ul>
      </div>
    </PanelShell>
    {showPlacementsModal && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        onClick={() => setShowPlacementsModal(false)}
      >
        <div
          className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-sm mx-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-5 border-b border-border">
            <div className="font-semibold text-sm">Logo placement</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Choose where the lab logo appears on documents and communications.
            </p>
          </div>
          <div className="p-5 space-y-3 max-h-72 overflow-y-auto">
            {LOGO_PLACEMENT_OPTIONS.map((opt) => {
              const checked = placementsSelection.includes(opt.key);
              return (
                <label key={opt.key} className="flex items-start gap-3 cursor-pointer">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() =>
                      setPlacementsSelection((prev) =>
                        checked ? prev.filter((k) => k !== opt.key) : [...prev, opt.key]
                      )
                    }
                    className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center mt-0.5 transition-colors ${
                      checked
                        ? "bg-primary border-primary"
                        : "bg-background border-input hover:border-primary/50"
                    }`}
                  >
                    {checked && <Check size={10} className="text-primary-foreground" />}
                  </button>
                  <div>
                    <div className="text-sm font-medium leading-tight">{opt.label}</div>
                    <div className="text-xs text-muted-foreground">{opt.desc}</div>
                  </div>
                </label>
              );
            })}
          </div>
          {placementsError && (
            <div className="px-5 pb-1">
              <p className="text-xs text-destructive">{placementsError}</p>
            </div>
          )}
          <div className="p-5 border-t border-border flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowPlacementsModal(false)}
              className="h-8 px-3 rounded-md border border-input bg-background text-xs font-semibold hover:bg-secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => placementsMutation.mutate(placementsSelection)}
              disabled={placementsMutation.isPending}
              className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-60"
            >
              {placementsMutation.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

function PasswordPanel() {
  const { user } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error("Not signed in.");
      if (newPassword.length < 8) throw new Error("Password must be at least 8 characters.");
      if (newPassword !== confirm) throw new Error("New passwords do not match.");
      return apiFetch(`/auth/users/${user.id}/password`, {
        method: "PUT",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
    },
    onSuccess: () => {
      setSuccess(true);
      setError(null);
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      setTimeout(() => setSuccess(false), 2500);
    },
    onError: (err: Error) => {
      setSuccess(false);
      setError(err.message || "Could not change password.");
    },
  });

  return (
    <PanelShell title="Password" subtitle="Change the password you use to sign in.">
      {error && <Alert tone="danger">{error}</Alert>}
      {success && <Alert tone="success">Password updated.</Alert>}
      <div className="grid grid-cols-1 gap-4 max-w-md">
        <Field label="Current password">
          <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className={inputCls} autoComplete="current-password" />
        </Field>
        <Field label="New password">
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={inputCls} autoComplete="new-password" />
        </Field>
        <Field label="Confirm new password">
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputCls} autoComplete="new-password" />
        </Field>
      </div>
      <div className="flex justify-end pt-1">
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || !currentPassword || !newPassword}
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
        >
          {mutation.isPending ? "Updating…" : "Update password"}
        </button>
      </div>
    </PanelShell>
  );
}

function TwoFactorPanel() {
  type Phase = "status" | "setup" | "confirm" | "backup-codes" | "disable" | "regen-confirm" | "regen-codes";
  const [phase, setPhase] = useState<Phase>("status");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [secretKey, setSecretKey] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [disableCode, setDisableCode] = useState("");
  const [regenCode, setRegenCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    apiFetch<{ data: { twoFactorEnabled: boolean } }>("/auth/2fa/status")
      .then((r) => { setEnabled(r.data.twoFactorEnabled); setLoading(false); })
      .catch(() => { setLoading(false); });
  }, []);

  async function startSetup() {
    setError(null);
    setBusy(true);
    try {
      const r = await apiFetch<{ data: { qrCodeDataUrl: string; secret: string } }>("/auth/2fa/setup", { method: "POST" });
      setQrCodeDataUrl(r.data.qrCodeDataUrl);
      setSecretKey(r.data.secret);
      setVerifyCode("");
      setPhase("setup");
    } catch (e: any) { setError(e.message || "Setup failed."); }
    finally { setBusy(false); }
  }

  async function confirmSetup() {
    if (!verifyCode.trim()) { setError("Please enter the 6-digit code from your authenticator app."); return; }
    setError(null);
    setBusy(true);
    try {
      const r = await apiFetch<{ data: { success: boolean; backupCodes: string[] } }>("/auth/2fa/confirm", {
        method: "POST",
        body: JSON.stringify({ code: verifyCode.trim() }),
      });
      setBackupCodes(r.data.backupCodes);
      setEnabled(true);
      setPhase("backup-codes");
    } catch (e: any) { setError(e.message || "Verification failed."); }
    finally { setBusy(false); }
  }

  async function disable2fa() {
    if (!disableCode.trim()) { setError("Please enter the code from your authenticator app."); return; }
    setError(null);
    setBusy(true);
    try {
      await apiFetch("/auth/2fa", { method: "DELETE", body: JSON.stringify({ code: disableCode.trim() }) });
      setEnabled(false);
      setDisableCode("");
      setPhase("status");
      setSuccess("Two-factor authentication has been disabled.");
      setTimeout(() => setSuccess(null), 4000);
    } catch (e: any) { setError(e.message || "Could not disable 2FA."); }
    finally { setBusy(false); }
  }

  async function regenerateBackupCodes() {
    if (!regenCode.trim()) { setError("Please enter the 6-digit code from your authenticator app."); return; }
    setError(null);
    setBusy(true);
    try {
      const r = await apiFetch<{ data: { backupCodes: string[] } }>("/auth/2fa/backup-codes", {
        method: "POST",
        body: JSON.stringify({ code: regenCode.trim() }),
      });
      setBackupCodes(r.data.backupCodes);
      setRegenCode("");
      setPhase("regen-codes");
    } catch (e: any) { setError(e.message || "Could not regenerate backup codes."); }
    finally { setBusy(false); }
  }

  function copyBackupCodes() {
    navigator.clipboard.writeText(backupCodes.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function downloadBackupCodes() {
    const blob = new Blob([backupCodes.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "labtrax-backup-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) {
    return (
      <PanelShell title="Two-factor authentication">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      </PanelShell>
    );
  }

  function BackupCodesDisplay({ title, subtitle }: { title: string; subtitle: string }) {
    return (
      <PanelShell title="Two-factor authentication" subtitle={subtitle}>
        <Alert tone="success">{title}</Alert>
        <div className="rounded-lg border border-border bg-secondary/20 p-4">
          <div className="text-sm font-semibold mb-2">Backup codes</div>
          <p className="text-xs text-muted-foreground mb-3">
            Each code can be used once in place of your authenticator code if you lose access to your device.
          </p>
          <div className="grid grid-cols-2 gap-1.5 font-mono text-sm mb-4">
            {backupCodes.map((c) => (
              <div key={c} className="px-2 py-1 bg-background border border-border rounded text-center tracking-wider">{c}</div>
            ))}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={copyBackupCodes}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-input bg-background text-xs font-semibold hover:bg-secondary">
              <Copy size={12} /> {copied ? "Copied!" : "Copy codes"}
            </button>
            <button type="button" onClick={downloadBackupCodes}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-input bg-background text-xs font-semibold hover:bg-secondary">
              <Download size={12} /> Download
            </button>
          </div>
        </div>
        <div className="flex justify-end">
          <button type="button" onClick={() => setPhase("status")}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90">
            Done
          </button>
        </div>
      </PanelShell>
    );
  }

  if (phase === "backup-codes") {
    return <BackupCodesDisplay title="Two-factor authentication is now active." subtitle="2FA is now enabled. Save these backup codes in a safe place." />;
  }

  if (phase === "regen-codes") {
    return <BackupCodesDisplay title="New backup codes generated. Your old codes are no longer valid." subtitle="Save these new backup codes in a safe place." />;
  }

  if (phase === "regen-confirm") {
    return (
      <PanelShell title="Regenerate backup codes" subtitle="Confirm with your current authenticator code to get a new set of backup codes. Your existing codes will be invalidated.">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="max-w-xs">
          <Field label="Authenticator code">
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              value={regenCode}
              onChange={(e) => { setRegenCode(e.target.value.replace(/\D/g, "")); setError(null); }}
              className={`${inputCls} text-center tracking-widest text-lg font-mono`}
              autoComplete="one-time-code"
              autoFocus
            />
          </Field>
        </div>
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={() => { setPhase("status"); setError(null); setRegenCode(""); }}
            className="h-9 px-4 rounded-md border border-input bg-background text-sm font-semibold hover:bg-secondary">
            Cancel
          </button>
          <button type="button" onClick={regenerateBackupCodes} disabled={busy || regenCode.length !== 6}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60">
            {busy ? "Generating…" : "Generate new codes"}
          </button>
        </div>
      </PanelShell>
    );
  }

  if (phase === "setup") {
    return (
      <PanelShell title="Set up two-factor authentication" subtitle="Scan the QR code with your authenticator app, then enter the 6-digit code to confirm.">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex flex-col items-center gap-4">
          {qrCodeDataUrl && <img src={qrCodeDataUrl} alt="QR code" className="w-48 h-48 border border-border rounded-lg" />}
          {secretKey && (
            <div className="text-center">
              <p className="text-xs text-muted-foreground mb-1">Or enter this key manually:</p>
              <code className="text-xs font-mono bg-secondary px-2 py-1 rounded tracking-widest select-all">{secretKey}</code>
            </div>
          )}
        </div>
        <div className="max-w-xs">
          <Field label="Verification code">
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ""))}
              className={`${inputCls} text-center tracking-widest text-lg font-mono`}
              autoComplete="one-time-code"
            />
          </Field>
        </div>
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={() => { setPhase("status"); setError(null); }}
            className="h-9 px-4 rounded-md border border-input bg-background text-sm font-semibold hover:bg-secondary">
            Cancel
          </button>
          <button type="button" onClick={confirmSetup} disabled={busy || verifyCode.length !== 6}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60">
            {busy ? "Verifying…" : "Verify and enable"}
          </button>
        </div>
      </PanelShell>
    );
  }

  if (phase === "disable") {
    return (
      <PanelShell title="Disable two-factor authentication" subtitle="Enter the 6-digit code from your authenticator app (or a backup code) to confirm.">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="max-w-xs">
          <Field label="Verification code">
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              value={disableCode}
              onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, ""))}
              className={`${inputCls} text-center tracking-widest font-mono`}
              autoComplete="one-time-code"
            />
          </Field>
        </div>
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={() => { setPhase("status"); setError(null); setDisableCode(""); }}
            className="h-9 px-4 rounded-md border border-input bg-background text-sm font-semibold hover:bg-secondary">
            Cancel
          </button>
          <button type="button" onClick={disable2fa} disabled={busy || !disableCode.trim()}
            className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 disabled:opacity-60">
            {busy ? "Disabling…" : "Disable 2FA"}
          </button>
        </div>
      </PanelShell>
    );
  }

  return (
    <PanelShell title="Two-factor authentication" subtitle="Add a second layer of protection to your account.">
      {error && <Alert tone="danger">{error}</Alert>}
      {success && <Alert tone="success">{success}</Alert>}
      <div className="rounded-lg border border-border bg-secondary/20 p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold flex items-center gap-2">
              <ShieldCheck size={15} className={enabled ? "text-emerald-600" : "text-muted-foreground"} />
              {enabled ? "Enabled" : "Not enabled"}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {enabled
                ? "Your account is protected with an authenticator app."
                : "Use an authenticator app (Google Authenticator, Authy, etc.) as a second sign-in step."}
            </p>
          </div>
          {enabled ? (
            <button type="button" onClick={() => { setPhase("disable"); setError(null); }}
              className="h-8 px-3 rounded-md border border-input bg-background text-xs font-semibold hover:bg-secondary text-destructive hover:text-destructive">
              Disable
            </button>
          ) : (
            <button type="button" onClick={startSetup} disabled={busy}
              className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-60">
              {busy ? "Loading…" : "Set up authenticator app"}
            </button>
          )}
        </div>
      </div>
      {enabled && (
        <div className="rounded-lg border border-border bg-secondary/20 p-4 flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-semibold">Backup codes</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Generate a fresh set of backup codes. Your existing codes will be permanently invalidated.
            </p>
          </div>
          <button type="button" onClick={() => { setRegenCode(""); setError(null); setPhase("regen-confirm"); }}
            className="shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-input bg-background text-xs font-semibold hover:bg-secondary whitespace-nowrap">
            <RefreshCcw size={12} /> Regenerate
          </button>
        </div>
      )}
      {enabled && <TrustedDevicesSection />}
    </PanelShell>
  );
}

interface TrustedDeviceRow {
  id: string;
  deviceName: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

function TrustedDevicesSection() {
  const queryClient = useQueryClient();
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const devicesQuery = useQuery({
    queryKey: ["auth", "trusted-devices"],
    queryFn: () =>
      apiFetch<{ devices: TrustedDeviceRow[] }>("/auth/2fa/trusted-devices"),
  });

  const devices: TrustedDeviceRow[] = devicesQuery.data?.devices ?? [];

  const revokeDevice = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/auth/2fa/trusted-devices/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setRevokeError(null);
      queryClient.invalidateQueries({ queryKey: ["auth", "trusted-devices"] });
    },
    onError: (err: Error) => {
      setRevokeError(err.message || "Could not revoke that device.");
    },
  });

  if (devicesQuery.isLoading) return null;
  if (devices.length === 0) return null;

  return (
    <div>
      <div className="text-sm font-semibold mb-1 flex items-center gap-2">
        <Monitor size={14} />
        Trusted devices
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        These devices are allowed to skip the 2FA challenge for 30 days. Revoke any device you don't recognise.
      </p>
      {revokeError && <Alert tone="danger">{revokeError}</Alert>}
      <div className="border border-border rounded-md divide-y divide-border">
        {devices.map((d) => (
          <div key={d.id} className="px-3 py-3 flex items-center justify-between gap-3 text-sm">
            <div className="min-w-0">
              <div className="font-medium truncate">
                {d.deviceName || describeUserAgent(d.userAgent)}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {describeUserAgent(d.userAgent)} · {d.ipAddress || "unknown IP"}
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                Trusted {formatRelative(d.createdAt)}
                {d.lastUsedAt ? ` · last used ${formatRelative(d.lastUsedAt)}` : ""}
                {" · "}expires {formatRelative(d.expiresAt)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => revokeDevice.mutate(d.id)}
              disabled={revokeDevice.isPending}
              className="h-8 px-3 rounded-md text-xs font-semibold border border-border hover:bg-destructive/10 hover:text-destructive hover:border-destructive/40 disabled:opacity-50 shrink-0"
            >
              Revoke
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function OrganizationsPanel() {
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
  });
  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
  });

  const memberships = meQuery.data?.memberships ?? [];
  const orgsById = useMemo(() => {
    const map = new Map<string, Organization>();
    for (const o of orgsQuery.data ?? []) map.set(o.id, o);
    return map;
  }, [orgsQuery.data]);

  const [search, setSearch] = useState("");
  const [selectedMembershipId, setSelectedMembershipId] = useState<string | null>(null);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const leaveMutation = useMutation({
    mutationFn: (membershipId: string) =>
      apiFetch(`/organizations/memberships/${membershipId}`, { method: "DELETE" }),
    onSuccess: () => {
      setLeaveConfirmOpen(false);
      setSelectedMembershipId(null);
      setLeaveError(null);
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
    onError: (err: Error) => {
      setLeaveError(err.message || "Failed to leave organization.");
    },
  });

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editBillingEmail, setEditBillingEmail] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editAddressLine1, setEditAddressLine1] = useState("");
  const [editAddressLine2, setEditAddressLine2] = useState("");
  const [editCity, setEditCity] = useState("");
  const [editState, setEditState] = useState("");
  const [editZip, setEditZip] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const updateOrgMutation = useMutation({
    mutationFn: ({ orgId, name, billingEmail, phone, addressLine1, addressLine2, city, state, zip }: {
      orgId: string; name: string; billingEmail: string;
      phone: string; addressLine1: string; addressLine2: string;
      city: string; state: string; zip: string;
    }) =>
      apiFetch<Organization>(`/organizations/${orgId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          displayName: name,
          billingEmail: billingEmail.trim() || undefined,
          phone: phone.trim() || undefined,
          addressLine1: addressLine1.trim() || undefined,
          addressLine2: addressLine2.trim() || undefined,
          city: city.trim() || undefined,
          state: state.trim() || undefined,
          zip: zip.trim() || undefined,
        }),
      }),
    onMutate: async ({ orgId, name, billingEmail, phone, addressLine1, addressLine2, city, state, zip }) => {
      await queryClient.cancelQueries({ queryKey: ["organizations"] });
      await queryClient.cancelQueries({ queryKey: ["auth", "me"] });

      const prevOrgs = queryClient.getQueryData<Organization[]>(["organizations"]);
      const prevMe = queryClient.getQueryData<MeResponse>(["auth", "me"]);

      const applyToOrg = (o: Organization): Organization =>
        o.id === orgId
          ? { ...o, name, displayName: name, billingEmail: billingEmail.trim() || null,
              phone: phone.trim() || null, addressLine1: addressLine1.trim() || null,
              addressLine2: addressLine2.trim() || null, city: city.trim() || null,
              state: state.trim() || null, zip: zip.trim() || null }
          : o;

      if (prevOrgs) {
        queryClient.setQueryData<Organization[]>(["organizations"], prevOrgs.map(applyToOrg));
      }
      if (prevMe) {
        queryClient.setQueryData<MeResponse>(["auth", "me"], {
          ...prevMe,
          memberships: prevMe.memberships.map((m) =>
            m.organizationId === orgId && m.organization
              ? { ...m, organization: applyToOrg(m.organization) }
              : m,
          ),
        });
      }

      return { prevOrgs, prevMe };
    },
    onError: (err, _vars, context) => {
      if (context?.prevOrgs !== undefined) {
        queryClient.setQueryData(["organizations"], context.prevOrgs);
      }
      if (context?.prevMe !== undefined) {
        queryClient.setQueryData(["auth", "me"], context.prevMe);
      }
      setEditError(err instanceof Error ? err.message : "Failed to save changes.");
    },
    onSuccess: () => {
      setIsEditing(false);
      setEditError(null);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["organizations"] });
      void queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && search) {
        setSearch("");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [search]);

  const filteredMemberships = useMemo(() => {
    if (!search.trim()) return memberships;
    const q = search.trim().toLowerCase();
    return memberships.filter((m) => {
      const org = m.organization || orgsById.get(m.organizationId);
      const name = (org?.displayName || org?.name || "").toLowerCase();
      const type = (org?.type || "").toLowerCase();
      const role = (m.role || "").toLowerCase();
      const phone = (org?.phone || "").toLowerCase();
      const city = (org?.city || "").toLowerCase();
      const state = (org?.state || "").toLowerCase();
      const addressLine1 = (org?.addressLine1 || "").toLowerCase();
      const addressLine2 = (org?.addressLine2 || "").toLowerCase();
      return (
        name.includes(q) ||
        type.includes(q) ||
        role.includes(q) ||
        phone.includes(q) ||
        city.includes(q) ||
        state.includes(q) ||
        addressLine1.includes(q) ||
        addressLine2.includes(q)
      );
    });
  }, [memberships, orgsById, search]);

  const selectedMembership = useMemo(
    () => filteredMemberships.find((m) => m.id === selectedMembershipId) ??
      memberships.find((m) => m.id === selectedMembershipId) ?? null,
    [filteredMemberships, memberships, selectedMembershipId],
  );
  const selectedOrg = selectedMembership
    ? selectedMembership.organization || orgsById.get(selectedMembership.organizationId)
    : null;

  const drawerCanEdit =
    selectedMembership?.status === "active" &&
    (selectedMembership?.role === "owner" || selectedMembership?.role === "admin");

  const drawerCanBackfill =
    selectedOrg?.type === "lab" &&
    selectedMembership?.status === "active" &&
    (selectedMembership?.role === "owner" || selectedMembership?.role === "admin");

  const drawerIsAdmin =
    selectedMembership?.status === "active" &&
    (selectedMembership?.role === "owner" || selectedMembership?.role === "admin");

  const [removeTargetId, setRemoveTargetId] = useState<string | null>(null);
  const [removeMemberError, setRemoveMemberError] = useState<string | null>(null);

  const orgMembersQuery = useQuery({
    queryKey: ["org-members", selectedOrg?.id],
    queryFn: () =>
      apiFetch<OrgMemberRow[]>(`/organizations/${selectedOrg!.id}/members`),
    enabled: !!selectedOrg && drawerIsAdmin,
  });

  const removeMemberMutation = useMutation({
    mutationFn: (membershipId: string) =>
      apiFetch(`/organizations/memberships/${membershipId}`, { method: "DELETE" }),
    onSuccess: () => {
      setRemoveTargetId(null);
      setRemoveMemberError(null);
      queryClient.invalidateQueries({ queryKey: ["org-members", selectedOrg?.id] });
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
    onError: (err: Error) => {
      setRemoveMemberError(err.message || "Failed to remove member.");
    },
  });

  const currentUserId = meQuery.data?.user?.id;

  return (
    <PanelShell title="Organizations" subtitle="Labs and practices you belong to.">
      {(meQuery.isLoading || orgsQuery.isLoading) && (
        <div className="text-sm text-muted-foreground">
          <Loader2 size={14} className="inline animate-spin mr-2" />
          Loading…
        </div>
      )}

      {memberships.length > 0 && (
        <div className="relative mb-3">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, type, city, state, or phone…"
            className="w-full h-8 pl-8 pr-8 rounded-md border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {search && (
            <button
              type="button"
              onClick={() => { setSearch(""); searchRef.current?.focus(); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}

      <div className="border border-border rounded-md divide-y divide-border">
        {memberships.length === 0 && !meQuery.isLoading && (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            You're not a member of any organization yet.
          </div>
        )}
        {memberships.length > 0 && filteredMemberships.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            <div>No organizations match "{search}".</div>
            <button
              type="button"
              onClick={() => setSearch("")}
              className="mt-2 text-xs text-primary hover:underline"
            >
              Clear search
            </button>
          </div>
        )}
        {filteredMemberships.map((m) => {
          const org = m.organization || orgsById.get(m.organizationId);
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => setSelectedMembershipId(m.id)}
              className="w-full px-3 py-3 text-sm text-left hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <div className="font-medium">{org?.displayName || org?.name || "Unknown"}</div>
                  <div className="text-xs text-muted-foreground capitalize">
                    {org?.type || "—"} · {org?.billingEmail || "no billing email"}
                  </div>
                  {(org?.phone || org?.city || org?.state) && (
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {[
                        org?.phone,
                        [org?.city, org?.state].filter(Boolean).join(", "),
                      ].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground capitalize">{m.role}</span>
                  <span className={`px-2 py-0.5 rounded-full ${m.status === "active" ? "bg-success/15 text-success" : "bg-warning/20 text-warning"}`}>
                    {m.status}
                  </span>
                  <ChevronRight size={14} className="text-muted-foreground ml-1 shrink-0" />
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <Sheet
        open={selectedMembershipId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedMembershipId(null);
            setIsEditing(false);
            setEditError(null);
          }
        }}
      >
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader className="mb-4">
            <SheetTitle className="flex items-center gap-2">
              <Building2 size={18} />
              {selectedOrg?.displayName || selectedOrg?.name || "Organization"}
            </SheetTitle>
            <SheetDescription className="capitalize">
              {selectedOrg?.type || "Organization"} details
            </SheetDescription>
          </SheetHeader>

          {selectedOrg && selectedMembership && (
            <div className="space-y-4 text-sm">
              <div className="rounded-md border border-border divide-y divide-border">
                {/* Name row */}
                <div className="px-3 py-2.5">
                  {isEditing ? (
                    <div className="space-y-1">
                      <label className="text-muted-foreground text-xs">Name</label>
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full h-8 px-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        placeholder="Organization name"
                        autoFocus
                      />
                    </div>
                  ) : (
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground text-xs">Name</span>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{selectedOrg.displayName || selectedOrg.name || "—"}</span>
                        {drawerCanEdit && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditName(selectedOrg.displayName || selectedOrg.name || "");
                              setEditBillingEmail(selectedOrg.billingEmail ?? "");
                              setEditPhone(selectedOrg.phone ?? "");
                              setEditAddressLine1(selectedOrg.addressLine1 ?? "");
                              setEditAddressLine2(selectedOrg.addressLine2 ?? "");
                              setEditCity(selectedOrg.city ?? "");
                              setEditState(selectedOrg.state ?? "");
                              setEditZip(selectedOrg.zip ?? "");
                              setEditError(null);
                              setIsEditing(true);
                            }}
                            className="text-muted-foreground hover:text-foreground transition-colors"
                            aria-label="Edit organization"
                            title="Edit organization"
                          >
                            <Pencil size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <div className="px-3 py-2.5 flex justify-between items-center">
                  <span className="text-muted-foreground text-xs">Type</span>
                  <span className="capitalize">{selectedOrg.type || "—"}</span>
                </div>
                {/* Billing email row */}
                <div className="px-3 py-2.5">
                  {isEditing ? (
                    <div className="space-y-1">
                      <label className="text-muted-foreground text-xs">Billing email</label>
                      <input
                        type="email"
                        value={editBillingEmail}
                        onChange={(e) => setEditBillingEmail(e.target.value)}
                        className="w-full h-8 px-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        placeholder="billing@example.com (optional)"
                      />
                    </div>
                  ) : (
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground text-xs">Billing email</span>
                      <span>{selectedOrg.billingEmail || <span className="text-muted-foreground italic">none</span>}</span>
                    </div>
                  )}
                </div>
                {/* Phone row */}
                <div className="px-3 py-2.5">
                  {isEditing ? (
                    <div className="space-y-1">
                      <label className="text-muted-foreground text-xs">Phone</label>
                      <input
                        type="tel"
                        value={editPhone}
                        onChange={(e) => setEditPhone(formatPhone(e.target.value))}
                        className="w-full h-8 px-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        placeholder="000-000-0000 (optional)"
                      />
                    </div>
                  ) : (
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground text-xs">Phone</span>
                      <span>{selectedOrg.phone || <span className="text-muted-foreground italic">none</span>}</span>
                    </div>
                  )}
                </div>
                {/* Address rows */}
                <div className="px-3 py-2.5">
                  {isEditing ? (
                    <div className="space-y-2">
                      <div className="space-y-1">
                        <label className="text-muted-foreground text-xs">Address line 1</label>
                        <input
                          type="text"
                          value={editAddressLine1}
                          onChange={(e) => setEditAddressLine1(e.target.value)}
                          className="w-full h-8 px-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          placeholder="123 Main St (optional)"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-muted-foreground text-xs">Address line 2</label>
                        <input
                          type="text"
                          value={editAddressLine2}
                          onChange={(e) => setEditAddressLine2(e.target.value)}
                          className="w-full h-8 px-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          placeholder="Suite 200 (optional)"
                        />
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div className="col-span-1 space-y-1">
                          <label className="text-muted-foreground text-xs">City</label>
                          <input
                            type="text"
                            value={editCity}
                            onChange={(e) => setEditCity(e.target.value)}
                            className="w-full h-8 px-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            placeholder="City"
                          />
                        </div>
                        <div className="col-span-1 space-y-1">
                          <label className="text-muted-foreground text-xs">State</label>
                          <input
                            type="text"
                            value={editState}
                            onChange={(e) => setEditState(e.target.value)}
                            className="w-full h-8 px-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            placeholder="CA"
                            maxLength={2}
                          />
                        </div>
                        <div className="col-span-1 space-y-1">
                          <label className="text-muted-foreground text-xs">ZIP</label>
                          <input
                            type="text"
                            value={editZip}
                            onChange={(e) => setEditZip(e.target.value)}
                            className="w-full h-8 px-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            placeholder="00000"
                          />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex justify-between items-start">
                      <span className="text-muted-foreground text-xs">Address</span>
                      <div className="text-right text-sm">
                        {selectedOrg.addressLine1 || selectedOrg.addressLine2 || selectedOrg.city || selectedOrg.state || selectedOrg.zip ? (
                          <>
                            {selectedOrg.addressLine1 && <div>{selectedOrg.addressLine1}</div>}
                            {selectedOrg.addressLine2 && <div>{selectedOrg.addressLine2}</div>}
                            {(selectedOrg.city || selectedOrg.state || selectedOrg.zip) && (
                              <div>
                                {[selectedOrg.city, selectedOrg.state, selectedOrg.zip].filter(Boolean).join(", ")}
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground italic">none</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <div className="px-3 py-2.5 flex justify-between items-center">
                  <span className="text-muted-foreground text-xs">Your role</span>
                  <span className="px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground text-xs capitalize">
                    {selectedMembership.role}
                  </span>
                </div>
                <div className="px-3 py-2.5 flex justify-between items-center">
                  <span className="text-muted-foreground text-xs">Status</span>
                  <span className={`px-2 py-0.5 rounded-full text-xs ${selectedMembership.status === "active" ? "bg-success/15 text-success" : "bg-warning/20 text-warning"}`}>
                    {selectedMembership.status}
                  </span>
                </div>
              </div>

              {/* Edit action row */}
              {isEditing && (
                <div className="space-y-2">
                  {editError && (
                    <p className="text-xs text-destructive">{editError}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={updateOrgMutation.isPending || !editName.trim()}
                      onClick={() => {
                        const emailVal = editBillingEmail.trim();
                        if (emailVal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
                          setEditError("Billing email is not a valid email address.");
                          return;
                        }
                        const phoneVal = editPhone.trim();
                        if (phoneVal) {
                          const digits = phoneVal.replace(/\D/g, "");
                          if (digits.length < 10) {
                            setEditError("Phone number must have at least 10 digits.");
                            return;
                          }
                        }
                        const stateVal = editState.trim();
                        if (stateVal && !/^[A-Za-z]{2}$/.test(stateVal)) {
                          setEditError("State must be a 2-letter abbreviation (e.g. CA).");
                          return;
                        }
                        const zipVal = editZip.trim();
                        if (zipVal && !/^\d{5}(-\d{4})?$/.test(zipVal)) {
                          setEditError("ZIP code must be 5 digits or 5+4 format (e.g. 90210 or 90210-1234).");
                          return;
                        }
                        setEditError(null);
                        updateOrgMutation.mutate({
                          orgId: selectedOrg.id,
                          name: editName.trim(),
                          billingEmail: editBillingEmail,
                          phone: editPhone,
                          addressLine1: editAddressLine1,
                          addressLine2: editAddressLine2,
                          city: editCity,
                          state: editState,
                          zip: editZip,
                        });
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {updateOrgMutation.isPending ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Check size={12} />
                      )}
                      Save changes
                    </button>
                    <button
                      type="button"
                      disabled={updateOrgMutation.isPending}
                      onClick={() => { setIsEditing(false); setEditError(null); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs hover:bg-muted transition-colors"
                    >
                      <X size={12} />
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {saveSuccess && (
                <div className="flex items-center gap-1.5 text-xs text-success">
                  <Check size={12} />
                  Changes saved
                </div>
              )}

              {drawerIsAdmin && (
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Members
                  </div>
                  {orgMembersQuery.isLoading && (
                    <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                      <Loader2 size={12} className="animate-spin" />
                      Loading members…
                    </div>
                  )}
                  {!orgMembersQuery.isLoading && (orgMembersQuery.data ?? []).length === 0 && (
                    <div className="text-xs text-muted-foreground">No members found.</div>
                  )}
                  {(orgMembersQuery.data ?? []).length > 0 && (
                    <div className="rounded-md border border-border divide-y divide-border">
                      {(orgMembersQuery.data ?? []).map((m) => {
                        const displayName = m.user
                          ? [m.user.firstName, m.user.lastName].filter(Boolean).join(" ") || m.user.username
                          : "Unknown";
                        const isSelf = m.userId === currentUserId;
                        const isOwner = m.role === "owner";
                        const canRemove = !isSelf && !isOwner && m.status === "active";
                        return (
                          <div
                            key={m.id}
                            className="px-3 py-2.5 flex items-center justify-between gap-2"
                          >
                            <div className="min-w-0">
                              <div className="text-xs font-medium truncate">
                                {displayName}
                                {isSelf && (
                                  <span className="ml-1.5 text-muted-foreground font-normal">(you)</span>
                                )}
                              </div>
                              {m.user?.email && (
                                <div className="text-xs text-muted-foreground truncate">{m.user.email}</div>
                              )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground text-xs capitalize">
                                {m.role}
                              </span>
                              {canRemove && (
                                <button
                                  type="button"
                                  onClick={() => { setRemoveMemberError(null); setRemoveTargetId(m.id); }}
                                  className="inline-flex items-center gap-1 h-6 px-2 rounded border border-destructive/40 text-destructive text-xs hover:bg-destructive/10 transition-colors"
                                  title={`Remove ${displayName}`}
                                >
                                  <UserMinus size={11} />
                                  Remove
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {removeMemberError && (
                    <p className="text-xs text-destructive">{removeMemberError}</p>
                  )}
                </div>
              )}

              {drawerCanBackfill && (
                <div className="space-y-3">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Admin controls
                  </div>
                  <BackfillInvoicesRow
                    labOrganizationId={selectedMembership.organizationId}
                    labName={selectedOrg.displayName || selectedOrg.name || "this lab"}
                  />
                  <DuplicateThresholdRow lab={selectedOrg} />
                  <TrustedDeviceTtlRow lab={selectedOrg} />
                </div>
              )}

              {selectedMembership.role !== "owner" && selectedMembership.status === "active" && (
                <div className="pt-2 border-t border-border/60">
                  {leaveError && (
                    <p className="text-xs text-destructive mb-2">{leaveError}</p>
                  )}
                  <button
                    type="button"
                    onClick={() => { setLeaveError(null); setLeaveConfirmOpen(true); }}
                    className="inline-flex items-center gap-2 h-8 px-3 rounded-md border border-destructive/40 text-destructive text-xs font-semibold hover:bg-destructive/10 transition-colors"
                  >
                    <LogOut size={13} />
                    Leave organization
                  </button>
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={leaveConfirmOpen} onOpenChange={setLeaveConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave {selectedOrg?.displayName || selectedOrg?.name || "this organization"}?</AlertDialogTitle>
            <AlertDialogDescription>
              Your access will be revoked immediately. You won't be able to see cases, invoices, or other data for this organization unless an admin re-invites you.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={leaveMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (selectedMembershipId) leaveMutation.mutate(selectedMembershipId);
              }}
              disabled={leaveMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {leaveMutation.isPending ? (
                <><Loader2 size={13} className="animate-spin mr-1.5" />Leaving…</>
              ) : "Leave organization"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={removeTargetId !== null}
        onOpenChange={(open) => { if (!open) { setRemoveTargetId(null); setRemoveMemberError(null); } }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove member from {selectedOrg?.displayName || selectedOrg?.name || "this organization"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Their access will be revoked immediately. You can re-invite them later if needed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeMemberError && (
            <p className="text-xs text-destructive px-1">{removeMemberError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeMemberMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (removeTargetId) removeMemberMutation.mutate(removeTargetId);
              }}
              disabled={removeMemberMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removeMemberMutation.isPending ? (
                <><Loader2 size={13} className="animate-spin mr-1.5" />Removing…</>
              ) : "Remove member"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PanelShell>
  );
}

interface BackfillSummary {
  labOrganizationId: string;
  casesScanned: number;
  created: number;
  skippedExisting: number;
  skippedNoRestorations: number;
  skippedNumberTaken: number;
  createdInvoiceIds: string[];
}

function BackfillInvoicesRow({ labOrganizationId, labName }: { labOrganizationId: string; labName: string }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [summary, setSummary] = useState<BackfillSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<BackfillSummary>(`/invoices/lab-orgs/${labOrganizationId}/backfill`, {
        method: "POST",
      }),
    onSuccess: (data) => {
      setError(null);
      setSummary(data);
    },
    onError: (err: Error) => {
      setSummary(null);
      setError(err.message || "Backfill failed.");
    },
  });

  return (
    <div className="mt-3 pt-3 border-t border-border/60">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground max-w-md">
          Generate missing invoices for every case in this lab that doesn't already have one. Safe to re-run — existing invoices and case statuses are not touched.
        </div>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setSummary(null);
            setConfirmOpen(true);
          }}
          disabled={mutation.isPending}
          className="h-8 px-3 rounded-md bg-secondary text-secondary-foreground text-xs font-semibold inline-flex items-center gap-1.5 hover:bg-secondary/80 disabled:opacity-60"
        >
          {mutation.isPending ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              Backfilling…
            </>
          ) : (
            <>
              <Wrench size={12} />
              Backfill missing invoices
            </>
          )}
        </button>
      </div>

      {error && (
        <div className="mt-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      {summary && (
        <div className="mt-2 rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs">
          <div className="font-medium mb-1">Backfill complete</div>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
            <li>Cases scanned: <span className="text-foreground font-medium">{summary.casesScanned}</span></li>
            <li>Invoices created: <span className="text-foreground font-medium">{summary.created}</span></li>
            <li>Skipped (already invoiced): <span className="text-foreground font-medium">{summary.skippedExisting}</span></li>
            <li>Skipped (no restorations): <span className="text-foreground font-medium">{summary.skippedNoRestorations}</span></li>
            <li>Skipped (number taken): <span className="text-foreground font-medium">{summary.skippedNumberTaken}</span></li>
          </ul>
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Backfill missing invoices?</AlertDialogTitle>
            <AlertDialogDescription>
              This will scan every case in <span className="font-medium text-foreground">{labName}</span> and generate an invoice for any case that doesn't have one yet. Cases that already have an invoice, have no restorations, or whose invoice number is already taken will be skipped. This is safe to re-run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                mutation.mutate();
              }}
            >
              Run backfill
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const THRESHOLD_PREVIEW_STEPS = [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];

function DuplicateThresholdRow({ lab }: { lab: Organization }) {
  const queryClient = useQueryClient();
  const labOrgId = lab.id;

  const savedThreshold = useMemo(
    () => resolveLabDupThreshold(lab.duplicateSuggestionThreshold),
    [lab.duplicateSuggestionThreshold],
  );
  const hasOverride =
    lab.duplicateSuggestionThreshold !== null &&
    lab.duplicateSuggestionThreshold !== undefined &&
    lab.duplicateSuggestionThreshold !== "";

  const [threshold, setThreshold] = useState<number>(savedThreshold);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlag, setSavedFlag] = useState(false);

  useEffect(() => {
    setThreshold(savedThreshold);
  }, [savedThreshold]);

  const casesQuery = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
  });
  const invoicesQuery = useQuery({
    queryKey: ["invoices"],
    queryFn: () => apiFetch<Invoice[]>("/invoices"),
  });
  const orgsQuery = useQuery({
    queryKey: ["organizations", { includeArchived: true }],
    queryFn: () =>
      apiFetch<Organization[]>("/organizations?includeArchived=true"),
  });

  // Build the same DoctorRow shape doctors.tsx uses, scoped to this lab only,
  // so the preview counts match what admins will see on the Doctors page.
  const labDoctorRows = useMemo<DoctorRow[]>(() => {
    const cases = (casesQuery.data ?? []).filter(
      (c) => c.labOrganizationId === labOrgId,
    );
    const invoices = invoicesQuery.data ?? [];
    const billedByCase = new Map<string, number>();
    for (const inv of invoices) {
      if (!inv.caseId) continue;
      billedByCase.set(
        inv.caseId,
        (billedByCase.get(inv.caseId) ?? 0) + Number(inv.total ?? 0),
      );
    }
    const map = new Map<string, DoctorRow>();
    for (const c of cases) {
      const doc = (c.doctorName || "—").trim();
      const practiceId = c.providerOrganizationId || "";
      const key = `${doc.toLowerCase()}|${practiceId}`;
      const billed = billedByCase.get(c.id) ?? Number(c.totalPrice ?? 0);
      const existing = map.get(key);
      if (existing) {
        existing.totalCases += 1;
        existing.totalBilled += billed;
      } else {
        map.set(key, {
          key,
          doctorName: doc,
          practiceName: "",
          practiceId,
          labOrganizationId: c.labOrganizationId || "",
          totalCases: 1,
          openCases: 0,
          rushCases: 0,
          totalBilled: billed,
          lastCaseAt: c.createdAt || null,
          hasAiImportedCase: false,
        });
      }
    }
    return Array.from(map.values());
  }, [casesQuery.data, invoicesQuery.data, labOrgId]);

  const adminLabSet = useMemo(() => new Set([labOrgId]), [labOrgId]);
  const orgs = orgsQuery.data ?? [];

  // Cluster counts at the currently selected threshold + at each preview step.
  const doctorClusterCount = useMemo(() => {
    const byLab = new Map<string, DoctorRow[]>();
    byLab.set(labOrgId, labDoctorRows);
    return buildDuplicateClusters<DoctorRow>(
      byLab,
      (r) => r.doctorName,
      (r) => r.key,
      bigramSimilarityForPreview,
      threshold,
    ).length;
  }, [labDoctorRows, labOrgId, threshold]);

  const practiceClusterCount = useMemo(() => {
    return buildPracticeDuplicateClusters(orgs, adminLabSet, threshold).length;
  }, [orgs, adminLabSet, threshold]);

  const previewByStep = useMemo(() => {
    return THRESHOLD_PREVIEW_STEPS.map((t) => {
      const byLab = new Map<string, DoctorRow[]>();
      byLab.set(labOrgId, labDoctorRows);
      const docCount = buildDuplicateClusters<DoctorRow>(
        byLab,
        (r) => r.doctorName,
        (r) => r.key,
        bigramSimilarityForPreview,
        t,
      ).length;
      const pracCount = buildPracticeDuplicateClusters(orgs, adminLabSet, t).length;
      return { threshold: t, docCount, pracCount };
    });
  }, [labOrgId, labDoctorRows, orgs, adminLabSet]);

  const saveMutation = useMutation({
    mutationFn: (next: number | null) =>
      apiFetch<Organization>(
        `/organizations/${labOrgId}/duplicate-suggestion-threshold`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threshold: next }),
        },
      ),
    onSuccess: () => {
      setSaveError(null);
      setSavedFlag(true);
      window.setTimeout(() => setSavedFlag(false), 2000);
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: (err: Error) => {
      setSaveError(err.message || "Failed to save threshold.");
    },
  });

  const dirty = Math.abs(threshold - savedThreshold) > 1e-6;
  const isLoading = casesQuery.isLoading || orgsQuery.isLoading;

  return (
    <div className="mt-3 pt-3 border-t border-border/60">
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium text-foreground">
              Duplicate detection sensitivity
            </div>
            <div className="text-[11px] text-muted-foreground max-w-md">
              Controls how similar two doctor or practice names must be before the "Suggested merges" and "Suggested duplicates" banners flag them. Lower = more candidates (catches messy data), higher = fewer false positives.
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {hasOverride && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">
                Custom
              </span>
            )}
            {!hasOverride && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                Default {DEFAULT_DUP_SIMILARITY_THRESHOLD.toFixed(2)}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 mt-1">
          <input
            type="range"
            min={0.5}
            max={0.95}
            step={0.05}
            value={threshold}
            onChange={(e) => setThreshold(parseFloat(e.target.value))}
            className="flex-1 max-w-xs accent-primary"
            aria-label="Duplicate similarity threshold"
          />
          <span className="text-xs font-mono w-10 text-right">
            {threshold.toFixed(2)}
          </span>
          <button
            type="button"
            onClick={() => saveMutation.mutate(threshold)}
            disabled={!dirty || saveMutation.isPending}
            className="h-7 px-2.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {saveMutation.isPending ? (
              <Loader2 size={11} className="animate-spin" />
            ) : null}
            Save
          </button>
          {hasOverride && (
            <button
              type="button"
              onClick={() => {
                setThreshold(DEFAULT_DUP_SIMILARITY_THRESHOLD);
                saveMutation.mutate(null);
              }}
              disabled={saveMutation.isPending}
              className="h-7 px-2 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              title="Revert to application default"
            >
              Reset
            </button>
          )}
          {savedFlag && (
            <span className="text-[11px] text-success inline-flex items-center gap-1">
              <Check size={11} />
              Saved
            </span>
          )}
        </div>

        <div className="mt-1 rounded-md border border-border/60 bg-muted/30 px-2.5 py-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-1">
            Preview (clusters that would be flagged)
          </div>
          {isLoading ? (
            <div className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5">
              <Loader2 size={10} className="animate-spin" />
              Loading…
            </div>
          ) : (
            <>
              <div className="text-[11px] text-foreground">
                At <span className="font-mono">{threshold.toFixed(2)}</span>:{" "}
                <span className="font-medium">{doctorClusterCount}</span> doctor
                {doctorClusterCount === 1 ? "" : "s"} cluster
                {doctorClusterCount === 1 ? "" : "s"},{" "}
                <span className="font-medium">{practiceClusterCount}</span> practice
                {practiceClusterCount === 1 ? "" : "s"} cluster
                {practiceClusterCount === 1 ? "" : "s"}.
              </div>
              <div className="mt-1.5 overflow-x-auto">
                <table className="text-[10px] text-muted-foreground">
                  <thead>
                    <tr>
                      <th className="pr-3 text-left font-medium">Threshold</th>
                      {previewByStep.map((s) => (
                        <th
                          key={s.threshold}
                          className={`px-1.5 text-center font-mono ${
                            Math.abs(s.threshold - threshold) < 1e-6
                              ? "text-foreground font-semibold"
                              : ""
                          }`}
                        >
                          {s.threshold.toFixed(2)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="pr-3">Doctors</td>
                      {previewByStep.map((s) => (
                        <td
                          key={s.threshold}
                          className={`px-1.5 text-center ${
                            Math.abs(s.threshold - threshold) < 1e-6
                              ? "text-foreground font-semibold"
                              : ""
                          }`}
                        >
                          {s.docCount}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="pr-3">Practices</td>
                      {previewByStep.map((s) => (
                        <td
                          key={s.threshold}
                          className={`px-1.5 text-center ${
                            Math.abs(s.threshold - threshold) < 1e-6
                              ? "text-foreground font-semibold"
                              : ""
                          }`}
                        >
                          {s.pracCount}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {saveError && (
          <div className="mt-1">
            <Alert tone="danger">{saveError}</Alert>
          </div>
        )}
      </div>
    </div>
  );
}

function TrustedDeviceTtlRow({ lab }: { lab: Organization }) {
  const queryClient = useQueryClient();
  const GLOBAL_DEFAULT = 30;

  const savedTtl: number = lab.trustedDeviceTtlDays ?? GLOBAL_DEFAULT;
  const hasOverride = lab.trustedDeviceTtlDays !== null && lab.trustedDeviceTtlDays !== undefined;

  const [ttl, setTtl] = useState<number>(savedTtl);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlag, setSavedFlag] = useState(false);

  useEffect(() => {
    setTtl(lab.trustedDeviceTtlDays ?? GLOBAL_DEFAULT);
  }, [lab.trustedDeviceTtlDays]);

  const dirty = ttl !== savedTtl;

  const saveMutation = useMutation({
    mutationFn: (days: number | null) =>
      apiFetch(`/organizations/${lab.id}/trusted-device-ttl`, {
        method: "PATCH",
        body: JSON.stringify({ ttlDays: days }),
      }),
    onSuccess: () => {
      setSaveError(null);
      setSavedFlag(true);
      setTimeout(() => setSavedFlag(false), 2000);
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: (err: Error) => setSaveError(err.message || "Failed to save."),
  });

  return (
    <div className="rounded-md border border-border bg-background p-3 space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xs font-semibold">Device trust period</div>
          <div className="text-[11px] text-muted-foreground max-w-sm">
            How long a trusted device can skip the 2FA challenge. Use a shorter period for shared workstations.
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {hasOverride ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">
              Custom
            </span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              Default {GLOBAL_DEFAULT}d
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="range"
          min={1}
          max={90}
          step={1}
          value={ttl}
          onChange={(e) => setTtl(parseInt(e.target.value, 10))}
          className="flex-1 max-w-xs accent-primary"
          aria-label="Device trust TTL days"
        />
        <span className="text-xs font-mono w-12 text-right">
          {ttl} day{ttl === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={() => saveMutation.mutate(ttl)}
          disabled={!dirty || saveMutation.isPending}
          className="h-7 px-2.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          {saveMutation.isPending ? <Loader2 size={11} className="animate-spin" /> : null}
          Save
        </button>
        {hasOverride && (
          <button
            type="button"
            onClick={() => {
              setTtl(GLOBAL_DEFAULT);
              saveMutation.mutate(null);
            }}
            disabled={saveMutation.isPending}
            className="h-7 px-2 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            title="Reset to global default"
          >
            Reset
          </button>
        )}
        {savedFlag && (
          <span className="text-[11px] text-success inline-flex items-center gap-1">
            <Check size={11} />
            Saved
          </span>
        )}
      </div>

      {saveError && (
        <div className="mt-1">
          <Alert tone="danger">{saveError}</Alert>
        </div>
      )}
    </div>
  );
}

// Local copy of the doctors-page bigram similarity (the doctors page keeps
// its own non-exported function). Mirroring it here avoids cross-page
// internals leaking through the public API of doctors.tsx.
function bigramSimilarityForPreview(a: string, b: string): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\bdr\.?\b/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const an = norm(a);
  const bn = norm(b);
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

function UsersPanel() {
  const usersQuery = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => apiFetch<{ users: AdminUser[] } | AdminUser[]>("/auth/users"),
  });
  const list: AdminUser[] = useMemo(() => {
    const d = usersQuery.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return d.users ?? [];
  }, [usersQuery.data]);

  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
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
  }, [list, search]);

  return (
    <PanelShell title="Users" subtitle="Everyone with a LabTrax account.">
      <div className="flex items-center gap-3 mb-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search users…"
          className="h-9 px-3 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none flex-1 max-w-sm"
        />
        <div className="text-xs text-muted-foreground">
          {filtered.length} of {list.length}
        </div>
      </div>
      <div className="border border-border rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="text-left font-medium px-3 py-2">User</th>
              <th className="text-left font-medium py-2">Email</th>
              <th className="text-left font-medium py-2">Practice</th>
              <th className="text-left font-medium py-2">Role</th>
              <th className="text-left font-medium px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {usersQuery.isLoading && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                  <Loader2 size={14} className="inline animate-spin mr-2" />
                  Loading…
                </td>
              </tr>
            )}
            {usersQuery.error && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-destructive">
                  {(usersQuery.error as Error).message}
                </td>
              </tr>
            )}
            {!usersQuery.isLoading && filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                  No users match.
                </td>
              </tr>
            )}
            {filtered.map((u) => (
              <tr key={u.id} className="border-t border-border">
                <td className="px-3 py-2.5">
                  <div className="font-medium">
                    {[u.firstName, u.lastName].filter(Boolean).join(" ") || u.username}
                  </div>
                  <div className="text-xs text-muted-foreground">@{u.username}</div>
                </td>
                <td className="py-2.5 text-muted-foreground text-xs">{u.email || "—"}</td>
                <td className="py-2.5 text-muted-foreground text-xs">{u.practiceName || "—"}</td>
                <td className="py-2.5">
                  <span className="text-[11px] uppercase tracking-wide bg-secondary text-secondary-foreground rounded-full px-2 py-0.5">
                    {u.role || "user"}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <span className={`text-[11px] px-2 py-0.5 rounded-full ${u.isActive === false ? "bg-warning/20 text-warning" : "bg-success/15 text-success"}`}>
                    {u.isActive === false ? "Inactive" : "Active"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PanelShell>
  );
}

type BackupDestinationType = "local" | "network";
type BackupIntervalUnit = "minutes" | "hours";

interface BackupScheduleData {
  interval: number | null;
  unit: BackupIntervalUnit | null;
  destination: BackupDestinationType | null;
  path: string | null;
  enabled: boolean;
  lastSuccessfulBackupAt: string | null;
  staleAlertThresholdDays: number;
  staleAlertRateLimitDays: number;
  staleAfterDays: number;
}

const DEFAULT_BACKUP_STALE_DAYS = 7;

function isBackupStale(lastSuccessfulBackupAt: string | null, staleDays: number = DEFAULT_BACKUP_STALE_DAYS): boolean {
  if (!lastSuccessfulBackupAt) return true;
  const last = new Date(lastSuccessfulBackupAt).getTime();
  if (Number.isNaN(last)) return true;
  return Date.now() - last > staleDays * 24 * 60 * 60 * 1000;
}

const INTERVAL_OPTIONS: Array<{ interval: number; unit: BackupIntervalUnit; label: string }> = [
  { interval: 15, unit: "minutes", label: "Every 15 minutes" },
  { interval: 30, unit: "minutes", label: "Every 30 minutes" },
  { interval: 1, unit: "hours", label: "Every hour" },
  { interval: 2, unit: "hours", label: "Every 2 hours" },
  { interval: 4, unit: "hours", label: "Every 4 hours" },
  { interval: 8, unit: "hours", label: "Every 8 hours" },
  { interval: 24, unit: "hours", label: "Every 24 hours" },
];

function intervalKey(interval: number, unit: BackupIntervalUnit): string {
  return `${interval}_${unit}`;
}

function parseIntervalKey(key: string): { interval: number; unit: BackupIntervalUnit } | null {
  const [iv, u] = key.split("_");
  const n = parseInt(iv ?? "", 10);
  if (!Number.isFinite(n) || (u !== "minutes" && u !== "hours")) return null;
  return { interval: n, unit: u };
}

function formatBackupSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

interface BackupRunRow {
  id: number;
  triggeredBy: string;
  destination: string;
  path: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  status: string;
  error: string | null;
  completedAt: string;
}

function BackupPanel() {
  const queryClient = useQueryClient();
  const [nowDest, setNowDest] = useState<BackupDestinationType>("local");
  const [nowPath, setNowPath] = useState("");
  const [backupResult, setBackupResult] = useState<{ size: number; completedAt: string; fileName: string; savedTo?: string | null; viaBrowser?: boolean } | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  const [schedIntervalKey, setSchedIntervalKey] = useState<string>(intervalKey(1, "hours"));
  const [schedDest, setSchedDest] = useState<BackupDestinationType>("local");
  const [schedPath, setSchedPath] = useState("");
  const [schedEnabled, setSchedEnabled] = useState(false);
  const [staleThresholdDays, setStaleThresholdDays] = useState(7);
  const [staleRateLimitDays, setStaleRateLimitDays] = useState(3);
  const [schedStaleDays, setSchedStaleDays] = useState<number>(DEFAULT_BACKUP_STALE_DAYS);
  const [schedError, setSchedError] = useState<string | null>(null);
  const [schedSuccess, setSchedSuccess] = useState(false);
  const [schedRunNowResult, setSchedRunNowResult] = useState<{ size: number; completedAt: string; fileName: string } | null>(null);
  const [schedRunNowError, setSchedRunNowError] = useState<string | null>(null);

  const scheduleQuery = useQuery<BackupScheduleData>({
    queryKey: ["admin", "backup-schedule-v2"],
    queryFn: () => apiFetch("/admin/backup/schedule"),
  });

  const historyQuery = useQuery<{ ok: boolean; runs: BackupRunRow[] }>({
    queryKey: ["admin", "backup-history"],
    queryFn: () => apiFetch("/admin/backup/history"),
    staleTime: 30_000,
  });

  const retentionQuery = useQuery<{
    ok: boolean;
    retentionDays: number;
    dbRetentionDays: number | null;
    envRetentionDays: number;
    maxRows: number;
    dbMaxRows: number | null;
    envMaxRows: number;
  }>({
    queryKey: ["admin", "backup-history-retention"],
    queryFn: () => apiFetch("/admin/backup/history-retention"),
    staleTime: 60_000,
  });

  const [retentionDaysInput, setRetentionDaysInput] = useState<string>("");
  const [maxRowsInput, setMaxRowsInput] = useState<string>("");
  const [retentionSaved, setRetentionSaved] = useState(false);

  useEffect(() => {
    if (retentionQuery.data) {
      setRetentionDaysInput(String(retentionQuery.data.retentionDays));
      setMaxRowsInput(String(retentionQuery.data.maxRows));
    }
  }, [retentionQuery.data]);

  const saveRetentionMutation = useMutation({
    mutationFn: () =>
      apiFetch("/admin/backup/history-retention", {
        method: "PUT",
        body: JSON.stringify({
          retentionDays: parseInt(retentionDaysInput, 10),
          maxRows: parseInt(maxRowsInput, 10),
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-history-retention"] });
      setRetentionSaved(true);
      setTimeout(() => setRetentionSaved(false), 3000);
    },
  });

  useEffect(() => {
    if (scheduleQuery.data) {
      const { interval, unit } = scheduleQuery.data;
      if (interval !== null && unit !== null) {
        setSchedIntervalKey(intervalKey(interval, unit));
      }
      setSchedDest((scheduleQuery.data.destination as BackupDestinationType | null) ?? "local");
      setSchedPath(scheduleQuery.data.path ?? "");
      setSchedEnabled(scheduleQuery.data.enabled);
      setStaleThresholdDays(scheduleQuery.data.staleAlertThresholdDays ?? 7);
      setStaleRateLimitDays(scheduleQuery.data.staleAlertRateLimitDays ?? 3);
      setSchedStaleDays(scheduleQuery.data.staleAfterDays ?? DEFAULT_BACKUP_STALE_DAYS);
    }
  }, [scheduleQuery.data]);

  const backupNowMutation = useMutation({
    mutationFn: async (): Promise<{ size: number; completedAt: string; fileName: string; savedTo: string | null; viaBrowser: boolean }> => {
      const isNetworkSftp = nowDest === "network" && nowPath.trim().startsWith("sftp://");
      if (isNetworkSftp) {
        const res = await apiFetch<{ size: number; completedAt: string; fileName: string }>("/admin/backup/run", {
          method: "POST",
          body: JSON.stringify({ destination: nowDest, path: nowPath.trim() || undefined }),
        });
        return { ...res, savedTo: nowPath.trim(), viaBrowser: false };
      }
      const { buffer, headers } = await apiFetchArrayBuffer("/admin/backup/generate", {
        method: "POST",
      });
      const disposition = headers.get("Content-Disposition") ?? "";
      const nameMatch = /filename="([^"]+)"/.exec(disposition);
      const fileName = nameMatch?.[1] ?? "labtrax-backup.zip.enc";
      const size = buffer.byteLength;
      const completedAt = new Date().toISOString();
      const electronAPI = (window as unknown as { electronAPI?: { saveBackupToFolder?: (buf: Uint8Array, name: string, folder: string) => Promise<{ ok: boolean; path?: string; error?: string }> } }).electronAPI;
      const wantsPath = !!nowPath.trim();
      if (wantsPath && !electronAPI?.saveBackupToFolder) {
        // Running in a regular browser — we cannot write to an arbitrary
        // filesystem path. Refuse instead of silently downloading to the
        // browser's default Downloads folder while pretending we saved to
        // the user's E:\… path.
        throw new Error(
          `This browser cannot save directly to "${nowPath.trim()}". Install and open the LabTrax Desktop app to back up to a specific folder, or clear the folder path to download the backup file through your browser instead.`,
        );
      }
      if (electronAPI?.saveBackupToFolder && wantsPath) {
        const result = await electronAPI.saveBackupToFolder(new Uint8Array(buffer), fileName, nowPath.trim());
        if (!result.ok) {
          throw new Error(result.error ?? "Failed to save backup to folder.");
        }
        return { size, completedAt, fileName, savedTo: result.path ?? nowPath.trim(), viaBrowser: false };
      }
      const blob = new Blob([buffer], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return { size, completedAt, fileName, savedTo: null, viaBrowser: true };
    },
    onSuccess: (data) => {
      setBackupResult(data);
      setBackupError(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-history"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-schedule-v2"] });
    },
    onError: (err: Error) => {
      setBackupResult(null);
      setBackupError(err.message || "Backup failed.");
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-history"] });
    },
  });

  const saveScheduleMutation = useMutation({
    mutationFn: () => {
      const parsed = parseIntervalKey(schedIntervalKey) ?? { interval: 1, unit: "hours" as BackupIntervalUnit };
      return apiFetch("/admin/backup/schedule", {
        method: "PUT",
        body: JSON.stringify({
          interval: parsed.interval,
          unit: parsed.unit,
          destination: schedDest,
          path: schedPath.trim() || null,
          enabled: schedEnabled,
          staleAlertThresholdDays: staleThresholdDays,
          staleAlertRateLimitDays: staleRateLimitDays,
          staleAfterDays: schedStaleDays,
        }),
      });
    },
    onSuccess: () => {
      setSchedError(null);
      setSchedSuccess(true);
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-schedule-v2"] });
      setTimeout(() => setSchedSuccess(false), 2500);
    },
    onError: (err: Error) => {
      setSchedError(err.message || "Failed to save schedule.");
    },
  });

  const disableScheduleMutation = useMutation({
    mutationFn: () => apiFetch("/admin/backup/schedule", { method: "DELETE" }),
    onSuccess: () => {
      setSchedEnabled(false);
      setSchedError(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-schedule-v2"] });
    },
    onError: (err: Error) => {
      setSchedError(err.message || "Failed to disable schedule.");
    },
  });

  const schedRunNowMutation = useMutation({
    mutationFn: () => apiFetch("/admin/backup/schedule/run-now", { method: "POST" }),
    onSuccess: (data: { size: number; completedAt: string; fileName: string }) => {
      setSchedRunNowResult(data);
      setSchedRunNowError(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-history"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-schedule-v2"] });
    },
    onError: (err: Error) => {
      setSchedRunNowResult(null);
      setSchedRunNowError(err.message || "Backup run failed.");
    },
  });

  const electron = typeof window !== "undefined"
    ? (window as ElectronWindow).electronAPI
    : null;

  async function pickFolderFor(setter: (v: string) => void) {
    if (electron?.showFolderDialog) {
      const p = await electron.showFolderDialog();
      if (p) setter(p);
    }
  }

  const gate = usePlatformAdminGate([
    scheduleQuery.error,
    backupNowMutation.error,
    saveScheduleMutation.error,
    disableScheduleMutation.error,
    schedRunNowMutation.error,
  ]);

  const needsPath = (d: BackupDestinationType) => d === "local" || d === "network";

  const stale = isBackupStale(scheduleQuery.data?.lastSuccessfulBackupAt ?? null, scheduleQuery.data?.staleAfterDays ?? DEFAULT_BACKUP_STALE_DAYS);
  const lastBackupAt = scheduleQuery.data?.lastSuccessfulBackupAt ?? null;

  return (
    <PanelShell title="Backup" subtitle="Back up all LabTrax data to keep your records safe.">
      {gate.blocked && <PlatformAdminSetupNotice />}

      {!gate.blocked && !scheduleQuery.isLoading && stale && (
        <div className="flex items-center gap-2.5 rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-3.5 py-3 text-amber-800 dark:text-amber-300">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
          <div className="flex-1 text-xs leading-snug space-y-0.5">
            <p className="font-semibold">
              {lastBackupAt ? "Backup overdue" : "Backup never completed"}
            </p>
            <p className="text-amber-700 dark:text-amber-400">
              {lastBackupAt
                ? `Last successful backup was ${Math.floor((Date.now() - new Date(lastBackupAt).getTime()) / (24 * 60 * 60 * 1000))} day(s) ago.`
                : "A successful backup has never been run for this lab."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => backupNowMutation.mutate()}
            disabled={backupNowMutation.isPending || (needsPath(nowDest) && !nowPath.trim())}
            className="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-semibold bg-amber-200 hover:bg-amber-300 text-amber-900 dark:bg-amber-800 dark:hover:bg-amber-700 dark:text-amber-100 disabled:opacity-60 transition-colors"
          >
            {backupNowMutation.isPending
              ? <><Loader2 size={11} className="animate-spin" />Backing up…</>
              : <><Download size={11} />Run backup now</>}
          </button>
        </div>
      )}

      {/* ── Back up now ── */}
      <div className="border border-border rounded-lg p-4 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck size={14} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold">Back up LabTrax data now</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          Creates a full backup ZIP containing all cases, patients, doctors, invoices, payments, bank transactions, pricing, and media attachments.
        </p>

        {backupError && !gate.blocked && <Alert tone="danger">{backupError}</Alert>}
        {backupResult && (
          <Alert tone="success">
            Backup complete — {formatBackupSize(backupResult.size)}{" "}
            {backupResult.viaBrowser ? (
              <>
                downloaded by your browser as{" "}
                <code className="font-mono text-xs">{backupResult.fileName}</code>. Check your
                browser's downloads folder.
              </>
            ) : backupResult.savedTo ? (
              <>
                saved to{" "}
                <code className="font-mono text-xs">{backupResult.savedTo}</code>.
              </>
            ) : (
              <>
                saved as{" "}
                <code className="font-mono text-xs">{backupResult.fileName}</code>.
              </>
            )}{" "}
            <span className="opacity-70">{new Date(backupResult.completedAt).toLocaleString()}</span>
          </Alert>
        )}

        <div className="space-y-3">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-2">Destination</div>
            <div className="flex flex-wrap gap-4">
              {(["local", "network"] as const).map((d) => (
                <label key={d} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="now-destination"
                    value={d}
                    checked={nowDest === d}
                    onChange={() => { setNowDest(d); setBackupResult(null); setBackupError(null); }}
                    className="accent-primary"
                  />
                  {d === "local" ? "Local folder / USB" : "Network server"}
                </label>
              ))}
            </div>
          </div>

          {needsPath(nowDest) && (
            <div className="space-y-1.5">
              {!electron?.saveBackupToFolder && nowDest === "local" && (
                <div className="rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[11px] leading-snug text-amber-800 dark:text-amber-300">
                  You're using LabTrax in a web browser. Browsers can't save files
                  to a specific folder like <span className="font-mono">E:\Lab Software\LabTrax Backup</span>.
                  Either install and open the LabTrax Desktop app to save to a chosen
                  folder, or clear the folder path below to download the backup file
                  through your browser instead.
                </div>
              )}
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                    {nowDest === "local" ? "Folder path" : "Network path (UNC/SMB or SFTP URL)"}
                  </label>
                  <input
                    value={nowPath}
                    onChange={(e) => setNowPath(e.target.value)}
                    placeholder={nowDest === "local" ? "C:\\Backups\\LabTrax" : "\\\\server\\share\\LabTrax  or  sftp://user@host/backups"}
                    className={inputCls}
                  />
                </div>
                {electron?.showFolderDialog && nowDest === "local" && (
                  <button
                    type="button"
                    onClick={() => pickFolderFor(setNowPath)}
                    className="h-9 px-3 rounded-md border border-border bg-secondary text-foreground text-xs font-medium hover:bg-secondary/80 shrink-0"
                  >
                    Browse…
                  </button>
                )}
              </div>
              {nowDest === "network" && nowPath.trim() && (
                <p className="text-[11px] text-muted-foreground leading-snug">
                  {nowPath.trim().startsWith("sftp://")
                    ? "SFTP — the file will be uploaded by the server directly to this location."
                    : "UNC/SMB — the file will be saved by this desktop app directly. The app must be open when you click Back up now."}
                </p>
              )}
              {nowDest === "network" && !nowPath.trim() && (
                <p className="text-[11px] text-muted-foreground leading-snug">
                  Use <span className="font-mono">\\server\share\LabTrax</span> for a network share (saved by this app) or <span className="font-mono">sftp://user@host/path</span> for SFTP (saved by the server).
                </p>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => backupNowMutation.mutate()}
          disabled={
            backupNowMutation.isPending ||
            gate.blocked ||
            (needsPath(nowDest) && !nowPath.trim())
          }
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-2"
        >
          {backupNowMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          {backupNowMutation.isPending ? "Backing up…" : "Back up now"}
        </button>
      </div>

      {/* ── Schedule ── */}
      <div className="border border-border rounded-lg p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock size={14} className="text-muted-foreground" />
            <h3 className="text-sm font-semibold">Schedule routine backups</h3>
          </div>
          {scheduleQuery.data?.enabled && (
            <span className="text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded-full bg-success/15 text-success">
              Active
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Automatically back up LabTrax at a regular interval to protect against data loss.
        </p>

        {schedError && !gate.blocked && <Alert tone="danger">{schedError}</Alert>}
        {schedSuccess && <Alert tone="success">Schedule saved.</Alert>}

        {scheduleQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={13} className="animate-spin" />
            Loading…
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Interval">
                <select
                  value={schedIntervalKey}
                  onChange={(e) => setSchedIntervalKey(e.target.value)}
                  className={inputCls}
                >
                  {INTERVAL_OPTIONS.map((opt) => (
                    <option key={intervalKey(opt.interval, opt.unit)} value={intervalKey(opt.interval, opt.unit)}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Destination">
                <select
                  value={schedDest}
                  onChange={(e) => setSchedDest(e.target.value as BackupDestinationType)}
                  className={inputCls}
                >
                  <option value="local">Local folder / USB</option>
                  <option value="network">Network server</option>
                </select>
              </Field>
            </div>

            {needsPath(schedDest) && (
              <div className="space-y-1.5">
                <div className="flex gap-2 items-end">
                  <div className="flex-1">
                    <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                      {schedDest === "local" ? "Folder path" : "Network path (SFTP URL)"}
                    </label>
                    <input
                      value={schedPath}
                      onChange={(e) => setSchedPath(e.target.value)}
                      placeholder={schedDest === "local" ? "C:\\Backups\\LabTrax" : "sftp://user@host/backups/LabTrax"}
                      className={inputCls}
                    />
                  </div>
                  {electron?.showFolderDialog && schedDest === "local" && (
                    <button
                      type="button"
                      onClick={() => pickFolderFor(setSchedPath)}
                      className="h-9 px-3 rounded-md border border-border bg-secondary text-foreground text-xs font-medium hover:bg-secondary/80 shrink-0"
                    >
                      Browse…
                    </button>
                  )}
                </div>
                {schedDest === "network" && schedPath.trim() && !schedPath.trim().startsWith("sftp://") && (
                  <div className="flex items-start gap-1.5 rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-amber-800 dark:text-amber-300">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
                    <p className="text-[11px] leading-snug">
                      UNC/SMB paths can't be used for scheduled backups — the server runs on Linux and can't access Windows network shares. Use an SFTP URL (<span className="font-mono">sftp://user@host/path</span>) for scheduled network backups. For UNC shares, use <strong>Back up now</strong> instead.
                    </p>
                  </div>
                )}
                {schedDest === "network" && !schedPath.trim() && (
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    Only SFTP URLs are supported for scheduled backups. Use <span className="font-mono">sftp://user@host/path</span>.
                  </p>
                )}
              </div>
            )}

            {/* Warn when the scheduled destination can't be reached from the server */}
            {(schedDest === "local" || (schedDest === "network" && !!schedPath.trim() && !schedPath.trim().startsWith("sftp://"))) && (
              <div className="flex items-start gap-2.5 rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-3.5 py-3 text-amber-800 dark:text-amber-300">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
                <div className="text-xs leading-snug space-y-1">
                  <p className="font-semibold">Scheduled backups can't write to this destination</p>
                  <p className="text-amber-700 dark:text-amber-400">
                    {schedDest === "local"
                      ? "Local folder and USB paths exist on your Windows machine, but scheduled backups run on the server (Linux) where those paths don't exist. The file would never reach you."
                      : "UNC/SMB network paths (\\\\server\\share) exist on your Windows network, but scheduled backups run on the server (Linux) where those paths aren't mounted."}
                    {" "}Use an <strong>SFTP URL</strong> (<code className="font-mono">sftp://user@host/path</code>) for scheduled backups, or use <strong>Back up now</strong> for local folder / USB backups.
                  </p>
                </div>
              </div>
            )}

            {/* Warn when network destination path looks like SFTP but is missing required fields */}
            {schedDest === "network" && schedPath.trim().startsWith("sftp://") && (
              <p className="text-[11px] text-muted-foreground">
                SFTP: authenticate via SSH key. Embedded passwords are not supported.
              </p>
            )}

            <div>
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Warn me if backup is older than (days)
              </label>
              <input
                type="number"
                min={1}
                max={365}
                value={schedStaleDays}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (Number.isFinite(v) && v >= 1) setSchedStaleDays(v);
                }}
                className={inputCls + " w-28"}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Alert after (days without backup)">
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={staleThresholdDays}
                  onChange={(e) => setStaleThresholdDays(Math.max(1, Math.min(365, parseInt(e.target.value, 10) || 7)))}
                  className={inputCls}
                />
              </Field>
              <Field label="Re-alert at most every (days)">
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={staleRateLimitDays}
                  onChange={(e) => setStaleRateLimitDays(Math.max(1, Math.min(365, parseInt(e.target.value, 10) || 3)))}
                  className={inputCls}
                />
              </Field>
            </div>

            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={schedEnabled}
                onChange={(e) => setSchedEnabled(e.target.checked)}
                className="accent-primary"
              />
              Enable automatic backups
            </label>
          </div>
        )}

        <div className="flex items-center gap-2 pt-1 flex-wrap">
          <button
            type="button"
            onClick={() => saveScheduleMutation.mutate()}
            disabled={
              saveScheduleMutation.isPending ||
              scheduleQuery.isLoading ||
              gate.blocked ||
              (schedEnabled && needsPath(schedDest) && !schedPath.trim()) ||
              schedEnabled && (
                schedDest === "local" ||
                (schedDest === "network" && !!schedPath.trim() && !schedPath.trim().startsWith("sftp://"))
              )
            }
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-2"
          >
            {saveScheduleMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : null}
            {saveScheduleMutation.isPending ? "Saving…" : "Save schedule"}
          </button>
          {scheduleQuery.data?.enabled && (
            <button
              type="button"
              onClick={() => disableScheduleMutation.mutate()}
              disabled={disableScheduleMutation.isPending || gate.blocked}
              className="h-9 px-3 rounded-md border border-border text-sm text-muted-foreground hover:text-foreground disabled:opacity-60"
            >
              Disable
            </button>
          )}
          {scheduleQuery.data?.enabled &&
            scheduleQuery.data?.destination === "network" &&
            !!scheduleQuery.data?.path?.startsWith("sftp://") && (
              <button
                type="button"
                onClick={() => {
                  setSchedRunNowResult(null);
                  setSchedRunNowError(null);
                  schedRunNowMutation.mutate();
                }}
                disabled={schedRunNowMutation.isPending || gate.blocked}
                className="h-9 px-3 rounded-md border border-border text-sm text-muted-foreground hover:text-foreground disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {schedRunNowMutation.isPending
                  ? <><Loader2 size={13} className="animate-spin" />Running…</>
                  : <><Play size={13} />Run now</>}
              </button>
            )}
        </div>

        {schedRunNowResult && !gate.blocked && (
          <Alert tone="success">
            Schedule test complete — {formatBackupSize(schedRunNowResult.size)} saved as{" "}
            <code className="font-mono text-xs">{schedRunNowResult.fileName}</code>.
          </Alert>
        )}
        {schedRunNowError && !gate.blocked && (
          <Alert tone="danger">{schedRunNowError}</Alert>
        )}
      </div>

      {/* ── Recent backups ── */}
      <div className="border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <History size={14} className="text-muted-foreground" />
            <h3 className="text-sm font-semibold">Recent backups</h3>
          </div>
          <button
            type="button"
            onClick={() => historyQuery.refetch()}
            disabled={historyQuery.isFetching}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {historyQuery.isFetching ? <Loader2 size={11} className="animate-spin inline" /> : "Refresh"}
          </button>
        </div>

        {/* Retention policy */}
        <div className="border border-border/60 rounded-md p-3 bg-muted/20 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">History retention</p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Keep for (days)</label>
              <input
                type="number"
                min={1}
                value={retentionDaysInput}
                onChange={(e) => setRetentionDaysInput(e.target.value)}
                disabled={retentionQuery.isLoading || gate.blocked}
                className="w-24 h-8 rounded-md border border-border bg-background px-2 text-xs disabled:opacity-50"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Max rows</label>
              <input
                type="number"
                min={1}
                value={maxRowsInput}
                onChange={(e) => setMaxRowsInput(e.target.value)}
                disabled={retentionQuery.isLoading || gate.blocked}
                className="w-24 h-8 rounded-md border border-border bg-background px-2 text-xs disabled:opacity-50"
              />
            </div>
            <button
              type="button"
              onClick={() => saveRetentionMutation.mutate()}
              disabled={
                saveRetentionMutation.isPending ||
                retentionQuery.isLoading ||
                gate.blocked ||
                !retentionDaysInput ||
                !maxRowsInput ||
                isNaN(parseInt(retentionDaysInput, 10)) ||
                isNaN(parseInt(maxRowsInput, 10)) ||
                parseInt(retentionDaysInput, 10) < 1 ||
                parseInt(maxRowsInput, 10) < 1
              }
              className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
            >
              {saveRetentionMutation.isPending ? <Loader2 size={11} className="animate-spin" /> : null}
              {saveRetentionMutation.isPending ? "Saving…" : "Save"}
            </button>
            {retentionSaved && (
              <span className="text-xs text-success flex items-center gap-1">
                <Check size={11} />
                Saved
              </span>
            )}
          </div>
          {saveRetentionMutation.isError && (
            <p className="text-xs text-destructive">
              {saveRetentionMutation.error instanceof Error
                ? saveRetentionMutation.error.message
                : "Failed to save retention settings."}
            </p>
          )}
          <p className="text-[10px] text-muted-foreground">
            Older entries are pruned automatically after each backup run. Whichever limit removes more rows wins.
          </p>
        </div>

        {historyQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={13} className="animate-spin" />
            Loading…
          </div>
        ) : historyQuery.isError ? (
          <p className="text-xs text-destructive">Could not load backup history.</p>
        ) : !historyQuery.data?.runs?.length ? (
          <p className="text-xs text-muted-foreground">No backups recorded yet. Run your first backup above.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">Status</th>
                  <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">When</th>
                  <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">Destination</th>
                  <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">Size</th>
                  <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">File</th>
                  <th className="text-left py-1.5 font-medium text-muted-foreground">Triggered by</th>
                </tr>
              </thead>
              <tbody>
                {historyQuery.data.runs.map((run) => (
                  <tr key={run.id} className="border-b border-border/50 last:border-0 hover:bg-muted/30">
                    <td className="py-1.5 pr-3 align-top">
                      {run.status === "success" ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-success/15 text-success">
                          <Check size={9} />
                          OK
                        </span>
                      ) : run.error?.includes("unreachable from the server") ? (
                        <span
                          className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 cursor-help"
                          title={
                            (run.error ?? "") +
                            "\n\nTo fix this, update the scheduled destination in the Schedule section above."
                          }
                        >
                          Skipped
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-destructive/15 text-destructive cursor-help"
                          title={run.error ?? "Unknown error"}
                        >
                          Error
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 align-top whitespace-nowrap text-muted-foreground">
                      {new Date(run.completedAt).toLocaleString(undefined, {
                        month: "short", day: "numeric", year: "numeric",
                        hour: "numeric", minute: "2-digit",
                      })}
                    </td>
                    <td className="py-1.5 pr-3 align-top capitalize">
                      {run.destination}
                      {run.path && (
                        <span className="block text-[10px] text-muted-foreground font-mono truncate max-w-[140px]" title={run.path}>
                          {run.path}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 align-top whitespace-nowrap">
                      {run.sizeBytes != null ? formatBackupSize(run.sizeBytes) : "—"}
                    </td>
                    <td className="py-1.5 pr-3 align-top font-mono max-w-[160px] truncate" title={run.fileName ?? undefined}>
                      {run.fileName ?? "—"}
                    </td>
                    <td className="py-1.5 align-top text-muted-foreground">
                      {run.triggeredBy}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Restore from backup ── */}
      <RestoreSection gate={gate} scheduleData={scheduleQuery.data ?? null} queryClient={queryClient} />
    </PanelShell>
  );
}

type RestorePhase = "idle" | "uploading" | "validating" | "decrypting" | "restoring_db" | "restoring_media" | "done" | "error";

const RESTORE_PHASE_LABELS: Record<RestorePhase, string> = {
  idle: "Idle",
  uploading: "Uploading…",
  validating: "Validating…",
  decrypting: "Decrypting…",
  restoring_db: "Restoring database…",
  restoring_media: "Restoring media files…",
  done: "Done",
  error: "Error",
};

const RESTORE_PHASE_STEP: Record<RestorePhase, number> = {
  idle: 0,
  uploading: 1,
  validating: 2,
  decrypting: 3,
  restoring_db: 4,
  restoring_media: 5,
  done: 6,
  error: 0,
};

function RestoreSection({
  gate,
  scheduleData,
  queryClient,
}: {
  gate: { blocked: boolean };
  scheduleData: { destination?: string | null; enabled?: boolean } | null;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const electron = typeof window !== "undefined"
    ? (window as ElectronWindow).electronAPI
    : null;

  const [open, setOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmStep, setConfirmStep] = useState<1 | 2>(1);
  const [restorePhase, setRestorePhase] = useState<RestorePhase>("idle");
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreSuccess, setRestoreSuccess] = useState(false);
  const [relaunchCountdown, setRelaunchCountdown] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const cancelRelaunch = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setRelaunchCountdown(null);
  }, []);

  useEffect(() => {
    if (!restoreSuccess || typeof electron?.relaunch !== "function") return;
    setRelaunchCountdown(3);
    const tick = setInterval(() => {
      setRelaunchCountdown((c) => {
        if (c === null) return null;
        if (c <= 1) {
          clearInterval(tick);
          countdownTimerRef.current = null;
          electron!.relaunch!();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    countdownTimerRef.current = tick;
    return () => {
      clearInterval(tick);
      countdownTimerRef.current = null;
    };
  }, [restoreSuccess, electron]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res = await apiFetch<{ phase: RestorePhase; message: string | null }>("/admin/backup/restore/status");
        setRestorePhase(res.phase);
        setRestoreMessage(res.message);
        if (res.phase === "done") {
          stopPolling();
          setRestoreSuccess(true);
          queryClient.invalidateQueries({ queryKey: ["admin", "backup-history"] });
        } else if (res.phase === "error") {
          stopPolling();
          setRestoreError(res.message || "Restore failed.");
        }
      } catch {
        // polling errors are transient; keep trying
      }
    }, 1500);
  }, [stopPolling, queryClient]);

  async function pickFileElectron() {
    if (!electron?.showOpenDialog) return;
    const filePaths = await electron.showOpenDialog({
      title: "Choose backup file",
      filters: [{ name: "LabTrax Backup", extensions: ["zip.enc", "enc"] }],
      properties: ["openFile"],
    });
    if (!filePaths || filePaths.length === 0) return;
    // Electron gives us a path; build a File-like object using fetch
    const resp = await fetch(`file://${filePaths[0]}`).catch(() => null);
    if (resp) {
      const blob = await resp.blob();
      const file = new File([blob], filePaths[0].split("/").pop() ?? "backup.zip.enc");
      setSelectedFile(file);
    }
  }

  function handleNativeFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (f) {
      setSelectedFile(f);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function openConfirm() {
    setConfirmStep(1);
    setRestoreError(null);
    setRestoreSuccess(false);
    setShowConfirm(true);
  }

  async function runRestore() {
    setShowConfirm(false);
    setRestorePhase("uploading");
    setRestoreMessage("Uploading backup file…");
    setRestoreError(null);
    setRestoreSuccess(false);
    startPolling();
    try {
      if (selectedFile) {
        const fd = new FormData();
        fd.append("file", selectedFile, selectedFile.name);
        await apiFetch("/admin/backup/restore", { method: "POST", body: fd, headers: {} as any });
      }
    } catch (err: unknown) {
      stopPolling();
      const msg = err instanceof Error ? err.message : "Restore failed.";
      setRestorePhase("error");
      setRestoreError(msg);
    }
  }

  const isRunning = restorePhase !== "idle" && restorePhase !== "done" && restorePhase !== "error";
  const stepCount = 5;
  const step = RESTORE_PHASE_STEP[restorePhase];

  return (
    <>
      <div className="border border-border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-foreground hover:bg-muted/30 transition-colors"
        >
          <div className="flex items-center gap-2">
            <RotateCcw size={14} className="text-muted-foreground" />
            Restore from backup
          </div>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {open && (
          <div className="px-4 pb-4 space-y-4 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Restore all lab data from a LabTrax <code className="font-mono">.zip.enc</code> backup file.{" "}
              <strong className="text-destructive">All current data and media will be replaced.</strong>
            </p>

            {restoreSuccess && (
              <div className="rounded-md bg-success/10 border border-success/30 px-3 py-2 text-xs text-success font-medium space-y-2">
                <div>
                  Restore complete — restart the app to finish loading the restored data.
                  {relaunchCountdown !== null && relaunchCountdown > 0 && (
                    <span className="ml-1">(Relaunching in {relaunchCountdown}…)</span>
                  )}
                  {relaunchCountdown === null && typeof electron?.relaunch !== "function" && (
                    <span className="ml-1">Please restart the app manually.</span>
                  )}
                </div>
                {typeof electron?.relaunch === "function" && (
                  <div className="flex items-center gap-2">
                    {relaunchCountdown !== null && relaunchCountdown > 0 && (
                      <button
                        type="button"
                        onClick={cancelRelaunch}
                        className="rounded px-2 py-0.5 text-xs font-semibold border border-success/40 bg-success/10 hover:bg-success/20 text-success transition-colors"
                      >
                        Cancel relaunch
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => electron!.relaunch!()}
                      className="rounded px-2 py-0.5 text-xs font-semibold border border-success/40 bg-success/20 hover:bg-success/30 text-success transition-colors"
                    >
                      Relaunch now
                    </button>
                  </div>
                )}
              </div>
            )}
            {restoreError && (
              <Alert tone="danger">{restoreError}</Alert>
            )}

            {isRunning && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground font-medium">{RESTORE_PHASE_LABELS[restorePhase]}</span>
                  <span className="text-muted-foreground">{step}/{stepCount}</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-500 rounded-full"
                    style={{ width: `${Math.min(100, (step / stepCount) * 100)}%` }}
                  />
                </div>
                {restoreMessage && (
                  <p className="text-[11px] text-muted-foreground">{restoreMessage}</p>
                )}
              </div>
            )}

            {!isRunning && !restoreSuccess && (
              <div className="space-y-3">
                {/* File source */}
                <div className="space-y-2">
                  {/* Local file */}
                  <div className="flex items-center gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".enc,.zip.enc"
                      className="hidden"
                      onChange={handleNativeFileChange}
                    />
                    <button
                      type="button"
                      disabled={gate.blocked}
                      onClick={() => {
                        if (electron?.showOpenDialog) {
                          void pickFileElectron();
                        } else {
                          fileInputRef.current?.click();
                        }
                      }}
                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border bg-background text-xs font-medium hover:bg-secondary disabled:opacity-60"
                    >
                      <Upload size={12} />
                      Choose backup file…
                    </button>
                    {selectedFile && (
                      <span className="text-xs text-muted-foreground font-mono truncate max-w-[180px]" title={selectedFile.name}>
                        {selectedFile.name}
                      </span>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  disabled={gate.blocked || !selectedFile}
                  onClick={() => openConfirm()}
                  className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 disabled:opacity-60 inline-flex items-center gap-2"
                >
                  <RotateCcw size={13} />
                  Restore
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Confirmation modal ── */}
      {showConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowConfirm(false)}
        >
          <div
            className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            {confirmStep === 1 ? (
              <>
                <div className="space-y-1">
                  <h3 className="text-base font-semibold text-destructive">⚠ Replace all data?</h3>
                  <p className="text-sm text-muted-foreground">
                    Restoring this backup will <strong>permanently overwrite</strong> all current lab data, including:
                  </p>
                </div>
                <ul className="text-sm text-muted-foreground list-disc list-inside space-y-0.5">
                  <li>All cases, patients, and doctors</li>
                  <li>All invoices and financial records</li>
                  <li>All media file attachments</li>
                  <li>All users and organization settings</li>
                </ul>
                <p className="text-xs text-muted-foreground border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 rounded px-2 py-1.5">
                  Source: <strong>{selectedFile?.name ?? "selected file"}</strong>
                </p>
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowConfirm(false)}
                    className="h-9 px-4 rounded-md border border-border text-sm hover:bg-secondary"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmStep(2)}
                    className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90"
                  >
                    I understand — continue
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1">
                  <h3 className="text-base font-semibold text-destructive">Final confirmation</h3>
                  <p className="text-sm text-muted-foreground">
                    Are you absolutely sure? This action cannot be undone. All current data will be replaced.
                  </p>
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowConfirm(false)}
                    className="h-9 px-4 rounded-md border border-border text-sm hover:bg-secondary"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void runRestore()}
                    className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90"
                  >
                    Yes, restore now
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

interface InstallerSlotInfo {
  available: boolean;
  size: number | null;
  uploadedAt: string | null;
  error: string | null;
}

interface DesktopInstallerInfo {
  version: string;
  dbVersion: string | null;
  envVersion: string;
  downloadUrl: string;
  dbDownloadUrl: string | null;
  envDownloadUrl: string;
  fileName: string | null;
  repoUrl: string | null;
  repoOwner: string | null;
  repoName: string | null;
  tokenConfigured: boolean;
  urlError: string | null;
  repoUrlWarning?: string;
  releaseNotes: string | null;
  dbReleaseNotes: string | null;
  installerObject: { size: number; uploadedAt: string } | null;
  installerSlots?: { zip: InstallerSlotInfo; exe: InstallerSlotInfo; dmg: InstallerSlotInfo };
  installerStatus: "ok" | "missing" | "stale" | "external" | "unknown";
  installerStatusMessage: string | null;
  settingsUpdatedAt: string | null;
  buildCounterWarning: {
    runUrl: string | null;
    runId: string | null;
    workflowName: string | null;
    ref: string | null;
    attemptedBuildNumber: number | null;
    reportedAt: string;
  } | null;
  downloadInterruptionAlertThreshold: number;
  downloadInterruptionAlertThresholdSource: "db" | "env";
  envDownloadInterruptionAlertThreshold: number;
  lastDesktopBuildTrigger: {
    triggeredAt: string;
    triggeredByUsername: string;
    apiBaseUrl: string;
  } | null;
}

interface DesktopBuildRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

interface DesktopBuildStatus {
  run: DesktopBuildRun | null;
}

function formatInstallerSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatInstallerTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function InstallerStatusBadge({ status }: { status: DesktopInstallerInfo["installerStatus"] }) {
  const map: Record<DesktopInstallerInfo["installerStatus"], { label: string; cls: string }> = {
    ok: { label: "Ready", cls: "bg-success/15 text-success" },
    missing: { label: "Missing", cls: "bg-destructive/15 text-destructive" },
    stale: { label: "Stale", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
    external: { label: "External", cls: "bg-secondary text-muted-foreground" },
    unknown: { label: "Unknown", cls: "bg-destructive/15 text-destructive" },
  };
  const { label, cls } = map[status] ?? map.unknown;
  return (
    <span className={`text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded-full ${cls}`}>
      {label}
    </span>
  );
}

function parseVersionFromFilename(filename: string): string | null {
  const match = filename.match(/(\d+\.\d+(?:\.\d+)*(?:-[\w.]+)?)/);
  return match ? match[1] : null;
}

function compareVersions(a: string, b: string): number {
  const normalize = (v: string) =>
    v
      .replace(/^v/, "")
      .split(/[-+]/)[0]
      .split(".")
      .map((p) => parseInt(p, 10) || 0);
  const pa = normalize(a);
  const pb = normalize(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

interface DesktopUpdateState {
  status: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
  lastCheckedAt: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
  downloadProgress: number | null;
  releaseNotes: string | null;
  error: string | null;
  feedUrl: string | null;
  autoUpdaterEnabled: boolean;
}

interface DesktopUpdaterApi {
  getAppVersion?: () => Promise<string>;
  getUpdateState?: () => Promise<DesktopUpdateState>;
  checkForUpdates?: () => Promise<DesktopUpdateState>;
  downloadUpdate?: () => Promise<DesktopUpdateState>;
  installUpdate?: () => Promise<void>;
  onUpdateState?: (cb: (state: DesktopUpdateState) => void) => () => void;
}

function getDesktopUpdaterApi(): DesktopUpdaterApi | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { electronAPI?: DesktopUpdaterApi }).electronAPI;
  if (!api || typeof api.getUpdateState !== "function") return null;
  return api;
}

// Non-admin Desktop app panel: shows just the version + Check for updates
// card so any signed-in user can self-report their version and trigger an
// on-demand check without waiting for the 4-hour background poll. Admin-only
// controls (installer upload, build pipeline, etc.) stay in DesktopInstallerPanel.
function DesktopAppUserPanel() {
  const api = getDesktopUpdaterApi();
  return (
    <PanelShell
      title="Desktop app"
      subtitle="Your installed version and update status."
    >
      {api ? (
        <AppVersionCard />
      ) : (
        <Alert tone="warning">
          App version info is only available inside the LabTrax desktop app.
        </Alert>
      )}
    </PanelShell>
  );
}

// Card shown at the top of Settings → Desktop App: surfaces the currently
// installed app version and lets an admin trigger an on-demand update check
// without waiting for the 4-hour background poll in `electron/main.cjs`.
// When auto-download is in progress or an update is staged for install, the
// card mirrors that status so admins can re-launch from this card too.
function AppVersionCard() {
  const api = getDesktopUpdaterApi();
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!api) return;
    let mounted = true;
    api.getAppVersion?.().then((v) => mounted && setAppVersion(v)).catch(() => {});
    api.getUpdateState?.().then((s) => mounted && setState(s)).catch(() => {});
    const off = api.onUpdateState?.((s) => mounted && setState(s));
    return () => {
      mounted = false;
      off?.();
    };
  }, [api]);

  // When not running inside the installed Electron desktop app, the
  // electron-updater IPC bridge is unavailable — there is no "current
  // version" to report and no way to trigger a download. Render a
  // placeholder card so admins viewing in a browser/PWA still see where
  // the update controls live (and aren't left wondering why the
  // Refresh / Check-for-updates button is missing).
  if (!api) {
    return (
      <div className="rounded-lg border border-border bg-secondary/30 px-5 py-4 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-sm font-semibold">App version</div>
          <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
            Browser preview
          </span>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Update controls (<strong>Check for updates</strong>,{" "}
          <strong>Download</strong>, <strong>Restart &amp; install</strong>) only appear when
          you open this page inside the <em>installed</em> LabTrax Desktop app —
          they rely on Electron auto-update IPC that the browser can&apos;t
          provide. Download &amp; install the desktop app from{" "}
          <strong>Download Desktop App</strong> in the sidebar, then sign in
          there and revisit Settings → Desktop app to see the version banner and
          the Check-for-updates button.
        </p>
      </div>
    );
  }

  const currentVersion = state?.currentVersion ?? appVersion ?? "—";
  const status = state?.status ?? "idle";
  const isChecking = status === "checking" || busy;
  const isDownloading = status === "downloading";
  const isDownloaded = status === "downloaded";
  const lastChecked = state?.lastCheckedAt
    ? new Date(state.lastCheckedAt).toLocaleString()
    : "never";

  async function handleCheck() {
    const check = api?.checkForUpdates;
    if (!check) return;
    setBusy(true);
    try {
      const next = await check();
      setState(next);
    } finally {
      setBusy(false);
    }
  }

  async function handleDownload() {
    const dl = api?.downloadUpdate;
    if (!dl) return;
    setBusy(true);
    try {
      const next = await dl();
      setState(next);
    } finally {
      setBusy(false);
    }
  }

  async function handleInstall() {
    await api?.installUpdate?.();
  }

  let statusLabel: string;
  let statusCls: string;
  switch (status) {
    case "checking":
      statusLabel = "Checking…";
      statusCls = "bg-secondary text-muted-foreground";
      break;
    case "available":
      statusLabel = state?.latestVersion ? `Update available: v${state.latestVersion}` : "Update available";
      statusCls = "bg-primary/10 text-primary";
      break;
    case "downloading":
      statusLabel = `Downloading${state?.downloadProgress != null ? ` ${state.downloadProgress}%` : "…"}`;
      statusCls = "bg-primary/10 text-primary";
      break;
    case "downloaded":
      statusLabel = state?.latestVersion ? `Ready to install v${state.latestVersion}` : "Ready to install";
      statusCls = "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
      break;
    case "not-available":
      statusLabel = "Up to date";
      statusCls = "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
      break;
    case "error":
      statusLabel = "Check failed";
      statusCls = "bg-destructive/10 text-destructive";
      break;
    default:
      statusLabel = "Idle";
      statusCls = "bg-secondary text-muted-foreground";
  }

  return (
    <div className="rounded-lg border border-border bg-secondary/30 px-5 py-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-sm font-semibold">App version</div>
            <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${statusCls}`}>
              {statusLabel}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Installed v{currentVersion} · last checked {lastChecked}
            {state?.feedUrl ? <> · feed <code className="font-mono text-[10px]">{state.feedUrl}</code></> : null}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isDownloaded && (
            <button
              type="button"
              onClick={handleInstall}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 inline-flex items-center gap-2"
            >
              <Download size={14} />
              Restart &amp; install
            </button>
          )}
          {(status === "available" || (status === "error" && state?.latestVersion)) && !isDownloaded && (
            <button
              type="button"
              onClick={handleDownload}
              disabled={busy || isDownloading}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-2"
            >
              {isDownloading ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Download size={13} />
              )}
              {isDownloading
                ? `Downloading${state?.downloadProgress != null ? ` ${state.downloadProgress}%` : "…"}`
                : status === "error"
                  ? "Retry download"
                  : "Download now"}
            </button>
          )}
          <button
            type="button"
            onClick={handleCheck}
            disabled={isChecking || isDownloading}
            className="h-9 px-4 rounded-md border border-border bg-background text-sm font-semibold hover:bg-secondary disabled:opacity-50 inline-flex items-center gap-2"
          >
            {isChecking ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RefreshCcw size={13} />
            )}
            {isChecking ? "Checking…" : "Check for updates"}
          </button>
        </div>
      </div>
      {status === "error" && state?.error && (
        <div className="text-[11px] rounded-md px-3 py-2 bg-destructive/10 text-destructive">
          {state.error}
        </div>
      )}
      {isDownloading && state?.downloadProgress != null && (
        <div className="w-full h-1.5 rounded-full bg-secondary overflow-hidden">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${state.downloadProgress}%` }}
          />
        </div>
      )}
      {isDownloaded && state?.releaseNotes && (
        <div className="rounded-md border border-border bg-background px-4 py-3 space-y-1">
          <div className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">
            Release notes
          </div>
          <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
            {state.releaseNotes}
          </p>
        </div>
      )}
    </div>
  );
}

function DesktopInstallerPanel() {
  const queryClient = useQueryClient();
  const [urlInput, setUrlInput] = useState<string>("");
  const [versionInput, setVersionInput] = useState<string>("");
  const [releaseNotesInput, setReleaseNotesInput] = useState<string>("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [alertThresholdInput, setAlertThresholdInput] = useState<string>("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [importNotesLoading, setImportNotesLoading] = useState(false);
  const [importNotesError, setImportNotesError] = useState<string | null>(null);
  const [duplicatePrompt, setDuplicatePrompt] = useState<{
    file: File;
    message: string;
  } | null>(null);
  const [uploadConfirmPending, setUploadConfirmPending] = useState<File | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  // Desktop build trigger state
  const [buildTriggerError, setBuildTriggerError] = useState<string | null>(null);
  const [buildTriggerSuccess, setBuildTriggerSuccess] = useState(false);
  const [buildTriggerTimestamp, setBuildTriggerTimestamp] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["admin", "desktop-installer"],
    queryFn: () => apiFetch<DesktopInstallerInfo>("/admin/settings/desktop-installer"),
  });

  const interruptionStatsQuery = useQuery({
    queryKey: ["admin", "desktop-installer", "interruption-stats"],
    queryFn: () =>
      apiFetch<{ count24h: number; retryFailCount24h: number; lastOccurredAt: string | null }>(
        "/admin/desktop-installer/interruption-stats",
      ),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });

  useEffect(() => {
    if (query.data) {
      setUrlInput(query.data.downloadUrl);
      setVersionInput(query.data.version);
      setReleaseNotesInput(query.data.releaseNotes ?? "");
      setAlertThresholdInput(String(query.data.downloadInterruptionAlertThreshold));
    }
  }, [query.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean; downloadUrl: string }>("/admin/settings/desktop-installer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          downloadUrl: urlInput.trim(),
          version: versionInput.trim(),
          releaseNotes: releaseNotesInput.trim() || null,
          downloadInterruptionAlertThreshold: (() => {
            const v = parseInt(alertThresholdInput.trim(), 10);
            return Number.isFinite(v) && v > 0 ? v : undefined;
          })(),
        }),
      }),
    onSuccess: () => {
      setSaveError(null);
      setSaveSuccess(true);
      queryClient.invalidateQueries({ queryKey: ["admin", "desktop-installer"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "desktop-installer", "history"] });
      setTimeout(() => setSaveSuccess(false), 2500);
    },
    onError: (err: Error) => {
      setSaveSuccess(false);
      setSaveError(err.message || "Failed to save installer settings.");
    },
  });

  const resetMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean }>("/admin/settings/desktop-installer", { method: "DELETE" }),
    onSuccess: () => {
      setSaveError(null);
      setSaveSuccess(false);
      queryClient.invalidateQueries({ queryKey: ["admin", "desktop-installer"] });
    },
    onError: (err: Error) => {
      setSaveError(err.message || "Failed to reset installer settings.");
    },
  });

  const dismissBuildCounterWarningMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean }>(
        "/admin/settings/desktop-installer/build-counter-warning",
        { method: "DELETE" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "desktop-installer"] });
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ file, force }: { file: File; force?: boolean }) => {
      const fd = new FormData();
      fd.append("file", file);
      const path = force
        ? "/admin/desktop-installer/upload?force=1"
        : "/admin/desktop-installer/upload";
      return apiFetch<{ success: boolean; installerObject: { size: number; uploadedAt: string } }>(
        path,
        { method: "POST", body: fd },
      );
    },
    onSuccess: () => {
      setUploadError(null);
      setUploadSuccess(true);
      setDuplicatePrompt(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "desktop-installer"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "desktop-installer", "uploads"] });
      setTimeout(() => setUploadSuccess(false), 3000);
    },
    onError: (err: Error, variables) => {
      setUploadSuccess(false);
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.body &&
        typeof err.body === "object" &&
        (err.body as { code?: unknown }).code === "duplicate_installer" &&
        !variables.force
      ) {
        setUploadError(null);
        setDuplicatePrompt({ file: variables.file, message: err.message });
        return;
      }
      setUploadError(err.message || "Failed to upload installer.");
    },
  });

  const buildTriggerMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean; trigger: DesktopInstallerInfo["lastDesktopBuildTrigger"]; apiBaseUrl: string }>(
        "/admin/desktop-build/trigger",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
      ),
    onSuccess: () => {
      const ts = new Date().toISOString();
      setBuildTriggerError(null);
      setBuildTriggerSuccess(true);
      setBuildTriggerTimestamp(ts);
      queryClient.invalidateQueries({ queryKey: ["admin", "desktop-installer"] });
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["admin", "desktop-build-status"] });
      }, 5_000);
      setTimeout(() => setBuildTriggerSuccess(false), 4000);
    },
    onError: (err: Error) => {
      setBuildTriggerSuccess(false);
      setBuildTriggerError(err.message || "Failed to trigger build.");
    },
  });

  const buildStatusQuery = useQuery({
    queryKey: ["admin", "desktop-build-status"],
    queryFn: () => apiFetch<DesktopBuildStatus>("/admin/desktop-build/status"),
    enabled: !!(query.data?.tokenConfigured && query.data?.repoOwner && query.data?.repoName),
    refetchInterval: (q) => {
      if (!buildTriggerTimestamp) return false;
      const run = q.state.data?.run;
      if (!run) return 30_000;
      if (new Date(run.createdAt) >= new Date(buildTriggerTimestamp) && run.status === "completed") return false;
      return 30_000;
    },
  });

  useEffect(() => {
    if (!buildTriggerTimestamp) return;
    const run = buildStatusQuery.data?.run;
    if (!run) return;
    if (new Date(run.createdAt) >= new Date(buildTriggerTimestamp) && run.status === "completed") {
      setBuildTriggerTimestamp(null);
    }
  }, [buildTriggerTimestamp, buildStatusQuery.data]);

  const isBuildPolling = buildTriggerTimestamp !== null;

  function handleUploadButtonClick() {
    setUploadError(null);
    setUploadSuccess(false);
    uploadInputRef.current?.click();
  }

  function handleUploadInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!/\.(zip|exe|dmg)$/i.test(file.name)) {
      setUploadError(
        "Pick a .zip (LabTrax-Windows-Portable.zip), .exe (LabTrax-Setup.exe), or .dmg (LabTrax.dmg) file.",
      );
      return;
    }
    setDuplicatePrompt(null);
    setUploadConfirmPending(file);
  }

  const gate = usePlatformAdminGate([
    query.error,
    saveMutation.error,
    uploadMutation.error,
    resetMutation.error,
  ]);

  const info = query.data;
  // Convert relative /downloads/… paths to absolute URLs so the link works in
  // the Electron renderer (origin is app://labtrax, not the API host).
  const absDownloadUrl = info?.downloadUrl
    ? info.downloadUrl.startsWith("/")
      ? `${getApiOrigin() || (typeof window !== "undefined" ? window.location.origin : "")}${info.downloadUrl}`
      : info.downloadUrl
    : "";
  const isExe = info?.downloadUrl.toLowerCase().endsWith(".exe") ?? false;
  const isDmg = info?.downloadUrl.toLowerCase().endsWith(".dmg") ?? false;
  const isZip = info?.downloadUrl.toLowerCase().endsWith(".zip") ?? (!isExe && !isDmg);
  const hasDbOverrides = info !== undefined && (info.dbDownloadUrl !== null || info.dbVersion !== null || info.dbReleaseNotes !== null);

  const hasChanges =
    !!info &&
    (urlInput.trim() !== info.downloadUrl ||
      versionInput.trim() !== info.version ||
      (releaseNotesInput.trim() || null) !== info.releaseNotes ||
      (() => {
        const v = parseInt(alertThresholdInput.trim(), 10);
        return Number.isFinite(v) && v > 0 && v !== info.downloadInterruptionAlertThreshold;
      })());

  return (
    <PanelShell
      title="Desktop app"
      subtitle={
        isDmg
          ? "Download and distribute LabTrax Desktop to staff Mac machines."
          : "Download and distribute LabTrax Desktop to staff Windows machines."
      }
    >
      {gate.blocked && <PlatformAdminSetupNotice />}
      {query.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          Loading…
        </div>
      )}
      {query.error && !gate.blocked && (
        <Alert tone="danger">{(query.error as Error).message}</Alert>
      )}
      {info && (
        <div className="space-y-5">
          <AppVersionCard />
          {info.repoUrlWarning && (
            <Alert tone="warning">{info.repoUrlWarning}</Alert>
          )}
          {info.buildCounterWarning && (
            <div className="rounded-lg border border-amber-400/50 bg-amber-500/10 px-4 py-3 space-y-2">
              <div className="flex items-start gap-2">
                <svg
                  className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5"
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                </svg>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                    Build counter may be out of sync
                  </div>
                  <p className="text-xs text-amber-700/80 dark:text-amber-400/80 mt-0.5 leading-relaxed">
                    A recent CI build
                    {info.buildCounterWarning.attemptedBuildNumber !== null
                      ? ` (build #${info.buildCounterWarning.attemptedBuildNumber})`
                      : ""}
                    {info.buildCounterWarning.workflowName
                      ? ` from "${info.buildCounterWarning.workflowName}"`
                      : ""}
                    {" "}
                    failed to push the updated <code className="font-mono bg-amber-500/15 px-1 py-0.5 rounded">build-number.json</code> to the repo.
                    The next build may reuse the same number. Apply the fallback artifact to fix this.
                  </p>
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    {info.repoUrl ? (
                      <a
                        href={`${info.repoUrl.replace(/\/$/, "")}/blob/main/docs/build-counter-recovery.md`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium text-amber-700 dark:text-amber-400 underline underline-offset-2 hover:no-underline"
                      >
                        Recovery guide
                      </a>
                    ) : (
                      <details className="w-full">
                        <summary className="text-xs font-medium text-amber-700 dark:text-amber-400 underline underline-offset-2 hover:no-underline cursor-pointer list-none">
                          Recovery guide
                        </summary>
                        <ol className="mt-2 text-xs text-amber-700/80 dark:text-amber-400/80 space-y-1 leading-relaxed border-t border-amber-400/30 pt-2 list-decimal list-inside">
                          <li>Open the failed GitHub Actions run and download the <code className="font-mono bg-amber-500/15 px-1 py-0.5 rounded">build-counter-fallback</code> artifact.</li>
                          <li>Extract the zip and find the <code className="font-mono bg-amber-500/15 px-1 py-0.5 rounded">buildNumber</code> value in <code className="font-mono bg-amber-500/15 px-1 py-0.5 rounded">build-number.json</code>.</li>
                          <li>Paste that number into the Build counter recovery field below and click <strong>Apply counter</strong>.</li>
                        </ol>
                      </details>
                    )}
                    {info.buildCounterWarning.runUrl && (
                      <a
                        href={info.buildCounterWarning.runUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium text-amber-700 dark:text-amber-400 underline underline-offset-2 hover:no-underline"
                      >
                        View failed run
                        {info.buildCounterWarning.runId
                          ? ` #${info.buildCounterWarning.runId}`
                          : ""}
                      </a>
                    )}
                    {info.buildCounterWarning.ref && (
                      <span className="text-[11px] text-amber-600/70 dark:text-amber-400/60">
                        branch: {info.buildCounterWarning.ref}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => dismissBuildCounterWarningMutation.mutate()}
                      disabled={dismissBuildCounterWarningMutation.isPending}
                      className="ml-auto text-xs font-medium text-amber-700 dark:text-amber-400 underline underline-offset-2 hover:no-underline disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {dismissBuildCounterWarningMutation.isPending ? "Dismissing…" : "Mark as resolved"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
          {info.urlError ? (
            <Alert tone="danger">
              Current download URL is invalid: {info.urlError} Use the field below to fix it.
            </Alert>
          ) : (
            <div className="rounded-lg border border-border bg-secondary/30 px-5 py-4 space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="text-sm font-semibold">{isDmg ? "LabTrax Desktop for Mac" : "LabTrax Desktop for Windows"}</div>
                    <InstallerStatusBadge status={info.installerStatus} />
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Version {info.version} · {info.fileName}
                  </div>
                </div>
                {info.installerStatus === "missing" || info.installerStatus === "unknown" ? (
                  <button
                    type="button"
                    disabled
                    title={info.installerStatusMessage ?? "Installer file not uploaded — use the upload control below."}
                    className="h-9 px-4 rounded-md bg-primary/40 text-primary-foreground/70 text-sm font-semibold cursor-not-allowed inline-flex items-center gap-2 shrink-0"
                  >
                    <Download size={14} />
                    {isZip ? "Download Portable ZIP" : isDmg ? "Download macOS DMG" : "Download Installer"}
                  </button>
                ) : (
                  <a
                    href={absDownloadUrl}
                    download
                    className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 inline-flex items-center gap-2 shrink-0"
                  >
                    <Download size={14} />
                    {isZip ? "Download Portable ZIP" : isDmg ? "Download macOS DMG" : "Download Installer"}
                  </a>
                )}
              </div>
              {info.installerStatusMessage && info.installerStatus !== "ok" && (
                <div
                  className={`text-[12px] rounded-md px-3 py-2 ${
                    info.installerStatus === "missing" || info.installerStatus === "unknown"
                      ? "bg-destructive/10 text-destructive"
                      : info.installerStatus === "stale"
                        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                        : "bg-secondary text-muted-foreground"
                  }`}
                >
                  {info.installerStatusMessage}
                </div>
              )}
              <div className="text-[11px] text-muted-foreground">
                {info.installerObject ? (
                  <>
                    Current installer: {formatInstallerSize(info.installerObject.size)} · uploaded{" "}
                    {formatInstallerTimestamp(info.installerObject.uploadedAt)}
                  </>
                ) : info.installerStatus === "external" ? (
                  <>External download — file is hosted outside App Storage.</>
                ) : (
                  <span className="text-amber-600 dark:text-amber-400">
                    No {isExe ? "installer" : isDmg ? "macOS installer" : "portable zip"} has been uploaded to App Storage yet — the download link will return 404 until an admin uploads <code className="font-mono bg-secondary px-1 py-0.5 rounded">{isExe ? "LabTrax-Setup.exe" : isDmg ? "LabTrax.dmg" : "LabTrax-Windows-Portable.zip"}</code> below.
                  </span>
                )}
              </div>
              {(() => {
                const stats = interruptionStatsQuery.data;
                if (!stats) return null;
                const threshold = info.downloadInterruptionAlertThreshold;
                const isAlert = stats.retryFailCount24h >= threshold;
                const hasAny = stats.count24h > 0;
                return (
                  <div
                    className={`text-[11px] rounded-md px-3 py-2 flex items-center gap-2 flex-wrap ${
                      isAlert
                        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                        : "bg-secondary/60 text-muted-foreground"
                    }`}
                  >
                    <span className="font-medium shrink-0">Last 24 h:</span>
                    {hasAny ? (
                      <>
                        <span>
                          {stats.count24h} interruption{stats.count24h !== 1 ? "s" : ""}
                          {stats.retryFailCount24h > 0 && (
                            <> · <span className={isAlert ? "font-semibold" : ""}>{stats.retryFailCount24h} retry failure{stats.retryFailCount24h !== 1 ? "s" : ""}</span></>
                          )}
                        </span>
                        {stats.lastOccurredAt && (
                          <span className="text-muted-foreground">
                            · last {new Date(stats.lastOccurredAt).toLocaleString()}
                          </span>
                        )}
                        {isAlert && (
                          <span className="font-semibold">
                            ⚠ Retry failures at or above alert threshold ({threshold})
                          </span>
                        )}
                      </>
                    ) : (
                      <span>no interruptions</span>
                    )}
                  </div>
                );
              })()}
              {info.releaseNotes && (
                <div className="rounded-md border border-border bg-background px-4 py-3 space-y-1">
                  <div className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">
                    Release notes
                  </div>
                  <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                    {info.releaseNotes}
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="rounded-lg border border-border px-5 py-4 space-y-3">
            <div className="text-sm font-semibold">Download URL, Version &amp; Release Notes</div>
            <p className="text-xs text-muted-foreground">
              Paste the GitHub Release asset URL (or a <code className="font-mono bg-secondary px-1 py-0.5 rounded">/downloads/</code> path) here after each build.
              Must start with <code className="font-mono bg-secondary px-1 py-0.5 rounded">https://</code> or <code className="font-mono bg-secondary px-1 py-0.5 rounded">/downloads/</code>.
            </p>
            {saveError && <Alert tone="danger">{saveError}</Alert>}
            {saveSuccess && <Alert tone="success">Settings saved.</Alert>}
            <div className="flex gap-2 items-start">
              <input
                className={`${inputCls} flex-1`}
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://github.com/…/releases/download/…/LabTrax-Setup.exe"
              />
              <input
                className={`${inputCls} w-28 shrink-0`}
                type="text"
                value={versionInput}
                onChange={(e) => setVersionInput(e.target.value)}
                placeholder="1.0.0"
                aria-label="Version"
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs font-medium text-muted-foreground shrink-0">
                Alert after
              </label>
              <input
                className={`${inputCls} w-20 shrink-0`}
                type="number"
                min={1}
                max={1000}
                step={1}
                value={alertThresholdInput}
                onChange={(e) => setAlertThresholdInput(e.target.value)}
                aria-label="Alert threshold: number of retry failures in 24 h"
              />
              <span className="text-xs text-muted-foreground">
                retry failure{alertThresholdInput === "1" ? "" : "s"} in 24 h
                {info && info.downloadInterruptionAlertThresholdSource === "env" && (
                  <span className="ml-1.5 text-[11px] text-muted-foreground/70">
                    (env default: {info.envDownloadInterruptionAlertThreshold})
                  </span>
                )}
              </span>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-muted-foreground">
                  Release notes <span className="font-normal">(optional)</span>
                </label>
                <button
                  type="button"
                  disabled={importNotesLoading || !versionInput.trim()}
                  title={!versionInput.trim() ? "Enter a version number first" : `Import notes for v${versionInput.trim()} from RELEASE_NOTES.md`}
                  onClick={async () => {
                    const ver = versionInput.trim();
                    if (!ver) return;
                    setImportNotesLoading(true);
                    setImportNotesError(null);
                    try {
                      const result = await apiFetch<{ version: string; notes: string | null }>(
                        `/admin/settings/desktop-installer/release-notes-file?version=${encodeURIComponent(ver)}`,
                      );
                      if (result.notes) {
                        setReleaseNotesInput(result.notes);
                      } else {
                        setImportNotesError(`No entry for ${result.version} found in RELEASE_NOTES.md.`);
                      }
                    } catch (err) {
                      setImportNotesError(
                        err instanceof Error ? err.message : "Could not load RELEASE_NOTES.md.",
                      );
                    } finally {
                      setImportNotesLoading(false);
                    }
                  }}
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {importNotesLoading ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <FileDown size={11} />
                  )}
                  Import from RELEASE_NOTES.md
                </button>
              </div>
              {importNotesError && (
                <p className="text-[11px] text-destructive">{importNotesError}</p>
              )}
              <textarea
                className="w-full px-2.5 py-2 rounded-md bg-background border border-input text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                rows={3}
                value={releaseNotesInput}
                onChange={(e) => setReleaseNotesInput(e.target.value)}
                placeholder="e.g. v1.2.0 — fixed PDF print crash, improved startup time"
                maxLength={1000}
              />
              <p className="text-[11px] text-muted-foreground text-right">
                {releaseNotesInput.length}/1000
              </p>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                {hasDbOverrides ? (
                  <button
                    type="button"
                    onClick={() => resetMutation.mutate()}
                    disabled={resetMutation.isPending || saveMutation.isPending}
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-60"
                  >
                    {resetMutation.isPending ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <RotateCcw size={11} />
                    )}
                    Reset to env defaults (v{info.envVersion} · {info.envDownloadUrl.split("/").pop()})
                  </button>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    Using env defaults: v{info.envVersion} · <code className="font-mono bg-secondary px-0.5 rounded">{info.envDownloadUrl}</code>
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending || resetMutation.isPending || !urlInput.trim() || !hasChanges}
                className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 shrink-0 inline-flex items-center gap-1.5"
              >
                {saveMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : null}
                Save
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-border px-5 py-4 space-y-3">
            <div className="text-sm font-semibold">Upload a refreshed installer</div>
            <p className="text-xs text-muted-foreground">
              After a fresh electron build, upload one of the Windows installers —{" "}
              the one-click{" "}
              <code className="font-mono bg-secondary px-1 py-0.5 rounded">LabTrax-Setup.exe</code>{" "}
              or the portable{" "}
              <code className="font-mono bg-secondary px-1 py-0.5 rounded">LabTrax-Windows-Portable.zip</code>{" "}
              — or the macOS{" "}
              <code className="font-mono bg-secondary px-1 py-0.5 rounded">LabTrax.dmg</code>.
              The file is stored in App Storage and served at the matching{" "}
              <code className="font-mono bg-secondary px-1 py-0.5 rounded">/downloads/</code>{" "}
              URL without any redeploy. Max size 300 MB. Remember to update the
              <em> Download URL</em> above to match.
            </p>
            {uploadError && <Alert tone="danger">{uploadError}</Alert>}
            {uploadSuccess && <Alert tone="success">Installer uploaded.</Alert>}
            <div className="flex items-center gap-3">
              <input
                ref={uploadInputRef}
                type="file"
                accept=".zip,application/zip,.exe,application/vnd.microsoft.portable-executable,application/x-msdownload,.dmg,application/x-apple-diskimage"
                className="hidden"
                onChange={handleUploadInputChange}
              />
              <button
                type="button"
                onClick={handleUploadButtonClick}
                disabled={uploadMutation.isPending}
                className="h-9 px-4 rounded-md border border-border text-sm font-semibold hover:bg-secondary/40 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {uploadMutation.isPending ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Upload size={13} />
                )}
                {uploadMutation.isPending ? "Uploading…" : "Choose ZIP, EXE, or DMG and upload"}
              </button>
              {info.installerObject && (
                <span className="text-[11px] text-muted-foreground">
                  Replaces the current {formatInstallerSize(info.installerObject.size)} file.
                </span>
              )}
            </div>
          </div>

          <AlertDialog
            open={uploadConfirmPending !== null}
            onOpenChange={(open) => {
              if (!open) setUploadConfirmPending(null);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Upload installer?</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-2 text-sm">
                    {(() => {
                      const liveVersion = info?.version ?? null;
                      const newVersion = uploadConfirmPending
                        ? parseVersionFromFilename(uploadConfirmPending.name)
                        : null;
                      const isDowngrade =
                        liveVersion &&
                        newVersion &&
                        compareVersions(newVersion, liveVersion) < 0;
                      return isDowngrade ? (
                        <div className="flex items-start gap-2 rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-amber-800 dark:text-amber-300">
                          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                          <span className="text-xs font-medium leading-snug">
                            Downgrade warning — you are about to replace{" "}
                            <strong>v{liveVersion}</strong> with{" "}
                            <strong>v{newVersion}</strong>. Users who have already
                            updated will be prompted to "downgrade". Proceed only
                            if this is intentional.
                          </span>
                        </div>
                      ) : null;
                    })()}
                    <p>
                      This will replace the live installer that all users download. Review the details below before continuing.
                    </p>
                    <div className="rounded-md border border-border bg-secondary/40 px-4 py-3 space-y-1 text-xs font-mono">
                      <div>
                        <span className="text-muted-foreground">File:&nbsp;</span>
                        <span className="font-semibold break-all">{uploadConfirmPending?.name}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Size:&nbsp;</span>
                        <span>{uploadConfirmPending ? formatInstallerSize(uploadConfirmPending.size) : "—"}</span>
                      </div>
                      {uploadConfirmPending && parseVersionFromFilename(uploadConfirmPending.name) && (
                        <div>
                          <span className="text-muted-foreground">New version:&nbsp;</span>
                          <span>{parseVersionFromFilename(uploadConfirmPending.name)}</span>
                        </div>
                      )}
                      <div>
                        <span className="text-muted-foreground">Current version:&nbsp;</span>
                        <span>{info?.version ?? "—"}</span>
                      </div>
                      {info?.installerObject && (
                        <div>
                          <span className="text-muted-foreground">Current size:&nbsp;</span>
                          <span>{formatInstallerSize(info.installerObject.size)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setUploadConfirmPending(null)}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    const file = uploadConfirmPending;
                    setUploadConfirmPending(null);
                    if (file) uploadMutation.mutate({ file });
                  }}
                >
                  Upload
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog
            open={duplicatePrompt !== null}
            onOpenChange={(open) => {
              if (!open) setDuplicatePrompt(null);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Upload the same file again?</AlertDialogTitle>
                <AlertDialogDescription>
                  {duplicatePrompt?.message ??
                    "This is the same file as your previous upload — did you forget to rebuild?"}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setDuplicatePrompt(null)}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    if (duplicatePrompt) {
                      const { file } = duplicatePrompt;
                      setDuplicatePrompt(null);
                      uploadMutation.mutate({ file, force: true });
                    }
                  }}
                >
                  Upload anyway
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <div className="rounded-lg border border-border px-5 py-4 space-y-3">
            <div className="text-sm font-semibold">
              {isZip ? "How to install (portable ZIP)" : isDmg ? "How to install (macOS)" : "How to install"}
            </div>
            {isDmg ? (
              <ol className="space-y-2 text-sm text-muted-foreground list-none">
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">1</span>
                  <span>Download <strong>LabTrax.dmg</strong> using the button above.</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">2</span>
                  <span>Double-click the downloaded <code className="font-mono bg-secondary px-1 py-0.5 rounded text-xs">.dmg</code> file to mount the disk image.</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">3</span>
                  <span>Drag the <strong>LabTrax</strong> icon into the <strong>Applications</strong> folder, then launch LabTrax from Applications or Spotlight.</span>
                </li>
              </ol>
            ) : isZip ? (
              <ol className="space-y-2 text-sm text-muted-foreground list-none">
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">1</span>
                  <span>Download <strong>LabTrax-Windows-Portable.zip</strong> using the button above.</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">2</span>
                  <span>Right-click the ZIP and choose <strong>Extract All…</strong> — make sure to extract the entire folder, not just the <code className="font-mono bg-secondary px-1 py-0.5 rounded text-xs">LabTrax.exe</code> file on its own.</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">3</span>
                  <span>Open the extracted <strong>LabTrax</strong> folder and run <code className="font-mono bg-secondary px-1 py-0.5 rounded text-xs">LabTrax.exe</code> from inside it.</span>
                </li>
              </ol>
            ) : (
              <ol className="space-y-2 text-sm text-muted-foreground list-none">
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">1</span>
                  <span>Download the installer using the button above.</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">2</span>
                  <span>Double-click the downloaded <code className="font-mono bg-secondary px-1 py-0.5 rounded text-xs">.exe</code> file to launch the setup wizard.</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">3</span>
                  <span>Follow the on-screen steps. LabTrax Desktop will be installed and a shortcut placed on the Desktop.</span>
                </li>
              </ol>
            )}
          </div>

          <div className="rounded-lg border border-border bg-secondary/20 px-5 py-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Package size={14} />
                Build &amp; publish installer
              </div>
              {info.repoUrl && (
                <a
                  href={`${info.repoUrl.replace(/\/$/, "")}/actions`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border bg-background text-xs font-semibold hover:bg-secondary shrink-0"
                >
                  <Github size={12} />
                  Open GitHub Actions
                  <ExternalLink size={10} className="text-muted-foreground" />
                </a>
              )}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Trigger the <strong>Build Windows Installer (Test)</strong> workflow from GitHub Actions. When the
              {" "}<code className="font-mono bg-secondary px-1 py-0.5 rounded">PLATFORM_ADMIN_SECRET</code> and{" "}
              <code className="font-mono bg-secondary px-1 py-0.5 rounded">PUBLISH_API_BASE_URL</code> secrets are
              configured in your repo, the built installer is automatically published to the live download page — no manual upload needed.
            </p>

            {/* Trigger button — shown when token + repo are configured; falls back to the Actions link otherwise */}
            {info.tokenConfigured && info.repoOwner && info.repoName ? (
              <div className="space-y-3">
                {buildTriggerError && <Alert tone="danger">{buildTriggerError}</Alert>}
                {buildTriggerSuccess && (
                  <Alert tone="success">
                    Build triggered — the <strong>Build Windows Installer (Test)</strong> workflow is now queued on GitHub Actions. Status will update automatically below.
                  </Alert>
                )}
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setBuildTriggerError(null);
                      setBuildTriggerSuccess(false);
                      buildTriggerMutation.mutate();
                    }}
                    disabled={buildTriggerMutation.isPending}
                    className="inline-flex items-center gap-2 h-8 px-4 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-60"
                  >
                    {buildTriggerMutation.isPending ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Play size={13} />
                    )}
                    {buildTriggerMutation.isPending ? "Triggering…" : "Trigger build"}
                  </button>
                  {info.lastDesktopBuildTrigger && (
                    <span className="text-[11px] text-muted-foreground">
                      Last triggered{" "}
                      {new Date(info.lastDesktopBuildTrigger.triggeredAt).toLocaleString()}{" "}
                      by {info.lastDesktopBuildTrigger.triggeredByUsername}
                    </span>
                  )}
                </div>

                {/* Live run status */}
                {buildStatusQuery.data !== undefined && (
                  <div className="rounded-md border border-border bg-background px-4 py-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Latest build run</div>
                      <button
                        type="button"
                        onClick={() => queryClient.invalidateQueries({ queryKey: ["admin", "desktop-build-status"] })}
                        disabled={buildStatusQuery.isFetching}
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                      >
                        <RefreshCcw size={11} className={buildStatusQuery.isFetching ? "animate-spin" : ""} />
                        Refresh
                      </button>
                    </div>
                    {buildStatusQuery.data.run ? (
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <BuildStatusBadge run={{
                            ...buildStatusQuery.data.run,
                            htmlUrl: buildStatusQuery.data.run.htmlUrl,
                          }} />
                          {isBuildPolling && buildStatusQuery.data.run.status !== "completed" && (
                            <span className="text-[11px] text-muted-foreground">Auto-refreshing every 30 s…</span>
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          <Clock size={11} className="inline mr-1 -mt-px" />
                          Started {new Date(buildStatusQuery.data.run.createdAt).toLocaleString()}
                          {buildStatusQuery.data.run.status === "completed" && (
                            <> · Updated {new Date(buildStatusQuery.data.run.updatedAt).toLocaleString()}</>
                          )}
                        </div>
                      </div>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">No runs found for <code className="font-mono">build-windows.yml</code>.</p>
                    )}
                  </div>
                )}
                {buildStatusQuery.isLoading && (
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Loader2 size={11} className="animate-spin" />
                    Loading run status…
                  </div>
                )}
              </div>
            ) : (
              /* Fallback: no token or repo — explain what needs to be set up */
              <div className="space-y-2">
                {!info.repoUrl && (
                  <p className="text-[11px] text-muted-foreground">
                    Set <code className="font-mono bg-secondary px-1 rounded">GITHUB_REPO_URL</code> to your repository URL to enable in-app build triggering.
                  </p>
                )}
                {info.repoUrl && !info.tokenConfigured && (
                  <p className="text-[11px] text-muted-foreground">
                    Set <code className="font-mono bg-secondary px-1 rounded">GITHUB_ACTIONS_TOKEN</code> (a fine-grained PAT with <em>Actions: Read and write</em> access) to enable in-app build triggering.
                  </p>
                )}
              </div>
            )}

            {(info.installerStatus === "missing" || info.installerStatus === "unknown") && (
              <div className="rounded-md border border-blue-300/60 bg-blue-50 dark:border-blue-800/40 dark:bg-blue-950/30 px-4 py-3 space-y-2">
                <div className="flex items-start gap-2">
                  <svg className="text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4" />
                    <path d="M12 8h.01" />
                  </svg>
                  <div>
                    <div className="text-xs font-semibold text-blue-800 dark:text-blue-300">One-time setup: add two secrets to your GitHub repo</div>
                    <p className="text-[11px] text-blue-700 dark:text-blue-400/90 mt-0.5 leading-relaxed">
                      For CI to auto-publish after each build, add these two Actions secrets under{" "}
                      <strong>Settings → Secrets and variables → Actions</strong> in your GitHub repo:
                    </p>
                    <dl className="mt-2 space-y-1.5 text-[11px]">
                      <div className="flex gap-2 items-start">
                        <dt className="font-mono bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300 px-1.5 py-0.5 rounded shrink-0 font-semibold">
                          PLATFORM_ADMIN_SECRET
                        </dt>
                        <dd className="text-blue-700 dark:text-blue-400/80 pt-0.5">
                          Must match the <code className="font-mono bg-blue-100 dark:bg-blue-900/40 px-1 rounded">PLATFORM_ADMIN_SECRET</code> env var set on this server.
                        </dd>
                      </div>
                      <div className="flex gap-2 items-start">
                        <dt className="font-mono bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300 px-1.5 py-0.5 rounded shrink-0 font-semibold">
                          PUBLISH_API_BASE_URL
                        </dt>
                        <dd className="text-blue-700 dark:text-blue-400/80 pt-0.5">
                          The public base URL of this server, e.g.{" "}
                          <code className="font-mono bg-blue-100 dark:bg-blue-900/40 px-1 rounded">https://your-app.replit.app</code>
                        </dd>
                      </div>
                    </dl>
                  </div>
                </div>
              </div>
            )}
          </div>

          <DesktopBuildCounterRecovery repoUrl={info.repoUrl} />
          <DesktopInstallerPipelineHealthPanel />
          <DesktopInstallerUploadsPanel />
          <DesktopInstallerHistoryPanel repoUrl={info.repoUrl} />
        </div>
      )}
    </PanelShell>
  );
}

// ── Pipeline Health card (Task #749) ─────────────────────────────────────────
//
// One-click end-to-end audit of the publish pipeline. Calls
// GET /admin/desktop-installer/health which folds the four independent
// probes (settings, storage, /downloads HEAD, GitHub Releases manifest)
// into a single JSON report. Surfacing this in-app means admins no longer
// have to grep server logs to figure out why "Download for Windows"
// returns a stale or broken file.

interface InstallerHealthSlotStatus {
  ok: boolean;
  size: number | null;
  uploadedAt: string | null;
  error: string | null;
}

interface InstallerHealthReport {
  ok: boolean;
  checkedAt: string;
  settings: { version: string | null; downloadUrl: string | null; activeKind: string | null; error: string | null };
  storage: { ok: boolean; size: number | null; uploadedAt: string | null; etag: string | null; error: string | null };
  storageSlots?: { zip: InstallerHealthSlotStatus; exe: InstallerHealthSlotStatus; dmg: InstallerHealthSlotStatus };
  download: {
    ok: boolean;
    checked: boolean;
    url: string | null;
    status: number | null;
    contentLength: number | null;
    etag: string | null;
    etagMatchesStorage: boolean | null;
    error: string | null;
  };
  downloadSpeed?: {
    checked: boolean;
    bytesPerSecond: number | null;
    estimatedSeconds: number | null;
    slow: boolean;
    error: string | null;
  };
  githubRelease: {
    ok: boolean;
    configured: boolean;
    tagName: string | null;
    publishedAt: string | null;
    manifestUrl: string | null;
    hasManifest: boolean;
    issue: string | null;
  };
  downloadInterruptions?: {
    count24h: number;
    retryFailCount24h: number;
    lastOccurredAt: string | null;
  };
  issues: string[];
}

function DesktopInstallerPipelineHealthPanel() {
  const [report, setReport] = useState<InstallerHealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runHealthCheck() {
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch<InstallerHealthReport>("/admin/desktop-installer/health");
      setReport(r);
    } catch (e: any) {
      setError(e?.message ?? "Failed to run health check.");
    } finally {
      setLoading(false);
    }
  }

  const StatusDot = ({ ok, label }: { ok: boolean | null; label: string }) => (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        marginRight: 12,
        fontSize: 13,
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 10,
          height: 10,
          borderRadius: 5,
          backgroundColor: ok === true ? "#16a34a" : ok === false ? "#dc2626" : "#9ca3af",
        }}
      />
      {label}
    </span>
  );

  return (
    <div style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, padding: 16, marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>Pipeline health</h3>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--muted, #6b7280)" }}>
            End-to-end audit: settings → App Storage → /downloads → GitHub Release manifest.
          </p>
        </div>
        <button onClick={runHealthCheck} disabled={loading} style={{ minWidth: 120 }}>
          {loading ? "Checking…" : report ? "Re-run" : "Run health check"}
        </button>
      </div>

      {error && (
        <div style={{ color: "#dc2626", fontSize: 13, marginTop: 8 }}>Error: {error}</div>
      )}

      {report && (
        <>
          <div style={{ marginTop: 12 }}>
            <StatusDot ok={!report.settings.error} label="Settings" />
            <StatusDot ok={report.storage.ok} label="App Storage" />
            <StatusDot ok={report.download.checked ? report.download.ok : null} label="Live /downloads HEAD" />
            <StatusDot
              ok={
                report.downloadSpeed?.checked
                  ? report.downloadSpeed.slow || report.downloadSpeed.error != null
                    ? false
                    : true
                  : null
              }
              label="Download speed"
            />
            <StatusDot
              ok={report.githubRelease.configured ? report.githubRelease.ok : null}
              label="GitHub Release"
            />
            {report.downloadInterruptions != null && (
              <StatusDot
                ok={report.downloadInterruptions.retryFailCount24h > 0 ? false : true}
                label={`Interruptions (24 h): ${report.downloadInterruptions.count24h}`}
              />
            )}
          </div>
          <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.5 }}>
            <div>
              <strong>Configured:</strong> {report.settings.version ?? "—"} →{" "}
              <code>{report.settings.downloadUrl ?? "—"}</code>
            </div>
            {report.storage.uploadedAt && (
              <div>
                <strong>Storage:</strong>{" "}
                {report.storage.size != null
                  ? `${(report.storage.size / 1_048_576).toFixed(1)} MB`
                  : "?"}
                , uploaded {new Date(report.storage.uploadedAt).toLocaleString()}
              </div>
            )}
            {report.storageSlots && (
              <div style={{ marginTop: 8 }}>
                <strong>Installer slots:</strong>
                <table style={{ marginTop: 4, borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "var(--muted, #6b7280)" }}>
                      <th style={{ paddingRight: 12, fontWeight: 500 }}>Kind</th>
                      <th style={{ paddingRight: 12, fontWeight: 500 }}>Status</th>
                      <th style={{ paddingRight: 12, fontWeight: 500 }}>Size</th>
                      <th style={{ fontWeight: 500 }}>Uploaded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(["zip", "exe", "dmg"] as const).map((kind) => {
                      const slot = report.storageSlots![kind];
                      return (
                        <tr key={kind}>
                          <td style={{ paddingRight: 12, fontFamily: "monospace" }}>{kind}</td>
                          <td style={{ paddingRight: 12, color: slot.ok ? "#16a34a" : "#dc2626" }}>
                            {slot.ok ? "✓ present" : "✗ missing"}
                          </td>
                          <td style={{ paddingRight: 12 }}>
                            {slot.size != null ? `${(slot.size / 1_048_576).toFixed(1)} MB` : "—"}
                          </td>
                          <td>
                            {slot.uploadedAt ? new Date(slot.uploadedAt).toLocaleString() : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {report.download.checked && (
              <div>
                <strong>Download HEAD:</strong> HTTP {report.download.status ?? "?"}
                {report.download.etagMatchesStorage === false && (
                  <span style={{ color: "#dc2626" }}> — ETag mismatch (stale copy?)</span>
                )}
              </div>
            )}
            {report.downloadSpeed?.checked && (
              <div style={{ marginTop: 2 }}>
                <strong>Download speed:</strong>{" "}
                {report.downloadSpeed.bytesPerSecond != null
                  ? `${(report.downloadSpeed.bytesPerSecond / 1_048_576).toFixed(2)} MB/s`
                  : "—"}
                {report.downloadSpeed.estimatedSeconds != null && (
                  <span style={{ marginLeft: 6, color: report.downloadSpeed.slow ? "#b45309" : "inherit" }}>
                    {`(est. ${report.downloadSpeed.estimatedSeconds < 60
                      ? `${Math.round(report.downloadSpeed.estimatedSeconds)}s`
                      : `${Math.round(report.downloadSpeed.estimatedSeconds / 60)} min`} total)`}
                    {report.downloadSpeed.slow && (
                      <span style={{ marginLeft: 6, fontWeight: 600 }}>
                        ⚠ Slow — may time out through proxy. Consider a GitHub Release URL.
                      </span>
                    )}
                  </span>
                )}
                {report.downloadSpeed.error && (
                  <span style={{ marginLeft: 6, color: "#6b7280" }}>({report.downloadSpeed.error})</span>
                )}
              </div>
            )}
            {report.githubRelease.configured && (
              <div>
                <strong>Latest Release:</strong> {report.githubRelease.tagName ?? "—"}
                {report.githubRelease.publishedAt && (
                  <> ({new Date(report.githubRelease.publishedAt).toLocaleDateString()})</>
                )}
                {!report.githubRelease.hasManifest && (
                  <span style={{ color: "#dc2626" }}> — no latest.yml/latest-mac.yml asset</span>
                )}
              </div>
            )}
            {report.downloadInterruptions != null && (
              <div style={{ marginTop: 4 }}>
                <strong>Download interruptions (24 h):</strong>{" "}
                {report.downloadInterruptions.count24h === 0 ? (
                  <span style={{ color: "#16a34a" }}>none</span>
                ) : (
                  <>
                    <span style={{ color: report.downloadInterruptions.retryFailCount24h > 0 ? "#dc2626" : "#b45309" }}>
                      {report.downloadInterruptions.count24h} total
                      {report.downloadInterruptions.retryFailCount24h > 0 && (
                        <>, {report.downloadInterruptions.retryFailCount24h} retry failure{report.downloadInterruptions.retryFailCount24h !== 1 ? "s" : ""}</>
                      )}
                    </span>
                    {report.downloadInterruptions.lastOccurredAt && (
                      <span style={{ marginLeft: 6, color: "var(--muted, #6b7280)" }}>
                        — last {new Date(report.downloadInterruptions.lastOccurredAt).toLocaleString()}
                      </span>
                    )}
                  </>
                )}
              </div>
            )}
            <div style={{ marginTop: 4, color: "var(--muted, #6b7280)", fontSize: 12 }}>
              Checked {new Date(report.checkedAt).toLocaleString()}
            </div>
          </div>
          {report.issues.length > 0 && (
            <ul style={{ marginTop: 12, paddingLeft: 20, color: "#b45309", fontSize: 13 }}>
              {report.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          )}
          {report.ok && (
            <div style={{ marginTop: 8, color: "#16a34a", fontSize: 13 }}>
              All probes healthy — pipeline is in sync.
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface InstallerUploadEntry {
  id: string;
  sizeBytes: number;
  version: string | null;
  checksumSha256: string | null;
  uploadedByUserId: string | null;
  uploadedByUsername: string | null;
  createdAt: string;
}

function ChecksumCell({ checksum }: { checksum: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!checksum) {
    return <span className="text-muted-foreground">—</span>;
  }
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(checksum);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard errors
    }
  };
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono" title={checksum}>
        {checksum.slice(0, 12)}
      </span>
      <button
        type="button"
        onClick={onCopy}
        className="text-muted-foreground hover:text-foreground transition-colors"
        title={copied ? "Copied!" : "Copy full SHA-256"}
        aria-label={copied ? "Checksum copied" : "Copy full SHA-256 checksum"}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}

function DesktopBuildCounterRecovery({ repoUrl }: { repoUrl: string | null }) {
  const queryClient = useQueryClient();
  const [buildNumberInput, setBuildNumberInput] = useState("");
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applySuccess, setApplySuccess] = useState<{ buildNumber: number; commitUrl: string | null } | null>(null);

  const applyMutation = useMutation({
    mutationFn: (buildNumber: number) =>
      apiFetch<{ ok: boolean; buildNumber: number; commitSha: string | null; commitUrl: string | null }>(
        "/admin/settings/build-counter",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: "desktop", buildNumber }),
        },
      ),
    onSuccess: (data) => {
      setApplyError(null);
      setApplySuccess({ buildNumber: data.buildNumber, commitUrl: data.commitUrl });
      setBuildNumberInput("");
      queryClient.invalidateQueries({ queryKey: ["admin", "desktop-installer"] });
      setTimeout(() => setApplySuccess(null), 8000);
    },
    onError: (err: Error) => {
      setApplySuccess(null);
      setApplyError(err.message || "Failed to apply build counter.");
    },
  });

  function handleApply() {
    const n = parseInt(buildNumberInput.trim(), 10);
    if (!buildNumberInput.trim() || Number.isNaN(n) || n < 1) {
      setApplyError("Enter a valid positive integer build number.");
      return;
    }
    setApplyError(null);
    setApplySuccess(null);
    applyMutation.mutate(n);
  }

  return (
    <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/40 dark:bg-amber-950/20 px-5 py-4 space-y-3">
      <div className="flex items-start gap-2">
        <RotateCcw size={14} className="mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
        <div>
          <div className="text-sm font-semibold">Build counter recovery</div>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            If a build workflow exited with a warning that the counter wasn't persisted, paste the <code className="font-mono bg-secondary px-0.5 rounded">buildNumber</code> from the <code className="font-mono bg-secondary px-0.5 rounded">build-counter-fallback</code> artifact here. The correct value is committed directly to <code className="font-mono bg-secondary px-0.5 rounded">main</code> via the GitHub API using <code className="font-mono bg-secondary px-0.5 rounded">BUILD_BOT_TOKEN</code> (or <code className="font-mono bg-secondary px-0.5 rounded">GITHUB_ACTIONS_TOKEN</code>) so the next build gets a higher number.
          </p>
        </div>
      </div>
      {applyError && <Alert tone="danger">{applyError}</Alert>}
      {applySuccess && (
        <Alert tone="success">
          Build counter set to <strong>{applySuccess.buildNumber}</strong> and committed to main.
          {applySuccess.commitUrl && (
            <>
              {" "}
              <a
                href={applySuccess.commitUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-medium"
              >
                View commit
              </a>
            </>
          )}
        </Alert>
      )}
      <div className="flex items-center gap-3">
        <input
          type="number"
          min={1}
          step={1}
          value={buildNumberInput}
          onChange={(e) => setBuildNumberInput(e.target.value)}
          placeholder="e.g. 42"
          className={`${inputCls} w-36 font-mono`}
          onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
        />
        <button
          type="button"
          onClick={handleApply}
          disabled={applyMutation.isPending || !buildNumberInput.trim()}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700 disabled:opacity-50"
        >
          {applyMutation.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <RotateCcw size={13} />
          )}
          {applyMutation.isPending ? "Applying…" : "Apply counter"}
        </button>
        {repoUrl && (
          <a
            href={`${repoUrl.replace(/\/$/, "")}/actions`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink size={11} />
            Actions
          </a>
        )}
      </div>
    </div>
  );
}

function DesktopInstallerUploadsPanel() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["admin", "desktop-installer", "uploads"],
    queryFn: () =>
      apiFetch<{ uploads: InstallerUploadEntry[] }>(
        "/admin/desktop-installer/uploads?limit=20",
      ),
    enabled: open,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ success: boolean }>(
        `/admin/desktop-installer/uploads/${id}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["admin", "desktop-installer", "uploads"],
      });
    },
  });

  const clearAllMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean; deletedCount: number }>(
        "/admin/desktop-installer/uploads",
        { method: "DELETE" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["admin", "desktop-installer", "uploads"],
      });
    },
  });

  const uploads = query.data?.uploads ?? [];
  const pendingDeleteId = deleteMutation.isPending
    ? (deleteMutation.variables as string | undefined)
    : undefined;

  return (
    <div className="rounded-lg border border-border px-5 py-4 space-y-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <History size={14} className="text-muted-foreground" />
          <div className="text-sm font-semibold">Recent uploads</div>
          <span className="text-xs text-muted-foreground">
            (last 20 zip uploads)
          </span>
        </div>
        {open ? (
          <ChevronDown size={14} className="text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="space-y-2">
          {query.isLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" />
              Loading uploads…
            </div>
          )}
          {query.error && (
            <Alert tone="danger">{(query.error as Error).message}</Alert>
          )}
          {!query.isLoading && !query.error && uploads.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No installer uploads yet. Each time an admin uploads a refreshed
              zip above, an entry will appear here.
            </p>
          )}
          {deleteMutation.error && (
            <Alert tone="danger">
              {(deleteMutation.error as Error).message}
            </Alert>
          )}
          {clearAllMutation.error && (
            <Alert tone="danger">
              {(clearAllMutation.error as Error).message}
            </Alert>
          )}
          {uploads.length > 0 && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  if (
                    !window.confirm(
                      "Clear ALL upload history entries? The uploaded zips themselves are not affected. This cannot be undone.",
                    )
                  ) {
                    return;
                  }
                  clearAllMutation.mutate();
                }}
                disabled={clearAllMutation.isPending}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-destructive hover:border-destructive disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Clear all upload history"
              >
                {clearAllMutation.isPending ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Trash2 size={11} />
                )}
                Clear all
              </button>
            </div>
          )}
          {uploads.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="font-medium py-2 pr-3">When</th>
                    <th className="font-medium py-2 pr-3">Version</th>
                    <th className="font-medium py-2 pr-3">Size</th>
                    <th className="font-medium py-2 pr-3">SHA-256</th>
                    <th className="font-medium py-2 pr-3">Uploaded by</th>
                    <th className="font-medium py-2 w-px"></th>
                  </tr>
                </thead>
                <tbody>
                  {uploads.map((u) => {
                    const isDeleting = pendingDeleteId === u.id;
                    return (
                      <tr key={u.id} className="border-b border-border/60 align-top">
                        <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                          {formatHistoryTimestamp(u.createdAt)}
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap font-mono">
                          {u.version ?? "—"}
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {formatInstallerSize(u.sizeBytes)}
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          <ChecksumCell checksum={u.checksumSha256} />
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {u.uploadedByUsername ?? (
                            <span className="text-muted-foreground">unknown</span>
                          )}
                        </td>
                        <td className="py-2 whitespace-nowrap text-right">
                          <button
                            type="button"
                            onClick={() => {
                              if (
                                !window.confirm(
                                  "Remove this upload entry from the history? The uploaded zip itself is not affected.",
                                )
                              ) {
                                return;
                              }
                              deleteMutation.mutate(u.id);
                            }}
                            disabled={isDeleting}
                            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-destructive hover:border-destructive disabled:opacity-50 disabled:cursor-not-allowed"
                            aria-label="Delete upload entry"
                          >
                            {isDeleting ? (
                              <Loader2 size={11} className="animate-spin" />
                            ) : (
                              <Trash2 size={11} />
                            )}
                            Delete
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface InstallerHistoryEntry {
  id: string;
  downloadUrl: string;
  version: string | null;
  releaseNotes: string | null;
  savedByUserId: string | null;
  savedByUsername: string | null;
  createdAt: string;
  source?: "ci" | "manual";
  ciMetadata?: {
    runId: string | null;
    commitSha: string | null;
    releaseTag: string | null;
  } | null;
}

function formatHistoryTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function DesktopInstallerHistoryPanel({ repoUrl }: { repoUrl: string | null }) {
  const [open, setOpen] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<"all" | "manual" | "ci">("all");
  const repoBase = repoUrl ? repoUrl.replace(/\/$/, "") : null;
  const query = useQuery({
    queryKey: ["admin", "desktop-installer", "history"],
    queryFn: () =>
      apiFetch<{ entries: InstallerHistoryEntry[] }>(
        "/admin/settings/desktop-installer/history?limit=20",
      ),
    enabled: open,
  });

  const allEntries = query.data?.entries ?? [];
  const entries =
    sourceFilter === "all"
      ? allEntries
      : allEntries.filter((e) => (e.source ?? "manual") === sourceFilter);
  const manualCount = allEntries.filter((e) => (e.source ?? "manual") === "manual").length;
  const ciCount = allEntries.filter((e) => e.source === "ci").length;

  const filterOptions: { value: "all" | "manual" | "ci"; label: string; count: number }[] = [
    { value: "all", label: "All", count: allEntries.length },
    { value: "manual", label: "Manual", count: manualCount },
    { value: "ci", label: "GitHub Actions", count: ciCount },
  ];

  return (
    <div className="rounded-lg border border-border px-5 py-4 space-y-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <History size={14} className="text-muted-foreground" />
          <div className="text-sm font-semibold">Change history</div>
          <span className="text-xs text-muted-foreground">
            (last 20 saves)
          </span>
        </div>
        {open ? (
          <ChevronDown size={14} className="text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="space-y-2">
          {query.isLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" />
              Loading history…
            </div>
          )}
          {query.error && (
            <Alert tone="danger">{(query.error as Error).message}</Alert>
          )}
          {!query.isLoading && !query.error && allEntries.length > 0 && (
            <div
              role="radiogroup"
              aria-label="Filter history by source"
              className="inline-flex rounded-md border border-border bg-muted/30 p-0.5 text-xs"
            >
              {filterOptions.map((opt) => {
                const active = sourceFilter === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setSourceFilter(opt.value)}
                    className={
                      "px-2.5 py-1 rounded-sm transition-colors " +
                      (active
                        ? "bg-background text-foreground shadow-sm font-medium"
                        : "text-muted-foreground hover:text-foreground")
                    }
                  >
                    {opt.label}
                    <span className="ml-1 text-muted-foreground">({opt.count})</span>
                  </button>
                );
              })}
            </div>
          )}
          {!query.isLoading && !query.error && allEntries.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No previous saves yet. Each time you save a new download URL, version, or release notes, a history entry will appear here.
            </p>
          )}
          {!query.isLoading && !query.error && allEntries.length > 0 && entries.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No {sourceFilter === "ci" ? "GitHub Actions" : "manual"} entries in the last {allEntries.length} saves.
            </p>
          )}
          {entries.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="font-medium py-2 pr-3">When</th>
                    <th className="font-medium py-2 pr-3">Version</th>
                    <th className="font-medium py-2 pr-3">Download URL</th>
                    <th className="font-medium py-2 pr-3">Release notes</th>
                    <th className="font-medium py-2">Saved by</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id} className="border-b border-border/60 align-top">
                      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                        {formatHistoryTimestamp(e.createdAt)}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap font-mono">
                        {e.version ?? "—"}
                      </td>
                      <td className="py-2 pr-3 max-w-[280px]">
                        <a
                          href={
                            e.downloadUrl.startsWith("/")
                              ? `${getApiOrigin() || (typeof window !== "undefined" ? window.location.origin : "")}${e.downloadUrl}`
                              : e.downloadUrl
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline break-all font-mono"
                        >
                          {e.downloadUrl}
                        </a>
                      </td>
                      <td className="py-2 pr-3 max-w-[260px]">
                        {e.releaseNotes ? (
                          <span className="whitespace-pre-wrap text-foreground">
                            {e.releaseNotes}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                        {e.source === "ci" && e.ciMetadata && (e.ciMetadata.runId || e.ciMetadata.commitSha || e.ciMetadata.releaseTag) && (
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                            {e.ciMetadata.releaseTag && (
                              <span>
                                Release:{" "}
                                {repoBase ? (
                                  <a
                                    href={`${repoBase}/releases/tag/${e.ciMetadata.releaseTag}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:underline font-mono"
                                  >
                                    {e.ciMetadata.releaseTag}
                                  </a>
                                ) : (
                                  <span className="font-mono">{e.ciMetadata.releaseTag}</span>
                                )}
                              </span>
                            )}
                            {e.ciMetadata.runId && (
                              <span>
                                Run:{" "}
                                {repoBase ? (
                                  <a
                                    href={`${repoBase}/actions/runs/${e.ciMetadata.runId}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:underline font-mono"
                                  >
                                    {e.ciMetadata.runId}
                                  </a>
                                ) : (
                                  <span className="font-mono">{e.ciMetadata.runId}</span>
                                )}
                              </span>
                            )}
                            {e.ciMetadata.commitSha && (
                              <span>
                                Commit:{" "}
                                {repoBase ? (
                                  <a
                                    href={`${repoBase}/commit/${e.ciMetadata.commitSha}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:underline font-mono"
                                  >
                                    {e.ciMetadata.commitSha.slice(0, 7)}
                                  </a>
                                ) : (
                                  <span className="font-mono">{e.ciMetadata.commitSha.slice(0, 7)}</span>
                                )}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="py-2 whitespace-nowrap">
                        {e.source === "ci" ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-foreground">
                            <Github size={11} />
                            GitHub Actions
                          </span>
                        ) : e.savedByUsername && e.savedByUsername !== "ci:platform-admin-secret" ? (
                          e.savedByUsername
                        ) : (
                          <span className="text-muted-foreground">unknown</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface MobileBuildInfo {
  iosBuildNumber: string | null;
  androidVersionCode: number | null;
  expoVersion: string | null;
  appJsonError: string | null;
  repoUrl: string | null;
  repoOwner: string | null;
  repoName: string | null;
  tokenConfigured: boolean;
  lastTrigger: {
    platform: string;
    profile: string;
    triggeredAt: string;
    triggeredByUsername: string;
  } | null;
  latestRun: {
    id: number;
    status: string;
    conclusion: string | null;
    html_url: string;
    created_at: string;
  } | null;
  versionHistory: {
    version: string;
    changedByUsername: string;
    changedAt: string;
  }[];
}

type BuildRunStatus = "pending" | "queued" | "running" | "success" | "failed" | "cancelled" | "unknown";

function getBuildRunStatus(run: MobileBuildInfo["latestRun"], hasTrigger: boolean): BuildRunStatus {
  if (!run) return hasTrigger ? "pending" : "unknown";
  if (run.status === "queued") return "queued";
  if (run.status === "in_progress") return "running";
  if (run.status === "completed") {
    if (run.conclusion === "success") return "success";
    if (run.conclusion === "cancelled") return "cancelled";
    return "failed";
  }
  return "unknown";
}

function isTerminalRunStatus(status: BuildRunStatus): boolean {
  return status === "success" || status === "failed" || status === "cancelled";
}

function BuildRunStatusBadge({ run, hasTrigger }: { run: MobileBuildInfo["latestRun"]; hasTrigger: boolean }) {
  const status = getBuildRunStatus(run, hasTrigger);
  const configs: Record<BuildRunStatus, { label: string; cls: string; icon: React.ReactNode }> = {
    pending: {
      label: "Pending",
      cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
      icon: <Loader2 size={11} className="shrink-0 animate-spin" />,
    },
    queued: {
      label: "Queued",
      cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
      icon: <Clock size={11} className="shrink-0" />,
    },
    running: {
      label: "Running",
      cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
      icon: <Loader2 size={11} className="shrink-0 animate-spin" />,
    },
    success: {
      label: "Success",
      cls: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
      icon: <Check size={11} className="shrink-0" />,
    },
    failed: {
      label: "Failed",
      cls: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
      icon: <RefreshCcw size={11} className="shrink-0" />,
    },
    cancelled: {
      label: "Cancelled",
      cls: "bg-secondary text-muted-foreground",
      icon: <Clock size={11} className="shrink-0" />,
    },
    unknown: {
      label: "Unknown",
      cls: "bg-secondary text-muted-foreground",
      icon: <Clock size={11} className="shrink-0" />,
    },
  };
  if (status === "unknown") return null;
  const { label, cls, icon } = configs[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {icon}
      {label}
    </span>
  );
}

interface MobileBuildRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

interface MobileBuildStatus {
  run: MobileBuildRun | null;
}

function isTerminalState(run: MobileBuildRun | null | undefined): boolean {
  return run?.status === "completed";
}

function BuildStatusBadge({ run }: { run: MobileBuildRun | null }) {
  if (!run) return null;

  const { status, conclusion } = run;

  let label: string;
  let cls: string;
  let dotCls: string;

  if (status === "queued") {
    label = "Queued";
    cls = "bg-yellow-50 text-yellow-700 border-yellow-200";
    dotCls = "bg-yellow-400";
  } else if (status === "in_progress") {
    label = "In progress";
    cls = "bg-blue-50 text-blue-700 border-blue-200";
    dotCls = "bg-blue-500 animate-pulse";
  } else if (status === "completed") {
    if (conclusion === "success") {
      label = "Success";
      cls = "bg-green-50 text-green-700 border-green-200";
      dotCls = "bg-green-500";
    } else if (conclusion === "failure") {
      label = "Failed";
      cls = "bg-red-50 text-red-700 border-red-200";
      dotCls = "bg-red-500";
    } else if (conclusion === "cancelled") {
      label = "Cancelled";
      cls = "bg-gray-50 text-gray-600 border-gray-200";
      dotCls = "bg-gray-400";
    } else {
      label = conclusion ?? "Completed";
      cls = "bg-gray-50 text-gray-600 border-gray-200";
      dotCls = "bg-gray-400";
    }
  } else {
    label = status;
    cls = "bg-gray-50 text-gray-600 border-gray-200";
    dotCls = "bg-gray-400";
  }

  return (
    <a
      href={run.htmlUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border ${cls} hover:opacity-80 transition-opacity`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dotCls}`} />
      {label}
      <ExternalLink size={9} className="opacity-60" />
    </a>
  );
}

function MobileBuildPanel() {
  const queryClient = useQueryClient();
  const [platform, setPlatform] = useState<"all" | "ios" | "android">("all");
  const [profile, setProfile] = useState<"production" | "preview" | "development">("production");
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [triggerSuccess, setTriggerSuccess] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [versionDraft, setVersionDraft] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [versionSuccess, setVersionSuccess] = useState(false);
  // ISO timestamp set when the user triggers a build; null when not polling.
  // Polling stays active until we observe a run whose createdAt is >= this
  // timestamp AND that run has reached a terminal state, so a pre-existing
  // completed run never prematurely stops the poll.
  const [triggerTimestamp, setTriggerTimestamp] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["admin", "mobile-build", "info"],
    queryFn: () => apiFetch<MobileBuildInfo>("/admin/mobile-build/info"),
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return false;
      const hasTrigger = data.lastTrigger !== null;
      const status = getBuildRunStatus(data.latestRun ?? null, hasTrigger);
      // Keep polling while pending (run not yet created), queued, or running.
      // Stop once a terminal state is reached (success, failed, cancelled).
      if (!hasTrigger) return false;
      return isTerminalRunStatus(status) ? false : 30_000;
    },
  });

  const versionMutation = useMutation({
    mutationFn: (version: string) =>
      apiFetch<{ ok: boolean; expoVersion: string }>("/admin/mobile-build/app-version", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      }),
    onSuccess: () => {
      setVersionError(null);
      setVersionSuccess(true);
      setVersionDraft(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "mobile-build", "info"] });
      setTimeout(() => setVersionSuccess(false), 4000);
    },
    onError: (err: Error) => {
      setVersionSuccess(false);
      setVersionError(err.message || "Failed to save version.");
    },
  });

  const isPolling = triggerTimestamp !== null;

  // Returns true when the run is for the current trigger and is in a terminal state.
  function isNewRunTerminal(run: MobileBuildRun | null | undefined, ts: string | null): boolean {
    if (!run || !ts) return false;
    return new Date(run.createdAt) >= new Date(ts) && isTerminalState(run);
  }

  const statusQuery = useQuery({
    queryKey: ["admin", "mobile-build", "status"],
    queryFn: () => apiFetch<MobileBuildStatus>("/admin/mobile-build/status"),
    enabled: !!(query.data?.tokenConfigured && query.data?.repoOwner && query.data?.repoName),
    refetchInterval: (q) => {
      if (!isPolling) return false;
      const run = q.state.data?.run;
      // Keep polling while the new run hasn't appeared yet or isn't terminal.
      if (!isNewRunTerminal(run, triggerTimestamp)) return 30_000;
      return false;
    },
  });

  const clearHistoryMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean }>("/admin/mobile-build/version-history", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "mobile-build", "info"] });
    },
  });

  const triggerMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean; trigger: MobileBuildInfo["lastTrigger"] }>("/admin/mobile-build/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, profile }),
      }),
    onSuccess: () => {
      const ts = new Date().toISOString();
      setTriggerError(null);
      setTriggerSuccess(true);
      setTriggerTimestamp(ts);
      queryClient.invalidateQueries({ queryKey: ["admin", "mobile-build", "info"] });
      // Small delay so GitHub has time to register the new run.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["admin", "mobile-build", "status"] });
      }, 5_000);
      setTimeout(() => setTriggerSuccess(false), 4000);
    },
    onError: (err: Error) => {
      setTriggerSuccess(false);
      setTriggerError(err.message || "Failed to trigger build.");
    },
  });

  // Stop polling only once we've confirmed a run created after our trigger is terminal.
  useEffect(() => {
    if (isPolling && isNewRunTerminal(statusQuery.data?.run, triggerTimestamp)) {
      setTriggerTimestamp(null);
    }
  }, [isPolling, statusQuery.data, triggerTimestamp]);

  const mobileBuildGate = usePlatformAdminGate([
    query.error,
    versionMutation.error,
    triggerMutation.error,
  ]);

  const info = query.data;
  const repoBase = info?.repoUrl ? info.repoUrl.replace(/\/$/, "") : null;
  const actionsUrl = repoBase ? `${repoBase}/actions/workflows/eas-build.yml` : null;

  function formatTriggerTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  }

  const platformLabels: Record<string, string> = { all: "All (iOS + Android)", ios: "iOS only", android: "Android only" };
  const profileLabels: Record<string, string> = { production: "Production", preview: "Preview", development: "Development" };

  return (
    <PanelShell
      title="Mobile app"
      subtitle="Trigger an EAS cloud build for iOS or Android straight from this settings panel."
    >
      {mobileBuildGate.blocked && <PlatformAdminSetupNotice />}
      {query.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          Loading…
        </div>
      )}
      {query.error && !mobileBuildGate.blocked && (
        <Alert tone="danger">{(query.error as Error).message}</Alert>
      )}
      {info && (
        <div className="space-y-5">
          {/* Build number info */}
          <div className="rounded-lg border border-border bg-secondary/30 px-5 py-4 space-y-3">
            <div className="text-sm font-semibold">Current build numbers</div>
            {info.appJsonError ? (
              <Alert tone="warning">Could not read app.json: {info.appJsonError}</Alert>
            ) : (
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">iOS build number</div>
                  <div className="text-sm font-mono font-semibold">{info.iosBuildNumber ?? "—"}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Android version code</div>
                  <div className="text-sm font-mono font-semibold">{info.androidVersionCode ?? "—"}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">App store version</div>
                  <div className="text-sm font-mono font-semibold">{info.expoVersion ?? "—"}</div>
                </div>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              The EAS build workflow automatically bumps iOS build number and Android version code before each build and commits the result back to{" "}
              <code className="font-mono">main</code>.
            </p>
          </div>

          {/* App store version editor */}
          {!info.appJsonError && (
            <div className="rounded-lg border border-border px-5 py-4 space-y-3">
              <div className="text-sm font-semibold">App store version string</div>
              <p className="text-[11px] text-muted-foreground">
                This is the user-visible version shown in the App Store and Google Play (e.g. <code className="font-mono">2.1.0</code>). Must be x.y.z format.
              </p>
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={versionDraft ?? info.expoVersion ?? ""}
                  onChange={(e) => setVersionDraft(e.target.value)}
                  placeholder="e.g. 2.1.0"
                  className={`${inputCls} w-36 font-mono`}
                />
                <button
                  type="button"
                  onClick={() => {
                    const v = (versionDraft ?? "").trim();
                    if (!/^\d+\.\d+\.\d+$/.test(v)) {
                      setVersionError("Version must be x.y.z (e.g. 2.1.0).");
                      return;
                    }
                    setVersionError(null);
                    versionMutation.mutate(v);
                  }}
                  disabled={versionMutation.isPending || versionDraft === null || versionDraft.trim() === "" || versionDraft.trim() === (info.expoVersion ?? "")}
                  className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
                >
                  {versionMutation.isPending ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : null}
                  {versionMutation.isPending ? "Saving…" : "Save version"}
                </button>
              </div>
              {versionError && <Alert tone="danger">{versionError}</Alert>}
              {versionSuccess && <Alert tone="success">Version updated and committed to app.json.</Alert>}
            </div>
          )}

          {/* Version change history */}
          {!info.appJsonError && info.versionHistory && info.versionHistory.length > 0 && (
            <div className="rounded-lg border border-border px-5 py-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">Version change history</div>
                <button
                  onClick={() => clearHistoryMutation.mutate()}
                  disabled={clearHistoryMutation.isPending}
                  className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md border border-border text-xs text-muted-foreground hover:text-destructive hover:border-destructive disabled:opacity-50 transition-colors"
                >
                  {clearHistoryMutation.isPending ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : null}
                  Clear history
                </button>
              </div>
              <div className="divide-y divide-border">
                {info.versionHistory.map((entry, i) => (
                  <div key={i} className="flex items-center justify-between py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold text-primary">{entry.version}</span>
                      <span className="text-muted-foreground text-xs">by {entry.changedByUsername}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <Clock size={10} className="inline mr-1 -mt-px" />
                      {formatTriggerTime(entry.changedAt)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Setup warnings */}
          {!info.tokenConfigured && (
            <Alert tone="warning">
              <strong>GITHUB_ACTIONS_TOKEN is not set.</strong> Add a fine-grained GitHub PAT with <em>Actions: Read and write</em> access as the <code className="font-mono">GITHUB_ACTIONS_TOKEN</code> environment secret to enable build triggering.
            </Alert>
          )}
          {(!info.repoOwner || !info.repoName) && (
            <Alert tone="warning">
              <strong>GITHUB_REPO_URL is not set or invalid.</strong> Set it to your repository URL (e.g.{" "}
              <code className="font-mono">https://github.com/your-org/your-repo</code>) so the panel knows where to dispatch the workflow.
            </Alert>
          )}

          {/* Trigger form */}
          <div className="rounded-lg border border-border px-5 py-4 space-y-4">
            <div className="text-sm font-semibold">Trigger EAS build</div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  Platform
                </label>
                <select
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value as "all" | "ios" | "android")}
                  className={inputCls}
                >
                  <option value="all">All (iOS + Android)</option>
                  <option value="ios">iOS only</option>
                  <option value="android">Android only</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  Profile
                </label>
                <select
                  value={profile}
                  onChange={(e) => setProfile(e.target.value as "production" | "preview" | "development")}
                  className={inputCls}
                >
                  <option value="production">Production</option>
                  <option value="preview">Preview</option>
                  <option value="development">Development</option>
                </select>
              </div>
            </div>
            {triggerError && <Alert tone="danger">{triggerError}</Alert>}
            {triggerSuccess && (
              <Alert tone="success">
                Build triggered successfully. Check{" "}
                {actionsUrl ? (
                  <a href={actionsUrl} target="_blank" rel="noopener noreferrer" className="underline font-medium">
                    GitHub Actions
                  </a>
                ) : (
                  "GitHub Actions"
                )}{" "}
                to monitor progress.
              </Alert>
            )}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={triggerMutation.isPending || !info.tokenConfigured || !info.repoOwner}
                className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
              >
                {triggerMutation.isPending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Play size={14} />
                )}
                {triggerMutation.isPending ? "Triggering…" : "Trigger EAS build"}
              </button>
              {actionsUrl && (
                <a
                  href={actionsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-input bg-background text-xs font-medium hover:bg-secondary"
                >
                  <Github size={13} />
                  View on GitHub
                  <ExternalLink size={11} className="text-muted-foreground" />
                </a>
              )}
            </div>
          </div>

          {/* Latest GitHub Actions run status */}
          {info.tokenConfigured && info.repoOwner && info.repoName && (
            <div className="rounded-lg border border-border px-5 py-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">Latest run status</div>
                <button
                  type="button"
                  onClick={() => {
                    queryClient.invalidateQueries({ queryKey: ["admin", "mobile-build", "status"] });
                  }}
                  disabled={statusQuery.isFetching}
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  <RefreshCcw size={12} className={statusQuery.isFetching ? "animate-spin" : ""} />
                  Refresh
                </button>
              </div>
              {statusQuery.isLoading && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 size={12} className="animate-spin" />
                  Loading…
                </div>
              )}
              {statusQuery.error && (
                <p className="text-xs text-muted-foreground">Could not load run status.</p>
              )}
              {statusQuery.data && !statusQuery.isLoading && (
                statusQuery.data.run ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-3">
                      <BuildStatusBadge run={statusQuery.data.run} />
                      {isPolling && !isTerminalState(statusQuery.data.run) && (
                        <span className="text-[11px] text-muted-foreground">Auto-refreshing every 30 s…</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <Clock size={11} className="inline mr-1 -mt-px" />
                      Started {formatTriggerTime(statusQuery.data.run.createdAt)}
                      {statusQuery.data.run.status === "completed" && (
                        <> · Updated {formatTriggerTime(statusQuery.data.run.updatedAt)}</>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No runs found for <code className="font-mono">eas-build.yml</code>.</p>
                )
              )}
            </div>
          )}

          {/* Build counter recovery */}
          <MobileBuildCounterRecovery repoUrl={info.repoUrl} onApplied={() => queryClient.invalidateQueries({ queryKey: ["admin", "mobile-build", "info"] })} />

          {/* Last triggered build */}
          {info.lastTrigger && (
            <div className="rounded-lg border border-border px-5 py-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold">Last triggered build</div>
                <div className="flex items-center gap-2">
                  <BuildRunStatusBadge run={info.latestRun} hasTrigger={info.lastTrigger !== null} />
                  {query.isFetching && !query.isLoading && (
                    <Loader2 size={11} className="animate-spin text-muted-foreground" />
                  )}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Platform</div>
                  <div className="font-medium">{platformLabels[info.lastTrigger.platform] ?? info.lastTrigger.platform}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Profile</div>
                  <div className="font-medium">{profileLabels[info.lastTrigger.profile] ?? info.lastTrigger.profile}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Triggered by</div>
                  <div className="font-medium">{info.lastTrigger.triggeredByUsername}</div>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground">
                  <Clock size={11} className="inline mr-1 -mt-px" />
                  {formatTriggerTime(info.lastTrigger.triggeredAt)}
                </div>
                {info.latestRun && (
                  <a
                    href={info.latestRun.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    <Github size={11} />
                    View run
                    <ExternalLink size={10} className="text-muted-foreground" />
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Trigger EAS build?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>This will dispatch a paid EAS cloud build with the following settings:</p>
                <div className="rounded-md border border-border bg-secondary/40 px-4 py-3 text-sm space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-20 shrink-0">Platform</span>
                    <span className="font-medium">{platformLabels[platform]}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-20 shrink-0">Profile</span>
                    <span className="font-medium">{profileLabels[profile]}</span>
                    {profile !== "production" && (
                      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                        Non-production
                      </span>
                    )}
                  </div>
                </div>
                {profile !== "production" && (
                  <p className="text-amber-600 dark:text-amber-400 text-sm">
                    You are about to start a <strong>{profileLabels[profile].toLowerCase()}</strong> build. These still consume build minutes. Make sure this is intentional.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                triggerMutation.mutate();
              }}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Yes, trigger build
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PanelShell>
  );
}

function MobileBuildCounterRecovery({
  repoUrl,
  onApplied,
}: {
  repoUrl: string | null;
  onApplied?: () => void;
}) {
  const [buildNumberInput, setBuildNumberInput] = useState("");
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applySuccess, setApplySuccess] = useState<{
    buildNumber: number;
    commitUrl: string | null;
  } | null>(null);

  const applyMutation = useMutation({
    mutationFn: (buildNumber: number) =>
      apiFetch<{
        ok: boolean;
        buildNumber: number;
        commitSha: string | null;
        commitUrl: string | null;
      }>("/admin/settings/build-counter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "mobile", buildNumber }),
      }),
    onSuccess: (data) => {
      setApplyError(null);
      setApplySuccess({ buildNumber: data.buildNumber, commitUrl: data.commitUrl });
      setBuildNumberInput("");
      onApplied?.();
      setTimeout(() => setApplySuccess(null), 8000);
    },
    onError: (err: Error) => {
      setApplySuccess(null);
      setApplyError(err.message || "Failed to apply build counter.");
    },
  });

  function handleApply() {
    const n = parseInt(buildNumberInput.trim(), 10);
    if (!buildNumberInput.trim() || Number.isNaN(n) || n < 1) {
      setApplyError("Enter a valid positive integer build number.");
      return;
    }
    setApplyError(null);
    setApplySuccess(null);
    applyMutation.mutate(n);
  }

  return (
    <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/40 dark:bg-amber-950/20 px-5 py-4 space-y-3">
      <div className="flex items-start gap-2">
        <RotateCcw size={14} className="mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
        <div>
          <div className="text-sm font-semibold">Build counter recovery</div>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            If an EAS build exited with a warning that the counter wasn't persisted, paste the build number from the <code className="font-mono bg-secondary px-0.5 rounded">build-counter-fallback</code> artifact here. Both <code className="font-mono bg-secondary px-0.5 rounded">expo.ios.buildNumber</code> and <code className="font-mono bg-secondary px-0.5 rounded">expo.android.versionCode</code> in <code className="font-mono bg-secondary px-0.5 rounded">app.json</code> will be set to this value and committed to <code className="font-mono bg-secondary px-0.5 rounded">main</code>.
          </p>
        </div>
      </div>
      {applyError && <Alert tone="danger">{applyError}</Alert>}
      {applySuccess && (
        <Alert tone="success">
          Build counter set to <strong>{applySuccess.buildNumber}</strong> and committed to main.
          {applySuccess.commitUrl && (
            <>
              {" "}
              <a
                href={applySuccess.commitUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-medium"
              >
                View commit
              </a>
            </>
          )}
        </Alert>
      )}
      <div className="flex items-center gap-3">
        <input
          type="number"
          min={1}
          step={1}
          value={buildNumberInput}
          onChange={(e) => setBuildNumberInput(e.target.value)}
          placeholder="e.g. 134"
          className={`${inputCls} w-36 font-mono`}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleApply();
          }}
        />
        <button
          type="button"
          onClick={handleApply}
          disabled={applyMutation.isPending || !buildNumberInput.trim()}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700 disabled:opacity-50"
        >
          {applyMutation.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <RotateCcw size={13} />
          )}
          {applyMutation.isPending ? "Applying…" : "Apply counter"}
        </button>
        {repoUrl && (
          <a
            href={`${repoUrl.replace(/\/$/, "")}/actions`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink size={11} />
            Actions
          </a>
        )}
      </div>
    </div>
  );
}

interface SessionRow {
  id: string;
  deviceName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string | null;
  expiresAt: string;
  current: boolean;
}

function describeUserAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Safari\//.test(ua) && !/Chrome\//.test(ua)
        ? "Safari"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : "Browser";
  const os = /Windows NT/.test(ua)
    ? "Windows"
    : /Mac OS X/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad|iOS/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = t - Date.now();
  const future = diff > 0;
  const absMs = Math.abs(diff);
  const min = Math.round(absMs / 60000);
  const suffix = (label: string) => (future ? `in ${label}` : `${label} ago`);
  if (min < 1) return future ? "in a moment" : "just now";
  if (min < 60) return suffix(`${min} min`);
  const hr = Math.round(min / 60);
  if (hr < 24) return suffix(`${hr} hr`);
  const day = Math.round(hr / 24);
  if (day < 30) return suffix(`${day} day${day === 1 ? "" : "s"}`);
  return new Date(iso).toLocaleDateString();
}

function SessionsPanel() {
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const sessionsQuery = useQuery({
    queryKey: ["auth", "sessions"],
    queryFn: () =>
      apiFetch<{ success: boolean; sessions: SessionRow[] } | SessionRow[]>(
        "/auth/sessions",
      ),
  });
  const list: SessionRow[] = useMemo(() => {
    const d = sessionsQuery.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return d.sessions ?? [];
  }, [sessionsQuery.data]);

  const revokeOne = useMutation({
    mutationFn: async (id: string) => {
      return apiFetch<{ success: boolean; revokedCurrent?: boolean }>(
        `/auth/sessions/${id}`,
        { method: "DELETE" },
      );
    },
    onSuccess: async (data) => {
      setError(null);
      setInfo("Sign-in revoked.");
      if (data?.revokedCurrent) {
        notifySessionCleared();
        return;
      }
      await sessionsQuery.refetch();
      setTimeout(() => setInfo(null), 2500);
    },
    onError: (err: Error) => {
      setInfo(null);
      setError(err.message || "Could not revoke that sign-in.");
    },
  });

  const revokeOthers = useMutation({
    mutationFn: async () => {
      return apiFetch<{ success: boolean; revokedCount: number }>(
        "/auth/sessions/revoke-others",
        { method: "POST" },
      );
    },
    onSuccess: async (data) => {
      setError(null);
      setInfo(
        data?.revokedCount
          ? `Signed out of ${data.revokedCount} other ${data.revokedCount === 1 ? "device" : "devices"}.`
          : "No other sign-ins to revoke.",
      );
      await sessionsQuery.refetch();
      setTimeout(() => setInfo(null), 2500);
    },
    onError: (err: Error) => {
      setInfo(null);
      setError(err.message || "Could not sign out of other devices.");
    },
  });

  const otherCount = list.filter((s) => !s.current).length;

  return (
    <PanelShell
      title="Active sign-ins"
      subtitle="Devices currently signed in to your LabTrax account."
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {sessionsQuery.isLoading ? (
            <>
              <Loader2 size={12} className="inline animate-spin mr-2" />
              Loading…
            </>
          ) : (
            <>
              {list.length} active {list.length === 1 ? "session" : "sessions"}
            </>
          )}
        </div>
        <button
          type="button"
          onClick={() => revokeOthers.mutate()}
          disabled={revokeOthers.isPending || otherCount === 0}
          className="h-9 px-3 rounded-md bg-destructive/10 text-destructive text-xs font-semibold hover:bg-destructive/20 disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          <LogOut size={12} />
          {revokeOthers.isPending ? "Signing out…" : "Sign out everywhere else"}
        </button>
      </div>
      <div className="border border-border rounded-md divide-y divide-border">
        {!sessionsQuery.isLoading && list.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            No active sign-ins.
          </div>
        )}
        {list.map((s) => (
          <div
            key={s.id}
            className="px-3 py-3 flex items-center justify-between gap-3 text-sm"
          >
            <div className="min-w-0">
              <div className="font-medium flex items-center gap-2">
                {s.deviceName || describeUserAgent(s.userAgent)}
                {s.current && (
                  <span className="text-[10px] uppercase tracking-wide bg-success/15 text-success rounded-full px-2 py-0.5">
                    This device
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 truncate">
                {describeUserAgent(s.userAgent)} · {s.ipAddress || "unknown IP"}
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                Signed in {formatRelative(s.createdAt)} · expires {formatRelative(s.expiresAt)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                if (s.current) {
                  if (!window.confirm("This is the device you're using right now. Revoking it will sign you out. Continue?")) return;
                }
                revokeOne.mutate(s.id);
              }}
              disabled={revokeOne.isPending}
              className="h-8 px-3 rounded-md text-xs font-semibold border border-border hover:bg-destructive/10 hover:text-destructive hover:border-destructive/40 disabled:opacity-50"
            >
              {s.current ? "Sign out" : "Revoke"}
            </button>
          </div>
        ))}
      </div>
    </PanelShell>
  );
}

const inputCls = "w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm";

type IteroRecentImport = {
  iteroOrderId: string;
  caseId: string | null;
  caseNumber: string | null;
  importedAt: string;
};

type IteroStatus = {
  available: boolean;
  configured: boolean;
  enabled: boolean;
  intervalMin: number;
  apiBaseUrl: string;
  labOrganizationId: string;
  providerOrganizationId: string;
  lastPollAt: string | null;
  lastError: string | null;
  importedCount: number;
  importedToday: number;
  recentImports: IteroRecentImport[];
  polling: boolean;
  authActive: boolean;
};

type IteroSetCredentialsPayload = { username: string; password: string };
type IteroSetApiConfigPayload = { apiBaseUrl?: string; labOrganizationId?: string; providerOrganizationId?: string; intervalMin?: number };
type IteroSetEnabledPayload = { enabled: boolean; intervalMin?: number };
type IteroPollResult = { ok: boolean; imported?: number; skipped?: number; total?: number; error?: string };
type IteroAPI = {
  getStatus: () => Promise<IteroStatus>;
  setCredentials: (payload: IteroSetCredentialsPayload) => Promise<IteroStatus>;
  clearCredentials: () => Promise<IteroStatus>;
  setApiConfig: (payload: IteroSetApiConfigPayload) => Promise<IteroStatus>;
  setEnabled: (payload: IteroSetEnabledPayload) => Promise<IteroStatus>;
  testLogin: () => Promise<{ ok: boolean; error?: string }>;
  pollNow: () => Promise<IteroPollResult>;
  onStatus: (cb: (s: IteroStatus) => void) => () => void;
};
type PlatformAdminStatus = {
  available: boolean;
  configured: boolean;
  savedAt: number | null;
};
type PlatformAdminTestResult = { ok: boolean; status: number; message?: string };
type PlatformAdminAPI = {
  getStatus: () => Promise<PlatformAdminStatus>;
  getSecret: () => Promise<string | null>;
  setSecret: (payload: string | { secret: string }) => Promise<PlatformAdminStatus>;
  clearSecret: () => Promise<PlatformAdminStatus>;
  testSecret: (payload: string | { apiBaseUrl: string }) => Promise<PlatformAdminTestResult>;
  onChanged: (cb: (s: PlatformAdminStatus) => void) => () => void;
};
type ElectronWindow = Window & { electronAPI?: { showFolderDialog?: () => Promise<string | null>; showOpenDialog?: (opts: { title?: string; filters?: Array<{ name: string; extensions: string[] }>; properties?: string[] }) => Promise<string[] | null>; relaunch?: () => void; openExternal?: (url: string) => Promise<boolean>; saveBackupToFolder?: (buffer: Uint8Array, fileName: string, folderPath: string) => Promise<{ ok: boolean; path?: string; error?: string }>; itero?: IteroAPI; platformAdmin?: PlatformAdminAPI } };

function PlatformAdminPanel() {
  const electron = typeof window !== "undefined" ? (window as ElectronWindow).electronAPI : null;
  const platformAdmin = electron?.platformAdmin;

  const [status, setStatus] = useState<PlatformAdminStatus | null>(null);
  const [secret, setSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (!platformAdmin) return;
    let cancelled = false;
    platformAdmin.getStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    const off = platformAdmin.onChanged((s) => setStatus(s));
    return () => {
      cancelled = true;
      off?.();
    };
  }, [platformAdmin]);

  // Re-render when the web-view session secret changes so the panel updates
  // immediately after unlock (or after the secret is cleared).
  useSessionSecretVersion();
  const sessionSecret = getSessionSecret();

  if (!platformAdmin) {
    // Web view: the OS keychain is not available, but the admin can still
    // unlock all admin tools for this session via the in-memory secret prompt.
    // Show the unlock notice if not yet unlocked, or a confirmation + clear
    // button if already unlocked.
    return (
      <PanelShell
        title="Platform admin"
        subtitle="Unlock platform-wide admin tools for this browser session."
      >
        <div className="space-y-4">
          {sessionSecret ? (
            <div className="rounded-md border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/40 px-4 py-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="font-medium text-green-800 dark:text-green-300">
                    Admin tools unlocked for this session
                  </p>
                  <p className="text-xs text-green-700 dark:text-green-400">
                    The secret is held only in memory and will be forgotten when
                    you refresh the page. To manage the OS-keychain copy,{" "}
                    open this panel from the LabTrax Desktop app.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => clearSessionSecret()}
                  className="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-medium border border-green-300 dark:border-green-700 bg-green-100 dark:bg-green-900 hover:bg-green-200 dark:hover:bg-green-800 text-green-800 dark:text-green-200 transition-colors"
                >
                  Lock
                </button>
              </div>
            </div>
          ) : (
            <PlatformAdminSetupNotice />
          )}
          <p className="text-xs text-muted-foreground">
            In the LabTrax Desktop app, the{" "}
            <code className="font-mono">PLATFORM_ADMIN_SECRET</code> is saved to
            the OS keychain and injected automatically. In the web view it is
            held in memory only for the current session.
          </p>
        </div>
      </PanelShell>
    );
  }

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setMessage(null);
    try {
      return await fn();
    } catch (err: any) {
      setMessage({ tone: "err", text: err?.message || String(err) });
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  const fmt = (n: number | null | undefined) => (n ? new Date(n).toLocaleString() : "Never");

  return (
    <PanelShell
      title="Platform admin secret"
      subtitle="Required to call platform-wide maintenance endpoints (Media Cleanup, Backup schedule, Cleanup alerts). The secret is encrypted on this machine via the OS keychain and attached as the X-Platform-Admin-Secret header on /admin/* requests."
    >
      <div className="px-6 py-5 space-y-6">
        {!status?.available && (
          <Alert tone="danger">
            OS keychain is unavailable on this machine — the secret cannot be stored securely. On Linux this requires gnome-keyring or kwallet.
          </Alert>
        )}

        {message && (
          <Alert tone={message.tone === "ok" ? "success" : "danger"}>{message.text}</Alert>
        )}

        <section className="space-y-3">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Secret</h3>
          <label className="block text-sm">
            <div className="text-muted-foreground mb-1">PLATFORM_ADMIN_SECRET</div>
            <div className="relative">
              <input
                type={showSecret ? "text" : "password"}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={status?.configured ? "(saved — type to replace)" : "Paste the value of PLATFORM_ADMIN_SECRET from the API server"}
                className={`${inputCls} pr-14`}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
              >
                {showSecret ? "Hide" : "Show"}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">
              Must exactly match the API server's <code className="font-mono">PLATFORM_ADMIN_SECRET</code> environment variable. Without it, admin maintenance panels return 403.
            </p>
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!secret.trim() || !!busy || !status?.available}
              onClick={() => run("save", async () => {
                const s = await platformAdmin.setSecret(secret.trim());
                setStatus(s);
                setSecret("");
                setShowSecret(false);
                setMessage({ tone: "ok", text: "Secret saved on this machine." });
              })}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-60"
            >
              {busy === "save" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save secret
            </button>
            <button
              type="button"
              disabled={!status?.configured || !!busy}
              onClick={() => run("test", async () => {
                const apiBase = (import.meta.env?.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "")
                  || `${window.location.origin}/api`;
                const r = await platformAdmin.testSecret({ apiBaseUrl: apiBase });
                if (r?.ok) {
                  setMessage({ tone: "ok", text: "Server accepted the secret." });
                } else {
                  setMessage({ tone: "err", text: r?.message || `Test failed (HTTP ${r?.status ?? 0}).` });
                }
              })}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-secondary text-foreground text-xs disabled:opacity-60"
            >
              {busy === "test" ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />} Test against server
            </button>
            {status?.configured && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => run("clear", async () => {
                  const s = await platformAdmin.clearSecret();
                  setStatus(s);
                  setMessage({ tone: "ok", text: "Secret removed from this machine." });
                })}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-secondary text-foreground text-xs"
              >
                <Trash2 size={12} /> Forget secret
              </button>
            )}
          </div>
        </section>

        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Status</h3>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            <div className="text-muted-foreground">Stored on this machine</div>
            <div>{status?.configured ? "Yes (encrypted)" : "No"}</div>
            <div className="text-muted-foreground">Saved at</div>
            <div>{fmt(status?.savedAt)}</div>
            <div className="text-muted-foreground">OS keychain</div>
            <div>{status?.available ? "Available" : "Unavailable"}</div>
          </div>
          <p className="text-xs text-muted-foreground pt-2">
            The encrypted blob lives next to the app's other settings (under <code className="font-mono">userData/platform-admin-secret.bin</code>). Signing out clears the in-memory copy but keeps the on-disk blob, so the next sign-in still works.
          </p>
        </section>
      </div>
    </PanelShell>
  );
}

interface IteroImportSession {
  batchId: string;
  importedAt: string;
  importedByUserId: string | null;
  importedByUsername: string | null;
  importedByName: string | null;
  createdCount: number;
  dedupedCount: number;
  erroredCount: number;
  totalCount: number;
  caseIds: string[];
}

function IteroAutoLinkToggle({ labOrgId }: { labOrgId: string }) {
  const qc = useQueryClient();
  const settingQuery = useQuery({
    queryKey: ["itero-auto-link-setting", labOrgId],
    queryFn: () => apiFetch<{ labOrganizationId: string; autoLinkSuggestedPractice: boolean }>(
      `/cases/itero-settings/${encodeURIComponent(labOrgId)}`,
    ),
    enabled: !!labOrgId,
  });
  const mutation = useMutation({
    mutationFn: (next: boolean) =>
      apiFetch(`/cases/itero-settings/${encodeURIComponent(labOrgId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoLinkSuggestedPractice: next }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["itero-auto-link-setting", labOrgId] });
    },
  });

  if (!labOrgId) return null;
  const enabled = !!settingQuery.data?.autoLinkSuggestedPractice;

  return (
    <label className="mt-1 flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={enabled}
        disabled={settingQuery.isLoading || mutation.isPending}
        onChange={(e) => mutation.mutate(e.target.checked)}
      />
      <span className="text-muted-foreground">
        Auto-link AI-suggested practice when the suggestion differs from the default above. Manual review is still possible — the case will show the link source as &ldquo;AI suggestion&rdquo; in the audit log.
      </span>
    </label>
  );
}

function IteroPanel() {
  const electron = (typeof window !== "undefined" ? (window as ElectronWindow).electronAPI : null);
  const itero = electron?.itero;
  const { user } = useAuth();
  const meQuery = useQuery({
    queryKey: ["me-for-itero"],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
  });

  const [status, setStatus] = useState<IteroStatus | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [labOrgId, setLabOrgId] = useState("");
  const [providerOrgId, setProviderOrgId] = useState("");
  const [intervalMin, setIntervalMin] = useState(5);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const historyQuery = useQuery<{ ok: boolean; data: { sessions: IteroImportSession[]; total: number } }>({
    queryKey: ["itero-import-history", labOrgId],
    queryFn: () => apiFetch(`/cases/itero-import-history?labOrganizationId=${encodeURIComponent(labOrgId)}&limit=25`),
    enabled: !!labOrgId,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!itero) return;
    let cancelled = false;
    itero.getStatus().then((s) => {
      if (cancelled) return;
      setStatus(s);
      setLabOrgId(s.labOrganizationId || "");
      setProviderOrgId(s.providerOrganizationId || "");
      setIntervalMin(s.intervalMin || 5);
    });
    const off = itero.onStatus((s) => setStatus(s));
    return () => { cancelled = true; off?.(); };
  }, [itero]);

  // Auto-set the API base URL to the same origin the renderer uses
  useEffect(() => {
    if (!itero || !status) return;
    const apiBase = (import.meta.env?.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "")
      || `${window.location.origin}/api`;
    if (!status.apiBaseUrl || status.apiBaseUrl !== apiBase) {
      itero.setApiConfig({ apiBaseUrl: apiBase });
    }
  }, [itero, status?.apiBaseUrl]);

  const labMemberships = useMemo(
    () => (meQuery.data?.memberships ?? []).filter((m) => m.organization?.type === "lab"),
    [meQuery.data],
  );
  const providerMemberships = useMemo(
    () => (meQuery.data?.memberships ?? []).filter((m) => m.organization?.type === "provider"),
    [meQuery.data],
  );

  if (!itero) {
    return (
      <PanelShell title="iTero auto-import" subtitle="Available in the desktop app only.">
        <div className="px-6 py-4 text-sm text-muted-foreground">
          The iTero "Lab Review" auto-import runs inside the LabTrax Desktop app. Open this panel from the desktop client to configure it.
        </div>
      </PanelShell>
    );
  }

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setMessage(null);
    try {
      const r = await fn();
      return r;
    } catch (err: any) {
      setMessage({ tone: "err", text: err?.message || String(err) });
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  const fmt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "Never");

  return (
    <PanelShell
      title="iTero auto-import"
      subtitle="Auto-create LabTrax cases from iTero Lab-Review orders. Credentials are encrypted on this machine via the OS keychain."
    >
      <div className="px-6 py-5 space-y-6">
        {!status?.available && (
          <div className="text-sm rounded-md px-3 py-2 bg-destructive/10 text-destructive">
            OS keychain is unavailable on this machine — credentials cannot be stored securely. On Linux this requires gnome-keyring or kwallet.
          </div>
        )}

        {message && (
          <div className={`text-sm rounded-md px-3 py-2 ${message.tone === "ok" ? "bg-success/15 text-success" : "bg-destructive/10 text-destructive"}`}>
            {message.text}
          </div>
        )}

        <section className="space-y-3">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Shared iTero account</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <div className="text-muted-foreground mb-1">Username / email</div>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={status?.configured ? "(saved — type to replace)" : "lab@example.com"}
                className="w-full h-9 px-3 rounded-md border border-border bg-background text-sm"
              />
            </label>
            <label className="text-sm">
              <div className="text-muted-foreground mb-1">Password</div>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={status?.configured ? "(saved — type to replace)" : ""}
                  className="w-full h-9 px-3 pr-9 rounded-md border border-border bg-background text-sm"
                />
                <button type="button" onClick={() => setShowPassword((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground">
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!username || !password || !!busy}
              onClick={() => run("save-creds", async () => {
                const s = await itero.setCredentials({ username, password });
                setStatus(s);
                setUsername("");
                setPassword("");
                setMessage({ tone: "ok", text: "iTero credentials saved." });
              })}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-60"
            >
              {busy === "save-creds" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save credentials
            </button>
            {status?.configured && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => run("clear-creds", async () => {
                  const s = await itero.clearCredentials();
                  setStatus(s);
                  setMessage({ tone: "ok", text: "iTero credentials removed." });
                })}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-secondary text-foreground text-xs"
              >
                <Trash2 size={12} /> Forget
              </button>
            )}
            <button
              type="button"
              disabled={!status?.configured || !!busy}
              onClick={() => run("test-login", async () => {
                const r = await itero.testLogin();
                setMessage(r?.ok
                  ? { tone: "ok", text: "Logged into iTero successfully." }
                  : { tone: "err", text: r?.error || "Login failed." });
              })}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-secondary text-foreground text-xs disabled:opacity-60"
            >
              {busy === "test-login" ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />} Test login
            </button>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Imported case routing</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <div className="text-muted-foreground mb-1">Lab organization</div>
              <select
                value={labOrgId}
                onChange={(e) => { setLabOrgId(e.target.value); itero.setApiConfig({ labOrganizationId: e.target.value }); }}
                className="w-full h-9 px-2 rounded-md border border-border bg-background text-sm"
              >
                <option value="">Select a lab…</option>
                {labMemberships.map((m) => (
                  <option key={m.organizationId} value={m.organizationId}>
                    {m.organization?.name || m.organizationId}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <div className="text-muted-foreground mb-1">Default provider (practice)</div>
              <select
                value={providerOrgId}
                onChange={(e) => { setProviderOrgId(e.target.value); itero.setApiConfig({ providerOrganizationId: e.target.value }); }}
                className="w-full h-9 px-2 rounded-md border border-border bg-background text-sm"
              >
                <option value="">Select a provider…</option>
                {providerMemberships.map((m) => (
                  <option key={m.organizationId} value={m.organizationId}>
                    {m.organization?.name || m.organizationId}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Imported cases are created under this lab and assigned to the chosen provider. You can re-route any case after it&rsquo;s reviewed.
          </p>
          <IteroAutoLinkToggle labOrgId={labOrgId} />
        </section>

        <section className="space-y-3">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Polling</h3>
          <div className="flex items-end gap-3 flex-wrap">
            <label className="text-sm">
              <div className="text-muted-foreground mb-1">Interval (minutes)</div>
              <input
                type="number"
                min={5}
                max={240}
                value={intervalMin}
                onChange={(e) => setIntervalMin(Number(e.target.value) || 5)}
                className="w-28 h-9 px-3 rounded-md border border-border bg-background text-sm"
              />
            </label>
            <button
              type="button"
              disabled={!status?.configured || !labOrgId || !providerOrgId || !!busy}
              onClick={() => run("toggle", async () => {
                const s = await itero.setEnabled({ enabled: !status?.enabled, intervalMin });
                setStatus(s);
              })}
              className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-xs font-medium ${status?.enabled ? "bg-destructive/10 text-destructive" : "bg-primary text-primary-foreground"} disabled:opacity-60`}
            >
              {status?.enabled ? "Pause auto-import" : "Enable auto-import"}
            </button>
            <button
              type="button"
              disabled={!status?.configured || !labOrgId || !providerOrgId || !!busy}
              onClick={() => run("poll", async () => {
                const r = await itero.pollNow();
                setMessage(r?.ok
                  ? { tone: "ok", text: `Poll complete — imported ${r.imported}, skipped ${r.skipped} of ${r.total}.` }
                  : { tone: "err", text: r?.error || "Poll failed." });
              })}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-secondary text-foreground text-xs disabled:opacity-60"
            >
              {busy === "poll" || status?.polling ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} Poll now
            </button>
          </div>
        </section>

        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Status</h3>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            <div className="text-muted-foreground">Credentials</div>
            <div>{status?.configured ? "Saved (encrypted)" : "Not set"}</div>
            <div className="text-muted-foreground">Auto-poll</div>
            <div>{status?.enabled ? `On — every ${status.intervalMin} min` : "Off"}</div>
            <div className="text-muted-foreground">Last poll</div>
            <div>{fmt(status?.lastPollAt)}</div>
            <div className="text-muted-foreground">Imported today</div>
            <div>{status?.importedToday ?? 0}</div>
            <div className="text-muted-foreground">Imported total</div>
            <div>{status?.importedCount ?? 0}</div>
            <div className="text-muted-foreground">Last error</div>
            <div className={status?.lastError ? "text-destructive" : ""}>{status?.lastError || "None"}</div>
            <div className="text-muted-foreground">Signed in as</div>
            <div className="truncate">{user?.username}{status?.authActive === false && <span className="text-destructive ml-2">(poller paused — sign in required)</span>}</div>
          </div>

        </section>

        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium flex items-center gap-1.5">
            <History size={11} />
            Import history
          </h3>
          {!labOrgId ? (
            <p className="text-xs text-muted-foreground">Select a lab above to see import history.</p>
          ) : historyQuery.isLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          ) : historyQuery.isError ? (
            <p className="text-xs text-destructive">Could not load history.</p>
          ) : !historyQuery.data?.data?.sessions?.length ? (
            <p className="text-xs text-muted-foreground">No import sessions recorded yet.</p>
          ) : (
            <div>
              <p className="text-xs text-muted-foreground mb-2">Click a session to view those cases.</p>
              <ul className="text-sm divide-y divide-border rounded-md border border-border">
                {historyQuery.data.data.sessions.map((session) => {
                  const operator = session.importedByName || session.importedByUsername || "Unknown user";
                  const label = `${session.totalCount} order${session.totalCount !== 1 ? "s" : ""} by ${operator}`;
                  return (
                    <li key={session.batchId} className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-secondary/40 transition-colors">
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium truncate">{fmt(session.importedAt)}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {operator} ·{" "}
                          <span className="text-emerald-600 dark:text-emerald-400">{session.createdCount} new</span>
                          {session.dedupedCount > 0 && (
                            <span className="text-muted-foreground"> · {session.dedupedCount} skipped</span>
                          )}
                          {session.erroredCount > 0 && (
                            <span className="text-destructive"> · {session.erroredCount} failed</span>
                          )}
                        </div>
                      </div>
                      {session.caseIds.length > 0 && (
                        <a
                          href="#/cases"
                          className="text-xs font-medium text-primary hover:underline whitespace-nowrap"
                          onClick={() => {
                            try {
                              sessionStorage.setItem(
                                "cases_itero_batch_v1",
                                JSON.stringify({ batchId: session.batchId, caseIds: session.caseIds, importedAt: session.importedAt, label })
                              );
                            } catch {}
                          }}
                        >
                          View {session.caseIds.length} case{session.caseIds.length !== 1 ? "s" : ""}
                        </a>
                      )}
                      {session.caseIds.length === 0 && (
                        <span className="text-xs text-muted-foreground">All skipped</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      </div>
    </PanelShell>
  );
}

// ── Subscriptions Panel ────────────────────────────────────────────────────

interface SubscriptionItem {
  id: string;
  subjectType: string;
  subjectId: string;
  subjectName: string;
  subjectOrgType: string | null;
  subjectEmail: string | null;
  provider: string;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  paymentMethodOnFile: boolean;
  revenueCatAppUserId: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  createdAt: string;
}

interface SubscriptionsResponse {
  ok: boolean;
  items: SubscriptionItem[];
  total: number;
  limit: number;
  offset: number;
}

const PROVIDER_LABELS: Record<string, { label: string; cls: string }> = {
  stripe: { label: "Stripe", cls: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300" },
  revenuecat: { label: "RevenueCat", cls: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300" },
  none: { label: "None", cls: "bg-secondary text-muted-foreground" },
};

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  trialing: { label: "Trialing", cls: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300" },
  active: { label: "Active", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300" },
  past_due: { label: "Past due", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300" },
  grace: { label: "Grace", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" },
  locked: { label: "Locked", cls: "bg-destructive/10 text-destructive" },
  canceled: { label: "Canceled", cls: "bg-secondary text-muted-foreground" },
  legacy_free: { label: "Legacy free", cls: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300" },
};

const PAGE_SIZE = 50;

function SubscriptionsPanel() {
  const [page, setPage] = useState(0);
  const [providerFilter, setProviderFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
  if (providerFilter) params.set("provider", providerFilter);
  if (statusFilter) params.set("status", statusFilter);

  const query = useQuery<SubscriptionsResponse>({
    queryKey: ["admin-subscriptions", page, providerFilter, statusFilter],
    queryFn: () => apiFetch<SubscriptionsResponse>(`/admin/subscriptions?${params.toString()}`),
    retry: false,
  });

  const { blocked } = usePlatformAdminGate([query.error]);

  if (blocked) {
    return (
      <PanelShell title="Subscriptions" subtitle="View all billing subscriptions across the platform.">
        <PlatformAdminSetupNotice />
      </PanelShell>
    );
  }

  const data = query.data;
  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  function fmtDate(iso: string | null | undefined) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function ProviderBadge({ provider }: { provider: string }) {
    const meta = PROVIDER_LABELS[provider] ?? { label: provider, cls: "bg-secondary text-muted-foreground" };
    return <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${meta.cls}`}>{meta.label}</span>;
  }

  function StatusBadge({ status }: { status: string }) {
    const meta = STATUS_LABELS[status] ?? { label: status, cls: "bg-secondary text-muted-foreground" };
    return <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${meta.cls}`}>{meta.label}</span>;
  }

  return (
    <PanelShell
      title="Subscriptions"
      subtitle="All billing subscriptions across the platform — provider, status, and renewal date."
    >
      {/* Filters */}
      <div className="flex gap-3 flex-wrap items-center">
        <div className="flex items-center gap-1.5">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Provider</label>
          <select
            value={providerFilter}
            onChange={(e) => { setProviderFilter(e.target.value); setPage(0); }}
            className="h-8 px-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">All</option>
            <option value="stripe">Stripe</option>
            <option value="revenuecat">RevenueCat</option>
            <option value="none">None</option>
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}
            className="h-8 px-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">All</option>
            <option value="trialing">Trialing</option>
            <option value="active">Active</option>
            <option value="past_due">Past due</option>
            <option value="grace">Grace</option>
            <option value="locked">Locked</option>
            <option value="canceled">Canceled</option>
            <option value="legacy_free">Legacy free</option>
          </select>
        </div>
        {data && (
          <span className="ml-auto text-xs text-muted-foreground">
            {data.total} total
          </span>
        )}
      </div>

      {/* Error */}
      {query.isError && (
        <Alert tone="danger">{(query.error as Error)?.message ?? "Failed to load subscriptions."}</Alert>
      )}

      {/* Loading */}
      {query.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
          <Loader2 size={14} className="animate-spin" />
          Loading…
        </div>
      )}

      {/* Table */}
      {data && data.items.length === 0 && (
        <p className="text-sm text-muted-foreground py-4">No subscriptions found.</p>
      )}

      {data && data.items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left">
                <th className="px-3 py-2 text-[11px] uppercase tracking-wide font-medium text-muted-foreground whitespace-nowrap">Account</th>
                <th className="px-3 py-2 text-[11px] uppercase tracking-wide font-medium text-muted-foreground whitespace-nowrap">Provider</th>
                <th className="px-3 py-2 text-[11px] uppercase tracking-wide font-medium text-muted-foreground whitespace-nowrap">Status</th>
                <th className="px-3 py-2 text-[11px] uppercase tracking-wide font-medium text-muted-foreground whitespace-nowrap">Renews / Expires</th>
                <th className="px-3 py-2 text-[11px] uppercase tracking-wide font-medium text-muted-foreground whitespace-nowrap">RC App User ID</th>
                <th className="px-3 py-2 text-[11px] uppercase tracking-wide font-medium text-muted-foreground whitespace-nowrap">Stripe Customer</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item, idx) => (
                <tr
                  key={item.id}
                  className={`border-b border-border last:border-0 ${idx % 2 === 0 ? "" : "bg-secondary/20"}`}
                >
                  <td className="px-3 py-2.5 min-w-[160px]">
                    <div className="font-medium text-foreground truncate max-w-[200px]" title={item.subjectName}>
                      {item.subjectName}
                    </div>
                    <div className="text-[11px] text-muted-foreground capitalize">
                      {["lab_org", "provider_org"].includes(item.subjectType) && item.subjectOrgType
                        ? item.subjectOrgType
                        : item.subjectType.replace(/_/g, " ")}
                      {item.subjectEmail && <span className="ml-1">· {item.subjectEmail}</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <ProviderBadge provider={item.provider} />
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <StatusBadge status={item.status} />
                    {item.cancelAtPeriodEnd && (
                      <span className="ml-1 text-[10px] text-muted-foreground">(cancels)</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                    {fmtDate(item.currentPeriodEnd)}
                  </td>
                  <td className="px-3 py-2.5">
                    {item.revenueCatAppUserId ? (
                      <code className="text-[11px] font-mono text-muted-foreground bg-secondary/60 px-1.5 py-0.5 rounded">
                        {item.revenueCatAppUserId}
                      </code>
                    ) : (
                      <span className="text-[11px] text-muted-foreground/50">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {item.stripeCustomerId ? (
                      <code className="text-[11px] font-mono text-muted-foreground bg-secondary/60 px-1.5 py-0.5 rounded">
                        {item.stripeCustomerId}
                      </code>
                    ) : (
                      <span className="text-[11px] text-muted-foreground/50">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center gap-3 justify-end pt-1">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="h-8 px-3 rounded-md bg-secondary text-foreground text-xs font-medium hover:bg-secondary/80 disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-xs text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
            className="h-8 px-3 rounded-md bg-secondary text-foreground text-xs font-medium hover:bg-secondary/80 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </PanelShell>
  );
}

type EmailPrefsData = {
  caseNoteNotifications: boolean;
  orgInviteNotifications: boolean;
  statementEmails: boolean;
  billingReminders: boolean;
  installerAlerts: boolean;
  backupAlerts: boolean;
  cleanupAlerts: boolean;
};

type SmsPrefsData = {
  accountLinkInvites: boolean;
  caseNoteNotifications: boolean;
  billingReminders: boolean;
};

function NotificationsPanel({ isAdmin }: { isAdmin: boolean }) {
  const [prefs, setPrefs] = useState<EmailPrefsData>({
    caseNoteNotifications: true,
    orgInviteNotifications: true,
    statementEmails: true,
    billingReminders: true,
    installerAlerts: true,
    backupAlerts: true,
    cleanupAlerts: true,
  });
  const [smsPrefs, setSmsPrefs] = useState<SmsPrefsData>({
    accountLinkInvites: true,
    caseNoteNotifications: true,
    billingReminders: true,
  });
  const [saving, setSaving] = useState<Partial<Record<keyof EmailPrefsData, boolean>>>({});
  const [smsSaving, setSmsSaving] = useState<Partial<Record<keyof SmsPrefsData, boolean>>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<{ tone: "success" | "danger"; message: string } | null>(null);
  const saveStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    apiFetch("/users/me/email-preferences")
      .then((data: EmailPrefsData) => setPrefs(data))
      .catch((err: Error) => setLoadError(err.message || "Could not load preferences."));
    apiFetch("/users/me/sms-preferences")
      .then((data: SmsPrefsData) => setSmsPrefs(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
    };
  }, []);

  function showSaveStatus(tone: "success" | "danger", message: string) {
    if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
    setSaveStatus({ tone, message });
    saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 2500);
  }

  async function toggle(key: keyof EmailPrefsData, value: boolean) {
    setPrefs((p) => ({ ...p, [key]: value }));
    setSaving((s) => ({ ...s, [key]: true }));
    try {
      await apiFetch("/users/me/email-preferences", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
      showSaveStatus("success", "Preference saved.");
    } catch (err) {
      setPrefs((p) => ({ ...p, [key]: !value }));
      showSaveStatus("danger", (err instanceof Error ? err.message : null) || "Could not save preference.");
    } finally {
      setSaving((s) => ({ ...s, [key]: false }));
    }
  }

  async function toggleSms(key: keyof SmsPrefsData, value: boolean) {
    setSmsPrefs((p) => ({ ...p, [key]: value }));
    setSmsSaving((s) => ({ ...s, [key]: true }));
    try {
      await apiFetch("/users/me/sms-preferences", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
      showSaveStatus("success", "Preference saved.");
    } catch (err) {
      setSmsPrefs((p) => ({ ...p, [key]: !value }));
      showSaveStatus("danger", (err instanceof Error ? err.message : null) || "Could not save preference.");
    } finally {
      setSmsSaving((s) => ({ ...s, [key]: false }));
    }
  }

  const accountRows: Array<{ prefKey: keyof EmailPrefsData; label: string; desc: string }> = [
    {
      prefKey: "caseNoteNotifications",
      label: "Case note alerts",
      desc: "Receive an email when a note is added to one of your cases",
    },
    {
      prefKey: "orgInviteNotifications",
      label: "Lab invitations",
      desc: "Receive invitation emails when you are added to a lab or organization",
    },
    {
      prefKey: "statementEmails",
      label: "Monthly statements",
      desc: "Receive monthly billing statement PDFs by email",
    },
    {
      prefKey: "billingReminders",
      label: "Billing & subscription reminders",
      desc: "Trial expiry countdowns, payment-due notices, and account lock warnings",
    },
  ];

  const systemAlertRows: Array<{ prefKey: keyof EmailPrefsData; label: string; desc: string }> = [
    {
      prefKey: "backupAlerts",
      label: "Backup reports",
      desc: "Backup success and failure summaries",
    },
    {
      prefKey: "cleanupAlerts",
      label: "Media cleanup reports",
      desc: "Nightly orphaned case-media cleanup summaries and interrupted-run recovery notices",
    },
    {
      prefKey: "installerAlerts",
      label: "Desktop installer alerts",
      desc: "Auto-publish failures, nightly health-check warnings, and download-reachability errors",
    },
  ];

  const smsRows: Array<{ prefKey: keyof SmsPrefsData; label: string; desc: string }> = [
    {
      prefKey: "accountLinkInvites",
      label: "Lab link invites (SMS)",
      desc: "Receive a text when another lab adds you as a doctor and wants to link your accounts",
    },
    {
      prefKey: "caseNoteNotifications",
      label: "Case note alerts (SMS)",
      desc: "Receive a text when a note is added to one of your cases",
    },
    {
      prefKey: "billingReminders",
      label: "Billing reminders (SMS)",
      desc: "Trial expiry countdowns, payment-due notices, and account lock warnings via text",
    },
  ];

  function ToggleRow({ prefKey, label, desc }: { prefKey: keyof EmailPrefsData; label: string; desc: string }) {
    return (
      <div className="flex items-center justify-between px-4 py-3 bg-card">
        <div className="min-w-0 mr-6">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={prefs[prefKey]}
          disabled={!!saving[prefKey]}
          onClick={() => toggle(prefKey, !prefs[prefKey])}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${prefs[prefKey] ? "bg-primary" : "bg-input"}`}
        >
          <span
            className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${prefs[prefKey] ? "translate-x-5" : "translate-x-0"}`}
          />
        </button>
      </div>
    );
  }

  function SmsToggleRow({ prefKey, label, desc }: { prefKey: keyof SmsPrefsData; label: string; desc: string }) {
    return (
      <div className="flex items-center justify-between px-4 py-3 bg-card">
        <div className="min-w-0 mr-6">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={smsPrefs[prefKey]}
          disabled={!!smsSaving[prefKey]}
          onClick={() => toggleSms(prefKey, !smsPrefs[prefKey])}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${smsPrefs[prefKey] ? "bg-primary" : "bg-input"}`}
        >
          <span
            className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${smsPrefs[prefKey] ? "translate-x-5" : "translate-x-0"}`}
          />
        </button>
      </div>
    );
  }

  return (
    <PanelShell
      title="Notifications"
      subtitle="Choose which emails and texts LabTrax sends to you. Transactional messages (password resets, verification codes) are always sent."
    >
      {loadError && <Alert tone="danger">{loadError}</Alert>}
      {saveStatus && <Alert tone={saveStatus.tone}>{saveStatus.message}</Alert>}

      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-0.5">Email</p>
      </div>
      <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
        {accountRows.map((row) => (
          <ToggleRow key={row.prefKey} {...row} />
        ))}
      </div>

      {isAdmin && (
        <div className="space-y-2 pt-2">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-0.5">System alerts</p>
            <p className="text-xs text-muted-foreground">These alerts are only sent to admin accounts.</p>
          </div>
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
            {systemAlertRows.map((row) => (
              <ToggleRow key={row.prefKey} {...row} />
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2 pt-2">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-0.5">Text messages</p>
        </div>
        <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
          {smsRows.map((row) => (
            <SmsToggleRow key={row.prefKey} {...row} />
          ))}
        </div>
      </div>
    </PanelShell>
  );
}

function PanelShell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="p-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function Field({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (
    <div className={full ? "col-span-2" : ""}>
      <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

function Alert({ tone, children }: { tone: "danger" | "success" | "warning"; children: React.ReactNode }) {
  const cls =
    tone === "danger"
      ? "bg-destructive/10 text-destructive"
      : tone === "warning"
        ? "bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800/40"
        : "bg-success/15 text-success";
  return <div className={`text-sm rounded-md px-3 py-2 ${cls}`}>{children}</div>;
}
