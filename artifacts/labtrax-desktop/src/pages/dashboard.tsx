import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowRight,
  ClipboardList,
  Clock,
  DollarSign,
  Package,
  Truck,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { Invoice, LabCase } from "@/lib/types";
import { formatDate, formatMoney, relativeTime } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import { DesktopFileDropZone } from "@/components/DesktopFileDropZone";

function isToday(d?: string | null): boolean {
  if (!d) return false;
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

const IN_PROGRESS_STATUSES = new Set([
  "received",
  "in_design",
  "in_milling",
  "in_porcelain",
  "qc",
]);
const READY_STATUSES = new Set(["shipped", "delivered"]);
const UNPAID_STATUSES = new Set(["open", "partially_paid", "overdue", "draft"]);

interface SummaryCardProps {
  title: string;
  value: string;
  hint?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  tone?: "primary" | "success" | "warning" | "neutral";
}

function SummaryCard({ title, value, hint, icon: Icon, tone = "primary" }: SummaryCardProps) {
  const toneClass =
    tone === "primary"
      ? "bg-primary/10 text-primary"
      : tone === "success"
        ? "bg-success/15 text-success"
        : tone === "warning"
          ? "bg-warning/20 text-warning"
          : "bg-secondary text-foreground";
  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
            {title}
          </div>
          <div className="mt-2 text-3xl font-semibold tracking-tight">{value}</div>
          {hint && (
            <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
          )}
        </div>
        <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${toneClass}`}>
          <Icon size={18} />
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  // Suppress browser navigation if a file is dropped outside the drop zone.
  useEffect(() => {
    function prevent(e: DragEvent) {
      e.preventDefault();
    }
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  const casesQuery = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
  });
  const invoicesQuery = useQuery({
    queryKey: ["invoices"],
    queryFn: () => apiFetch<Invoice[]>("/invoices"),
  });

  const cases = casesQuery.data ?? [];
  const invoices = invoicesQuery.data ?? [];

  const todayCount = cases.filter((c) => isToday(c.createdAt)).length;
  const inProgressCount = cases.filter((c) => IN_PROGRESS_STATUSES.has(c.status)).length;
  const readyCount = cases.filter((c) => READY_STATUSES.has(c.status)).length;
  const rushCount = cases.filter((c) => c.priority === "rush").length;

  const unpaidInvoices = invoices.filter((i) => UNPAID_STATUSES.has(i.status));
  const unpaidTotal = unpaidInvoices.reduce(
    (sum, i) => sum + Number(i.balanceDue || i.total || 0),
    0,
  );

  const recentPayments = [...invoices]
    .filter((i) => i.status === "paid")
    .sort((a, b) =>
      (b.updatedAt || b.issuedAt || "").localeCompare(a.updatedAt || a.issuedAt || ""),
    )
    .slice(0, 5);

  const recentCases = [...cases]
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    .slice(0, 6);

  const loading = casesQuery.isLoading || invoicesQuery.isLoading;

  return (
    <div className="px-8 py-7 max-w-[1500px] mx-auto">
      <div className="flex items-end justify-between mb-7">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Live operations across your lab.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          {loading ? "Loading…" : `Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-7">
        <SummaryCard
          title="Logged today"
          value={todayCount.toString()}
          hint="New cases created"
          icon={ClipboardList}
        />
        <SummaryCard
          title="In progress"
          value={inProgressCount.toString()}
          hint="Across design / mill / porcelain"
          icon={Clock}
          tone="warning"
        />
        <SummaryCard
          title="Ready / shipped"
          value={readyCount.toString()}
          hint="Out the door"
          icon={Truck}
          tone="success"
        />
        <SummaryCard
          title="Rush cases"
          value={rushCount.toString()}
          hint="Priority queue"
          icon={AlertTriangle}
          tone={rushCount > 0 ? "warning" : "neutral"}
        />
        <SummaryCard
          title="Unpaid invoices"
          value={formatMoney(unpaidTotal)}
          hint={`${unpaidInvoices.length} open`}
          icon={DollarSign}
          tone="primary"
        />
      </div>

      <div className="mb-7">
        <DesktopFileDropZone />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <section className="lg:col-span-2 bg-card border border-border rounded-xl">
          <header className="flex items-center justify-between px-5 py-3.5 border-b border-border">
            <div>
              <h2 className="text-sm font-semibold">Recent cases</h2>
              <p className="text-xs text-muted-foreground">Latest activity from the lab.</p>
            </div>
            <Link
              href="/cases"
              className="text-xs font-medium text-primary inline-flex items-center gap-1 hover:underline"
            >
              View all <ArrowRight size={12} />
            </Link>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="text-left font-medium px-5 py-2.5">Case</th>
                  <th className="text-left font-medium py-2.5">Patient</th>
                  <th className="text-left font-medium py-2.5">Doctor</th>
                  <th className="text-left font-medium py-2.5">Status</th>
                  <th className="text-left font-medium py-2.5">Due</th>
                  <th className="text-left font-medium px-5 py-2.5">Logged</th>
                </tr>
              </thead>
              <tbody>
                {recentCases.length === 0 && !loading && (
                  <tr>
                    <td colSpan={6} className="px-5 py-8 text-center text-sm text-muted-foreground">
                      No cases yet.
                    </td>
                  </tr>
                )}
                {loading && (
                  <tr>
                    <td colSpan={6} className="px-5 py-8 text-center text-sm text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                )}
                {recentCases.map((c) => (
                  <tr key={c.id} className="border-t border-border hover:bg-secondary/40">
                    <td className="px-5 py-3 font-mono text-xs">{c.caseNumber}</td>
                    <td className="py-3">
                      {c.patientFirstName} {c.patientLastName}
                    </td>
                    <td className="py-3 text-muted-foreground">{c.doctorName}</td>
                    <td className="py-3">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="py-3 text-muted-foreground">{formatDate(c.dueDate)}</td>
                    <td className="px-5 py-3 text-muted-foreground">{relativeTime(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="bg-card border border-border rounded-xl">
          <header className="flex items-center justify-between px-5 py-3.5 border-b border-border">
            <div>
              <h2 className="text-sm font-semibold">Recent payments</h2>
              <p className="text-xs text-muted-foreground">Last 5 settled invoices.</p>
            </div>
            <Link
              href="/invoices"
              className="text-xs font-medium text-primary inline-flex items-center gap-1 hover:underline"
            >
              View all <ArrowRight size={12} />
            </Link>
          </header>
          <ul className="divide-y divide-border">
            {recentPayments.length === 0 && (
              <li className="px-5 py-8 text-center text-sm text-muted-foreground">
                No payments yet.
              </li>
            )}
            {recentPayments.map((i) => (
              <li key={i.id} className="px-5 py-3 flex items-center justify-between">
                <div className="min-w-0">
                  <div className="font-mono text-xs">{i.invoiceNumber}</div>
                  <div className="text-xs text-muted-foreground">
                    {relativeTime(i.updatedAt || i.issuedAt)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Package size={13} className="text-success" />
                  <span className="font-semibold tabular-nums">
                    {formatMoney(i.total)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
