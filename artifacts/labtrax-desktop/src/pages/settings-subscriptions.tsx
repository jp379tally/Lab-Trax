import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Loader2,
  Search,
  X,
  Pencil,
  Save,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { PanelShell } from "./settings";
import { CreatorGate } from "@/lib/creator";
import type { CreatorSubscriptionSummary } from "@workspace/api-client-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { toast } from "@/hooks/use-toast";
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

interface SubscriptionItem {
  id: string;
  subjectType: string;
  subjectId: string;
  provider: string;
  providerPlan: string | null;
  monthlyPriceUsd: number | null;
  capabilities: string[];
  status: string;
  waiverReason: string | null;
  waiverStartsAt: string | null;
  waiverEndsAt: string | null;
  waiverGrantedAt: string | null;
  waiverGrantedByUserId: string | null;
  waiverActive: boolean;
  currentPeriodEnd: string | null;
  trialEndAt: string | null;
  canceledAt: string | null;
  cancelAtPeriodEnd: boolean;
  paymentMethodOnFile: boolean;
  processorState: {
    provider: string;
    hasStripeCustomer: boolean;
    hasStripeSubscription: boolean;
    hasRevenueCatAccount: boolean;
  };
  createdAt: string;
  updatedAt: string;
  organization: {
    id: string; name: string; type: string; accountNumber: string | null;
    addressLine1?: string | null; addressLine2?: string | null;
    city?: string | null; state?: string | null; zip?: string | null;
  } | null;
  account: { id: string; name: string; email: string | null } | null;
  accountHolderName: string;
  accountType: "Provider" | "Lab" | null;
  canonicalAccountNumber: string | null;
  canonicalSubjectType: string;
  canonicalSubjectId: string;
  formattedAddress: string | null;
}

interface PlanDef {
  id: string;
  monthlyPriceUsd: number;
  capabilities: string[];
}

type SubscriptionSummary = CreatorSubscriptionSummary;

interface SubscriptionsResponse {
  summary?: SubscriptionSummary;
  ok: boolean;
  items: SubscriptionItem[];
  total: number;
  limit: number;
  offset: number;
  plans: PlanDef[];
}

interface SubscriptionHistoryEvent {
  id?: string;
  eventType: string;
  createdAt: string;
  statusBefore?: string | null;
  statusAfter?: string | null;
  rawPayloadJson?: {
    actorUserId?: string;
    before?: unknown;
    after?: unknown;
  } | null;
}

interface SubscriptionAuditEntry {
  id?: string;
  action: string;
  createdAt: string;
  userId?: string | null;
  beforeJson?: unknown;
  afterJson?: unknown;
}

interface SubscriptionHistoryResponse {
  ok: boolean;
  subscription: Partial<SubscriptionItem> & { id: string };
  events: SubscriptionHistoryEvent[];
  audits: SubscriptionAuditEntry[];
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

const PAGE_SIZE = 100;

function waiverLabel(item: SubscriptionItem): string {
  if (item.waiverActive) {
    return item.waiverEndsAt ? "Fees waived" : "Fees waived indefinitely";
  }
  if (!item.waiverReason) return "Not waived";
  const now = Date.now();
  if (item.waiverStartsAt && new Date(item.waiverStartsAt).getTime() > now) {
    return "Waiver scheduled";
  }
  return "Waiver expired";
}

function lifecycleLabel(item: SubscriptionItem): string {
  if (item.canceledAt) {
    return `Canceled ${format(new Date(item.canceledAt), "MMM d, yyyy")}`;
  }
  if (item.trialEndAt && item.status === "trialing") {
    return `Trial ends ${format(new Date(item.trialEndAt), "MMM d, yyyy")}`;
  }
  if (item.currentPeriodEnd) {
    return `${item.cancelAtPeriodEnd ? "Expires" : "Renews"} ${format(new Date(item.currentPeriodEnd), "MMM d, yyyy")}`;
  }
  return "No renewal date";
}

function providerAddress(item: Pick<SubscriptionItem, "formattedAddress" | "organization">): string {
  if (item.formattedAddress?.trim()) return item.formattedAddress.trim();
  const org = item.organization;
  const legacyAddress = [org?.addressLine1, org?.addressLine2, org?.city, org?.state, org?.zip]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(", ");
  return legacyAddress || "No address on file";
}

function accountNumberLabel(item: Pick<SubscriptionItem, "canonicalAccountNumber" | "status">): string {
  return item.canonicalAccountNumber?.trim() ||
    (item.status === "legacy_free" ? "Legacy account (no number)" : "No account number");
}

export function SubscriptionsPanel() {
  return <CreatorGate><SubscriptionsPanelBody /></CreatorGate>;
}

function SubscriptionsPanelBody() {
  const [page, setPage] = useState(0);
  const [providerFilter, setProviderFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [planFilter, setPlanFilter] = useState("");
  const [search, setSearch] = useState("");
  const [accountTypeFilter, setAccountTypeFilter] = useState("");
  const [waiverFilter, setWaiverFilter] = useState("");
  const [selectedItem, setSelectedItem] = useState<SubscriptionItem | null>(null);

  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
  if (providerFilter) params.set("provider", providerFilter);
  if (statusFilter) params.set("status", statusFilter);
  if (planFilter) params.set("plan", planFilter);
  if (search) params.set("q", search);
  if (accountTypeFilter) params.set("accountType", accountTypeFilter);
  if (waiverFilter) params.set("waiver", waiverFilter);

  const queryKey = [
    "admin-subscriptions",
    page,
    providerFilter,
    statusFilter,
    planFilter,
    search,
    accountTypeFilter,
    waiverFilter,
  ];
  const query = useQuery<SubscriptionsResponse>({
    queryKey,
    queryFn: () => apiFetch<SubscriptionsResponse>(`/admin/provider-subscriptions?${params.toString()}`),
    retry: false,
  });

  const items = query.data?.items ?? [];

  const data = query.data;
  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;
  const plans = data?.plans ?? [];

  return (
    <PanelShell
      title="Subscriptions"
      subtitle="Creator cockpit for billing and entitlements."
    >
      <div className="space-y-4">
        {data?.summary && (
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-6" data-testid="subscription-summary">
            {([["Accounts", data.summary.totalAccounts], ["Paid", data.summary.paidSubscribers], ["Trial", data.summary.trial], ["Free", data.summary.free], ["Waived", data.summary.waived], ["Other", data.summary.other]] as const).map(([l, v]) => (
              <div key={l} className="bg-card px-3 py-2"><div className="text-[10px] uppercase tracking-widest text-muted-foreground">{l}</div><div className="text-xl font-semibold tabular-nums">{v}</div></div>
            ))}
            {(["byStatus", "byProvider"] as const).map((k) => (
              <div key={k} className="col-span-2 bg-card px-3 py-2 sm:col-span-3" data-testid={`subscription-${k}`}>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{k === "byStatus" ? "By status" : "By provider"}</div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm">
                  {Object.entries(data.summary![k]).map(([name, n]) => (
                    <span key={name}><span className="capitalize text-muted-foreground">{name}</span> <span className="tabular-nums font-medium">{n}</span></span>
                  ))}
                  {Object.keys(data.summary![k]).length === 0 && <span className="text-muted-foreground">None</span>}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 bg-background border border-input rounded-md px-2 h-8 w-64 focus-within:ring-1 focus-within:ring-ring">
            <Search size={14} className="text-muted-foreground" />
            <input
              id="subscription-search"
              aria-label="Search subscriptions"
              type="text"
              placeholder="Search..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              className="flex-1 bg-transparent text-sm focus:outline-none"
              data-testid="input-search-subscriptions"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <label htmlFor="subscription-provider-filter" className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Provider</label>
            <select
              id="subscription-provider-filter"
              value={providerFilter}
              onChange={(e) => { setProviderFilter(e.target.value); setPage(0); }}
              className="h-8 px-2 text-sm rounded-md border border-border bg-background"
              data-testid="select-filter-provider"
            >
              <option value="">All</option>
              <option value="stripe">Stripe</option>
              <option value="revenuecat">RevenueCat</option>
              <option value="none">None</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <label htmlFor="subscription-status-filter" className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Status</label>
            <select
              id="subscription-status-filter"
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}
              className="h-8 px-2 text-sm rounded-md border border-border bg-background"
              data-testid="select-filter-status"
            >
              <option value="">All</option>
              {Object.keys(STATUS_LABELS).map(k => (
                <option key={k} value={k}>{STATUS_LABELS[k].label}</option>
              ))}
            </select>
          </div>

          {plans.length > 0 && (
            <div className="flex items-center gap-1.5">
              <label htmlFor="subscription-plan-filter" className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Plan</label>
              <select
                id="subscription-plan-filter"
                value={planFilter}
                onChange={(e) => { setPlanFilter(e.target.value); setPage(0); }}
                className="h-8 px-2 text-sm rounded-md border border-border bg-background"
                data-testid="select-filter-plan"
              >
                <option value="">All</option>
                {plans.map(p => (
                  <option key={p.id} value={p.id}>{p.id}</option>
                ))}
              </select>
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <label htmlFor="subscription-type-filter" className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Type</label>
            <select
              id="subscription-type-filter"
              value={accountTypeFilter}
              onChange={(e) => { setAccountTypeFilter(e.target.value); setPage(0); }}
              className="h-8 px-2 text-sm rounded-md border border-border bg-background"
              data-testid="select-filter-type"
            >
              <option value="">All</option>
              <option value="Provider">Provider</option>
              <option value="Lab">Lab</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <label htmlFor="subscription-waiver-filter" className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Waiver</label>
            <select
              id="subscription-waiver-filter"
              value={waiverFilter}
              onChange={(e) => { setWaiverFilter(e.target.value); setPage(0); }}
              className="h-8 px-2 text-sm rounded-md border border-border bg-background"
              data-testid="select-filter-waiver"
            >
              <option value="">All</option>
              <option value="active">Fees waived</option>
              <option value="scheduled">Scheduled</option>
              <option value="expired">Expired</option>
              <option value="none">Not waived</option>
            </select>
          </div>

          {data && (
            <span className="ml-auto text-xs text-muted-foreground">
               Total: {data.total}
            </span>
          )}
        </div>

        {query.isError && (
          <div role="alert" className="flex items-center justify-between gap-3 p-3 text-sm text-destructive bg-destructive/10 rounded-md border border-destructive/20">
            <span>{(query.error as Error)?.message ?? "Failed to load subscriptions."}</span>
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="h-7 px-2.5 rounded border border-destructive/30 text-xs font-medium hover:bg-destructive/10"
              data-testid="button-retry-subscriptions"
            >
              Retry
            </button>
          </div>
        )}

        {query.isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
            <Loader2 size={14} className="animate-spin" />
            Loading…
          </div>
        )}

        {data && items.length === 0 && (
          <div className="text-sm text-muted-foreground py-8 text-center bg-secondary/20 rounded-md border border-border border-dashed">
            No subscriptions found matching filters.
          </div>
        )}

        {items.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/40 text-left">
                  <th className="px-3 py-2 text-[11px] uppercase tracking-wide font-medium text-muted-foreground whitespace-nowrap">Account</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-wide font-medium text-muted-foreground whitespace-nowrap">Plan / Price</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-wide font-medium text-muted-foreground whitespace-nowrap">Status</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-wide font-medium text-muted-foreground whitespace-nowrap">Waiver</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-wide font-medium text-muted-foreground whitespace-nowrap">Provider</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-wide font-medium text-muted-foreground whitespace-nowrap">Renews / Expires</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-wide font-medium text-muted-foreground whitespace-nowrap text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => (
                  <tr
                    key={item.id}
                    className={`border-b border-border last:border-0 hover:bg-secondary/40 transition-colors ${idx % 2 === 0 ? "" : "bg-secondary/20"}`}
                  >
                    <td className="px-3 py-2.5 min-w-[200px]">
                      <div className="font-medium text-foreground truncate max-w-[220px]" title={item.accountHolderName}>
                        {item.accountHolderName}
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-0.5">
                         <span className="font-mono bg-secondary/60 px-1 rounded text-[10px]">{accountNumberLabel(item)}</span>
                        <span>&middot;</span>
                        <span className="capitalize">{item.accountType ?? item.subjectType.replace(/_/g, " ")}</span>
                      </div>
                       <div className="text-[11px] text-muted-foreground mt-1 truncate max-w-[260px]" title={providerAddress(item)}>
                         {providerAddress(item)}
                       </div>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {item.providerPlan ? (
                        <div>
                          <span className="font-medium">{item.providerPlan}</span>
                          <span className="text-muted-foreground ml-1">
                            (${item.monthlyPriceUsd !== null ? item.monthlyPriceUsd : '—'}/mo)
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${STATUS_LABELS[item.status]?.cls || 'bg-secondary'}`}>
                        {STATUS_LABELS[item.status]?.label || item.status}
                      </span>
                      {item.cancelAtPeriodEnd && (
                        <span className="ml-1 text-[10px] text-muted-foreground">(cancels)</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {item.waiverActive ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                          {waiverLabel(item)}
                        </span>
                      ) : item.waiverReason ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-secondary text-muted-foreground">
                          {waiverLabel(item)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Not waived</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${PROVIDER_LABELS[item.provider]?.cls || 'bg-secondary'}`}>
                        {PROVIDER_LABELS[item.provider]?.label || item.provider}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                      {lifecycleLabel(item)}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-right">
                      <button
                        type="button"
                         onClick={() => setSelectedItem(item)}
                        className="inline-flex items-center justify-center h-7 px-2.5 text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 rounded transition-colors"
                        data-testid={`button-details-${item.id}`}
                      >
                        Manage
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center gap-3 justify-end pt-2">
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
      </div>

      {selectedItem && (
        <SubscriptionDetailSheet
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
          queryKey={queryKey}
          plans={plans}
        />
      )}
    </PanelShell>
  );
}

function SubscriptionDetailSheet({
  item,
  onClose,
  queryKey,
  plans,
}: {
  item: SubscriptionItem | null;
  onClose: () => void;
  queryKey: readonly unknown[];
  plans: PlanDef[];
}) {
  const id = item?.id ?? "";
  const { data, isLoading, error } = useQuery<SubscriptionHistoryResponse>({
    queryKey: ["admin-subscription-history", id],
    queryFn: () => apiFetch(`/admin/provider-subscriptions/${id}/history`),
    enabled: Boolean(id),
  });

  const sub = item && data?.subscription
    ? { ...item, ...data.subscription }
    : item;

  return (
    <Sheet open={true} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto" data-testid="sheet-subscription-detail">
        <SheetHeader className="mb-6">
          <SheetTitle>Subscription Details</SheetTitle>
          <SheetDescription>
            Manage plan, status, billing provider, and fee waivers.
          </SheetDescription>
        </SheetHeader>

        {isLoading && (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
            <Loader2 className="animate-spin" size={24} />
            <span className="text-sm">Loading details...</span>
          </div>
        )}

        {error && (
          <div role="alert" className="p-4 rounded-md bg-destructive/10 text-destructive text-sm border border-destructive/20">
            {(error as Error).message ?? "Failed to load subscription details"}
          </div>
        )}

        {sub && (
          <div className="space-y-8">
            <section className="space-y-4">
              <h3 className="text-sm font-semibold tracking-tight">Account Identity</h3>
              <div className="grid grid-cols-2 gap-4 bg-secondary/20 p-4 rounded-lg border border-border/50">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Holder Name</div>
                  <div className="font-medium text-sm">{sub.accountHolderName}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Type</div>
                  <div className="text-sm capitalize">{sub.accountType ?? sub.subjectType.replace(/_/g, " ")}</div>
                </div>
                
                {/* Editable Account Number if supported */}
                <AccountNumberEditor sub={sub} queryKey={queryKey} />
                 <div className="col-span-2">
                   <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Provider address</div>
                   <div className="text-sm">{providerAddress(sub)}</div>
                 </div>
                
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Created</div>
                  <div className="text-sm">{format(new Date(sub.createdAt), "MMM d, yyyy")}</div>
                </div>
              </div>
            </section>

            <section className="space-y-4">
              <h3 className="text-sm font-semibold tracking-tight">Entitlement & Billing</h3>
              <div className="bg-secondary/20 p-4 rounded-lg border border-border/50 space-y-4">
                <PlanStatusEditor sub={sub} plans={plans} queryKey={queryKey} />
                
                <div className="h-px bg-border/50 my-2" />
                
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Billing Provider</div>
                    <div className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${PROVIDER_LABELS[sub.provider]?.cls || 'bg-secondary'}`}>
                      {PROVIDER_LABELS[sub.provider]?.label || sub.provider}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Current Period End</div>
                    <div className="text-sm">{sub.currentPeriodEnd ? format(new Date(sub.currentPeriodEnd), "MMM d, yyyy") : "—"}</div>
                  </div>
                </div>
              </div>
            </section>

            <section className="space-y-4">
              <h3 className="text-sm font-semibold tracking-tight">Fee Waiver</h3>
              <WaiverEditor sub={sub} queryKey={queryKey} />
            </section>

            <section className="space-y-4">
              <h3 className="text-sm font-semibold tracking-tight">Audit History</h3>
              <HistoryView events={data?.events ?? []} audits={data?.audits ?? []} />
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function AccountNumberEditor({ sub, queryKey }: { sub: SubscriptionItem, queryKey: readonly unknown[] }) {
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(sub.canonicalAccountNumber || "");
  
  const mutation = useMutation({
    mutationFn: (accountNumber: string) => apiFetch(`/admin/provider-subscriptions/${sub.id}/account-number`, {
      method: "PATCH",
      body: JSON.stringify({ accountNumber })
    }),
    onSuccess: () => {
      toast({ title: "Account number updated" });
      setIsEditing(false);
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ["admin-subscription-history", sub.id] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    }
  });

  useEffect(() => {
    if (!isEditing) setValue(sub.canonicalAccountNumber || "");
  }, [isEditing, sub.canonicalAccountNumber]);

  if (sub.subjectType !== "provider_org") {
    return (
      <div>
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Account #</div>
        <div className="text-sm font-mono">{accountNumberLabel(sub)}</div>
      </div>
    );
  }

  if (!isEditing) {
    return (
      <div>
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Account #</div>
        <div className="flex items-center gap-2">
           <span className="text-sm font-mono">{accountNumberLabel(sub)}</span>
          <button 
            onClick={() => setIsEditing(true)}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
            data-testid="btn-edit-account-number"
            aria-label="Edit account number"
          >
            <Pencil size={12} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="col-span-2">
      <label htmlFor="subscription-account-number" className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1 block">Account #</label>
      <div className="flex items-center gap-2">
        <input 
          id="subscription-account-number"
          type="text" 
          value={value}
          onChange={e => setValue(e.target.value)}
          className="h-8 px-2 text-sm rounded border border-input bg-background font-mono focus:outline-none focus:ring-1 focus:ring-ring flex-1"
          data-testid="input-edit-account-number"
          disabled={mutation.isPending}
        />
        <button
          type="button"
          onClick={() => mutation.mutate(value)}
          disabled={mutation.isPending || !value.trim() || value === sub.canonicalAccountNumber}
          className="h-8 px-3 rounded bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
          data-testid="btn-save-account-number"
        >
          {mutation.isPending ? <Loader2 size={12} className="animate-spin" /> : "Save"}
        </button>
        <button
          type="button"
          onClick={() => { setIsEditing(false); setValue(sub.canonicalAccountNumber || ""); }}
          disabled={mutation.isPending}
          className="h-8 px-2 rounded border border-border text-xs hover:bg-secondary disabled:opacity-50"
          aria-label="Cancel account number edit"
        >
          <X size={14} />
        </button>
      </div>
      {mutation.isError && (
        <p role="alert" className="mt-2 text-xs text-destructive" data-testid="error-account-number">
          {(mutation.error as Error).message}
        </p>
      )}
    </div>
  );
}

function PlanStatusEditor({ sub, plans, queryKey }: { sub: SubscriptionItem, plans: PlanDef[], queryKey: readonly unknown[] }) {
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [planId, setPlanId] = useState(sub.providerPlan || "");
  const [status, setStatus] = useState(sub.status);
  
  const isProvider = sub.subjectType === "provider_org" || sub.subjectType === "provider_user";
  
  const mutation = useMutation({
    mutationFn: (data: { providerPlan?: string, status?: string }) => apiFetch(`/admin/provider-subscriptions/${sub.id}`, {
      method: "PATCH",
      body: JSON.stringify(data)
    }),
    onSuccess: () => {
      toast({ title: "Subscription updated" });
      setIsEditing(false);
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ["admin-subscription-history", sub.id] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    }
  });

  useEffect(() => {
    if (!isEditing) {
      setPlanId(sub.providerPlan || "");
      setStatus(sub.status);
    }
  }, [isEditing, sub.providerPlan, sub.status]);

  if (!isEditing) {
    return (
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Plan</div>
          <div className="text-sm font-medium">{sub.providerPlan || "—"}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Status</div>
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${STATUS_LABELS[sub.status]?.cls || 'bg-secondary'}`}>
              {STATUS_LABELS[sub.status]?.label || sub.status}
            </span>
            <button 
              onClick={() => setIsEditing(true)}
              className="text-muted-foreground hover:text-foreground transition-colors p-1"
              data-testid="btn-edit-plan-status"
             aria-label="Edit plan and status"
            >
              <Pencil size={12} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  const handleSave = () => {
    const payload: { providerPlan?: string; status?: string } = {};
    if (planId !== (sub.providerPlan || "")) payload.providerPlan = planId;
    if (status !== sub.status) payload.status = status;
    if (Object.keys(payload).length > 0) mutation.mutate(payload);
    else setIsEditing(false);
  };

  return (
    <div className="space-y-3 bg-card p-3 rounded-md border border-border">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="subscription-plan" className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1 block">Plan</label>
          <select 
            id="subscription-plan"
            value={planId} 
            onChange={e => setPlanId(e.target.value)}
            disabled={!isProvider || mutation.isPending}
            className="w-full h-8 px-2 text-sm rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            data-testid="select-edit-plan"
          >
            {!planId && <option value="" disabled>Select a plan</option>}
            {plans.map(p => (
              <option key={p.id} value={p.id}>{p.id}</option>
            ))}
          </select>
          {!isProvider && <p className="text-[10px] text-muted-foreground mt-1">Only available for provider accounts</p>}
        </div>
        <div>
          <label htmlFor="subscription-status" className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1 block">Status</label>
          <select 
            id="subscription-status"
            value={status} 
            onChange={e => setStatus(e.target.value)}
            disabled={mutation.isPending}
            className="w-full h-8 px-2 text-sm rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            data-testid="select-edit-status"
          >
            {Object.keys(STATUS_LABELS).map(k => (
              <option key={k} value={k}>{STATUS_LABELS[k].label}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button
          onClick={() => { setIsEditing(false); setPlanId(sub.providerPlan || ""); setStatus(sub.status); }}
          disabled={mutation.isPending}
          className="h-8 px-3 rounded border border-border text-xs font-medium hover:bg-secondary disabled:opacity-50 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={mutation.isPending || (planId === (sub.providerPlan || "") && status === sub.status)}
          className="h-8 px-3 rounded bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-1.5"
          data-testid="btn-save-plan-status"
        >
          {mutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          Save Changes
        </button>
      </div>
      {mutation.isError && (
        <p role="alert" className="text-xs text-destructive" data-testid="error-plan-status">
          {(mutation.error as Error).message}
        </p>
      )}
    </div>
  );
}

function WaiverEditor({ sub, queryKey }: { sub: SubscriptionItem, queryKey: readonly unknown[] }) {
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [reason, setReason] = useState(sub.waiverReason || "");
  const [startsAt, setStartsAt] = useState(sub.waiverStartsAt ? sub.waiverStartsAt.split("T")[0] : format(new Date(), "yyyy-MM-dd"));
  const [endsAt, setEndsAt] = useState(sub.waiverEndsAt ? sub.waiverEndsAt.split("T")[0] : "");
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  
  const grantMutation = useMutation({
    mutationFn: (data: { reason: string, startsAt?: string, endsAt?: string }) => {
      // Create full ISO strings for the API
      const payload: { reason: string; startsAt?: string; endsAt?: string } = {
        reason: data.reason,
      };
      if (data.startsAt) payload.startsAt = new Date(data.startsAt).toISOString();
      if (data.endsAt) payload.endsAt = new Date(data.endsAt).toISOString();
      return apiFetch(`/admin/provider-subscriptions/${sub.id}/waiver`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });
    },
    onSuccess: () => {
      toast({ title: "Waiver updated" });
      setIsEditing(false);
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ["admin-subscription-history", sub.id] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update waiver", description: err.message, variant: "destructive" });
    }
  });

  const endMutation = useMutation({
    mutationFn: () => apiFetch(`/admin/provider-subscriptions/${sub.id}/waiver`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: "Waiver ended" });
      setShowEndConfirm(false);
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ["admin-subscription-history", sub.id] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to end waiver", description: err.message, variant: "destructive" });
    }
  });

  useEffect(() => {
    if (!isEditing) {
      setReason(sub.waiverReason || "");
      setStartsAt(sub.waiverStartsAt ? sub.waiverStartsAt.split("T")[0] : format(new Date(), "yyyy-MM-dd"));
      setEndsAt(sub.waiverEndsAt ? sub.waiverEndsAt.split("T")[0] : "");
    }
  }, [
    isEditing,
    sub.waiverEndsAt,
    sub.waiverReason,
    sub.waiverStartsAt,
  ]);

  if (!isEditing) {
    if (!sub.waiverReason) {
      return (
        <div className="bg-secondary/20 p-4 rounded-lg border border-border/50 flex items-center justify-between">
          <div className="text-sm text-muted-foreground">No active fee waiver.</div>
          <button
            onClick={() => setIsEditing(true)}
            className="h-8 px-3 rounded bg-secondary text-foreground text-xs font-medium hover:bg-secondary/80 transition-colors"
            data-testid="btn-grant-waiver"
          >
            Grant Waiver
          </button>
        </div>
      );
    }

    return (
      <div className={`p-4 rounded-lg border ${sub.waiverActive ? 'bg-emerald-50/50 border-emerald-200 dark:bg-emerald-950/20 dark:border-emerald-800' : 'bg-secondary/20 border-border/50'}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-3 flex-1">
            <div className="flex items-center gap-2">
              {sub.waiverActive ? (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                  Active Waiver
                </span>
              ) : (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-secondary text-muted-foreground">
                  Inactive Waiver
                </span>
              )}
              <span className="text-xs font-medium text-foreground">{sub.waiverReason}</span>
            </div>
            
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <span className="text-muted-foreground block mb-0.5">Starts</span>
                <span>{sub.waiverStartsAt ? format(new Date(sub.waiverStartsAt), "MMM d, yyyy") : "—"}</span>
              </div>
              <div>
                <span className="text-muted-foreground block mb-0.5">Ends</span>
                <span>{sub.waiverEndsAt ? format(new Date(sub.waiverEndsAt), "MMM d, yyyy") : "Indefinite"}</span>
              </div>
            </div>
          </div>
          
          <div className="flex flex-col gap-2 shrink-0">
            <button
              onClick={() => setIsEditing(true)}
              className="h-7 px-3 rounded border border-border text-xs font-medium hover:bg-secondary transition-colors w-full text-center"
              data-testid="btn-edit-waiver"
            >
              Edit
            </button>
            {sub.waiverReason && (
              <button
                onClick={() => setShowEndConfirm(true)}
                className="h-7 px-3 rounded border border-destructive/30 text-destructive text-xs font-medium hover:bg-destructive/10 transition-colors w-full text-center"
                data-testid="btn-end-waiver"
              >
                 End Waiver
              </button>
            )}
          </div>
        </div>

        <AlertDialog open={showEndConfirm} onOpenChange={setShowEndConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>End Fee Waiver?</AlertDialogTitle>
              <AlertDialogDescription>
                This will immediately terminate the fee waiver for <strong>{sub.accountHolderName}</strong>. 
                Standard billing and capability restrictions will apply going forward based on their plan status.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); endMutation.mutate(); }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {endMutation.isPending ? <Loader2 size={14} className="animate-spin mr-2" /> : null}
                End Waiver
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  return (
    <div className="bg-card p-4 rounded-lg border border-primary/20 space-y-4 shadow-sm">
      <div>
        <label htmlFor="subscription-waiver-reason" className="text-xs font-medium block mb-1.5">Reason (Internal)</label>
        <input
          id="subscription-waiver-reason"
          type="text"
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="e.g., Strategic partnership, Goodwill gesture"
          className="w-full h-9 px-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring/50"
          data-testid="input-waiver-reason"
          disabled={grantMutation.isPending}
        />
      </div>
      
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="subscription-waiver-start" className="text-xs font-medium block mb-1.5">Start Date</label>
          <input
            id="subscription-waiver-start"
            type="date"
            value={startsAt}
            onChange={e => setStartsAt(e.target.value)}
            className="w-full h-9 px-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring/50"
            data-testid="input-waiver-start"
            disabled={grantMutation.isPending}
          />
        </div>
        <div>
          <label htmlFor="subscription-waiver-end" className="text-xs font-medium block mb-1.5">End Date (Optional)</label>
          <input
            id="subscription-waiver-end"
            type="date"
            value={endsAt}
            onChange={e => setEndsAt(e.target.value)}
            className="w-full h-9 px-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring/50"
            data-testid="input-waiver-end"
            disabled={grantMutation.isPending}
          />
        </div>
      </div>
      
      <div className="flex justify-end gap-2 pt-2">
        <button
          onClick={() => {
            setIsEditing(false);
            setReason(sub.waiverReason || "");
            setStartsAt(sub.waiverStartsAt ? sub.waiverStartsAt.split("T")[0] : format(new Date(), "yyyy-MM-dd"));
            setEndsAt(sub.waiverEndsAt ? sub.waiverEndsAt.split("T")[0] : "");
          }}
          disabled={grantMutation.isPending}
          className="h-8 px-3 rounded-md border border-border text-xs font-medium hover:bg-secondary disabled:opacity-50 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => grantMutation.mutate({ reason, startsAt, endsAt: endsAt || undefined })}
          disabled={grantMutation.isPending || !reason.trim()}
          className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-1.5"
          data-testid="btn-save-waiver"
        >
          {grantMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          Save Waiver
        </button>
      </div>
      {grantMutation.isError && (
        <p role="alert" className="text-xs text-destructive" data-testid="error-waiver">
          {(grantMutation.error as Error).message}
        </p>
      )}
    </div>
  );
}

function HistoryView({
  events,
  audits,
}: {
  events: SubscriptionHistoryEvent[];
  audits: SubscriptionAuditEntry[];
}) {
  if (!events?.length && !audits?.length) {
    return <div className="text-sm text-muted-foreground italic py-2">No history available.</div>;
  }

  // Combine and sort events and audits
  const combined = [
    ...(events || []).map(e => ({ ...e, _type: 'event' as const, _time: new Date(e.createdAt).getTime() })),
    ...(audits || []).map(a => ({ ...a, _type: 'audit' as const, _time: new Date(a.createdAt).getTime() }))
  ].sort((a, b) => b._time - a._time);

  return (
    <div className="space-y-4">
      {combined.map((item, i) => (
        <div key={item.id || i} className="flex gap-3 text-sm relative">
          <div className="mt-1 w-2 h-2 rounded-full bg-border shrink-0 z-10" />
          {i !== combined.length - 1 && (
            <div className="absolute left-1 top-3 bottom-0 w-px bg-border/50 -ml-[0.5px]" />
          )}
          <div className="space-y-1 pb-4 flex-1">
            <div className="flex justify-between items-start gap-4">
              <span className="font-medium">
                {item._type === 'event'
                  ? item.eventType.replace(/_/g, " ")
                  : item.action.replace(/_/g, " ")}
              </span>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {format(new Date(item.createdAt), "MMM d, yyyy h:mm a")}
              </span>
            </div>
            
            {item._type === "event" && item.rawPayloadJson?.actorUserId && (
              <div className="text-xs text-muted-foreground">Actor: {item.rawPayloadJson.actorUserId}</div>
            )}
            {item._type === "audit" && item.userId && (
              <div className="text-xs text-muted-foreground">Actor: {item.userId}</div>
            )}
            
            {item._type === "event" && item.statusBefore !== undefined && item.statusAfter !== undefined && (
              <div className="text-xs bg-secondary/30 p-2 rounded mt-2 font-mono">
                Status: {item.statusBefore || 'none'} &rarr; {item.statusAfter}
              </div>
            )}
            
            {item._type === 'audit' && Boolean(item.beforeJson) && Boolean(item.afterJson) && (
              <details className="text-xs mt-2 group">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">View details</summary>
                <div className="mt-2 grid grid-cols-2 gap-2 p-2 bg-secondary/20 rounded font-mono text-[10px] overflow-x-auto">
                  <div className="space-y-1">
                    <div className="text-muted-foreground uppercase tracking-wider">Before</div>
                    <pre>{JSON.stringify(item.beforeJson, null, 2)}</pre>
                  </div>
                  <div className="space-y-1">
                    <div className="text-muted-foreground uppercase tracking-wider">After</div>
                    <pre>{JSON.stringify(item.afterJson, null, 2)}</pre>
                  </div>
                </div>
              </details>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
