import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Building2, Check, ChevronDown, ChevronRight, Clock, Copy, CreditCard, Download, ExternalLink, FileDown, Github, History, KeyRound, LayoutList, Loader2, LogOut, Monitor, Package, Play, RotateCcw, RefreshCcw, ShieldCheck, Smartphone, Sparkles, Trash2, Upload, User as UserIcon, Wrench } from "lucide-react";
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
import { apiFetch, ApiError, notifySessionCleared } from "@/lib/api";
import { usePlatformAdminGate, PlatformAdminSetupNotice } from "@/lib/platform-admin-gate";
import { formatPhone } from "@/lib/format";
import { useAuth } from "@/lib/auth-context";
import type { MeResponse, Organization } from "@/lib/types";

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

type TabKey = "profile" | "password" | "sessions" | "organizations" | "users" | "backup" | "desktop" | "mobile" | "itero" | "platform-admin" | "subscriptions" | "notifications";

const VALID_TAB_KEYS: TabKey[] = ["profile", "password", "sessions", "organizations", "users", "backup", "desktop", "mobile", "itero", "platform-admin", "subscriptions", "notifications"];

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
  const tabs: Array<{ key: TabKey; label: string; icon: typeof UserIcon; show: boolean }> = [
    { key: "profile", label: "Profile", icon: UserIcon, show: true },
    { key: "password", label: "Password", icon: KeyRound, show: true },
    { key: "sessions", label: "Active sessions", icon: Monitor, show: true },
    { key: "organizations", label: "Organizations", icon: Building2, show: true },
    { key: "users", label: "Users", icon: ShieldCheck, show: isAdmin },
    { key: "backup", label: "Backup", icon: ShieldCheck, show: isAdmin },
    { key: "desktop", label: "Desktop app", icon: Download, show: isAdmin },
    { key: "mobile", label: "Mobile app", icon: Smartphone, show: isAdmin && hasPlatformAdminBridge },
    { key: "itero", label: "iTero auto-import", icon: Sparkles, show: isAdmin && typeof window !== "undefined" && !!(window as { electronAPI?: { itero?: unknown } }).electronAPI?.itero },
    { key: "platform-admin", label: "Platform admin", icon: Wrench, show: isAdmin && hasPlatformAdminBridge },
    { key: "subscriptions", label: "Subscriptions", icon: CreditCard, show: isAdmin && hasPlatformAdminBridge },
    { key: "notifications", label: "Notifications", icon: Monitor, show: true },
  ];
  const [tab, setTab] = useState<TabKey>(readInitialTab);

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
            {tabs.filter((t) => t.show).map((t) => {
              const Icon = t.icon;
              const active = tab === t.key;
              return (
                <li key={t.key}>
                  <button
                    type="button"
                    onClick={() => setTab(t.key)}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                      active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                    }`}
                  >
                    <Icon size={14} />
                    {t.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="flex-1 min-w-0 bg-card border border-border rounded-xl">
          {tab === "profile" && <ProfilePanel />}
          {tab === "password" && <PasswordPanel />}
          {tab === "sessions" && <SessionsPanel />}
          {tab === "organizations" && <OrganizationsPanel />}
          {tab === "users" && isAdmin && <UsersPanel />}
          {tab === "backup" && isAdmin && <BackupPanel />}
          {tab === "desktop" && isAdmin && <DesktopInstallerPanel />}
          {tab === "mobile" && isAdmin && hasPlatformAdminBridge && <MobileBuildPanel />}
          {tab === "itero" && isAdmin && <IteroPanel />}
          {tab === "platform-admin" && isAdmin && hasPlatformAdminBridge && <PlatformAdminPanel />}
          {tab === "subscriptions" && isAdmin && hasPlatformAdminBridge && <SubscriptionsPanel />}
          {tab === "notifications" && <NotificationsPanel />}
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

function OrganizationsPanel() {
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

  return (
    <PanelShell title="Organizations" subtitle="Labs and practices you belong to.">
      {(meQuery.isLoading || orgsQuery.isLoading) && (
        <div className="text-sm text-muted-foreground">
          <Loader2 size={14} className="inline animate-spin mr-2" />
          Loading…
        </div>
      )}
      <div className="border border-border rounded-md divide-y divide-border">
        {memberships.length === 0 && !meQuery.isLoading && (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            You're not a member of any organization yet.
          </div>
        )}
        {memberships.map((m) => {
          const org = m.organization || orgsById.get(m.organizationId);
          const canBackfill =
            org?.type === "lab" &&
            m.status === "active" &&
            (m.role === "owner" || m.role === "admin");
          return (
            <div key={m.id} className="px-3 py-3 text-sm">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <div className="font-medium">{org?.displayName || org?.name || "Unknown"}</div>
                  <div className="text-xs text-muted-foreground capitalize">
                    {org?.type || "—"} · {org?.billingEmail || "no billing email"}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground capitalize">{m.role}</span>
                  <span className={`px-2 py-0.5 rounded-full ${m.status === "active" ? "bg-success/15 text-success" : "bg-warning/20 text-warning"}`}>
                    {m.status}
                  </span>
                </div>
              </div>
              {canBackfill && (
                <BackfillInvoicesRow
                  labOrganizationId={m.organizationId}
                  labName={org?.displayName || org?.name || "this lab"}
                />
              )}
            </div>
          );
        })}
      </div>
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

type BackupDestinationType = "onedrive" | "local" | "network";
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
  const [nowDest, setNowDest] = useState<BackupDestinationType>("onedrive");
  const [nowPath, setNowPath] = useState("");
  const [backupResult, setBackupResult] = useState<{ size: number; completedAt: string; fileName: string } | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  const [schedIntervalKey, setSchedIntervalKey] = useState<string>(intervalKey(1, "hours"));
  const [schedDest, setSchedDest] = useState<BackupDestinationType>("onedrive");
  const [schedPath, setSchedPath] = useState("");
  const [schedEnabled, setSchedEnabled] = useState(false);
  const [staleThresholdDays, setStaleThresholdDays] = useState(7);
  const [staleRateLimitDays, setStaleRateLimitDays] = useState(3);
  const [schedStaleDays, setSchedStaleDays] = useState<number>(DEFAULT_BACKUP_STALE_DAYS);
  const [schedError, setSchedError] = useState<string | null>(null);
  const [schedSuccess, setSchedSuccess] = useState(false);

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
      setSchedDest((scheduleQuery.data.destination as BackupDestinationType | null) ?? "onedrive");
      setSchedPath(scheduleQuery.data.path ?? "");
      setSchedEnabled(scheduleQuery.data.enabled);
      setStaleThresholdDays(scheduleQuery.data.staleAlertThresholdDays ?? 7);
      setStaleRateLimitDays(scheduleQuery.data.staleAlertRateLimitDays ?? 3);
      setSchedStaleDays(scheduleQuery.data.staleAfterDays ?? DEFAULT_BACKUP_STALE_DAYS);
    }
  }, [scheduleQuery.data]);

  const backupNowMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ size: number; completedAt: string; fileName: string }>("/admin/backup/run", {
        method: "POST",
        body: JSON.stringify({ destination: nowDest, path: nowPath.trim() || undefined }),
      }),
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
              {lastBackupAt ? "Backup overdue" : "No backup on record"}
            </p>
            <p className="text-amber-700 dark:text-amber-400">
              {lastBackupAt
                ? `Last successful backup was ${Math.floor((Date.now() - new Date(lastBackupAt).getTime()) / (24 * 60 * 60 * 1000))} day(s) ago.`
                : "No successful backup has been recorded."}
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
            Backup complete — {formatBackupSize(backupResult.size)} saved as{" "}
            <code className="font-mono text-xs">{backupResult.fileName}</code> at{" "}
            {new Date(backupResult.completedAt).toLocaleString()}.
          </Alert>
        )}

        <div className="space-y-3">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-2">Destination</div>
            <div className="flex flex-wrap gap-4">
              {(["onedrive", "local", "network"] as const).map((d) => (
                <label key={d} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="now-destination"
                    value={d}
                    checked={nowDest === d}
                    onChange={() => { setNowDest(d); setBackupResult(null); setBackupError(null); }}
                    className="accent-primary"
                  />
                  {d === "onedrive" ? "OneDrive" : d === "local" ? "Local folder / USB" : "Network server"}
                </label>
              ))}
            </div>
          </div>

          {needsPath(nowDest) && (
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  {nowDest === "local" ? "Folder path" : "Network path (UNC/SMB or SFTP URL)"}
                </label>
                <input
                  value={nowPath}
                  onChange={(e) => setNowPath(e.target.value)}
                  placeholder={nowDest === "local" ? "C:\\Backups\\LabTrax" : "\\\\server\\share\\LabTrax"}
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
                  <option value="onedrive">OneDrive</option>
                  <option value="local">Local folder / USB</option>
                  <option value="network">Network server</option>
                </select>
              </Field>
            </div>

            {needsPath(schedDest) && (
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                    {schedDest === "local" ? "Folder path" : "Network path (UNC/SMB or SFTP URL)"}
                  </label>
                  <input
                    value={schedPath}
                    onChange={(e) => setSchedPath(e.target.value)}
                    placeholder={schedDest === "local" ? "C:\\Backups\\LabTrax" : "\\\\server\\share\\LabTrax"}
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

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => saveScheduleMutation.mutate()}
            disabled={
              saveScheduleMutation.isPending ||
              scheduleQuery.isLoading ||
              gate.blocked ||
              (schedEnabled && needsPath(schedDest) && !schedPath.trim())
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
        </div>
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
  const [useOneDrive, setUseOneDrive] = useState(false);
  const [restorePhase, setRestorePhase] = useState<RestorePhase>("idle");
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreSuccess, setRestoreSuccess] = useState(false);
  const [relaunchCountdown, setRelaunchCountdown] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hasOneDrive = !!scheduleData?.destination;

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
      setUseOneDrive(false);
    }
  }

  function handleNativeFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (f) {
      setSelectedFile(f);
      setUseOneDrive(false);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function openConfirm(fromOneDrive: boolean) {
    setUseOneDrive(fromOneDrive);
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
      if (useOneDrive) {
        await apiFetch("/admin/backup/restore/from-onedrive", { method: "POST" });
      } else if (selectedFile) {
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
                    {selectedFile && !useOneDrive && (
                      <span className="text-xs text-muted-foreground font-mono truncate max-w-[180px]" title={selectedFile.name}>
                        {selectedFile.name}
                      </span>
                    )}
                  </div>

                  {/* OneDrive option */}
                  {hasOneDrive && (
                    <button
                      type="button"
                      disabled={gate.blocked}
                      onClick={() => {
                        setSelectedFile(null);
                        setUseOneDrive(true);
                      }}
                      className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md border text-xs font-medium transition-colors disabled:opacity-60 ${useOneDrive ? "border-primary bg-primary/10 text-primary" : "border-border bg-background hover:bg-secondary"}`}
                    >
                      <RefreshCcw size={12} />
                      Restore from OneDrive (latest)
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  disabled={gate.blocked || (!selectedFile && !useOneDrive)}
                  onClick={() => openConfirm(useOneDrive)}
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
                  Source: <strong>{useOneDrive ? "Latest file in OneDrive (LabTrax Backups folder)" : (selectedFile?.name ?? "selected file")}</strong>
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

interface DesktopInstallerInfo {
  version: string;
  dbVersion: string | null;
  envVersion: string;
  downloadUrl: string;
  dbDownloadUrl: string | null;
  envDownloadUrl: string;
  fileName: string | null;
  repoUrl: string | null;
  urlError: string | null;
  repoUrlWarning?: string;
  releaseNotes: string | null;
  dbReleaseNotes: string | null;
  installerObject: { size: number; uploadedAt: string } | null;
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

function DesktopInstallerPanel() {
  const queryClient = useQueryClient();
  const [urlInput, setUrlInput] = useState<string>("");
  const [versionInput, setVersionInput] = useState<string>("");
  const [releaseNotesInput, setReleaseNotesInput] = useState<string>("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
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

  const query = useQuery({
    queryKey: ["admin", "desktop-installer"],
    queryFn: () => apiFetch<DesktopInstallerInfo>("/admin/settings/desktop-installer"),
  });

  useEffect(() => {
    if (query.data) {
      setUrlInput(query.data.downloadUrl);
      setVersionInput(query.data.version);
      setReleaseNotesInput(query.data.releaseNotes ?? "");
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

  const info = query.data;
  const isExe = info?.downloadUrl.toLowerCase().endsWith(".exe") ?? false;
  const isDmg = info?.downloadUrl.toLowerCase().endsWith(".dmg") ?? false;
  const isZip = info?.downloadUrl.toLowerCase().endsWith(".zip") ?? (!isExe && !isDmg);
  const hasDbOverrides = info !== undefined && (info.dbDownloadUrl !== null || info.dbVersion !== null || info.dbReleaseNotes !== null);

  const hasChanges =
    !!info &&
    (urlInput.trim() !== info.downloadUrl ||
      versionInput.trim() !== info.version ||
      (releaseNotesInput.trim() || null) !== info.releaseNotes);

  return (
    <PanelShell
      title="Desktop app"
      subtitle={
        isDmg
          ? "Download and distribute LabTrax Desktop to staff Mac machines."
          : "Download and distribute LabTrax Desktop to staff Windows machines."
      }
    >
      {query.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          Loading…
        </div>
      )}
      {query.error && (
        <Alert tone="danger">{(query.error as Error).message}</Alert>
      )}
      {info && (
        <div className="space-y-5">
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
                <a
                  href={info.downloadUrl}
                  download
                  className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 inline-flex items-center gap-2 shrink-0"
                >
                  <Download size={14} />
                  {isZip ? "Download Portable ZIP" : isDmg ? "Download macOS DMG" : "Download Installer"}
                </a>
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

          <div className="rounded-lg border border-border bg-secondary/20 px-5 py-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Package size={14} />
              Build a one-click installer
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              The NSIS setup wizard (<code className="font-mono bg-secondary px-1 py-0.5 rounded">LabTrax-Setup.exe</code>) is built by the{" "}
              <strong>Build Windows Installer (Test)</strong> workflow in GitHub Actions.
              Download <code className="font-mono bg-secondary px-1 py-0.5 rounded">LabTrax-Setup.exe</code> from the workflow run summary,
              upload it here, and set the <em>Download URL</em> above to{" "}
              <code className="font-mono bg-secondary px-1 py-0.5 rounded">/downloads/LabTrax-Setup.exe</code>.
            </p>
            <a
              href={info.repoUrl ? `${info.repoUrl.replace(/\/$/, "")}/actions` : "https://github.com/features/actions"}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline font-medium mt-1"
            >
              <ExternalLink size={11} />
              Open GitHub Actions
            </a>
          </div>

          <DesktopBuildCounterRecovery repoUrl={info.repoUrl} />
          <DesktopInstallerUploadsPanel />
          <DesktopInstallerHistoryPanel repoUrl={info.repoUrl} />
        </div>
      )}
    </PanelShell>
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
                          href={e.downloadUrl}
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
      {query.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          Loading…
        </div>
      )}
      {query.error && (
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
type ElectronWindow = Window & { electronAPI?: { showFolderDialog?: () => Promise<string | null>; showOpenDialog?: (opts: { title?: string; filters?: Array<{ name: string; extensions: string[] }>; properties?: string[] }) => Promise<string[] | null>; relaunch?: () => void; itero?: IteroAPI; platformAdmin?: PlatformAdminAPI } };

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

  if (!platformAdmin) {
    return (
      <PanelShell title="Platform admin" subtitle="Available in the desktop app only.">
        <div className="px-6 py-4 text-sm text-muted-foreground">
          The platform admin secret is stored on this machine via the OS keychain. Open this panel from the LabTrax Desktop app to configure it.
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

          {status?.recentImports && status.recentImports.length > 0 && (
            <div className="pt-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2">Recent imports (last 10)</div>
              <ul className="text-sm divide-y divide-border rounded-md border border-border">
                {status.recentImports.map((imp) => (
                  <li key={imp.iteroOrderId + imp.importedAt} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <div className="font-mono text-xs text-muted-foreground truncate">iTero #{imp.iteroOrderId}</div>
                      <div className="text-xs text-muted-foreground">{fmt(imp.importedAt)}</div>
                    </div>
                    {imp.caseId ? (
                      <a
                        href={`#/cases/${imp.caseId}`}
                        className="text-xs font-medium text-primary hover:underline whitespace-nowrap"
                      >
                        {imp.caseNumber ? `Case ${imp.caseNumber}` : "Open case"}
                      </a>
                    ) : (
                      <span className="text-xs text-muted-foreground">No case link</span>
                    )}
                  </li>
                ))}
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
};

function NotificationsPanel() {
  const [prefs, setPrefs] = useState<EmailPrefsData>({
    caseNoteNotifications: true,
    orgInviteNotifications: true,
    statementEmails: true,
    billingReminders: true,
  });
  const [saving, setSaving] = useState<Partial<Record<keyof EmailPrefsData, boolean>>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/users/me/email-preferences")
      .then((data: EmailPrefsData) => setPrefs(data))
      .catch((err: Error) => setLoadError(err.message || "Could not load preferences."));
  }, []);

  async function toggle(key: keyof EmailPrefsData, value: boolean) {
    setPrefs((p) => ({ ...p, [key]: value }));
    setSaving((s) => ({ ...s, [key]: true }));
    try {
      await apiFetch("/users/me/email-preferences", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
    } catch {
      setPrefs((p) => ({ ...p, [key]: !value }));
    } finally {
      setSaving((s) => ({ ...s, [key]: false }));
    }
  }

  const rows: Array<{ key: keyof EmailPrefsData; label: string; desc: string }> = [
    {
      key: "caseNoteNotifications",
      label: "Case note alerts",
      desc: "Receive an email when a note is sent on a case",
    },
    {
      key: "orgInviteNotifications",
      label: "Lab invitations",
      desc: "Receive invitation emails when you are added to a lab",
    },
    {
      key: "statementEmails",
      label: "Monthly statements",
      desc: "Receive monthly billing statement PDFs by email",
    },
    {
      key: "billingReminders",
      label: "Billing reminders",
      desc: "Trial expiry, payment due, and account status alerts",
    },
  ];

  return (
    <PanelShell
      title="Email Notifications"
      subtitle="Choose which emails LabTrax sends to you. Transactional emails (password resets, verification codes) are always sent."
    >
      {loadError && <Alert tone="danger">{loadError}</Alert>}
      <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
        {rows.map(({ key, label, desc }) => (
          <div key={key} className="flex items-center justify-between px-4 py-3 bg-card">
            <div className="min-w-0 mr-6">
              <p className="text-sm font-medium text-foreground">{label}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={prefs[key]}
              disabled={!!saving[key]}
              onClick={() => toggle(key, !prefs[key])}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${prefs[key] ? "bg-primary" : "bg-input"}`}
            >
              <span
                className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${prefs[key] ? "translate-x-5" : "translate-x-0"}`}
              />
            </button>
          </div>
        ))}
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
