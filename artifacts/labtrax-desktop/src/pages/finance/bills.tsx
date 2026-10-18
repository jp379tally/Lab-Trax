import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { FinanceShell } from "@/components/finance/FinanceShell";
import { NewVendorDialog } from "@/components/finance/NewVendorDialog";
import { formatDate, formatMoney } from "@/lib/format";
import type {
  Bill,
  BillDetail,
  BillLineInput,
  BillStatusFilter,
  VendorApSummary,
  VendorCredit,
  VendorLite,
} from "@/lib/ap-types";
import { todayIsoDate, useApCategories, useApVendors } from "@/lib/ap";

export default function BillsPage() {
  return (
    <FinanceShell>
      {({ organizationId }) => <BillsContent organizationId={organizationId} />}
    </FinanceShell>
  );
}

const STATUS_FILTERS: Array<{ key: BillStatusFilter; label: string }> = [
  { key: "open", label: "Unpaid" },
  { key: "paid", label: "Paid" },
  { key: "void", label: "Void" },
  { key: "all", label: "All" },
];

function BillsContent({ organizationId }: { organizationId: string }) {
  const [status, setStatus] = useState<BillStatusFilter>("open");
  const [search, setSearch] = useState("");
  const [editorBillId, setEditorBillId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [detailBillId, setDetailBillId] = useState<string | null>(null);
  const [vendorDetailId, setVendorDetailId] = useState<string | null>(null);

  const params = new URLSearchParams({ organizationId, status });
  if (search.trim()) params.set("search", search.trim());

  const billsQuery = useQuery({
    queryKey: ["finance", "bills", params.toString()],
    queryFn: () => apiFetch<Bill[]>(`/finance/bills?${params.toString()}`),
  });

  const bills = billsQuery.data ?? [];
  const totalDue = bills.reduce((sum, bill) => sum + Number(bill.balanceDue || 0), 0);

  if (vendorDetailId) {
    return (
      <VendorApDetail
        organizationId={organizationId}
        vendorId={vendorDetailId}
        onBack={() => setVendorDetailId(null)}
        onOpenBill={(id) => {
          setVendorDetailId(null);
          setDetailBillId(id);
        }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md bg-secondary p-0.5">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.key}
              type="button"
              onClick={() => setStatus(filter.key)}
              className={`px-3 h-8 text-sm rounded ${
                status === filter.key
                  ? "bg-card shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search bill number, memo, vendor"
            className="h-9 pl-8 pr-3 w-72 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          />
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="text-sm text-muted-foreground">
            Showing{" "}
            <span className="tabular-nums font-medium text-foreground">
              {formatMoney(totalDue)}
            </span>{" "}
            due
          </div>
          <button
            type="button"
            onClick={() => {
              setEditorBillId(null);
              setShowEditor(true);
            }}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
          >
            <Plus size={15} /> Enter Bill
          </button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="text-left font-medium px-4 py-2">Vendor</th>
                <th className="text-left font-medium py-2">Bill #</th>
                <th className="text-left font-medium py-2">Bill date</th>
                <th className="text-left font-medium py-2">Due</th>
                <th className="text-left font-medium py-2">Status</th>
                <th className="text-right font-medium py-2">Amount</th>
                <th className="text-right font-medium px-4 py-2">Balance</th>
              </tr>
            </thead>
            <tbody>
              {billsQuery.isLoading && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading bills…
                  </td>
                </tr>
              )}
              {billsQuery.isError && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-destructive">
                    Could not load bills.{" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => billsQuery.refetch()}
                    >
                      Try again
                    </button>
                  </td>
                </tr>
              )}
              {!billsQuery.isLoading &&
                !billsQuery.isError &&
                bills.map((bill) => (
                  <tr
                    key={bill.id}
                    className="border-t border-border hover:bg-secondary/30 cursor-pointer"
                    onClick={() => setDetailBillId(bill.id)}
                  >
                    <td className="px-4 py-2.5">
                      <button
                        type="button"
                        className="hover:underline text-left"
                        onClick={(event) => {
                          event.stopPropagation();
                          setVendorDetailId(bill.vendorId);
                        }}
                      >
                        {bill.vendorName}
                      </button>
                      {bill.vendorIsActive === false && (
                        <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                          inactive
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-muted-foreground">{bill.billNumber ?? "—"}</td>
                    <td className="py-2.5">{formatDate(bill.billDate)}</td>
                    <td className="py-2.5">
                      <DueCell dueDate={bill.dueDate} settled={Number(bill.balanceDue) <= 0} />
                    </td>
                    <td className="py-2.5">
                      <StatusBadge status={bill.status} />
                    </td>
                    <td className="py-2.5 text-right tabular-nums">{formatMoney(bill.total)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                      {formatMoney(bill.balanceDue)}
                    </td>
                  </tr>
                ))}
              {!billsQuery.isLoading && !billsQuery.isError && !bills.length && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                    No bills match this filter. Enter a bill to record what the lab owes
                    without moving money yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showEditor && (
        <BillEditor
          organizationId={organizationId}
          billId={editorBillId}
          onClose={() => {
            setShowEditor(false);
            setEditorBillId(null);
          }}
        />
      )}
      {detailBillId && (
        <BillDetailDrawer
          organizationId={organizationId}
          billId={detailBillId}
          onClose={() => setDetailBillId(null)}
          onEdit={(id) => {
            setDetailBillId(null);
            setEditorBillId(id);
            setShowEditor(true);
          }}
        />
      )}
    </div>
  );
}

function DueCell({ dueDate, settled }: { dueDate: string; settled: boolean }) {
  const overdue = !settled && new Date(dueDate).getTime() < Date.now();
  return (
    <span className={overdue ? "text-destructive font-medium" : ""}>
      {formatDate(dueDate)}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    open: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    partially_paid: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
    paid: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
    void: "bg-secondary text-muted-foreground",
  };
  const labels: Record<string, string> = {
    open: "Unpaid",
    partially_paid: "Partly paid",
    paid: "Paid",
    void: "Void",
  };
  return (
    <span
      className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${
        styles[status] ?? "bg-secondary text-muted-foreground"
      }`}
    >
      {labels[status] ?? status}
    </span>
  );
}

// ─────────────────────────── Enter / edit a bill ───────────────────────────

interface LineDraft {
  key: string;
  categoryId: string;
  description: string;
  amount: string;
}

const newLine = (): LineDraft => ({
  key: Math.random().toString(36).slice(2),
  categoryId: "",
  description: "",
  amount: "",
});

/**
 * Value of the "+ Add new vendor…" row. Choosing it only opens the New vendor
 * window; the bill's vendor never takes this value.
 */
const ADD_NEW_VENDOR = "__add_new_vendor__";

/** Keys that step a closed <select> from row to row on Windows and Linux. */
const SELECT_STEP_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "PageDown",
  "PageUp",
  "Home",
  "End",
]);

function BillEditor({
  organizationId,
  billId,
  onClose,
}: {
  organizationId: string;
  billId: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const vendors = useApVendors(organizationId);
  const categories = useApCategories(organizationId);

  const existing = useQuery({
    queryKey: ["finance", "bill", billId],
    queryFn: () => apiFetch<BillDetail>(`/finance/bills/${billId}`),
    enabled: !!billId,
  });

  const [vendorId, setVendorId] = useState("");
  const [billNumber, setBillNumber] = useState("");
  const [billDate, setBillDate] = useState(todayIsoDate());
  const [dueDate, setDueDate] = useState("");
  const [termsDays, setTermsDays] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [showNewVendor, setShowNewVendor] = useState(false);
  // Vendors created from this form. They stay listed even before the
  // refreshed vendor list includes them, so the selected row always exists.
  const [createdVendors, setCreatedVendors] = useState<VendorLite[]>([]);
  const vendorSelectRef = useRef<HTMLSelectElement>(null);
  const steppingVendors = useRef(false);

  const vendorOptions = useMemo(() => {
    const loaded = vendors.data ?? [];
    const missing = createdVendors.filter(
      (created) => !loaded.some((vendor) => vendor.id === created.id),
    );
    return missing.length ? [...loaded, ...missing] : loaded;
  }, [vendors.data, createdVendors]);

  function applyVendorTerms(vendor: VendorLite | undefined) {
    const days = vendor?.paymentTermsDays;
    if (days == null) return;
    setTermsDays((current) => (current.trim() === "" ? String(days) : current));
  }

  function chooseVendor(nextId: string) {
    if (nextId === ADD_NEW_VENDOR) {
      if (steppingVendors.current) {
        // An arrow key walked onto the Add New row. Land on the first vendor
        // rather than opening the window in the middle of scrolling.
        const first = vendorOptions[0];
        if (first && first.id !== vendorId) chooseVendor(first.id);
        return;
      }
      // vendorId is left alone, so React puts the field back to it.
      setShowNewVendor(true);
      return;
    }
    setVendorId(nextId);
    applyVendorTerms(vendorOptions.find((vendor) => vendor.id === nextId));
  }

  function noteVendorStep(event: React.KeyboardEvent<HTMLSelectElement>) {
    if (event.altKey || !SELECT_STEP_KEYS.has(event.key)) return;
    steppingVendors.current = true;
    // An arrow key's change arrives before this timer runs. A later change
    // came from a click, Enter or typing.
    window.setTimeout(() => {
      steppingVendors.current = false;
    }, 0);
  }

  function closeNewVendor() {
    setShowNewVendor(false);
    vendorSelectRef.current?.focus();
  }

  function selectCreatedVendor(vendor: VendorLite) {
    // Select straight from the save response. The vendor lists refresh in the
    // background and are not needed for this.
    setCreatedVendors((prev) => [...prev.filter((v) => v.id !== vendor.id), vendor]);
    setVendorId(vendor.id);
    applyVendorTerms(vendor);
    closeNewVendor();
  }

  // Hydrate once per loaded bill rather than in an effect that fights edits.
  if (billId && existing.data && hydratedFor !== billId) {
    const bill = existing.data;
    setHydratedFor(billId);
    setVendorId(bill.vendorId);
    setBillNumber(bill.billNumber ?? "");
    setBillDate(bill.billDate.slice(0, 10));
    setDueDate(bill.dueDate.slice(0, 10));
    setTermsDays(bill.termsDays == null ? "" : String(bill.termsDays));
    setMemo(bill.memo ?? "");
    setLines(
      bill.lines.length
        ? bill.lines.map((line) => ({
            key: line.id,
            categoryId: line.categoryId ?? "",
            description: line.description,
            amount: line.amount,
          }))
        : [newLine()],
    );
  }

  const total = lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0);
  const settledAmount = existing.data
    ? Number(existing.data.total) - Number(existing.data.balanceDue)
    : 0;

  const save = useMutation({
    mutationFn: async (acknowledgeDuplicateReference: boolean) => {
      const payload: {
        organizationId?: string;
        vendorId?: string;
        billNumber: string | null;
        billDate: string;
        dueDate: string | null;
        termsDays: number | null;
        memo: string | null;
        lines: BillLineInput[];
        acknowledgeDuplicateReference?: boolean;
      } = {
        billNumber: billNumber.trim() || null,
        billDate,
        dueDate: dueDate || null,
        termsDays: termsDays.trim() === "" ? null : Number(termsDays),
        memo: memo.trim() || null,
        lines: lines.map((line) => ({
          categoryId: line.categoryId || null,
          description: line.description.trim(),
          amount: Number(line.amount),
        })),
      };
      if (acknowledgeDuplicateReference) payload.acknowledgeDuplicateReference = true;
      if (billId) {
        return apiFetch<Bill>(`/finance/bills/${billId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      }
      return apiFetch<Bill>("/finance/bills", {
        method: "POST",
        body: JSON.stringify({ ...payload, organizationId, vendorId }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["finance", "bills"] });
      qc.invalidateQueries({ queryKey: ["finance", "pay-bills"] });
      qc.invalidateQueries({ queryKey: ["finance", "ap-summary"] });
      onClose();
    },
    onError: (err: unknown) => {
      const body = (err as { body?: { error?: { code?: string; message?: string } } })?.body;
      if (body?.error?.code === "duplicate_bill_reference") {
        setDuplicateWarning(body.error.message ?? "This vendor already has a bill with that number.");
        setError(null);
        return;
      }
      setDuplicateWarning(null);
      setError(err instanceof Error ? err.message : "Could not save this bill.");
    },
  });

  function validate(): string | null {
    if (!billId && !vendorId) return "Choose a vendor.";
    if (!billDate) return "Enter the bill date.";
    if (dueDate && dueDate < billDate) return "The due date cannot be before the bill date.";
    if (!lines.length) return "Add at least one line.";
    for (const line of lines) {
      if (!line.description.trim()) return "Every line needs a description.";
      if (line.amount.trim() === "" || Number.isNaN(Number(line.amount))) {
        return "Every line needs an amount.";
      }
    }
    if (billId && total < settledAmount) {
      return `This bill already has ${formatMoney(settledAmount)} applied to it. The total cannot go below that.`;
    }
    return null;
  }

  function submit(acknowledge: boolean) {
    const problem = validate();
    if (problem) {
      setError(problem);
      setDuplicateWarning(null);
      return;
    }
    setError(null);
    save.mutate(acknowledge);
  }

  const busy = save.isPending || (!!billId && existing.isLoading);

  return (
    <>
      <Modal title={billId ? "Edit bill" : "Enter bill"} onClose={onClose} wide>
        {billId && existing.isLoading ? (
          <div className="py-12 text-center text-muted-foreground">
            <Loader2 size={16} className="inline animate-spin mr-2" />
            Loading bill…
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Field label="Vendor">
                <select
                  ref={vendorSelectRef}
                  value={vendorId}
                  disabled={!!billId}
                  onKeyDown={noteVendorStep}
                  onChange={(event) => chooseVendor(event.target.value)}
                  className="h-9 px-2 rounded-md bg-secondary text-sm w-full disabled:opacity-60"
                >
                  {/* Shown in the closed field until a vendor is chosen. Hidden
                      from the open list so Add New is its first row. */}
                  <option value="" hidden>
                    Select…
                  </option>
                  {!billId && <option value={ADD_NEW_VENDOR}>+ Add new vendor…</option>}
                  {vendorOptions.map((vendor) => (
                    <option key={vendor.id} value={vendor.id}>
                      {vendor.name}
                      {vendor.isActive ? "" : " (inactive)"}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Bill number">
                <input
                  value={billNumber}
                  onChange={(event) => setBillNumber(event.target.value)}
                  placeholder="Vendor's reference"
                  className="h-9 px-2 rounded-md bg-secondary text-sm w-full"
                />
              </Field>
              <Field label="Bill date">
                <input
                  type="date"
                  value={billDate}
                  onChange={(event) => setBillDate(event.target.value)}
                  className="h-9 px-2 rounded-md bg-secondary text-sm w-full"
                />
              </Field>
              <Field label="Terms (days)">
                <input
                  type="number"
                  min={0}
                  value={termsDays}
                  onChange={(event) => setTermsDays(event.target.value)}
                  placeholder="Net 30"
                  className="h-9 px-2 rounded-md bg-secondary text-sm w-full"
                />
              </Field>
              <Field label="Due date">
                <input
                  type="date"
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                  className="h-9 px-2 rounded-md bg-secondary text-sm w-full"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Leave blank to use the terms above.
                </p>
              </Field>
              <div className="col-span-2 md:col-span-3">
                <Field label="Memo">
                  <input
                    value={memo}
                    onChange={(event) => setMemo(event.target.value)}
                    className="h-9 px-2 rounded-md bg-secondary text-sm w-full"
                  />
                </Field>
              </div>
            </div>

            <div className="border border-border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="text-left font-medium px-3 py-2">Category</th>
                    <th className="text-left font-medium py-2">Description</th>
                    <th className="text-right font-medium py-2 w-32">Amount</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => (
                    <tr key={line.key} className="border-t border-border">
                      <td className="px-3 py-2">
                        <select
                          value={line.categoryId}
                          onChange={(event) =>
                            setLines((prev) =>
                              prev.map((l, i) =>
                                i === index ? { ...l, categoryId: event.target.value } : l,
                              ),
                            )
                          }
                          className="h-8 px-2 rounded bg-secondary text-sm w-full"
                        >
                          <option value="">Uncategorized</option>
                          {(categories.data ?? []).map((category) => (
                            <option key={category.id} value={category.id}>
                              {category.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2">
                        <input
                          value={line.description}
                          onChange={(event) =>
                            setLines((prev) =>
                              prev.map((l, i) =>
                                i === index ? { ...l, description: event.target.value } : l,
                              ),
                            )
                          }
                          className="h-8 px-2 rounded bg-secondary text-sm w-full"
                        />
                      </td>
                      <td className="py-2">
                        <input
                          type="number"
                          step="0.01"
                          value={line.amount}
                          onChange={(event) =>
                            setLines((prev) =>
                              prev.map((l, i) =>
                                i === index ? { ...l, amount: event.target.value } : l,
                              ),
                            )
                          }
                          className="h-8 px-2 rounded bg-secondary text-sm w-full text-right tabular-nums"
                        />
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {lines.length > 1 && (
                          <button
                            type="button"
                            aria-label="Remove line"
                            onClick={() =>
                              setLines((prev) => prev.filter((_, i) => i !== index))
                            }
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border bg-secondary/20">
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => setLines((prev) => [...prev, newLine()])}
                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                      >
                        <Plus size={13} /> Add line
                      </button>
                    </td>
                    <td className="py-2 text-right text-muted-foreground">Total</td>
                    <td className="py-2 text-right tabular-nums font-semibold">
                      {formatMoney(total)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>

            <p className="text-xs text-muted-foreground">
              Saving a bill raises what this vendor is owed. No money leaves a bank
              account until you pay it in Pay Bills.
            </p>

            {duplicateWarning && (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-sm">
                <AlertTriangle size={15} className="mt-0.5 text-amber-600 shrink-0" />
                <div className="flex-1">
                  <p>{duplicateWarning}</p>
                  <button
                    type="button"
                    onClick={() => submit(true)}
                    disabled={save.isPending}
                    className="mt-2 h-8 px-3 rounded-md bg-amber-600 text-white text-sm font-medium disabled:opacity-60"
                  >
                    Save it anyway
                  </button>
                </div>
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="h-9 px-3 rounded-md bg-secondary text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => submit(false)}
                disabled={busy}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-60"
              >
                {save.isPending && <Loader2 size={14} className="animate-spin" />}
                {billId ? "Save changes" : "Save bill"}
              </button>
            </div>
          </div>
        )}
      </Modal>
      {showNewVendor && (
        <NewVendorDialog
          organizationId={organizationId}
          onClose={closeNewVendor}
          onSaved={selectCreatedVendor}
        />
      )}
    </>
  );
}

// ─────────────────────────── Bill detail ───────────────────────────

function BillDetailDrawer({
  organizationId,
  billId,
  onClose,
  onEdit,
}: {
  organizationId: string;
  billId: string;
  onClose: () => void;
  onEdit: (billId: string) => void;
}) {
  const qc = useQueryClient();
  const [voidReason, setVoidReason] = useState("");
  const [confirmingVoid, setConfirmingVoid] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ["finance", "bill", billId],
    queryFn: () => apiFetch<BillDetail>(`/finance/bills/${billId}`),
  });

  const voidBill = useMutation({
    mutationFn: () =>
      apiFetch(`/finance/bills/${billId}/void`, {
        method: "POST",
        body: JSON.stringify({ reason: voidReason.trim() || null }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["finance", "bills"] });
      qc.invalidateQueries({ queryKey: ["finance", "bill", billId] });
      qc.invalidateQueries({ queryKey: ["finance", "pay-bills"] });
      qc.invalidateQueries({ queryKey: ["finance", "ap-summary"] });
      onClose();
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : "Could not void this bill."),
  });

  const bill = detail.data;

  return (
    <Modal title="Bill" onClose={onClose} wide>
      {detail.isLoading && (
        <div className="py-12 text-center text-muted-foreground">
          <Loader2 size={16} className="inline animate-spin mr-2" />
          Loading…
        </div>
      )}
      {detail.isError && (
        <p className="py-12 text-center text-destructive">Could not load this bill.</p>
      )}
      {bill && (
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-lg font-semibold">{bill.vendorName}</div>
              <div className="text-sm text-muted-foreground">
                {bill.billNumber ? `Bill ${bill.billNumber} · ` : ""}
                {formatDate(bill.billDate)} · due {formatDate(bill.dueDate)}
              </div>
            </div>
            <div className="text-right">
              <StatusBadge status={bill.status} />
              <div className="mt-1 text-xl font-semibold tabular-nums">
                {formatMoney(bill.balanceDue)}
              </div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                balance of {formatMoney(bill.total)}
              </div>
            </div>
          </div>

          <Section title="Lines">
            <table className="w-full text-sm">
              <tbody>
                {bill.lines.map((line) => (
                  <tr key={line.id} className="border-t border-border first:border-0">
                    <td className="py-2">{line.description}</td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(line.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title="Payments and credits">
            {bill.payments.length ? (
              <table className="w-full text-sm">
                <tbody>
                  {bill.payments.map((payment) => (
                    <tr
                      key={payment.allocationId}
                      className="border-t border-border first:border-0"
                    >
                      <td className="py-2">
                        {formatDate(payment.paymentDate)}
                        <span className="ml-2 text-muted-foreground">
                          {payment.fundedByCredit
                            ? "vendor credit"
                            : payment.paymentMethod}
                        </span>
                        {payment.referenceNumber && (
                          <span className="ml-2 text-muted-foreground">
                            #{payment.referenceNumber}
                          </span>
                        )}
                        {payment.reversedAt && (
                          <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                            reversed
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(payment.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing applied yet.</p>
            )}
          </Section>

          <Section title="History">
            <ul className="text-sm space-y-1">
              {bill.events.map((event) => (
                <li key={event.id} className="flex justify-between gap-4">
                  <span>{event.eventType.replace(/_/g, " ")}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatDate(event.occurredAt)}
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {!bill.voidedAt && (
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => onEdit(bill.id)}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-secondary text-sm"
              >
                <Pencil size={14} /> Edit
              </button>
              {confirmingVoid ? (
                <div className="flex items-center gap-2">
                  <input
                    value={voidReason}
                    onChange={(event) => setVoidReason(event.target.value)}
                    placeholder="Reason (optional)"
                    className="h-9 px-2 rounded-md bg-secondary text-sm w-56"
                  />
                  <button
                    type="button"
                    onClick={() => voidBill.mutate()}
                    disabled={voidBill.isPending}
                    className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-destructive text-destructive-foreground text-sm font-medium disabled:opacity-60"
                  >
                    {voidBill.isPending && <Loader2 size={14} className="animate-spin" />}
                    Confirm void
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingVoid(true)}
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-secondary text-sm text-destructive"
                >
                  <Ban size={14} /> Void
                </button>
              )}
            </div>
          )}
          {bill.voidedAt && (
            <p className="text-sm text-muted-foreground">
              Voided {formatDate(bill.voidedAt)}
              {bill.voidReason ? ` — ${bill.voidReason}` : ""}. Void bills keep a zero
              balance and stay in the history.
            </p>
          )}
        </div>
      )}
      <input type="hidden" value={organizationId} readOnly />
    </Modal>
  );
}

// ─────────────────────────── Vendor AP detail ───────────────────────────

function VendorApDetail({
  organizationId,
  vendorId,
  onBack,
  onOpenBill,
}: {
  organizationId: string;
  vendorId: string;
  onBack: () => void;
  onOpenBill: (billId: string) => void;
}) {
  const summary = useQuery({
    queryKey: ["finance", "ap-summary", organizationId, vendorId],
    queryFn: () =>
      apiFetch<VendorApSummary>(
        `/finance/vendors/${vendorId}/ap-summary?organizationId=${organizationId}`,
      ),
  });
  const [showCredit, setShowCredit] = useState(false);

  const data = summary.data;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-secondary text-sm"
        >
          <ArrowLeft size={14} /> Bills
        </button>
        <div className="text-lg font-semibold">{data?.vendor.name ?? "Vendor"}</div>
        {data?.vendor.isActive === false && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
            inactive — history stays available
          </span>
        )}
        <button
          type="button"
          onClick={() => setShowCredit(true)}
          className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-secondary text-sm"
        >
          <Plus size={14} /> Vendor credit
        </button>
      </div>

      {summary.isLoading && (
        <p className="text-muted-foreground">
          <Loader2 size={16} className="inline animate-spin mr-2" />
          Loading vendor activity…
        </p>
      )}
      {summary.isError && (
        <p className="text-destructive">Could not load this vendor&apos;s activity.</p>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat label="Amount due" value={data.amountDue} />
            <Stat label="Overdue" value={data.overdueAmount} alert />
            <Stat label="Unapplied credit" value={data.unappliedCreditAmount} />
            <Stat label="Open bills" raw={String(data.openBillCount)} />
          </div>

          <Panel title="Bills">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="text-left font-medium px-4 py-2">Bill #</th>
                  <th className="text-left font-medium py-2">Date</th>
                  <th className="text-left font-medium py-2">Due</th>
                  <th className="text-left font-medium py-2">Status</th>
                  <th className="text-right font-medium py-2">Amount</th>
                  <th className="text-right font-medium px-4 py-2">Balance</th>
                </tr>
              </thead>
              <tbody>
                {data.bills.map((bill) => (
                  <tr
                    key={bill.id}
                    className="border-t border-border hover:bg-secondary/30 cursor-pointer"
                    onClick={() => onOpenBill(bill.id)}
                  >
                    <td className="px-4 py-2.5">{bill.billNumber ?? "—"}</td>
                    <td className="py-2.5">{formatDate(bill.billDate)}</td>
                    <td className="py-2.5">{formatDate(bill.dueDate)}</td>
                    <td className="py-2.5">
                      <StatusBadge status={bill.status} />
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      {formatMoney(bill.total)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                      {formatMoney(bill.balanceDue)}
                    </td>
                  </tr>
                ))}
                {!data.bills.length && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      No bills recorded for this vendor.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Panel>

          <Panel title="Credits">
            <table className="w-full text-sm">
              <tbody>
                {data.credits.map((credit) => (
                  <tr key={credit.id} className="border-t border-border first:border-0">
                    <td className="px-4 py-2.5">
                      {credit.creditNumber ?? "Credit"} · {formatDate(credit.creditDate)}
                      {credit.voidedAt && (
                        <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                          void
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                      {formatMoney(credit.amount)} issued
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                      {formatMoney(credit.remainingAmount)} left
                    </td>
                  </tr>
                ))}
                {!data.credits.length && (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground">
                      No vendor credits.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Panel>

          <Panel title="Payments">
            <table className="w-full text-sm">
              <tbody>
                {data.payments.map((payment) => (
                  <tr key={payment.id} className="border-t border-border first:border-0">
                    <td className="px-4 py-2.5">
                      {formatDate(payment.paymentDate)} · {payment.paymentMethod}
                      {payment.referenceNumber ? ` #${payment.referenceNumber}` : ""}
                      {payment.status === "void" && (
                        <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                          void
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                      {formatMoney(payment.totalAmount)}
                    </td>
                  </tr>
                ))}
                {!data.payments.length && (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground">
                      No payments recorded.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Panel>
        </>
      )}

      {showCredit && (
        <VendorCreditEditor
          organizationId={organizationId}
          vendorId={vendorId}
          onClose={() => setShowCredit(false)}
        />
      )}
    </div>
  );
}

function VendorCreditEditor({
  organizationId,
  vendorId,
  onClose,
}: {
  organizationId: string;
  vendorId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const categories = useApCategories(organizationId);
  const [creditNumber, setCreditNumber] = useState("");
  const [creditDate, setCreditDate] = useState(todayIsoDate());
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      apiFetch<VendorCredit>("/finance/vendor-credits", {
        method: "POST",
        body: JSON.stringify({
          organizationId,
          vendorId,
          creditNumber: creditNumber.trim() || null,
          creditDate,
          amount: Number(amount),
          categoryId: categoryId || null,
          memo: memo.trim() || null,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["finance", "ap-summary"] });
      qc.invalidateQueries({ queryKey: ["finance", "pay-bills"] });
      onClose();
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : "Could not save this credit."),
  });

  return (
    <Modal title="Vendor credit" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Credit number">
            <input
              value={creditNumber}
              onChange={(event) => setCreditNumber(event.target.value)}
              className="h-9 px-2 rounded-md bg-secondary text-sm w-full"
            />
          </Field>
          <Field label="Credit date">
            <input
              type="date"
              value={creditDate}
              onChange={(event) => setCreditDate(event.target.value)}
              className="h-9 px-2 rounded-md bg-secondary text-sm w-full"
            />
          </Field>
          <Field label="Amount">
            <input
              type="number"
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="h-9 px-2 rounded-md bg-secondary text-sm w-full text-right tabular-nums"
            />
          </Field>
          <Field label="Category">
            <select
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              className="h-9 px-2 rounded-md bg-secondary text-sm w-full"
            >
              <option value="">Uncategorized</option>
              {(categories.data ?? []).map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Memo">
          <input
            value={memo}
            onChange={(event) => setMemo(event.target.value)}
            className="h-9 px-2 rounded-md bg-secondary text-sm w-full"
          />
        </Field>
        <p className="text-xs text-muted-foreground">
          Applying a credit in Pay Bills reduces what you owe without withdrawing any
          cash.
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-3 rounded-md bg-secondary text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={create.isPending || !(Number(amount) > 0)}
            onClick={() => {
              setError(null);
              create.mutate();
            }}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-60"
          >
            {create.isPending && <Loader2 size={14} className="animate-spin" />}
            Save credit
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────────────────── Small shared pieces ───────────────────────────

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto py-10 px-4">
      <div
        className={`bg-card border border-border rounded-xl shadow-lg w-full ${
          wide ? "max-w-3xl" : "max-w-lg"
        }`}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-border rounded-lg px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-2">
        {title}
      </div>
      {children}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border text-sm font-semibold">
        {title}
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

export function Stat({
  label,
  value,
  raw,
  alert,
}: {
  label: string;
  value?: string;
  raw?: string;
  alert?: boolean;
}) {
  return (
    <div className="border border-border rounded-xl bg-card px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
        {label}
      </div>
      <div
        className={`mt-1 text-xl font-semibold tabular-nums ${
          alert && Number(value ?? 0) > 0 ? "text-destructive" : ""
        }`}
      >
        {raw ?? formatMoney(value ?? 0)}
      </div>
    </div>
  );
}

export type { VendorLite };
