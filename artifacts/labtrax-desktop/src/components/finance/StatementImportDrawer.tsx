/**
 * StatementImportDrawer — owner-only AI bank-statement import UI for the
 * desktop register page.
 *
 * Flow:
 *  1. Owner drops or picks a PDF/PNG/JPG/WEBP file.
 *  2. File is uploaded to POST /finance/transactions/import/preview.
 *  3. A review table shows extracted rows with confidence badges and duplicate flags.
 *  4. Owner edits, deletes, or approves rows, then clicks "Import".
 *  5. Approved rows are committed via POST /finance/transactions/import/confirm.
 */

import { useCallback, useRef, useState, type DragEvent } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, FileText, Loader2, Trash2, Upload, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { toast } from "@/hooks/use-toast";

const ALLOWED_MIME = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
const ALLOWED_EXT = /\.(pdf|png|jpg|jpeg|webp)$/i;

type Confidence = "high" | "medium" | "low";

interface ExtractedRow {
  rowIndex: number;
  txnDate: string;
  description: string;
  checkNumber: string | null;
  debit: number;
  credit: number;
  confidence: Confidence;
  duplicateCandidateId: string | null;
  duplicateCandidateDate: string | null;
  duplicateCandidatePayee: string | null;
  duplicateCandidateAmount: number | null;
  duplicateScore: number;
}

interface EditableRow extends ExtractedRow {
  approved: boolean;
  markedDuplicate: boolean;
  expanded: boolean;
}

interface Props {
  organizationId: string;
  accountId: string;
  accountName?: string;
  onClose: () => void;
  onImported: () => void;
}

type Phase = "upload" | "parsing" | "review" | "confirming" | "done";

const CONFIDENCE_BADGE: Record<Confidence, { label: string; cls: string }> = {
  high: { label: "High", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300" },
  medium: { label: "Medium", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300" },
  low: { label: "Low", cls: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300" },
};

export function StatementImportDrawer({ organizationId, accountId, accountName, onClose, onImported }: Props) {
  const [phase, setPhase] = useState<Phase>("upload");
  const [dragOver, setDragOver] = useState(false);
  const [filename, setFilename] = useState("");
  const [previewToken, setPreviewToken] = useState("");
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function validateFile(f: File): string | null {
    if (!ALLOWED_MIME.includes(f.type) && !ALLOWED_EXT.test(f.name)) {
      return "Only PDF, PNG, JPG, or WEBP files are supported.";
    }
    if (f.size > 20 * 1024 * 1024) return "File must be under 20 MB.";
    return null;
  }

  async function uploadFile(f: File) {
    const err = validateFile(f);
    if (err) { setError(err); return; }
    setError(null);
    setFilename(f.name);
    setPhase("parsing");
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("organizationId", organizationId);
      fd.append("bankAccountId", accountId);

      const resp = await apiFetch<{
        previewToken: string;
        rows: ExtractedRow[];
        filename: string;
        totalCount: number;
      }>("/finance/transactions/import/preview", { method: "POST", body: fd });

      const editableRows: EditableRow[] = resp.rows.map((r) => ({
        ...r,
        approved: r.duplicateScore < 0.7,
        markedDuplicate: r.duplicateScore >= 0.7,
        expanded: false,
      }));
      setPreviewToken(resp.previewToken);
      setRows(editableRows);
      setPhase("review");
    } catch (e: any) {
      setError(e?.message ?? "Failed to parse the statement. Please try again.");
      setPhase("upload");
    }
  }

  function onFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) void uploadFile(f);
    e.target.value = "";
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) void uploadFile(f);
  }

  function toggleApprove(idx: number) {
    setRows((prev) =>
      prev.map((r, i) => i === idx ? { ...r, approved: !r.approved, markedDuplicate: false } : r)
    );
  }

  function toggleDuplicate(idx: number) {
    setRows((prev) =>
      prev.map((r, i) => i === idx ? { ...r, markedDuplicate: !r.markedDuplicate, approved: r.markedDuplicate } : r)
    );
  }

  function toggleExpand(idx: number) {
    setRows((prev) =>
      prev.map((r, i) => i === idx ? { ...r, expanded: !r.expanded } : r)
    );
  }

  function deleteRow(idx: number) {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateField(idx: number, field: "txnDate" | "description" | "checkNumber" | "debit" | "credit", value: string) {
    setRows((prev) =>
      prev.map((r, i) => {
        if (i !== idx) return r;
        if (field === "debit" || field === "credit") {
          const num = Math.max(0, parseFloat(value) || 0);
          return { ...r, [field]: num };
        }
        return { ...r, [field]: value };
      })
    );
  }

  function approveAll() {
    setRows((prev) => prev.map((r) => ({ ...r, approved: true, markedDuplicate: false })));
  }

  async function confirmImport() {
    const approvedRows = rows.filter((r) => r.approved && !r.markedDuplicate);
    if (!approvedRows.length) {
      setError("No approved rows to import.");
      return;
    }
    setPhase("confirming");
    setError(null);
    try {
      const skippedCount = rows.length - approvedRows.length;
      await apiFetch("/finance/transactions/import/confirm", {
        method: "POST",
        body: JSON.stringify({
          previewToken,
          organizationId,
          bankAccountId: accountId,
          sourceFilename: filename,
          approvedRows: approvedRows.map((r) => ({
            rowIndex: r.rowIndex,
            txnDate: r.txnDate,
            description: r.description,
            checkNumber: r.checkNumber ?? null,
            debit: r.debit,
            credit: r.credit,
          })),
          skippedCount,
        }),
      });
      setPhase("done");
      toast({ title: `Imported ${approvedRows.length} transaction${approvedRows.length !== 1 ? "s" : ""}`, description: `From ${filename}` });
      onImported();
    } catch (e: any) {
      setError(e?.message ?? "Import failed. Please try again.");
      setPhase("review");
    }
  }

  const approvedCount = rows.filter((r) => r.approved && !r.markedDuplicate).length;
  const dupFlagCount = rows.filter((r) => r.duplicateCandidateId && !r.markedDuplicate).length;

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-foreground/30" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-3xl bg-card border-l border-border h-full flex flex-col overflow-hidden">
        <header className="flex-none sticky top-0 z-10 bg-card border-b border-border px-6 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Import from Statement</h2>
            {accountName && (
              <p className="text-xs text-muted-foreground mt-0.5">Account: {accountName}</p>
            )}
          </div>
          <button type="button" onClick={onClose} className="h-9 w-9 rounded-md hover:bg-secondary flex items-center justify-center">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
          {error && (
            <div className="flex items-start gap-2 px-4 py-3 rounded-md bg-destructive/10 text-destructive text-sm">
              <AlertTriangle size={15} className="mt-0.5 flex-none" />
              <span>{error}</span>
            </div>
          )}

          {(phase === "upload" || phase === "parsing") && (
            <UploadZone
              dragOver={dragOver}
              parsing={phase === "parsing"}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClickPick={() => fileInputRef.current?.click()}
            />
          )}

          {phase === "review" && (
            <>
              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{filename}</span>
                  {" · "}{rows.length} row{rows.length !== 1 ? "s" : ""} extracted
                  {dupFlagCount > 0 && (
                    <span className="ml-2 text-amber-600 dark:text-amber-400">
                      · {dupFlagCount} possible duplicate{dupFlagCount !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={approveAll}
                    className="h-8 px-3 rounded-md bg-secondary text-xs font-medium hover:bg-secondary/80"
                  >
                    Approve all
                  </button>
                  <button
                    type="button"
                    onClick={() => { setPhase("upload"); setRows([]); setPreviewToken(""); setFilename(""); }}
                    className="h-8 px-3 rounded-md bg-secondary text-xs font-medium hover:bg-secondary/80"
                  >
                    Re-upload
                  </button>
                </div>
              </div>

              <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full text-xs border-collapse">
                  <thead className="bg-secondary/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="text-left font-medium px-3 py-2 w-8">✓</th>
                      <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                      <th className="text-left font-medium px-3 py-2">Description / Payee</th>
                      <th className="text-left font-medium px-3 py-2 w-20">Check #</th>
                      <th className="text-right font-medium px-3 py-2 w-24">Payment</th>
                      <th className="text-right font-medium px-3 py-2 w-24">Deposit</th>
                      <th className="text-left font-medium px-3 py-2 w-20">Confidence</th>
                      <th className="px-2 py-2 w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, idx) => (
                      <ReviewRow
                        key={`${r.rowIndex}-${idx}`}
                        row={r}
                        onToggleApprove={() => toggleApprove(idx)}
                        onToggleDuplicate={() => toggleDuplicate(idx)}
                        onToggleExpand={() => toggleExpand(idx)}
                        onDelete={() => deleteRow(idx)}
                        onFieldChange={(f, v) => updateField(idx, f, v)}
                      />
                    ))}
                    {!rows.length && (
                      <tr>
                        <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                          No transactions were extracted from this file.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {phase === "confirming" && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Loader2 size={32} className="animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Importing transactions…</p>
            </div>
          )}

          {phase === "done" && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <CheckCircle2 size={40} className="text-emerald-500" />
              <p className="text-base font-medium">Import complete</p>
              <p className="text-sm text-muted-foreground">Transactions have been added to the register.</p>
              <button type="button" onClick={onClose} className="mt-2 h-9 px-6 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90">
                Close
              </button>
            </div>
          )}
        </div>

        {phase === "review" && (
          <footer className="flex-none border-t border-border px-6 py-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {approvedCount} of {rows.length} rows approved
            </p>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose} className="h-9 px-4 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmImport()}
                disabled={approvedCount === 0}
                className="h-9 px-5 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Import {approvedCount} transaction{approvedCount !== 1 ? "s" : ""}
              </button>
            </div>
          </footer>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp"
          className="hidden"
          onChange={onFileInputChange}
        />
      </div>
    </div>
  );
}

function UploadZone({
  dragOver,
  parsing,
  onDragOver,
  onDragLeave,
  onDrop,
  onClickPick,
}: {
  dragOver: boolean;
  parsing: boolean;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onClickPick: () => void;
}) {
  if (parsing) {
    return (
      <div className="border-2 border-dashed border-border rounded-xl p-12 flex flex-col items-center justify-center gap-4 text-center">
        <Loader2 size={36} className="animate-spin text-primary" />
        <div>
          <p className="text-sm font-medium">Analyzing statement with AI…</p>
          <p className="text-xs text-muted-foreground mt-1">This may take 10–30 seconds.</p>
        </div>
      </div>
    );
  }
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`border-2 border-dashed rounded-xl p-12 flex flex-col items-center justify-center gap-4 text-center cursor-pointer transition-colors ${
        dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-secondary/30"
      }`}
      onClick={onClickPick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClickPick()}
    >
      <div className="h-14 w-14 rounded-full bg-secondary flex items-center justify-center">
        <FileText size={28} className="text-muted-foreground" />
      </div>
      <div>
        <p className="text-sm font-medium">Drop your bank statement here</p>
        <p className="text-xs text-muted-foreground mt-1">
          PDF, PNG, JPG, or WEBP · Max 20 MB
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Mobile or desktop banking screenshot accepted
        </p>
      </div>
      <button
        type="button"
        className="h-9 px-5 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 inline-flex items-center gap-1.5"
        onClick={(e) => { e.stopPropagation(); onClickPick(); }}
      >
        <Upload size={14} /> Choose file
      </button>
    </div>
  );
}

function ReviewRow({
  row,
  onToggleApprove,
  onToggleDuplicate,
  onToggleExpand,
  onDelete,
  onFieldChange,
}: {
  row: EditableRow;
  onToggleApprove: () => void;
  onToggleDuplicate: () => void;
  onToggleExpand: () => void;
  onDelete: () => void;
  onFieldChange: (field: "txnDate" | "description" | "checkNumber" | "debit" | "credit", value: string) => void;
}) {
  const hasDup = !!row.duplicateCandidateId;
  const badge = CONFIDENCE_BADGE[row.confidence];
  const rowCls = row.markedDuplicate
    ? "opacity-50 bg-secondary/20"
    : !row.approved
    ? "bg-secondary/10"
    : "";

  return (
    <>
      <tr className={`border-t border-border ${rowCls}`}>
        <td className="px-3 py-2">
          <input
            type="checkbox"
            checked={row.approved && !row.markedDuplicate}
            onChange={onToggleApprove}
            className="h-4 w-4 rounded"
          />
        </td>
        <td className="px-3 py-2">
          <input
            type="date"
            value={row.txnDate}
            onChange={(e) => onFieldChange("txnDate", e.target.value)}
            className="w-full bg-transparent focus:outline-none focus:bg-card focus:ring-1 focus:ring-primary rounded px-1"
          />
        </td>
        <td className="px-3 py-2">
          <input
            type="text"
            value={row.description}
            onChange={(e) => onFieldChange("description", e.target.value)}
            className="w-full bg-transparent focus:outline-none focus:bg-card focus:ring-1 focus:ring-primary rounded px-1"
          />
        </td>
        <td className="px-3 py-2">
          <input
            type="text"
            value={row.checkNumber ?? ""}
            onChange={(e) => onFieldChange("checkNumber", e.target.value)}
            placeholder="—"
            className="w-full bg-transparent focus:outline-none focus:bg-card focus:ring-1 focus:ring-primary rounded px-1 text-center"
          />
        </td>
        <td className="px-3 py-2 text-right">
          <input
            type="number"
            min="0"
            step="0.01"
            value={row.debit || ""}
            onChange={(e) => onFieldChange("debit", e.target.value)}
            placeholder="0.00"
            className="w-full bg-transparent focus:outline-none focus:bg-card focus:ring-1 focus:ring-primary rounded px-1 text-right tabular-nums"
          />
        </td>
        <td className="px-3 py-2 text-right">
          <input
            type="number"
            min="0"
            step="0.01"
            value={row.credit || ""}
            onChange={(e) => onFieldChange("credit", e.target.value)}
            placeholder="0.00"
            className="w-full bg-transparent focus:outline-none focus:bg-card focus:ring-1 focus:ring-primary rounded px-1 text-right tabular-nums"
          />
        </td>
        <td className="px-3 py-2">
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold leading-none ${badge.cls}`}>
            {badge.label}
          </span>
        </td>
        <td className="px-2 py-2">
          <div className="flex items-center gap-0.5">
            {hasDup && (
              <button
                type="button"
                onClick={onToggleExpand}
                title="View possible duplicate"
                className="h-6 w-6 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-600 flex items-center justify-center"
              >
                {row.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
            )}
            <button
              type="button"
              onClick={onDelete}
              className="h-6 w-6 rounded hover:bg-secondary text-muted-foreground hover:text-destructive flex items-center justify-center"
            >
              <Trash2 size={11} />
            </button>
          </div>
        </td>
      </tr>
      {hasDup && row.expanded && (
        <tr className="bg-amber-50 dark:bg-amber-950/30 border-t border-amber-200 dark:border-amber-800">
          <td colSpan={8} className="px-4 py-3">
            <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 mb-2 flex items-center gap-1.5">
              <AlertTriangle size={12} /> Possible duplicate detected
            </p>
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div className="space-y-1">
                <p className="font-medium text-muted-foreground uppercase tracking-wide text-[10px]">This import row</p>
                <p>{row.txnDate} · {row.description}</p>
                <p className="tabular-nums">
                  {row.debit > 0 ? `Payment ${formatMoney(row.debit)}` : `Deposit ${formatMoney(row.credit)}`}
                </p>
              </div>
              <div className="space-y-1">
                <p className="font-medium text-muted-foreground uppercase tracking-wide text-[10px]">Existing register entry</p>
                <p>{row.duplicateCandidateDate} · {row.duplicateCandidatePayee ?? "—"}</p>
                <p className="tabular-nums">{formatMoney(row.duplicateCandidateAmount ?? 0)}</p>
              </div>
            </div>
            <div className="flex items-center gap-3 mt-3">
              <button
                type="button"
                onClick={onToggleDuplicate}
                className={`h-7 px-3 rounded text-[11px] font-medium ${row.markedDuplicate ? "bg-amber-200 text-amber-900 dark:bg-amber-800 dark:text-amber-100" : "bg-secondary text-foreground hover:bg-secondary/80"}`}
              >
                {row.markedDuplicate ? "Marked as duplicate (excluded)" : "Mark as duplicate"}
              </button>
              {row.markedDuplicate && (
                <button
                  type="button"
                  onClick={onToggleDuplicate}
                  className="h-7 px-3 rounded bg-secondary text-foreground text-[11px] font-medium hover:bg-secondary/80"
                >
                  Keep both
                </button>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
