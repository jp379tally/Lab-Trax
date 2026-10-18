import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Download, Lock, Loader2, Paperclip } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { apiFetch, apiUrl, authedFetch } from "@/lib/api";
import { CREATOR_ACCESS_KEY, CreatorGate, PinSetup, creatorErrorMessage, formatMinor, minorToMajor } from "@/lib/creator";
import type { CreatorRevenue, CreatorFeedbackItem, CreatorFeedbackList } from "@workspace/api-client-react";
import OwnerPage from "@/pages/owner/OwnerPage";
import type { MeResponse } from "@/lib/types";
import { SubscriptionsPanel } from "@/pages/settings-subscriptions";

type Tab = "revenue" | "feedback" | "subscriptions" | "lab-owner" | "security";
const TABS: { id: Tab; label: string }[] = [
  { id: "revenue", label: "Revenue" },
  { id: "feedback", label: "Feedback inbox" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "lab-owner", label: "Lab owner" },
  { id: "security", label: "Security" },
];

function initialTab(): Tab {
  const t = new URLSearchParams(window.location.search).get("tab");
  return TABS.some((x) => x.id === t) ? (t as Tab) : "revenue";
}

export default function CreatorPage() {
  return <CreatorGate><CreatorDashboard /></CreatorGate>;
}

function CreatorDashboard() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const qc = useQueryClient();
  const lock = useMutation({
    mutationKey: ["creator", "lock"],
    mutationFn: () => apiFetch("/creator/lock", { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CREATOR_ACCESS_KEY }),
  });
  const me = useQuery<MeResponse>({ queryKey: ["auth", "me"], queryFn: () => apiFetch<MeResponse>("/auth/me") });
  const ownsLab = (me.data?.memberships ?? []).some(
    (m: any) => m.status === "active" && m.organization?.type === "lab" && m.role === "owner",
  );
  const tabs = TABS.filter((t) => t.id !== "lab-owner" || ownsLab);
  const feedback = useQuery({ queryKey: ["creator", "feedback-count"], queryFn: () => apiFetch<FeedbackResp>("/creator/feedback?status=new&offset=0&limit=1") });
  return (
    <div className="h-full overflow-y-auto" data-testid="creator-dashboard">
      <header className="flex items-end justify-between border-b border-border px-6 pb-3 pt-5">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Private platform console</div>
          <h1 className="text-2xl font-semibold tracking-tight">Creator</h1>
        </div>
        <button type="button" disabled={lock.isPending} onClick={() => lock.mutate()} data-testid="button-creator-lock"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-sm hover:bg-secondary">
          <Lock size={13} /> {lock.isPending ? "Locking…" : "Lock"}
        </button>
      </header>
      {lock.isError && <p role="alert" data-testid="text-lock-error" className="px-6 pt-2 text-sm text-destructive">{creatorErrorMessage(lock.error)}</p>}
      <nav className="flex gap-1 border-b border-border px-6">
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)} data-testid={`tab-creator-${t.id}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {t.label}
            {t.id === "feedback" && !!feedback.data?.newCount && (
              <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">{feedback.data.newCount}</span>
            )}
          </button>
        ))}
      </nav>
      <main className="p-6">
        {tab === "revenue" && <RevenueReport />}
        {tab === "feedback" && <FeedbackInbox />}
        {tab === "subscriptions" && <SubscriptionsPanel />}
        {tab === "lab-owner" && (ownsLab ? <OwnerPage embedded /> : <p className="text-sm text-muted-foreground">This account does not own a lab.</p>)}
        {tab === "security" && <PinSetup />}
      </main>
    </div>
  );
}

// ── Revenue ──
type RevenueResp = CreatorRevenue;
const money = formatMinor;
const iso = (d: Date) => format(d, "yyyy-MM-dd");

function RevenueReport() {
  const now = new Date();
  const [start, setStart] = useState(iso(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [end, setEnd] = useState(iso(now));
  const [group, setGroup] = useState<"daily" | "monthly" | "yearly">("daily");
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const q = useQuery<RevenueResp>({
    queryKey: ["creator", "revenue", start, end, group, tz],
    queryFn: () => apiFetch<RevenueResp>(`/creator/revenue?start=${start}&end=${end}&timezone=${encodeURIComponent(tz)}&group=${group}`),
    enabled: start <= end,
  });
  const qc = useQueryClient();
  const reconcile = useMutation({
    mutationKey: ["creator", "reconcile"],
    mutationFn: () => apiFetch("/creator/revenue/reconcile", { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["creator", "revenue"] }),
  });
  const inp = "h-8 rounded border border-border bg-background px-2 text-sm";
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <input aria-label="Start date" type="date" className={inp} value={start} onChange={(e) => setStart(e.target.value)} />
        <input aria-label="End date" type="date" className={inp} value={end} onChange={(e) => setEnd(e.target.value)} />
        <select aria-label="Group" className={inp} value={group} onChange={(e) => setGroup(e.target.value as typeof group)}>
          <option value="daily">Daily</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option>
        </select>
        {([["This month", "month"], ["Last month", "last"], ["This year", "year"]] as const).map(([l, k]) => (
          <button key={k} type="button" data-testid={`preset-${k}`} onClick={() => {
            const y = now.getFullYear(), m = now.getMonth();
            if (k === "month") { setStart(iso(new Date(y, m, 1))); setEnd(iso(now)); }
            if (k === "last") { setStart(iso(new Date(y, m - 1, 1))); setEnd(iso(new Date(y, m, 0))); }
            if (k === "year") { setStart(iso(new Date(y, 0, 1))); setEnd(iso(now)); }
          }} className="h-8 rounded border border-border px-2.5 text-xs hover:bg-secondary">{l}</button>
        ))}
        <span className="text-xs text-muted-foreground" data-testid="revenue-tz">Timezone {tz} · dates inclusive · amounts in each currency's own units</span>
        {q.isFetching && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
      </div>
      {start > end && <p className="text-sm text-destructive">Start date must be on or before end date.</p>}
      {q.isError && (
        <div role="alert" className="flex items-center gap-3 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          {creatorErrorMessage(q.error)}
          <button type="button" onClick={() => void q.refetch()} className="rounded border border-destructive/30 px-2 py-1 text-xs">Retry</button>
        </div>
      )}
      {q.isLoading && <div className="h-40 animate-pulse rounded-lg bg-secondary/40" />}
      {q.data && (
        <>
          {q.data.unavailableAmounts > 0 && (
            <p className="rounded-md border border-amber-300/50 bg-amber-100/50 p-3 text-sm text-amber-900 dark:text-amber-200">
              {q.data.unavailableAmounts} payment amount(s) were unavailable from providers and are excluded from totals.
            </p>
          )}
          {q.data.currencies.length === 0 && <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">No verified receipts in this range. Provider coverage may be incomplete, so this is not a confirmed zero.</p>}
          {q.data.currencies.map((c) => (
            <div key={c.currency} className="rounded-lg border border-border bg-card p-4" data-testid={`revenue-${c.currency}`}>
              <div className="mb-3 flex flex-wrap items-baseline gap-x-8 gap-y-2">
                <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{c.currency}</span>
                <Stat label="Collected fees" v={money(c.collectedMinor, c.currency)} />
                <Stat label="Refunds" v={money(c.refundsMinor, c.currency)} />
                <Stat label="Net (collected less refunds)" v={money(c.netMinor, c.currency)} strong />
              </div>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={c.buckets.map((b) => ({ ...b, net: minorToMajor(b.netMinor, c.currency) }))}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="period" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} width={50} />
                    <Tooltip />
                    <Bar dataKey="net" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <table className="mt-3 w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase text-muted-foreground"><th className="py-1">Period</th><th className="text-right">Collected</th><th className="text-right">Refunds</th><th className="text-right">Net</th></tr></thead>
                <tbody>{c.buckets.map((b) => (
                  <tr key={b.period} className="border-t border-border"><td className="py-1.5">{b.period}</td>
                    <td className="text-right tabular-nums">{money(b.collectedMinor, c.currency)}</td>
                    <td className="text-right tabular-nums">{money(b.refundsMinor, c.currency)}</td>
                    <td className="text-right tabular-nums font-medium">{money(b.netMinor, c.currency)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          ))}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Provider coverage</h3>
              <button type="button" disabled={reconcile.isPending} onClick={() => reconcile.mutate()} data-testid="button-revenue-reconcile"
                className="h-7 rounded border border-border px-2.5 text-xs hover:bg-secondary disabled:opacity-50">
                {reconcile.isPending ? "Resuming…" : "Resume ingestion"}
              </button>
            </div>
            {reconcile.isError && <p role="alert" className="mb-2 text-xs text-destructive">{creatorErrorMessage(reconcile.error)}</p>}
            <ul className="divide-y divide-border rounded-lg border border-border">
              {q.data.coverage.map((c) => (
                <li key={c.provider} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span><span className="font-medium capitalize">{c.provider}</span> <span className="text-muted-foreground">{c.detail}</span></span>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">{c.status}{c.updatedAt ? ` · ${format(new Date(c.updatedAt), "MMM d, h:mm a")}` : ""}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
function Stat({ label, v, strong }: { label: string; v: string; strong?: boolean }) {
  return <div><div className="text-[11px] uppercase text-muted-foreground">{label}</div><div className={`tabular-nums ${strong ? "text-2xl font-semibold" : "text-lg"}`}>{v}</div></div>;
}

// ── Feedback ──
type FeedbackItem = CreatorFeedbackItem;
type FeedbackResp = CreatorFeedbackList;
const FB_PAGE = 25;

function FeedbackInbox() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<"new" | "reviewed">("new");
  const [page, setPage] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const q = useQuery<FeedbackResp>({
    queryKey: ["creator", "feedback", status, page],
    queryFn: () => apiFetch<FeedbackResp>(`/creator/feedback?status=${status}&offset=${page * FB_PAGE}&limit=${FB_PAGE}`),
  });
  const toggle = useMutation({
    mutationFn: ({ id, reviewed }: { id: string; reviewed: boolean }) =>
      apiFetch(`/creator/feedback/${id}`, { method: "PATCH", body: JSON.stringify({ reviewed }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["creator", "feedback"] }); qc.invalidateQueries({ queryKey: ["creator", "feedback-count"] }); },
  });
  async function download(r: FeedbackItem, a: FeedbackItem["attachments"][number]) {
    setDownloadError(null);
    try {
      const res = await authedFetch(apiUrl(`/creator/feedback/${r.id}/attachments/${a.id}`));
      if (!res.ok) {
        if (res.status === 403) void qc.invalidateQueries({ queryKey: CREATOR_ACCESS_KEY });
        throw new Error(`Attachment could not be downloaded (${res.status}).`);
      }
      const url = URL.createObjectURL(await res.blob());
      const el = document.createElement("a");
      el.href = url; el.download = a.filename; document.body.appendChild(el); el.click(); el.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setDownloadError(creatorErrorMessage(error)); }
  }
  const pages = q.data ? Math.ceil(q.data.total / FB_PAGE) : 0;
  return (
    <section className="max-w-3xl space-y-4">
      <div className="inline-flex rounded-md border border-border p-0.5">
        {(["new", "reviewed"] as const).map((s) => (
          <button key={s} type="button" data-testid={`filter-feedback-${s}`} onClick={() => { setStatus(s); setPage(0); }}
            className={`rounded px-3 py-1 text-sm capitalize ${status === s ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>
            {s}{s === "new" && q.data ? ` (${q.data.newCount})` : ""}
          </button>
        ))}
      </div>
      {q.isLoading && <div className="h-32 animate-pulse rounded-lg bg-secondary/40" />}
      {q.isError && (
        <div role="alert" className="flex items-center gap-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {creatorErrorMessage(q.error)}
          <button type="button" onClick={() => void q.refetch()} className="rounded border border-destructive/30 px-2 py-1 text-xs">Retry</button>
        </div>
      )}
      {toggle.isError && <p role="alert" data-testid="text-review-error" className="text-sm text-destructive">{creatorErrorMessage(toggle.error)}</p>}
      {downloadError && <p role="alert" className="text-sm text-destructive">{downloadError}</p>}
      {q.data?.items.length === 0 && <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">No {status} feedback.</p>}
      {q.data?.items.map((r) => {
        const name = [r.reporter?.firstName, r.reporter?.lastName].filter(Boolean).join(" ") || r.reporter?.username || "Unknown";
        return (
          <article key={r.id} className="rounded-lg border border-border bg-card p-4" data-testid={`feedback-${r.id}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
              <span><span className="text-sm font-medium text-foreground">{name}</span> · {r.reporter?.email} · {r.organization?.name} · {r.portal}</span>
              <time>{format(new Date(r.createdAt), "MMM d, yyyy h:mm a")}</time>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm">{r.description}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {r.attachments.map((a) => (
                <button key={a.id} type="button" onClick={() => void download(r, a)}
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-secondary">
                  <Paperclip size={11} /> {a.filename} <Download size={11} />
                </button>
              ))}
              <button type="button" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: r.id, reviewed: !r.reviewedAt })}
                data-testid={`button-review-${r.id}`}
                className="ml-auto h-7 rounded bg-primary/10 px-2.5 text-xs font-medium text-primary hover:bg-primary/20">
                {r.reviewedAt ? "Mark as new" : "Mark reviewed"}
              </button>
            </div>
          </article>
        );
      })}
      {pages > 1 && (
        <div className="flex items-center justify-end gap-3 text-xs">
          <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className="h-8 rounded-md bg-secondary px-3 disabled:opacity-40">Previous</button>
          <span>Page {page + 1} of {pages}</span>
          <button type="button" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} className="h-8 rounded-md bg-secondary px-3 disabled:opacity-40">Next</button>
        </div>
      )}
    </section>
  );
}
