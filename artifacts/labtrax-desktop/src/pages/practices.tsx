import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Loader2, Mail, Search, Tag, Trash2, UserPlus, Users, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { Invoice, LabCase, Organization } from "@/lib/types";
import { formatMoney, relativeTime } from "@/lib/format";

interface PracticeMember {
  id: string;
  role: string;
  status: string;
  userId: string;
  user: {
    id: string;
    username: string;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    initials?: string | null;
  } | null;
}

interface PracticeInvite {
  id: string;
  email: string;
  roleToAssign: string;
  status: string;
  expiresAt?: string | null;
  createdAt?: string | null;
}

const ASSIGNABLE_ROLES = ["admin", "user", "billing", "read_only"] as const;
const ADMIN_ROLES = new Set(["owner", "admin"]);

function roleLabel(role: string): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "admin":
      return "Admin";
    case "user":
      return "Member";
    case "billing":
      return "Billing";
    case "read_only":
      return "Read only";
    default:
      return role;
  }
}

export default function PracticesPage() {
  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
  });
  const casesQuery = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
  });
  const invoicesQuery = useQuery({
    queryKey: ["invoices"],
    queryFn: () => apiFetch<Invoice[]>("/invoices"),
  });

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [editing, setEditing] = useState<Organization | null>(null);

  const orgs = orgsQuery.data ?? [];
  const cases = casesQuery.data ?? [];
  const invoices = invoicesQuery.data ?? [];

  const stats = useMemo(() => {
    const map = new Map<string, { caseCount: number; openBalance: number; totalBilled: number }>();
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orgs
      .filter((o) => {
        if (typeFilter !== "all" && o.type !== typeFilter) return false;
        if (!q) return true;
        return (
          o.name.toLowerCase().includes(q) ||
          (o.displayName || "").toLowerCase().includes(q) ||
          (o.billingEmail || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [orgs, search, typeFilter]);

  const isLoading = orgsQuery.isLoading;
  const error = orgsQuery.error as Error | null;

  return (
    <div className="px-8 py-7">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Practices</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Provider organizations your lab works with, plus your own lab orgs.
          </p>
        </div>
        <div className="text-sm text-muted-foreground">
          {filtered.length} of {orgs.length}
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
              placeholder="Search practice…"
              className="w-full h-9 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
            />
          </div>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          >
            <option value="all">All types</option>
            <option value="lab">Lab</option>
            <option value="provider">Provider</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="text-left font-medium px-5 py-2.5">Practice</th>
                <th className="text-left font-medium py-2.5">Type</th>
                <th className="text-left font-medium py-2.5">Contact</th>
                <th className="text-left font-medium py-2.5">Location</th>
                <th className="text-right font-medium py-2.5">Cases</th>
                <th className="text-right font-medium py-2.5">Billed</th>
                <th className="text-right font-medium px-5 py-2.5">Open balance</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading practices…
                  </td>
                </tr>
              )}
              {error && (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-destructive">{error.message}</td>
                </tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-muted-foreground">
                    No practices match the current filters.
                  </td>
                </tr>
              )}
              {filtered.map((o) => {
                const s = stats.get(o.id) ?? { caseCount: 0, openBalance: 0, totalBilled: 0 };
                return (
                  <tr
                    key={o.id}
                    onClick={() => setEditing(o)}
                    className="border-t border-border cursor-pointer hover:bg-secondary/40"
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="h-7 w-7 rounded-md bg-primary/10 text-primary flex items-center justify-center">
                          <Building2 size={13} />
                        </div>
                        <div>
                          <div className="font-medium">{o.displayName || o.name}</div>
                          {o.displayName && (
                            <div className="text-xs text-muted-foreground">{o.name}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="py-3">
                      <span className="text-[11px] uppercase tracking-wide bg-secondary text-secondary-foreground rounded-full px-2 py-0.5">
                        {o.type}
                      </span>
                    </td>
                    <td className="py-3 text-muted-foreground">
                      <div className="text-xs">{o.billingEmail || "—"}</div>
                      <div className="text-xs">{o.phone || ""}</div>
                    </td>
                    <td className="py-3 text-muted-foreground text-xs">
                      {[o.city, o.state].filter(Boolean).join(", ") || "—"}
                    </td>
                    <td className="py-3 text-right tabular-nums">{s.caseCount}</td>
                    <td className="py-3 text-right tabular-nums">{formatMoney(s.totalBilled)}</td>
                    <td className="px-5 py-3 text-right tabular-nums">
                      {s.openBalance > 0 ? (
                        <span className="text-warning font-medium">{formatMoney(s.openBalance)}</span>
                      ) : (
                        <span className="text-muted-foreground">{formatMoney(0)}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editing && <PracticeEditor org={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

interface PracticeFields {
  name: string;
  displayName: string;
  billingEmail: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zip: string;
  isActive: boolean;
}

function PracticeEditor({ org, onClose }: { org: Organization; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { user: currentUser } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<PracticeFields>({
    name: org.name || "",
    displayName: org.displayName || "",
    billingEmail: org.billingEmail || "",
    phone: org.phone || "",
    addressLine1: org.addressLine1 || "",
    addressLine2: org.addressLine2 || "",
    city: org.city || "",
    state: org.state || "",
    zip: org.zip || "",
    isActive: org.isActive ?? true,
  });

  const detailQuery = useQuery({
    queryKey: ["organization", org.id],
    queryFn: () => apiFetch<Organization>(`/organizations/${org.id}`),
  });

  const membersQuery = useQuery({
    queryKey: ["organization", org.id, "members"],
    queryFn: () => apiFetch<PracticeMember[]>(`/organizations/${org.id}/members`),
  });

  useEffect(() => {
    const d = detailQuery.data;
    if (!d) return;
    setFields({
      name: d.name || "",
      displayName: d.displayName || "",
      billingEmail: d.billingEmail || "",
      phone: d.phone || "",
      addressLine1: d.addressLine1 || "",
      addressLine2: d.addressLine2 || "",
      city: d.city || "",
      state: d.state || "",
      zip: d.zip || "",
      isActive: d.isActive ?? true,
    });
  }, [detailQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch<Organization>(`/organizations/${org.id}`, {
        method: "PATCH",
        body: JSON.stringify(fields),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      queryClient.invalidateQueries({ queryKey: ["organization", org.id] });
      onClose();
    },
    onError: (err: Error) => setError(err.message || "Save failed."),
  });

  function update<K extends keyof PracticeFields>(key: K, value: PracticeFields[K]) {
    setFields((p) => ({ ...p, [key]: value }));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-foreground/30">
      <div className="w-full max-w-2xl bg-card border-l border-border h-full overflow-y-auto scrollbar-thin">
        <header className="sticky top-0 z-10 bg-card border-b border-border px-6 py-4 flex items-center justify-between">
          <div>
            <div className="text-xs text-muted-foreground">Practice</div>
            <div className="text-sm font-semibold">{org.displayName || org.name}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setError(null);
                saveMutation.mutate();
              }}
              disabled={saveMutation.isPending}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
            >
              {saveMutation.isPending ? "Saving…" : "Save changes"}
            </button>
            <button type="button" onClick={onClose} className="h-9 w-9 rounded-md hover:bg-secondary flex items-center justify-center" aria-label="Close">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="px-6 py-6 space-y-6">
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">{error}</div>
          )}

          <section className="grid grid-cols-2 gap-4">
            <FormField label="Legal name">
              <input value={fields.name} onChange={(e) => update("name", e.target.value)} className={inputCls} />
            </FormField>
            <FormField label="Display name">
              <input value={fields.displayName} onChange={(e) => update("displayName", e.target.value)} className={inputCls} />
            </FormField>
            <FormField label="Billing email">
              <input type="email" value={fields.billingEmail} onChange={(e) => update("billingEmail", e.target.value)} className={inputCls} />
            </FormField>
            <FormField label="Phone">
              <input value={fields.phone} onChange={(e) => update("phone", e.target.value)} className={inputCls} />
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
            <FormField label="Status">
              <label className="inline-flex items-center gap-2 text-sm h-9">
                <input
                  type="checkbox"
                  checked={fields.isActive}
                  onChange={(e) => update("isActive", e.target.checked)}
                  className="h-4 w-4"
                />
                Active
              </label>
            </FormField>
          </section>

          {org.type === "provider" && (
            <ConnectionTierSection
              providerOrg={org}
              currentUserId={currentUser?.id}
            />
          )}

          <MembershipSection
            org={org}
            members={membersQuery.data ?? []}
            membersLoading={membersQuery.isLoading}
            currentUserId={currentUser?.id}
          />

          <section className="text-xs text-muted-foreground">
            Created {relativeTime(org.createdAt)} · Updated {relativeTime(org.updatedAt)}
          </section>
        </div>
      </div>
    </div>
  );
}

const inputCls = "w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm";

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

interface MembershipSectionProps {
  org: Organization;
  members: PracticeMember[];
  membersLoading: boolean;
  currentUserId?: string;
}

function MembershipSection({ org, members, membersLoading, currentUserId }: MembershipSectionProps) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<(typeof ASSIGNABLE_ROLES)[number]>("user");
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  const myMembership = members.find((m) => m.userId === currentUserId);
  const isAdmin = !!myMembership && ADMIN_ROLES.has(myMembership.role);

  const invitesQuery = useQuery({
    queryKey: ["organization", org.id, "invites"],
    queryFn: () => apiFetch<PracticeInvite[]>(`/organizations/${org.id}/invites`),
    enabled: isAdmin,
  });

  const memberKey = ["organization", org.id, "members"] as const;
  const inviteKey = ["organization", org.id, "invites"] as const;

  const inviteMutation = useMutation({
    mutationFn: () =>
      apiFetch<PracticeInvite>(`/organizations/${org.id}/invites`, {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail.trim(), roleToAssign: inviteRole }),
      }),
    onSuccess: (invite) => {
      setActionError(null);
      setInviteSuccess(`Invite sent to ${invite.email}.`);
      setInviteEmail("");
      setInviteRole("user");
      queryClient.invalidateQueries({ queryKey: inviteKey });
    },
    onError: (err: Error) => {
      setInviteSuccess(null);
      setActionError(err.message || "Could not send invite.");
    },
  });

  const roleMutation = useMutation({
    mutationFn: ({ membershipId, role }: { membershipId: string; role: string }) =>
      apiFetch(`/organizations/memberships/${membershipId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: memberKey });
    },
    onError: (err: Error) => setActionError(err.message || "Could not update role."),
  });

  const removeMutation = useMutation({
    mutationFn: (membershipId: string) =>
      apiFetch(`/organizations/memberships/${membershipId}`, { method: "DELETE" }),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: memberKey });
    },
    onError: (err: Error) => setActionError(err.message || "Could not remove member."),
  });

  const pendingInvites = (invitesQuery.data ?? []).filter((i) => i.status === "pending");

  const ownerCount = members.filter((m) => m.role === "owner" && m.status === "active").length;

  function handleInviteSubmit(e: React.FormEvent) {
    e.preventDefault();
    setActionError(null);
    setInviteSuccess(null);
    if (!inviteEmail.trim()) {
      setActionError("Enter an email address to invite.");
      return;
    }
    inviteMutation.mutate();
  }

  function handleRoleChange(member: PracticeMember, role: string) {
    if (role === member.role) return;
    if (member.role === "owner" && ownerCount <= 1) {
      setActionError("There must be at least one owner.");
      return;
    }
    roleMutation.mutate({ membershipId: member.id, role });
  }

  function handleRemove(member: PracticeMember) {
    if (member.role === "owner" && ownerCount <= 1) {
      setActionError("Cannot remove the last owner.");
      return;
    }
    const name =
      [member.user?.firstName, member.user?.lastName].filter(Boolean).join(" ") ||
      member.user?.username ||
      "this member";
    if (!confirm(`Remove ${name} from ${org.displayName || org.name}?`)) return;
    removeMutation.mutate(member.id);
  }

  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold flex items-center gap-2">
        <Users size={14} /> Members
      </h3>

      {actionError && (
        <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">{actionError}</div>
      )}

      <div className="border border-border rounded-md divide-y divide-border">
        {membersLoading && (
          <div className="px-3 py-3 text-sm text-muted-foreground">Loading…</div>
        )}
        {!membersLoading && members.length === 0 && (
          <div className="px-3 py-3 text-sm text-muted-foreground">No members yet.</div>
        )}
        {members.map((m) => {
          const isSelf = m.userId === currentUserId;
          const canEdit =
            isAdmin && !(m.role === "owner" && ownerCount <= 1) && !(isSelf && myMembership?.role === "owner" && ownerCount <= 1);
          const isBusy =
            (roleMutation.isPending && roleMutation.variables?.membershipId === m.id) ||
            (removeMutation.isPending && removeMutation.variables === m.id);
          return (
            <div key={m.id} className="flex items-center justify-between px-3 py-2 text-sm gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">
                  {[m.user?.firstName, m.user?.lastName].filter(Boolean).join(" ") || m.user?.username || "—"}
                  {isSelf && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                </div>
                <div className="text-xs text-muted-foreground truncate">{m.user?.email || m.user?.username}</div>
              </div>
              <div className="flex items-center gap-2">
                {isAdmin ? (
                  <select
                    value={m.role}
                    onChange={(e) => handleRoleChange(m, e.target.value)}
                    disabled={!canEdit || isBusy}
                    className="h-8 px-2 rounded-md bg-background border border-input text-xs"
                  >
                    {m.role === "owner" && <option value="owner">Owner</option>}
                    {ASSIGNABLE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {roleLabel(r)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground text-xs">
                    {roleLabel(m.role)}
                  </span>
                )}
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    m.status === "active" ? "bg-success/15 text-success" : "bg-warning/20 text-warning"
                  }`}
                >
                  {m.status}
                </span>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => handleRemove(m)}
                    disabled={!canEdit || isBusy}
                    title={isSelf ? "Leave this practice" : "Remove member"}
                    className="h-8 w-8 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground flex items-center justify-center"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {isAdmin && (
        <>
          <div>
            <h4 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2 flex items-center gap-1.5">
              <Mail size={12} /> Pending invites
            </h4>
            <div className="border border-border rounded-md divide-y divide-border">
              {invitesQuery.isLoading && (
                <div className="px-3 py-3 text-sm text-muted-foreground">Loading…</div>
              )}
              {!invitesQuery.isLoading && pendingInvites.length === 0 && (
                <div className="px-3 py-3 text-sm text-muted-foreground">No pending invites.</div>
              )}
              {pendingInvites.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between px-3 py-2 text-sm gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{inv.email}</div>
                    <div className="text-xs text-muted-foreground">
                      Invited {relativeTime(inv.createdAt)}
                      {inv.expiresAt ? ` · expires ${relativeTime(inv.expiresAt)}` : ""}
                    </div>
                  </div>
                  <span className="px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground text-xs">
                    {roleLabel(inv.roleToAssign)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <form onSubmit={handleInviteSubmit} className="border border-border rounded-md p-3 space-y-2">
            <h4 className="text-xs uppercase tracking-wide text-muted-foreground font-medium flex items-center gap-1.5">
              <UserPlus size={12} /> Invite a new member
            </h4>
            {inviteSuccess && (
              <div className="text-xs text-success bg-success/10 px-2 py-1.5 rounded">{inviteSuccess}</div>
            )}
            <div className="flex flex-wrap gap-2">
              <input
                type="email"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="person@example.com"
                className="flex-1 min-w-[200px] h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as (typeof ASSIGNABLE_ROLES)[number])}
                className="h-9 px-2 rounded-md bg-background border border-input text-sm"
              >
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={inviteMutation.isPending}
                className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {inviteMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
                Send invite
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}

interface ConnectionRecord {
  id: string;
  labOrganizationId: string;
  providerOrganizationId: string;
  status: string;
  tierName?: string | null;
  labOrganization?: { id: string; name: string; displayName?: string | null } | null;
}

interface PricingTierRecord {
  id: string;
  labOrganizationId: string;
  name: string;
}

interface PricingTiersResponse {
  labOrganizationId: string;
  tiers: PricingTierRecord[];
}

function ConnectionTierSection({
  providerOrg,
  currentUserId,
}: {
  providerOrg: Organization;
  currentUserId?: string;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const connectionsQuery = useQuery({
    queryKey: ["organization-connections", providerOrg.id, currentUserId],
    queryFn: () =>
      apiFetch<ConnectionRecord[]>(
        `/organizations/connections?providerOrganizationId=${encodeURIComponent(providerOrg.id)}`
      ),
    enabled: !!currentUserId,
  });

  const connections = connectionsQuery.data ?? [];
  const labIds = useMemo(
    () => [...new Set(connections.map((c) => c.labOrganizationId))],
    [connections]
  );

  const tiersByLabQueries = useQuery({
    queryKey: ["pricing-tiers-for-labs", labIds.sort().join(",")],
    enabled: labIds.length > 0,
    queryFn: async () => {
      const results = await Promise.all(
        labIds.map((labId) =>
          apiFetch<PricingTiersResponse>(
            `/pricing/tiers?labOrganizationId=${encodeURIComponent(labId)}`
          ).catch(() => null)
        )
      );
      const map: Record<string, PricingTierRecord[]> = {};
      results.forEach((r, i) => {
        if (r) map[labIds[i]] = r.tiers ?? [];
      });
      return map;
    },
  });

  const tierMutation = useMutation({
    mutationFn: ({
      connectionId,
      tierName,
    }: {
      connectionId: string;
      tierName: string | null;
    }) =>
      apiFetch<ConnectionRecord>(`/organizations/connections/${connectionId}`, {
        method: "PATCH",
        body: JSON.stringify({ tierName }),
      }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({
        queryKey: ["organization-connections", providerOrg.id],
      });
    },
    onError: (err: Error) =>
      setError(err.message || "Could not update default tier."),
  });

  if (!currentUserId) return null;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold flex items-center gap-2">
        <Tag size={14} /> Default pricing tier
      </h3>
      <p className="text-xs text-muted-foreground">
        Pick which tier this practice is on. New cases use this tier's prices
        when there is no per-doctor override.
      </p>

      {error && (
        <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
          {error}
        </div>
      )}

      {connectionsQuery.isLoading && (
        <div className="text-sm text-muted-foreground">Loading connections…</div>
      )}

      {!connectionsQuery.isLoading && connections.length === 0 && (
        <div className="text-sm text-muted-foreground border border-border rounded-md px-3 py-3">
          No connection between this practice and one of your labs yet.
        </div>
      )}

      <div className="border border-border rounded-md divide-y divide-border">
        {connections.map((c) => {
          const tiers = tiersByLabQueries.data?.[c.labOrganizationId] ?? [];
          const labName =
            c.labOrganization?.displayName ||
            c.labOrganization?.name ||
            "Your lab";
          const isBusy =
            tierMutation.isPending &&
            tierMutation.variables?.connectionId === c.id;
          return (
            <div
              key={c.id}
              className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{labName}</div>
                <div className="text-xs text-muted-foreground">
                  Status: {c.status}
                </div>
              </div>
              <select
                value={c.tierName ?? ""}
                disabled={isBusy || tiersByLabQueries.isLoading}
                onChange={(e) =>
                  tierMutation.mutate({
                    connectionId: c.id,
                    tierName: e.target.value === "" ? null : e.target.value,
                  })
                }
                className="h-8 px-2 rounded-md bg-background border border-input text-xs min-w-[160px]"
              >
                <option value="">— No default tier —</option>
                {tiers.map((t) => (
                  <option key={t.id} value={t.name}>
                    {t.name}
                  </option>
                ))}
                {c.tierName &&
                  !tiers.some((t) => t.name === c.tierName) && (
                    <option value={c.tierName}>
                      {c.tierName} (missing)
                    </option>
                  )}
              </select>
            </div>
          );
        })}
      </div>
    </section>
  );
}
