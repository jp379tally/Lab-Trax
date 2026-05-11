import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, BellRing, Check, ChevronDown, ChevronRight, Clock, Copy, Download, ExternalLink, Github, HardDrive, History, KeyRound, Loader2, LogOut, Monitor, Package, RotateCcw, ShieldCheck, Sparkles, Trash2, Upload, User as UserIcon, Wrench } from "lucide-react";
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
import { formatNextCleanupTime } from "@/lib/cleanup-schedule";
import { formatNextBackupTime } from "@/lib/backup-schedule";
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

type TabKey = "profile" | "password" | "sessions" | "organizations" | "users" | "storage" | "desktop" | "itero";

export default function SettingsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const tabs: Array<{ key: TabKey; label: string; icon: typeof UserIcon; show: boolean }> = [
    { key: "profile", label: "Profile", icon: UserIcon, show: true },
    { key: "password", label: "Password", icon: KeyRound, show: true },
    { key: "sessions", label: "Active sessions", icon: Monitor, show: true },
    { key: "organizations", label: "Organizations", icon: Building2, show: true },
    { key: "users", label: "Users", icon: ShieldCheck, show: isAdmin },
    { key: "storage", label: "Storage", icon: HardDrive, show: isAdmin },
    { key: "desktop", label: "Desktop app", icon: Download, show: isAdmin },
    { key: "itero", label: "iTero auto-import", icon: Sparkles, show: isAdmin && typeof window !== "undefined" && !!(window as { electronAPI?: { itero?: unknown } }).electronAPI?.itero },
  ];
  const [tab, setTab] = useState<TabKey>("profile");

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
          {tab === "storage" && isAdmin && <StoragePanel />}
          {tab === "desktop" && isAdmin && <DesktopInstallerPanel />}
          {tab === "itero" && isAdmin && <IteroPanel />}
        </div>
      </div>
    </div>
  );
}

function ProfilePanel() {
  const { user, refresh } = useAuth();
  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [practiceName, setPracticeName] = useState(user?.practiceName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    setFirstName(user?.firstName ?? "");
    setLastName(user?.lastName ?? "");
    setEmail(user?.email ?? "");
    setPracticeName(user?.practiceName ?? "");
  }, [user?.id]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error("Not signed in.");
      return apiFetch(`/auth/users/${user.id}/profile`, {
        method: "PUT",
        body: JSON.stringify({ firstName, lastName, email, practiceName }),
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

  return (
    <PanelShell title="Profile" subtitle="Your personal info shown across LabTrax.">
      {error && <Alert tone="danger">{error}</Alert>}
      {success && <Alert tone="success">Profile saved.</Alert>}
      <div className="grid grid-cols-2 gap-4">
        <Field label="First name">
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Last name">
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Email" full>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
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
    </PanelShell>
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

interface CleanupReport {
  ok: boolean;
  triggeredBy: string;
  dryRun: boolean;
  mediaDirExists: boolean;
  scannedFiles: number;
  referencedFiles: number;
  orphanCount: number;
  removedCount: number;
  freedBytes: number;
  sample: string[];
  errors: Array<{ fileName: string; error: string }>;
}

interface LastRun {
  at: string;
  removedCount: number;
  freedBytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

const LAST_RUN_KEY = "labtrax.admin.storage.lastRun";

interface CleanupAlertSettings {
  minRemoved: number;
  minFreedMb: number;
  dbMinRemoved: number | null;
  dbMinFreedMb: number | null;
  envMinRemoved: number;
  envMinFreedMb: number;
}

interface CleanupScheduleSettings {
  hourUtc: number;
  dbHourUtc: number | null;
  envHourUtc: number;
  retentionDays: number;
  dbRetentionDays: number | null;
  envRetentionDays: number;
  stuckTimeoutMinutes: number;
  dbStuckTimeoutMinutes: number | null;
  envStuckTimeoutMinutes: number;
}

function CleanupScheduleSettingsPanel() {
  const queryClient = useQueryClient();
  const [hourUtc, setHourUtc] = useState("");
  const [retentionDays, setRetentionDays] = useState("");
  const [stuckTimeoutMinutes, setStuckTimeoutMinutes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const settingsQuery = useQuery({
    queryKey: ["admin", "cleanup-schedule"],
    queryFn: () => apiFetch<CleanupScheduleSettings>("/admin/settings/cleanup-schedule"),
  });

  useEffect(() => {
    if (settingsQuery.data) {
      setHourUtc(String(settingsQuery.data.hourUtc));
      setRetentionDays(String(settingsQuery.data.retentionDays));
      setStuckTimeoutMinutes(String(settingsQuery.data.stuckTimeoutMinutes));
    }
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean; hourUtc: number; retentionDays: number; stuckTimeoutMinutes: number }>(
        "/admin/settings/cleanup-schedule",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            hourUtc: parseInt(hourUtc, 10),
            retentionDays: parseInt(retentionDays, 10),
            stuckTimeoutMinutes: parseInt(stuckTimeoutMinutes, 10),
          }),
        },
      ),
    onSuccess: () => {
      setError(null);
      setSuccess(true);
      queryClient.invalidateQueries({ queryKey: ["admin", "cleanup-schedule"] });
      setTimeout(() => setSuccess(false), 2500);
    },
    onError: (err: Error) => {
      setSuccess(false);
      setError(err.message || "Failed to save settings.");
    },
  });

  const resetHourMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean }>("/admin/settings/cleanup-schedule?field=hourUtc", {
        method: "DELETE",
      }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "cleanup-schedule"] });
    },
    onError: (err: Error) => {
      setError(err.message || "Failed to reset setting.");
    },
  });

  const resetRetentionMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean }>("/admin/settings/cleanup-schedule?field=retentionDays", {
        method: "DELETE",
      }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "cleanup-schedule"] });
    },
    onError: (err: Error) => {
      setError(err.message || "Failed to reset setting.");
    },
  });

  const resetStuckTimeoutMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean }>("/admin/settings/cleanup-schedule?field=stuckTimeoutMinutes", {
        method: "DELETE",
      }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "cleanup-schedule"] });
    },
    onError: (err: Error) => {
      setError(err.message || "Failed to reset setting.");
    },
  });

  const data = settingsQuery.data;

  return (
    <div className="border border-border rounded-lg p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Clock size={14} className="text-muted-foreground" />
        <h3 className="text-sm font-semibold">Cleanup schedule</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Controls when the nightly cleanup runs and how long its history is kept. The cleanup hour takes effect on the next server restart; history retention applies immediately on each run.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      {success && <Alert tone="success">Schedule saved.</Alert>}
      {settingsQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          Loading…
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cleanup hour (UTC, 0–23)">
            <input
              className={inputCls}
              type="number"
              min={0}
              max={23}
              step={1}
              value={hourUtc}
              onChange={(e) => setHourUtc(e.target.value)}
              placeholder={data ? String(data.envHourUtc) : "8"}
            />
            {data && data.dbHourUtc !== null ? (
              <button
                type="button"
                onClick={() => resetHourMutation.mutate()}
                disabled={resetHourMutation.isPending}
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-60"
              >
                {resetHourMutation.isPending ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <RotateCcw size={11} />
                )}
                Reset to default ({data.envHourUtc}:00 UTC)
              </button>
            ) : data ? (
              <p className="text-[11px] text-muted-foreground mt-1">
                Using env default: {data.envHourUtc}:00 UTC
              </p>
            ) : null}
          </Field>
          <Field label="History retention (days)">
            <input
              className={inputCls}
              type="number"
              min={1}
              step={1}
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
              placeholder={data ? String(data.envRetentionDays) : "365"}
            />
            {data && data.dbRetentionDays !== null ? (
              <button
                type="button"
                onClick={() => resetRetentionMutation.mutate()}
                disabled={resetRetentionMutation.isPending}
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-60"
              >
                {resetRetentionMutation.isPending ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <RotateCcw size={11} />
                )}
                Reset to default ({data.envRetentionDays} days)
              </button>
            ) : data ? (
              <p className="text-[11px] text-muted-foreground mt-1">
                Using env default: {data.envRetentionDays} days
              </p>
            ) : null}
          </Field>
          <Field label="Crash-recovery timeout (min)">
            <input
              className={inputCls}
              type="number"
              min={1}
              step={1}
              value={stuckTimeoutMinutes}
              onChange={(e) => setStuckTimeoutMinutes(e.target.value)}
              placeholder={data ? String(data.envStuckTimeoutMinutes) : "30"}
            />
            {data && data.dbStuckTimeoutMinutes !== null ? (
              <button
                type="button"
                onClick={() => resetStuckTimeoutMutation.mutate()}
                disabled={resetStuckTimeoutMutation.isPending}
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-60"
              >
                {resetStuckTimeoutMutation.isPending ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <RotateCcw size={11} />
                )}
                Reset to default ({data.envStuckTimeoutMinutes} min)
              </button>
            ) : data ? (
              <p className="text-[11px] text-muted-foreground mt-1">
                Using env default: {data.envStuckTimeoutMinutes} min
              </p>
            ) : null}
          </Field>
        </div>
      )}
      {(() => {
        const parsed = parseInt(hourUtc, 10);
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 23) {
          return (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Clock size={11} className="shrink-0" />
              Next run: <span className="text-foreground font-medium">{formatNextCleanupTime(parsed)}</span>
            </p>
          );
        }
        return null;
      })()}
      <button
        type="button"
        onClick={() => saveMutation.mutate()}
        disabled={saveMutation.isPending || settingsQuery.isLoading}
        className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-2"
      >
        {saveMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : null}
        {saveMutation.isPending ? "Saving…" : "Save schedule"}
      </button>
    </div>
  );
}

function CleanupAlertSettingsPanel() {
  const queryClient = useQueryClient();
  const [minRemoved, setMinRemoved] = useState("");
  const [minFreedMb, setMinFreedMb] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const settingsQuery = useQuery({
    queryKey: ["admin", "cleanup-alert-settings"],
    queryFn: () => apiFetch<CleanupAlertSettings>("/admin/settings/cleanup-alerts"),
  });

  useEffect(() => {
    if (settingsQuery.data) {
      setMinRemoved(String(settingsQuery.data.minRemoved));
      setMinFreedMb(String(settingsQuery.data.minFreedMb));
    }
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean; minRemoved: number; minFreedMb: number }>(
        "/admin/settings/cleanup-alerts",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            minRemoved: parseInt(minRemoved, 10),
            minFreedMb: parseFloat(minFreedMb),
          }),
        },
      ),
    onSuccess: () => {
      setError(null);
      setSuccess(true);
      queryClient.invalidateQueries({ queryKey: ["admin", "cleanup-alert-settings"] });
      setTimeout(() => setSuccess(false), 2500);
    },
    onError: (err: Error) => {
      setSuccess(false);
      setError(err.message || "Failed to save settings.");
    },
  });

  const resetMinRemovedMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean }>("/admin/settings/cleanup-alerts?field=minRemoved", {
        method: "DELETE",
      }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "cleanup-alert-settings"] });
    },
    onError: (err: Error) => {
      setError(err.message || "Failed to reset setting.");
    },
  });

  const resetMinFreedMbMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean }>("/admin/settings/cleanup-alerts?field=minFreedMb", {
        method: "DELETE",
      }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "cleanup-alert-settings"] });
    },
    onError: (err: Error) => {
      setError(err.message || "Failed to reset setting.");
    },
  });

  const data = settingsQuery.data;

  return (
    <div className="border border-border rounded-lg p-4 space-y-4">
      <div className="flex items-center gap-2">
        <BellRing size={14} className="text-muted-foreground" />
        <h3 className="text-sm font-semibold">Cleanup alert thresholds</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        The nightly cleanup job emails admins when it removes files or frees storage above these limits. Set "Min freed (MB)" to 0 to disable the freed-bytes threshold.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      {success && <Alert tone="success">Thresholds saved.</Alert>}
      {settingsQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          Loading…
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Min files removed">
            <input
              className={inputCls}
              type="number"
              min={1}
              step={1}
              value={minRemoved}
              onChange={(e) => setMinRemoved(e.target.value)}
              placeholder={data ? String(data.envMinRemoved) : "1"}
            />
            {data && data.dbMinRemoved !== null ? (
              <button
                type="button"
                onClick={() => resetMinRemovedMutation.mutate()}
                disabled={resetMinRemovedMutation.isPending}
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-60"
              >
                {resetMinRemovedMutation.isPending ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <RotateCcw size={11} />
                )}
                Reset to default ({data.envMinRemoved})
              </button>
            ) : data ? (
              <p className="text-[11px] text-muted-foreground mt-1">
                Using env default: {data.envMinRemoved}
              </p>
            ) : null}
          </Field>
          <Field label="Min freed (MB)">
            <input
              className={inputCls}
              type="number"
              min={0}
              step={0.1}
              value={minFreedMb}
              onChange={(e) => setMinFreedMb(e.target.value)}
              placeholder={data ? String(data.envMinFreedMb) : "0"}
            />
            {data && data.dbMinFreedMb !== null ? (
              <button
                type="button"
                onClick={() => resetMinFreedMbMutation.mutate()}
                disabled={resetMinFreedMbMutation.isPending}
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-60"
              >
                {resetMinFreedMbMutation.isPending ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <RotateCcw size={11} />
                )}
                Reset to default ({data.envMinFreedMb} MB)
              </button>
            ) : data ? (
              <p className="text-[11px] text-muted-foreground mt-1">
                Using env default: {data.envMinFreedMb} MB
              </p>
            ) : null}
          </Field>
        </div>
      )}
      <button
        type="button"
        onClick={() => saveMutation.mutate()}
        disabled={saveMutation.isPending || settingsQuery.isLoading}
        className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-2"
      >
        {saveMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : null}
        {saveMutation.isPending ? "Saving…" : "Save thresholds"}
      </button>
    </div>
  );
}

interface BackupScheduleSettings {
  hourUtc: number;
  dbHourUtc: number | null;
  envHourUtc: number;
}

function BackupSchedulePanel() {
  const queryClient = useQueryClient();
  const [hourUtc, setHourUtc] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const scheduleQuery = useQuery({
    queryKey: ["admin", "backup-schedule"],
    queryFn: () => apiFetch<BackupScheduleSettings>("/admin/settings/backup-schedule"),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (scheduleQuery.data) {
      setHourUtc(String(scheduleQuery.data.hourUtc));
    }
  }, [scheduleQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean; hourUtc: number }>(
        "/admin/settings/backup-schedule",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hourUtc: parseInt(hourUtc, 10) }),
        },
      ),
    onSuccess: () => {
      setError(null);
      setSuccess(true);
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-schedule"] });
      setTimeout(() => setSuccess(false), 2500);
    },
    onError: (err: Error) => {
      setSuccess(false);
      setError(err.message || "Failed to save settings.");
    },
  });

  const resetMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean }>("/admin/settings/backup-schedule?field=hourUtc", {
        method: "DELETE",
      }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-schedule"] });
    },
    onError: (err: Error) => {
      setError(err.message || "Failed to reset setting.");
    },
  });

  const data = scheduleQuery.data;

  const parsed = parseInt(hourUtc, 10);
  const previewLabel =
    !isNaN(parsed) && parsed >= 0 && parsed <= 23
      ? formatNextBackupTime(parsed)
      : null;

  return (
    <div className="border border-border rounded-lg p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Clock size={14} className="text-muted-foreground" />
        <h3 className="text-sm font-semibold">OneDrive backup schedule</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Controls when the nightly OneDrive backup runs. The backup hour takes effect on the next server restart.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      {success && <Alert tone="success">Schedule saved.</Alert>}
      {scheduleQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          Loading…
        </div>
      ) : (
        <Field label="Backup hour (UTC, 0–23)">
          <input
            className={inputCls}
            type="number"
            min={0}
            max={23}
            step={1}
            value={hourUtc}
            onChange={(e) => setHourUtc(e.target.value)}
            placeholder={data ? String(data.envHourUtc) : "7"}
          />
          {data && data.dbHourUtc !== null ? (
            <button
              type="button"
              onClick={() => resetMutation.mutate()}
              disabled={resetMutation.isPending}
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-60"
            >
              {resetMutation.isPending ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <RotateCcw size={11} />
              )}
              Reset to default ({data.envHourUtc}:00 UTC)
            </button>
          ) : data ? (
            <p className="text-[11px] text-muted-foreground mt-1">
              Using env default: {data.envHourUtc}:00 UTC
            </p>
          ) : null}
        </Field>
      )}
      {previewLabel && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Clock size={11} className="shrink-0" />
          Next backup: <span className="text-foreground font-medium">{previewLabel}</span>
        </p>
      )}
      <button
        type="button"
        onClick={() => saveMutation.mutate()}
        disabled={saveMutation.isPending || scheduleQuery.isLoading}
        className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-2"
      >
        {saveMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : null}
        {saveMutation.isPending ? "Saving…" : "Save schedule"}
      </button>
    </div>
  );
}

function StoragePanel() {
  const [report, setReport] = useState<CleanupReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<LastRun | null>(() => {
    try {
      const raw = localStorage.getItem(LAST_RUN_KEY);
      return raw ? (JSON.parse(raw) as LastRun) : null;
    } catch {
      return null;
    }
  });

  const scanMutation = useMutation({
    mutationFn: () =>
      apiFetch<CleanupReport>("/admin/cleanup/orphaned-media?dryRun=true", {
        method: "POST",
      }),
    onSuccess: (data) => {
      setReport(data);
      setError(null);
    },
    onError: (err: Error) => {
      setError(err.message || "Scan failed.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      apiFetch<CleanupReport>("/admin/cleanup/orphaned-media?dryRun=false", {
        method: "POST",
      }),
    onSuccess: (data) => {
      setReport(data);
      setError(null);
      const run: LastRun = {
        at: new Date().toISOString(),
        removedCount: data.removedCount,
        freedBytes: data.freedBytes,
      };
      setLastRun(run);
      try {
        localStorage.setItem(LAST_RUN_KEY, JSON.stringify(run));
      } catch {
        // ignore
      }
    },
    onError: (err: Error) => {
      setError(err.message || "Cleanup failed.");
    },
  });

  const busy = scanMutation.isPending || deleteMutation.isPending;

  return (
    <PanelShell
      title="Storage"
      subtitle="Scan for and remove orphaned case-media files that are no longer linked to any case."
    >
      {error && <Alert tone="danger">{error}</Alert>}

      {lastRun && (
        <div className="rounded-md bg-secondary/40 border border-border px-4 py-3 text-sm space-y-0.5">
          <div className="font-medium text-foreground">Last cleanup</div>
          <div className="text-xs text-muted-foreground">
            Ran {formatRelative(lastRun.at)} · removed {lastRun.removedCount} {lastRun.removedCount === 1 ? "file" : "files"} · freed {formatBytes(lastRun.freedBytes)}
          </div>
        </div>
      )}

      <div className="flex gap-3 items-center">
        <button
          type="button"
          onClick={() => scanMutation.mutate()}
          disabled={busy}
          className="h-9 px-4 rounded-md bg-secondary text-foreground text-sm font-medium hover:bg-secondary/80 disabled:opacity-60 inline-flex items-center gap-2"
        >
          {scanMutation.isPending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <HardDrive size={14} />
          )}
          {scanMutation.isPending ? "Scanning…" : "Scan for orphans"}
        </button>

        {report && report.dryRun && report.orphanCount > 0 && (
          <button
            type="button"
            onClick={() => {
              if (
                !window.confirm(
                  `Delete ${report.orphanCount} orphaned ${report.orphanCount === 1 ? "file" : "files"} (${formatBytes(report.freedBytes)})? This cannot be undone.`,
                )
              )
                return;
              deleteMutation.mutate();
            }}
            disabled={busy}
            className="h-9 px-4 rounded-md bg-destructive/10 text-destructive text-sm font-medium hover:bg-destructive/20 disabled:opacity-60 inline-flex items-center gap-2"
          >
            {deleteMutation.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Trash2 size={14} />
            )}
            {deleteMutation.isPending
              ? "Deleting…"
              : `Delete ${report.orphanCount} orphaned ${report.orphanCount === 1 ? "file" : "files"}`}
          </button>
        )}
      </div>

      {report && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Scanned", value: report.scannedFiles.toLocaleString() },
              { label: "Referenced", value: report.referencedFiles.toLocaleString() },
              { label: "Orphans", value: report.orphanCount.toLocaleString() },
              {
                label: report.dryRun ? "Reclaimable" : "Freed",
                value: formatBytes(report.freedBytes),
              },
            ].map(({ label, value }) => (
              <div
                key={label}
                className="rounded-lg border border-border bg-secondary/30 px-4 py-3 text-center"
              >
                <div className="text-xl font-semibold tabular-nums">{value}</div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mt-0.5">
                  {label}
                </div>
              </div>
            ))}
          </div>

          {!report.mediaDirExists && (
            <div className="text-sm text-muted-foreground rounded-md bg-secondary/40 border border-border px-3 py-2">
              The case-media upload directory does not exist yet — no files have been uploaded, so there is nothing to scan.
            </div>
          )}

          {!report.dryRun && report.removedCount > 0 && (
            <Alert tone="success">
              Removed {report.removedCount} {report.removedCount === 1 ? "file" : "files"} · freed {formatBytes(report.freedBytes)}.
            </Alert>
          )}

          {report.orphanCount === 0 && report.dryRun && report.mediaDirExists && (
            <div className="text-sm text-muted-foreground text-center py-2">
              No orphaned files found. Storage is clean.
            </div>
          )}

          {report.sample.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Sample orphaned files ({report.sample.length} shown)
              </div>
              <div className="border border-border rounded-md divide-y divide-border max-h-48 overflow-y-auto">
                {report.sample.map((name) => (
                  <div key={name} className="px-3 py-1.5 text-xs font-mono text-muted-foreground truncate">
                    {name}
                  </div>
                ))}
              </div>
            </div>
          )}

          {report.errors.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-destructive font-medium mb-1.5">
                Errors ({report.errors.length})
              </div>
              <div className="border border-destructive/30 rounded-md divide-y divide-border max-h-36 overflow-y-auto">
                {report.errors.map(({ fileName, error: errMsg }) => (
                  <div key={fileName} className="px-3 py-1.5 text-xs">
                    <span className="font-mono text-muted-foreground">{fileName}</span>
                    <span className="text-destructive ml-2">{errMsg}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      <CleanupScheduleSettingsPanel />
      <CleanupAlertSettingsPanel />
      <BackupSchedulePanel />
    </PanelShell>
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

function DesktopInstallerPanel() {
  const queryClient = useQueryClient();
  const [urlInput, setUrlInput] = useState<string>("");
  const [versionInput, setVersionInput] = useState<string>("");
  const [releaseNotesInput, setReleaseNotesInput] = useState<string>("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [duplicatePrompt, setDuplicatePrompt] = useState<{
    file: File;
    message: string;
  } | null>(null);
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
    uploadMutation.mutate({ file });
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
              <label className="text-xs font-medium text-muted-foreground">
                Release notes <span className="font-normal">(optional)</span>
              </label>
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
type ElectronWindow = Window & { electronAPI?: { itero?: IteroAPI } };

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
