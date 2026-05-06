import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Clock,
  Plus,
  Upload,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type { LabCase } from "@/lib/types";
import { formatDate, relativeTime } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
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

type DropState =
  | { phase: "idle" }
  | { phase: "dragging-file" }
  | { phase: "dragging-case" }
  | { phase: "picking"; files: File[] }
  | { phase: "uploading" }
  | { phase: "done"; message: string }
  | { phase: "error"; message: string };

interface DropZoneProps {
  cases: LabCase[];
}

function DropZone({ cases }: DropZoneProps) {
  const [state, setState] = useState<DropState>({ phase: "idle" });
  const [caseSearch, setCaseSearch] = useState("");
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const filteredCases = useMemo(() => {
    const q = caseSearch.trim().toLowerCase();
    if (!q) return cases.slice(0, 8);
    return cases
      .filter(
        (c) =>
          c.caseNumber.toLowerCase().includes(q) ||
          `${c.patientFirstName} ${c.patientLastName}`.toLowerCase().includes(q) ||
          c.doctorName.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [cases, caseSearch]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      setState({ phase: "dragging-file" });
    } else {
      setState({ phase: "dragging-case" });
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) {
      setState({ phase: "idle" });
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      setCaseSearch("");
      setSelectedCaseId(null);
      setState({ phase: "picking", files });
    } else {
      setState({
        phase: "done",
        message: "Case noted — open it to update details.",
      });
      setTimeout(() => setState({ phase: "idle" }), 3000);
    }
  }, []);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) {
        setCaseSearch("");
        setSelectedCaseId(null);
        setState({ phase: "picking", files });
      }
      e.target.value = "";
    },
    [],
  );

  async function runUpload(files: File[], caseId: string | null) {
    setState({ phase: "uploading" });
    try {
      let count = 0;
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        const result = await apiFetch<{ url: string; filename: string }>(
          "/media/upload",
          { method: "POST", body: fd },
        );

        if (caseId) {
          await apiFetch(`/cases/${caseId}/submissions`, {
            method: "POST",
            body: JSON.stringify({
              submissionType: "document",
              payloadJson: { url: result.url, filename: result.filename },
            }),
          });
        }
        count++;
      }
      setState({
        phase: "done",
        message: `${count} file${count === 1 ? "" : "s"} uploaded${caseId ? " and attached to case" : ""}.`,
      });
      setTimeout(() => setState({ phase: "idle" }), 4000);
    } catch (e: unknown) {
      setState({
        phase: "error",
        message: e instanceof Error ? e.message : "Upload failed",
      });
      setTimeout(() => setState({ phase: "idle" }), 4000);
    }
  }

  function cancelPicking() {
    setState({ phase: "idle" });
    setCaseSearch("");
    setSelectedCaseId(null);
  }

  const isIdle = state.phase === "idle";
  const isDraggingFile = state.phase === "dragging-file";
  const isDraggingCase = state.phase === "dragging-case";

  if (state.phase === "picking") {
    const files = state.files;
    return (
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">
            {files.length} file{files.length === 1 ? "" : "s"} ready to upload
          </p>
          <button
            type="button"
            onClick={cancelPicking}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Cancel"
          >
            <X size={15} />
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Attach to a case (optional) — or upload without linking.
        </p>
        <div className="relative">
          <input
            autoFocus
            type="search"
            placeholder="Search case # or patient…"
            value={caseSearch}
            onChange={(e) => {
              setCaseSearch(e.target.value);
              setSelectedCaseId(null);
            }}
            className="w-full h-8 px-3 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
          />
        </div>
        {filteredCases.length > 0 && (
          <ul className="border border-border rounded-md divide-y divide-border max-h-40 overflow-y-auto">
            {filteredCases.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedCaseId((prev) =>
                      prev === c.id ? null : c.id,
                    )
                  }
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-secondary/50 transition-colors flex items-center gap-2 ${
                    selectedCaseId === c.id ? "bg-primary/10" : ""
                  }`}
                >
                  {selectedCaseId === c.id && (
                    <CheckCircle2 size={13} className="text-primary shrink-0" />
                  )}
                  <span className="font-mono text-xs text-muted-foreground">
                    {c.caseNumber}
                  </span>
                  <span className="truncate">
                    {c.patientFirstName} {c.patientLastName}
                  </span>
                  <span className="text-muted-foreground ml-auto text-xs truncate">
                    {c.doctorName}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {selectedCaseId && (
          <p className="text-xs text-primary font-medium">
            Files will be attached to case{" "}
            {cases.find((c) => c.id === selectedCaseId)?.caseNumber}.
          </p>
        )}
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={() => runUpload(files, null)}
            className="flex-1 h-8 rounded-md bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Upload without case
          </button>
          <button
            type="button"
            onClick={() => runUpload(files, selectedCaseId)}
            className="flex-1 h-8 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
          >
            {selectedCaseId ? "Upload & attach" : "Upload"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={isIdle ? () => fileRef.current?.click() : undefined}
      className={`relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed select-none transition-all min-h-[140px] px-6 py-8 ${
        isDraggingFile
          ? "border-primary bg-primary/8 scale-[1.01] cursor-copy"
          : isDraggingCase
            ? "border-amber-400 bg-amber-50/50 dark:bg-amber-900/10 scale-[1.01] cursor-copy"
            : state.phase === "done"
              ? "border-success bg-success/5 cursor-default"
              : state.phase === "error"
                ? "border-destructive bg-destructive/5 cursor-default"
                : state.phase === "uploading"
                  ? "border-border bg-card cursor-wait"
                  : "border-border bg-card hover:border-primary/50 hover:bg-secondary/40 cursor-pointer"
      }`}
    >
      <input
        ref={fileRef}
        type="file"
        multiple
        className="sr-only"
        onChange={handleFileInput}
        aria-label="Upload files"
      />

      {state.phase === "uploading" && (
        <>
          <div className="h-10 w-10 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          <p className="text-sm text-muted-foreground">Uploading…</p>
        </>
      )}

      {state.phase === "done" && (
        <>
          <div className="h-10 w-10 rounded-full bg-success/15 flex items-center justify-center">
            <Upload size={18} className="text-success" />
          </div>
          <p className="text-sm font-medium text-success">{state.message}</p>
        </>
      )}

      {state.phase === "error" && (
        <>
          <div className="h-10 w-10 rounded-full bg-destructive/15 flex items-center justify-center">
            <AlertTriangle size={18} className="text-destructive" />
          </div>
          <p className="text-sm text-destructive">{state.message}</p>
        </>
      )}

      {isDraggingCase && (
        <>
          <div className="h-10 w-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
            <ClipboardList size={18} className="text-amber-600 dark:text-amber-400" />
          </div>
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
            Drop to acknowledge case
          </p>
        </>
      )}

      {isDraggingFile && (
        <>
          <div className="h-10 w-10 rounded-full bg-primary/15 flex items-center justify-center">
            <Upload size={18} className="text-primary" />
          </div>
          <p className="text-sm font-medium text-primary">Drop to upload</p>
        </>
      )}

      {isIdle && (
        <>
          <div className="h-10 w-10 rounded-full bg-secondary flex items-center justify-center">
            <Upload size={18} className="text-muted-foreground" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium">Drop files or cases here</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Files will be uploaded and optionally linked to a case
            </p>
          </div>
          <p className="text-xs text-primary font-medium">or click to browse</p>
        </>
      )}
    </div>
  );
}

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
            <DropZone cases={cases} />
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
