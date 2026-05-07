import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, BellRing, Clock, HardDrive, KeyRound, Loader2, LogOut, Monitor, ShieldCheck, Trash2, User as UserIcon } from "lucide-react";
import { apiFetch, notifySessionCleared } from "@/lib/api";
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

type TabKey = "profile" | "password" | "sessions" | "organizations" | "users" | "storage";

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
          return (
            <div key={m.id} className="px-3 py-3 flex items-center justify-between text-sm">
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
          );
        })}
      </div>
    </PanelShell>
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
}

function CleanupScheduleSettingsPanel() {
  const queryClient = useQueryClient();
  const [hourUtc, setHourUtc] = useState("");
  const [retentionDays, setRetentionDays] = useState("");
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
    }
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean; hourUtc: number; retentionDays: number }>(
        "/admin/settings/cleanup-schedule",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            hourUtc: parseInt(hourUtc, 10),
            retentionDays: parseInt(retentionDays, 10),
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
            {data?.dbHourUtc === null && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Using env default: {data.envHourUtc}:00 UTC
              </p>
            )}
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
            {data?.dbRetentionDays === null && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Using env default: {data.envRetentionDays} days
              </p>
            )}
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
            {data?.dbMinRemoved === null && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Using env default: {data.envMinRemoved}
              </p>
            )}
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
            {data?.dbMinFreedMb === null && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Using env default: {data.envMinFreedMb}
              </p>
            )}
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
    </PanelShell>
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

function Alert({ tone, children }: { tone: "danger" | "success"; children: React.ReactNode }) {
  const cls = tone === "danger" ? "bg-destructive/10 text-destructive" : "bg-success/15 text-success";
  return <div className={`text-sm rounded-md px-3 py-2 ${cls}`}>{children}</div>;
}
