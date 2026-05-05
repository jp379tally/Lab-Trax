import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Loader2, Search, Users, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { Invoice, LabCase, Organization } from "@/lib/types";
import { formatMoney, relativeTime } from "@/lib/format";

interface PracticeMember {
  id: string;
  role: string;
  status: string;
  user: {
    id: string;
    username: string;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    initials?: string | null;
  } | null;
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

          <section>
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
              <Users size={14} /> Members
            </h3>
            <div className="border border-border rounded-md divide-y divide-border">
              {membersQuery.isLoading && (
                <div className="px-3 py-3 text-sm text-muted-foreground">Loading…</div>
              )}
              {!membersQuery.isLoading && (membersQuery.data ?? []).length === 0 && (
                <div className="px-3 py-3 text-sm text-muted-foreground">No members yet.</div>
              )}
              {(membersQuery.data ?? []).map((m) => (
                <div key={m.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium">
                      {[m.user?.firstName, m.user?.lastName].filter(Boolean).join(" ") || m.user?.username || "—"}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{m.user?.email || m.user?.username}</div>
                  </div>
                  <div className="text-xs flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground capitalize">{m.role}</span>
                    <span className={`px-2 py-0.5 rounded-full ${m.status === "active" ? "bg-success/15 text-success" : "bg-warning/20 text-warning"}`}>
                      {m.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>

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
