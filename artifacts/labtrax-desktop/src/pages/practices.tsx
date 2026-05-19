import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Building2, ChevronDown, ChevronRight, DollarSign, Link2, Loader2, Mail, Plus, Search, Send, Stethoscope, Tag, Trash2, UserPlus, Users, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { Invoice, LabCase, MeResponse, Organization } from "@/lib/types";
import { formatMoney, formatPhone, relativeTime } from "@/lib/format";

import { DEFAULT_PRICE_KEYS, priceKeyLabel } from "@/lib/pricing-keys";

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
    queryKey: ["organizations", { includeArchived: true }],
    queryFn: () =>
      apiFetch<Organization[]>("/organizations?includeArchived=true"),
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
  const [showArchived, setShowArchived] = useState(false);
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

  const archivedCount = useMemo(
    () => orgs.filter((o) => !!o.deletedAt).length,
    [orgs]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orgs
      .filter((o) => {
        if (!showArchived && o.deletedAt) return false;
        if (typeFilter !== "all" && o.type !== typeFilter) return false;
        if (!q) return true;
        return (
          o.name.toLowerCase().includes(q) ||
          (o.displayName || "").toLowerCase().includes(q) ||
          (o.billingEmail || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [orgs, search, typeFilter, showArchived]);

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
          <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground select-none cursor-pointer">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Show archived{archivedCount > 0 ? ` (${archivedCount})` : ""}
          </label>
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
                          <div className="font-medium flex items-center gap-2">
                            <span className={o.deletedAt ? "text-muted-foreground" : ""}>
                              {o.displayName || o.name}
                            </span>
                            {o.deletedAt && (
                              <span className="text-[10px] uppercase tracking-wide bg-secondary text-muted-foreground rounded px-1.5 py-0.5">
                                Archived
                              </span>
                            )}
                          </div>
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

interface NewDoctorRow {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

interface CreatedDoctor {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  platformAccountNumber: string | null;
}

export function AddPracticeDialog({
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
  const [doctors, setDoctors] = useState<NewDoctorRow[]>([]);
  const [doctorResults, setDoctorResults] = useState<{
    created: CreatedDoctor[];
    skipped: { index: number; reason: string }[];
  } | null>(null);
  const [creatingDoctors, setCreatingDoctors] = useState(false);
  // Once the practice itself is created, lock the practice form and switch
  // the CTA to "retry doctors" so a second submit can't create a duplicate
  // practice.
  const [createdOrgId, setCreatedOrgId] = useState<string | null>(null);

  function addDoctorRow() {
    setDoctors((rows) => [...rows, { firstName: "", lastName: "", email: "", phone: "" }]);
  }
  function updateDoctorRow(idx: number, key: keyof NewDoctorRow, value: string) {
    setDoctors((rows) => rows.map((r, i) => (i === idx ? { ...r, [key]: value } : r)));
  }
  function removeDoctorRow(idx: number) {
    setDoctors((rows) => rows.filter((_, i) => i !== idx));
  }

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
    onSuccess: async (org) => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      setCreatedOrgId(org.id);
      await submitDoctors(org.id);
    },
    onError: (err: Error) => setError(err.message || "Could not create practice."),
  });

  async function submitDoctors(orgId: string) {
    const validDoctors = doctors
      .map((d) => ({
        firstName: d.firstName.trim(),
        lastName: d.lastName.trim(),
        email: d.email.trim(),
        phone: d.phone.trim(),
      }))
      .filter((d) => d.firstName.length > 0);
    if (validDoctors.length === 0) {
      onClose();
      return;
    }
    setCreatingDoctors(true);
    setError(null);
    try {
      const result = await apiFetch<{
        created: CreatedDoctor[];
        skipped: { index: number; reason: string }[];
      }>(`/organizations/${orgId}/doctors`, {
        method: "POST",
        body: JSON.stringify({ doctors: validDoctors }),
      });
      setDoctorResults(result);
    } catch (err: any) {
      setError(
        (err?.message || "Practice was created, but adding doctors failed.") +
          " The practice was saved — click \"Retry adding doctors\" to try again.",
      );
    } finally {
      setCreatingDoctors(false);
    }
  }

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
    // Practice is already created — only retry the doctor batch instead of
    // creating a duplicate practice on resubmit.
    if (createdOrgId) {
      void submitDoctors(createdOrgId);
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
              <input value={fields.phone} onChange={(e) => update("phone", formatPhone(e.target.value))} className={inputCls} placeholder="000-000-0000" />
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

          <section className="border-t border-border pt-5">
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="text-sm font-semibold">Doctors at this practice</div>
                <div className="text-[11px] text-muted-foreground">
                  Optional. Each doctor gets their own platform account number on creation.
                </div>
              </div>
              <button
                type="button"
                onClick={addDoctorRow}
                className="h-8 px-3 rounded-md text-xs font-medium border border-border hover:bg-secondary inline-flex items-center gap-1"
              >
                <Plus size={14} /> Add doctor
              </button>
            </div>
            {doctors.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">
                No additional doctors. Click "Add doctor" to add one.
              </div>
            ) : (
              <div className="space-y-3">
                {doctors.map((d, idx) => (
                  <div
                    key={idx}
                    className="grid grid-cols-12 gap-2 items-start bg-muted/30 rounded-md p-3"
                  >
                    <div className="col-span-3">
                      <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                        First name
                      </label>
                      <input
                        value={d.firstName}
                        onChange={(e) => updateDoctorRow(idx, "firstName", e.target.value)}
                        className={inputCls}
                        placeholder="Jane"
                      />
                    </div>
                    <div className="col-span-3">
                      <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                        Last name
                      </label>
                      <input
                        value={d.lastName}
                        onChange={(e) => updateDoctorRow(idx, "lastName", e.target.value)}
                        className={inputCls}
                        placeholder="Smith"
                      />
                    </div>
                    <div className="col-span-3">
                      <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                        Email
                      </label>
                      <input
                        type="email"
                        value={d.email}
                        onChange={(e) => updateDoctorRow(idx, "email", e.target.value)}
                        className={inputCls}
                        placeholder="optional"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                        Phone
                      </label>
                      <input
                        value={d.phone}
                        onChange={(e) => updateDoctorRow(idx, "phone", formatPhone(e.target.value))}
                        className={inputCls}
                        placeholder="000-000-0000"
                      />
                    </div>
                    <div className="col-span-1 flex items-end justify-end h-full pt-4">
                      <button
                        type="button"
                        onClick={() => removeDoctorRow(idx)}
                        className="h-9 w-9 rounded-md hover:bg-destructive/10 text-destructive flex items-center justify-center"
                        aria-label="Remove doctor"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {doctorResults && (
            <section className="border-t border-border pt-5">
              <div className="text-sm font-semibold mb-2">Doctors created</div>
              <ul className="space-y-1 text-sm">
                {doctorResults.created.map((d) => (
                  <li key={d.id} className="flex items-center justify-between bg-muted/40 rounded px-3 py-2">
                    <span>
                      {[d.firstName, d.lastName].filter(Boolean).join(" ") || "Doctor"}
                      {d.email ? <span className="text-muted-foreground"> · {d.email}</span> : null}
                    </span>
                    <span className="font-mono text-xs bg-primary/10 text-primary rounded px-2 py-0.5">
                      {d.platformAccountNumber || "—"}
                    </span>
                  </li>
                ))}
              </ul>
              {doctorResults.skipped.length > 0 && (
                <div className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                  {doctorResults.skipped.length} doctor(s) skipped:
                  <ul className="list-disc list-inside mt-1">
                    {doctorResults.skipped.map((s, i) => (
                      <li key={i}>Row #{s.index + 1}: {s.reason}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
        </div>

        <footer className="px-6 py-4 border-t border-border flex items-center justify-end gap-2">
          {doctorResults ? (
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90"
            >
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="h-9 px-4 rounded-md text-sm font-medium hover:bg-secondary"
              >
                {createdOrgId ? "Close" : "Cancel"}
              </button>
              <button
                type="submit"
                disabled={createMutation.isPending || creatingDoctors || !fields.name.trim()}
                className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
              >
                {createMutation.isPending
                  ? "Creating practice…"
                  : creatingDoctors
                    ? "Adding doctors…"
                    : createdOrgId
                      ? "Retry adding doctors"
                      : "Create practice"}
              </button>
            </>
          )}
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
  statementEmailOptOut: boolean;
}

export function PracticeEditor({ org, onClose }: { org: Organization; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { user: currentUser } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [addDoctorOpen, setAddDoctorOpen] = useState(false);
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
    statementEmailOptOut: org.statementEmailOptOut ?? false,
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
      statementEmailOptOut: d.statementEmailOptOut ?? false,
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

  const liveOrg = detailQuery.data ?? org;
  const isArchived = !!liveOrg.deletedAt;
  const canArchive = org.type === "provider";

  const archiveMutation = useMutation({
    mutationFn: () =>
      apiFetch<Organization>(`/organizations/${org.id}/archive`, {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      queryClient.invalidateQueries({ queryKey: ["organization", org.id] });
      onClose();
    },
    onError: (err: Error) =>
      setError(err.message || "Could not archive practice."),
  });

  const restoreMutation = useMutation({
    mutationFn: () =>
      apiFetch<Organization>(`/organizations/${org.id}/restore`, {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      queryClient.invalidateQueries({ queryKey: ["organization", org.id] });
    },
    onError: (err: Error) =>
      setError(err.message || "Could not restore practice."),
  });

  function handleArchive() {
    if (
      !confirm(
        `Archive ${org.displayName || org.name}? It will be hidden from the practices list. Existing cases and invoices are preserved and you can restore it from the archived view.`,
      )
    ) {
      return;
    }
    setError(null);
    archiveMutation.mutate();
  }

  function handleRestore() {
    setError(null);
    restoreMutation.mutate();
  }

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
            {canArchive && !isArchived && (
              <button
                type="button"
                onClick={() => setAddDoctorOpen(true)}
                className="h-9 px-3 rounded-md text-sm font-medium border border-border hover:bg-secondary inline-flex items-center gap-1.5"
              >
                <UserPlus size={14} />
                Add doctor to practice
              </button>
            )}
            {canArchive && isArchived && (
              <button
                type="button"
                onClick={handleRestore}
                disabled={restoreMutation.isPending}
                className="h-9 px-3 rounded-md text-sm font-medium border border-border hover:bg-secondary inline-flex items-center gap-1.5 disabled:opacity-60"
              >
                {restoreMutation.isPending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <ArchiveRestore size={14} />
                )}
                Restore
              </button>
            )}
            {canArchive && !isArchived && (
              <button
                type="button"
                onClick={handleArchive}
                disabled={archiveMutation.isPending}
                className="h-9 px-3 rounded-md text-sm font-medium text-destructive hover:bg-destructive/10 inline-flex items-center gap-1.5 disabled:opacity-60"
              >
                {archiveMutation.isPending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Archive size={14} />
                )}
                Archive
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setError(null);
                saveMutation.mutate();
              }}
              disabled={saveMutation.isPending || isArchived}
              title={isArchived ? "Restore this practice before editing." : undefined}
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
          {isArchived && (
            <div className="text-sm bg-secondary border border-border text-muted-foreground px-3 py-2 rounded-md flex items-center gap-2">
              <Archive size={14} />
              This practice is archived. Existing cases and invoices are
              preserved. Restore it to start booking new work again.
            </div>
          )}
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
              <input value={fields.phone} onChange={(e) => update("phone", formatPhone(e.target.value))} className={inputCls} placeholder="000-000-0000" />
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
            {org.type === "provider" && (
              <FormField label="Statement emails" full>
                <label className="inline-flex items-center gap-2 text-sm h-9 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={fields.statementEmailOptOut}
                    onChange={(e) => update("statementEmailOptOut", e.target.checked)}
                    className="h-4 w-4"
                  />
                  Opt out of automated statement emails
                </label>
                <div className="text-[11px] text-muted-foreground mt-1">
                  When checked, this practice will be skipped during monthly auto-send runs even if it has a billing email on file.
                </div>
              </FormField>
            )}
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
            <>
              <ConnectionTierSection
                providerOrg={org}
                currentUserId={currentUser?.id}
              />
              <PracticePricingSection
                providerOrg={org}
                currentUserId={currentUser?.id}
              />
            </>
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
      {addDoctorOpen && (
        <AddDoctorToPracticeDialog
          org={org}
          onClose={() => setAddDoctorOpen(false)}
        />
      )}
    </div>
  );
}

interface EligibleDoctor {
  id: string;
  username: string;
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  doctorName?: string | null;
  platformAccountNumber?: string | null;
  currentPractices: string[];
  virtual?: boolean;
}

function AddDoctorToPracticeDialog({
  org,
  onClose,
}: {
  org: Organization;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  const [selectedUserId, setSelectedUserId] = useState("");
  const [search, setSearch] = useState("");

  const eligibleQuery = useQuery({
    queryKey: ["organization", org.id, "eligible-doctors"],
    queryFn: () =>
      apiFetch<EligibleDoctor[]>(
        `/organizations/${org.id}/eligible-doctors`,
      ),
    enabled: mode === "existing",
  });

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ["organization", org.id, "members"] });
    queryClient.invalidateQueries({ queryKey: ["organization", org.id, "eligible-doctors"] });
    queryClient.invalidateQueries({ queryKey: ["organizations"] });
  }

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch<{
        created: Array<{ firstName?: string | null; lastName?: string | null; email?: string | null }>;
        skipped: Array<{ index: number; reason: string }>;
      }>(`/organizations/${org.id}/doctors`, {
        method: "POST",
        body: JSON.stringify({
          doctors: [
            {
              firstName: firstName.trim(),
              lastName: lastName.trim(),
              email: email.trim() || undefined,
              phone: phone.trim() || undefined,
            },
          ],
        }),
      }),
    onSuccess: (res) => {
      const skipped = res.skipped?.[0];
      if (skipped) {
        setError(skipped.reason || "Could not add doctor.");
        return;
      }
      const d = res.created?.[0];
      const name = [d?.firstName, d?.lastName].filter(Boolean).join(" ") || "Doctor";
      setSuccess(`${name} added to ${org.displayName || org.name}.`);
      setError(null);
      setFirstName("");
      setLastName("");
      setEmail("");
      setPhone("");
      invalidateAll();
    },
    onError: (err: Error) => setError(err.message || "Could not add doctor."),
  });

  const linkMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ firstName?: string | null; lastName?: string | null }>(
        `/organizations/${org.id}/doctors/link`,
        {
          method: "POST",
          body: JSON.stringify({ userId: selectedUserId }),
        },
      ),
    onSuccess: (res) => {
      const name = [res.firstName, res.lastName].filter(Boolean).join(" ") || "Doctor";
      setSuccess(`${name} linked to ${org.displayName || org.name}.`);
      setError(null);
      setSelectedUserId("");
      invalidateAll();
    },
    onError: (err: Error) => setError(err.message || "Could not link doctor."),
  });

  // Used when the user picks a "virtual" case-history doctor who has no
  // account yet — creates the account and links them in one step.
  const createFromCaseMutation = useMutation({
    mutationFn: (doc: EligibleDoctor) => {
      const raw = (doc.doctorName || doc.username || "").trim();
      // Strip common "Dr." prefix so the name fields aren't polluted.
      const stripped = raw.replace(/^dr\.?\s+/i, "").trim();
      const parts = stripped.split(/\s+/);
      const fName = parts[0] || "Doctor";
      const lName = parts.slice(1).join(" ") || undefined;
      return apiFetch<{
        created: Array<{ firstName?: string | null; lastName?: string | null }>;
        skipped: Array<{ index: number; reason: string }>;
      }>(`/organizations/${org.id}/doctors`, {
        method: "POST",
        body: JSON.stringify({
          doctors: [{ firstName: fName, lastName: lName }],
        }),
      });
    },
    onSuccess: (res) => {
      const skipped = res.skipped?.[0];
      if (skipped) {
        setError(skipped.reason || "Could not create doctor account.");
        return;
      }
      const d = res.created?.[0];
      const name = [d?.firstName, d?.lastName].filter(Boolean).join(" ") || "Doctor";
      setSuccess(`${name} added to ${org.displayName || org.name}.`);
      setError(null);
      setSelectedUserId("");
      invalidateAll();
    },
    onError: (err: Error) => setError(err.message || "Could not create doctor."),
  });

  const eligible = eligibleQuery.data ?? [];
  const filteredEligible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return eligible;
    return eligible.filter((u) => {
      const name = `${u.firstName ?? ""} ${u.lastName ?? ""}`.toLowerCase();
      return (
        name.includes(q) ||
        (u.email ?? "").toLowerCase().includes(q) ||
        (u.username ?? "").toLowerCase().includes(q) ||
        (u.platformAccountNumber ?? "").toLowerCase().includes(q)
      );
    });
  }, [eligible, search]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (mode === "new") {
      if (!firstName.trim()) {
        setError("First name is required.");
        return;
      }
      createMutation.mutate();
    } else {
      if (!selectedUserId) {
        setError("Pick a doctor from the list first.");
        return;
      }
      const selectedDoc = eligible.find((u) => u.id === selectedUserId);
      if (selectedDoc?.virtual) {
        createFromCaseMutation.mutate(selectedDoc);
      } else {
        linkMutation.mutate();
      }
    }
  }

  const submitting =
    createMutation.isPending ||
    linkMutation.isPending ||
    createFromCaseMutation.isPending;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/40"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
      >
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <div className="text-xs text-muted-foreground">Practice</div>
            <div className="text-sm font-semibold">
              {org.displayName || org.name}
            </div>
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

        <div className="px-5 pt-4">
          <div className="inline-flex rounded-md border border-border overflow-hidden text-sm">
            <button
              type="button"
              onClick={() => {
                setMode("new");
                setError(null);
                setSuccess(null);
              }}
              className={`px-3 h-8 inline-flex items-center gap-1.5 ${
                mode === "new"
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-secondary"
              }`}
            >
              <UserPlus size={13} /> Add new doctor
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("existing");
                setError(null);
                setSuccess(null);
              }}
              className={`px-3 h-8 inline-flex items-center gap-1.5 border-l border-border ${
                mode === "existing"
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-secondary"
              }`}
            >
              <Users size={13} /> Pick existing doctor
            </button>
          </div>
        </div>

        <div className="px-5 py-4 space-y-4">
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}
          {success && (
            <div className="text-sm text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 px-3 py-2 rounded-md">
              {success}
            </div>
          )}

          {mode === "new" ? (
            <div className="grid grid-cols-2 gap-3">
              <FormField label="First name">
                <input
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className={inputCls}
                  placeholder="Jane"
                  autoFocus
                />
              </FormField>
              <FormField label="Last name">
                <input
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className={inputCls}
                  placeholder="Smith"
                />
              </FormField>
              <FormField label="Email" full>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputCls}
                  placeholder="optional"
                />
              </FormField>
              <FormField label="Phone" full>
                <input
                  value={phone}
                  onChange={(e) => setPhone(formatPhone(e.target.value))}
                  className={inputCls}
                  placeholder="000-000-0000"
                />
              </FormField>
              <div className="col-span-2 text-[11px] text-muted-foreground">
                Creates a new doctor account at this practice. They'll receive
                their own platform account number.
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="relative">
                <Search
                  size={14}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search all existing doctors…"
                  className="w-full h-9 pl-8 pr-3 rounded-md bg-background border border-input text-sm"
                />
              </div>
              <div className="max-h-72 overflow-y-auto rounded-md border border-border divide-y divide-border bg-background">
                {eligibleQuery.isLoading && (
                  <div className="px-3 py-6 text-sm text-muted-foreground text-center">
                    <Loader2 size={14} className="inline animate-spin mr-2" />
                    Loading doctors…
                  </div>
                )}
                {eligibleQuery.error && (
                  <div className="px-3 py-6 text-sm text-destructive text-center">
                    {(eligibleQuery.error as Error).message}
                  </div>
                )}
                {!eligibleQuery.isLoading &&
                  !eligibleQuery.error &&
                  filteredEligible.length === 0 && (
                    <div className="px-3 py-6 text-sm text-muted-foreground text-center">
                      {eligible.length === 0
                        ? "No existing doctors on the platform to link yet."
                        : "No matches."}
                    </div>
                  )}
                {filteredEligible.map((u) => {
                  const checked = selectedUserId === u.id;
                  const name = u.virtual
                    ? (u.doctorName || u.username)
                    : ([u.firstName, u.lastName].filter(Boolean).join(" ") || u.username);
                  return (
                    <label
                      key={u.id}
                      className={`flex items-start gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-secondary/60 ${
                        checked ? "bg-primary/10" : ""
                      }`}
                    >
                      <input
                        type="radio"
                        name="eligible-doctor"
                        className="mt-1"
                        checked={checked}
                        onChange={() => setSelectedUserId(u.id)}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate flex items-center gap-1.5">
                          {name}
                          {u.virtual && (
                            <span className="text-[10px] bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 rounded px-1.5 py-0.5 shrink-0">
                              no account yet
                            </span>
                          )}
                          {!u.virtual && u.platformAccountNumber && (
                            <span className="text-[10px] font-mono bg-primary/10 text-primary rounded px-1.5 py-0.5 shrink-0">
                              {u.platformAccountNumber}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {u.virtual
                            ? "From case history — will create account"
                            : (u.email || u.phone || u.username)}
                        </div>
                        {!u.virtual && u.currentPractices.length > 0 && (
                          <div className="text-[11px] text-muted-foreground mt-0.5">
                            Currently at: {u.currentPractices.join(", ")}
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {eligible.some((u) => u.virtual)
                  ? "Doctors with accounts can be linked instantly. Doctors from case history will get a new account created."
                  : "Links any existing doctor on the platform to this practice without creating a duplicate account."}
              </div>
            </div>
          )}
        </div>

        <footer className="px-5 py-4 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-md text-sm font-medium hover:bg-secondary"
          >
            Close
          </button>
          <button
            type="submit"
            disabled={
              submitting ||
              (mode === "new" ? !firstName.trim() : !selectedUserId)
            }
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {mode === "new"
              ? "Add doctor"
              : eligible.find((u) => u.id === selectedUserId)?.virtual
                ? "Create & link doctor"
                : "Link doctor"}
          </button>
        </footer>
      </form>
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
        <ConnectPracticeToLab
          providerOrg={providerOrg}
          onConnected={() => {
            queryClient.invalidateQueries({
              queryKey: ["organization-connections", providerOrg.id],
            });
          }}
        />
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

// ── Connect practice to lab (creates + auto-approves an organization
// connection so the lab admin can immediately assign a default tier).
function ConnectPracticeToLab({
  providerOrg,
  onConnected,
}: {
  providerOrg: Organization;
  onConnected: () => void;
}) {
  const meQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
  });

  // Labs the current user can administer. We surface either:
  //   * the practice's parent lab if the user is an admin there, or
  //   * a picker over their admin labs if multiple
  const adminLabOrgs = useMemo(() => {
    const out: { id: string; name: string }[] = [];
    for (const m of meQuery.data?.memberships ?? []) {
      if (
        m.status === "active" &&
        (m.role === "owner" || m.role === "admin") &&
        m.organization?.type === "lab"
      ) {
        out.push({
          id: m.organizationId,
          name:
            (m.organization?.displayName as string | null) ||
            m.organization?.name ||
            "Lab",
        });
      }
    }
    return out;
  }, [meQuery.data]);

  const initialLabId = useMemo(() => {
    const parentId = providerOrg.parentLabOrganizationId ?? "";
    if (parentId && adminLabOrgs.some((l) => l.id === parentId))
      return parentId;
    return adminLabOrgs[0]?.id ?? "";
  }, [providerOrg.parentLabOrganizationId, adminLabOrgs]);

  const [labId, setLabId] = useState<string>(initialLabId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLabId(initialLabId);
  }, [initialLabId]);

  const connectMutation = useMutation({
    mutationFn: async () => {
      if (!labId) throw new Error("Pick a lab to connect this practice to.");
      const created = await apiFetch<{
        id?: string;
        alreadyExists?: boolean;
      }>(`/organizations/connections`, {
        method: "POST",
        body: JSON.stringify({
          labOrganizationId: labId,
          providerOrganizationId: providerOrg.id,
        }),
      });
      // Auto-approve if newly created (lab admin is on the lab side).
      if (created?.id) {
        try {
          await apiFetch(
            `/organizations/connections/${created.id}/approve`,
            { method: "POST" },
          );
        } catch {
          /* If approval fails (e.g. already approved on the other side),
             the connection is still usable and the dropdown will show
             the current status. */
        }
      }
      return created;
    },
    onSuccess: () => {
      setError(null);
      onConnected();
    },
    onError: (e: Error) =>
      setError(e.message || "Could not connect this practice to a lab."),
  });

  if (meQuery.isLoading) {
    return (
      <div className="text-sm text-muted-foreground border border-border rounded-md px-3 py-3">
        Loading…
      </div>
    );
  }

  if (adminLabOrgs.length === 0) {
    return (
      <div className="text-sm text-muted-foreground border border-border rounded-md px-3 py-3">
        No connection between this practice and one of your labs yet.
      </div>
    );
  }

  return (
    <div className="border border-border rounded-md px-3 py-3 space-y-2">
      <p className="text-xs text-muted-foreground">
        This practice isn't linked to any of your labs yet. Connect it to
        start assigning a pricing tier.
      </p>
      {error && (
        <div className="text-xs text-destructive bg-destructive/10 px-2 py-1 rounded">
          {error}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {adminLabOrgs.length > 1 ? (
          <select
            value={labId}
            onChange={(e) => setLabId(e.target.value)}
            className="h-8 px-2 rounded-md bg-background border border-input text-xs min-w-[180px]"
            disabled={connectMutation.isPending}
          >
            {adminLabOrgs.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-muted-foreground">
            Lab: <span className="font-medium text-foreground">{adminLabOrgs[0].name}</span>
          </span>
        )}
        <button
          type="button"
          onClick={() => connectMutation.mutate()}
          disabled={connectMutation.isPending || !labId}
          className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
        >
          {connectMutation.isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Link2 size={12} />
          )}
          Connect to lab
        </button>
      </div>
    </div>
  );
}

// ── Per-doctor pricing for a practice ──
//
// Lists every doctor known at this practice (sourced from the lab's case
// history) and lets a lab admin assign a tier override and/or per-item
// custom prices to each doctor inline. Backed by /api/pricing/overrides.
interface PracticePricingTier {
  id: string;
  labOrganizationId: string;
  name: string;
  prices: Record<string, number>;
}

interface PracticePricingOverride {
  id: string;
  labOrganizationId: string;
  doctorName: string;
  practiceName: string | null;
  providerOrganizationId: string | null;
  tierName: string | null;
  prices: Record<string, number>;
  notes: string | null;
}

interface PracticeOverridesResponse {
  labOrganizationId: string;
  keys: string[];
  overrides: PracticePricingOverride[];
}

interface PracticeTiersResponse {
  labOrganizationId: string;
  keys: string[];
  tiers: PracticePricingTier[];
}

function PracticePricingSection({
  providerOrg,
  currentUserId,
}: {
  providerOrg: Organization;
  currentUserId?: string;
}) {
  const queryClient = useQueryClient();

  const connectionsQuery = useQuery({
    queryKey: ["organization-connections", providerOrg.id, currentUserId],
    queryFn: () =>
      apiFetch<ConnectionRecord[]>(
        `/organizations/connections?providerOrganizationId=${encodeURIComponent(providerOrg.id)}`,
      ),
    enabled: !!currentUserId,
  });
  const labOrganizationId =
    connectionsQuery.data?.[0]?.labOrganizationId ?? null;
  // The practice's "default tier" (set in the section above) lives on the
  // organization_connections row. Surface it here so the per-doctor dropdown
  // can show "— Use practice default (Standard) —" instead of a bare label —
  // otherwise admins see two seemingly-conflicting selections (the practice
  // default tier picker AND a per-doctor "Use practice default") with no
  // hint that the second one resolves to the first.
  const practiceDefaultTierName: string | null =
    (connectionsQuery.data?.[0]?.tierName as string | null | undefined) ?? null;

  const casesQuery = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
    enabled: !!currentUserId,
  });

  const tiersQuery = useQuery({
    queryKey: ["pricing-tiers-for-labs", labOrganizationId ?? ""],
    enabled: !!labOrganizationId,
    queryFn: () =>
      apiFetch<PracticeTiersResponse>(
        `/pricing/tiers?labOrganizationId=${encodeURIComponent(labOrganizationId!)}`,
      ),
  });
  const tiers = tiersQuery.data?.tiers ?? [];

  const overridesQuery = useQuery({
    queryKey: ["pricing-overrides", labOrganizationId ?? ""],
    enabled: !!labOrganizationId,
    queryFn: () =>
      apiFetch<PracticeOverridesResponse>(
        `/pricing/overrides?labOrganizationId=${encodeURIComponent(labOrganizationId!)}`,
      ),
  });
  const allOverrides = overridesQuery.data?.overrides ?? [];

  // Distinct doctors at this practice (from cases).
  const doctorsAtPractice = useMemo(() => {
    const set = new Map<string, string>(); // lower → display
    for (const c of casesQuery.data ?? []) {
      if (c.providerOrganizationId !== providerOrg.id) continue;
      const name = (c.doctorName || "").trim();
      if (!name) continue;
      const k = name.toLowerCase();
      if (!set.has(k)) set.set(k, name);
    }
    // Also merge in any existing overrides linked by providerOrganizationId
    // even if they have no cases yet, so admins can edit them here.
    for (const o of allOverrides) {
      if (o.providerOrganizationId !== providerOrg.id) continue;
      const name = (o.doctorName || "").trim();
      if (!name) continue;
      const k = name.toLowerCase();
      if (!set.has(k)) set.set(k, name);
    }
    return Array.from(set.values()).sort((a, b) => a.localeCompare(b));
  }, [casesQuery.data, allOverrides, providerOrg.id]);

  if (!currentUserId) return null;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold flex items-center gap-2">
        <Stethoscope size={14} /> Per-doctor pricing
      </h3>
      <p className="text-xs text-muted-foreground">
        Override the practice's default tier for a specific doctor, or set
        custom item prices that beat any tier. Leave a price blank to fall
        back to the doctor's tier (or the practice's default tier).
      </p>

      {!labOrganizationId && (
        <div className="text-xs text-muted-foreground border border-border rounded-md px-3 py-3">
          Connect this practice to one of your labs above to start
          assigning per-doctor pricing.
        </div>
      )}

      {labOrganizationId && (overridesQuery.isLoading || casesQuery.isLoading) && (
        <div className="text-sm text-muted-foreground">Loading doctors…</div>
      )}

      {labOrganizationId &&
        !overridesQuery.isLoading &&
        !casesQuery.isLoading &&
        doctorsAtPractice.length === 0 && (
          <div className="text-xs text-muted-foreground border border-border rounded-md px-3 py-3">
            No doctors on file for this practice yet. They'll appear here
            after their first case is created.
          </div>
        )}

      {labOrganizationId && doctorsAtPractice.length > 0 && (
        <div className="border border-border rounded-md divide-y divide-border">
          {doctorsAtPractice.map((doctorName) => {
            const existing =
              allOverrides.find(
                (o) =>
                  o.doctorName.trim().toLowerCase() ===
                  doctorName.toLowerCase(),
              ) ?? null;
            return (
              <DoctorPricingRow
                key={doctorName}
                doctorName={doctorName}
                providerOrg={providerOrg}
                labOrganizationId={labOrganizationId}
                tiers={tiers}
                existing={existing}
                practiceDefaultTierName={practiceDefaultTierName}
                onSaved={() => {
                  queryClient.invalidateQueries({
                    queryKey: ["pricing-overrides", labOrganizationId],
                  });
                }}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function DoctorPricingRow({
  doctorName,
  providerOrg,
  labOrganizationId,
  tiers,
  existing,
  practiceDefaultTierName,
  onSaved,
}: {
  doctorName: string;
  providerOrg: Organization;
  labOrganizationId: string;
  tiers: PracticePricingTier[];
  existing: PracticePricingOverride | null;
  practiceDefaultTierName: string | null;
  onSaved: () => void;
}) {
  // The "use practice default" option in the per-doctor dropdown resolves to
  // whatever tier the practice has set in the section above. Surface that
  // resolved name in both the dropdown label and the row subtitle so admins
  // aren't left guessing which tier wins.
  const practiceDefaultLabel = practiceDefaultTierName
    ? `— Use practice default (${practiceDefaultTierName}) —`
    : "— Use practice default (no tier set) —";
  const subtitleTier = existing?.tierName
    ? `Tier: ${existing.tierName}`
    : practiceDefaultTierName
      ? `Tier: practice default (${practiceDefaultTierName})`
      : "Tier: practice default (no tier set)";
  const [open, setOpen] = useState(false);
  const [tierName, setTierName] = useState<string>(existing?.tierName ?? "");
  const [prices, setPrices] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const k of DEFAULT_PRICE_KEYS) {
      const v = Number(existing?.prices?.[k] ?? 0);
      out[k] = v > 0 ? v.toFixed(2) : "";
    }
    return out;
  });
  const [error, setError] = useState<string | null>(null);

  // If the cached override changes (e.g. after another save), reset state.
  useEffect(() => {
    setTierName(existing?.tierName ?? "");
    const out: Record<string, string> = {};
    for (const k of DEFAULT_PRICE_KEYS) {
      const v = Number(existing?.prices?.[k] ?? 0);
      out[k] = v > 0 ? v.toFixed(2) : "";
    }
    setPrices(out);
  }, [existing?.id, existing?.tierName, existing?.prices]);

  const nextPrices = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(prices)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[k] = n;
    }
    return out;
  }, [prices]);

  const customPriceCount = Object.keys(nextPrices).length;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        labOrganizationId,
        doctorName: doctorName.trim(),
        practiceName: providerOrg.displayName || providerOrg.name || null,
        providerOrganizationId: providerOrg.id,
        tierName: tierName.trim() ? tierName.trim() : null,
        prices: nextPrices,
      };
      if (existing) {
        return apiFetch<PracticePricingOverride>(
          `/pricing/overrides/${existing.id}`,
          { method: "PATCH", body: JSON.stringify(payload) },
        );
      }
      return apiFetch<PracticePricingOverride>(`/pricing/overrides`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: (e: Error) =>
      setError(e.message || "Could not save pricing for this doctor."),
  });

  const tierMissing =
    !!existing?.tierName &&
    !tiers.some(
      (t) => t.name.toLowerCase() === existing.tierName!.toLowerCase(),
    );

  return (
    <div className="px-3 py-2 text-sm space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="h-6 w-6 rounded hover:bg-secondary flex items-center justify-center"
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate">{doctorName}</div>
          <div className="text-[11px] text-muted-foreground truncate">
            {subtitleTier}
            {customPriceCount > 0
              ? ` · ${customPriceCount} custom price${customPriceCount === 1 ? "" : "s"}`
              : ""}
          </div>
        </div>
        <select
          value={tierName}
          onChange={(e) => setTierName(e.target.value)}
          className="h-8 px-2 rounded-md bg-background border border-input text-xs min-w-[160px]"
          disabled={saveMutation.isPending}
        >
          <option value="">{practiceDefaultLabel}</option>
          {tiers.map((t) => (
            <option key={t.id} value={t.name}>
              {t.name}
            </option>
          ))}
          {tierMissing && (
            <option value={existing!.tierName!}>
              {existing!.tierName} (missing)
            </option>
          )}
        </select>
      </div>

      {open && (
        <div className="pl-8 space-y-2">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {DEFAULT_PRICE_KEYS.map((k) => {
              const tierPrice = (() => {
                // Doctor's selected tier wins; otherwise fall back to the
                // practice's default tier so placeholders show the price the
                // case will actually use when the field is left blank.
                const effectiveTierName =
                  tierName.trim() || practiceDefaultTierName || "";
                if (!effectiveTierName) return 0;
                const t = tiers.find(
                  (tt) =>
                    tt.name.toLowerCase() === effectiveTierName.toLowerCase(),
                );
                const n = Number(t?.prices?.[k] ?? 0);
                return Number.isFinite(n) && n > 0 ? n : 0;
              })();
              return (
                <label
                  key={k}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="text-muted-foreground truncate">
                    {priceKeyLabel(k)}
                  </span>
                  <div className="relative">
                    <DollarSign
                      size={11}
                      className="absolute left-1.5 top-1.5 text-muted-foreground pointer-events-none"
                    />
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0"
                      placeholder={
                        tierPrice > 0 ? formatMoney(tierPrice) : "—"
                      }
                      value={prices[k] ?? ""}
                      onChange={(e) =>
                        setPrices((p) => ({ ...p, [k]: e.target.value }))
                      }
                      className="h-7 pl-5 pr-2 w-24 rounded-md bg-background border border-input text-xs text-right"
                      disabled={saveMutation.isPending}
                    />
                  </div>
                </label>
              );
            })}
          </div>
          {error && (
            <div className="text-xs text-destructive bg-destructive/10 px-2 py-1 rounded">
              {error}
            </div>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="h-7 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
            >
              {saveMutation.isPending && (
                <Loader2 size={12} className="animate-spin" />
              )}
              Save pricing
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
