import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, Plus, Trash2 } from "lucide-react";
import { apiFetch, apiUrl, authedMediaFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatInvoiceDate } from "@/lib/invoice-date";
import { refreshCustomerBalanceQueries, refreshInvoiceSalesQueries } from "@/lib/refresh-case-finance";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import type { RecoveryBillingList, RecoveryBillingRow, RecoveryPricePreview, RecoveryPricedChild, RecoveryPricedLine,
  RecoveryPricedWork, RecoveryProposal as ApiRecoveryProposal } from "@workspace/api-client-react";

export type RecoveryState =
  | "unresolved"
  | "deleted_case" | "deleted_or_void_billing" | "held" | "released" | "existing_billing"
  | "do_not_bill" | "existing_work" | "exception" | "proposed" | "needs_prescription_review";

export type RecoveryChildCharge = RecoveryPricedChild;
export type RecoveryLine = RecoveryPricedLine;
export type RecoveryWorkRow = RecoveryPricedWork;
export type RecoveryProposal = ApiRecoveryProposal;
export type RecoveryCaseRow = RecoveryBillingRow;
type RecoveryList = RecoveryBillingList;
/** Owner/admin of the recovery lab, billing staff, or not yet known. */
type RecoveryAccess = "admin" | "staff" | null;
type CommitKind = "apply" | "correct" | "dnb" | "release";
interface PreviewState { data: RecoveryPricePreview | null; error: string | null; pending: boolean }

const STATE_LABEL: Record<RecoveryState, string> = {
  unresolved: "Unresolved provenance or billing",
  needs_prescription_review: "Needs prescription review", proposed: "Proposed", exception: "Proposal has exceptions",
  existing_work: "Existing work", do_not_bill: "Do not bill", existing_billing: "Existing billing",
  held: "Held replacement", released: "Released replacement",
  deleted_or_void_billing: "Deleted or void billing", deleted_case: "Deleted case",
};
const RATE_SOURCE: Record<string, string> = {
  override: "doctor override", discount: "discount off default tier", tier: "assigned tier", default: "lab default tier",
};
const PAGE = 25;
const PREVIEW_DELAY_MS = 400;
const money = (v: unknown) => `$${Number(v ?? 0).toFixed(2)}`;
const KEY = ["finance", "recovery-billing"];

interface WorkDraft { toothNumber: string; restorationType: string; restorationSubtype: string; arch: string; material: string; shade: string; quantity: string }
const blank = (): WorkDraft => ({ toothNumber: "", restorationType: "", restorationSubtype: "", arch: "", material: "", shade: "", quantity: "1" });

function errMsg(e: unknown) { return e instanceof Error ? e.message : "Request failed."; }

function rateSource(r: RecoveryPricedWork) {
  const kind = r.priceSource ? RATE_SOURCE[r.priceSource] ?? r.priceSource : null;
  if (kind && r.priceSourceName) return `${kind}: ${r.priceSourceName}`;
  return kind ?? r.priceSourceName ?? "no catalog rate";
}

/** Entered work exactly as staging and the price preview send it. Amounts are never sent. */
function workBody(attId: string, work: WorkDraft[], connectors: string) {
  return {
    evidenceAttachmentId: attId,
    restorations: work.map((w) => ({
      toothNumber: w.toothNumber.trim(), restorationType: w.restorationType.trim(),
      restorationSubtype: w.restorationSubtype.trim() || null,
      arch: w.arch === "upper" || w.arch === "lower" ? w.arch : null,
      material: w.material.trim() || null, shade: w.shade.trim() || null,
      quantity: Math.max(1, Math.floor(Number(w.quantity) || 1)),
    })),
    bridgeConnectors: connectors.trim() || null,
  };
}

async function openEvidence(caseId: string, attId: string) {
  const res = await authedMediaFetch(apiUrl(`/cases/${caseId}/attachments/${attId}/file`));
  if (!res.ok) throw new Error("Could not open the prescription file.");
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function useRecoveryMutation<V>(fn: (v: V) => Promise<unknown>, caseId: string, onCommit?: (v: V) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (_data, v) => {
      onCommit?.(v);
      // Write is committed; refresh failures must never surface as a retryable error.
      try { await qc.invalidateQueries({ queryKey: KEY }); } catch { /* best effort */ }
      try { await refreshInvoiceSalesQueries(qc, undefined, caseId); } catch { /* best effort */ }
      // Release moves a replacement onto the customer's balance; apply and void change what is held.
      try { await refreshCustomerBalanceQueries(qc); } catch { /* best effort */ }
    },
  });
}

function PricingBreakdown({ rows, lines, exceptions, exceptionsTestId }: {
  rows: RecoveryPricedWork[]; lines: RecoveryPricedLine[]; exceptions: string[]; exceptionsTestId: string;
}) {
  return (
    <>
      <ul className="space-y-1">
        {lines.map((l, i) => (
          <li key={i}>
            {String(l.description ?? "Line")} · {String(l.quantity ?? 1)} x {money(l.unitPrice)} = {money(l.lineTotal)}
            {l.childItems?.map((c, j) => (
              <div key={j} className="ml-4 text-xs text-muted-foreground">
                {String(c.description ?? "Child charge")} {c.priced === false ? "(no supported price)" : `${String(c.quantity ?? 1)} x ${money(c.unitPrice)} = ${money(c.lineTotal)}`}
              </div>
            ))}
          </li>
        ))}
      </ul>
      <ul className="text-xs text-muted-foreground">
        {rows.map((r) => (
          <li key={r.id}>
            {r.restorationType}{r.toothNumber ? ` #${r.toothNumber}` : ""}{r.arch ? ` ${r.arch}` : ""} · qty {r.quantity ?? 1} · rate {money(r.unitPrice)} · {rateSource(r)}
          </li>
        ))}
      </ul>
      {exceptions.length > 0 && (
        <ul className="text-xs text-destructive list-disc pl-4" data-testid={exceptionsTestId}>
          {exceptions.map((x) => <li key={x}>{x}</li>)}
        </ul>
      )}
    </>
  );
}

function PricePreview({ state }: { state: PreviewState | null }) {
  if (!state) return null;
  if (state.error) {
    return (
      <p role="status" className="text-xs text-amber-800" data-testid="preview-error">
        Price preview unavailable: {state.error} You can still enter work and stage it; staging prices it again.
      </p>
    );
  }
  if (!state.data) return <p className="text-xs text-muted-foreground" data-testid="preview-loading">Pricing at current catalog rates…</p>;
  const { data, pending } = state;
  return (
    <div className={`rounded border border-dashed p-3 text-sm space-y-2${pending ? " opacity-60" : ""}`} aria-busy={pending} data-testid="preview-price">
      <div className="font-medium">
        Current-rate replacement: <span data-testid="preview-total">{money(data.total)}</span>
        {pending && <span className="ml-2 text-xs font-normal text-muted-foreground">Updating…</span>}
      </div>
      <div className="text-xs text-muted-foreground">Priced from the current catalog, not the original invoice total. Preview only; nothing is saved until you stage.</div>
      <PricingBreakdown rows={data.rows} lines={data.lines} exceptions={data.exceptions} exceptionsTestId="preview-exceptions" />
      {data.exceptions.length > 0 && (
        <p className="text-xs text-destructive">These exceptions would block applying. They must be fixed and the work staged again before an owner or admin can apply it.</p>
      )}
    </div>
  );
}

function CaseCard({ row, access }: { row: RecoveryCaseRow; access: RecoveryAccess }) {
  const [committed, setCommitted] = useState<{ kind: CommitKind; proposalId: string | null } | null>(null);
  const savedRecovery = row.invoice?.recoveryBilling as { state?: string; proposalId?: string } | null;
  const confirmed = committed?.kind === "release" ? savedRecovery?.state === "released" :
    committed?.kind === "dnb" ? row.state === "do_not_bill" :
      (committed?.kind === "apply" || committed?.kind === "correct") && savedRecovery?.proposalId === committed.proposalId;
  useEffect(() => { if (confirmed) setCommitted(null); }, [confirmed]);
  const [mode, setMode] = useState<null | "propose" | "dnb" | "release">(null);
  const [evidenceErr, setEvidenceErr] = useState("");
  const [attId, setAttId] = useState(row.prescriptions[0]?.id ?? "");
  const [work, setWork] = useState<WorkDraft[]>([blank()]);
  const [connectors, setConnectors] = useState("");
  const [rxOk, setRxOk] = useState(false); const [idOk, setIdOk] = useState(false); const [dupOk, setDupOk] = useState(false);
  const [notes, setNotes] = useState(""); const [reason, setReason] = useState("");
  const [chargesOk, setChargesOk] = useState(false); const [payOk, setPayOk] = useState(false); const [evNotes, setEvNotes] = useState("");

  const p = row.proposal;
  const done = () => setMode(null);
  const commit = (kind: CommitKind, proposalId: string | null = row.proposalId) => {
    setCommitted({ kind, proposalId });
    done();
  };
  const propose = useRecoveryMutation(() => apiFetch(`/billing-recovery/cases/${row.caseId}/proposal`, {
    method: "POST",
    body: JSON.stringify({
      ...workBody(attId, work, connectors),
      prescriptionReviewed: true, identityReviewed: true, duplicateReviewed: true, reviewNotes: notes.trim(),
    }),
  }), row.caseId);
  const [analysis, setAnalysis] = useState<{ exceptions: string[]; extracted?: unknown } | null>(null);
  const analyze = useMutation({
    mutationFn: () => apiFetch<{ analysisId: string; restorations: Partial<WorkDraft & { quantity: number; arch: string | null }>[]; exceptions: string[]; extracted?: unknown }>(
      `/billing-recovery/cases/${row.caseId}/analyze`, { method: "POST", body: JSON.stringify({ evidenceAttachmentId: attId }) }),
    onSuccess: (r) => {
      setAnalysis({ exceptions: r.exceptions, extracted: r.extracted });
      setRxOk(false); setIdOk(false); setDupOk(false);
      if (r.restorations.length) setWork(r.restorations.map((x) => ({
        toothNumber: x.toothNumber ?? "", restorationType: x.restorationType ?? "", restorationSubtype: x.restorationSubtype ?? "",
        arch: x.arch ?? "", material: x.material ?? "", shade: x.shade ?? "", quantity: String(x.quantity ?? 1) })));
    },
  });
  const apply = useRecoveryMutation((proposalId: string) => apiFetch(`/billing-recovery/cases/${row.caseId}/apply`, {
    method: "POST", body: JSON.stringify({ proposalId }),
  }), row.caseId, (proposalId) => commit("apply", proposalId));
  const correct = useRecoveryMutation(() => apiFetch(`/billing-recovery/cases/${row.caseId}/correct`, {
    method: "POST", body: JSON.stringify({ proposalId: row.proposalId }),
  }), row.caseId, () => commit("correct"));
  const dnb = useRecoveryMutation(() => apiFetch(`/billing-recovery/cases/${row.caseId}/do-not-bill`, {
    method: "POST", body: JSON.stringify({ reason: reason.trim() }),
  }), row.caseId, () => commit("dnb"));
  const release = useRecoveryMutation(() => apiFetch(`/billing-recovery/cases/${row.caseId}/release`, {
    method: "POST",
    body: JSON.stringify({ chargesReviewed: true, historicalPaymentsReviewed: true,
      historicalSettlement: "independent_evidence_of_no_payment", evidenceNotes: evNotes.trim() }),
  }), row.caseId, () => commit("release"));

  const rowsTyped = work.every((w) => w.restorationType.trim());
  // Unsaved current-catalog pricing for exactly the entered work. Only the newest
  // request may update the card; a failure never blocks manual entry or staging.
  const previewBody = mode === "propose" && attId && rowsTyped && !analyze.isPending
    ? JSON.stringify(workBody(attId, work, connectors)) : null;
  const [preview, setPreview] = useState<PreviewState | null>(null);
  useEffect(() => {
    if (!previewBody) { setPreview(null); return; }
    let current = true;
    setPreview((prev) => ({ data: prev?.data ?? null, error: null, pending: true }));
    const timer = setTimeout(() => {
      apiFetch<RecoveryPricePreview>(`/billing-recovery/cases/${row.caseId}/preview`, { method: "POST", body: previewBody })
        .then((data) => { if (current) setPreview({ data, error: null, pending: false }); })
        .catch((e: unknown) => { if (current) setPreview({ data: null, error: errMsg(e), pending: false }); });
    }, PREVIEW_DELAY_MS);
    return () => { current = false; clearTimeout(timer); };
  }, [previewBody, row.caseId]);

  const canStage = !committed && (row.state === "needs_prescription_review" || row.state === "proposed" || row.state === "exception" || row.state === "held");
  const applyReady = row.state === "proposed" && !!p && !!row.proposalId && p.exceptions.length === 0;
  const canApply = !committed && applyReady && access === "admin";
  const canApplyCorrection = !committed && row.state === "held" && !!p && !!row.proposalId && !!row.invoice && p.previousInvoiceId === row.invoice.id && p.exceptions.length === 0 && savedRecovery?.proposalId !== row.proposalId;
  const missing = [
    !attId && "Select the prescription",
    !rowsTyped && "Give every work row a type",
    !rxOk && "Confirm you reviewed the prescription",
    !idOk && "Confirm doctor and practice identity",
    !dupOk && "Confirm you checked for duplicate work",
    !notes.trim() && "Add review notes",
    analyze.isPending && "Wait for the analysis to finish",
  ].filter((item): item is string => !!item);
  const canPropose = missing.length === 0;
  const missingId = `stage-missing-${row.caseId}`;
  const notesId = `review-notes-${row.caseId}`;
  const upd = (i: number, k: keyof WorkDraft, v: string) => setWork((ws) => ws.map((w, j) => (j === i ? { ...w, [k]: v } : w)));

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3" data-testid={`card-recovery-${row.caseId}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-semibold">Case {row.caseNumber} <span className="font-normal text-muted-foreground">· {row.patientName || "Unnamed patient"}</span></div>
          <div className="text-xs text-muted-foreground">{row.doctorName} · historical date {row.historicalDate}</div>
        </div>
        <div className="flex gap-2 items-center">
          {row.sourceFlagged && <Badge variant="outline">Source flagged</Badge>}
          <Badge variant="secondary" data-testid={`status-recovery-${row.caseId}`}>{STATE_LABEL[row.state]}</Badge>
        </div>
      </div>
      <div className="text-xs rounded bg-amber-50 text-amber-900 border border-amber-200 px-2 py-1">
        {savedRecovery?.state === "released"
          ? "Original payment history was not recovered. A lab admin reviewed independent settlement evidence before release."
          : "Historical payments: unknown. This is not evidence the work was unpaid."}
      </div>
      {row.rxNotes && <p className="text-sm"><span className="text-muted-foreground">Rx notes: </span>{row.rxNotes}</p>}

      <div className="flex flex-wrap gap-2 items-center">
        {row.prescriptions.length === 0 && <span className="text-xs text-muted-foreground">No verified prescription file attached.</span>}
        {row.prescriptions.map((f) => (
          <Button key={f.id} size="sm" variant="outline" data-testid={`button-evidence-${f.id}`}
            onClick={() => openEvidence(row.caseId, f.id).then(() => setEvidenceErr("")).catch((e) => setEvidenceErr(errMsg(e)))}>
            <ExternalLink className="h-3.5 w-3.5 mr-1" />{f.fileName}
          </Button>
        ))}
      </div>
      {evidenceErr && <p role="alert" className="text-xs text-destructive">{evidenceErr}</p>}
      {committed && <p role="status" className="text-sm text-amber-800" data-testid={`committed-${row.caseId}`}>Saved successfully. Financial actions are paused until the updated record is confirmed. Refresh the list; do not submit again.</p>}

      {p && (
        <div className="rounded border p-3 text-sm space-y-2" data-testid={`proposal-${row.caseId}`}>
          <div className="font-medium">Proposal at current catalog rates: {money(p.total)}</div>
          <div className="text-xs text-muted-foreground">Priced {new Date(p.pricingAt).toLocaleString()}. Current-rate replacement, not the original invoice total.</div>
          <PricingBreakdown rows={p.rows} lines={p.lines} exceptions={p.exceptions} exceptionsTestId={`exceptions-${row.caseId}`} />
        </div>
      )}

      {row.invoice && (row.state === "held" ? (
        <div className="text-sm rounded border border-sky-200 bg-sky-50 text-sky-950 p-3 space-y-1" data-testid={`invoice-${row.caseId}`}>
          <div className="font-medium">Held replacement invoice {row.invoice.invoiceNumber}</div>
          <div>Total {money(row.invoice.total)} · balance {money(row.invoice.balanceDue)}</div>
          <div className="text-xs">Not on the customer's balance yet. It goes on the balance only when an owner or admin reviews it for release.</div>
        </div>
      ) : row.state === "released" ? (
        <div className="text-sm rounded border border-emerald-200 bg-emerald-50 text-emerald-950 p-3 space-y-1" data-testid={`invoice-${row.caseId}`}>
          <div className="font-medium">Released — on customer's balance</div>
          <div>
            Invoice {row.invoice.invoiceNumber} · total {money(row.invoice.total)} · balance {money(row.invoice.balanceDue)}
            {row.invoice.dueAt ? ` · due ${formatInvoiceDate(row.invoice.dueAt)}` : ""}
          </div>
        </div>
      ) : (
        <div className="text-sm rounded border p-3" data-testid={`invoice-${row.caseId}`}>
          Invoice {row.invoice.invoiceNumber} · {row.invoice.status} · total {money(row.invoice.total)} · balance {money(row.invoice.balanceDue)}
        </div>
      ))}
      {row.state === "do_not_bill" && <p className="text-sm text-muted-foreground">Marked do not bill. Reason recorded in the audit trail.</p>}
      {(row.state === "existing_billing" || row.state === "existing_work" || row.state === "deleted_or_void_billing" || row.state === "deleted_case") && (
        <p className="text-sm text-muted-foreground">Existing or deleted billing takes precedence. No replacement can be created here.</p>
      )}

      <div className="flex flex-wrap gap-2">
        {canStage && <Button size="sm" onClick={() => setMode(mode === "propose" ? null : "propose")} data-testid={`button-propose-${row.caseId}`}>{p ? "Revise prescription work" : "Enter prescription work"}</Button>}
        {canStage && <Button size="sm" variant="outline" onClick={() => setMode(mode === "dnb" ? null : "dnb")} data-testid={`button-dnb-${row.caseId}`}>Do not bill</Button>}
        {canApply && p && row.proposalId && (
          <Button size="sm" onClick={() => apply.mutate(row.proposalId!)} disabled={apply.isPending} data-testid={`button-apply-${row.caseId}`}>
            {apply.isPending ? "Applying..." : `Apply as held invoice · ${money(p.total)}`}
          </Button>
        )}
        {canApplyCorrection && (
          <Button size="sm" onClick={() => correct.mutate(undefined)} disabled={correct.isPending} data-testid={`button-correct-${row.caseId}`}>{correct.isPending ? "Applying..." : "Apply held correction"}</Button>
        )}
        {row.state === "held" && access === "admin" && !committed && <Button size="sm" onClick={() => setMode(mode === "release" ? null : "release")} data-testid={`button-release-${row.caseId}`}>Review for release</Button>}
        {row.state === "held" && access === "staff" && <span className="text-xs text-muted-foreground">Release is restricted to owners and admins.</span>}
      </div>
      {!committed && applyReady && access && (
        <p className="text-xs text-muted-foreground" data-testid={`apply-help-${row.caseId}`}>
          {access === "admin"
            ? "Applying creates this case's held replacement invoice for the total above. It stays held, with a $0.00 balance and not on the customer's balance, until an owner or admin reviews it for release."
            : "An owner or admin must apply this proposal. Applying creates a held replacement invoice that stays off the customer's balance until it is reviewed for release."}
        </p>
      )}
      {!committed && row.state === "exception" && p && (
        <p className="text-xs text-destructive" data-testid={`apply-blocked-${row.caseId}`}>This proposal has exceptions, so it cannot be applied. They must be fixed and the work staged again.</p>
      )}

      {apply.isError && apply.variables === row.proposalId && <p role="alert" className="text-sm text-destructive" data-testid={`error-apply-${row.caseId}`}>{errMsg(apply.error)}</p>}
      {correct.isError && <p role="alert" className="text-sm text-destructive">{errMsg(correct.error)}</p>}
      {mode === "propose" && (
        <form className="space-y-3 border-t pt-3" onSubmit={(e) => { e.preventDefault(); if (canPropose) propose.mutate(undefined, { onSuccess: done }); }}>
          <p className="text-xs text-muted-foreground">Enter work from the prescription. Amounts are never entered; they come from the current catalog, and the price appears below as you enter work.</p>
          <div>
            <Label className="text-xs">Evidence prescription</Label>
            <select className="w-full border rounded h-9 px-2 text-sm bg-background" value={attId} disabled={analyze.isPending}
              onChange={(e) => { setAttId(e.target.value); setAnalysis(null); analyze.reset(); setRxOk(false); setIdOk(false); setDupOk(false); }} data-testid="select-evidence">
              <option value="">Select prescription</option>
              {row.prescriptions.map((f) => <option key={f.id} value={f.id}>{f.fileName}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <Button type="button" size="sm" variant="outline" disabled={!attId || analyze.isPending} onClick={() => analyze.mutate()} data-testid="button-analyze">{analyze.isPending ? "Analyzing..." : "Analyze prescription"}</Button>
            {analyze.isError && <p role="alert" className="text-sm text-destructive" data-testid="error-analyze">Analysis failed: {errMsg(analyze.error)} Enter work manually if needed.</p>}
            {analysis && <p className="text-xs text-muted-foreground">Fields were filled from analysis. Verify every row against the prescription; nothing is applied automatically.</p>}
            {analysis && analysis.exceptions.length > 0 && (
              <ul className="text-xs text-destructive list-disc pl-4" data-testid="analysis-exceptions">{analysis.exceptions.map((x) => <li key={x}>{x}</li>)}</ul>
            )}
          </div>
          <fieldset disabled={analyze.isPending} className="space-y-3">
            {work.map((w, i) => (
              <div key={i} className="grid grid-cols-2 md:grid-cols-7 gap-2 items-end">
                <Input placeholder="Type *" value={w.restorationType} onChange={(e) => upd(i, "restorationType", e.target.value)} data-testid={`input-type-${i}`} />
                <Input placeholder="Tooth #" value={w.toothNumber} onChange={(e) => upd(i, "toothNumber", e.target.value)} data-testid={`input-tooth-${i}`} />
                <select className="border rounded h-9 px-2 text-sm bg-background" value={w.arch} onChange={(e) => upd(i, "arch", e.target.value)} data-testid={`select-arch-${i}`}>
                  <option value="">No arch</option><option value="upper">Upper</option><option value="lower">Lower</option>
                </select>
                <Input placeholder="Material" value={w.material} onChange={(e) => upd(i, "material", e.target.value)} />
                <Input placeholder="Subtype" value={w.restorationSubtype} onChange={(e) => upd(i, "restorationSubtype", e.target.value)} />
                <Input placeholder="Shade" value={w.shade} onChange={(e) => upd(i, "shade", e.target.value)} />
                <div className="flex gap-1">
                  <Input type="number" min={1} max={32} value={w.quantity} onChange={(e) => upd(i, "quantity", e.target.value)} />
                  <Button type="button" size="icon" variant="ghost" disabled={work.length === 1} onClick={() => setWork((ws) => ws.filter((_, j) => j !== i))} aria-label="Remove row"><Trash2 className="h-4 w-4" /></Button>
                </div>
              </div>
            ))}
            <Button type="button" size="sm" variant="outline" disabled={work.length >= 64} onClick={() => setWork((ws) => [...ws, blank()])}><Plus className="h-3.5 w-3.5 mr-1" />Add work</Button>
            <Input placeholder="Bridge connectors (optional)" maxLength={200} value={connectors} onChange={(e) => setConnectors(e.target.value)} data-testid="input-connectors" />
            {previewBody ? <PricePreview state={preview} /> : attId && !rowsTyped && !analyze.isPending && (
              <p className="text-xs text-muted-foreground" data-testid="preview-idle">The current-catalog price appears once every work row has a type.</p>
            )}
            {([["I reviewed the prescription", rxOk, setRxOk, "rx"], ["I confirmed doctor and practice identity", idOk, setIdOk, "identity"], ["I checked for duplicate work", dupOk, setDupOk, "duplicate"]] as const).map(([t, v, set, id]) => (
              <label key={id} className="flex items-center gap-2 text-sm"><Checkbox checked={v} onCheckedChange={(c) => set(c === true)} data-testid={`check-${id}`} />{t}</label>
            ))}
            <div className="space-y-1">
              <Label htmlFor={notesId} className="text-xs">Review notes <span className="text-destructive">(required)</span></Label>
              <Textarea id={notesId} aria-required="true" placeholder="What you checked against the prescription" maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="input-review-notes" />
            </div>
          </fieldset>
          {propose.isError && <p role="alert" className="text-sm text-destructive">{errMsg(propose.error)}</p>}
          <div className="flex flex-wrap items-start gap-3">
            <Button type="submit" size="sm" disabled={!canPropose || propose.isPending} aria-describedby={canPropose ? undefined : missingId} data-testid="button-submit-proposal">{propose.isPending ? "Staging..." : "Stage proposal"}</Button>
            {!canPropose && (
              <div id={missingId} className="text-xs text-muted-foreground" data-testid="stage-missing">
                <div className="font-medium text-foreground">Still needed before staging:</div>
                <ul className="list-disc pl-4">{missing.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
            )}
          </div>
        </form>
      )}

      {mode === "dnb" && (
        <form className="space-y-2 border-t pt-3" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) dnb.mutate(undefined, { onSuccess: done }); }}>
          {row.state === "held" && <p className="text-xs text-muted-foreground">This voids the held replacement only. The case and its sources are preserved.</p>}
          <Textarea placeholder="Reason (required)" maxLength={4000} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="input-dnb-reason" />
          {dnb.isError && <p role="alert" className="text-sm text-destructive">{errMsg(dnb.error)}</p>}
          <Button type="submit" size="sm" variant="destructive" disabled={!reason.trim() || dnb.isPending} data-testid="button-submit-dnb">{dnb.isPending ? "Saving..." : "Confirm do not bill"}</Button>
        </form>
      )}

      {mode === "release" && (
        <form className="space-y-2 border-t pt-3" onSubmit={(e) => { e.preventDefault(); if (chargesOk && payOk && evNotes.trim().length >= 20) release.mutate(undefined, { onSuccess: done }); }}>
          <p className="text-xs text-muted-foreground">Releasing puts this replacement invoice on the customer's balance: it becomes open, with its total due by the normal invoice due date. Only continue with independent evidence that nothing was paid.</p>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={chargesOk} onCheckedChange={(c) => setChargesOk(c === true)} data-testid="check-charges" />I reviewed the charges</label>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={payOk} onCheckedChange={(c) => setPayOk(c === true)} data-testid="check-payments" />I reviewed historical payments and have independent evidence of no payment</label>
          <Textarea placeholder="Evidence notes (at least 20 characters)" maxLength={4000} value={evNotes} onChange={(e) => setEvNotes(e.target.value)} data-testid="input-evidence-notes" />
          {release.isError && <p role="alert" className="text-sm text-destructive">{errMsg(release.error)}</p>}
          <Button type="submit" size="sm" disabled={!chargesOk || !payOk || evNotes.trim().length < 20 || release.isPending} data-testid="button-submit-release">{release.isPending ? "Releasing..." : "Release invoice"}</Button>
        </form>
      )}
    </div>
  );
}

export default function RecoveryBillingPage() {
  const { user } = useAuth();
  const accessQ = useQuery({
    queryKey: ["billing-recovery", "access", user?.id],
    queryFn: () => apiFetch<{ available: boolean; role?: Exclude<RecoveryAccess, null> }>("/billing-recovery/access"),
    enabled: !!user,
    retry: false,
  });
  const access: RecoveryAccess =
    accessQ.data?.available === true ? accessQ.data.role ?? null : null;
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<RecoveryList>("/billing-recovery"),
    enabled: accessQ.data?.available === true,
  });
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  const rows = q.data?.rows ?? [];
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return rows.filter((r) => (filter === "all" || r.state === filter) &&
      (!s || `${r.caseNumber} ${r.patientName} ${r.doctorName}`.toLowerCase().includes(s)));
  }, [rows, filter, search]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const cur = Math.min(page, pages - 1);
  const slice = filtered.slice(cur * PAGE, cur * PAGE + PAGE);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4" data-testid="page-recovery-billing">
      <div>
        <h1 className="text-2xl font-semibold">Recovery Billing</h1>
        <p className="text-sm text-muted-foreground">Review lost-work evidence and stage replacement billing. Nothing here collects payment.</p>
      </div>
      {accessQ.isError && (
        <div role="alert" className="rounded border border-destructive/40 p-4 text-sm" data-testid="error-recovery-access">
          {errMsg(accessQ.error)}
        </div>
      )}
      {accessQ.isSuccess && accessQ.data.available !== true && (
        <div className="rounded border p-4 text-sm text-muted-foreground" data-testid="error-recovery-access-unavailable">
          Recovery billing is not available for this account.
        </div>
      )}
      <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 p-3 text-sm">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <div data-testid="recovery-flow-help">
          Replacements use current catalog rates, not original totals. Historical payments are unknown, so no case is assumed unpaid.
          Billing staff stage a proposal. An owner or admin applies it, which creates a held replacement invoice that is not on the customer's balance.
          An owner or admin then reviews it for release, which puts it on the customer's balance.
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input className="max-w-xs" placeholder="Search case, patient, doctor" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} data-testid="input-search" />
        <select className="border rounded h-9 px-2 text-sm bg-background" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }} data-testid="select-state">
          <option value="all">All states</option>
          {Object.entries(STATE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {q.isLoading && <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-32 w-full" />)}</div>}
      {q.isError && (
        <div role="alert" className="rounded border border-destructive/40 p-4 text-sm" data-testid="error-recovery">
          {errMsg(q.error)} <Button size="sm" variant="outline" className="ml-2" onClick={() => q.refetch()}>Retry</Button>
        </div>
      )}
      {q.data && filtered.length === 0 && <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground" data-testid="empty-recovery">No cases match these filters.</div>}
      <div className="space-y-3">{slice.map((r) => <CaseCard key={r.caseId} row={r} access={access} />)}</div>
      {q.data && filtered.length > PAGE && (
        <div className="flex items-center justify-between text-sm">
          <Button size="sm" variant="outline" disabled={cur === 0} onClick={() => setPage(cur - 1)}>Previous</Button>
          <span>Page {cur + 1} of {pages} · {filtered.length} cases</span>
          <Button size="sm" variant="outline" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}
