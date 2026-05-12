import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Loader2, Mail, Plus, Search, Send, Tag, Trash2, UserPlus, Users, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { Invoice, LabCase, MeResponse, Organization } from "@/lib/types";
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
  const [adding, setAdding] = useState(false);

  const meQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
  });

  const adminLabOrgIds = useMemo(() => {
    const ids: string[] = [];
    for (const m of meQuery.data?.memberships ?? []) {
      if (
        m.status === "active" &&
        ADMIN_ROLES.has(m.role) &&
        m.organization?.type === "lab"
      ) {
        ids.push(m.organizationId);
      }
    }
    return ids;
  }, [meQuery.data]);
  const canAddPractice = adminLabOrgIds.length > 0;

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
        <div className="flex items-center gap-3">
          <div className="text-sm text-muted-foreground">
            {filtered.length} of {orgs.length}
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
      {adding && (
        <AddPracticeDialog
          adminLabOrgIds={adminLabOrgIds}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

interface AddPracticeFields {
  name: string;
  displayName: string;
  billingEmail: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  doctorName: string;
  accountNumber: string;
  parentLabOrganizationId: string;
}

function AddPracticeDialog({
  adminLabOrgIds,
  onClose,
}: {
  adminLabOrgIds: string[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<AddPracticeFields>({
    name: "",
    displayName: "",
    billingEmail: "",
    phone: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    zip: "",
    country: "",
    doctorName: "",
    accountNumber: "",
    parentLabOrganizationId: adminLabOrgIds[0] ?? "",
  });

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
  });
  const labOptions = useMemo(
    () =>
      (orgsQuery.data ?? []).filter(
        (o) => o.type === "lab" && adminLabOrgIds.includes(o.id),
      ),
    [orgsQuery.data, adminLabOrgIds],
  );

  function update<K extends keyof AddPracticeFields>(key: K, value: AddPracticeFields[K]) {
    setFields((p) => ({ ...p, [key]: value }));
  }

  const createMutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        type: "provider",
        name: fields.name.trim(),
      };
      if (fields.displayName.trim()) payload.displayName = fields.displayName.trim();
      if (fields.billingEmail.trim()) payload.billingEmail = fields.billingEmail.trim();
      if (fields.phone.trim()) payload.phone = fields.phone.trim();
      if (fields.addressLine1.trim()) payload.addressLine1 = fields.addressLine1.trim();
      if (fields.addressLine2.trim()) payload.addressLine2 = fields.addressLine2.trim();
      if (fields.city.trim()) payload.city = fields.city.trim();
      if (fields.state.trim()) payload.state = fields.state.trim();
      if (fields.zip.trim()) payload.zip = fields.zip.trim();
      if (fields.country.trim()) payload.country = fields.country.trim();
      if (fields.doctorName.trim()) payload.doctorName = fields.doctorName.trim();
      if (fields.accountNumber.trim()) payload.accountNumber = fields.accountNumber.trim();
      if (fields.parentLabOrganizationId) {
        payload.parentLabOrganizationId = fields.parentLabOrganizationId;
      }
      return apiFetch<Organization>("/organizations", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      onClose();
    },
    onError: (err: Error) => setError(err.message || "Could not create practice."),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!fields.name.trim()) {
      setError("Practice name is required.");
      return;
    }
    if (adminLabOrgIds.length > 1 && !fields.parentLabOrganizationId) {
      setError("Choose which lab this practice belongs to.");
      return;
    }
    createMutation.mutate();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-card border border-border rounded-xl shadow-lg max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-6 py-4 border-b border-border flex items-center justify-between">
          <div>
            <div className="text-xs text-muted-foreground">New practice</div>
            <div className="text-sm font-semibold">Add a provider practice</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-9 rounded-md hover:bg-secondary flex items-center justify-center"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <form onSubmit={handleSubmit} className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-6 space-y-6">
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">{error}</div>
          )}

          <section className="grid grid-cols-2 gap-4">
            {labOptions.length > 1 && (
              <FormField label="Parent lab" full>
                <select
                  value={fields.parentLabOrganizationId}
                  onChange={(e) => update("parentLabOrganizationId", e.target.value)}
                  className={inputCls}
                >
                  <option value="">Select a lab…</option>
                  {labOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.displayName || o.name}
                    </option>
                  ))}
                </select>
              </FormField>
            )}
            <FormField label="Legal name">
              <input
                value={fields.name}
                onChange={(e) => update("name", e.target.value)}
                className={inputCls}
                required
                autoFocus
              />
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
            <FormField label="Primary doctor name" full>
              <input value={fields.doctorName} onChange={(e) => update("doctorName", e.target.value)} className={inputCls} />
              <div className="text-[11px] text-muted-foreground mt-1">
                Used to derive the auto account number when one isn't supplied below.
              </div>
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
            <FormField label="Country">
              <input value={fields.country} onChange={(e) => update("country", e.target.value)} className={inputCls} />
            </FormField>
            <FormField label="Account number (optional)" full>
              <input
                value={fields.accountNumber}
                onChange={(e) => update("accountNumber", e.target.value)}
                className={inputCls}
                placeholder="Leave blank to auto-generate"
              />
              <div className="text-[11px] text-muted-foreground mt-1">
                Must be unique within your lab. Leave blank to let LabTrax pick one.
              </div>
            </FormField>
          </section>
        </div>

        <footer className="px-6 py-4 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-md text-sm font-medium hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createMutation.isPending || !fields.name.trim()}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
          >
            {createMutation.isPending ? "Creating…" : "Create practice"}
          </button>
        </footer>
        </form>
      </div>
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
  accountNumber: string;
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
    accountNumber: org.accountNumber || "",
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
      accountNumber: d.accountNumber || "",
    });
  }, [detailQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => {
      // Only send `accountNumber` for provider practices that already have a
      // parent lab — the server rejects it otherwise. For other orgs we drop
      // it from the payload entirely.
      const { accountNumber, ...rest } = fields;
      const payload =
        org.type === "provider" && org.parentLabOrganizationId
          ? { ...rest, accountNumber }
          : rest;
      return apiFetch<Organization>(`/organizations/${org.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    },
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
            {org.type === "provider" && org.parentLabOrganizationId && (
              <FormField label="Account number" full>
                <input
                  value={fields.accountNumber}
                  onChange={(e) => update("accountNumber", e.target.value)}
                  className={inputCls}
                  placeholder="e.g. 123-JS-1"
                />
                <div className="text-[11px] text-muted-foreground mt-1">
                  Share this with the practice so they can claim their existing
                  cases when signing up. Must be unique within your lab.
                </div>
              </FormField>
            )}
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

  const cancelInviteMutation = useMutation({
    mutationFn: (inviteId: string) =>
      apiFetch(`/organizations/invites/${inviteId}/cancel`, { method: "POST" }),
    onSuccess: () => {
      setActionError(null);
      setInviteSuccess(null);
      queryClient.invalidateQueries({ queryKey: inviteKey });
    },
    onError: (err: Error) => setActionError(err.message || "Could not cancel invite."),
  });

  const resendInviteMutation = useMutation({
    mutationFn: (inviteId: string) =>
      apiFetch<PracticeInvite>(`/organizations/invites/${inviteId}/resend`, { method: "POST" }),
    onSuccess: (invite) => {
      setActionError(null);
      setInviteSuccess(`Invite resent to ${invite.email}.`);
      queryClient.invalidateQueries({ queryKey: inviteKey });
    },
    onError: (err: Error) => {
      setInviteSuccess(null);
      setActionError(err.message || "Could not resend invite.");
    },
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
              {pendingInvites.map((inv) => {
                const isResending =
                  resendInviteMutation.isPending && resendInviteMutation.variables === inv.id;
                const isCancelling =
                  cancelInviteMutation.isPending && cancelInviteMutation.variables === inv.id;
                const isBusy = isResending || isCancelling;
                return (
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
                    <button
                      type="button"
                      onClick={() => resendInviteMutation.mutate(inv.id)}
                      disabled={isBusy}
                      title="Resend invite"
                      className="h-8 w-8 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground flex items-center justify-center"
                    >
                      {isResending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!confirm(`Cancel the invite for ${inv.email}?`)) return;
                        cancelInviteMutation.mutate(inv.id);
                      }}
                      disabled={isBusy}
                      title="Cancel invite"
                      className="h-8 w-8 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground flex items-center justify-center"
                    >
                      {isCancelling ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
                    </button>
                  </div>
                );
              })}
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
