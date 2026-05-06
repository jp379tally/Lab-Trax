import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowRight,
  Clock,
  Plus,
  Upload,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type { LabCase } from "@/lib/types";
import { formatDate } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import { DashboardDropZone } from "@/components/DashboardDropZone";
import { NewCaseModal } from "./cases";

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

const COMPLETED_STATUSES = new Set(["delivered", "cancelled"]);

function CaseRow({ c }: { c: LabCase }) {
  return (
    <tr className="border-t border-border hover:bg-secondary/40">
      <td className="px-5 py-3 font-mono text-xs">{c.caseNumber}</td>
      <td className="py-3">
        {c.patientFirstName} {c.patientLastName}
      </td>
      <td className="py-3 text-muted-foreground">{c.doctorName}</td>
      <td className="py-3">
        <StatusBadge status={c.status} />
      </td>
      <td className="py-3 text-muted-foreground pr-5">{formatDate(c.dueDate)}</td>
    </tr>
  );
}

function CasesTable({
  cases,
  loading,
  emptyText,
}: {
  cases: LabCase[];
  loading: boolean;
  emptyText: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="text-left font-medium px-5 py-2.5">Case</th>
            <th className="text-left font-medium py-2.5">Patient</th>
            <th className="text-left font-medium py-2.5">Doctor</th>
            <th className="text-left font-medium py-2.5">Status</th>
            <th className="text-left font-medium py-2.5 pr-5">Due</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={5} className="px-5 py-8 text-center text-sm text-muted-foreground">
                Loading…
              </td>
            </tr>
          )}
          {!loading && cases.length === 0 && (
            <tr>
              <td colSpan={5} className="px-5 py-8 text-center text-sm text-muted-foreground">
                {emptyText}
              </td>
            </tr>
          )}
          {cases.map((c) => (
            <CaseRow key={c.id} c={c} />
          ))}
        </tbody>
      </table>
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

  const [showNewCase, setShowNewCase] = useState(false);

  const casesQuery = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
  });

  const cases = casesQuery.data ?? [];
  const loading = casesQuery.isLoading;

  const todayCases = cases.filter((c) => isToday(c.createdAt));
  const inProgressCount = cases.filter((c) =>
    IN_PROGRESS_STATUSES.has(c.status),
  ).length;
  const rushCount = cases.filter((c) => c.priority === "rush").length;

  const recentCases = useMemo(
    () =>
      [...cases]
        .filter((c) => !COMPLETED_STATUSES.has(c.status))
        .sort((a, b) =>
          (b.updatedAt || b.createdAt || "").localeCompare(
            a.updatedAt || a.createdAt || "",
          ),
        )
        .slice(0, 6),
    [cases],
  );

  return (
    <div className="px-8 py-7 max-w-[1400px] mx-auto">
      <div className="flex items-end justify-between mb-7">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Your lab at a glance.
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Clock size={12} />
              {inProgressCount} in progress
            </span>
            {rushCount > 0 && (
              <span className="flex items-center gap-1.5 text-destructive font-medium">
                <AlertTriangle size={12} />
                {rushCount} rush
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowNewCase(true)}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors shadow-sm"
          >
            <Plus size={15} />
            Add case
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 flex flex-col gap-6">
          <div>
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Upload size={14} className="text-muted-foreground" />
              Drop zone
            </h2>
            <DashboardDropZone />
          </div>

          <section className="bg-card border border-border rounded-xl">
            <header className="px-5 py-3.5 border-b border-border">
              <h2 className="text-sm font-semibold">Logged today</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {loading
                  ? "Loading…"
                  : todayCases.length === 0
                    ? "No cases yet today"
                    : `${todayCases.length} case${todayCases.length === 1 ? "" : "s"} received`}
              </p>
            </header>
            <CasesTable
              cases={todayCases}
              loading={loading}
              emptyText="No cases logged today."
            />
          </section>
        </div>

        <section className="lg:col-span-2 bg-card border border-border rounded-xl self-start">
          <header className="flex items-center justify-between px-5 py-3.5 border-b border-border">
            <div>
              <h2 className="text-sm font-semibold">Recent cases</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Most recently active, excluding completed.
              </p>
            </div>
            <Link
              href="/cases"
              className="text-xs font-medium text-primary inline-flex items-center gap-1 hover:underline"
            >
              View all <ArrowRight size={12} />
            </Link>
          </header>
          <CasesTable
            cases={recentCases}
            loading={loading}
            emptyText="No active cases."
          />
        </section>
      </div>

      {showNewCase && <NewCaseModal onClose={() => setShowNewCase(false)} />}
    </div>
  );
}
