import type React from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  computeShiftClickRange,
  shiftKeyFromChangeEvent,
  suppressShiftClickTextSelection,
} from "@/lib/shift-click-range";
import { useColumnWidths } from "@/hooks/useColumnWidths";
import { useInvoicePanelSize } from "@/hooks/useInvoicePanelSize";
import { useBatchedListReset } from "@/hooks/useBatchedListReset";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  filterAndSortInvoices,
  FINANCE_INVOICES_QUERY_KEY,
  invoiceStatusSelectionFromLegacy,
  invoiceStatusSelectionToLegacy,
  invoiceStatusSelectionValues,
  transitionInvoiceStatusSelectionValues,
  type InvoiceStatusFilter,
} from "@workspace/api-client-react";
import { useLocation, useSearch } from "wouter";
import { useAuth } from "@/lib/auth-context";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  CreditCard,
  Download,
  ExternalLink,
  Eye,
  FileText,
  GitBranch,
  GripVertical,
  Layers,
  Loader2,
  Lock,
  Mail,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Plus,
  Printer,
  RotateCcw,
  ScrollText,
  Search,
  Send,
  Sparkles,
  Stethoscope,
  Trash2,
  TrendingUp,
  TriangleAlert,
  X,
} from "lucide-react";
import QRCodeLib from "qrcode";
import { apiFetch, ApiError, getApiOrigin, getAccessToken } from "@/lib/api";
import { useBankAccounts } from "@/lib/finance";
import { registerNavBlocker } from "@/lib/nav-guard";
import { InvoiceEditorPresentation } from "@/components/invoice-editor-presentation";
import { DoctorNamePicker } from "@/components/DoctorNamePicker";
import {
  ItemCombobox,
  type ItemComboboxOption,
} from "@/components/ItemCombobox";
import {
  RemakeOriginalPicker,
  blankQuestionnaire,
  buildRemakeLinkPayload,
  isRemakeQuestionnaireComplete,
  remakeQuestionnaireError,
  type RemakeQuestionnaireValue,
  type RemakeCaseHit,
} from "@/components/remake-questionnaire";
import type {
  CaseAttachment,
  CaseRestoration,
  Invoice,
  InvoiceDisplayMetadata,
  InvoiceLineItem,
  LabCase,
  Organization,
  PracticeStatement,
} from "@/lib/types";
import {
  formatDate,
  formatDateTime,
  formatInvoiceLineMoney,
  formatMoney,
  statusLabel,
} from "@/lib/format";
import {
  fitInvoiceLineItemColumns,
  INVOICE_LINE_ITEM_ACTION_COLUMN_WIDTH,
  INVOICE_LINE_ITEM_COLUMN_DEFAULTS,
  INVOICE_LINE_ITEM_COLUMN_MINIMUMS,
  resizeInvoiceLineItemColumns,
} from "@/lib/invoice-line-item-layout";
const INVOICE_COLUMN_DEFAULTS = [...INVOICE_LINE_ITEM_COLUMN_DEFAULTS];
import {
  formatInvoiceDate,
  hasInvoiceDateRepairChanges,
  isLikelyLegacyShiftedInvoiceDate,
  invoiceDateInputToTimestamp,
  invoiceTimestampToDateInput,
} from "@/lib/invoice-date";
import {
  computeInvoiceDateRange,
  INVOICE_DATE_PRESET_LABELS,
  type InvoiceDatePreset,
} from "@/lib/invoice-date-filter";
import { getLocalTimeZone, millisecondsUntilNextLocalMidnight } from "@workspace/api-client-react";
import { toast } from "@/hooks/use-toast";
import {
  deriveRxSummary,
  formatRxTeethLabel,
  formatRxTeethWithShades,
} from "@/lib/rx-summary";
import { StatusBadge } from "@/components/StatusBadge";
import { MultiSelectFilter } from "@/components/MultiSelectFilter";
import { ColumnTotal } from "@/components/ColumnTotal";
import { PrescriptionPreview } from "@/components/PrescriptionPreview";
import {
  buildInvoicePdf,
  downloadInvoicePdf,
  previewInvoicePdf,
  printInvoicePdf,
  type InvoicePdfOptions,
} from "@/lib/export";
import { fetchAllPages } from "@/lib/fetch-all-pages";
import { useInvoiceTemplate } from "@/lib/use-invoice-template";
import { refreshInvoiceSalesQueries } from "@/lib/refresh-case-finance";
import { ReceivePaymentModal } from "@/components/receive-payment-modal";
import { InvoicePreviewPanel, INVOICE_PREVIEW_QUERY_KEY } from "@/components/invoice-preview-panel";

const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "outstanding", label: "Outstanding" },
  { value: "paid", label: "Paid" },
  { value: "void", label: "Void" },
  { value: "zero_balance", label: "$0 balance" },
  { value: "frozen", label: "Frozen" },
];

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;
const STATUS_TABS = [
  { key: "all", label: "All Invoices" },
  { key: "open", label: "Open" },
  { key: "overdue", label: "Overdue" },
  { key: "paid", label: "Paid" },
  { key: "draft", label: "Draft" },
  { key: "void", label: "Void" },
] as const;
type InvoiceStatusCounts = Record<(typeof STATUS_TABS)[number]["key"], number>;

/** Condensed numbered pager: 1 ... 4 5 6 ... N */
export function pagerItems(page: number, pageCount: number): (number | "gap")[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const items: (number | "gap")[] = [1];
  const lo = Math.max(2, page - 1);
  const hi = Math.min(pageCount - 1, page + 1);
  if (lo > 2) items.push("gap");
  for (let n = lo; n <= hi; n++) items.push(n);
  if (hi < pageCount - 1) items.push("gap");
  items.push(pageCount);
  return items;
}

/** Spreadsheet-safe CSV cell: quotes, and neutralises formula triggers. */
export function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Stable identity so an unloaded batch never re-triggers downstream memos. */
const EMPTY_INVOICES: Invoice[] = [];

type InvoiceListSummary = {
  openBalance: number;
  openCount: number;
  overdueBalance: number;
  overdueCount: number;
  sumTotal: number;
  sumBalance: number;
  paidThisMonth: number;
  paidCount: number;
  totalInvoices?: number;
  statusCounts?: InvoiceStatusCounts;
};

type InvoiceListPage = {
  rows: Invoice[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextCursor?: string | null;
  summary?: InvoiceListSummary;
};

const EDITABLE_STATUSES = [
  "open",
  "partially_paid",
  "paid",
  "void",
] as const;

const BULK_EDITABLE_STATUSES = [
  "open",
  "paid",
  "void",
] as const;

type DraftLine = {
  id?: string;
  item: string;
  description: string;
  quantity: number;
  unitPrice: string;
  isDiscount?: boolean;
  toothNumber?: number | null;
  toothLabel?: string | null;
  subItems?: DraftLine[];
  catalogItemKey?: string | null;
  missingCatalogItem?: boolean;
  /** true = price was explicitly set; false = alloy sub-item waiting for lab to price it */
  priced?: boolean;
  displayMetadata?: Record<string, unknown>;
};

function readDisplayMetadata(inv: Invoice | undefined | null): InvoiceDisplayMetadata {
  if (!inv) return {};
  return (inv.displayMetadata ?? inv.displayMetadataJson ?? {}) as InvoiceDisplayMetadata;
}

function getUrlParam(name: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

/**
 * Read the persisted/deep-linked status filter into the multi-select's array
 * shape. The Status filter used to be a single-value dropdown, so an existing
 * bookmark or saved link can still carry `?status=paid` (or the old "all"
 * sentinel) — those rehydrate as a one-item selection / empty selection
 * respectively, and the new form is a comma-separated list.
 */
function readStatusFilters(raw: string): string[] {
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "" && v !== "all");
}

function setUrlParams(updates: Record<string, string | null>) {
  if (typeof window === "undefined") return;
  const sp = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(updates)) {
    if (v === null || v === "") sp.delete(k);
    else sp.set(k, v);
  }
  const qs = sp.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState({}, "", url);
}

type SortKey = "practice" | "issued" | "due";
type SortDir = "asc" | "desc";

const KPI_TONES = {
  blue: { card: "bg-blue-50 border-blue-100 dark:bg-blue-950/30 dark:border-blue-900", block: "bg-blue-600", label: "text-blue-700 dark:text-blue-300", bar: "bg-blue-300/70" },
  red: { card: "bg-red-50 border-red-100 dark:bg-red-950/30 dark:border-red-900", block: "bg-red-600", label: "text-red-600 dark:text-red-300", bar: "bg-red-300/70" },
  green: { card: "bg-green-50 border-green-100 dark:bg-green-950/30 dark:border-green-900", block: "bg-green-600", label: "text-green-700 dark:text-green-300", bar: "bg-green-300/70" },
  violet: { card: "bg-violet-50 border-violet-100 dark:bg-violet-950/30 dark:border-violet-900", block: "bg-violet-600", label: "text-violet-700 dark:text-violet-300", bar: "bg-violet-300/70" },
} as const;

function InvoiceKpiCard({ testId, tone, icon, label, value, sub, onClick }: {
  testId: string;
  tone: keyof typeof KPI_TONES;
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  onClick?: () => void;
}) {
  const t = KPI_TONES[tone];
  const body = (
    <>
      <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white max-sm:absolute max-sm:top-3 max-sm:right-3 max-sm:h-6 max-sm:w-6 max-sm:rounded-lg max-sm:[&>svg]:h-3 max-sm:[&>svg]:w-3 ${t.block}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={`block text-[11px] uppercase tracking-wide font-semibold max-sm:pr-7 max-sm:min-h-7 ${t.label}`}>{label}</span>
        <span className="block text-xl sm:text-2xl font-bold tabular-nums [overflow-wrap:anywhere]">{value}</span>
        <span className="block text-xs text-muted-foreground">{sub}</span>
      </span>
      <span aria-hidden="true" className="hidden sm:flex items-end gap-0.5 h-10 self-end">
        {[4, 6, 5, 8, 10].map((h, n) => (
          <span key={n} className={`w-1.5 rounded-sm ${t.bar}`} style={{ height: `${h * 4}px` }} />
        ))}
      </span>
    </>
  );
  const cls = `relative min-w-0 flex max-sm:block items-center gap-3 rounded-xl border px-3 py-3 text-left ${t.card}`;
  return onClick ? (
    <button type="button" data-testid={testId} onClick={onClick} className={`${cls} cursor-pointer hover:brightness-95`}>{body}</button>
  ) : (
    <div data-testid={testId} className={cls}>{body}</div>
  );
}

function isInvoiceOverdue(i: Invoice): boolean {
  const due = i.dueAt ?? i.dueDate;
  if (!due || i.frozen) return false;
  if (i.status === "paid" || i.status === "void") return false;
  if (Number(i.balanceDue ?? i.total ?? 0) <= 0) return false;
  return new Date(due).getTime() < Date.now();
}

function restorationText(meta: InvoiceDisplayMetadata): string {
  return [meta.caseType || meta.caseSubtype, meta.teeth ? `Tooth ${meta.teeth}` : ""].filter(Boolean).join(" - ");
}

function isReadonlyDraft(i: { status?: unknown }): boolean {
  const st = String(i.status);
  return st === "draft" || st === "recovery_draft";
}

export default function InvoicesPage() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const urlSearch = useSearch();

  const [search, setSearch] = useState(() => getUrlParam("q"));
  const [statusSelection, setStatusSelection] = useState(() => {
    const v = getUrlParam("view");
    const view = v === "outstanding" || v === "open" ? v : "all";
    return invoiceStatusSelectionFromLegacy(view, readStatusFilters(getUrlParam("status")));
  });
  const { view: viewMode, statuses: statusFilters } = useMemo(
    () => invoiceStatusSelectionToLegacy(statusSelection),
    [statusSelection],
  );
  const unifiedStatusSelection = invoiceStatusSelectionValues(statusSelection);
  const setUnifiedStatusSelection = (next: string[]) => {
    setStatusSelection((current) => transitionInvoiceStatusSelectionValues(current, next));
    const added = next.find((value) => !unifiedStatusSelection.includes(
      value as (typeof unifiedStatusSelection)[number],
    ));
    if (added === "outstanding") {
      setOverdueBucket("");
      setCustomDueDateFrom("");
      setCustomDueDateTo("");
    }
  };
  const [aiOnly, setAiOnly] = useState(() => getUrlParam("ai") === "1");
  const [doctorName, setDoctorName] = useState(() => getUrlParam("doctor"));
  const [overdueBucket, setOverdueBucket] = useState(
    () => getUrlParam("overdue"),
  );
  const [customDueDateFrom, setCustomDueDateFrom] = useState(
    () => getUrlParam("date_from"),
  );
  const [customDueDateTo, setCustomDueDateTo] = useState(
    () => getUrlParam("date_to"),
  );
  const [invoiceDatePreset, setInvoiceDatePreset] = useState<InvoiceDatePreset>(
    () => (getUrlParam("issued_preset") as InvoiceDatePreset) || "all",
  );
  const [customIssuedFrom, setCustomIssuedFrom] = useState(
    () => getUrlParam("issued_from"),
  );
  const [customIssuedTo, setCustomIssuedTo] = useState(
    () => getUrlParam("issued_to"),
  );
  const [dateRefreshTick, setDateRefreshTick] = useState(0);
  const localTimeZoneRef = useRef(getLocalTimeZone());
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const nextTimeZone = getLocalTimeZone();
      if (nextTimeZone === localTimeZoneRef.current) return;
      localTimeZoneRef.current = nextTimeZone;
      if (invoiceDatePreset === "today" || invoiceDatePreset === "yesterday") {
        setPage(1);
        setDateRefreshTick((tick) => tick + 1);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [invoiceDatePreset]);
  useEffect(() => {
    if (invoiceDatePreset !== "today" && invoiceDatePreset !== "yesterday") return;
    const timeout = window.setTimeout(
      () => setDateRefreshTick((tick) => tick + 1),
      millisecondsUntilNextLocalMidnight(new Date()),
    );
    return () => window.clearTimeout(timeout);
  }, [invoiceDatePreset, dateRefreshTick]);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [editing, setEditing] = useState<Invoice | null>(null);
  // Guards the invoiceId deep-link effect below against re-opening the same
  // invoice on unrelated re-renders (mirrors lastProcessedCaseIdRef in cases.tsx).
  const lastProcessedInvoiceIdRef = useRef<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(
    () => getUrlParam("previewId") || null,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [statementBuilderOpen, setStatementBuilderOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Row snapshots by id so bulk operations act on the WHOLE selection, not
  // just the rows on the page currently rendered.
  const selectedSnapshotsRef = useRef<Map<string, Invoice>>(new Map());
  const [fullSelected, setFullSelected] = useState(false);
  const [selectExcluded, setSelectExcluded] = useState(0);
  const [selectProgress, setSelectProgress] = useState<{ loaded: number; total: number | null } | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);
  const selectAbortRef = useRef<AbortController | null>(null);
  function clearSelection() {
    selectAbortRef.current?.abort();
    selectAbortRef.current = null;
    selectedSnapshotsRef.current = new Map();
    setSelected(new Set());
    setFullSelected(false);
    setSelectExcluded(0);
    setSelectProgress(null);
    setSelectError(null);
  }
  function getSelectedInvoices(): Invoice[] {
    const live = new Map(data.map((i) => [i.id, i] as const));
    return Array.from(selected)
      .map((id) => live.get(id) ?? selectedSnapshotsRef.current.get(id))
      .filter((i): i is Invoice => !!i && !isReadonlyDraft(i));
  }
  const [paymentChoice, setPaymentChoice] = useState<{
    groups: { providerOrganizationId: string; name: string; invoices: Invoice[] }[];
  } | null>(null);
  function openReceivePaymentFor(invs: Invoice[], excluded: Invoice[]) {
    const first = invs[0];
    if (!first) return;
    const meta = readDisplayMetadata(first);
    const doctorValues = [...new Set(
      invs.map((i) => i.doctorIdentity || i.doctorDisplayName || i.doctorName || "").filter(Boolean),
    )];
    if (excluded.length > 0) {
      toast({
        title: `${excluded.length} selected invoice${excluded.length === 1 ? "" : "s"} excluded`,
        description: `Not included in this payment: ${excluded.map((i) => i.invoiceNumber).join(", ")}`,
      });
    }
    setReceivePaymentModal({
      practiceOrDoctorName: first.providerOrganization?.name || meta.billTo || "Unknown",
      defaultAmount: invs.reduce((t, i) => t + Math.max(0, Number(i.balanceDue ?? 0)), 0),
      invoiceIds: invs.map((i) => i.id),
      providerOrganizationId: first.providerOrganizationId,
      doctorName: doctorValues.length === 1 ? doctorValues[0] : null,
    });
  }
  // Receive Payment acts on the WHOLE selection (all pages), one practice at a time.
  function startBulkReceivePayment() {
    const all = getSelectedInvoices();
    if (all.length === 0) return;
    const map = new Map<string, Invoice[]>();
    for (const i of all) {
      const list = map.get(i.providerOrganizationId) ?? [];
      list.push(i);
      map.set(i.providerOrganizationId, list);
    }
    if (map.size === 1) { openReceivePaymentFor(all, []); return; }
    setPaymentChoice({
      groups: Array.from(map, ([providerOrganizationId, invoices]) => ({
        providerOrganizationId,
        name: invoices[0].providerOrganization?.name || readDisplayMetadata(invoices[0]).billTo || "Unknown practice",
        invoices,
      })),
    });
  }
  // Every editor entry goes through here: drafts are read-only previews.
  function openEditorFor(inv: Invoice) {
    if (isReadonlyDraft(inv)) { setPreviewId(inv.id); return; }
    setEditing(inv);
  }
  // Shift-click range selection for the invoice checkboxes. A normal click
  // toggles the single invoice and moves the anchor; a shift-click with a
  // valid anchor adds every invoice between the anchor and the clicked row
  // (in the current filtered/sorted order) to the selection. Draft invoices
  // are read-only and can never join a selection.
  const selectionAnchorIdRef = useRef<string | null>(null);
  const handleInvoiceRowCheckboxChange = (
    invoiceId: string,
    checked: boolean,
    shiftKey: boolean,
  ) => {
    const eligibleRows = filtered.filter((i) => !isReadonlyDraft(i));
    if (!eligibleRows.some((i) => i.id === invoiceId)) return;
    setFullSelected(false);
    setSelectExcluded(0);
    if (shiftKey) {
      const rangeIds = computeShiftClickRange(
        eligibleRows.map((i) => i.id),
        selectionAnchorIdRef.current,
        invoiceId,
      );
      if (rangeIds) {
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of rangeIds) next.add(id);
          return next;
        });
        return;
      }
      selectionAnchorIdRef.current = null;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(invoiceId);
      else next.delete(invoiceId);
      return next;
    });
    selectionAnchorIdRef.current = invoiceId;
  };
  const [bulkSendOpen, setBulkSendOpen] = useState(false);
  const [bulkRemakeOpen, setBulkRemakeOpen] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState<{
    kind: "delete_selected" | "reset_selected" | "reset_all" | "status_change";
    count: number;
    labOrganizationId: string;
    targetStatus?: (typeof BULK_EDITABLE_STATUSES)[number];
  } | null>(null);
  const [bulkFeedback, setBulkFeedback] = useState<string | null>(null);
  // Bulk Paid→Open guard: shown when selected invoices have recorded payments.
  const [bulkPaymentDeleteConfirm, setBulkPaymentDeleteConfirm] = useState<{
    paidCount: number;
    paidInvoiceIds: string[];
    allInvoiceIds: string[];
  } | null>(null);
  // Bulk Open→Paid prompt: shown after the confirm dialog for "paid" status so
  // admins can choose to record payments or just flip the status.
  const [bulkRecordPaymentPrompt, setBulkRecordPaymentPrompt] = useState<{
    count: number;
    invoiceIds: string[];
  } | null>(null);
  const [receivePaymentModal, setReceivePaymentModal] = useState<{
    practiceOrDoctorName: string;
    defaultAmount: number;
    invoiceIds: string[];
    providerOrganizationId: string;
    doctorName?: string | null;
  } | null>(null);

  const { user } = useAuth();
  const isBillingUser =
    user?.role === "owner" ||
    user?.role === "admin" ||
    user?.role === "billing";
  const isAdminOrOwner = user?.role === "owner" || user?.role === "admin";

  // Numbered server offset paging. The page is part of the request; any
  // change to the rest of the query identity (filters, sort, page size)
  // resets to page 1 during render so no stale offset is ever requested.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [loaded, setLoaded] = useState<{
    key: string;
    rows: Invoice[];
    total: number;
    summary?: InvoiceListSummary;
    legacy?: boolean;
  }>({ key: "", rows: [], total: 0 });
  const queryBase = useMemo(() => {
    const sp = new URLSearchParams();
    if (viewMode === "outstanding") {
      sp.set("view", "outstanding");
    } else if (viewMode === "open" && !statusFilters.includes("zero_balance")) {
      sp.set("status", "open");
    } else if (statusFilters.length > 0) {
      sp.set("statuses", statusFilters.join(","));
    }
    if (doctorName) sp.set("doctorName", doctorName);
    if (aiOnly) sp.set("aiOnly", "true");
    if (viewMode !== "outstanding") {
      if (overdueBucket) sp.set("overdueBucket", overdueBucket);
      if (overdueBucket === "custom" && customDueDateFrom) sp.set("dueDateFrom", customDueDateFrom);
      if (overdueBucket === "custom" && customDueDateTo) sp.set("dueDateTo", customDueDateTo);
    }
    const issuedRange = computeInvoiceDateRange(
      invoiceDatePreset,
      customIssuedFrom,
      customIssuedTo,
    );
    if (issuedRange.startDate) sp.set("issuedFrom", issuedRange.startDate.toISOString());
    if (issuedRange.endDate) sp.set("issuedTo", issuedRange.endDate.toISOString());
    if (search.trim()) sp.set("search", search.trim());
    if (sortKey) sp.set("sort", sortKey);
    sp.set("sortDir", sortDir);
    return sp.toString();
  }, [viewMode, statusFilters, doctorName, aiOnly, overdueBucket, customDueDateFrom, customDueDateTo, invoiceDatePreset, customIssuedFrom, customIssuedTo, search, sortKey, sortDir, dateRefreshTick]);
  const queryBaseRef = useRef(queryBase);
  queryBaseRef.current = queryBase;
  const queryString = useMemo(() => {
    const sp = new URLSearchParams(queryBase);
    sp.set("limit", String(pageSize));
    sp.set("offset", String((page - 1) * pageSize));
    return sp.toString();
  }, [queryBase, page, pageSize]);
  const [pagedQueryBase, setPagedQueryBase] = useState(`${queryBase}|${pageSize}`);
  if (pagedQueryBase !== `${queryBase}|${pageSize}`) {
    setPagedQueryBase(`${queryBase}|${pageSize}`);
    setPage(1);
  }
  // Confirmed invoice mutations invalidate ["invoices"]; the active page
  // refetches itself and is clamped below if the set shrank.
  const restartBatches = useCallback(() => { setPage(1); selectAbortRef.current?.abort(); }, []);
  useBatchedListReset("invoices", restartBatches);

  const listQuery = useQuery({
    queryKey: [
      ...FINANCE_INVOICES_QUERY_KEY,
      queryString,
      invoiceDatePreset === "today" || invoiceDatePreset === "yesterday"
        ? dateRefreshTick
        : 0,
    ],
    queryFn: async ({ signal }) => {
      const query = queryString;
      const response = await apiFetch<InvoiceListPage | Invoice[]>(
        `/invoices?${query}`,
        { signal },
      );
      const result: InvoiceListPage = Array.isArray(response)
        ? {
            rows: response,
            total: response.length,
            limit: response.length,
            offset: 0,
            hasMore: false,
            nextCursor: null,
          }
        : response;
      return { ...result, query, legacy: Array.isArray(response) };
    },
  });
  const { isLoading, error, isFetching } = listQuery;
  const currentPageData =
    listQuery.data?.query === queryString ? listQuery.data : undefined;
  useEffect(() => {
    const result = listQuery.data;
    if (!result || result.query !== queryString) return;
    setLoaded({
      key: queryString,
      rows: result.rows,
      total: result.total,
      summary: result.summary,
      legacy: result.legacy,
    });
  }, [queryString, listQuery.data]);
  const loadedRows = loaded.key === queryString ? loaded.rows : EMPTY_INVOICES;
  const loadedTotal = loaded.key === queryString ? loaded.total : 0;
  const loadedSummary = loaded.key === queryString ? loaded.summary : undefined;
  const loadedLegacy = loaded.key === queryString && loaded.legacy === true;
  const hasRegisterAggregates = Boolean(loadedSummary || loadedLegacy);
  const data = loadedRows;
  const pageCount = Math.max(1, Math.ceil(loadedTotal / pageSize));
  // Clamp when a mutation or refresh left the requested page past the end.
  useEffect(() => {
    if (loaded.key === queryString && page > pageCount) setPage(pageCount);
  }, [loaded.key, queryString, loadedTotal, page, pageCount]);
  const rangeStart = loadedTotal === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(loadedTotal, page * pageSize, (page - 1) * pageSize + loadedRows.length);

  const [exportState, setExportState] = useState<{ loaded: number; total: number | null } | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => exportAbortRef.current?.abort(), [queryBase]);
  async function exportCsv() {
    if (exportAbortRef.current) return;
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExportState({ loaded: 0, total: null });
    try {
      const rows = await fetchAllPages<Invoice>({
        fetchPage: async ({ limit, offset }) => {
          if (controller.signal.aborted) throw new DOMException("Export cancelled", "AbortError");
          const sp = new URLSearchParams(queryBase);
          sp.set("limit", String(limit));
          sp.set("offset", String(offset));
          return apiFetch<InvoiceListPage | Invoice[]>(`/invoices?${sp.toString()}`, { signal: controller.signal });
        },
        onProgress: (p) => { if (!controller.signal.aborted) setExportState(p); },
        getId: (i) => i.id,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const header = ["Invoice #", "Practice", "Doctor", "Issued", "Due", "Status", "Total", "Balance"];
      const lines = [header.map(csvCell).join(",")].concat(
        rows.map((i) => {
          const meta = readDisplayMetadata(i) as Record<string, unknown>;
          return [
            i.invoiceNumber,
            i.providerOrganization?.name,
            meta.billTo ?? meta.doctorName,
            i.issuedAt ?? i.createdAt,
            i.dueAt ?? i.dueDate,
            i.status,
            i.total,
            i.balanceDue ?? i.total,
          ].map(csvCell).join(",");
        }),
      );
      const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoices-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: `Exported ${rows.length} invoices` });
    } catch (err) {
      if (!controller.signal.aborted) {
        toast({ title: "Export failed", description: err instanceof Error ? err.message : "No file was written.", variant: "destructive" });
      }
    } finally {
      exportAbortRef.current = null;
      setExportState(null);
    }
  }

  // Deep-link: if the URL contains ?invoiceId=<id>, auto-open that invoice in
  // the editor. Mirrors the ?caseId= deep-link in cases.tsx: useSearch() so
  // the effect re-fires whenever the query string changes even while this
  // component stays mounted, and lastProcessedInvoiceIdRef prevents
  // re-opening the same invoice on unrelated re-renders. The target invoice
  // may not be in the currently-loaded (filtered) list, so fall back to a
  // direct fetch rather than leaving the user on a blank page.
  useEffect(() => {
    const params = new URLSearchParams(urlSearch);
    setPreviewId(params.get("previewId"));
  }, [urlSearch]);

  useEffect(() => {
    const params = new URLSearchParams(urlSearch);
    if (params.get("newInvoice") === "1" && (isBillingUser || isAdminOrOwner)) {
      setCreateOpen(true);
      params.delete("newInvoice");
      const rest = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
    }
  }, [urlSearch, isBillingUser, isAdminOrOwner]);

  useEffect(() => {
    const params = new URLSearchParams(urlSearch);
    const targetId = params.get("invoiceId");
    if (!targetId || isLoading) return;
    if (targetId === lastProcessedInvoiceIdRef.current) return;
    lastProcessedInvoiceIdRef.current = targetId;
    const found = data.find((i) => i.id === targetId);
    if (found) {
      openEditorFor(found);
    } else {
      apiFetch<Invoice>(`/invoices/${targetId}`)
        .then((fresh) => { openEditorFor(fresh); })
        .catch(() => {/* invoice not found or inaccessible */});
    }
  }, [urlSearch, data, isLoading]);

  const doctorNamesQuery = useQuery({
    queryKey: ["case-doctor-names"],
    queryFn: () => apiFetch<string[]>("/cases/doctor-names"),
    staleTime: 60_000,
  });
  const distinctDoctorNames = doctorNamesQuery.data ?? [];

  const practicesQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
    staleTime: 60_000,
  });
  const practiceOptions = useMemo(
    () =>
      (practicesQuery.data ?? []).filter(
        (o) =>
          (o.type === "provider" || o.type === "practice") && !o.deletedAt,
      ).sort((a, b) => a.name.localeCompare(b.name)),
    [practicesQuery.data],
  );

  useEffect(() => {
    setUrlParams({
      q: search || null,
      status: viewMode !== "all" || statusFilters.length === 0 ? null : statusFilters.join(","),
      view: viewMode !== "all" ? viewMode : null,
      ai: aiOnly ? "1" : null,
      doctor: doctorName || null,
      overdue: overdueBucket || null,
      issued_preset: invoiceDatePreset === "all" ? null : invoiceDatePreset,
      issued_from: invoiceDatePreset === "custom" ? customIssuedFrom || null : null,
      issued_to: invoiceDatePreset === "custom" ? customIssuedTo || null : null,
    });
  }, [search, statusFilters, viewMode, aiOnly, doctorName, overdueBucket, invoiceDatePreset, customIssuedFrom, customIssuedTo]);

  useEffect(() => { clearSelection(); }, [search, statusFilters, viewMode, aiOnly, doctorName, overdueBucket, invoiceDatePreset, customIssuedFrom, customIssuedTo, dateRefreshTick]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const matchingRows = useMemo(() => {
    if (!loadedLegacy) return data;
    const { startDate, endDate } = computeInvoiceDateRange(
      invoiceDatePreset,
      customIssuedFrom,
      customIssuedTo,
    );
    const issuedRange = startDate || endDate
      ? { start: startDate, end: endDate }
      : null;
    return filterAndSortInvoices(data, {
      view: viewMode,
      statuses: statusFilters as InvoiceStatusFilter[],
      search,
      date: invoiceDatePreset,
      issuedRange,
      sort: sortKey ?? undefined,
      sortDirection: sortDir,
    });
  }, [data, loadedLegacy, search, statusFilters, viewMode, sortKey, sortDir, invoiceDatePreset, customIssuedFrom, customIssuedTo, dateRefreshTick]);
  const filtered = useMemo(
    () => loadedLegacy ? matchingRows.slice((page - 1) * pageSize, page * pageSize) : matchingRows,
    [loadedLegacy, matchingRows, page, pageSize],
  );

  useEffect(() => {
    for (const i of data) if (selected.has(i.id)) selectedSnapshotsRef.current.set(i.id, i);
  }, [data, selected]);
  const eligibleVisible = filtered.filter((i) => !isReadonlyDraft(i));
  const headerChecked = selected.size > 0 && (
    loadedLegacy
      ? matchingRows.filter((i) => !isReadonlyDraft(i)).every((i) => selected.has(i.id))
      : fullSelected || (loadedTotal <= filtered.length && eligibleVisible.length > 0 && eligibleVisible.every((i) => selected.has(i.id)))
  );
  async function selectAllMatching() {
    selectAbortRef.current?.abort();
    setSelectError(null);
    if (loadedLegacy) {
      // Whole set is already in memory: synchronous.
      const eligible = matchingRows.filter((i) => !isReadonlyDraft(i));
      selectedSnapshotsRef.current = new Map(eligible.map((i) => [i.id, i] as const));
      setSelected(new Set(eligible.map((i) => i.id)));
      setSelectExcluded(matchingRows.length - eligible.length);
      setFullSelected(true);
      return;
    }
    const controller = new AbortController();
    selectAbortRef.current = controller;
    const base = queryBase;
    setSelectProgress({ loaded: 0, total: null });
    try {
      const rows = await fetchAllPages<Invoice>({
        fetchPage: async ({ limit, offset }) => {
          if (controller.signal.aborted) throw new DOMException("Selection cancelled", "AbortError");
          const sp = new URLSearchParams(base);
          sp.set("limit", String(limit));
          sp.set("offset", String(offset));
          return apiFetch<InvoiceListPage | Invoice[]>(`/invoices?${sp.toString()}`, { signal: controller.signal });
        },
        onProgress: (p) => { if (!controller.signal.aborted) setSelectProgress(p); },
        getId: (i) => i.id,
        signal: controller.signal,
      });
      if (controller.signal.aborted || selectAbortRef.current !== controller || queryBaseRef.current !== base) return;
      const eligible = rows.filter((i) => !isReadonlyDraft(i));
      selectedSnapshotsRef.current = new Map(eligible.map((i) => [i.id, i] as const));
      setSelected(new Set(eligible.map((i) => i.id)));
      setSelectExcluded(rows.length - eligible.length);
      setFullSelected(true);
    } catch (err) {
      if (!controller.signal.aborted) {
        setSelectError(err instanceof Error ? err.message : "Could not select all matching invoices.");
      }
    } finally {
      if (selectAbortRef.current === controller) {
        selectAbortRef.current = null;
        setSelectProgress(null);
      }
    }
  }

  const stats = useMemo(() => {
    if (loadedSummary) return loadedSummary;
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    // Mirror the exact same rows + per-row value as the Balance column total
    // below (`filtered`, `i.balanceDue ?? i.total`) so this card and the
    // column total can never disagree for the current view (status, doctor,
    // aging, search, date range all flow through `filtered`). Frozen
    // invoices are explicitly excluded — their case was deleted, so any
    // balance is not real outstanding money — matching the convention used
    // for open-balance figures elsewhere (e.g. the practice summary).
    let openBalance = 0, openCount = 0;
    let overdueBalance = 0, overdueCount = 0;
    // Legacy/test array responses contain no aggregate metadata. Recompute
    // from that complete response rather than from a paginated subset.
    for (const inv of data) {
      if (inv.frozen) continue;
      const bal = Number(inv.balanceDue ?? inv.total ?? 0);
      openBalance += bal;
      if (bal !== 0) {
        openCount++;
        const due = inv.dueAt ?? inv.dueDate;
        if (due && new Date(due) < today) {
          overdueBalance += bal;
          overdueCount++;
        }
      }
    }

    let paidThisMonth = 0, paidCount = 0;
    for (const inv of matchingRows) {
      if (inv.status !== "paid") continue;
      const ts = inv.updatedAt || inv.issuedAt || inv.createdAt;
      if (ts && new Date(ts) >= monthStart) {
        paidThisMonth += Number(inv.total ?? 0);
        paidCount++;
      }
    }

    return {
      openBalance,
      openCount,
      overdueBalance,
      overdueCount,
      sumTotal: matchingRows.reduce((sum, invoice) => sum + Number(invoice.total ?? 0), 0),
      sumBalance: matchingRows.reduce(
        (sum, invoice) => sum + Number(invoice.balanceDue ?? invoice.total ?? 0),
        0,
      ),
      paidThisMonth,
      paidCount,
      totalInvoices: undefined as number | undefined,
      statusCounts: undefined as InvoiceStatusCounts | undefined,
    };
  }, [matchingRows, data, loadedSummary]);

  const metricMoney = (value: number) => hasRegisterAggregates ? formatMoney(value) : "—";
  const metricCount = (value: number) => hasRegisterAggregates ? `${value.toLocaleString("en-US")} invoice${value !== 1 ? "s" : ""}` : "—";

  const labOrganizationId = data[0]?.labOrganizationId ?? "";

  const bulkDeleteMutation = useMutation({
    mutationFn: ({ expected: _expected, ...payload }: { invoiceIds?: string[]; all?: boolean; expected: number }) =>
      apiFetch<{ deletedCount: number }>("/invoices/bulk", {
        method: "DELETE",
        body: JSON.stringify({ ...(labOrganizationId ? { labOrganizationId } : {}), ...payload }),
      }),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      const affected = result?.deletedCount ?? 0;
      if (affected === 0) {
        setBulkFeedback("No invoices were deleted. Please try again or refresh.");
        return;
      }
      void refreshInvoiceSalesQueries(queryClient);
      if (!variables.all && affected < variables.expected) {
        clearSelection();
        setBulkFeedback(
          `Only ${affected} of ${variables.expected} selected invoice${variables.expected !== 1 ? "s" : ""} could be deleted.`,
        );
        return;
      }
      clearSelection();
      setBulkConfirm(null);
      setBulkFeedback(null);
    },
  });

  const bulkResetMutation = useMutation({
    mutationFn: ({ expected: _expected, ...payload }: { invoiceIds?: string[]; all?: boolean; expected: number }) =>
      apiFetch<{ resetCount: number; legacyResetCount?: number; skippedCount?: number; skippedDraftCount?: number }>("/invoices/bulk-reset", {
        method: "POST",
        body: JSON.stringify({ ...(labOrganizationId ? { labOrganizationId } : {}), ...payload }),
      }),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      const affected = result?.resetCount ?? 0;
      const skippedDrafts = result?.skippedDraftCount ?? 0;
      if (skippedDrafts > 0) {
        if (affected > 0) void refreshInvoiceSalesQueries(queryClient);
        clearSelection();
        setBulkConfirm(null);
        setBulkFeedback(`Reset ${affected} invoice${affected !== 1 ? "s" : ""}. ${skippedDrafts} Draft invoice${skippedDrafts !== 1 ? "s are" : " is"} read-only and ${skippedDrafts !== 1 ? "were" : "was"} left unchanged.`);
        return;
      }
      if (affected === 0) {
        setBulkFeedback("No invoices were reset. Please try again or refresh.");
        return;
      }
      void refreshInvoiceSalesQueries(queryClient);
      if (!variables.all && affected < variables.expected) {
        const skipped = result?.skippedCount ?? variables.expected - affected;
        clearSelection();
        setBulkFeedback(
          `Only ${affected} of ${variables.expected} selected invoice${variables.expected !== 1 ? "s" : ""} could be reset. ` +
            `${skipped} invoice${skipped !== 1 ? "s were" : " was"} skipped — likely already deleted or no longer available.`,
        );
        return;
      }
      clearSelection();
      setBulkConfirm(null);
      setBulkFeedback(null);
    },
    onError: async (err, variables) => {
      // Network-level failure (status 0): the request may have actually
      // landed on the server before the connection dropped. Refetch and
      // check whether the targeted invoices now read $0 instead of showing
      // a bare "Failed to fetch".
      if (!(err instanceof ApiError) || err.status !== 0) return;
      try {
        await queryClient.refetchQueries({ queryKey: ["invoices"] });
        // The list is batched, so the cache holds only the pages the user has
        // loaded. A target that is not in it has not been checked — reporting
        // that as a confirmed reset would be a lie.
        const cached = queryClient.getQueriesData<
          (InvoiceListPage & { query: string }) | Invoice[]
        >({ queryKey: ["invoices"] });
        const rows = cached.flatMap(([, result]) =>
          Array.isArray(result) ? result : (result?.rows ?? []),
        );
        const wholeSetCached = cached.some(([, result]) =>
          Array.isArray(result) ? true : !!result && result.rows.length >= result.total,
        );
        const cachedIds = new Set(rows.map((r) => r.id));
        const unverifiable = variables.all
          ? !wholeSetCached
          : (variables.invoiceIds ?? []).some((id) => !cachedIds.has(id));
        if (unverifiable) {
          bulkResetMutation.reset();
          setBulkFeedback(
            "The connection dropped before the server confirmed the reset. Refresh the page to see whether it went through before trying again.",
          );
          return;
        }
        const targets = variables.all
          ? rows.filter((r) => !labOrganizationId || r.labOrganizationId === labOrganizationId)
          : rows.filter((r) => variables.invoiceIds?.includes(r.id));
        const remaining = targets.filter(
          (r) => Number(r.total ?? 0) !== 0 || Number(r.balanceDue ?? 0) !== 0,
        );
        if (remaining.length === 0) {
          // The reset landed even though the response was lost.
          bulkResetMutation.reset();
          clearSelection();
          setBulkConfirm(null);
          setBulkFeedback(null);
          toast({
            title: "Reset completed",
            description:
              "The connection dropped, but the reset went through — the affected invoices now show $0.00.",
          });
          return;
        }
        bulkResetMutation.reset();
        setBulkFeedback(
          `The connection dropped before the server confirmed the reset. ${remaining.length} invoice${remaining.length !== 1 ? "s" : ""} still show${remaining.length === 1 ? "s" : ""} a balance — please try again.`,
        );
      } catch {
        // Refetch also failed — keep the original network error visible.
      }
    },
  });

  const bulkStatusMutation = useMutation({
    mutationFn: ({ expected: _expected, ...payload }: { invoiceIds: string[]; status: (typeof BULK_EDITABLE_STATUSES)[number]; expected: number }) =>
      apiFetch<{ updatedCount: number; skippedFrozenCount: number; skippedDraftCount?: number; skippedReadOnlyCount?: number; status: string }>("/invoices/bulk-status", {
        method: "POST",
        body: JSON.stringify({ ...(labOrganizationId ? { labOrganizationId } : {}), ...payload }),
      }),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      const affected = result?.updatedCount ?? 0;
      const label = statusLabel(variables.status);
      if (affected === 0) {
        setBulkFeedback(
          result?.skippedDraftCount
            ? "No invoices were updated — Draft invoices are read-only."
            : result?.skippedFrozenCount
            ? "No invoices were updated — frozen invoices cannot change status."
            : "No invoices were updated. Please try again or refresh.",
        );
        return;
      }
      void refreshInvoiceSalesQueries(queryClient);
      clearSelection();
      setBulkConfirm(null);
      setBulkFeedback(null);
      const skipped = result?.skippedReadOnlyCount ?? (result?.skippedFrozenCount ?? 0) + (result?.skippedDraftCount ?? 0);
      toast({
        title: `Updated ${affected} invoice${affected !== 1 ? "s" : ""} to ${label}`,
        description:
          skipped > 0
            ? `${skipped} frozen or Draft invoice${skipped !== 1 ? "s were" : " was"} skipped.`
            : undefined,
      });
    },
  });

  // Deletes all payment rows for the given invoices (used by the bulk Paid→Open guard).
  // After all deletions succeed, fires the bulk-status mutation for the full selection.
  const bulkDeletePaymentsMutation = useMutation({
    mutationFn: async ({ paidInvoiceIds, allInvoiceIds }: { paidInvoiceIds: string[]; allInvoiceIds: string[] }) => {
      await Promise.all(
        paidInvoiceIds.map((id) =>
          apiFetch(`/invoices/${id}/payments`, { method: "DELETE" }),
        ),
      );
      return { allInvoiceIds };
    },
    onSuccess: ({ allInvoiceIds }) => {
      void refreshInvoiceSalesQueries(queryClient);
      setBulkPaymentDeleteConfirm(null);
      bulkStatusMutation.mutate({ invoiceIds: allInvoiceIds, status: "open", expected: allInvoiceIds.length });
    },
    onError: (err: Error) => {
      setBulkFeedback(err.message || "Failed to delete payments. Please try again.");
    },
  });

  function applyBulkStatus(target: (typeof BULK_EDITABLE_STATUSES)[number]) {
    if (!labOrganizationId || selected.size === 0) return;
    setBulkFeedback(null);
    if (target === "open") {
      // Guard: detect selected invoices that are paid/partially_paid and may have payments.
      const selectedInvoices = getSelectedInvoices();
      const paidInvoices = selectedInvoices.filter(
        (i) => i.status === "paid" || i.status === "partially_paid",
      );
      if (paidInvoices.length > 0) {
        setBulkPaymentDeleteConfirm({
          paidCount: paidInvoices.length,
          paidInvoiceIds: paidInvoices.map((i) => i.id),
          allInvoiceIds: Array.from(selected),
        });
        return;
      }
      bulkStatusMutation.mutate({ invoiceIds: Array.from(selected), status: target, expected: selected.size });
      return;
    }
    if (target === "paid" || target === "void") {
      setBulkConfirm({ kind: "status_change", count: selected.size, labOrganizationId, targetStatus: target });
      return;
    }
    bulkStatusMutation.mutate({ invoiceIds: Array.from(selected), status: target, expected: selected.size });
  }

  function handleBulkConfirm() {
    if (!bulkConfirm) return;
    setBulkFeedback(null);
    if (bulkConfirm.kind === "delete_selected") {
      bulkDeleteMutation.mutate({ invoiceIds: Array.from(selected), expected: selected.size });
    } else if (bulkConfirm.kind === "reset_selected") {
      bulkResetMutation.mutate({ invoiceIds: Array.from(selected), expected: selected.size });
    } else if (bulkConfirm.kind === "reset_all") {
      bulkResetMutation.mutate({ all: true, expected: bulkConfirm.count });
    } else if (bulkConfirm.kind === "status_change" && bulkConfirm.targetStatus) {
      if (bulkConfirm.targetStatus === "paid") {
        // For Open→Paid, ask whether to record payments before applying the status change.
        const ids = Array.from(selected);
        setBulkConfirm(null);
        setBulkRecordPaymentPrompt({ count: ids.length, invoiceIds: ids });
      } else {
        bulkStatusMutation.mutate({ invoiceIds: Array.from(selected), status: bulkConfirm.targetStatus, expected: selected.size });
      }
    }
  }

  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 767px)");
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  const [moreOpenId, setMoreOpenId] = useState<string | null>(null);
  const canEditInvoice = isBillingUser || isAdminOrOwner;
  function renderRowActions(i: Invoice) {
    const balance = Number(i.balanceDue ?? i.total ?? 0);
    const btn = "inline-flex h-11 w-11 md:h-8 md:w-8 items-center justify-center rounded-md border border-border bg-card hover:bg-secondary";
    return (
      <div className="relative flex items-center justify-center gap-1.5" data-testid={`invoice-actions-${i.id}`}>
        <button type="button" className={btn} aria-label={`View invoice ${i.invoiceNumber}`} data-testid={`invoice-view-${i.id}`}
          onClick={(e) => { e.stopPropagation(); setPreviewId(i.id); }}>
          <Eye size={14} />
        </button>
        {canEditInvoice && !isReadonlyDraft(i) && (
          <button type="button" className={btn} aria-label={`Edit invoice ${i.invoiceNumber}`} data-testid={`invoice-edit-${i.id}`}
            onClick={(e) => { e.stopPropagation(); openEditorFor(i); }}>
            <FileText size={14} />
          </button>
        )}
        <button type="button" className={btn} aria-label={`More actions for invoice ${i.invoiceNumber}`} aria-haspopup="menu"
          aria-expanded={moreOpenId === i.id} data-testid={`invoice-more-${i.id}`}
          onClick={(e) => { e.stopPropagation(); setMoreOpenId((cur) => (cur === i.id ? null : i.id)); }}>
          <MoreHorizontal size={14} />
        </button>
        {moreOpenId === i.id && (
          <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-48 rounded-md border border-border bg-card py-1 text-sm shadow-lg"
            onClick={(e) => e.stopPropagation()} onMouseLeave={() => setMoreOpenId(null)}>
            <button type="button" role="menuitem" className="w-full px-3 py-1.5 text-left hover:bg-secondary inline-flex items-center gap-2"
              onClick={() => { setMoreOpenId(null); void navigator.clipboard?.writeText(i.invoiceNumber); toast({ title: "Invoice number copied" }); }}>
              <Copy size={13} /> Copy invoice number
            </button>
            {isBillingUser && balance > 0 && i.status !== "void" && !isReadonlyDraft(i) && !i.frozen && (
              <button type="button" role="menuitem" data-testid={`invoice-more-payment-${i.id}`}
                className="w-full px-3 py-1.5 text-left hover:bg-secondary inline-flex items-center gap-2"
                onClick={() => {
                  setMoreOpenId(null);
                  setReceivePaymentModal({
                    practiceOrDoctorName: i.providerOrganization?.name ?? "",
                    defaultAmount: balance,
                    invoiceIds: [i.id],
                    providerOrganizationId: i.providerOrganizationId ?? "",
                  });
                }}>
                <CreditCard size={13} /> Record payment
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-8 py-7 xl:flex xl:items-start xl:gap-5 max-md:[&_button]:min-h-11 max-md:[&_select]:min-h-11 max-md:[&_input:not([type=checkbox])]:min-h-11">
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div className="flex items-start gap-3">
          <span data-testid="invoices-heading-icon" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white">
            <FileText size={22} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Invoices</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Open balances, payments, and statements.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 min-w-0 max-w-full">
          {exportState ? (
            <button
              type="button"
              data-testid="invoices-export-cancel"
              onClick={() => exportAbortRef.current?.abort()}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium border border-border bg-card hover:bg-secondary"
            >
              <Loader2 size={14} className="animate-spin" />
              Exporting {exportState.loaded}{exportState.total != null ? ` of ${exportState.total}` : ""} - Cancel
            </button>
          ) : (
            <button
              type="button"
              data-testid="invoices-export"
              onClick={() => void exportCsv()}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium border border-border bg-card hover:bg-secondary"
            >
              <Download size={14} /> Export
            </button>
          )}
          <button
            type="button"
            data-testid="invoices-statements"
            onClick={() => setLocation("/statements")}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium border border-border bg-card hover:bg-secondary"
          >
            <FileText size={14} /> Statements
          </button>
          {canEditInvoice && <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700"
          >
            <Plus size={14} /> New Invoice
          </button>}
        </div>
      </div>

      <div data-testid="invoice-summary-cards" className="grid grid-cols-1 min-[360px]:grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
        <InvoiceKpiCard
          testId="invoice-open-card"
          tone="blue"
          icon={<FileText size={20} />}
          label="Open Balance"
          value={metricMoney(stats.openBalance)}
          sub={metricCount(stats.openCount)}
        />
        <InvoiceKpiCard
          testId="invoice-overdue-card"
          tone="red"
          icon={<AlertCircle size={20} />}
          label="Overdue"
          value={metricMoney(stats.overdueBalance)}
          sub={metricCount(stats.overdueCount)}
          onClick={() => {
            setStatusSelection({ kind: "view", view: "outstanding" });
            setOverdueBucket("");
            setCustomDueDateFrom("");
            setCustomDueDateTo("");
          }}
        />
        <InvoiceKpiCard
          testId="invoice-paid-card"
          tone="green"
          icon={<CheckCircle2 size={20} />}
          label="Paid This Month"
          value={metricMoney(stats.paidThisMonth)}
          sub={metricCount(stats.paidCount)}
        />
        <InvoiceKpiCard
          testId="invoice-total-card"
          tone="violet"
          icon={<FileText size={20} />}
          label="Total Invoices"
          value={stats.totalInvoices != null ? stats.totalInvoices.toLocaleString("en-US") : "\u2014"}
          sub="All time"
        />
      </div>

      {!isLoading && !error && loaded.key === queryString && !hasRegisterAggregates && (
        <p role="status" className="mb-3 text-xs text-muted-foreground">Invoice totals are unavailable. Refresh to try again.</p>
      )}
      <div className="bg-card border border-border rounded-xl">
        <div data-testid="invoice-controls" className="sticky top-0 z-20 bg-card rounded-t-xl">
        <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search invoice #, patient, doctor, or practice..."
              className="w-full h-10 pl-8 pr-3 rounded-lg bg-card text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-border focus:border-primary"
            />
          </div>
          <MultiSelectFilter
            label="Status"
            options={STATUS_FILTER_OPTIONS}
            selected={unifiedStatusSelection}
            onChange={setUnifiedStatusSelection}
            data-testid="invoices-status-filter"
          />
          <select
            value={invoiceDatePreset}
            onChange={(e) => {
              const val = e.target.value as InvoiceDatePreset;
              setInvoiceDatePreset(val);
              if (val !== "custom") {
                setCustomIssuedFrom("");
                setCustomIssuedTo("");
              }
            }}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
            title="Invoice date"
          >
            {(Object.keys(INVOICE_DATE_PRESET_LABELS) as InvoiceDatePreset[]).map((key) => (
              <option key={key} value={key}>
                {INVOICE_DATE_PRESET_LABELS[key]}
              </option>
            ))}
          </select>
          {viewMode !== "outstanding" && (
          <select
            value={overdueBucket}
            onChange={(e) => {
              setOverdueBucket(e.target.value);
              if (e.target.value !== "custom") {
                setCustomDueDateFrom("");
                setCustomDueDateTo("");
              }
            }}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
            title="Overdue bucket"
          >
            <option value="">Any age</option>
            <option value="0_30">0–30 days overdue</option>
            <option value="31_60">31–60 days overdue</option>
            <option value="61_90">61–90 days overdue</option>
            <option value="90_plus">90+ days overdue</option>
            {isAdminOrOwner && <option value="custom">Custom date range…</option>}
          </select>
          )}
          <select
            value={doctorName}
            onChange={(e) => setDoctorName(e.target.value)}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
            title="Filter by doctor"
          >
            <option value="">All doctors</option>
            {distinctDoctorNames.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground select-none">
            <input
              type="checkbox"
              checked={aiOnly}
              onChange={(e) => setAiOnly(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            <Sparkles size={12} className="text-amber-500" />
            AI-imported only
          </label>
          <button
            type="button"
            data-testid="sort-issued"
            onClick={() => toggleSort("issued")}
            className="inline-flex items-center gap-1 h-9 px-2.5 rounded-md bg-secondary text-xs font-medium hover:bg-secondary/70"
            title="Sort by issued date"
          >
            Issued
            {sortKey === "issued" ? (sortDir === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} />) : <span className="opacity-30"><ArrowUp size={10} /></span>}
          </button>
          <button
            type="button"
            data-testid="invoices-clear-filters"
            onClick={() => {
              setSearch("");
              setStatusSelection({ kind: "all" });
              setAiOnly(false);
              setDoctorName("");
              setOverdueBucket("");
              setCustomDueDateFrom("");
              setCustomDueDateTo("");
              setInvoiceDatePreset("all");
              setCustomIssuedFrom("");
              setCustomIssuedTo("");
            }}
            className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-xs font-medium text-blue-600 hover:bg-secondary"
          >
            <RotateCcw size={13} /> Clear Filters
          </button>
          <button
            type="button"
            onClick={() => setStatementBuilderOpen(true)}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-xs font-medium hover:bg-secondary"
            title="Build a multi-practice statement"
          >
            <FileText size={14} /> Multi-practice statement
          </button>
        </div>

        {overdueBucket === "custom" && isAdminOrOwner && (
          <div className="px-4 py-2.5 flex items-center gap-3 border-b border-border flex-wrap bg-muted/40">
            <span className="text-xs font-medium text-muted-foreground">Invoice date range:</span>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">From</label>
              <input
                type="date"
                value={customDueDateFrom}
                onChange={(e) => setCustomDueDateFrom(e.target.value)}
                className="h-8 px-2 rounded-md bg-card text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">to</label>
              <input
                type="date"
                value={customDueDateTo}
                onChange={(e) => setCustomDueDateTo(e.target.value)}
                min={customDueDateFrom || undefined}
                className="h-8 px-2 rounded-md bg-card text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            {customDueDateFrom && customDueDateTo && customDueDateTo < customDueDateFrom && (
              <span className="text-xs text-destructive">End must be on or after start</span>
            )}
          </div>
        )}

        {invoiceDatePreset === "custom" && (
          <div className="px-4 py-2.5 flex items-center gap-3 border-b border-border flex-wrap bg-muted/40">
            <span className="text-xs font-medium text-muted-foreground">Invoice date:</span>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">From</label>
              <input
                type="date"
                value={customIssuedFrom}
                onChange={(e) => setCustomIssuedFrom(e.target.value)}
                className="h-8 px-2 rounded-md bg-card text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">to</label>
              <input
                type="date"
                value={customIssuedTo}
                onChange={(e) => setCustomIssuedTo(e.target.value)}
                min={customIssuedFrom || undefined}
                className="h-8 px-2 rounded-md bg-card text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            {customIssuedFrom && customIssuedTo && customIssuedTo < customIssuedFrom && (
              <span className="text-xs text-destructive">End must be on or after start</span>
            )}
          </div>
        )}

        {(selectProgress || selectError || selectExcluded > 0) && (
          <div data-testid="invoice-select-all-status" role="status" aria-live="polite"
            className={`flex flex-wrap items-center gap-3 px-5 py-2 rounded-md mb-2 text-xs border ${selectError ? "border-destructive/40 text-destructive" : "border-border text-muted-foreground"}`}>
            {selectProgress && (
              <>
                <span>Selecting matching invoices: {selectProgress.loaded}{selectProgress.total != null ? ` of ${selectProgress.total}` : ""}</span>
                <button type="button" className="underline" data-testid="invoice-select-all-cancel" onClick={() => { selectAbortRef.current?.abort(); selectAbortRef.current = null; setSelectProgress(null); }}>Cancel</button>
              </>
            )}
            {selectError && (
              <>
                <span>Could not select all matching invoices: {selectError}</span>
                <button type="button" className="underline" data-testid="invoice-select-all-retry" onClick={() => void selectAllMatching()}>Retry</button>
              </>
            )}
            {!selectProgress && !selectError && selectExcluded > 0 && (
              <span data-testid="invoice-select-all-excluded">
                {selectExcluded} draft invoice{selectExcluded !== 1 ? "s were" : " was"} not selected: drafts are read-only and cannot be bulk edited, reset, paid or sent.
              </span>
            )}
          </div>
        )}
        {selected.size > 0 && (
          <div data-testid="invoice-bulk-controls" className="flex flex-wrap items-center gap-3 px-5 py-2 bg-primary/5 border border-primary/20 rounded-md mb-2 text-sm [&>button]:shrink-0 [&>span]:shrink-0">
            <span className="font-medium text-primary">{selected.size} invoice{selected.size !== 1 ? "s" : ""} selected</span>
            <button
              type="button"
              onClick={() => setBulkSendOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90"
            >
              <Send size={12} /> Send {selected.size > 1 ? `${selected.size} invoices` : "invoice"}
            </button>
            {isBillingUser && labOrganizationId && (
              <>
                <button
                  type="button"
                  onClick={() => { setBulkFeedback(null); setBulkConfirm({ kind: "delete_selected", count: selected.size, labOrganizationId }); }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-destructive/10 text-destructive border border-destructive/20 text-xs font-medium hover:bg-destructive/20"
                >
                  <Trash2 size={12} /> Delete selected
                </button>
                <button
                  type="button"
                  onClick={() => { setBulkFeedback(null); setBulkConfirm({ kind: "reset_selected", count: selected.size, labOrganizationId }); }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-warning/10 text-warning border border-warning/20 text-xs font-medium hover:bg-warning/20"
                >
                  <RotateCcw size={12} /> Reset to $0
                </button>
                <button
                  type="button"
                  onClick={() => { setBulkFeedback(null); setBulkConfirm({ kind: "reset_all", count: loadedTotal || filtered.length, labOrganizationId }); }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-warning/10 text-warning border border-warning/20 text-xs font-medium hover:bg-warning/20"
                >
                  <RotateCcw size={12} /> Reset all to $0
                </button>
                <select
                  aria-label="Change status"
                  value=""
                  disabled={bulkStatusMutation.isPending}
                  onChange={(e) => {
                    const v = e.target.value as (typeof BULK_EDITABLE_STATUSES)[number];
                    e.target.value = "";
                    if (v) applyBulkStatus(v);
                  }}
                  className="px-3 py-1.5 rounded-md bg-secondary text-foreground border border-border text-xs font-medium hover:bg-secondary/70 disabled:opacity-50"
                >
                  <option value="">Change status…</option>
                  {BULK_EDITABLE_STATUSES.map((s) => (
                    <option key={s} value={s}>{statusLabel(s)}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => { setBulkFeedback(null); setBulkRemakeOpen(true); }}
                  title="Step through the selected invoices and link each one's case as a remake of an earlier case"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-secondary text-foreground border border-border text-xs font-medium hover:bg-secondary/70"
                >
                  <GitBranch size={12} /> Mark as remakes
                </button>
                <button
                  type="button"
                  onClick={() => {
                    startBulkReceivePayment();
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 text-xs font-medium hover:bg-emerald-500/20"
                >
                  <CreditCard size={12} /> Receive Payment
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="ml-auto text-xs text-muted-foreground hover:text-foreground"
            >
              Clear selection
            </button>
          </div>
        )}
        </div>

        <div role="tablist" aria-label="Invoice status" data-testid="invoice-status-tabs" className="flex flex-wrap gap-2 px-5 py-3 border-b border-border">
          {STATUS_TABS.map((tab) => {
            const active = tab.key === "all"
              ? unifiedStatusSelection.length === 0
              : unifiedStatusSelection.length === 1 && unifiedStatusSelection[0] === (tab.key === "overdue" ? "outstanding" : tab.key);
            const count = loadedSummary?.statusCounts?.[tab.key];
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`invoice-tab-${tab.key}`}
                onClick={() => {
                  if (tab.key === "all") setUnifiedStatusSelection([]);
                  else setUnifiedStatusSelection([tab.key === "overdue" ? "outstanding" : tab.key]);
                }}
                className={`inline-flex items-center gap-2 h-8 px-3 rounded-lg text-sm font-medium border ${active ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border hover:bg-secondary"}`}
              >
                {tab.label}
                <span className={`text-xs tabular-nums rounded-full px-1.5 ${active ? "bg-primary-foreground/20" : "bg-secondary"}`}>
                  {count != null ? count.toLocaleString("en-US") : "\u2014"}
                </span>
              </button>
            );
          })}
          {unifiedStatusSelection.length > 1 || (unifiedStatusSelection.length === 1 && !STATUS_TABS.some((t) => (t.key === "overdue" ? "outstanding" : t.key) === unifiedStatusSelection[0])) ? (
            <span data-testid="invoice-tab-custom" className="inline-flex items-center h-8 px-3 rounded-lg text-sm border border-primary text-primary">
              Custom ({unifiedStatusSelection.length})
            </span>
          ) : null}
        </div>
        <div
          data-testid="invoices-loaded-count"
          className="flex flex-wrap items-center justify-between gap-2 px-5 py-2 text-xs text-muted-foreground border-b border-border"
        >
          <span>Showing {rangeStart}-{rangeEnd} of {loadedTotal.toLocaleString("en-US")} invoices</span>
          <label className="inline-flex items-center gap-2">
            <span className="sr-only">Rows per page</span>
            <select
              data-testid="invoices-page-size"
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="h-8 px-2 rounded-md bg-secondary text-xs border border-border"
            >
              {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n} per page</option>)}
            </select>
          </label>
        </div>
        <div className="overflow-x-auto rounded-b-xl">
          {!narrow && <table className="w-full text-sm">
            <thead>
              <tr className="bg-sky-50 dark:bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={headerChecked}
                    disabled={selectProgress !== null}
                    ref={(el) => {
                      if (el) el.indeterminate = selected.size > 0 && !headerChecked;
                    }}
                    onChange={(e) => {
                      if (e.target.checked) void selectAllMatching();
                      else clearSelection();
                    }}
                    aria-label={selected.size > 0 ? "Deselect all matching invoices" : `Select all ${loadedTotal || filtered.length} matching invoices`}
                    data-testid="invoice-select-all"
                    title={selected.size > 0 && !headerChecked ? "Select all matching invoices" : headerChecked ? "Deselect all" : "Select all matching invoices"}
                  />
                </th>
                <th className="text-left font-medium px-2 py-2.5">Invoice #</th>
                <th className="text-left font-medium py-2.5">
                  <button
                    type="button"
                    onClick={() => toggleSort("practice")}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    Practice / Patient
                    {sortKey === "practice" ? (
                      sortDir === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} />
                    ) : (
                      <span className="opacity-30"><ArrowUp size={10} /></span>
                    )}
                  </button>
                </th>
                <th className="text-left font-medium py-2.5">Restoration</th>
                <th className="text-left font-medium py-2.5">
                  <button
                    type="button"
                    onClick={() => toggleSort("due")}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    Due Date
                    {sortKey === "due" ? (
                      sortDir === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} />
                    ) : (
                      <span className="opacity-30"><ArrowUp size={10} /></span>
                    )}
                  </button>
                </th>
                <th className="text-left font-medium py-2.5">Status</th>
                <th className="text-right font-medium py-2.5">
                  Total
                  <ColumnTotal
                    values={[stats.sumTotal]}
                    loading={isLoading || !hasRegisterAggregates}
                    testId="column-total-total"
                  />
                </th>
                <th className="text-right font-medium px-5 py-2.5">
                  Balance
                  <ColumnTotal
                    values={[stats.sumBalance]}
                    loading={isLoading || !hasRegisterAggregates}
                    testId="column-total-balance"
                  />
                </th>
                <th className="text-center font-medium px-3 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={9} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading invoices…
                  </td>
                </tr>
              )}
              {error && (
                <tr>
                  <td colSpan={9} className="px-5 py-12 text-center text-destructive">
                    {(error as Error).message}
                  </td>
                </tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-5 py-12 text-center text-muted-foreground">
                    No invoices match the current filters.
                  </td>
                </tr>
              )}
              {filtered.map((i) => {
                const meta = readDisplayMetadata(i);
                const hasDateDriftWarning =
                  isLikelyLegacyShiftedInvoiceDate(i.issuedAt, i.createdAt) ||
                  isLikelyLegacyShiftedInvoiceDate(i.dueAt ?? i.dueDate, i.createdAt);
                return (
                <tr
                  key={i.id}
                  onClick={(event) => {
                    event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
                    setPreviewId(i.id);
                  }}
                  data-testid={`invoice-row-${i.id}`}
                  aria-selected={previewId === i.id}
                  className={`border-t border-border/60 cursor-pointer ${previewId === i.id ? "bg-primary/10 hover:bg-primary/10" : "hover:bg-secondary/40"}`}
                >
                  <td className="w-10 px-3 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5"
                      aria-label={`Select invoice ${i.invoiceNumber}`}
                      checked={selected.has(i.id) && !isReadonlyDraft(i)}
                      disabled={isReadonlyDraft(i)}
                      title={isReadonlyDraft(i) ? "Draft invoices are read-only and cannot be selected" : undefined}
                      onMouseDown={suppressShiftClickTextSelection}
                      onChange={(e) =>
                        handleInvoiceRowCheckboxChange(
                          i.id,
                          e.target.checked,
                          shiftKeyFromChangeEvent(e),
                        )
                      }
                    />
                  </td>
                  <td className="px-2 py-3 font-mono text-xs">
                    <span className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        aria-label={`Preview invoice ${i.invoiceNumber}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setPreviewId(i.id);
                        }}
                        className="rounded text-blue-600 font-semibold hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                      >
                        {i.invoiceNumber}
                      </button>
                      {i.aiGenerated && !i.aiReviewedAt && (
                        <span title="AI-imported — needs review">
                          <Sparkles size={11} className="text-amber-500" />
                        </span>
                      )}
                      {isAdminOrOwner && hasDateDriftWarning && (
                        <span title="One or more dates may have shifted under the former timezone handling">
                          <TriangleAlert size={11} className="text-amber-500" />
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="py-3 pr-2 max-w-[260px]">
                    <div className="truncate font-medium">
                      {i.providerOrganization?.name || <span className="text-muted-foreground">{"\u2014"}</span>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{meta.patientName || "\u2014"}</div>
                  </td>
                  <td className="py-3 pr-2 text-xs text-muted-foreground max-w-[220px]">
                    <div className="truncate" title={[meta.caseType, meta.caseSubtype, meta.material, meta.billTo].filter(Boolean).join(" / ")}>
                      {restorationText(meta) || "\u2014"}
                    </div>
                  </td>
                  <td
                    data-testid={`invoice-due-${i.id}`}
                    className={`py-3 ${isInvoiceOverdue(i) ? "text-red-600 font-medium dark:text-red-400" : "text-muted-foreground"}`}
                  >
                    {formatInvoiceDate(i.dueAt ?? i.dueDate)}
                  </td>
                  <td className="py-3">
                    <span className="inline-flex items-center flex-wrap gap-1.5">
                      <StatusBadge status={i.status} />
                      {i.frozen && (
                        <span
                          title={String(i.status) === "recovery_draft" ? "Current-rate replacement held for charge and historical-payment review; not collectible" : "Invoice is frozen — the linked case was deleted"}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full uppercase tracking-wide bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400 border border-amber-300/60 dark:border-amber-700/40"
                        >
                          <Lock size={9} />
                          {String(i.status) === "recovery_draft" ? "Review hold" : "Frozen"}
                        </span>
                      )}
                      {i.hasUnpricedAlloy && (
                        <span
                          title="One or more alloy sub-items still need a unit price"
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full uppercase tracking-wide bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400 border border-amber-300/60 dark:border-amber-700/40"
                        >
                          <TriangleAlert size={9} />
                          Alloy unpriced
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="py-3 text-right tabular-nums font-medium">
                    {formatMoney(i.total)}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">
                    {formatMoney(i.balanceDue ?? i.total)}
                  </td>
                  <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                    {renderRowActions(i)}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>}
          {narrow && <ul data-testid="invoice-mobile-list" className="divide-y divide-border">
            {isLoading && <li className="px-4 py-8 text-center text-muted-foreground">Loading invoices...</li>}
            {error && <li className="px-4 py-8 text-center text-destructive">{(error as Error).message}</li>}
            {!isLoading && !error && filtered.length === 0 && (
              <li className="px-4 py-8 text-center text-muted-foreground">No invoices match the current filters.</li>
            )}
            {filtered.map((i) => {
              const meta = readDisplayMetadata(i);
              return (
                <li
                  key={i.id}
                  data-testid={`invoice-card-${i.id}`}
                  onClick={() => setPreviewId(i.id)}
                  className={`px-4 py-3 flex flex-col gap-2 ${previewId === i.id ? "bg-primary/10" : ""}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <label className="inline-flex h-11 w-11 shrink-0 items-center justify-center">
                      <input
                        type="checkbox"
                        className="h-5 w-5"
                        aria-label={`Select invoice ${i.invoiceNumber}`}
                        checked={selected.has(i.id) && !isReadonlyDraft(i)}
                        disabled={isReadonlyDraft(i)}
                        title={isReadonlyDraft(i) ? "Draft invoices are read-only and cannot be selected" : undefined}
                        onMouseDown={suppressShiftClickTextSelection}
                        onChange={(e) => handleInvoiceRowCheckboxChange(i.id, e.target.checked, shiftKeyFromChangeEvent(e))}
                      />
                      </label>
                      <button type="button" aria-label={`Preview invoice ${i.invoiceNumber}`} onClick={() => setPreviewId(i.id)}
                        className="font-semibold text-blue-600 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                        {i.invoiceNumber}
                      </button>
                      {i.aiGenerated && !i.aiReviewedAt && <Sparkles size={12} className="text-amber-500" aria-label="AI-imported, needs review" />}
                      {i.frozen && <Lock size={12} className="text-amber-600" aria-label="Frozen" />}
                      {i.hasUnpricedAlloy && <TriangleAlert size={12} className="text-amber-500" aria-label="Alloy unpriced" />}
                    </span>
                    <StatusBadge status={i.status} />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate font-medium">{i.providerOrganization?.name || "\u2014"}</div>
                    <div className="truncate text-xs text-muted-foreground">{meta.patientName || "\u2014"}</div>
                    {restorationText(meta) && <div className="truncate text-xs text-muted-foreground">{restorationText(meta)}</div>}
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className={isInvoiceOverdue(i) ? "text-red-600 font-medium" : "text-muted-foreground"}>
                      Due {formatInvoiceDate(i.dueAt ?? i.dueDate)}
                    </span>
                    <span className="tabular-nums text-right">
                      <span className="text-xs text-muted-foreground">Total {formatMoney(i.total)} - Balance </span>
                      <span className="font-semibold">{formatMoney(i.balanceDue ?? i.total)}</span>
                    </span>
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>{renderRowActions(i)}</div>
                </li>
              );
            })}
          </ul>}
        </div>
        {pageCount > 1 && (
          <nav aria-label="Pagination" data-testid="invoices-pager" className="flex flex-wrap items-center justify-end gap-1 px-5 py-3 border-t border-border max-md:[&_button]:min-w-11">
            <button type="button" data-testid="invoices-page-prev" aria-label="Previous page" disabled={page <= 1 || isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))} className="h-8 min-w-8 px-2 rounded-md border border-border text-sm hover:bg-secondary disabled:opacity-40">&lt;</button>
            {pagerItems(page, pageCount).map((item, idx) =>
              item === "gap" ? (
                <span key={`gap-${idx}`} className="px-1 text-muted-foreground">...</span>
              ) : (
                <button key={item} type="button" aria-label={`Page ${item}`} data-testid={`invoices-page-${item}`} aria-current={item === page ? "page" : undefined} disabled={isFetching} onClick={() => setPage(item)} className={`h-8 min-w-8 px-2 rounded-md text-sm tabular-nums ${item === page ? "bg-primary text-primary-foreground" : "border border-border hover:bg-secondary"}`}>{item}</button>
              ),
            )}
            <button type="button" data-testid="invoices-page-next" aria-label="Next page" disabled={page >= pageCount || isFetching} onClick={() => setPage((p) => Math.min(pageCount, p + 1))} className="h-8 min-w-8 px-2 rounded-md border border-border text-sm hover:bg-secondary disabled:opacity-40">&gt;</button>
          </nav>
        )}
      </div>

    </div>
    {previewId && (
      <InvoicePreviewPanel
        key={previewId}
        invoiceId={previewId}
        refreshToken={listQuery.dataUpdatedAt}
        canRecordPayment={isBillingUser}
        canEdit={canEditInvoice}
        suppressEscape={!!editing || !!receivePaymentModal || createOpen}
        onClose={() => {
          const params = new URLSearchParams(urlSearch);
          const returnTo = params.get("returnTo");
          if (returnTo === "/reports" || returnTo?.startsWith("/reports?")) {
            setLocation(returnTo);
            return;
          }
          setPreviewId(null);
          params.delete("previewId");
          params.delete("returnTo");
          const query = params.toString();
          setLocation(`/invoices${query ? `?${query}` : ""}`);
        }}
        onEdit={(inv) => openEditorFor(inv)}
        onRecordPayment={(inv) => {
          const m = readDisplayMetadata(inv);
          setReceivePaymentModal({
            practiceOrDoctorName: inv.providerOrganization?.name || m.billTo || "Unknown",
            defaultAmount: Math.max(0, Number(inv.balanceDue ?? 0)),
            invoiceIds: [inv.id],
            providerOrganizationId: inv.providerOrganizationId,
            doctorName: inv.doctorIdentity || inv.doctorDisplayName || inv.doctorName || null,
          });
        }}
      />
    )}
      {editing && (
        <InvoiceEditor
          key={editing.id}
          invoice={editing}
          doctorNames={distinctDoctorNames}
          onClose={() => {
            setEditing(null);
            void queryClient.invalidateQueries({ queryKey: INVOICE_PREVIEW_QUERY_KEY });
            const params = new URLSearchParams(window.location.search);
            if (params.has("invoiceId")) {
              params.delete("invoiceId");
              const newSearch = params.toString();
              setLocation(`/invoices${newSearch ? `?${newSearch}` : ""}`);
            }
          }}
          onGoToCase={() => {
            const caseId = editing.caseId;
            if (caseId) {
              // Don't unmount the editor first — navigating while dirty must let
              // the navigation guard show the discard prompt. The route change
              // itself unmounts the editor once the user proceeds.
              setLocation(`/cases?caseId=${encodeURIComponent(caseId)}`);
            } else {
              setEditing(null);
            }
          }}
        />
      )}
      {paymentChoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Choose practice for payment" data-testid="payment-practice-choice">
          <div className="w-full max-w-md rounded-xl border border-border bg-background p-5 shadow-xl">
            <h2 className="text-base font-semibold">Receive payment for one practice</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Your selection spans {paymentChoice.groups.length} practices. A payment applies to one practice; the others are left out.
            </p>
            <ul className="mt-3 space-y-2">
              {paymentChoice.groups.map((g) => {
                const excluded = paymentChoice.groups.filter((o) => o !== g).flatMap((o) => o.invoices);
                const total = g.invoices.reduce((t, i) => t + Math.max(0, Number(i.balanceDue ?? 0)), 0);
                return (
                  <li key={g.providerOrganizationId}>
                    <button
                      type="button"
                      data-testid={`payment-choice-${g.providerOrganizationId}`}
                      onClick={() => { setPaymentChoice(null); openReceivePaymentFor(g.invoices, excluded); }}
                      className="w-full rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-secondary"
                    >
                      <span className="font-medium">{g.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {g.invoices.length} invoice{g.invoices.length === 1 ? "" : "s"} - {formatMoney(total)} balance
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        Excludes {excluded.length}: {excluded.map((i) => i.invoiceNumber).join(", ")}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <button type="button" onClick={() => setPaymentChoice(null)} className="mt-3 text-xs text-muted-foreground hover:text-foreground">Cancel</button>
          </div>
        </div>
      )}
      {createOpen && (
        <CreateInvoiceDialog
          knownLabOrgId={data?.[0]?.labOrganizationId}
          onClose={() => setCreateOpen(false)}
          onCreated={(inv) => {
            void refreshInvoiceSalesQueries(queryClient, inv.id, inv.caseId);
            setCreateOpen(false);
            openEditorFor(inv);
          }}
        />
      )}
      {statementBuilderOpen && (
        <StatementBuilderDialog
          knownLabOrgId={data?.[0]?.labOrganizationId}
          onClose={() => setStatementBuilderOpen(false)}
        />
      )}
      {bulkSendOpen && (
        <BulkSendDialog
          invoices={getSelectedInvoices()}
          onClose={() => setBulkSendOpen(false)}
          onSent={() => { clearSelection(); setBulkSendOpen(false); }}
        />
      )}
      {bulkRemakeOpen && (
        <BulkMarkRemakeWizard
          invoices={getSelectedInvoices()}
          isAdmin={isAdminOrOwner}
          onClose={(anyLinked) => {
            setBulkRemakeOpen(false);
            if (anyLinked) {
              clearSelection();
              queryClient.invalidateQueries({ queryKey: ["invoices"] });
              queryClient.invalidateQueries({ queryKey: ["cases"] });
            }
          }}
        />
      )}
      {receivePaymentModal && labOrganizationId && (
        <ReceivePaymentModal
          open={true}
          onClose={() => {
            setReceivePaymentModal(null);
            void queryClient.invalidateQueries({ queryKey: INVOICE_PREVIEW_QUERY_KEY });
            window.requestAnimationFrame(() => {
              document.querySelector<HTMLButtonElement>('[data-testid="invoice-preview-record-payment"]')?.focus();
            });
          }}
          practiceOrDoctorName={receivePaymentModal.practiceOrDoctorName}
          defaultAmount={receivePaymentModal.defaultAmount}
          invoiceIds={receivePaymentModal.invoiceIds}
          providerOrganizationId={receivePaymentModal.providerOrganizationId}
          labOrganizationId={labOrganizationId}
          doctorName={receivePaymentModal.doctorName ?? null}
        />
      )}
      {bulkConfirm && (
        <BulkInvoiceConfirmModal
          kind={bulkConfirm.kind}
          count={bulkConfirm.count}
          targetStatusLabel={bulkConfirm.targetStatus ? statusLabel(bulkConfirm.targetStatus) : null}
          pending={bulkDeleteMutation.isPending || bulkResetMutation.isPending || bulkStatusMutation.isPending}
          error={
            (bulkDeleteMutation.error instanceof Error ? bulkDeleteMutation.error.message : null) ??
            (bulkResetMutation.error instanceof Error ? bulkResetMutation.error.message : null) ??
            (bulkStatusMutation.error instanceof Error ? bulkStatusMutation.error.message : null)
          }
          feedback={bulkFeedback}
          onCancel={() => {
            setBulkConfirm(null);
            setBulkFeedback(null);
          }}
          onConfirm={handleBulkConfirm}
        />
      )}
      {/* Bulk Paid→Open guard: some selected invoices have recorded payments */}
      {bulkPaymentDeleteConfirm && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
            <h3 className="text-base font-semibold">Some invoices have recorded payments</h3>
            <p className="text-sm text-muted-foreground">
              {bulkPaymentDeleteConfirm.paidCount} of the {bulkPaymentDeleteConfirm.allInvoiceIds.length} selected invoice{bulkPaymentDeleteConfirm.allInvoiceIds.length !== 1 ? "s are" : " is"} currently Paid or Partially Paid and {bulkPaymentDeleteConfirm.paidCount !== 1 ? "have" : "has"} recorded payments. Deleting {bulkPaymentDeleteConfirm.paidCount !== 1 ? "them" : "it"} will clear those ledger entries and mark all selected invoices as Open.
            </p>
            {bulkDeletePaymentsMutation.error instanceof Error && (
              <p className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
                {bulkDeletePaymentsMutation.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setBulkPaymentDeleteConfirm(null)}
                disabled={bulkDeletePaymentsMutation.isPending}
                className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() =>
                  bulkDeletePaymentsMutation.mutate({
                    paidInvoiceIds: bulkPaymentDeleteConfirm.paidInvoiceIds,
                    allInvoiceIds: bulkPaymentDeleteConfirm.allInvoiceIds,
                  })
                }
                disabled={bulkDeletePaymentsMutation.isPending}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md text-sm font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              >
                {bulkDeletePaymentsMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                Delete payments & mark Open
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Bulk Open→Paid prompt: ask whether to record payments */}
      {bulkRecordPaymentPrompt && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
            <h3 className="text-base font-semibold">
              Mark {bulkRecordPaymentPrompt.count} invoice{bulkRecordPaymentPrompt.count !== 1 ? "s" : ""} as Paid
            </h3>
            <p className="text-sm text-muted-foreground">
              Do you want to record a payment entry for {bulkRecordPaymentPrompt.count !== 1 ? "these invoices" : "this invoice"}? This keeps the financial ledger accurate.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  const ids = bulkRecordPaymentPrompt.invoiceIds;
                  const cnt = bulkRecordPaymentPrompt.count;
                  setBulkRecordPaymentPrompt(null);
                  bulkStatusMutation.mutate({ invoiceIds: ids, status: "paid", expected: cnt });
                }}
                className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary"
              >
                No, just mark as paid
              </button>
              <button
                type="button"
                onClick={() => {
                  const ids = bulkRecordPaymentPrompt.invoiceIds;
                  setBulkRecordPaymentPrompt(null);
                  // Open ReceivePaymentModal pre-seeded with the selected invoices.
                  const idSet = new Set(ids);
                  const selectedInvs = getSelectedInvoices().filter((i) => idSet.has(i.id));
                  const first = selectedInvs[0];
                  if (!first || !labOrganizationId) return;
                  const defaultAmount = selectedInvs.reduce(
                    (sum, inv) => sum + Math.max(0, Number(inv.balanceDue ?? inv.total ?? 0)),
                    0,
                  );
                  setReceivePaymentModal({
                    practiceOrDoctorName: first.providerOrganization?.name ?? "",
                    defaultAmount,
                    invoiceIds: ids,
                    providerOrganizationId: first.providerOrganizationId,
                    doctorName: (() => {
                      const names = [...new Set(selectedInvs.map(i => i.doctorIdentity || i.doctorDisplayName || i.doctorName || "").filter(Boolean))];
                      return names.length === 1 ? names[0] : null;
                    })(),
                  });
                }}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <CreditCard size={14} /> Yes, record payment
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Bulk "Mark as remakes" wizard ────────────────────────────────────────────
// Steps through the selected invoices one at a time, collecting the same
// original-case + questionnaire answers as the single-invoice "Mark as remake"
// action inside the Invoice Editor, and submits each one through the exact
// same PATCH /cases/:caseId/mark-as-remake endpoint — so suffix assignment,
// history events, no-charge invoice zeroing, and remake-stat counting are
// identical to the single flow. Invoices without a linked case (or whose case
// is already a remake) can only be skipped.
type BulkRemakeResult = {
  invoiceId: string;
  invoiceNumber: string;
  status: "linked" | "skipped";
  detail?: string;
};

function BulkMarkRemakeWizard({
  invoices,
  isAdmin,
  onClose,
}: {
  invoices: Invoice[];
  isAdmin: boolean;
  onClose: (anyLinked: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [index, setIndex] = useState(0);
  const [results, setResults] = useState<BulkRemakeResult[]>([]);
  const [remakeSelected, setRemakeSelected] = useState<RemakeCaseHit | null>(null);
  const [questionnaire, setQuestionnaire] = useState<RemakeQuestionnaireValue>(
    blankQuestionnaire(),
  );
  const [submitError, setSubmitError] = useState<string | null>(null);

  const finished = index >= invoices.length;
  const current = finished ? null : invoices[index]!;
  const caseId = current?.caseId ?? null;
  const meta = readDisplayMetadata(current);

  // Fetch the current invoice's linked case so we can show its case number
  // and detect "already a remake" up front instead of via a submit error.
  // Reuses the Invoice Editor's query key so the cache is shared.
  const linkedCaseQuery = useQuery({
    queryKey: ["case-number-for-invoice", caseId],
    queryFn: () =>
      apiFetch<LabCase & { restorations?: CaseRestoration[] }>(`/cases/${caseId}`),
    enabled: !!caseId && !finished,
    staleTime: 300_000,
  });
  const linkedCase = caseId ? linkedCaseQuery.data ?? null : null;
  const alreadyRemake = !!linkedCase?.remakeOfCaseId;

  const linkedCount = results.filter((r) => r.status === "linked").length;

  function advance(result: BulkRemakeResult) {
    setResults((prev) => [...prev, result]);
    setRemakeSelected(null);
    setQuestionnaire(blankQuestionnaire());
    setSubmitError(null);
    setIndex((i) => i + 1);
  }

  function skipCurrent(detail?: string) {
    if (!current) return;
    advance({
      invoiceId: current.id,
      invoiceNumber: current.invoiceNumber,
      status: "skipped",
      ...(detail ? { detail } : {}),
    });
  }

  const linkMutation = useMutation({
    mutationFn: () => {
      if (!caseId || !remakeSelected) {
        return Promise.reject(new Error("Select the original case being remade."));
      }
      return apiFetch<{ caseId: string; caseNumber: string }>(
        `/cases/${caseId}/mark-as-remake`,
        {
          method: "PATCH",
          body: JSON.stringify(buildRemakeLinkPayload(remakeSelected, questionnaire)),
        },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["case-number-for-invoice", caseId] });
      queryClient.invalidateQueries({ queryKey: ["case-remake-chain", caseId] });
      queryClient.invalidateQueries({ queryKey: ["case", caseId] });
      if (current) {
        queryClient.invalidateQueries({ queryKey: ["invoice", current.id] });
        advance({
          invoiceId: current.id,
          invoiceNumber: current.invoiceNumber,
          status: "linked",
        });
      }
    },
    onError: (err: Error) => {
      setSubmitError(err.message || "Could not mark this case as a remake.");
    },
  });

  const closeWizard = () => {
    if (!linkMutation.isPending) onClose(linkedCount > 0);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={closeWizard} />
      <div className="relative z-10 w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-card border border-border shadow-2xl p-6 mx-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <GitBranch size={15} className="text-muted-foreground" />
            {finished
              ? "Mark as remakes — done"
              : `Mark as remakes (${index + 1} of ${invoices.length})`}
          </h2>
          <button
            type="button"
            onClick={closeWizard}
            disabled={linkMutation.isPending}
            className="h-7 w-7 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground"
          >
            <X size={15} />
          </button>
        </div>

        {finished ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {linkedCount} of {invoices.length} invoice
              {invoices.length !== 1 ? "s" : ""} linked as remakes.
            </p>
            <ul className="max-h-64 overflow-y-auto rounded-md border border-border divide-y divide-border text-sm">
              {results.map((r) => (
                <li key={r.invoiceId} className="flex items-center gap-2 px-3 py-2">
                  {r.status === "linked" ? (
                    <CheckCircle2 size={14} className="text-success shrink-0" />
                  ) : (
                    <Ban size={14} className="text-muted-foreground shrink-0" />
                  )}
                  <span className="font-medium">{r.invoiceNumber}</span>
                  <span className="text-xs text-muted-foreground truncate">
                    {r.status === "linked"
                      ? "Marked as remake"
                      : r.detail || "Skipped"}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={closeWizard}
                className="h-8 px-4 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-3 rounded-md bg-secondary/50 px-3 py-2 text-sm">
              <span className="font-medium">{current!.invoiceNumber}</span>
              {meta.patientName ? (
                <span className="text-muted-foreground"> — {meta.patientName}</span>
              ) : null}
              {current!.providerOrganization?.name ? (
                <span className="text-muted-foreground">
                  {" "}· {current!.providerOrganization.name}
                </span>
              ) : null}
              {linkedCase?.caseNumber ? (
                <span className="text-muted-foreground"> · Case #{linkedCase.caseNumber}</span>
              ) : null}
            </div>

            {!caseId ? (
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <AlertCircle size={14} className="text-warning shrink-0" />
                This invoice isn't linked to a case, so it can't be marked as a remake.
              </p>
            ) : linkedCaseQuery.isLoading ? (
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" /> Loading case…
              </p>
            ) : linkedCaseQuery.isError ? (
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <AlertCircle size={14} className="text-warning shrink-0" />
                Couldn't load the linked case for this invoice.
              </p>
            ) : alreadyRemake ? (
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <AlertCircle size={14} className="text-warning shrink-0" />
                Case #{linkedCase?.caseNumber} is already linked as a remake.
              </p>
            ) : (
              <RemakeOriginalPicker
                labOrganizationId={current!.labOrganizationId}
                selected={remakeSelected}
                onSelect={(hit) => {
                  setRemakeSelected(hit);
                  setSubmitError(null);
                }}
                onClear={() => {
                  setRemakeSelected(null);
                  setQuestionnaire(blankQuestionnaire());
                }}
                questionnaire={questionnaire}
                onQuestionnaireChange={setQuestionnaire}
                isAdmin={isAdmin}
                excludeCaseId={caseId}
              />
            )}

            {submitError && (
              <p className="mt-3 text-sm text-destructive">{submitError}</p>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeWizard}
                disabled={linkMutation.isPending}
                className="h-8 px-4 rounded-md text-sm bg-secondary hover:bg-secondary/80 text-muted-foreground disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() =>
                  skipCurrent(
                    !caseId
                      ? "No linked case"
                      : alreadyRemake
                        ? "Already a remake"
                        : undefined,
                  )
                }
                disabled={linkMutation.isPending}
                className="h-8 px-4 rounded-md text-sm bg-secondary hover:bg-secondary/80 disabled:opacity-50"
              >
                Skip
              </button>
              <button
                type="button"
                onClick={() => linkMutation.mutate()}
                disabled={
                  linkMutation.isPending ||
                  !caseId ||
                  alreadyRemake ||
                  !remakeSelected ||
                  !isRemakeQuestionnaireComplete(questionnaire)
                }
                className="h-8 px-4 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {linkMutation.isPending && <Loader2 size={12} className="animate-spin" />}
                {linkMutation.isPending
                  ? "Saving…"
                  : index + 1 < invoices.length
                    ? "Mark & next"
                    : "Mark as remake"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function BulkInvoiceConfirmModal({
  kind,
  count,
  targetStatusLabel,
  pending,
  error,
  feedback,
  onCancel,
  onConfirm,
}: {
  kind: "delete_selected" | "reset_selected" | "reset_all" | "status_change";
  count: number;
  targetStatusLabel?: string | null;
  pending: boolean;
  error: string | null;
  feedback: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isDelete = kind === "delete_selected";
  const isResetAll = kind === "reset_all";
  const isStatus = kind === "status_change";
  const statusName = targetStatusLabel ?? "the selected status";
  const title = isDelete
    ? `Delete ${count} invoice${count !== 1 ? "s" : ""}?`
    : isResetAll
    ? "Reset all invoices to $0?"
    : isStatus
    ? `Mark ${count} invoice${count !== 1 ? "s" : ""} as ${statusName}?`
    : `Reset ${count} invoice${count !== 1 ? "s" : ""} to $0?`;
  const description = isDelete
    ? `This will permanently void and hide ${count} invoice${count !== 1 ? "s" : ""}. They will no longer appear in the invoices list or statement rollups. This cannot be undone.`
    : isResetAll
    ? `This will zero out all invoice totals and line items across every practice. Invoices will show $0.00 total and $0.00 balance due. This cannot be undone.`
    : isStatus
    ? `This will change the status of ${count} selected invoice${count !== 1 ? "s" : ""} to ${statusName}. Frozen invoices will be skipped.`
    : `This will zero out the totals and line items for ${count} selected invoice${count !== 1 ? "s" : ""}. Each will show $0.00 total and $0.00 balance due. This cannot be undone.`;

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
        {error && (
          <p className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">{error}</p>
        )}
        {feedback && !error && (
          <p className="text-sm text-warning bg-warning/10 rounded-md px-3 py-2" data-testid="bulk-invoice-feedback">{feedback}</p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary disabled:opacity-50"
          >
            {feedback ? "Close" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className={`h-9 px-3 rounded-md text-sm font-medium text-white disabled:opacity-50 ${isDelete ? "bg-destructive hover:bg-destructive/90" : isStatus ? "bg-primary hover:bg-primary/90" : "bg-warning hover:bg-warning/90"}`}
          >
            {pending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : isDelete ? (
              "Delete invoices"
            ) : isStatus ? (
              `Mark as ${statusName}`
            ) : (
              "Reset to $0"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function BulkSendDialog({
  invoices,
  onClose,
  onSent,
}: {
  invoices: Invoice[];
  onClose: () => void;
  onSent: () => void;
}) {
  const { user } = useAuth();
  const [subject, setSubject] = useState("Your invoice from our lab");
  const [message, setMessage] = useState(
    "Hi,\n\nPlease find your invoice(s) attached.\n\nThank you,",
  );
  const [phase, setPhase] = useState<"compose" | "sending" | "done">("compose");
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<{ invoiceNumber: string; status: "sent" | "failed"; error?: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { template: invoiceTemplate, extraImageDataUrls } = useInvoiceTemplate(
    user?.practiceOrganizationId ?? null,
  );
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  useEffect(() => {
    const logoUrl = user?.practiceLogoUrl;
    if (!logoUrl) return;
    fetch(logoUrl)
      .then((r) => r.blob())
      .then((blob) => {
        const reader = new FileReader();
        reader.onload = () => setLogoDataUrl(reader.result as string);
        reader.readAsDataURL(blob);
      })
      .catch(() => {});
  }, [user?.practiceLogoUrl]);

  function buildOptions(inv: Invoice): InvoicePdfOptions {
    const meta: InvoiceDisplayMetadata = inv.displayMetadata ?? inv.displayMetadataJson ?? {};
    return {
      invoiceNumber: inv.invoiceNumber,
      labName: inv.labOrganization?.name ?? "",
      practiceName: inv.providerOrganization?.name ?? "",
      patientName: meta.patientName ?? null,
      billTo: meta.billTo ?? null,
      teeth: meta.teeth ?? null,
      shade: meta.shade ?? null,
      material: meta.material ?? null,
      caseNotes: meta.caseNotes ?? null,
      issuedAt: inv.issuedAt ?? null,
      dueAt: inv.dueAt ?? inv.dueDate ?? null,
      status: (inv.status ?? "").replace(/_/g, " "),
      items: (inv.items ?? []).map((it) => ({
        item: null,
        toothNumber: it.toothNumber ?? null,
        toothLabel: it.toothLabel ?? null,
        description: it.description,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        lineTotal: Number(it.quantity ?? 0) * Number(it.unitPrice ?? 0),
        subItems: (it.subItems ?? []).map((sub) => ({
          item: null,
          toothNumber: sub.toothNumber ?? null,
          description: sub.description,
          quantity: sub.quantity,
          unitPrice: sub.unitPrice,
          lineTotal: Number(sub.quantity ?? 0) * Number(sub.unitPrice ?? 0),
        })),
      })),
      subtotal: inv.subtotal ?? 0,
      tax: inv.tax ?? null,
      discount: inv.discount ?? null,
      credits: meta.credits ?? null,
      total: inv.total ?? 0,
      balanceDue: inv.balanceDue ?? inv.total ?? 0,
      notes: inv.notes ?? null,
      generatedAt: new Date(),
      logoUrl: logoDataUrl,
      template: invoiceTemplate,
      extraImageDataUrls,
    };
  }

  async function handleSend() {
    setError(null);
    setPhase("sending");
    setProgress(0);
    const items: Array<{ invoiceId: string; subject: string; message: string; filename: string; pdfBase64: string }> = [];
    const partial: typeof results = [];
    for (let idx = 0; idx < invoices.length; idx++) {
      const inv = invoices[idx];
      setProgress(idx + 1);
      try {
        const built = buildInvoicePdf(buildOptions(inv));
        items.push({
          invoiceId: inv.id,
          subject: subject.trim(),
          message,
          filename: built.filename,
          pdfBase64: built.base64,
        });
        partial.push({ invoiceNumber: inv.invoiceNumber, status: "sent" });
      } catch (e) {
        partial.push({ invoiceNumber: inv.invoiceNumber, status: "failed", error: (e as Error)?.message || "PDF generation failed" });
      }
    }
    if (items.length > 0) {
      try {
        await apiFetch("/invoices/batch-email", {
          method: "POST",
          body: JSON.stringify({ items }),
        });
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : (e as Error)?.message || "Failed to send";
        setError(msg);
        setPhase("done");
        setResults(partial.map((r) => r.status === "sent" ? { ...r, status: "failed" as const, error: msg } : r));
        return;
      }
    }
    setResults(partial);
    setPhase("done");
  }

  const sentCount = results.filter((r) => r.status === "sent").length;
  const failedCount = results.filter((r) => r.status === "failed").length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-foreground/40">
      <div className="w-full max-w-lg bg-card border border-border rounded-xl shadow-xl flex flex-col max-h-[90vh]">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Bulk email</div>
            <div className="text-sm font-semibold">
              {invoices.length} invoice{invoices.length !== 1 ? "s" : ""}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {phase === "compose" && (
            <>
              <div className="text-xs text-muted-foreground bg-secondary/50 rounded-md px-3 py-2 space-y-0.5">
                {invoices.slice(0, 5).map((inv) => (
                  <div key={inv.id} className="font-mono">{inv.invoiceNumber} — {inv.providerOrganization?.name ?? "—"}</div>
                ))}
                {invoices.length > 5 && <div className="text-muted-foreground">…and {invoices.length - 5} more</div>}
              </div>
              <p className="text-xs text-muted-foreground">
                Each invoice PDF will be generated and sent to the billing email on file for that practice. Invoices without a billing email will be skipped.
              </p>
              <div>
                <label className="block text-xs font-medium mb-1">Subject</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full h-9 px-3 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Message</label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={5}
                  className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                />
              </div>
            </>
          )}

          {phase === "sending" && (
            <div className="flex flex-col items-center justify-center py-8 gap-3 text-sm text-muted-foreground">
              <Loader2 size={24} className="animate-spin text-primary" />
              <p>Building PDF {progress} of {invoices.length}…</p>
            </div>
          )}

          {phase === "done" && (
            <div className="space-y-3">
              <div className={`flex items-center gap-2 text-sm font-medium ${failedCount === 0 ? "text-emerald-600" : "text-amber-600"}`}>
                {failedCount === 0
                  ? <><CheckCircle2 size={15} /> {sentCount} invoice{sentCount !== 1 ? "s" : ""} sent successfully</>
                  : <><AlertCircle size={15} /> {sentCount} sent, {failedCount} failed</>}
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <ul className="space-y-1 text-xs max-h-48 overflow-y-auto">
                {results.map((r) => (
                  <li key={r.invoiceNumber} className={`flex items-center gap-2 ${r.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
                    {r.status === "sent" ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
                    <span className="font-mono">{r.invoiceNumber}</span>
                    {r.error && <span className="truncate">{r.error}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          {phase === "done" ? (
            <button
              type="button"
              onClick={sentCount > 0 ? onSent : onClose}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
            >
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={phase === "sending"}
                className="px-4 py-2 rounded-md border border-border text-sm hover:bg-secondary disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={phase === "sending" || !subject.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                <Send size={14} /> Send {invoices.length} invoice{invoices.length !== 1 ? "s" : ""}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

// Serialize the editable invoice form fields into a stable string so we can
// detect whether the user has made unsaved edits (dirty check). Only fields
// that the Save action actually persists are included; provider reassignment
// is saved independently and is intentionally excluded.
function serializeInvoiceForm(f: {
  providerId?: string;
  invoiceNumber: string;
  statusValue: string;
  issuedAt: string;
  dueAt: string;
  tax: number;
  discount: number;
  credits: number;
  notes: string;
  patientName: string;
  billTo: string;
  teeth: string;
  shade: string;
  material: string;
  caseNotes: string;
  layoutPresetId: string | null;
  items: DraftLine[];
}): string {
  return JSON.stringify({
    providerId: f.providerId,
    invoiceNumber: f.invoiceNumber,
    statusValue: f.statusValue,
    issuedAt: f.issuedAt,
    dueAt: f.dueAt,
    tax: Number(f.tax || 0),
    discount: Number(f.discount || 0),
    credits: Number(f.credits || 0),
    notes: f.notes,
    patientName: f.patientName,
    billTo: f.billTo,
    teeth: f.teeth,
    shade: f.shade,
    material: f.material,
    caseNotes: f.caseNotes,
    layoutPresetId: f.layoutPresetId ?? null,
    items: f.items.map((it) => ({
      item: it.item,
      description: it.description,
      quantity: Number(it.quantity || 0),
      unitPrice: it.unitPrice,
      isDiscount: !!it.isDiscount,
      toothNumber: it.toothNumber ?? null,
      toothLabel: it.toothLabel ?? null,
      subItems: (it.subItems ?? []).map((sub) => ({
        item: sub.item,
        description: sub.description,
        quantity: Number(sub.quantity || 0),
        unitPrice: sub.unitPrice,
        toothNumber: sub.toothNumber ?? null,
        toothLabel: sub.toothLabel ?? null,
        isDiscount: !!sub.isDiscount,
      })),
    })),
  });
}

function RestoreCaseButton({
  caseId,
  onSuccess,
}: {
  caseId: string;
  onSuccess: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const restoreMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ restored: boolean }>(`/cases/${caseId}/restore`, {
        method: "POST",
      }),
    onSuccess: () => {
      setError(null);
      onSuccess();
    },
    onError: (err: unknown) => {
      const msg =
        err instanceof ApiError
          ? err.message
          : "Failed to restore case. Please try again.";
      setError(msg);
    },
  });
  return (
    <span className="inline-flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => restoreMutation.mutate()}
        disabled={restoreMutation.isPending}
        className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded border border-amber-500 hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-800 dark:text-amber-300 disabled:opacity-50"
      >
        {restoreMutation.isPending ? (
          <Loader2 size={11} className="animate-spin" />
        ) : (
          <RotateCcw size={11} />
        )}
        Restore case
      </button>
      {error && (
        <span className="text-xs text-destructive">{error}</span>
      )}
    </span>
  );
}

function nameToPriceKey(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return `custom_${slug || "item"}`;
}

interface CreateTierItemModalProps {
  labOrganizationId: string;
  onClose: () => void;
  onCreated: (item: { name: string; description: string; unitPrice: number }) => void;
}

function CreateTierItemModal({
  labOrganizationId,
  onClose,
  onCreated,
}: CreateTierItemModalProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [selectedTierId, setSelectedTierId] = useState<string>("all");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tiersQuery = useQuery({
    queryKey: ["pricing", "tiers", labOrganizationId],
    queryFn: () =>
      apiFetch<{ tiers: Array<{ id: string; name: string; prices: Record<string, number> }> }>(
        `/pricing/tiers?labOrganizationId=${encodeURIComponent(labOrganizationId)}`,
      ),
    enabled: !!labOrganizationId,
    staleTime: 30_000,
  });
  const tiers = tiersQuery.data?.tiers ?? [];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return setError("Item name is required.");
    const priceValue = Number(price);
    if (!Number.isFinite(priceValue) || priceValue <= 0)
      return setError("Price must be a positive number.");
    if (tiers.length === 0) return setError("No pricing tiers available.");

    const priceKey = nameToPriceKey(trimmedName);
    const targetTiers =
      selectedTierId === "all"
        ? tiers
        : tiers.filter((t) => t.id === selectedTierId);
    if (targetTiers.length === 0) return setError("Selected tier not found.");

    setSaving(true);
    setError(null);
    try {
      for (const tier of targetTiers) {
        const mergedPrices: Record<string, number> = { ...tier.prices, [priceKey]: priceValue };
        await apiFetch(`/pricing/tiers/${tier.id}`, {
          method: "PATCH",
          body: JSON.stringify({ prices: mergedPrices }),
        });
      }
      await apiFetch(`/pricing/item-labels`, {
        method: "PUT",
        body: JSON.stringify({
          labOrganizationId,
          labels: { [priceKey]: trimmedName },
        }),
      });
      queryClient.invalidateQueries({ queryKey: ["pricing", "tiers"] });
      queryClient.invalidateQueries({ queryKey: ["pricing"] });
      onCreated({
        name: trimmedName,
        description: description.trim() || trimmedName,
        unitPrice: priceValue,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create item.");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-[420px] max-w-[calc(100vw-2rem)]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2 font-semibold">
            <Layers size={16} className="text-primary" />
            Create new tier item
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground flex items-center justify-center"
          >
            <X size={15} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Item name <span className="text-destructive">*</span>
            </label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Rush fee"
              className="w-full h-9 px-3 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Invoice description{" "}
              <span className="text-muted-foreground/60">(optional)</span>
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Defaults to item name"
              className="w-full h-9 px-3 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Unit price <span className="text-destructive">*</span>
            </label>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              className="w-full h-9 px-3 rounded-md bg-background border border-input text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Add to pricing tier
            </label>
            {tiersQuery.isLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 size={13} className="animate-spin" /> Loading tiers…
              </div>
            ) : tiers.length === 0 ? (
              <div className="text-xs text-destructive">
                No pricing tiers found. Create one in Settings → Pricing first.
              </div>
            ) : (
              <select
                value={selectedTierId}
                onChange={(e) => setSelectedTierId(e.target.value)}
                className="w-full h-9 px-3 rounded-md bg-background border border-input text-sm"
              >
                <option value="all">All pricing tiers</option>
                {tiers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {error && (
            <div className="text-xs text-destructive bg-destructive/10 rounded-md px-3 py-2">
              {error}
            </div>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-4 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || tiersQuery.isLoading || tiers.length === 0}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
            >
              {saving && <Loader2 size={13} className="animate-spin" />}
              {saving ? "Saving…" : "Create & add to invoice"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function InvoiceEditor({
  invoice,
  doctorNames,
  onClose,
  onGoToCase,
}: {
  invoice: Invoice;
  doctorNames?: string[];
  onClose: () => void;
  onGoToCase?: () => void;
}) {
  return <InvoiceEditingSurface key={invoice.id} invoice={invoice} doctorNames={doctorNames} onClose={onClose} onGoToCase={onGoToCase} />;
}

export function InlineInvoiceEditor({
  invoice, doctorNames, onOpenEditor, onClose,
}: {
  invoice: Invoice;
  doctorNames?: string[];
  onOpenEditor: () => void;
  onClose: () => void;
}) {
  return <InvoiceEditingSurface key={invoice.id} invoice={invoice} doctorNames={doctorNames} onClose={onClose} inline onOpenEditor={onOpenEditor} />;
}

function InvoiceEditingSurface({
  invoice, doctorNames, onClose, onGoToCase, inline = false, onOpenEditor,
}: {
  invoice: Invoice;
  doctorNames?: string[];
  onClose: () => void;
  onGoToCase?: () => void;
  inline?: boolean;
  onOpenEditor?: () => void;
}) {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const isAdmin =
    user?.role === "owner" ||
    user?.role === "admin" ||
    user?.role === "billing";
  const canEditInline = isAdmin && user?.userType !== "provider";
  // POST /cases/:caseId/restore requires ADMIN_ROLES (owner | admin), not billing
  const canRestoreCase = user?.role === "owner" || user?.role === "admin";
  const isAdminOrOwner = user?.role === "owner" || user?.role === "admin";

  const {
    widths: colWidths,
    resizingCol,
    startResize,
    resetColumn,
    fitColumn,
    resetAll: resetAllColWidths,
  } = useColumnWidths(INVOICE_COLUMN_DEFAULTS, user?.id);

  const {
    panelWidth,
    isMaximized: invoicePanelIsMaximized,
    toggleMaximized: toggleInvoicePanelMaximized,
    onResizeMouseDown,
  } = useInvoicePanelSize();
  const lineItemsTableRef = useRef<HTMLTableElement>(null);
  const lineItemsTableContainerRef = useRef<HTMLDivElement>(null);
  const [lineItemsContainerWidth, setLineItemsContainerWidth] = useState(0);
  useEffect(() => {
    const container = lineItemsTableContainerRef.current;
    if (!container) return;
    const measure = () => setLineItemsContainerWidth(container.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const fittedColumnWidths = useMemo(
    () =>
      fitInvoiceLineItemColumns(
        colWidths,
        lineItemsContainerWidth ||
          colWidths.reduce((total, width) => total + width, 0) +
            INVOICE_LINE_ITEM_ACTION_COLUMN_WIDTH,
      ),
    [colWidths, lineItemsContainerWidth],
  );
  const fittedTableWidth =
    fittedColumnWidths.reduce((total, width) => total + width, 0) +
    INVOICE_LINE_ITEM_ACTION_COLUMN_WIDTH;

  // Layout preset selection (per-invoice override of the lab's default template).
  const [layoutPresetId, setLayoutPresetId] = useState<string | null>(
    invoice.layoutPresetId ?? null,
  );
  const presetsQuery = useQuery({
    queryKey: ["invoice-template-presets", invoice.labOrganizationId],
    queryFn: () =>
      apiFetch<{ presets: Array<{ id: string; name: string; template: unknown; savedAt: string }> }>(
        `/organizations/${invoice.labOrganizationId}/invoice-template/presets`,
      ),
    staleTime: 60_000,
  });
  const availablePresets = presetsQuery.data?.presets ?? [];

  // Use the selected preset's template if one is picked and still exists;
  // fall back to the lab-default template from the /me payload.
  const selectedPresetTemplate =
    layoutPresetId != null
      ? (availablePresets.find((p) => p.id === layoutPresetId)?.template ?? null)
      : null;

  // Per-lab visual invoice template + preloaded extra-image data URLs.
  // Passes the preset template when one is selected so extra images in the
  // preset are preloaded the same way as the lab-default template.
  const { template: invoiceTemplate, extraImageDataUrls } = useInvoiceTemplate(
    selectedPresetTemplate ?? user?.practiceInvoiceTemplate,
  );


  // Pre-fetch lab logo as a data-URL for invoice PDFs (only when placement is active)
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const invoicePlacementActive = !!(user?.practiceLogoplacements?.includes("invoices"));
  useEffect(() => {
    const logoUrl = user?.practiceLogoUrl;
    if (!invoicePlacementActive || !logoUrl) {
      setLogoDataUrl(null);
      return;
    }
    let cancelled = false;
    fetch(logoUrl)
      .then((r) => r.blob())
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          }),
      )
      .then((dataUrl) => {
        if (!cancelled) setLogoDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setLogoDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [invoicePlacementActive, user?.practiceLogoUrl]);

  const detailQuery = useQuery({
    queryKey: ["invoice", invoice.id],
    queryFn: () => apiFetch<Invoice>(`/invoices/${invoice.id}`),
  });

  // When the parent page hasn't supplied a list (doctorNames === undefined),
  // read from the React Query cache that InvoicesPage populates via its own
  // query. Using getQueryData() (non-reactive) avoids creating an extra
  // observer that can interfere with detailQuery timing.
  const editorDoctorNames = useMemo(() => {
    if (doctorNames !== undefined) return doctorNames;
    return queryClient.getQueryData<string[]>(["case-doctor-names"]) ?? [];
  }, [doctorNames, queryClient]);

  const practicesQuery = useQuery({
    queryKey: ["organizations", "includeLabPractices"],
    queryFn: () =>
      apiFetch<Organization[]>("/organizations?includeLabPractices=true"),
    enabled: isAdmin,
    staleTime: 60_000,
  });
  const practices = useMemo(
    () =>
      (practicesQuery.data ?? []).filter(
        (o) =>
          (o.type === "provider" || o.type === "practice") &&
          !o.deletedAt &&
          (o.parentLabOrganizationId === invoice.labOrganizationId ||
            o.id === invoice.providerOrganizationId),
      ),
    [practicesQuery.data, invoice.labOrganizationId, invoice.providerOrganizationId],
  );

  // Per-doctor priced item catalog used by the "Item" dropdown so
  // picking "Zirconia Crown" auto-fills its description and the
  // doctor-specific unit price. Only loaded for invoices linked to a
  // case (caseId is required by the server endpoint).
  const caseIdForPricing =
    detailQuery.data?.caseId ?? invoice.caseId ?? null;

  // Fetch the linked case to get its canonical caseNumber for the QR URL.
  // Declared after caseIdForPricing so the query key is known at render time.
  const linkedCaseQuery = useQuery({
    queryKey: ["case-number-for-invoice", caseIdForPricing],
    queryFn: () =>
      apiFetch<LabCase & { restorations?: CaseRestoration[]; caseNotes?: string | null }>(
        `/cases/${caseIdForPricing}`,
      ),
    enabled: !!caseIdForPricing,
    staleTime: 300_000,
  });
  const linkedCase = linkedCaseQuery.data ?? null;
  const linkedCaseNumber = linkedCase?.caseNumber ?? null;

  // Only fetched once the linked case is known to be a remake, to show which
  // original it remakes without a second bespoke lookup — reuses the same
  // chain endpoint the case-detail "Remake history" timeline already relies on.
  const remakeChainQuery = useQuery({
    queryKey: ["case-remake-chain", caseIdForPricing],
    queryFn: () =>
      apiFetch<{
        chain: Array<{
          id: string;
          caseNumber: string;
          status: string | null;
          remakeReason: string | null;
          remakeCharged: boolean | null;
        }>;
      }>(`/cases/${caseIdForPricing}/remake-chain`),
    enabled: !!caseIdForPricing && !!linkedCase?.remakeOfCaseId,
    staleTime: 60_000,
  });
  const remakeOriginal =
    remakeChainQuery.data?.chain.find((c) => c.id === linkedCase?.remakeOfCaseId) ?? null;

  const linkedRxSummary = useMemo(
    () => deriveRxSummary(linkedCase?.restorations),
    [linkedCase?.restorations],
  );
  const linkedRxTeethLabel = useMemo(
    () =>
      formatRxTeethWithShades(
        linkedCase?.restorations,
        formatRxTeethLabel(linkedRxSummary),
      ),
    [linkedCase?.restorations, linkedRxSummary],
  );

  // Pre-generate a QR code data URL for the invoice PDF. The QR encodes the
  // case deep-link URL so recipients can scan to open the case in LabTrax.
  // Uses the linked case's caseNumber so the URL resolves correctly even when
  // the invoice number diverges from the case number.
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  useEffect(() => {
    const caseNum = linkedCaseNumber ?? invoice.invoiceNumber;
    if (!caseNum) {
      setQrCodeDataUrl(null);
      return;
    }
    const qrUrl = `${window.location.origin}/cases/${encodeURIComponent(caseNum)}`;
    let cancelled = false;
    QRCodeLib.toDataURL(qrUrl, { margin: 1, width: 120 })
      .then((dataUrl) => {
        if (!cancelled) setQrCodeDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrCodeDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [linkedCaseNumber, invoice.invoiceNumber]);

  const pricedItemsQuery = useQuery({
    queryKey: ["pricing-resolve-items", caseIdForPricing],
    queryFn: () =>
      apiFetch<{
        items: Array<{
          key: string;
          label: string;
          unitPrice: number;
          source: string | null;
          sourceName: string | null;
        }>;
      }>(`/pricing/resolve-items?caseId=${encodeURIComponent(caseIdForPricing!)}`),
    enabled: !!caseIdForPricing,
  });
  const pricedItems = pricedItemsQuery.data?.items ?? [];

  const discountItemsQuery = useQuery({
    queryKey: [
      "pricing-discount-items",
      invoice.labOrganizationId,
      caseIdForPricing ?? null,
    ],
    queryFn: () =>
      apiFetch<{
        items: Array<{ key: string; label: string; unitPrice: number; isDiscount: true }>;
      }>(
        `/pricing/discount-items?labOrganizationId=${encodeURIComponent(invoice.labOrganizationId)}${
          caseIdForPricing ? `&caseId=${encodeURIComponent(caseIdForPricing)}` : ""
        }`,
      ),
    enabled: !!invoice.labOrganizationId,
    staleTime: 60_000,
  });
  const discountItems = discountItemsQuery.data?.items ?? [];

  const billableItemsQuery = useQuery({
    queryKey: ["finance", "vendors", invoice.labOrganizationId, "items"],
    queryFn: () =>
      apiFetch<
        Array<{
          id: string;
          name: string;
          unitPrice: string | null;
          priceKey?: string | null;
        }>
      >(
        `/finance/vendors?organizationId=${encodeURIComponent(invoice.labOrganizationId)}&vendorType=item`,
      ),
    enabled: !!invoice.labOrganizationId,
    staleTime: 60_000,
  });
  const billableItems = billableItemsQuery.data ?? [];

  // Unified options: case-priced charges, custom charges, then explicit
  // discount items. Charge and discount names are deduped separately.
  const itemOptions = useMemo<ItemComboboxOption[]>(() => {
    const seen = new Set<string>();
    const discountPriceKeys = new Set(discountItems.map((item) => item.key));
    const opts: ItemComboboxOption[] = [];
    for (const p of pricedItems) {
      const key = `charge:${p.label.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      opts.push({
        key: `p:${p.key}`,
        name: p.label,
        unitPrice: p.unitPrice,
        group: "catalog",
      });
    }
    for (const b of billableItems) {
      if (b.priceKey && discountPriceKeys.has(b.priceKey)) continue;
      const key = `charge:${b.name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      opts.push({
        key: `b:${b.id}`,
        name: b.name,
        unitPrice: b.unitPrice != null ? Number(b.unitPrice) : null,
        group: "custom",
      });
    }
    for (const item of discountItems) {
      const key = `discount:${item.label.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      opts.push({
        key: `d:${item.key}`,
        name: item.label,
        unitPrice: item.unitPrice,
        group: "custom",
        isDiscount: true,
      });
    }
    return opts;
  }, [pricedItems, billableItems, discountItems]);

  const caseAttachmentsQuery = useQuery({
    queryKey: ["case-attachments-for-invoice", caseIdForPricing],
    queryFn: () =>
      apiFetch<{ attachments: CaseAttachment[] }>(
        `/cases/${caseIdForPricing}/attachments`,
      ).then((r) => r.attachments),
    enabled: !!caseIdForPricing,
  });
  const rxAttachments = caseAttachmentsQuery.data ?? [];
  const [prescriptionPreviewOpen, setPrescriptionPreviewOpen] = useState(false);

  async function openAttachmentFile(att: CaseAttachment) {
    const url = `${getApiOrigin()}/api/cases/${att.caseId}/attachments/${att.id}/file`;
    const token = getAccessToken();
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) { window.alert("Could not open file."); return; }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl; a.target = "_blank"; a.rel = "noreferrer";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
  }

  const [invoiceNumber, setInvoiceNumber] = useState(invoice.invoiceNumber);
  const [statusValue, setStatusValue] = useState<string>(
    EDITABLE_STATUSES.includes(invoice.status as (typeof EDITABLE_STATUSES)[number])
      ? invoice.status
      : "open",
  );
  const [providerId, setProviderId] = useState(invoice.providerOrganizationId);
  const [reassignConfirm, setReassignConfirm] = useState<{
    targetId: string;
    targetName: string;
  } | null>(null);
  const [issuedAt, setIssuedAt] = useState<string>(invoiceTimestampToDateInput(invoice.issuedAt));
  const [dueAt, setDueAt] = useState<string>(
    invoiceTimestampToDateInput(invoice.dueAt ?? invoice.dueDate),
  );
  const [dateRepairOpen, setDateRepairOpen] = useState(false);
  const [repairIssuedAt, setRepairIssuedAt] = useState(
    invoiceTimestampToDateInput(invoice.issuedAt),
  );
  const [repairDueAt, setRepairDueAt] = useState(
    invoiceTimestampToDateInput(invoice.dueAt ?? invoice.dueDate),
  );
  const [tax, setTax] = useState<number>(0);
  const [discount, setDiscount] = useState<number>(0);
  const [items, setItems] = useState<DraftLine[]>([]);
  const [notes, setNotes] = useState<string>("");
  const [patientName, setPatientName] = useState<string>("");
  const [billTo, setBillTo] = useState<string>("");
  const [teeth, setTeeth] = useState<string>("");
  const [shade, setShade] = useState<string>("");
  const [material, setMaterial] = useState<string>("");
  const [caseNotes, setCaseNotes] = useState<string>("");
  const [credits, setCredits] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  // Baseline snapshot of the form (set when detail loads) for the dirty check.
  const baselineRef = useRef<string | null>(null);
  const draftDirtyRef = useRef(false);
  const [resetVersion, setResetVersion] = useState(0);
  const [savedAwaitingRefresh, setSavedAwaitingRefresh] = useState(false);
  // When unsaved edits would be lost (close, route navigation, etc.) we stash
  // the action to run if the user confirms; a non-null value shows the
  // "Discard changes?" confirmation.
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(
    null,
  );

  useEffect(() => {
    const d = detailQuery.data;
    if (!d) return;
    // Guard: reject stale cache entries keyed to a different invoice.
    if (d.id !== invoice.id) return;
    if (draftDirtyRef.current) return;
    setSavedAwaitingRefresh(false);
    const nextStatus = EDITABLE_STATUSES.includes(
      d.status as (typeof EDITABLE_STATUSES)[number],
    )
      ? d.status
      : "open";
    const nextIssuedAt = invoiceTimestampToDateInput(d.issuedAt);
    const nextDueAt = invoiceTimestampToDateInput(d.dueAt ?? d.dueDate);
    const nextTax = Number(d.tax ?? 0);
    const nextDiscount = Number(d.discount ?? 0);
    const nextNotes = d.notes ?? "";
    const meta = readDisplayMetadata(d);
    const nextPatientName = meta.patientName ?? "";
    const nextBillTo = meta.billTo ?? "";
    const nextTeeth = meta.teeth ?? "";
    const nextShade = meta.shade ?? "";
    const nextMaterial = meta.material ?? "";
    const nextCaseNotes = meta.caseNotes ?? "";
    const nextCredits = Number(meta.credits ?? 0) || 0;
    const nextLayoutPresetId = (d as any).layoutPresetId ?? null;
    const metaItems = Array.isArray(meta.lineItems) ? meta.lineItems : [];
    const nextItems: DraftLine[] = (d.items ?? []).map(
      (it: InvoiceLineItem, idx: number) => ({
        id: it.id,
        displayMetadata: { ...(metaItems[idx] ?? {}) },
        item: metaItems[idx]?.item ?? "",
        description: it.description,
        quantity: Number(it.quantity ?? 0),
        unitPrice: String(
          it.isDiscount ? Math.abs(Number(it.unitPrice ?? 0)) : it.unitPrice ?? "",
        ),
        isDiscount: !!it.isDiscount,
        toothNumber: (it as any).toothNumber ?? null,
        toothLabel: (it as any).toothLabel ?? null,
        catalogItemKey: (metaItems[idx] as any)?.catalogItemKey ?? null,
        missingCatalogItem: (metaItems[idx] as any)?.missingCatalogItem ?? false,
        subItems: ((it as any).subItems ?? []).map((sub: any, sidx: number) => ({
          id: sub.id,
          displayMetadata: { ...((metaItems[idx]?.subItems as Record<string, unknown>[] | undefined)?.[sidx] ?? {}) },
          item: (metaItems[idx]?.subItems as any[])?.[sidx]?.item ?? "",
          description: sub.description,
          quantity: Number(sub.quantity ?? 0),
          unitPrice: String(sub.unitPrice ?? ""),
          toothNumber: sub.toothNumber ?? null,
          toothLabel: sub.toothLabel ?? null,
          isDiscount: !!sub.isDiscount,
          priced: sub.priced,
        })),
      }),
    );
    setInvoiceNumber(d.invoiceNumber);
    setStatusValue(nextStatus);
    setProviderId(d.providerOrganizationId);
    setIssuedAt(nextIssuedAt);
    setDueAt(nextDueAt);
    setTax(nextTax);
    setDiscount(nextDiscount);
    setNotes(nextNotes);
    setPatientName(nextPatientName);
    setBillTo(nextBillTo);
    setTeeth(nextTeeth);
    setShade(nextShade);
    setMaterial(nextMaterial);
    setCaseNotes(nextCaseNotes);
    setCredits(nextCredits);
    setLayoutPresetId(nextLayoutPresetId);
    setItems(nextItems);
    // Record the loaded state as the dirty-check baseline.
    baselineRef.current = serializeInvoiceForm({
      providerId: inline ? d.providerOrganizationId : undefined,
      invoiceNumber: d.invoiceNumber,
      statusValue: nextStatus,
      issuedAt: nextIssuedAt,
      dueAt: nextDueAt,
      tax: nextTax,
      discount: nextDiscount,
      credits: nextCredits,
      notes: nextNotes,
      patientName: nextPatientName,
      billTo: nextBillTo,
      teeth: nextTeeth,
      shade: nextShade,
      material: nextMaterial,
      caseNotes: nextCaseNotes,
      layoutPresetId: nextLayoutPresetId,
      items: nextItems,
    });
  }, [detailQuery.data, invoice.id, inline, resetVersion]);

  const subtotal = useMemo(
    () =>
      items.reduce((sum, it) => {
        const lineMagnitude = Number(it.quantity || 0) * Number(it.unitPrice || 0);
        const lineAmt = it.isDiscount ? -Math.abs(lineMagnitude) : lineMagnitude;
        const subAmt = (it.subItems ?? []).reduce(
          (s, sub) => s + Number(sub.quantity || 0) * Number(sub.unitPrice || 0),
          0,
        );
        return sum + lineAmt + subAmt;
      }, 0),
    [items],
  );
  /** True when any sub-item still carries priced===false (alloy not yet quoted). */
  const hasUnpricedLines = useMemo(
    () =>
      items.some((it) =>
        (it.subItems ?? []).some((sub) => sub.priced === false),
      ),
    [items],
  );

  // Credits behave like a discount applied to the invoice (e.g. a
  // patient/practice deposit or store credit). They reduce the final
  // total just like the Discount field, and are shown as their own
  // line in the totals footer so the user can see exactly how the
  // total was computed.
  const total =
    subtotal +
    Number(tax || 0) -
    Number(discount || 0) -
    Number(credits || 0);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (savedAwaitingRefresh) throw new Error("This invoice was saved. Reload its confirmed data before editing again.");
      if (inline && !canEditInline) throw new Error("You do not have permission to edit invoices.");
      if ((detailQuery.data ?? invoice).frozen) throw new Error("Invoice is frozen — billing edits are not allowed.");
      if (!invoiceNumber.trim()) {
        throw new Error("Invoice number is required.");
      }
      // Safety guard: if React Query somehow served a stale entry for a
      // different invoice, refuse to save rather than corrupt the wrong record.
      if (detailQuery.data != null && detailQuery.data.id !== invoice.id) {
        throw new Error(
          "Invoice data mismatch — please close and reopen this invoice.",
        );
      }
      if (detailQuery.isLoading || !baselineRef.current) throw new Error("Wait for the invoice to finish loading.");
      const trimmedItems = items.map((it) => ({
        ...it,
        item: it.item.trim(),
        description: it.description.trim(),
        subItems: (it.subItems ?? []).map((sub) => ({
          ...sub,
          item: sub.item.trim(),
          description: sub.description.trim(),
        })),
      }));
      if (
        trimmedItems.some(
          (it) =>
            !it.description ||
            (it.subItems ?? []).some((sub) => !sub.description),
        )
      ) {
        throw new Error("Each line item needs a description.");
      }
      const invalidDiscountAmount = trimmedItems.some(
        (it) => it.isDiscount && Number(it.unitPrice) <= 0,
      );
      if (invalidDiscountAmount) {
        throw new Error("Discount amounts must be greater than 0.");
      }
      const invalidPrice = trimmedItems.some((it) => {
        const values = [it.unitPrice, ...(it.subItems ?? []).map((sub) => sub.unitPrice)];
        return values.some((value) => value.trim() === "" || !Number.isFinite(Number(value)) || Number(value) < 0);
      });
      if (invalidPrice) {
        throw new Error("Each line item needs a valid price. Enter 0 for a no-charge item.");
      }
      const existingMeta = readDisplayMetadata(detailQuery.data) as Record<
        string,
        unknown
      >;
      const displayMetadata: Record<string, unknown> = {
        ...existingMeta,
        reviewedCharges: true,
        reviewedChargesNeedsReview: false,
        ...(existingMeta.legacyChargesNeedsReview === true ? { legacyChargesNeedsReview: false } : {}),
        patientName: patientName.trim(),
        billTo: billTo.trim(),
        teeth: teeth.trim(),
        shade: shade.trim(),
        material: material.trim(),
        caseNotes: caseNotes.trim(),
        credits: Number(credits) || 0,
        lineItems: trimmedItems.map((it) => ({
          ...it.displayMetadata,
          item: it.item,
          description: it.description,
          catalogItemKey: it.catalogItemKey ?? null,
          missingCatalogItem: !!it.missingCatalogItem,
          subItems: (it.subItems ?? []).map((sub) => ({
            ...sub.displayMetadata,
            item: sub.item,
            description: sub.description,
          })),
        })),
      };
      const payload: Record<string, unknown> = {
        ...(inline ? { providerOrganizationId: providerId } : {}),
        status: statusValue,
        invoiceNumber: invoiceNumber.trim(),
        tax,
        discount,
        notes: notes.trim() ? notes.trim() : null,
        displayMetadata,
        layoutPresetId: layoutPresetId ?? null,
        items: trimmedItems.map((it, idx) => ({
          ...(it.id ? { id: it.id } : {}),
          toothNumber: it.toothNumber ?? null,
          toothLabel: it.toothLabel ?? null,
          description: it.description,
          quantity: it.quantity,
          unitPrice: it.isDiscount
            ? -Math.abs(Number(it.unitPrice))
            : Number(it.unitPrice),
          isDiscount: !!it.isDiscount,
          sortOrder: idx,
          subItems: (it.subItems ?? []).map((sub, sidx) => ({
            ...(sub.id ? { id: sub.id } : {}),
            toothNumber: sub.toothNumber ?? null,
            toothLabel: sub.toothLabel ?? null,
            isDiscount: !!sub.isDiscount,
            description: sub.description,
            quantity: sub.quantity,
            unitPrice: Number(sub.unitPrice),
            sortOrder: sidx,
          })),
        })),
      };
      const loadedInvoice = detailQuery.data ?? invoice;
      if (
        !isLikelyLegacyShiftedInvoiceDate(
          loadedInvoice.dueAt ?? loadedInvoice.dueDate,
          loadedInvoice.createdAt,
        )
      ) {
        payload.dueAt = invoiceDateInputToTimestamp(dueAt);
      }
      if (
        !isLikelyLegacyShiftedInvoiceDate(
          loadedInvoice.issuedAt,
          loadedInvoice.createdAt,
        )
      ) {
        payload.issuedAt = invoiceDateInputToTimestamp(issuedAt);
      }
      return apiFetch<Invoice>(`/invoices/${invoice.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: async () => {
      if (!inline) {
        void refreshInvoiceSalesQueries(queryClient, invoice.id, invoice.caseId);
        onClose();
        return;
      }
      // PATCH returns a header row, not the complete detail. Reload persisted
      // line IDs before enabling another edit (particularly for newly added rows).
      setSavedAwaitingRefresh(true);
      try {
        const confirmed = await apiFetch<Invoice>(`/invoices/${invoice.id}`);
        draftDirtyRef.current = false;
        baselineRef.current = null;
        setError(null);
        queryClient.setQueryData(["invoice", invoice.id], confirmed);
        setResetVersion((v) => v + 1);
      } catch {
        draftDirtyRef.current = false;
        baselineRef.current = null;
        setError("Invoice saved, but confirmed data could not be reloaded. Retry loading before making more edits.");
      }
      void refreshInvoiceSalesQueries(queryClient, invoice.id, invoice.caseId);
    },
    onError: (err: Error) => setError(err.message || "Save failed."),
  });

  const dateRepairMutation = useMutation({
    mutationFn: () =>
      apiFetch<Invoice>(`/invoices/${invoice.id}/repair-dates`, {
        method: "PATCH",
        body: JSON.stringify({
          issuedAt: invoiceDateInputToTimestamp(repairIssuedAt),
          dueAt: invoiceDateInputToTimestamp(repairDueAt),
        }),
      }),
    onSuccess: async (updated) => {
      draftDirtyRef.current = false;
      baselineRef.current = null;
      setIssuedAt(invoiceTimestampToDateInput(updated.issuedAt));
      setDueAt(invoiceTimestampToDateInput(updated.dueAt ?? updated.dueDate));
      setDateRepairOpen(false);
      await refreshInvoiceSalesQueries(queryClient, invoice.id, invoice.caseId);
      toast({ title: "Invoice dates repaired" });
    },
    onError: (err: Error) => setError(err.message || "Date repair failed."),
  });

  // Deletes all payment rows on this invoice before reverting its status to open.
  // Used by the Paid→Open payment-guard dialog ("Delete payment & mark Open").
  const deletePaymentsMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ deletedCount: number; invoice: Invoice }>(`/invoices/${invoice.id}/payments`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void refreshInvoiceSalesQueries(queryClient, invoice.id, invoice.caseId);
      setPaymentDeleteConfirm(false);
      saveMutation.mutate();
    },
    onError: (err: Error) => {
      setPaymentDeleteConfirm(false);
      setError(err.message || "Failed to delete payments.");
    },
  });

  /**
   * Pre-save gate that intercepts status transitions needing user input:
   *   • paid/partially_paid → open  when payments exist  → payment-delete guard
   *   • * → paid                    when no payments yet  → "record payment?" prompt
   * All other transitions fall through to saveMutation directly.
   */
  function handleSaveRequest() {
    setError(null);
    if (saveMutation.isPending || deletePaymentsMutation.isPending || savedAwaitingRefresh) return;
    if (pendingDiscard || reassignConfirm || dateRepairOpen) return;
    if (inline && !canEditInline) return;
    if ((detailQuery.data ?? invoice).frozen || detailQuery.isLoading || detailQuery.isError) return;

    const currentStatus = detailQuery.data?.status ?? invoice.status;
    const existingPayments = detailQuery.data?.payments ?? [];

    // Paid/PartiallyPaid → Open: warn if there are recorded payments.
    if (
      (currentStatus === "paid" || currentStatus === "partially_paid") &&
      statusValue === "open" &&
      existingPayments.length > 0
    ) {
      setPaymentDeleteConfirm(true);
      return;
    }

    // Any status → Paid: offer to record a payment if none exist yet.
    // Skip when the existing status is already paid (user just editing other fields).
    if (
      currentStatus !== "paid" &&
      statusValue === "paid" &&
      existingPayments.length === 0
    ) {
      setRecordPaymentPrompt(true);
      return;
    }

    saveMutation.mutate();
  }

  function updateItem(idx: number, patch: Partial<DraftLine>) {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }

  function removeItem(idx: number) {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }

  function moveItem(idx: number, dir: -1 | 1) {
    setItems((prev) => {
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  function addItem() {
    setItems((prev) => [
      ...prev,
      { item: "", description: "", quantity: 1, unitPrice: "" },
    ]);
  }

  function addDiscountLine() {
    setItems((prev) => [
      ...prev,
      {
        item: "",
        description: "",
        quantity: 1,
        unitPrice: "",
        isDiscount: true,
      },
    ]);
  }

  // Persist a brand-new billable item to the lab's custom billable items
  // (vendors, vendorType "item") so it shows up there and in future
  // typeaheads. Returns the created item (to select it) or null on failure.
  async function createBillableItem(
    name: string,
    price: number,
  ): Promise<{ name: string; unitPrice: number | null } | null> {
    const trimmed = name.trim();
    if (!trimmed || !invoice.labOrganizationId) return null;
    const unitPrice = price > 0 ? price : null;
    try {
      await apiFetch(`/finance/vendors`, {
        method: "POST",
        body: JSON.stringify({
          organizationId: invoice.labOrganizationId,
          name: trimmed,
          vendorType: "item",
          unitPrice: unitPrice != null ? unitPrice.toFixed(2) : null,
        }),
      });
      // Prefix-invalidate so both this editor's item list and the Lists page
      // (["finance","vendors",orgId,"items"|"all"]) refetch.
      await queryClient.invalidateQueries({
        queryKey: ["finance", "vendors", invoice.labOrganizationId],
      });
      return { name: trimmed, unitPrice };
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not add billable item.",
      );
      return null;
    }
  }

  function addSubItem(parentIdx: number) {
    setItems((prev) =>
      prev.map((it, i) =>
        i === parentIdx
          ? {
              ...it,
              subItems: [
                ...(it.subItems ?? []),
                { item: "", description: "", quantity: 1, unitPrice: "" },
              ],
            }
          : it,
      ),
    );
  }

  function removeSubItem(parentIdx: number, subIdx: number) {
    setItems((prev) =>
      prev.map((it, i) =>
        i === parentIdx
          ? { ...it, subItems: (it.subItems ?? []).filter((_, si) => si !== subIdx) }
          : it,
      ),
    );
  }

  function updateSubItem(parentIdx: number, subIdx: number, patch: Partial<DraftLine>) {
    setItems((prev) =>
      prev.map((it, i) =>
        i === parentIdx
          ? {
              ...it,
              subItems: (it.subItems ?? []).map((sub, si) =>
                si === subIdx ? { ...sub, ...patch } : sub,
              ),
            }
          : it,
      ),
    );
  }

  const reassignMutation = useMutation({
    mutationFn: (newProviderId: string) =>
      apiFetch<Invoice>(`/invoices/${invoice.id}`, {
        method: "PATCH",
        body: JSON.stringify({ providerOrganizationId: newProviderId }),
      }),
    onSuccess: (updated) => {
      setProviderId(updated.providerOrganizationId);
      setReassignConfirm(null);
      void refreshInvoiceSalesQueries(queryClient, invoice.id, invoice.caseId);
    },
    onError: (err: Error) => {
      setReassignConfirm(null);
      setError(err.message || "Reassignment failed.");
    },
  });

  const [emailOpen, setEmailOpen] = useState(false);
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [voidDialog, setVoidDialog] = useState<null | "void" | "writeoff">(null);
  // Paid→Open guard: shown when the invoice has recorded payments.
  const [paymentDeleteConfirm, setPaymentDeleteConfirm] = useState(false);
  // Open→Paid prompt: shown when the invoice is being marked paid with no existing payments.
  const [recordPaymentPrompt, setRecordPaymentPrompt] = useState(false);
  const [showAddLineMenu, setShowAddLineMenu] = useState(false);
  const [showCreateItemModal, setShowCreateItemModal] = useState(false);
  const addLineMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showAddLineMenu) return;
    function onDown(e: MouseEvent) {
      if (!addLineMenuRef.current?.contains(e.target as Node)) {
        setShowAddLineMenu(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showAddLineMenu]);

  // Local optimistic flag so the banner + button disappear the instant the
  // user clicks "Mark reviewed" — without waiting for the server round-trip
  // or the invoice query to refetch. The server still records the ack; if it
  // fails we roll back so the banner reappears.
  const [aiReviewedLocal, setAiReviewedLocal] = useState(false);
  const ackAiMutation = useMutation({
    mutationFn: () =>
      apiFetch<Invoice>(`/invoices/${invoice.id}/ai-review`, {
        method: "PATCH",
        body: JSON.stringify({ acknowledged: true }),
      }),
    onMutate: () => {
      setAiReviewedLocal(true);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoice", invoice.id] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (err: Error) => {
      setAiReviewedLocal(false);
      setError(err.message || "Could not mark reviewed.");
    },
  });

  // ── Mark as remake ─────────────────────────────────────────────────────
  // Links the invoice's underlying case as a remake of an earlier case via
  // the shared questionnaire, so it counts toward remake stats like any
  // other remake (instead of the old hand-edited-case-number workaround).
  const [markRemakeOpen, setMarkRemakeOpen] = useState(false);
  const [remakeSelected, setRemakeSelected] = useState<RemakeCaseHit | null>(null);
  const [remakeQuestionnaire, setRemakeQuestionnaire] = useState<RemakeQuestionnaireValue>(
    blankQuestionnaire(),
  );
  const [remakeSubmitError, setRemakeSubmitError] = useState<string | null>(null);

  function closeMarkRemake() {
    setMarkRemakeOpen(false);
    setRemakeSelected(null);
    setRemakeQuestionnaire(blankQuestionnaire());
    setRemakeSubmitError(null);
  }

  const markAsRemakeMutation = useMutation({
    mutationFn: () => {
      if (!caseIdForPricing || !remakeSelected) {
        return Promise.reject(new Error("Select the original case being remade."));
      }
      const questionnaireError = remakeQuestionnaireError(remakeQuestionnaire);
      if (questionnaireError) return Promise.reject(new Error(questionnaireError));
      return apiFetch<{ caseId: string; caseNumber: string }>(
        `/cases/${caseIdForPricing}/mark-as-remake`,
        {
          method: "PATCH",
          body: JSON.stringify(buildRemakeLinkPayload(remakeSelected, remakeQuestionnaire)),
        },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["case-number-for-invoice", caseIdForPricing] });
      queryClient.invalidateQueries({ queryKey: ["case-remake-chain", caseIdForPricing] });
      queryClient.invalidateQueries({ queryKey: ["case", caseIdForPricing] });
      queryClient.invalidateQueries({ queryKey: ["cases"] });
      queryClient.invalidateQueries({ queryKey: ["invoice", invoice.id] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      closeMarkRemake();
    },
    onError: (err: Error) => {
      setRemakeSubmitError(err.message || "Could not mark this case as a remake.");
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: () =>
      apiFetch<Invoice>(`/invoices/${invoice.id}/duplicate`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: (created) => {
      void refreshInvoiceSalesQueries(queryClient, created.id, created.caseId);
      onClose();
      // Brief alert: the user can find the duplicate at the top of the list.
      window.alert(`Created duplicate ${created.invoiceNumber}`);
    },
    onError: (err: Error) => setError(err.message || "Duplicate failed."),
  });

  const voidMutation = useMutation({
    mutationFn: async (input: { kind: "void" | "writeoff"; reason: string }) => {
      const path =
        input.kind === "void"
          ? `/invoices/${invoice.id}/void`
          : `/invoices/${invoice.id}/write-off`;
      return apiFetch(path, {
        method: "POST",
        body: JSON.stringify({ reason: input.reason, reverseDeposit: true }),
      });
    },
    onSuccess: () => {
      void refreshInvoiceSalesQueries(queryClient, invoice.id, invoice.caseId);
      setVoidDialog(null);
      onClose();
    },
    onError: (err: Error) => setError(err.message || "Operation failed."),
  });

  // Whether the form has unsaved edits compared to the loaded invoice. Until
  // the baseline is captured (detail still loading) we treat it as clean.
  const isDirty = baselineRef.current != null && (
      serializeInvoiceForm({
        providerId: inline ? providerId : undefined,
        invoiceNumber,
        statusValue,
        issuedAt,
        dueAt,
        tax,
        discount,
        credits,
        notes,
        patientName,
        billTo,
        teeth,
        shade,
        material,
        caseNotes,
        layoutPresetId,
        items,
      }) !== baselineRef.current
    );
  draftDirtyRef.current = isDirty;
  const saving = saveMutation.isPending || deletePaymentsMutation.isPending || reassignMutation.isPending || dateRepairMutation.isPending;

  function resetDraft() {
    draftDirtyRef.current = false;
    baselineRef.current = null;
    setError(null);
    setResetVersion((v) => v + 1);
  }

  function requestAction(proceed: () => void) {
    if (saving) return;
    if (isDirty) setPendingDiscard(() => proceed);
    else proceed();
  }

  // Close the editor. If there are unsaved edits, ask for confirmation first
  // so the user can intentionally discard or keep editing.
  const requestClose = useCallback(() => {
    if (saveMutation.isPending || deletePaymentsMutation.isPending) return;
    if (inline) { onClose(); return; }
    if (isDirty) {
      setPendingDiscard(() => onClose);
    } else {
      onClose();
    }
  }, [isDirty, inline, onClose, saveMutation.isPending, deletePaymentsMutation.isPending]);

  // While the form has unsaved edits, intercept in-app route navigations (the
  // sidebar links, programmatic redirects, etc.) so the user can confirm before
  // losing work, and warn on a native window close/reload via beforeunload.
  useEffect(() => {
    if (!isDirty && !saving) return;
    const unregister = registerNavBlocker((proceed) => {
      if (saving) return;
      setPendingDiscard(() => proceed);
    });
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      unregister();
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [isDirty, saving]);

  // Keyboard shortcuts: Cmd/Ctrl+S = save, Cmd/Ctrl+P = print, Esc = close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!saveMutation.isPending && !deletePaymentsMutation.isPending) handleSaveRequest();
      } else if (meta && e.key.toLowerCase() === "p") {
        e.preventDefault();
        handlePrintPdf();
      } else if (!inline && meta && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setEmailOpen(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        // If the discard confirmation is open, Escape cancels that prompt
        // rather than the whole editor, so a stray keystroke can't lose work.
        if (pendingDiscard) {
          setPendingDiscard(null);
        } else {
          requestClose();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  const practiceName =
    detailQuery.data?.providerOrganization?.name ||
    invoice.providerOrganization?.name ||
    providerId;
  const labName =
    detailQuery.data?.labOrganization?.name ||
    invoice.labOrganization?.name ||
    "";

  function buildPdfOptions(): InvoicePdfOptions {
    return {
      invoiceNumber,
      labName,
      practiceName,
      patientName,
      billTo,
      teeth,
      shade,
      material: material.trim() || null,
      caseNotes,
      issuedAt: invoiceDateInputToTimestamp(issuedAt),
      dueAt: invoiceDateInputToTimestamp(dueAt),
      status: statusValue.replace(/_/g, " "),
      items: items.map((it) => ({
        item: it.item,
        toothNumber: it.toothNumber ?? null,
        toothLabel: it.toothLabel ?? null,
        description: it.description,
        quantity: it.quantity,
        unitPrice: it.isDiscount ? -Math.abs(Number(it.unitPrice || 0)) : it.unitPrice,
        isDiscount: !!it.isDiscount,
        lineTotal: (it.isDiscount ? -1 : 1) * Number(it.quantity || 0) * Number(it.unitPrice || 0),
        subItems: (it.subItems ?? []).map((sub) => ({
          item: sub.item,
          toothNumber: sub.toothNumber ?? null,
          description: sub.description,
          quantity: sub.quantity,
          unitPrice: sub.unitPrice,
          lineTotal: Number(sub.quantity || 0) * Number(sub.unitPrice || 0),
        })),
      })),
      subtotal,
      tax,
      discount,
      credits,
      total,
      balanceDue: detailQuery.data?.balanceDue ?? total,
      notes,
      generatedAt: new Date(),
      logoUrl: logoDataUrl,
      logoPdfSize: (user?.practiceLogoSize as "small" | "medium" | "large" | null) ?? null,
      template: invoiceTemplate,
      extraImageDataUrls,
      caseNumber: linkedCaseNumber ?? undefined,
      qrCodeDataUrl,
    };
  }

  function handleDownloadPdf() {
    if (isDirty) { setError("Save or cancel your changes before downloading the confirmed invoice."); return; }
    downloadInvoicePdf(buildPdfOptions());
  }

  function handlePreviewPdf() {
    if (isDirty) { setError("Save or cancel your changes before previewing the confirmed invoice."); return; }
    const opened = previewInvoicePdf(buildPdfOptions());
    if (!opened) {
      setError(
        "Your browser blocked the preview popup. Allow popups for LabTrax in your browser's address bar, then click Preview again.",
      );
    }
  }

  function handlePrintPdf() {
    if (saving || savedAwaitingRefresh || detailQuery.isLoading || detailQuery.isError) return;
    if (isDirty) { setError("Save or cancel your changes before printing the confirmed invoice."); return; }
    printInvoicePdf(buildPdfOptions());
  }

  return (
    <InvoiceEditorPresentation inline={inline} width={invoicePanelIsMaximized ? "100vw" : panelWidth}>
        {/* Drag handle on the left edge */}
        {!inline && <div
          onMouseDown={onResizeMouseDown}
          className="group absolute left-0 top-0 h-full w-4 cursor-col-resize z-20"
          title="Drag to resize panel width"
          aria-label="Drag to resize invoice panel"
        >
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-primary/35 group-hover:bg-primary/70 group-active:bg-primary transition-colors duration-100" />
          <GripVertical
            aria-hidden="true"
            size={16}
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded bg-card text-muted-foreground group-hover:text-primary"
          />
        </div>}
        <header className={inline ? "bg-card border-b border-border px-3 py-3 flex flex-wrap items-start gap-2" : "sticky top-0 z-10 bg-card border-b border-border px-6 py-4 flex items-start gap-3"}>
          <div className="shrink-0">
            <div className="text-xs text-muted-foreground">Invoice</div>
            <div className="flex items-center gap-2">
              <div className="font-mono text-sm font-semibold">{invoice.invoiceNumber}</div>
              {invoice.frozen && (
                <span
                  title={String(invoice.status) === "recovery_draft" ? "Current-rate replacement held for charge and historical-payment review; not collectible" : "Invoice is frozen — the linked case was deleted"}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full uppercase tracking-wide bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400 border border-amber-300/60 dark:border-amber-700/40"
                >
                  <Lock size={9} />
                  {String(invoice.status) === "recovery_draft" ? "Review hold" : "Frozen"}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-1 min-w-0 flex-wrap items-center justify-end gap-2">
            {hasUnpricedLines && (
              <span
                title="One or more alloy sub-items still need a unit price — you can still save, but the total may be incomplete."
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400 border border-amber-300/60 dark:border-amber-700/40 select-none"
              >
                <TriangleAlert size={11} />
                Unpriced alloy lines
              </span>
            )}
            {(!inline || canEditInline) && <button
              type="button"
              onClick={handleSaveRequest}
              disabled={saving || savedAwaitingRefresh || detailQuery.isLoading || detailQuery.isError || !!(detailQuery.data ?? invoice).frozen}
              title={invoice.frozen ? "Invoice is frozen — the linked case was deleted" : undefined}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
            >
              {saveMutation.isPending || deletePaymentsMutation.isPending ? "Saving…" : "Save changes"}
            </button>}
            {inline && <>
              <button type="button" onClick={resetDraft} disabled={!isDirty || saving} className="h-9 px-3 rounded-md border border-border text-sm disabled:opacity-50">Cancel</button>
              <button type="button" onClick={() => requestAction(() => onOpenEditor?.())} disabled={saving || savedAwaitingRefresh} className="h-9 px-3 rounded-md bg-secondary text-xs font-medium">Open in editor</button>
              <button type="button" onClick={handlePrintPdf} disabled={saving || savedAwaitingRefresh || detailQuery.isLoading || detailQuery.isError} className="h-9 px-3 rounded-md bg-secondary text-xs font-medium"><Printer size={12} className="inline mr-1" />Print</button>
              {isDirty && <span role="status" className="text-xs text-amber-700">Unsaved changes</span>}
            </>}
            {!inline && <>
            <button
              type="button"
              onClick={() => setRecordPaymentOpen(true)}
              disabled={detailQuery.isLoading || invoice.status === "paid" || invoice.status === "void"}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <CreditCard size={14} /> Record Payment
            </button>
            <button
              type="button"
              onClick={() => setEmailOpen(true)}
              disabled={detailQuery.isLoading}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary disabled:opacity-50"
            >
              <Mail size={14} /> Email
            </button>
            <button
              type="button"
              onClick={() => {
                if (onGoToCase) {
                  onGoToCase();
                } else if (invoice.caseId) {
                  // Navigate without closing first — while dirty the navigation
                  // blocker surfaces the discard prompt (the editor must stay
                  // mounted to render it); the route change unmounts us anyway.
                  setLocation(`/cases?caseId=${encodeURIComponent(invoice.caseId)}`);
                }
              }}
              disabled={!invoice.caseId}
              title={invoice.caseId ? "Open the linked case" : "This invoice has no linked case"}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary disabled:opacity-50"
            >
              <ExternalLink size={14} /> Go to case
            </button>
            <button
              type="button"
              onClick={toggleInvoicePanelMaximized}
              className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-secondary"
              aria-label={
                invoicePanelIsMaximized
                  ? "Restore invoice panel width"
                  : "Expand invoice panel to full width"
              }
              title={invoicePanelIsMaximized ? "Restore panel width" : "Expand to full width"}
            >
              {invoicePanelIsMaximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-secondary"
                aria-label="More actions"
                title="More actions"
              >
                <MoreHorizontal size={16} />
              </button>
              {moreOpen && (
                <div
                  className="absolute right-0 mt-1 z-50 w-64 bg-card border border-border rounded-md shadow-lg py-1 text-sm"
                  onMouseLeave={() => setMoreOpen(false)}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      handlePreviewPdf();
                    }}
                    disabled={detailQuery.isLoading}
                    className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    <Eye size={14} /> Preview PDF
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      handlePrintPdf();
                    }}
                    disabled={detailQuery.isLoading}
                    className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    <Printer size={14} /> Print
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      handleDownloadPdf();
                    }}
                    disabled={detailQuery.isLoading}
                    className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    <Download size={14} /> Download PDF
                  </button>
                  {caseIdForPricing && (
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        setPrescriptionPreviewOpen(true);
                      }}
                      title="Preview the linked case's prescriptions, files & history"
                      className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2"
                    >
                      <Stethoscope size={14} /> Preview prescription
                    </button>
                  )}
                  {caseIdForPricing && linkedCase && !linkedCase.remakeOfCaseId && (
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        setMarkRemakeOpen(true);
                      }}
                      title="Link this case as a remake of an earlier case"
                      className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2"
                    >
                      <GitBranch size={14} /> Mark as remake
                    </button>
                  )}
                  {rxAttachments.length === 1 && (
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        void openAttachmentFile(rxAttachments[0]!);
                      }}
                      title={`Preview Rx: ${rxAttachments[0]!.fileName}`}
                      className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2"
                    >
                      <ScrollText size={14} /> Rx
                    </button>
                  )}
                  {rxAttachments.length > 1 && rxAttachments.map((att) => (
                    <button
                      key={att.id}
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        void openAttachmentFile(att);
                      }}
                      className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2"
                      title={att.fileName}
                    >
                      <ScrollText size={14} className="shrink-0 text-muted-foreground" />
                      <span className="truncate">{att.fileName}</span>
                    </button>
                  ))}
                  <div className="my-1 border-t border-border" />
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      duplicateMutation.mutate();
                    }}
                    disabled={duplicateMutation.isPending}
                    className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    <Copy size={14} /> Duplicate
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      setVoidDialog("writeoff");
                    }}
                    disabled={
                      invoice.frozen ||
                      invoice.status === "paid" || invoice.status === "void"
                    }
                    title={invoice.frozen ? "Invoice is frozen — the linked case was deleted" : undefined}
                    className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <CheckCircle2 size={14} /> Write off balance
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      setVoidDialog("void");
                    }}
                    disabled={invoice.frozen || invoice.status === "void"}
                    title={invoice.frozen ? "Invoice is frozen — the linked case was deleted" : undefined}
                    className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2 text-destructive disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Ban size={14} /> Void invoice
                  </button>
                </div>
              )}
            </div>
            </>}
          </div>
          {!inline &&
          <button
            type="button"
            onClick={requestClose}
            className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border text-sm font-medium hover:bg-secondary"
            aria-label="Close without saving"
            title="Close without saving (Esc)"
          >
            <X size={16} /> Close
          </button>}
        </header>

        <div className="invoice-fields px-6 py-6 space-y-6">
          {detailQuery.isLoading && (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 size={16} className="animate-spin mr-2" />
              Loading invoice…
            </div>
          )}

          {error && (
            <div role="alert" className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}
          {detailQuery.isError && <div role="alert" className="text-sm text-destructive">Could not load invoice. <button type="button" onClick={() => void detailQuery.refetch()}>Retry</button></div>}
          {savedAwaitingRefresh && !saving && <button type="button" onClick={() => void detailQuery.refetch()} className="text-sm underline">Retry loading confirmed invoice</button>}
          <fieldset disabled={saving || savedAwaitingRefresh || detailQuery.isLoading || detailQuery.isError || (inline && (!canEditInline || !!(detailQuery.data ?? invoice).frozen))} className="min-w-0 space-y-6">
          {(detailQuery.data?.displayMetadata as Record<string, unknown> | undefined)?.reviewedChargesNeedsReview === true && (
            <div role="alert" className="text-sm text-amber-900 bg-amber-100 px-3 py-2 rounded-md">
              {(detailQuery.data?.displayMetadata as Record<string, unknown> | undefined)?.legacyChargesNeedsReview === true
                ? "Some legacy charges have missing ownership information. Charges and totals have been left unchanged. Check each charge against the case, remove any obsolete charges, then save to confirm your review."
                : "The case changed after these invoice charges were reviewed. Check the lines against the case before saving; new case charges are not added automatically."}
            </div>
          )}

          {invoice.aiGenerated && !invoice.aiReviewedAt && !aiReviewedLocal && (
            <div className="flex items-start gap-3 px-3 py-2.5 rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30">
              <Sparkles size={16} className="text-amber-500 mt-0.5 shrink-0" />
              <div className="flex-1 text-sm">
                <div className="font-medium text-amber-900 dark:text-amber-200">
                  AI-imported invoice — please review
                </div>
                {invoice.aiPricingWarning && (
                  <div className="text-xs text-amber-800 dark:text-amber-300/90 mt-0.5">
                    {invoice.aiPricingWarning}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => ackAiMutation.mutate()}
                disabled={ackAiMutation.isPending}
                className="text-xs font-medium px-2.5 py-1 rounded border border-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
              >
                Mark reviewed
              </button>
            </div>
          )}

          {linkedCase?.remakeOfCaseId && (
            <div className="flex items-start gap-3 px-3 py-2.5 rounded-md border border-sky-300/60 bg-sky-50 dark:bg-sky-950/30">
              <GitBranch size={16} className="text-sky-500 mt-0.5 shrink-0" />
              <div className="flex-1 text-sm">
                <div className="font-medium text-sky-900 dark:text-sky-200">
                  This case is a remake
                  {remakeOriginal?.caseNumber && (
                    <>
                      {" "}
                      of case{" "}
                      <span className="font-mono">{remakeOriginal.caseNumber}</span>
                    </>
                  )}
                </div>
                {(linkedCase.remakeReason || linkedCase.remakeCharged !== null) && (
                  <div className="text-xs text-sky-800 dark:text-sky-300/90 mt-0.5">
                    {linkedCase.remakeReason && <>Reason: {linkedCase.remakeReason}</>}
                    {linkedCase.remakeReason && linkedCase.remakeCharged !== null && " · "}
                    {linkedCase.remakeCharged === true && "Charged"}
                    {linkedCase.remakeCharged === false && "No charge"}
                  </div>
                )}
              </div>
            </div>
          )}

          {invoice.frozen && (
            <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-950/30 text-sm">
              <div className="flex items-center gap-2 flex-wrap">
                <Lock size={14} className="text-amber-600 dark:text-amber-400 shrink-0" />
                <span className="font-medium text-amber-800 dark:text-amber-300">
                  {invoice.caseDeletedNote ?? "Case Deleted"}
                  {(detailQuery.data?.linkedCaseNumber ?? invoice.linkedCaseNumber) && (
                    <> &mdash; Case {detailQuery.data?.linkedCaseNumber ?? invoice.linkedCaseNumber}</>
                  )}
                </span>
                {invoice.caseDeletedAt && (
                  <span className="text-muted-foreground text-xs">
                    · {formatDate(invoice.caseDeletedAt)}
                  </span>
                )}
                {invoice.caseId && (
                  <button
                    type="button"
                    onClick={() =>
                      setLocation(`/cases?caseId=${encodeURIComponent(invoice.caseId!)}`)
                    }
                    className="ml-auto inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400 underline underline-offset-2 hover:no-underline"
                  >
                    <ExternalLink size={11} />
                    View case
                  </button>
                )}
              </div>
              {(detailQuery.data?.linkedCaseIsDeleted ?? invoice.linkedCaseIsDeleted) === true && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-amber-700 dark:text-amber-400">
                    The linked case is still deleted — billing is paused.
                  </span>
                  {canRestoreCase && invoice.caseId && (
                    <RestoreCaseButton
                      caseId={invoice.caseId}
                      onSuccess={() => {
                        queryClient.invalidateQueries({ queryKey: ["invoices"] });
                        queryClient.invalidateQueries({ queryKey: ["invoice", invoice.id] });
                      }}
                    />
                  )}
                </div>
              )}
              {(detailQuery.data?.linkedCaseIsDeleted ?? invoice.linkedCaseIsDeleted) === false && (
                <span className="text-xs text-amber-700 dark:text-amber-400">
                  The linked case appears to have been restored, but this invoice is still frozen. Please contact support.
                </span>
              )}
            </div>
          )}

          {invoice.voidedAt && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-destructive/40 bg-destructive/10 text-sm">
              <Ban size={14} className="text-destructive" />
              <span className="font-medium">
                {invoice.voidKind === "writeoff" ? "Written off" : "Voided"}
              </span>
              {invoice.voidReason && (
                <span className="text-muted-foreground">— {invoice.voidReason}</span>
              )}
            </div>
          )}

          <section className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div className="md:col-span-1">
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Invoice #
              </label>
              <input
                type="text"
                value={invoiceNumber}
                aria-label="Invoice number"
                onChange={(e) => setInvoiceNumber(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Status
              </label>
              <select
                value={statusValue}
                aria-label="Status"
                onChange={(e) => setStatusValue(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              >
                {EDITABLE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Client / Provider
              </label>
              {isAdmin ? (
                <select
                  value={providerId}
                  aria-label="Client / Provider"
                  onChange={(e) => {
                    const targetId = e.target.value;
                    if (targetId === providerId) return;
                    const targetOrg = practices.find((p) => p.id === targetId);
                    setReassignConfirm({
                      targetId,
                      targetName: targetOrg?.displayName || targetOrg?.name || targetId,
                    });
                  }}
                  className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
                  disabled={practicesQuery.isLoading || reassignMutation.isPending}
                >
                  {!practices.some((p) => p.id === providerId) && (
                    <option value={providerId}>
                      {detailQuery.data?.providerOrganization?.name ||
                        invoice.providerOrganization?.name ||
                        providerId}
                    </option>
                  )}
                  {practices.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName || p.name}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    type="text"
                    value={
                      detailQuery.data?.providerOrganization?.name ||
                      invoice.providerOrganization?.name ||
                      providerId
                    }
                    disabled
                    readOnly
                    className="w-full h-9 px-2.5 rounded-md bg-secondary/40 border border-input text-sm text-muted-foreground cursor-not-allowed"
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    Admins can reassign invoices to a different practice.
                  </p>
                </>
              )}
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Issued
              </label>
              <input
                type="date"
                value={issuedAt}
                aria-label="Issued"
                onChange={(e) => setIssuedAt(e.target.value)}
                disabled={isLikelyLegacyShiftedInvoiceDate(
                  detailQuery.data?.issuedAt ?? invoice.issuedAt,
                  detailQuery.data?.createdAt ?? invoice.createdAt,
                )}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
              {isAdminOrOwner &&
                (isLikelyLegacyShiftedInvoiceDate(
                  detailQuery.data?.issuedAt ?? invoice.issuedAt,
                  detailQuery.data?.createdAt ?? invoice.createdAt,
                ) ||
                  isLikelyLegacyShiftedInvoiceDate(
                    detailQuery.data?.dueAt ??
                      detailQuery.data?.dueDate ??
                      invoice.dueAt ??
                      invoice.dueDate,
                    detailQuery.data?.createdAt ?? invoice.createdAt,
                  )) && (
                  <button
                    type="button"
                    onClick={() => {
                      setRepairIssuedAt(issuedAt);
                      setRepairDueAt(dueAt);
                      setDateRepairOpen(true);
                    }}
                    disabled={isDirty}
                    title={isDirty ? "Save or discard other invoice edits before repairing dates" : undefined}
                    className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 hover:underline disabled:opacity-50 disabled:no-underline"
                  >
                    <TriangleAlert size={12} />
                    Review possible date shift
                  </button>
                )}
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Due
              </label>
              <input
                type="date"
                value={dueAt}
                aria-label="Due"
                onChange={(e) => setDueAt(e.target.value)}
                disabled={isLikelyLegacyShiftedInvoiceDate(
                  detailQuery.data?.dueAt ??
                    detailQuery.data?.dueDate ??
                    invoice.dueAt ??
                    invoice.dueDate,
                  detailQuery.data?.createdAt ?? invoice.createdAt,
                )}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
              {issuedAt && (
                <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
                  Will be included on the{" "}
                  {(() => { const _d = new Date(issuedAt); return `${String(_d.getUTCMonth() + 1).padStart(2, "0")}/${_d.getUTCFullYear()}`; })()}{" "}
                  statement, generated at end of month.
                </p>
              )}
            </div>
            {(availablePresets.length > 0 || layoutPresetId != null) && (
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  Layout preset
                </label>
                {(() => {
                  const matchedPreset =
                    layoutPresetId != null
                      ? availablePresets.find((p) => p.id === layoutPresetId)
                      : undefined;
                  const presetsFetched =
                    !presetsQuery.isLoading && !presetsQuery.isError;
                  const isDeleted =
                    layoutPresetId != null &&
                    presetsFetched &&
                    matchedPreset == null;
                  const displayValue = isDeleted
                    ? "Deleted preset (using lab default)"
                    : (matchedPreset?.name ?? "Lab default");
                  return (
                    <select aria-label="Layout preset" value={layoutPresetId ?? ""} onChange={(e) => setLayoutPresetId(e.target.value || null)} className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm">
                      <option value="">Lab default</option>
                      {isDeleted && <option value={layoutPresetId!}>{displayValue}</option>}
                      {availablePresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  );
                })()}
              </div>
            )}
          </section>

          {linkedCase && (
            <section>
              <h3 className="text-sm font-semibold mb-3">Rx Summary</h3>
              <div className="rounded-lg border border-border bg-secondary/20 px-4 py-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Patient</div>
                  <div>{`${linkedCase.patientFirstName ?? ""} ${linkedCase.patientLastName ?? ""}`.trim() || "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Doctor</div>
                  <div>{linkedCase.doctorName || "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Restorative Type</div>
                  <div>{linkedRxSummary.restorativeType ?? "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                    {linkedRxSummary.materials.length > 1 ? "Materials" : "Material"}
                  </div>
                  <div>{linkedRxSummary.materials.length > 0 ? linkedRxSummary.materials.join(", ") : "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                    {linkedRxSummary.shades.length > 1 ? "Shades" : "Shade"}
                  </div>
                  <div>{linkedRxSummary.shades.length > 0 ? linkedRxSummary.shades.join(", ") : "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                    {linkedRxSummary.isFullArch ? "Tooth Coverage" : "Tooth Number(s)"}
                  </div>
                  <div>{linkedRxTeethLabel || "—"}</div>
                </div>
                <div className="md:col-span-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Rx Notes</div>
                  <div className="whitespace-pre-wrap">{(linkedCase.caseNotes ?? "").trim() || "—"}</div>
                </div>
              </div>
            </section>
          )}

          <section>
            <h3 className="text-sm font-semibold mb-3">Patient & billing details</h3>
            {detailQuery.isLoading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4" aria-busy="true" aria-label="Loading patient and billing details">
                {[...Array(6)].map((_, i) => (
                  <div key={i} className={i === 4 ? "md:col-span-2" : undefined}>
                    <div className="h-3 w-24 rounded bg-muted animate-pulse mb-2" />
                    <div className="h-9 rounded-md bg-muted animate-pulse" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                    Patient name
                  </label>
                  <input
                    type="text"
                    value={patientName}
                    aria-label="Patient name"
                    onChange={(e) => setPatientName(e.target.value)}
                    placeholder="Patient name"
                    className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
                  />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                    Bill to
                  </label>
                  <DoctorNamePicker
                    value={billTo}
                    onChange={(name) => setBillTo(name)}
                    doctorNames={editorDoctorNames}
                    placeholder="Select doctor…"
                  />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                    Teeth
                  </label>
                  <input
                    type="text"
                    value={teeth}
                    aria-label="Teeth"
                    onChange={(e) => setTeeth(e.target.value)}
                    placeholder="e.g. 8, 9, 10"
                    className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
                  />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                    Shade
                  </label>
                  <input
                    type="text"
                    value={shade}
                    aria-label="Shade"
                    onChange={(e) => setShade(e.target.value)}
                    placeholder="e.g. A2"
                    className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
                  />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                    Material
                  </label>
                  <input
                    type="text"
                    value={material}
                    aria-label="Material"
                    onChange={(e) => setMaterial(e.target.value)}
                    placeholder="e.g. Zirconia"
                    className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                    Case notes
                  </label>
                  <textarea
                    value={caseNotes}
                    aria-label="Case notes"
                    onChange={(e) => setCaseNotes(e.target.value)}
                    rows={2}
                    placeholder="Case notes from the originating case"
                    className="w-full px-3 py-2 rounded-md bg-background border border-input text-sm resize-y"
                  />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                    Credits
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={credits}
                    aria-label="Credits"
                    onChange={(e) => setCredits(Number(e.target.value) || 0)}
                    className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm text-right tabular-nums"
                  />
                </div>
              </div>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">Line items</h3>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={resetAllColWidths}
                  className="text-xs text-muted-foreground hover:text-foreground"
                  title="Reset all column widths to defaults"
                >
                  Reset columns
                </button>
                <div className="relative" ref={addLineMenuRef}>
                  <button
                    type="button"
                    onClick={() => setShowAddLineMenu((v) => !v)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    <Plus size={13} /> Add line <ChevronDown size={11} />
                  </button>
                  {showAddLineMenu && (
                    <div className="absolute right-0 top-full mt-1 w-56 bg-card border border-border rounded-lg shadow-xl z-20 py-1">
                      <button
                        type="button"
                        onClick={() => { addItem(); setShowAddLineMenu(false); }}
                        className="w-full text-left px-3 py-2.5 text-sm hover:bg-secondary"
                      >
                        <div className="font-medium">One-off line item</div>
                        <div className="text-xs text-muted-foreground">Free text, not saved to a tier</div>
                      </button>
                      <button
                        type="button"
                        onClick={() => { addDiscountLine(); setShowAddLineMenu(false); }}
                        className="w-full text-left px-3 py-2.5 text-sm hover:bg-secondary"
                      >
                        <div className="font-medium">Discount line</div>
                        <div className="text-xs text-muted-foreground">Enter a positive amount to deduct</div>
                      </button>
                      <button
                        type="button"
                        onClick={() => { setShowCreateItemModal(true); setShowAddLineMenu(false); }}
                        className="w-full text-left px-3 py-2.5 text-sm hover:bg-secondary"
                      >
                        <div className="font-medium inline-flex items-center gap-1"><Layers size={12} /> Create new tier item</div>
                        <div className="text-xs text-muted-foreground">Save to pricing tier &amp; add to invoice</div>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div
              ref={lineItemsTableContainerRef}
              className="min-w-0 border border-border rounded-md overflow-x-auto relative"
            >
              {resizingCol !== null && (
                <div
                  className="bg-primary/50 pointer-events-none absolute top-0 bottom-0 z-10"
                  style={{
                    left: fittedColumnWidths.slice(0, resizingCol + 1).reduce((a, b) => a + b, 0) - 1,
                    width: 2,
                  }}
                />
              )}
              <table
                ref={lineItemsTableRef}
                className="invoice-lines text-sm"
                style={{
                  tableLayout: "fixed",
                  width: fittedTableWidth,
                  userSelect: "none",
                }}
              >
                <colgroup>
                  {inline && <col style={{ width: 28 }} />}
                  {fittedColumnWidths.map((w, i) => (
                    <col key={i} style={{ width: w }} />
                  ))}
                  <col style={{ width: INVOICE_LINE_ITEM_ACTION_COLUMN_WIDTH }} />
                </colgroup>
                <thead>
                  <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {inline && <th aria-label="Remove line" />}
                    {(["Item", "Tooth #", "Description", "Qty", "Amount", "Total"] as const).map(
                      (label, i) => (
                        <th
                          key={label}
                          data-col-id={`col-${i}`}
                          className={`font-medium px-3 py-2 relative${
                            i === 0 || i === 2 ? " text-left" : " text-right"
                          }`}
                          style={{ overflow: "hidden" }}
                        >
                          {label}
                          <div
                            onMouseDown={(e) =>
                              startResize(i, e, {
                                widths: fittedColumnWidths,
                                minimums: [...INVOICE_LINE_ITEM_COLUMN_MINIMUMS],
                                neighborIndex: i === 2 ? 0 : 2,
                                resize: resizeInvoiceLineItemColumns,
                              })
                            }
                            onDoubleClick={() => {
                              const table = lineItemsTableRef.current;
                              if (!table) { resetColumn(i); return; }
                              const cells = table.querySelectorAll<HTMLElement>(`[data-col-id="col-${i}"]`);
                              let max = 0;
                              cells.forEach((el) => { max = Math.max(max, el.scrollWidth); });
                              fitColumn(i, max + 8);
                            }}
                            className="group/resize"
                            style={{
                              position: "absolute",
                              top: 0,
                              right: 0,
                              width: 6,
                              height: "100%",
                              cursor: "col-resize",
                              userSelect: "none",
                              display: "flex",
                              alignItems: "stretch",
                              justifyContent: "flex-end",
                            }}
                          >
                            <span
                              className={`w-0.5 transition-colors duration-100 ${resizingCol === i ? "bg-primary" : "bg-border/60 group-hover/resize:bg-primary/50"}`}
                              style={{ display: "block", height: "100%" }}
                            />
                          </div>
                        </th>
                      ),
                    )}
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                        No line items. Click "Add line" to add one.
                      </td>
                    </tr>
                  )}
                  {items.map((it, idx) => (
                    <Fragment key={idx}>
                    {it.missingCatalogItem && (
                      <tr className="border-t border-border bg-amber-50/60 dark:bg-amber-900/20">
                        <td colSpan={7} className="px-3 py-1 text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                          <span className="font-semibold">⚠</span>
                          No catalog price found for &ldquo;{it.item || it.description}&rdquo; — add it to the pricing tier to auto-fill the rate.
                        </td>
                      </tr>
                    )}
                    <tr className="border-t border-border">
                      {inline && <td className="line-trash"><button type="button" onClick={() => removeItem(idx)} aria-label={`Remove line ${idx + 1}`} className="h-7 w-7 flex items-center justify-center rounded hover:bg-destructive/10"><Trash2 size={13} /></button></td>}
                      <td data-col-id="col-0" data-label="Item" className="px-3 py-1.5 align-top">
                        <ItemCombobox
                          value={it.item}
                          options={itemOptions}
                          onPick={(o) =>
                            updateItem(idx, {
                              item: o.name,
                              description: o.name,
                              isDiscount: !!o.isDiscount,
                              ...(o.unitPrice != null
                                ? { unitPrice: String(o.unitPrice) }
                                : {}),
                            })
                          }
                          onText={(t) =>
                            updateItem(
                              idx,
                              t.trim() === ""
                                ? { item: "", description: "", unitPrice: "" }
                                : { item: t },
                            )
                          }
                          placeholder="Item"
                          onAddNew={
                            isAdminOrOwner
                              ? (typedName) => {
                                  const sp = new URLSearchParams();
                                  sp.set("addItem", "1");
                                  if (typedName) sp.set("name", typedName);
                                  setLocation(`/pricing?${sp.toString()}`);
                                }
                              : undefined
                          }
                        />
                        {it.isDiscount && (
                          <span className="mt-1 inline-flex rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                            Discount
                          </span>
                        )}
                      </td>
                      <td data-col-id="col-1" data-label="Tooth #" className="px-3 py-1.5">
                        <input
                          type="text"
                          aria-label={`Tooth for line ${idx + 1}`}
                          value={it.toothLabel ?? (it.toothNumber != null ? String(it.toothNumber) : "")}
                          onChange={(e) => {
                            const v = e.target.value;
                            updateItem(idx, {
                              toothLabel: v || null,
                              toothNumber: null,
                            });
                          }}
                          placeholder="—"
                          className="w-full h-8 px-2 rounded bg-background border border-input text-sm text-right tabular-nums"
                        />
                      </td>
                      <td data-col-id="col-2" data-label="Description" className="px-3 py-1.5 align-top">
                        <textarea
                          value={it.description}
                          aria-label={`Description for line ${idx + 1}`}
                          onChange={(e) =>
                            updateItem(idx, { description: e.target.value })
                          }
                          onInput={(e) => {
                            const el = e.currentTarget;
                            el.style.height = "auto";
                            el.style.height = `${el.scrollHeight}px`;
                          }}
                          ref={(el) => {
                            if (el) {
                              el.style.height = "auto";
                              el.style.height = `${el.scrollHeight}px`;
                            }
                          }}
                          placeholder="Description"
                          rows={2}
                          className="w-full min-h-[3.5rem] px-2 py-1.5 rounded bg-background border border-input text-sm resize-none overflow-hidden"
                        />
                      </td>
                      <td data-col-id="col-3" data-label="Qty" className="px-3 py-1.5">
                        <input
                          type="number"
                          aria-label={`Quantity for line ${idx + 1}`}
                          min={0}
                          step={1}
                          value={it.quantity}
                          onChange={(e) =>
                            updateItem(idx, { quantity: Number(e.target.value) || 0 })
                          }
                          className="w-full h-8 px-2 rounded bg-background border border-input text-sm text-right tabular-nums"
                        />
                      </td>
                      <td data-col-id="col-4" data-label="Unit price" className="px-3 py-1.5">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={it.unitPrice}
                          aria-label={it.isDiscount ? "Discount amount" : "Unit price"}
                          onChange={(e) =>
                            updateItem(idx, { unitPrice: e.target.value })
                          }
                          className="w-full h-8 px-2 rounded bg-background border border-input text-sm text-right tabular-nums"
                        />
                      </td>
                      <td data-col-id="col-5" data-label="Total" className="px-3 py-1.5 text-right tabular-nums font-medium">
                        {formatInvoiceLineMoney(
                          it.isDiscount
                            ? -Math.abs(Number(it.quantity || 0) * Number(it.unitPrice || 0))
                            : Number(it.quantity || 0) * Number(it.unitPrice || 0),
                        )}
                      </td>
                      <td className="line-actions px-2 py-1.5 align-top">
                        <div className="flex items-center gap-0.5 justify-end">
                          <button
                            type="button"
                            onClick={() => moveItem(idx, -1)}
                            disabled={idx === 0}
                            className="h-7 w-6 rounded hover:bg-secondary text-muted-foreground hover:text-foreground flex items-center justify-center disabled:opacity-30 disabled:hover:bg-transparent"
                            aria-label="Move up"
                          >
                            <ArrowUp size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveItem(idx, 1)}
                            disabled={idx === items.length - 1}
                            className="h-7 w-6 rounded hover:bg-secondary text-muted-foreground hover:text-foreground flex items-center justify-center disabled:opacity-30 disabled:hover:bg-transparent"
                            aria-label="Move down"
                          >
                            <ArrowDown size={12} />
                          </button>
                          {!inline && <button
                            type="button"
                            onClick={() => removeItem(idx)}
                            className="h-7 w-7 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive flex items-center justify-center"
                            aria-label="Remove line"
                          >
                            <Trash2 size={13} />
                          </button>}
                        </div>
                      </td>
                    </tr>
                    {(it.subItems ?? []).map((sub, sidx) => {
                      const needsPrice = sub.priced === false;
                      return (
                      <tr
                        key={`sub-${sidx}`}
                        className={`border-t border-border/50 ${needsPrice ? "bg-amber-50/70 dark:bg-amber-950/30" : "bg-muted/20"}`}
                        onClick={needsPrice ? (e) => {
                          const row = e.currentTarget;
                          const input = row.querySelector<HTMLInputElement>('[data-col-id="col-4"] input');
                          input?.focus();
                          input?.select();
                        } : undefined}
                        style={needsPrice ? { cursor: "pointer" } : undefined}
                      >
                        {inline && <td className="line-trash"><button type="button" onClick={(e) => { e.stopPropagation(); removeSubItem(idx, sidx); }} aria-label={`Remove sub-item ${idx + 1}.${sidx + 1}`} className="h-7 w-7 flex items-center justify-center rounded hover:bg-destructive/10"><Trash2 size={11} /></button></td>}
                        <td data-col-id="col-0" data-label="Sub-item" className="py-1.5 pl-8 pr-3 align-top">
                          <ItemCombobox
                            size="sm"
                            value={sub.item}
                            options={itemOptions.filter((option) => !option.isDiscount)}
                            onPick={(o) =>
                              updateSubItem(idx, sidx, {
                                item: o.name,
                                description: o.name,
                                ...(o.unitPrice != null
                                  ? { unitPrice: String(o.unitPrice) }
                                  : {}),
                              })
                            }
                            onText={(t) =>
                              updateSubItem(
                                idx,
                                sidx,
                                t.trim() === ""
                                  ? { item: "", description: "", unitPrice: "" }
                                  : { item: t },
                              )
                            }
                            placeholder="Sub-item"
                            onAddNew={
                              isAdminOrOwner
                                ? (typedName) => {
                                    const sp = new URLSearchParams();
                                    sp.set("addItem", "1");
                                    if (typedName) sp.set("name", typedName);
                                    setLocation(`/pricing?${sp.toString()}`);
                                  }
                                : undefined
                            }
                          />
                        </td>
                        <td data-col-id="col-1" data-label="Tooth #" className="px-3 py-1.5">
                          <input
                            type="text"
                            aria-label={`Tooth for sub-item ${idx + 1}.${sidx + 1}`}
                            value={sub.toothLabel ?? (sub.toothNumber != null ? String(sub.toothNumber) : "")}
                            onChange={(e) => {
                              const v = e.target.value;
                              updateSubItem(idx, sidx, {
                                toothLabel: v || null,
                                toothNumber: null,
                              });
                            }}
                            placeholder="—"
                            className="w-full h-7 px-2 rounded bg-background border border-input text-xs text-right tabular-nums"
                          />
                        </td>
                        <td data-col-id="col-2" data-label="Description" className="px-3 py-1.5 align-top">
                          <input
                            type="text"
                            aria-label={`Description for sub-item ${idx + 1}.${sidx + 1}`}
                            value={sub.description}
                            onChange={(e) => updateSubItem(idx, sidx, { description: e.target.value })}
                            placeholder="Description"
                            className="w-full h-7 px-2 rounded bg-background border border-input text-xs"
                          />
                        </td>
                        <td data-col-id="col-3" data-label="Qty" className="px-3 py-1.5">
                          <input
                            type="number"
                            aria-label={`Quantity for sub-item ${idx + 1}.${sidx + 1}`}
                            min={0}
                            step={1}
                            value={sub.quantity}
                            onChange={(e) => updateSubItem(idx, sidx, { quantity: Number(e.target.value) || 0 })}
                            className="w-full h-7 px-2 rounded bg-background border border-input text-xs text-right tabular-nums"
                          />
                        </td>
                        <td data-col-id="col-4" data-label="Unit price" className="px-3 py-1.5">
                          {needsPrice && (
                            <div className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                              <TriangleAlert size={10} />
                              Needs price
                            </div>
                          )}
                          <input
                            type="number"
                            aria-label={`Unit price for sub-item ${idx + 1}.${sidx + 1}`}
                            min={0}
                            step="0.01"
                            value={sub.unitPrice}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => updateSubItem(idx, sidx, { unitPrice: e.target.value })}
                            className={`w-full h-7 px-2 rounded border text-xs text-right tabular-nums ${needsPrice ? "bg-amber-50 border-amber-300 dark:bg-amber-950/40 dark:border-amber-700" : "bg-background border-input"}`}
                          />
                        </td>
                        <td data-col-id="col-5" data-label="Total" className="px-3 py-1.5 text-right tabular-nums text-xs text-muted-foreground">
                          {formatMoney(Number(sub.quantity || 0) * Number(sub.unitPrice || 0))}
                        </td>
                        {!inline && <td className="px-2 py-1.5 align-top">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); removeSubItem(idx, sidx); }}
                            className="h-6 w-6 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive flex items-center justify-center"
                            aria-label="Remove sub-item"
                          >
                            <Trash2 size={11} />
                          </button>
                        </td>}
                      </tr>
                      );
                    })}
                    {(it.subItems ?? []).length > 0 && (
                      <tr className="border-t border-border/50 bg-muted/30">
                        <td colSpan={5} className="py-1.5 pr-3 text-right text-xs italic text-muted-foreground">
                          — Subtotal
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-xs font-semibold text-foreground">
                          {formatMoney(
                            Number(it.quantity || 0) * Number(it.unitPrice || 0) +
                            (it.subItems ?? []).reduce(
                              (s, sub) => s + Number(sub.quantity || 0) * Number(sub.unitPrice || 0),
                              0,
                            ),
                          )}
                        </td>
                        <td />
                      </tr>
                    )}
                    <tr className="border-t border-border/30">
                      <td colSpan={7} className="px-3 py-1">
                        <button
                          type="button"
                          onClick={() => addSubItem(idx)}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <Plus size={10} />
                          Sub-item
                        </button>
                      </td>
                    </tr>
                    </Fragment>
                  ))}
                  <tr className="border-t border-border/30">
                    <td colSpan={7} className="px-3 py-1">
                      <button
                        type="button"
                        onClick={addItem}
                        aria-label="Add a blank line"
                        data-testid="button-add-line-bottom"
                        className="w-full flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <Plus size={10} />
                        Add line
                      </button>
                    </td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr className="border-t border-border">
                    <td colSpan={5} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
                      Subtotal
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMoney(subtotal)}
                    </td>
                    <td />
                  </tr>
                  <tr className="border-t border-border">
                    <td colSpan={5} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
                      Tax
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={tax}
                        aria-label="Tax"
                        onChange={(e) => setTax(Number(e.target.value) || 0)}
                        className="w-full max-w-24 h-7 px-2 rounded bg-background border border-input text-sm text-right tabular-nums"
                      />
                    </td>
                    <td />
                  </tr>
                  <tr className="border-t border-border">
                    <td colSpan={5} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
                      Discount
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={discount}
                        aria-label="Invoice discount"
                        onChange={(e) => setDiscount(Number(e.target.value) || 0)}
                        className="w-full max-w-24 h-7 px-2 rounded bg-background border border-input text-sm text-right tabular-nums"
                      />
                    </td>
                    <td />
                  </tr>
                  {Number(credits || 0) > 0 && (
                    <tr className="border-t border-border">
                      <td
                        colSpan={5}
                        className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium"
                      >
                        Credits applied
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        −{formatMoney(Number(credits || 0))}
                      </td>
                      <td />
                    </tr>
                  )}
                  <tr className="border-t border-border bg-secondary/30">
                    <td colSpan={5} className="px-3 py-2.5 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
                      Total
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold">
                      {formatMoney(total)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {inline && <div className="flex items-center justify-between gap-3 text-sm border-t border-border pt-3">
            <span className="text-muted-foreground">{isDirty ? "Balance due (draft)" : "Balance due"}</span>
            <output className="font-semibold tabular-nums" aria-label="Calculated balance due">
              {formatMoney(statusValue === "void" ? 0 : total - (detailQuery.data?.payments ?? []).reduce((sum, payment) => sum + Number(payment.amount || 0), 0))}
            </output>
          </div>}

          <section>
            <label className="block text-sm font-semibold mb-2">Notes</label>
            <textarea
              value={notes}
              aria-label="Notes"
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              placeholder="Internal notes for this invoice (optional)"
              className="w-full px-3 py-2 rounded-md bg-background border border-input text-sm resize-y"
            />
          </section>

          {detailQuery.data?.linkedTransactions && detailQuery.data.linkedTransactions.length > 0 && (() => {
            const linkedTxns = detailQuery.data.linkedTransactions;
            const linkedTxnTotal = linkedTxns.reduce(
              (sum, t) => sum + Number(t.creditAmount) - Number(t.debitAmount),
              0
            );
            // Use balanceDue (remaining unpaid) as the target — not total —
            // so partially-paid invoices don't generate false positives.
            const invoiceBalanceDue = Number(detailQuery.data?.balanceDue ?? detailQuery.data?.total ?? 0);
            const aggregateMismatch =
              invoiceBalanceDue > 0.005 &&
              linkedTxnTotal < invoiceBalanceDue - 0.01;
            return (
              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold">Linked register entries</h3>
                  <span className={`text-xs tabular-nums ${aggregateMismatch ? "text-amber-600 dark:text-amber-400 font-medium" : "text-muted-foreground"}`}>
                    {aggregateMismatch && <AlertCircle size={11} className="inline mr-1 mb-0.5" />}
                    Total: {formatMoney(linkedTxnTotal)}
                  </span>
                </div>
                <div className="border border-border rounded-md divide-y divide-border">
                  {linkedTxns.map((t) => {
                    const entryNet = Number(t.creditAmount) - Number(t.debitAmount);
                    // Flag this individual entry when it alone is less than the
                    // outstanding balance AND it's the only linked entry (single
                    // entry that can't cover the invoice by itself).
                    const entryShortfall =
                      aggregateMismatch &&
                      linkedTxns.length === 1 &&
                      entryNet < invoiceBalanceDue - 0.01;
                    return (
                      <div
                        key={t.id}
                        className={`flex items-center justify-between px-3 py-2 text-sm ${entryShortfall ? "bg-amber-50/60 dark:bg-amber-950/20" : ""}`}
                      >
                        <div>
                          <div className={`font-medium flex items-center gap-1 ${entryShortfall ? "text-amber-700 dark:text-amber-400" : ""}`}>
                            {formatMoney(entryNet)}
                            {entryShortfall && (
                              <AlertCircle size={12} className="shrink-0" aria-label={`Doesn't cover balance due (${formatMoney(invoiceBalanceDue)})`} />
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {t.accountName || "Bank"} · {formatDate(t.txnDate)}
                            {t.payee ? ` · ${t.payee}` : ""}
                          </div>
                        </div>
                        {t.source === "invoice" && (
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            auto
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                {aggregateMismatch && (
                  <p className="mt-1.5 flex items-start gap-1 text-xs text-amber-600 dark:text-amber-400">
                    <AlertCircle size={12} className="shrink-0 mt-0.5" />
                    Linked entries ({formatMoney(linkedTxnTotal)}) don&apos;t cover the balance due ({formatMoney(invoiceBalanceDue)}).
                  </p>
                )}
              </section>
            );
          })()}

          {detailQuery.data?.payments && detailQuery.data.payments.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold mb-2">Payments</h3>
              <div className="border border-border rounded-md divide-y divide-border">
                {detailQuery.data.payments.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between px-3 py-2 text-sm"
                  >
                    <div>
                      <div className="font-medium">{formatMoney(p.amount)}</div>
                      <div className="text-xs text-muted-foreground">
                        {p.method || "Payment"} · {formatDate(p.paidAt)}
                      </div>
                    </div>
                    {p.reference && (
                      <div className="text-xs text-muted-foreground">{p.reference}</div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
          {detailQuery.data?.dateRepairLogs &&
            detailQuery.data.dateRepairLogs.length > 0 && (
              <section>
                <h3 className="text-sm font-semibold mb-2">Date repair history</h3>
                <div className="border border-border rounded-md divide-y divide-border">
                  {detailQuery.data.dateRepairLogs.map((entry) => {
                    const actorName =
                      [entry.actorFirstName, entry.actorLastName]
                        .filter(Boolean)
                        .join(" ")
                        .trim() ||
                      entry.actorInitials ||
                      entry.actorUsername ||
                      entry.userId ||
                      "Unknown user";
                    const oldDates = entry.beforeJson ?? {};
                    const correctedDates = entry.afterJson ?? {};
                    const displayDate = (value: string | null | undefined) =>
                      value ? formatInvoiceDate(value) : "Not set";
                    return (
                      <div key={entry.id} className="px-3 py-2 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-medium flex items-center gap-1.5">
                            <RotateCcw size={12} className="shrink-0 text-muted-foreground" />
                            Invoice dates repaired
                          </div>
                          <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
                            {formatDateTime(entry.createdAt)}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground space-y-0.5">
                          <div>
                            Issue date: {displayDate(oldDates.issuedAt)}
                            {" → "}
                            <span className="text-foreground">
                              {displayDate(correctedDates.issuedAt)}
                            </span>
                          </div>
                          <div>
                            Due date: {displayDate(oldDates.dueAt)}
                            {" → "}
                            <span className="text-foreground">
                              {displayDate(correctedDates.dueAt)}
                            </span>
                          </div>
                          <div>By {actorName}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          {(detailQuery.data as any)?.doctorIdentityRepairLogs &&
            ((detailQuery.data as any).doctorIdentityRepairLogs as Array<{
              id: string;
              userId: string | null;
              beforeJson: Record<string, unknown> | null;
              afterJson: Record<string, unknown> | null;
              metadataJson: Record<string, unknown> | null;
              createdAt: string;
              actorUsername: string | null;
              actorFirstName: string | null;
              actorLastName: string | null;
              actorInitials: string | null;
            }>).length > 0 && (
            <section>
              <h3 className="text-sm font-semibold mb-2">Doctor identity repair history</h3>
              <div className="border border-border rounded-md divide-y divide-border">
                {((detailQuery.data as any).doctorIdentityRepairLogs as Array<{
                  id: string;
                  userId: string | null;
                  beforeJson: Record<string, unknown> | null;
                  afterJson: Record<string, unknown> | null;
                  metadataJson: Record<string, unknown> | null;
                  createdAt: string;
                  actorUsername: string | null;
                  actorFirstName: string | null;
                  actorLastName: string | null;
                  actorInitials: string | null;
                }>).map((entry) => {
                  const actorName =
                    [entry.actorFirstName, entry.actorLastName]
                      .filter(Boolean)
                      .join(" ")
                      .trim() ||
                    entry.actorInitials ||
                    entry.actorUsername ||
                    entry.userId ||
                    "Unknown user";
                  const before = entry.beforeJson ?? {};
                  const after = entry.afterJson ?? {};
                  const beforeName = typeof before.doctorDisplayName === "string"
                    ? before.doctorDisplayName
                    : "Unclassified legacy invoice";
                  const afterName = typeof after.doctorDisplayName === "string"
                    ? after.doctorDisplayName
                    : "Doctor profile";
                  return (
                    <div key={entry.id} className="px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-medium flex items-center gap-1.5">
                          <Stethoscope size={12} className="shrink-0 text-muted-foreground" />
                          Doctor identity assigned
                        </div>
                        <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
                          {formatDateTime(entry.createdAt)}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground space-y-0.5">
                        <div>
                          {beforeName}{" → "}
                          <span className="text-foreground">{afterName}</span>
                        </div>
                        <div>By {actorName}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          {(detailQuery.data as any)?.paymentDeleteLogs &&
            ((detailQuery.data as any).paymentDeleteLogs as Array<{
              id: string;
              userId: string | null;
              userInitials: string | null;
              metadataJson: Record<string, unknown>;
              createdAt: string;
            }>).length > 0 && (
            <section>
              <h3 className="text-sm font-semibold mb-2">Payment history</h3>
              <div className="border border-border rounded-md divide-y divide-border">
                {((detailQuery.data as any).paymentDeleteLogs as Array<{
                  id: string;
                  userId: string | null;
                  userInitials: string | null;
                  metadataJson: Record<string, unknown>;
                  createdAt: string;
                }>).map((entry) => {
                  const meta = entry.metadataJson ?? {};
                  const count = typeof meta.deletedCount === "number" ? meta.deletedCount : null;
                  const prevStatus = typeof meta.previousStatus === "string" ? meta.previousStatus : null;
                  return (
                    <div key={entry.id} className="px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-medium text-destructive/80 flex items-center gap-1.5">
                          <Trash2 size={12} className="shrink-0" />
                          {count === 1 ? "1 payment cleared" : count != null ? `${count} payments cleared` : "Payments cleared"}
                        </div>
                        <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
                          {formatDateTime(entry.createdAt)}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground space-y-0.5">
                        {prevStatus && (
                          <div>
                            Was{" "}
                            <span className="capitalize">
                              {prevStatus.replace(/_/g, " ")}
                            </span>
                            {" → "}
                            <span className="capitalize">Open</span>
                          </div>
                        )}
                        {(entry.userInitials || entry.userId) && (
                          <div>By {entry.userInitials || entry.userId}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          </fieldset>
        </div>
      {prescriptionPreviewOpen && caseIdForPricing && (
        <PrescriptionPreview
          caseId={caseIdForPricing}
          invoiceCaseId={caseIdForPricing}
          onClose={() => setPrescriptionPreviewOpen(false)}
        />
      )}
      {markRemakeOpen && caseIdForPricing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => !markAsRemakeMutation.isPending && closeMarkRemake()}
          />
          <div className="relative z-10 w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-card border border-border shadow-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold flex items-center gap-2">
                <GitBranch size={15} className="text-muted-foreground" />
                Mark as remake{linkedCaseNumber ? ` — #${linkedCaseNumber}` : ""}
              </h2>
              <button
                type="button"
                onClick={() => !markAsRemakeMutation.isPending && closeMarkRemake()}
                className="h-7 w-7 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground"
                disabled={markAsRemakeMutation.isPending}
              >
                <X size={15} />
              </button>
            </div>
            <RemakeOriginalPicker
              labOrganizationId={invoice.labOrganizationId}
              selected={remakeSelected}
              onSelect={(hit) => {
                setRemakeSelected(hit);
                setRemakeSubmitError(null);
              }}
              onClear={() => {
                setRemakeSelected(null);
                setRemakeQuestionnaire(blankQuestionnaire());
              }}
              questionnaire={remakeQuestionnaire}
              onQuestionnaireChange={setRemakeQuestionnaire}
              isAdmin={isAdmin}
              excludeCaseId={caseIdForPricing}
            />
            {remakeSubmitError && (
              <p className="mt-3 text-sm text-destructive">{remakeSubmitError}</p>
            )}
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeMarkRemake}
                disabled={markAsRemakeMutation.isPending}
                className="h-8 px-4 rounded-md text-sm bg-secondary hover:bg-secondary/80 text-muted-foreground disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => markAsRemakeMutation.mutate()}
                disabled={
                  markAsRemakeMutation.isPending ||
                  !remakeSelected ||
                  !isRemakeQuestionnaireComplete(remakeQuestionnaire)
                }
                className="h-8 px-4 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {markAsRemakeMutation.isPending && (
                  <Loader2 size={12} className="animate-spin" />
                )}
                {markAsRemakeMutation.isPending ? "Saving…" : "Mark as remake"}
              </button>
            </div>
          </div>
        </div>
      )}
      {emailOpen && (
        <EmailInvoiceDialog
          invoice={invoice}
          practiceName={practiceName}
          buildPdfOptions={buildPdfOptions}
          onClose={() => setEmailOpen(false)}
        />
      )}
      {/* Paid→Open guard: invoice has recorded payments that must be deleted first */}
      {paymentDeleteConfirm && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
            <h3 className="text-base font-semibold">This invoice has a recorded payment</h3>
            <p className="text-sm text-muted-foreground">
              {detailQuery.data?.inStatement
                ? "This invoice was included in a statement that has a recorded payment. Reverting to Open without removing the payment will leave the ledger out of balance."
                : "This invoice has a recorded payment. Delete it before marking the invoice as Open?"}
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPaymentDeleteConfirm(false)}
                disabled={deletePaymentsMutation.isPending}
                className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => deletePaymentsMutation.mutate()}
                disabled={deletePaymentsMutation.isPending}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md text-sm font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              >
                {deletePaymentsMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                Delete payment &amp; mark Open
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Open→Paid prompt: no existing payments — offer to record one */}
      {recordPaymentPrompt && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
            <h3 className="text-base font-semibold">Record a payment?</h3>
            <p className="text-sm text-muted-foreground">
              Do you want to record a payment for this invoice? This keeps the financial ledger accurate.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setRecordPaymentPrompt(false);
                  saveMutation.mutate();
                }}
                className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary"
              >
                No, just mark as paid
              </button>
              <button
                type="button"
                onClick={() => {
                  setRecordPaymentPrompt(false);
                  setRecordPaymentOpen(true);
                }}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <CreditCard size={14} /> Yes, record payment
              </button>
            </div>
          </div>
        </div>
      )}
      {recordPaymentOpen && (
        <RecordPaymentDialog
          invoice={detailQuery.data ?? invoice}
          onClose={() => setRecordPaymentOpen(false)}
          onRecorded={() => {
            void refreshInvoiceSalesQueries(queryClient, invoice.id, invoice.caseId);
            setRecordPaymentOpen(false);
          }}
        />
      )}
      {voidDialog && (
        <VoidConfirmDialog
          kind={voidDialog}
          pending={voidMutation.isPending}
          onCancel={() => setVoidDialog(null)}
          onConfirm={(reason) =>
            voidMutation.mutate({ kind: voidDialog, reason })
          }
        />
      )}
      {reassignConfirm && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
            <h3 className="text-base font-semibold">Reassign invoice?</h3>
            <p className="text-sm text-muted-foreground">
              This invoice will be moved to{" "}
              <span className="font-medium text-foreground">
                {reassignConfirm.targetName}
              </span>
              . {inline ? "The change will be included when you save this invoice and logged in the audit trail." : "The change is saved immediately and logged in the audit trail."}
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setReassignConfirm(null)}
                disabled={reassignMutation.isPending}
                className="h-9 px-4 rounded-md bg-secondary text-secondary-foreground text-sm font-medium hover:bg-secondary/80 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  if (inline) {
                    setProviderId(reassignConfirm.targetId);
                    setReassignConfirm(null);
                  } else reassignMutation.mutate(reassignConfirm.targetId);
                }}
                disabled={reassignMutation.isPending}
                className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {reassignMutation.isPending && (
                  <Loader2 size={14} className="animate-spin" />
                )}
                Reassign
              </button>
            </div>
          </div>
        </div>
      )}
      {dateRepairOpen && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-lg p-5 space-y-4">
            <div>
              <h3 className="text-base font-semibold">Review invoice date repair</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                This invoice has a non-standard historical timestamp that may have shifted
                its calendar day. Confirm the intended dates below. No totals, status,
                statement rules, or other invoice fields will change.
              </p>
            </div>
            <div className="rounded-md border border-border overflow-hidden text-sm">
              <div className="grid grid-cols-3 gap-3 bg-secondary/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                <span>Date</span>
                <span>Currently shown</span>
                <span>Corrected date</span>
              </div>
              <div className="grid grid-cols-3 gap-3 items-center px-3 py-3 border-t border-border">
                <span className="font-medium">Issue date</span>
                <span>{formatInvoiceDate(detailQuery.data?.issuedAt ?? invoice.issuedAt)}</span>
                <input
                  type="date"
                  value={repairIssuedAt}
                  onChange={(e) => setRepairIssuedAt(e.target.value)}
                  disabled={!isLikelyLegacyShiftedInvoiceDate(
                    detailQuery.data?.issuedAt ?? invoice.issuedAt,
                    detailQuery.data?.createdAt ?? invoice.createdAt,
                  )}
                  className="h-9 px-2 rounded-md bg-background border border-input"
                />
              </div>
              <div className="grid grid-cols-3 gap-3 items-center px-3 py-3 border-t border-border">
                <span className="font-medium">Due date</span>
                <span>
                  {formatInvoiceDate(
                    detailQuery.data?.dueAt ??
                      detailQuery.data?.dueDate ??
                      invoice.dueAt ??
                      invoice.dueDate,
                  )}
                </span>
                <input
                  type="date"
                  value={repairDueAt}
                  onChange={(e) => setRepairDueAt(e.target.value)}
                  disabled={!isLikelyLegacyShiftedInvoiceDate(
                    detailQuery.data?.dueAt ??
                      detailQuery.data?.dueDate ??
                      invoice.dueAt ??
                      invoice.dueDate,
                    detailQuery.data?.createdAt ?? invoice.createdAt,
                  )}
                  className="h-9 px-2 rounded-md bg-background border border-input"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Saving creates a dedicated audit record with the previous and corrected dates.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDateRepairOpen(false)}
                disabled={dateRepairMutation.isPending}
                className="h-9 px-4 rounded-md bg-secondary text-secondary-foreground text-sm font-medium hover:bg-secondary/80 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => dateRepairMutation.mutate()}
                disabled={
                  dateRepairMutation.isPending ||
                  (isLikelyLegacyShiftedInvoiceDate(
                    detailQuery.data?.issuedAt ?? invoice.issuedAt,
                    detailQuery.data?.createdAt ?? invoice.createdAt,
                  ) &&
                    !repairIssuedAt) ||
                  (isLikelyLegacyShiftedInvoiceDate(
                    detailQuery.data?.dueAt ??
                      detailQuery.data?.dueDate ??
                      invoice.dueAt ??
                      invoice.dueDate,
                    detailQuery.data?.createdAt ?? invoice.createdAt,
                  ) &&
                    !repairDueAt) ||
                  !hasInvoiceDateRepairChanges({
                    issuedAt: detailQuery.data?.issuedAt ?? invoice.issuedAt,
                    dueAt:
                      detailQuery.data?.dueAt ??
                      detailQuery.data?.dueDate ??
                      invoice.dueAt ??
                      invoice.dueDate,
                    createdAt: detailQuery.data?.createdAt ?? invoice.createdAt,
                    repairedIssuedAt: repairIssuedAt,
                    repairedDueAt: repairDueAt,
                  })
                }
                className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {dateRepairMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                Confirm and save dates
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingDiscard && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
            <h3 className="text-base font-semibold">Discard changes?</h3>
            <p className="text-sm text-muted-foreground">
              You have unsaved edits to this invoice. If you leave now, your
              changes will be lost.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setPendingDiscard(null)}
                className="h-9 px-4 rounded-md bg-secondary text-secondary-foreground text-sm font-medium hover:bg-secondary/80"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={() => {
                  const proceed = pendingDiscard;
                  setPendingDiscard(null);
                  if (inline) resetDraft();
                  proceed();
                }}
                className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90"
              >
                Discard changes
              </button>
            </div>
          </div>
        </div>
      )}

      {showCreateItemModal && (
        <CreateTierItemModal
          labOrganizationId={invoice.labOrganizationId}
          onClose={() => setShowCreateItemModal(false)}
          onCreated={(newItem) => {
            setItems((prev) => [
              ...prev,
              {
                item: newItem.name,
                description: newItem.description,
                quantity: 1,
                unitPrice: String(newItem.unitPrice),
              },
            ]);
            setShowCreateItemModal(false);
          }}
        />
      )}
    </InvoiceEditorPresentation>
  );
}

function VoidConfirmDialog({
  kind,
  pending,
  onCancel,
  onConfirm,
}: {
  kind: "void" | "writeoff";
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const isWriteoff = kind === "writeoff";
  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
        <h3 className="text-base font-semibold">
          {isWriteoff ? "Write off remaining balance?" : "Void this invoice?"}
        </h3>
        <p className="text-sm text-muted-foreground">
          {isWriteoff
            ? "This issues a write-off credit equal to the remaining balance and marks the invoice as settled. Any deposit linked to this invoice will be reversed."
            : "Voiding marks this invoice as cancelled and reverses any linked deposit. This is reversible only by re-creating the invoice."}
        </p>
        <div>
          <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
            Reason {isWriteoff ? "(optional)" : "(required)"}
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 rounded-md bg-background border border-input text-sm resize-y"
            placeholder={isWriteoff ? "e.g. small balance write-off" : "e.g. duplicate invoice"}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reason.trim())}
            disabled={pending || (!isWriteoff && reason.trim().length === 0)}
            className={`h-9 px-3 rounded-md text-sm font-medium text-white disabled:opacity-50 ${isWriteoff ? "bg-primary hover:bg-primary/90" : "bg-destructive hover:bg-destructive/90"}`}
          >
            {pending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : isWriteoff ? (
              "Write off"
            ) : (
              "Void"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export function StatementBuilderDialog({
  knownLabOrgId,
  knownPracticeId,
  onClose,
}: {
  knownLabOrgId?: string;
  /** When provided the practice selector is pre-populated and locked. */
  knownPracticeId?: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
  });
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const [providerOrgId, setProviderOrgId] = useState(knownPracticeId ?? "");
  const [periodStart, setPeriodStart] = useState(
    firstOfMonth.toISOString().slice(0, 10),
  );
  const [periodEnd, setPeriodEnd] = useState(today.toISOString().slice(0, 10));
  const [openOnly, setOpenOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<PracticeStatement | null>(null);
  const [emailTo, setEmailTo] = useState("");
  const [smsTo, setSmsTo] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  // Defaults captured at mount so the dirty check treats an edited-then-reverted
  // field as clean, mirroring the InvoiceEditor safe-exit behavior.
  const initialPeriodStartRef = useRef(periodStart);
  const initialPeriodEndRef = useRef(periodEnd);

  // Any user-entered selection or recipient counts as unsaved input. A
  // generated statement is already persisted server-side, so it doesn't count.
  // When the practice was pre-populated via knownPracticeId it is not dirty.
  const isDirty =
    (knownPracticeId ? false : providerOrgId !== "") ||
    periodStart !== initialPeriodStartRef.current ||
    periodEnd !== initialPeriodEndRef.current ||
    !openOnly ||
    emailTo.trim() !== "" ||
    smsTo.trim() !== "";

  // Close the dialog, prompting to discard first if there is unsaved input so a
  // stray Escape or Close can't silently throw away a half-filled form.
  const requestClose = useCallback(() => {
    if (isDirty) setConfirmClose(true);
    else onClose();
  }, [isDirty, onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (confirmClose) setConfirmClose(false);
      else requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmClose, requestClose]);

  const labOrgId = useMemo(() => {
    if (knownLabOrgId) return knownLabOrgId;
    return orgsQuery.data?.find((o) => o.type === "lab")?.id ?? "";
  }, [knownLabOrgId, orgsQuery.data]);

  const practiceOrgs = useMemo(
    () => (orgsQuery.data ?? []).filter((o) => o.type === "provider"),
    [orgsQuery.data],
  );

  // Fetch the full org record for the selected practice so we can read
  // additionalEmails (not returned by the list endpoint).
  const practiceOrgQuery = useQuery({
    queryKey: ["organizations", providerOrgId],
    queryFn: () => apiFetch<Organization>(`/organizations/${providerOrgId}`),
    enabled: !!providerOrgId,
  });
  const billingCcEmails = useMemo(
    () =>
      (practiceOrgQuery.data?.additionalEmails ?? []).filter(
        (e) => e.type === "billing",
      ),
    [practiceOrgQuery.data],
  );

  const practiceName = useMemo(() => {
    return practiceOrgs.find((o) => o.id === providerOrgId)?.name || "Practice";
  }, [practiceOrgs, providerOrgId]);

  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch<{ statements: PracticeStatement[] }>(
        "/invoices/practice-statements/generate",
        {
          method: "POST",
          body: JSON.stringify({
            labOrganizationId: labOrgId,
            providerOrganizationIds: [providerOrgId],
            periodStart: new Date(periodStart).toISOString(),
            periodEnd: new Date(periodEnd).toISOString(),
            includeStatuses: openOnly
              ? ["open", "partially_paid"]
              : ["open", "partially_paid", "paid"],
          }),
        },
      );
      return res.statements?.[0] ?? null;
    },
    onSuccess: (s) => {
      setGenerated(s);
      queryClient.invalidateQueries({ queryKey: ["statements"] });
    },
    onError: (e: Error) => setError(e.message || "Failed to generate"),
  });

  const sendEmailMutation = useMutation({
    mutationFn: () => {
      if (!generated) throw new Error("Generate a statement first.");
      return apiFetch(
        `/invoices/practice-statements/${generated.id}/email`,
        {
          method: "POST",
          body: JSON.stringify({
            to: emailTo.trim(),
            subject: `Statement for ${practiceName}`,
            message: `Please find your account statement for ${periodStart} – ${periodEnd} attached.`,
          }),
        },
      );
    },
    onError: (e: Error) => setError(e.message || "Email failed"),
  });

  const sendSmsMutation = useMutation({
    mutationFn: () => {
      if (!generated) throw new Error("Generate a statement first.");
      const balance = Number(generated.balanceDue || 0);
      return apiFetch(
        `/invoices/practice-statements/${generated.id}/sms`,
        {
          method: "POST",
          body: JSON.stringify({
            to: smsTo.trim(),
            message: `${practiceName}: account statement for ${periodStart} – ${periodEnd}. Balance due ${formatMoney(balance)}. Reply with any questions.`,
          }),
        },
      );
    },
    onError: (e: Error) => setError(e.message || "SMS failed"),
  });

  function submit() {
    setError(null);
    if (!labOrgId) {
      setError("No lab organization found.");
      return;
    }
    if (!providerOrgId) {
      setError("Pick a practice.");
      return;
    }
    generateMutation.mutate();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-lg w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between">
          <h3 className="text-base font-semibold">Build practice statement</h3>
          <button
            type="button"
            onClick={requestClose}
            className="h-8 w-8 inline-flex items-center justify-center rounded hover:bg-secondary"
            aria-label="Close without saving"
          >
            <X size={16} />
          </button>
        </div>

        {error && (
          <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
            {error}
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
              Practice
            </label>
            <select
              value={providerOrgId}
              onChange={(e) => setProviderOrgId(e.target.value)}
              disabled={!!knownPracticeId}
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm disabled:opacity-60 disabled:cursor-default"
            >
              <option value="">Select practice…</option>
              {practiceOrgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Period start
              </label>
              <input
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Period end
              </label>
              <input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
            </div>
          </div>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={openOnly}
              onChange={(e) => setOpenOnly(e.target.checked)}
            />
            Include only open invoices
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={generateMutation.isPending}
            className="h-9 px-3 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {generateMutation.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <FileText size={14} />
            )}
            Generate statement
          </button>
        </div>

        {generated && (
          <div className="border-t border-border pt-4 space-y-3">
            <div className="text-sm">
              <div className="font-medium">Statement generated</div>
              <div className="text-xs text-muted-foreground">
                {generated.invoiceCount} invoice
                {generated.invoiceCount === 1 ? "" : "s"} · billed{" "}
                {formatMoney(Number(generated.totalBilled || 0))} · balance{" "}
                {formatMoney(Number(generated.balanceDue || 0))}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  Email recipient
                </label>
                <div className="flex gap-2">
                  <input
                    type="email"
                    value={emailTo}
                    onChange={(e) => setEmailTo(e.target.value)}
                    placeholder="practice@example.com"
                    className="flex-1 h-9 px-2.5 rounded-md bg-background border border-input text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => sendEmailMutation.mutate()}
                    disabled={sendEmailMutation.isPending || !emailTo.trim()}
                    className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary border border-border disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    <Mail size={14} /> Email
                  </button>
                </div>
                {billingCcEmails.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <span className="text-[11px] text-muted-foreground">Auto-CC:</span>
                    {billingCcEmails.map((e) => (
                      <span
                        key={e.id}
                        className="inline-flex items-center h-5 px-2 rounded-full bg-secondary border border-border text-[11px] text-muted-foreground"
                      >
                        {e.email}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  SMS recipient
                </label>
                <div className="flex gap-2">
                  <input
                    type="tel"
                    value={smsTo}
                    onChange={(e) => setSmsTo(e.target.value)}
                    placeholder="+15551234567"
                    className="flex-1 h-9 px-2.5 rounded-md bg-background border border-input text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => sendSmsMutation.mutate()}
                    disabled={sendSmsMutation.isPending || !smsTo.trim()}
                    className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary border border-border disabled:opacity-50"
                  >
                    SMS
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {confirmClose && (
        <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
            <h3 className="text-base font-semibold">Discard changes?</h3>
            <p className="text-sm text-muted-foreground">
              You have unsaved input on this statement. If you close now, your
              changes will be lost.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setConfirmClose(false)}
                className="h-9 px-4 rounded-md bg-secondary text-secondary-foreground text-sm font-medium hover:bg-secondary/80"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmClose(false);
                  onClose();
                }}
                className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90"
              >
                Discard changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EmailInvoiceDialog({
  invoice,
  practiceName,
  buildPdfOptions,
  onClose,
}: {
  invoice: Invoice;
  practiceName: string;
  buildPdfOptions: () => InvoicePdfOptions;
  onClose: () => void;
}) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState(
    `Invoice ${invoice.invoiceNumber}`,
  );
  const [message, setMessage] = useState(
    `Hi ${practiceName},\n\nPlease find invoice ${invoice.invoiceNumber} attached.\n\nThank you,`,
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<string | null>(null);

  async function send() {
    setError(null);
    setSending(true);
    try {
      const built = buildInvoicePdf(buildPdfOptions());
      const trimmedTo = to.trim();
      const res = await apiFetch<{ sentAt: string; to: string }>(
        `/invoices/${invoice.id}/email`,
        {
          method: "POST",
          body: JSON.stringify({
            ...(trimmedTo ? { to: trimmedTo } : {}),
            subject: subject.trim(),
            message,
            filename: built.filename,
            pdfBase64: built.base64,
          }),
        },
      );
      setSentAt(res.sentAt);
      setTo(res.to);
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.message
          : (e as Error)?.message || "Failed to send.";
      setError(msg);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-foreground/40">
      <div className="w-full max-w-lg bg-card border border-border rounded-xl shadow-xl flex flex-col max-h-[90vh]">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Email invoice</div>
            <div className="text-sm font-semibold font-mono">
              {invoice.invoiceNumber}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
          >
            <X size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {sentAt ? (
            <div className="rounded-md border border-success/40 bg-success/10 px-3 py-3 text-sm">
              <div className="font-medium text-success">Invoice sent.</div>
              <div className="text-xs text-muted-foreground mt-1">
                Delivered to {to} at {formatDateTime(sentAt)}.
              </div>
            </div>
          ) : (
            <>
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                  To
                </span>
                <input
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="Leave blank to use the practice's billing email on file"
                  className="mt-1 w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
                />
              </label>
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                  Subject
                </span>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="mt-1 w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
                />
              </label>
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                  Message
                </span>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={8}
                  className="mt-1 w-full px-3 py-2 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary resize-y"
                />
              </label>
              <div className="text-xs text-muted-foreground">
                The invoice PDF will be attached.
              </div>
              {error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}
            </>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary"
          >
            {sentAt ? "Close" : "Cancel"}
          </button>
          {!sentAt && (
            <button
              type="button"
              onClick={send}
              disabled={sending}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {sending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Mail size={14} />
              )}
              {sending ? "Sending…" : "Send email"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

const PAYMENT_METHODS = [
  { value: "check", label: "Check" },
  { value: "ach", label: "ACH / Bank Transfer" },
  { value: "card", label: "Card" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
] as const;

function RecordPaymentDialog({
  invoice,
  onClose,
  onRecorded,
}: {
  invoice: Invoice;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const labOrgId = invoice.labOrganizationId ?? null;
  const accountsQuery = useBankAccounts(labOrgId);
  const settingsQuery = useQuery({
    queryKey: ["finance", "settings", labOrgId],
    queryFn: () =>
      apiFetch<{ defaultBankAccountId: string | null }>(
        `/finance/settings?organizationId=${labOrgId}`
      ),
    enabled: !!labOrgId,
  });

  const activeAccounts = (accountsQuery.data ?? []).filter(
    (a) => !a.isArchived
  );

  const defaultAccountId = settingsQuery.data?.defaultBankAccountId ?? null;

  const balanceDue = Number(invoice.balanceDue ?? invoice.total ?? 0);
  const [amount, setAmount] = useState<string>(
    balanceDue > 0 ? balanceDue.toFixed(2) : "",
  );
  const [method, setMethod] = useState<string>("check");
  const [reference, setReference] = useState("");
  const [depositAccountId, setDepositAccountId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Once we know the default account, pre-select it
  useEffect(() => {
    if (!depositAccountId && defaultAccountId) {
      setDepositAccountId(defaultAccountId);
    }
  }, [defaultAccountId, depositAccountId]);

  // If no default is set but accounts loaded, pick the first non-Undeposited Funds account
  useEffect(() => {
    if (!depositAccountId && activeAccounts.length > 0 && settingsQuery.isFetched) {
      const first = activeAccounts.find((a) => a.accountType !== "undeposited_funds") ?? activeAccounts[0];
      if (first) setDepositAccountId(first.id);
    }
  }, [activeAccounts, depositAccountId, settingsQuery.isFetched]);

  async function submit() {
    const parsed = parseFloat(amount);
    if (!parsed || parsed <= 0) {
      setError("Enter a valid payment amount.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await apiFetch(`/invoices/${invoice.id}/payments`, {
        method: "POST",
        body: JSON.stringify({
          amount: parsed,
          paymentMethod: method,
          ...(reference.trim() ? { referenceNumber: reference.trim() } : {}),
          ...(depositAccountId ? { depositBankAccountId: depositAccountId } : {}),
        }),
      });
      onRecorded();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to record payment.");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-foreground/40">
      <div className="w-full max-w-md bg-card border border-border rounded-xl shadow-xl flex flex-col">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Record payment</div>
            <div className="text-sm font-semibold font-mono">{invoice.invoiceNumber}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
          >
            <X size={16} />
          </button>
        </header>
        <div className="px-5 py-4 space-y-4">
          {balanceDue > 0 && (
            <div className="rounded-md bg-secondary/60 px-3 py-2 text-sm flex items-center justify-between">
              <span className="text-muted-foreground">Balance due</span>
              <span className="font-semibold tabular-nums">{formatMoney(balanceDue)}</span>
            </div>
          )}
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Amount</span>
            <div className="relative mt-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
              <input
                type="number"
                min={0.01}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full h-9 pl-7 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary tabular-nums"
                placeholder="0.00"
                autoFocus
              />
            </div>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Method</span>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="mt-1 w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
              Reference # <span className="normal-case text-muted-foreground font-normal">(optional)</span>
            </span>
            <input
              type="text"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Check #, confirmation #…"
              className="mt-1 w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
            />
          </label>
          {activeAccounts.length > 0 && (
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                Deposit to account
              </span>
              <select
                value={depositAccountId}
                onChange={(e) => setDepositAccountId(e.target.value)}
                className="mt-1 w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
              >
                {activeAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.id === defaultAccountId ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <CreditCard size={14} />}
            {saving ? "Saving…" : "Record Payment"}
          </button>
        </footer>
      </div>

    </div>
  );
}

export function CreateInvoiceDialog({
  knownLabOrgId,
  onClose,
  onCreated,
}: {
  knownLabOrgId?: string;
  onClose: () => void;
  onCreated: (inv: Invoice) => void;
}) {
  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
  });

  const labOrgs = (orgsQuery.data ?? []).filter((o) => o.type === "lab");
  const providerOrgs = (orgsQuery.data ?? []).filter((o) => o.type === "provider");

  const defaultLabId = knownLabOrgId ?? labOrgs[0]?.id ?? "";

  const [labOrgId, setLabOrgId] = useState(defaultLabId);
  const [providerOrgId, setProviderOrgId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [issuedAt, setIssuedAt] = useState(invoiceTimestampToDateInput(new Date().toISOString()));
  const [dueAt, setDueAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  // Issue date defaults to today; capture it so reverting back to the default
  // reads as clean, mirroring the InvoiceEditor safe-exit behavior.
  const initialIssuedAtRef = useRef(issuedAt);

  useEffect(() => {
    if (!labOrgId && labOrgs.length) setLabOrgId(labOrgs[0].id);
  }, [labOrgs, labOrgId]);

  // The lab is auto-selected, so it doesn't count as unsaved input. Any
  // practice, invoice number, changed issue date, or due date does.
  const isDirty =
    providerOrgId !== "" ||
    invoiceNumber.trim() !== "" ||
    issuedAt !== initialIssuedAtRef.current ||
    dueAt !== "";

  // Close the dialog, prompting to discard first if there is unsaved input so a
  // stray Escape or Close can't silently throw away a half-filled form.
  const requestClose = useCallback(() => {
    if (isDirty) setConfirmClose(true);
    else onClose();
  }, [isDirty, onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (confirmClose) setConfirmClose(false);
      else requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmClose, requestClose]);

  async function submit() {
    if (!invoiceNumber.trim()) { setError("Invoice number is required."); return; }
    if (!providerOrgId) { setError("Select a client / practice."); return; }
    if (!labOrgId) { setError("No lab organization found."); return; }
    setError(null);
    setSaving(true);
    try {
      const inv = await apiFetch<Invoice>("/invoices", {
        method: "POST",
        body: JSON.stringify({
          invoiceNumber: invoiceNumber.trim(),
          labOrganizationId: labOrgId,
          providerOrganizationId: providerOrgId,
          issuedAt: invoiceDateInputToTimestamp(issuedAt) ?? undefined,
          dueAt: invoiceDateInputToTimestamp(dueAt) ?? undefined,
        }),
      });
      onCreated(inv);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to create invoice.");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-foreground/40">
      <div className="w-full max-w-md bg-card border border-border rounded-xl shadow-xl flex flex-col">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="text-sm font-semibold">New Invoice</div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close without saving"
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
          >
            <X size={16} />
          </button>
        </header>
        <div className="px-5 py-4 space-y-4">
          {labOrgs.length > 1 && (
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Lab</span>
              <select
                value={labOrgId}
                onChange={(e) => setLabOrgId(e.target.value)}
                className="mt-1 w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
              >
                {labOrgs.map((o) => (
                  <option key={o.id} value={o.id}>{o.displayName || o.name}</option>
                ))}
              </select>
            </label>
          )}
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Client / Practice</span>
            <select
              value={providerOrgId}
              onChange={(e) => setProviderOrgId(e.target.value)}
              className="mt-1 w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
            >
              <option value="">Select a practice…</option>
              {providerOrgs.map((o) => (
                <option key={o.id} value={o.id}>{o.displayName || o.name}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Invoice Number</span>
            <input
              type="text"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="e.g. INV-2026-001"
              className="mt-1 w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary font-mono"
              autoFocus
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Issue Date</span>
              <input
                type="date"
                value={issuedAt}
                onChange={(e) => setIssuedAt(e.target.value)}
                className="mt-1 w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
              />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                Due Date <span className="normal-case font-normal">(optional)</span>
              </span>
              <input
                type="date"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
                className="mt-1 w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
              />
            </label>
          </div>
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Add line items in the editor.
          </p>
        </div>
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            type="button"
            onClick={requestClose}
            className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || orgsQuery.isLoading}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {saving ? "Creating…" : "Create Invoice"}
          </button>
        </footer>
      </div>

      {confirmClose && (
        <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
            <h3 className="text-base font-semibold">Discard changes?</h3>
            <p className="text-sm text-muted-foreground">
              You have unsaved input on this invoice. If you close now, your
              changes will be lost.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setConfirmClose(false)}
                className="h-9 px-4 rounded-md bg-secondary text-secondary-foreground text-sm font-medium hover:bg-secondary/80"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmClose(false);
                  onClose();
                }}
                className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90"
              >
                Discard changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
