import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Pencil, Plus, Settings2, Trash2, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import {
  useBankAccounts,
  useLabOrganizations,
  useSelectedAccount,
  useSelectedOrg,
} from "@/lib/finance";
import type { BankAccount, TransactionCategory } from "@/lib/types";
import { formatMoney } from "@/lib/format";
import { formatPhone } from "@/lib/format";
import type { Vendor } from "./VendorCombobox";

const ALL_TABS = [
  { path: "/finance/register", label: "Register", billingOnly: false },
  { path: "/finance/receive-payments", label: "Receive Payments", billingOnly: true },
  { path: "/finance/reconcile", label: "Reconcile", billingOnly: false },
  { path: "/finance/cash-flow", label: "Cash Flow", billingOnly: false },
  { path: "/finance/recurring", label: "Recurring", billingOnly: false },
  { path: "/finance/payees", label: "Payees", billingOnly: false },
];

export function canReceivePayments(user: {
  userType?: string | null;
  role?: string | null;
} | null): boolean {
  if (!user) return false;
  if (user.userType !== "lab") return false;
  return user.role === "admin" || user.role === "billing";
}

type Props = {
  children: (ctx: {
    organizationId: string;
    accountId: string | null;
    accounts: BankAccount[];
  }) => ReactNode;
  requireAccount?: boolean;
};

export function FinanceShell({ children, requireAccount }: Props) {
  const [location] = useLocation();
  const { user } = useAuth();
  const billingAllowed = canReceivePayments(user);
  const TABS = ALL_TABS.filter((t) => !t.billingOnly || billingAllowed);
  const orgs = useLabOrganizations();
  const [orgId, setOrgId] = useSelectedOrg();
  const accounts = useBankAccounts(orgId);
  const [accountId, setAccountId] = useSelectedAccount(orgId);
  const [showManage, setShowManage] = useState(false);

  return (
    <div className="px-8 py-7">
      <div className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Financial</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Bank register, reconciliation, cash flow, and recurring entries.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={orgId || ""}
            onChange={(e) => setOrgId(e.target.value || null)}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          >
            {(orgs.data || []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.displayName || o.name}
              </option>
            ))}
            {!orgs.data?.length && <option value="">No labs available</option>}
          </select>
          <select
            value={accountId || ""}
            onChange={(e) => setAccountId(e.target.value || null)}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          >
            {(accounts.data || []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.last4 ? ` ··${a.last4}` : ""}
              </option>
            ))}
            {!accounts.data?.length && <option value="">No accounts yet</option>}
          </select>
          <button
            type="button"
            onClick={() => setShowManage(true)}
            className="h-9 px-3 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80 inline-flex items-center gap-1.5"
          >
            <Settings2 size={14} /> Manage
          </button>
        </div>
      </div>

      <div className="border-b border-border mb-5">
        <nav className="flex gap-1 -mb-px">
          {TABS.map((t) => {
            const active = location.startsWith(t.path);
            return (
              <Link
                key={t.path}
                href={t.path}
                className={`px-3.5 py-2 text-sm font-medium border-b-2 transition-colors ${
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {!orgId && (
        <div className="text-sm text-muted-foreground py-12 text-center">
          You need to be a member of a lab organization to use Finance.
        </div>
      )}

      {orgId && requireAccount && !accountId && (
        <div className="text-sm text-muted-foreground py-12 text-center border border-dashed border-border rounded-md">
          No bank accounts yet.{" "}
          <button
            type="button"
            className="text-primary font-medium hover:underline"
            onClick={() => setShowManage(true)}
          >
            Add an account
          </button>{" "}
          to get started.
        </div>
      )}

      {orgId && (!requireAccount || accountId) &&
        children({ organizationId: orgId, accountId, accounts: accounts.data || [] })}

      {showManage && orgId && (
        <ManageAccountsModal organizationId={orgId} onClose={() => setShowManage(false)} />
      )}
    </div>
  );
}

function ManageAccountsModal({
  organizationId,
  onClose,
}: {
  organizationId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const accounts = useBankAccounts(organizationId);
  const cats = useQuery({
    queryKey: ["finance", "categories", organizationId],
    queryFn: () =>
      apiFetch<TransactionCategory[]>(
        `/finance/categories?organizationId=${organizationId}`
      ),
  });
  const vendorsQuery = useQuery({
    queryKey: ["finance", "vendors", organizationId, "all"],
    queryFn: () =>
      apiFetch<Vendor[]>(
        `/finance/vendors?organizationId=${organizationId}&includeInactive=true`
      ),
  });

  const [name, setName] = useState("");
  const [institution, setInstitution] = useState("");
  const [last4, setLast4] = useState("");
  const [opening, setOpening] = useState("0");

  const [catName, setCatName] = useState("");
  const [catKind, setCatKind] = useState<"income" | "expense" | "transfer">("expense");

  // Vendor form state
  const [vendorName, setVendorName] = useState("");
  const [vendorAddress, setVendorAddress] = useState("");
  const [vendorPhone, setVendorPhone] = useState("");
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null);

  const addVendor = useMutation({
    mutationFn: () =>
      apiFetch("/finance/vendors", {
        method: "POST",
        body: JSON.stringify({
          organizationId,
          name: vendorName.trim(),
          address: vendorAddress.trim() || null,
          phone: vendorPhone.trim() || null,
        }),
      }),
    onSuccess: () => {
      setVendorName("");
      setVendorAddress("");
      setVendorPhone("");
      qc.invalidateQueries({ queryKey: ["finance", "vendors", organizationId] });
    },
  });

  const updateVendor = useMutation({
    mutationFn: (v: Vendor) =>
      apiFetch(`/finance/vendors/${v.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: v.name.trim(),
          address: v.address ?? null,
          phone: v.phone ?? null,
        }),
      }),
    onSuccess: () => {
      setEditingVendor(null);
      qc.invalidateQueries({ queryKey: ["finance", "vendors", organizationId] });
    },
  });

  const deleteVendor = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/finance/vendors/${id}`, { method: "DELETE" }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["finance", "vendors", organizationId] }),
  });

  const settingsQuery = useQuery({
    queryKey: ["finance", "settings", organizationId],
    queryFn: () =>
      apiFetch<{ defaultBankAccountId: string | null }>(
        `/finance/settings?organizationId=${organizationId}`
      ),
  });
  const updateSettings = useMutation({
    mutationFn: (defaultBankAccountId: string | null) =>
      apiFetch("/finance/settings", {
        method: "PATCH",
        body: JSON.stringify({ organizationId, defaultBankAccountId }),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["finance", "settings", organizationId] }),
  });

  const addAccount = useMutation({
    mutationFn: () =>
      apiFetch("/finance/accounts", {
        method: "POST",
        body: JSON.stringify({
          organizationId,
          name,
          institution: institution || null,
          last4: last4 || null,
          openingBalance: Number(opening) || 0,
        }),
      }),
    onSuccess: () => {
      setName("");
      setInstitution("");
      setLast4("");
      setOpening("0");
      qc.invalidateQueries({ queryKey: ["finance", "accounts", organizationId] });
    },
  });

  const archiveAccount = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/finance/accounts/${id}`, { method: "DELETE" }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["finance", "accounts", organizationId] }),
  });

  const addCategory = useMutation({
    mutationFn: () =>
      apiFetch("/finance/categories", {
        method: "POST",
        body: JSON.stringify({ organizationId, name: catName, kind: catKind }),
      }),
    onSuccess: () => {
      setCatName("");
      qc.invalidateQueries({
        queryKey: ["finance", "categories", organizationId],
      });
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-foreground/30">
      <div className="w-full max-w-2xl bg-card border-l border-border h-full overflow-y-auto scrollbar-thin">
        <header className="sticky top-0 z-10 bg-card border-b border-border px-6 py-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">Manage accounts & categories</h2>
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-9 rounded-md hover:bg-secondary flex items-center justify-center"
          >
            <X size={16} />
          </button>
        </header>
        <div className="px-6 py-6 space-y-7">
          <section>
            <h3 className="text-sm font-semibold mb-3">Bank accounts</h3>
            <div className="border border-border rounded-md overflow-hidden mb-4">
              <table className="w-full text-sm">
                <thead className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">Name</th>
                    <th className="text-left font-medium px-3 py-2">Institution</th>
                    <th className="text-left font-medium px-3 py-2 w-16">Last 4</th>
                    <th className="text-right font-medium px-3 py-2">Book balance</th>
                    <th className="px-2 py-2 w-12" />
                  </tr>
                </thead>
                <tbody>
                  {(accounts.data || []).map((a) => (
                    <tr key={a.id} className="border-t border-border">
                      <td className="px-3 py-2">
                        {a.name}
                        {a.isArchived && (
                          <span className="ml-2 text-[10px] uppercase text-muted-foreground">
                            archived
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {a.institution || "—"}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {a.last4 || "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatMoney(a.bookBalance ?? a.openingBalance)}
                      </td>
                      <td className="px-2 py-2 text-right">
                        {!a.isArchived && (
                          <button
                            type="button"
                            onClick={() => archiveAccount.mutate(a.id)}
                            className="h-7 w-7 rounded hover:bg-secondary text-muted-foreground hover:text-destructive flex items-center justify-center"
                            aria-label="Archive"
                          >
                            <Archive size={13} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!accounts.data?.length && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                        No accounts yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Account name"
                className="h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
              <input
                value={institution}
                onChange={(e) => setInstitution(e.target.value)}
                placeholder="Institution"
                className="h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
              <input
                value={last4}
                onChange={(e) => setLast4(e.target.value.slice(0, 4))}
                placeholder="Last 4"
                className="h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
              <input
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
                placeholder="Opening balance"
                type="number"
                step="0.01"
                className="h-9 px-2.5 rounded-md bg-background border border-input text-sm text-right tabular-nums"
              />
            </div>
            <div className="flex justify-end mt-3">
              <button
                type="button"
                disabled={!name.trim() || addAccount.isPending}
                onClick={() => addAccount.mutate()}
                className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                <Plus size={14} /> Add account
              </button>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold mb-3">Invoice payment deposits</h3>
            <p className="text-xs text-muted-foreground mb-3">
              When an invoice is marked paid, a deposit is auto-posted to this account.
            </p>
            <select
              value={settingsQuery.data?.defaultBankAccountId || ""}
              onChange={(e) =>
                updateSettings.mutate(e.target.value || null)
              }
              className="h-9 px-2.5 rounded-md bg-background border border-input text-sm w-full max-w-sm"
            >
              <option value="">— No default (auto-deposits disabled) —</option>
              {(accounts.data || [])
                .filter((a) => !a.isArchived)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.last4 ? ` ····${a.last4}` : ""}
                  </option>
                ))}
            </select>
          </section>

          <section>
            <h3 className="text-sm font-semibold mb-3">Categories</h3>
            <div className="flex flex-wrap gap-2 mb-4">
              {(cats.data || []).map((c) => (
                <span
                  key={c.id}
                  className="inline-flex items-center gap-1 text-xs bg-secondary/60 px-2.5 py-1 rounded-full"
                >
                  <span className="text-foreground">{c.name}</span>
                  <span className="text-muted-foreground">· {c.kind}</span>
                </span>
              ))}
              {!cats.data?.length && (
                <span className="text-sm text-muted-foreground">No categories yet.</span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <input
                value={catName}
                onChange={(e) => setCatName(e.target.value)}
                placeholder="Category name"
                className="h-9 px-2.5 rounded-md bg-background border border-input text-sm col-span-2"
              />
              <select
                value={catKind}
                onChange={(e) => setCatKind(e.target.value as any)}
                className="h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              >
                <option value="expense">Expense</option>
                <option value="income">Income</option>
                <option value="transfer">Transfer</option>
              </select>
            </div>
            <div className="flex justify-end mt-3">
              <button
                type="button"
                disabled={!catName.trim() || addCategory.isPending}
                onClick={() => addCategory.mutate()}
                className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                <Plus size={14} /> Add category
              </button>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold mb-3">Vendors</h3>
            {(vendorsQuery.data ?? []).length > 0 && (
              <div className="border border-border rounded-md overflow-hidden mb-4">
                <table className="w-full text-sm">
                  <thead className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="text-left font-medium px-3 py-2">Name</th>
                      <th className="text-left font-medium px-3 py-2">Address</th>
                      <th className="text-left font-medium px-3 py-2">Phone</th>
                      <th className="px-2 py-2 w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {(vendorsQuery.data ?? []).map((v) =>
                      editingVendor?.id === v.id ? (
                        <tr key={v.id} className="border-t border-border bg-secondary/10">
                          <td className="px-3 py-1.5">
                            <input
                              value={editingVendor.name}
                              onChange={(e) =>
                                setEditingVendor({ ...editingVendor, name: e.target.value })
                              }
                              className="h-8 px-2 rounded-md bg-background border border-input text-sm w-full"
                            />
                          </td>
                          <td className="px-3 py-1.5">
                            <input
                              value={editingVendor.address ?? ""}
                              onChange={(e) =>
                                setEditingVendor({ ...editingVendor, address: e.target.value || null })
                              }
                              className="h-8 px-2 rounded-md bg-background border border-input text-sm w-full"
                            />
                          </td>
                          <td className="px-3 py-1.5">
                            <input
                              value={editingVendor.phone ?? ""}
                              onChange={(e) =>
                                setEditingVendor({ ...editingVendor, phone: e.target.value || null })
                              }
                              className="h-8 px-2 rounded-md bg-background border border-input text-sm w-full"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <div className="flex items-center gap-1 justify-end">
                              <button
                                type="button"
                                onClick={() => updateVendor.mutate(editingVendor)}
                                disabled={!editingVendor.name.trim() || updateVendor.isPending}
                                className="h-7 px-2 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-60"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingVendor(null)}
                                className="h-7 w-7 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground"
                              >
                                <X size={13} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        <tr key={v.id} className="border-t border-border">
                          <td className="px-3 py-2 font-medium">{v.name}</td>
                          <td className="px-3 py-2 text-muted-foreground text-xs">
                            {v.address || "—"}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground text-xs">
                            {v.phone ? formatPhone(v.phone) : "—"}
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-1 justify-end">
                              <button
                                type="button"
                                onClick={() => setEditingVendor(v)}
                                className="h-7 w-7 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground"
                                aria-label="Edit vendor"
                              >
                                <Pencil size={13} />
                              </button>
                              <button
                                type="button"
                                onClick={() => deleteVendor.mutate(v.id)}
                                disabled={deleteVendor.isPending}
                                className="h-7 w-7 rounded-md hover:bg-destructive/10 flex items-center justify-center text-destructive disabled:opacity-50"
                                aria-label="Delete vendor"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            )}
            {!(vendorsQuery.data ?? []).length && (
              <p className="text-sm text-muted-foreground mb-4">No vendors yet.</p>
            )}
            <div className="grid grid-cols-3 gap-3">
              <input
                value={vendorName}
                onChange={(e) => setVendorName(e.target.value)}
                placeholder="Vendor name *"
                className="h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
              <input
                value={vendorAddress}
                onChange={(e) => setVendorAddress(e.target.value)}
                placeholder="Address"
                className="h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
              <input
                value={vendorPhone}
                onChange={(e) => setVendorPhone(e.target.value)}
                placeholder="Phone"
                className="h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
            </div>
            <div className="flex justify-end mt-3">
              <button
                type="button"
                disabled={!vendorName.trim() || addVendor.isPending}
                onClick={() => addVendor.mutate()}
                className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                <Plus size={14} /> Add vendor
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
