import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Redirect, useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Plus, Settings2, X } from "lucide-react";
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
import { LAB_ADMIN_ROLES, LAB_BILLING_ROLES, useLabMembershipRole } from "@/lib/membership-roles";

// Grouped so the two sides of the ledger read as separate bodies of work:
// what customers owe the lab (receivable) and what the lab owes vendors
// (payable), with the shared register and reporting tools after them.
const ALL_TABS = [
  { path: "/finance/register", label: "Register", billingOnly: false, group: null },
  { path: "/finance/receive-payments", label: "Receive Payments", billingOnly: true, group: "Receivable" },
  { path: "/finance/make-deposits", label: "Make Deposits", billingOnly: true, showUndepositedBadge: true, group: "Receivable" },
  { path: "/finance/bills", label: "Bills", billingOnly: true, group: "Payable" },
  { path: "/finance/pay-bills", label: "Pay Bills", billingOnly: true, group: "Payable" },
  { path: "/finance/aging", label: "Aging", billingOnly: true, group: "Payable" },
  { path: "/finance/reconcile", label: "Reconcile", billingOnly: false, group: null },
  { path: "/finance/cash-flow", label: "Cash Flow", billingOnly: false, group: null },
  { path: "/finance/recurring", label: "Recurring", billingOnly: false, group: null },
  { path: "/finance/payees", label: "Payees", billingOnly: false, group: null },
];

// The server authorizes these screens by the user's membership in the lab
// chosen in this header, not by their primary-lab role, so they gate on that
// per-lab role with the server's role sets. A lab's owners and admins can then
// finish what Receive Payments starts (Make Deposits) and open the report it
// links to (Aging) even when their primary-lab role is lower.
const LAB_ROLE_SCREENS: ReadonlyArray<{
  path: string;
  label: string;
  roles: ReadonlySet<string>;
  audience: string;
}> = [
  { path: "/finance/receive-payments", label: "Receive Payments", roles: LAB_ADMIN_ROLES, audience: "lab owners and administrators" },
  { path: "/finance/make-deposits", label: "Make Deposits", roles: LAB_ADMIN_ROLES, audience: "lab owners and administrators" },
  { path: "/finance/aging", label: "Aging", roles: LAB_BILLING_ROLES, audience: "lab owners, administrators and billing members" },
];

export function canReceivePayments(user: {
  userType?: string | null;
  role?: string | null;
} | null): boolean {
  if (!user) return false;
  if (user.userType !== "lab") return false;
  return user.role === "owner" || user.role === "admin";
}

/**
 * Route guard for the screens FinanceShell gates on the user's role in the
 * selected lab. It redirects only accounts that are not lab accounts; the
 * shell names the user's role in that lab when a screen is not available.
 */
export function LabFinanceRoute({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user?.userType !== "lab") return <Redirect to="/finance/register" />;
  return <>{children}</>;
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
  const registerPresentation = location.startsWith("/finance/register");
  const { user } = useAuth();
  const billingAllowed = canReceivePayments(user);
  const orgs = useLabOrganizations();
  const [orgId, setOrgId] = useSelectedOrg();
  const labScreen = LAB_ROLE_SCREENS.find((screen) => location.startsWith(screen.path)) ?? null;
  const labRole = useLabMembershipRole(orgId, !!labScreen || !billingAllowed);
  const allowedInLab = (roles: ReadonlySet<string>) =>
    labRole.status === "ready" && !!labRole.role && roles.has(labRole.role);
  const labScreenAllowed = !!labScreen && allowedInLab(labScreen.roles);
  const depositsAllowed = billingAllowed || allowedInLab(LAB_ADMIN_ROLES);
  const labName = (() => {
    const org = (orgs.data || []).find((o) => o.id === orgId);
    return org?.displayName || org?.name || "this lab";
  })();
  const TABS = ALL_TABS.filter((t) => {
    if (!t.billingOnly || billingAllowed) return true;
    const screen = LAB_ROLE_SCREENS.find((row) => row.path === t.path);
    return !!screen && allowedInLab(screen.roles);
  });
  const accounts = useBankAccounts(orgId);
  const [accountId, setAccountId] = useSelectedAccount(orgId);
  const [showManage, setShowManage] = useState(false);
  const qc = useQueryClient();
  const appliedAccountParamRef = useRef<string | null>(null);

  useEffect(() => {
    if (!location.startsWith("/finance/register")) {
      appliedAccountParamRef.current = null;
      return;
    }
    if (!accounts.data?.length) return;
    const requestedAccountId = new URLSearchParams(window.location.search).get("account");
    if (!requestedAccountId || appliedAccountParamRef.current === requestedAccountId) return;
    if (
      requestedAccountId !== accountId &&
      accounts.data.some((account) => account.id === requestedAccountId)
    ) {
      setAccountId(requestedAccountId);
    }
    if (accounts.data.some((account) => account.id === requestedAccountId)) {
      appliedAccountParamRef.current = requestedAccountId;
    }
  }, [accountId, accounts.data, location, setAccountId]);

  const undepositedSummary = useQuery({
    queryKey: ["finance", "undeposited-summary", orgId],
    queryFn: () =>
      apiFetch<{ count: number; total: number }>(
        `/finance/undeposited-funds?organizationId=${orgId}&summary=1`
      ),
    enabled: !!orgId && depositsAllowed,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  useEffect(() => {
    if (!orgId || !depositsAllowed) return;
    const ch = new BroadcastChannel("labtrax:finance");
    ch.onmessage = (e: MessageEvent) => {
      if (e.data === "undeposited-changed") {
        void qc.invalidateQueries({ queryKey: ["finance", "undeposited-summary", orgId] });
      }
    };
    return () => ch.close();
  }, [orgId, depositsAllowed, qc]);

  return (
    <div className={registerPresentation ? "finance-register-shell min-w-0 px-3 sm:px-8 py-7" : "px-8 py-7"}>
      <div className={registerPresentation ? "flex flex-wrap items-start justify-between gap-3 mb-5" : "flex items-start justify-between mb-5"}>
        <div className={registerPresentation ? "min-w-0 max-w-full" : undefined}>
          <h1 className="text-2xl font-semibold tracking-tight">Financial</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Bank register, reconciliation, cash flow, and recurring entries.
          </p>
        </div>
        <div className={registerPresentation ? "flex flex-wrap min-w-0 max-w-full items-center gap-2" : "flex items-center gap-2"}>
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
        <nav className="flex gap-1">
          {TABS.map((t, index) => {
            const active = location.startsWith(t.path);
            const pendingCount =
              t.showUndepositedBadge ? (undepositedSummary.data?.count ?? 0) : 0;
            const pendingTotal =
              t.showUndepositedBadge ? (undepositedSummary.data?.total ?? 0) : 0;
            const startsGroup = !!t.group && TABS[index - 1]?.group !== t.group;
            return (
              <div key={t.path} className="flex items-end">
                {startsGroup && (
                  <span className="self-center px-2 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                    {t.group}
                  </span>
                )}
              <Link
                href={t.path}
                className={`px-4 py-2 text-sm font-medium border border-b-0 rounded-t-md transition-colors inline-flex items-center gap-1.5 ${
                  active
                    ? "bg-sky-100 border-sky-300 text-foreground border-b border-b-background -mb-px relative z-10"
                    : "bg-sky-50 border-sky-200 text-sky-900 hover:bg-sky-100 hover:text-foreground"
                }`}
              >
                {t.label}
                {pendingCount > 0 && (
                  <span
                    className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold leading-none bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300 tabular-nums"
                    title={`${pendingCount} payment${pendingCount !== 1 ? "s" : ""} pending deposit`}
                  >
                    {formatMoney(pendingTotal)}
                  </span>
                )}
              </Link>
              </div>
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

      {orgId && labScreen && labRole.status === "loading" && (
        <div role="status" className="text-sm text-muted-foreground py-12 text-center">
          Checking your role in {labName}…
        </div>
      )}

      {orgId && labScreen && labRole.status === "error" && (
        <div role="alert" className="text-sm py-12 text-center border border-dashed border-border rounded-md">
          <p className="font-medium">Your role in {labName} could not be loaded</p>
          <p className="mt-1 text-muted-foreground">{labRole.error.message}</p>
          <button
            type="button"
            onClick={labRole.retry}
            className="mt-3 h-8 px-3 rounded-md bg-secondary text-xs font-medium hover:bg-secondary/80"
          >
            Retry
          </button>
        </div>
      )}

      {orgId && labScreen && labRole.status === "ready" && !labScreenAllowed && (
        <div role="alert" className="text-sm py-12 text-center border border-dashed border-border rounded-md">
          <p className="font-medium">Not available</p>
          <p className="mt-1 text-muted-foreground">
            {labScreen.label} is available only to {labScreen.audience}.{" "}
            {labRole.label
              ? `Your role in ${labName} is ${labRole.label}.`
              : `You are not an active member of ${labName}.`}
          </p>
        </div>
      )}

      {orgId && (labScreen ? labScreenAllowed : billingAllowed) && (!requireAccount || accountId) &&
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
  const [name, setName] = useState("");
  const [institution, setInstitution] = useState("");
  const [last4, setLast4] = useState("");
  const [opening, setOpening] = useState("0");

  const [catName, setCatName] = useState("");
  const [catKind, setCatKind] = useState<"income" | "expense" | "transfer">("expense");

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

  const unarchiveAccount = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/finance/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ isArchived: false }),
      }),
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
                        {a.isArchived ? (
                          <button
                            type="button"
                            onClick={() => unarchiveAccount.mutate(a.id)}
                            className="h-7 w-7 rounded hover:bg-secondary text-muted-foreground hover:text-foreground flex items-center justify-center"
                            aria-label="Unarchive"
                          >
                            <ArchiveRestore size={13} />
                          </button>
                        ) : (
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
            <h3 className="text-sm font-semibold mb-1">Payees / Vendors</h3>
            <p className="text-sm text-muted-foreground">
              Manage payees and vendors from the{" "}
              <Link href="/finance/payees" onClick={onClose} className="text-primary hover:underline font-medium">
                Payees tab
              </Link>
              . From there you can add, edit, and group vendors by type.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
