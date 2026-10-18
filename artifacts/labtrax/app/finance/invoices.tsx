import React, { useEffect, useMemo, useRef, useState } from "react";
import { AppState, Modal, Platform, useWindowDimensions, View, Text, StyleSheet, ScrollView, Pressable, Switch, TextInput, Keyboard } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { FINANCE_INVOICES_QUERY_KEY, useInvoiceBrowserPage, useInvoiceFilterFacets, usePagedInvoices, type CanonicalInvoice, type UseInvoicesParams } from "@workspace/api-client-react";
import { newInvoiceDesktopUrl } from "@/lib/invoice-web-export";
import { resilientFetch, throwIfResNotOk } from "@/lib/query-client";
import { INVOICE_PAGE_SIZES, fetchAllInvoiceRows, invoicesToCsv, parseInvoicePage, pagerItems, type ExportProgress } from "@/lib/invoice-web-export";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";
import { ListScreen, type ListScreenQuery } from "@/components/ui/ListScreen";
import { ColumnTotals } from "@/components/ui/ColumnTotals";
import { FormSheet } from "@/components/ui/FormSheet";
import { invoiceLayoutMode } from "@/lib/invoice-web-fields";
import { InvoiceWideToolbar, WebSelect } from "@/components/invoices-web/InvoiceWideControls";
import { InvoiceSummaryCards } from "@/components/invoices-web/InvoiceSummaryCards";
import { InvoiceRegisterRow, InvoiceRegisterColumns } from "@/components/invoices-web/InvoiceRegisterRow";
import { InvoiceDetailPanel } from "@/components/invoices-web/InvoiceDetailPanel";
import { DateField } from "@/components/DateField";
import { roleCanEdit, canEditOrg, useMe, primaryLabOrgId, primaryProviderOrgId, canAdminAnyLab } from "@/lib/auth-me";
import { titleCase, formatMoney, formatDate } from "@/lib/format";
import {
  UNIFIED_STATUS_FILTERS, DATE_FILTERS, OVERDUE_FILTERS, dateFilterLabel, overdueFilterLabel,
   parseDateInput, dateRangeForFilter, customerNameOf, doctorNameOf,
   getLocalTimeZone,
   formatInvoiceIssueDate,
  millisecondsUntilNextLocalMidnight,
  invoiceStatusSelectionToLegacy,
  transitionInvoiceStatusSelection,
  type InvoiceDateFilter,
  type InvoiceOverdueFilter, type InvoiceSortField, type InvoiceSortDirection,
  type InvoiceStatusSelection,
} from "@/lib/invoice-filters";

type FilterDraft = {
  practiceId: string;
  doctorName: string;
  aiOnly: boolean;
  date: InvoiceDateFilter;
  dateStart: string;
  dateEnd: string;
  overdue: InvoiceOverdueFilter;
  overdueStart: string;
  overdueEnd: string;
};

const EMPTY_FILTERS: FilterDraft = {
  practiceId: "", doctorName: "", aiOnly: false,
  date: "all", dateStart: "", dateEnd: "",
  overdue: "all", overdueStart: "", overdueEnd: "",
};

type InvoiceRegisterSnapshot = {
  statusSelection: InvoiceStatusSelection;
  search: string;
  filters: FilterDraft;
  sort: InvoiceSortField;
  sortDirection: InvoiceSortDirection;
  scrollOffset: number;
};

const invoiceRegisterSnapshots = new Map<string, InvoiceRegisterSnapshot>();
const INVOICE_SEARCH_DEBOUNCE_MS = 300;

function emptySnapshot(): InvoiceRegisterSnapshot {
  return {
    statusSelection: { kind: "all" },
    search: "",
    filters: { ...EMPTY_FILTERS },
    sort: "issued",
    sortDirection: "desc",
    scrollOffset: 0,
  };
}

function accountIdentity(me: ReturnType<typeof useMe>["data"]): string {
  const user = me?.user;
  if (!user || typeof user !== "object") return "anonymous";
  const id = (user as { id?: unknown }).id;
  return typeof id === "string" ? id : "anonymous";
}

export function resetInvoiceRegisterSnapshotsForTests(): void {
  invoiceRegisterSnapshots.clear();
}

export function seedInvoiceRegisterFiltersForTests(filters: Partial<FilterDraft>): void {
  const snapshot = emptySnapshot();
  invoiceRegisterSnapshots.set("anonymous:lab:lab-1", {
    ...snapshot,
    filters: { ...EMPTY_FILTERS, ...filters },
  });
}
function invoiceVariant(status?: string | null): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s.includes("paid")) return "paid";
  if (s.includes("overdue") || s.includes("past")) return "overdue";
  if (s.includes("void") || s.includes("cancel")) return "void";
  return "unpaid";
}

export default function InvoicesScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const me = useMe().data;
  const routeParams = useLocalSearchParams<{
    invoiceId?: string | string[];
    fromSalesReport?: string | string[];
  }>();
  const routeInvoiceId = Array.isArray(routeParams.invoiceId)
    ? routeParams.invoiceId[0] ?? null
    : routeParams.invoiceId ?? null;
  const openedFromSalesReport = (Array.isArray(routeParams.fromSalesReport)
    ? routeParams.fromSalesReport[0]
    : routeParams.fromSalesReport) === "1";
  const labOrgId = primaryLabOrgId(me);
  const providerOrgId = primaryProviderOrgId(me);
  const scopeKey = `${accountIdentity(me)}:${labOrgId ? `lab:${labOrgId}` : providerOrgId ? `provider:${providerOrgId}` : "unscoped"}`;
  const initialSnapshotRef = useRef(invoiceRegisterSnapshots.get(scopeKey) ?? emptySnapshot());
  const activeScopeRef = useRef(scopeKey);
  const skipNextPersistenceRef = useRef(false);
  const [statusSelection, setStatusSelection] = useState<InvoiceStatusSelection>(
    initialSnapshotRef.current.statusSelection,
  );
  const [search, setSearch] = useState(initialSnapshotRef.current.search);
  const [requestedSearch, setRequestedSearch] = useState(initialSnapshotRef.current.search.trim());
  const [filters, setFilters] = useState<FilterDraft>(initialSnapshotRef.current.filters);
  const [draft, setDraft] = useState<FilterDraft>(initialSnapshotRef.current.filters);
  const [draftStatusSelection, setDraftStatusSelection] = useState<InvoiceStatusSelection>(
    initialSnapshotRef.current.statusSelection,
  );
  const { view, statuses } = invoiceStatusSelectionToLegacy(statusSelection);
  const { view: draftView, statuses: draftStatuses } =
    invoiceStatusSelectionToLegacy(draftStatusSelection);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [sortSheetOpen, setSortSheetOpen] = useState(false);
  const [sort, setSort] = useState<InvoiceSortField>(initialSnapshotRef.current.sort);
  const [sortDirection, setSortDirection] = useState<InvoiceSortDirection>(initialSnapshotRef.current.sortDirection);
  const scrollOffsetRef = useRef(initialSnapshotRef.current.scrollOffset);
  const [dateRefreshTick, setDateRefreshTick] = useState(0);
  const localTimeZoneRef = useRef(getLocalTimeZone());
  const datePresetRef = useRef(filters.date);
  datePresetRef.current = filters.date;

  const isWeb = Platform.OS === "web";
  const isAdminOrOwner = canAdminAnyLab(me);
  const { width: windowWidth } = useWindowDimensions();
  const wideWeb = isWeb && invoiceLayoutMode(windowWidth) === "side";
  const wideControls = isWeb && windowWidth >= 1100;
  const [selectedId, setSelectedId] = useState<string | null>(routeInvoiceId);
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  const canUseAdvancedFilters = Boolean(labOrgId);
  // Keep the compact view toggles for the lightweight/provider route and for
  // fully hydrated lab memberships. Auth-route fixtures can carry only the
  // membership type; in that shape the filter sheet is the compatibility UI.
  const showViewControls = !isWeb && (!canUseAdvancedFilters ||
    Boolean(me?.memberships?.some((membership) =>
      membership.organization?.id === labOrgId,
    )));

  useEffect(() => {
    if (routeInvoiceId) setSelectedId(routeInvoiceId);
  }, [routeInvoiceId]);

  useEffect(() => {
    if (activeScopeRef.current === scopeKey) return;
    activeScopeRef.current = scopeKey;
    skipNextPersistenceRef.current = true;
    const next = invoiceRegisterSnapshots.get(scopeKey) ?? emptySnapshot();
    setStatusSelection(next.statusSelection);
    setSearch(next.search);
    setRequestedSearch(next.search.trim());
    setFilters(next.filters);
    setDraft(next.filters);
    setDraftStatusSelection(next.statusSelection);
    setSort(next.sort);
    setSortDirection(next.sortDirection);
    scrollOffsetRef.current = next.scrollOffset;
    setFilterSheetOpen(false);
    setSortSheetOpen(false);
    setSelectedId(null);
  }, [scopeKey]);

  useEffect(() => {
    const trimmedSearch = search.trim();
    if (!trimmedSearch) {
      setRequestedSearch("");
      return;
    }
    const timeout = setTimeout(() => {
      setRequestedSearch(trimmedSearch);
    }, INVOICE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    if (skipNextPersistenceRef.current) {
      skipNextPersistenceRef.current = false;
      return;
    }
    invoiceRegisterSnapshots.set(scopeKey, {
      statusSelection,
      search,
      filters: { ...filters },
      sort,
      sortDirection,
      scrollOffset: scrollOffsetRef.current,
    });
  }, [scopeKey, statusSelection, search, filters, sort, sortDirection]);

  useEffect(() => {
    if (filters.date !== "today" && filters.date !== "yesterday") return;
    const timeout = setTimeout(
      () => setDateRefreshTick((tick) => tick + 1),
      millisecondsUntilNextLocalMidnight(new Date()),
    );
    return () => clearTimeout(timeout);
  }, [filters.date, dateRefreshTick]);

  const dateRange = dateRangeForFilter(
    filters.date,
    new Date(),
    parseDateInput(filters.dateStart),
    parseDateInput(filters.dateEnd),
  );
  const params = useMemo<UseInvoicesParams>(() => {
    const next: UseInvoicesParams = labOrgId
      ? { labOrganizationId: labOrgId }
      : providerOrgId
        ? { practiceId: providerOrgId }
        : {};
    const requestStatuses = view === "outstanding"
      ? ["open"]
      : view === "open"
        ? ["open"]
        : statuses;
    if (requestStatuses.length) next.status = requestStatuses.join(",");
    if (view === "open" || view === "outstanding") next.view = view;
    if (requestedSearch) next.search = requestedSearch;
    if (filters.practiceId) next.practiceId = filters.practiceId;
    if (filters.doctorName) next.doctorName = filters.doctorName;
    if (filters.aiOnly) next.aiOnly = true;
    if (dateRange) {
       next.issuedFrom = dateRange.start.toISOString();
       next.issuedTo = dateRange.end.toISOString();
    }
    if (view !== "outstanding" && filters.overdue !== "all") {
      next.overdueBucket = filters.overdue;
      if (filters.overdue === "custom") {
        next.dueDateFrom = filters.overdueStart;
        next.dueDateTo = filters.overdueEnd;
      }
    }
    next.sortBy = sort;
    next.sortDirection = sortDirection;
    return next;
  }, [labOrgId, providerOrgId, statusSelection, filters, requestedSearch, dateRange?.start.getTime(), dateRange?.end.getTime(), dateRefreshTick, sort, sortDirection]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(25);
  const paramsKey = JSON.stringify(params) + "|" + pageSize;
  const [pagedKey, setPagedKey] = useState(paramsKey);
  if (pagedKey !== paramsKey) {
    setPagedKey(paramsKey);
    setPage(1);
  }
  const nativeQuery = usePagedInvoices(params, { enabled: !isWeb });
  const webQuery = useInvoiceBrowserPage(params, { page, pageSize, enabled: isWeb });
  const query = (isWeb ? webQuery : nativeQuery) as typeof nativeQuery;
  const pageCount = Math.max(1, Math.ceil((query.total ?? 0) / pageSize));
  useEffect(() => {
    if (isWeb && !webQuery.isLoading && page > pageCount) setPage(pageCount);
  }, [isWeb, webQuery.isLoading, query.total, page, pageCount]);
  const queryClient = useQueryClient();
  useEffect(() => {
    const cache = isWeb ? queryClient.getQueryCache?.() : undefined;
    if (!cache) return;
    return cache.subscribe((event) => {
      if (event.type !== "updated") return;
      if ((event as { action?: { type?: string } }).action?.type !== "invalidate") return;
      if (event.query.queryKey[0] !== FINANCE_INVOICES_QUERY_KEY[0]) return;
      setPage(1);
    });
  }, [isWeb, queryClient]);
  const refreshInvoicesRef = useRef(query.refresh);
  refreshInvoicesRef.current = query.refresh;
  const lastDateRefreshTickRef = useRef(dateRefreshTick);
  useEffect(() => {
    if (lastDateRefreshTickRef.current === dateRefreshTick) return;
    lastDateRefreshTickRef.current = dateRefreshTick;
    void refreshInvoicesRef.current();
  }, [dateRefreshTick]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") return;
      const nextTimeZone = getLocalTimeZone();
      if (nextTimeZone === localTimeZoneRef.current) return;
      localTimeZoneRef.current = nextTimeZone;
      if (datePresetRef.current === "today" || datePresetRef.current === "yesterday") {
        setDateRefreshTick((tick) => tick + 1);
      }
    });
    return () => subscription.remove();
  }, []);
  const refreshWebRef = useRef<() => void>(() => {});
  useFocusEffect(React.useCallback(() => {
    if (Platform.OS === "web") refreshWebRef.current();
  }, []));
  const facetsQuery = useInvoiceFilterFacets(
    labOrgId ? { labOrganizationId: labOrgId } : providerOrgId ? { practiceId: providerOrgId } : undefined,
  );

  const practices = facetsQuery.data?.practices ?? [];
  const doctors = facetsQuery.data?.doctors ?? [];

  const filteredQuery: ListScreenQuery<CanonicalInvoice> = query;

  const activeCount = Number(view !== "all") + statuses.length +
    Number(Boolean(filters.practiceId)) + Number(Boolean(filters.doctorName)) +
    Number(filters.aiOnly) + Number(filters.date !== "all") + Number(filters.overdue !== "all");
  const filtersActive = activeCount > 0 || view !== "all" || Boolean(search.trim());
  const displayedInvoices = filteredQuery.data ?? [];

  const openFilters = () => {
    setDraft({ ...filters });
    setDraftStatusSelection(statusSelection);
    setFilterSheetOpen(true);
  };
  const clearAll = () => {
    setStatusSelection({ kind: "all" }); setSearch(""); setFilters(EMPTY_FILTERS); setDraft(EMPTY_FILTERS);
  };
  const dateInvalid = draft.date === "custom" && (
    !parseDateInput(draft.dateStart) || !parseDateInput(draft.dateEnd) ||
    parseDateInput(draft.dateEnd)!.getTime() < parseDateInput(draft.dateStart)!.getTime()
  );
  const overdueInvalid = draft.overdue === "custom" && (
    !parseDateInput(draft.overdueStart) || !parseDateInput(draft.overdueEnd) ||
    parseDateInput(draft.overdueEnd)!.getTime() < parseDateInput(draft.overdueStart)!.getTime()
  );

  const webSummary = query.summary;
  const canWriteInvoices = roleCanEdit(me?.memberships?.find((m) => (m.organization?.id ?? (m as { organizationId?: string }).organizationId) === labOrgId)?.role);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => exportAbortRef.current?.abort(), [paramsKey]);
  const runExport = async () => {
    if (exportAbortRef.current) return;
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExportError(null);
    setExportProgress({ loaded: 0, total: null });
    try {
      const rows = await fetchAllInvoiceRows({
        signal: controller.signal,
        onProgress: (p) => { if (!controller.signal.aborted) setExportProgress(p); },
        fetchPage: async ({ limit, offset }) => {
          const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
          for (const [k, v] of Object.entries(params)) {
            if (v === undefined || v === null || v === "" || v === false) continue;
            qs.set(k, String(v));
          }
          const res = await resilientFetch(`/api/invoices?${qs.toString()}`, { signal: controller.signal });
          await throwIfResNotOk(res);
          return parseInvoicePage(await res.json());
        },
      });
      const blob = new Blob([invoicesToCsv(rows)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoices-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      if (!controller.signal.aborted) setExportError(err instanceof Error ? err.message : "Export failed. No file was written.");
    } finally {
      exportAbortRef.current = null;
      setExportProgress(null);
    }
  };
  refreshWebRef.current = () => { if (selectedId) { void query.refresh(); } };
  const manualRefresh = async () => { setDetailRefreshToken((n) => n + 1); return query.refresh(); };
  const headerActionsView = isWeb ? (<View style={[styles.headerActions, wideControls && { paddingBottom: 0, paddingHorizontal: 0, flexWrap: "nowrap" }]} testID="invoice-header-actions">
        {exportProgress ? (
          <Pressable onPress={() => exportAbortRef.current?.abort()} style={styles.headerBtn} testID="invoice-export-cancel" accessibilityRole="button">
            <Text style={styles.headerBtnText}>Exporting {exportProgress.loaded}{exportProgress.total != null ? ` of ${exportProgress.total}` : ""} - Cancel</Text>
          </Pressable>
        ) : (
          <Pressable onPress={() => void runExport()} style={styles.headerBtn} testID="invoice-export" accessibilityRole="button">
            <Text style={styles.headerBtnText}>Export</Text>
          </Pressable>
        )}
        {labOrgId && canWriteInvoices ? <Pressable onPress={() => router.push("/finance/statements" as never)} style={styles.headerBtn} testID="invoice-statements" accessibilityRole="button">
          <Text style={styles.headerBtnText}>Statements</Text>
        </Pressable> : null}
        {canWriteInvoices ? <Pressable onPress={() => window.location.assign(newInvoiceDesktopUrl())} style={[styles.headerBtn, styles.headerBtnPrimary]} testID="invoice-new" accessibilityRole="button">
          <Text style={[styles.headerBtnText, { color: "#fff" }]}>New Invoice</Text>
        </Pressable> : null}
      </View>) : null;
  const selectStatusKey = (key: string) => setStatusSelection(key === "all" ? { kind: "all" } : key === "overdue" ? { kind: "view", view: "outstanding" } : key === "open" ? { kind: "view", view: "open" } : transitionInvoiceStatusSelection({ kind: "all" }, key as Parameters<typeof transitionInvoiceStatusSelection>[1]));
  const openSheetWith = (patch: Partial<FilterDraft>) => { setDraft({ ...filters, ...patch }); setDraftStatusSelection(statusSelection); setFilterSheetOpen(true); };
  const statusKeyNow = statusActiveKey(statusSelection);
  const filterHeader = (
    <View>
      {wideControls ? <View style={styles.wideTop}>
        <View style={[styles.webTitleRow, { flex: 1, paddingBottom: 0 }]} testID="invoice-web-heading">
          <View style={styles.webTitleIcon}><Ionicons name="document-text" size={20} color="#fff" /></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.webTitle} numberOfLines={1}>Invoices</Text>
            <Text style={styles.webSubtitle} numberOfLines={1}>Track billing, payments and statements</Text>
          </View>
        </View>
        {headerActionsView}
      </View> : null}
      {isWeb && !wideControls ? <View style={styles.webTitleRow} testID="invoice-web-heading">
        <View style={styles.webTitleIcon}><Ionicons name="document-text" size={20} color="#fff" /></View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.webTitle} numberOfLines={1}>Invoices</Text>
          <Text style={styles.webSubtitle} numberOfLines={1}>Track billing, payments and statements</Text>
        </View>
      </View> : null}
      {isWeb && !wideControls ? headerActionsView : null}
      {isWeb && exportError ? <Text style={[styles.hint, styles.errorText, { marginHorizontal: Spacing.lg }]} testID="invoice-export-error">{exportError}</Text> : null}
      {isWeb ? <InvoiceSummaryCards summary={webSummary} loading={query.isLoading} /> : <ColumnTotals loading={query.isLoading || query.isFetching} items={[
        { label: "Total", values: displayedInvoices.map((i) => i.total), testID: "column-total-total" },
        { label: "Balance", values: displayedInvoices.map((i) => i.balanceDue ?? i.total), testID: "column-total-balance" },
      ]} />}
      {wideControls ? <InvoiceWideToolbar search={search} onSearch={setSearch}
        statusKey={statusKeyNow} statusOptions={[...STATUS_SELECT_OPTIONS, ...(statusKeyNow === "custom" ? [{ value: "custom", label: "Custom", disabled: true }] : [])]} onStatus={selectStatusKey}
        dateValue={filters.date} dateOptions={DATE_FILTERS.map((o) => ({ value: o.key, label: o.key === "all" ? "All dates" : o.label }))}
        onDate={(v) => v === "custom" ? openSheetWith({ date: "custom" }) : setFilters((f) => ({ ...f, date: v as InvoiceDateFilter, dateStart: "", dateEnd: "" }))}
        ageValue={filters.overdue} ageOptions={OVERDUE_FILTERS.map((o) => ({ value: o.key, label: o.key === "all" ? "Any age" : o.label }))}
        onAge={(v) => v === "custom" ? openSheetWith({ overdue: "custom" }) : setFilters((f) => ({ ...f, overdue: v as InvoiceOverdueFilter, overdueStart: "", overdueEnd: "" }))}
        doctorValue={filters.doctorName} doctorOptions={[{ value: "", label: "All doctors" }, ...doctors.map((n) => ({ value: n, label: n }))]}
        onDoctor={(v) => setFilters((f) => ({ ...f, doctorName: v }))}
        aiOnly={filters.aiOnly} onAiOnly={() => setFilters((f) => ({ ...f, aiOnly: !f.aiOnly }))}
        activeCount={activeCount} onOpenFilters={openFilters} showClear={filtersActive} onClear={clearAll} /> : null}
      {!wideControls ? <View style={styles.searchWrap}>
        <Ionicons name="search" size={17} color={colors.textTertiary} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search invoices"
          placeholderTextColor={colors.textTertiary}
          style={styles.searchInput}
          autoCapitalize="none"
          returnKeyType="search"
          onSubmitEditing={() => Keyboard.dismiss()}
          testID="invoice-search"
          accessibilityLabel="Search invoices"
        />
        {search ? <Pressable onPress={() => setSearch("")} hitSlop={8} testID="search-clear" accessibilityLabel="Clear search">
          <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
        </Pressable> : null}
      </View> : null}
      {!wideControls ? <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.filterRow}>
        {showViewControls ? <>
          <Pressable
            onPress={() => {
              setStatusSelection({ kind: "all" });
            }}
            style={[styles.filterChip, view === "all" && styles.filterChipActive]}
            testID="view-all"
          >
            <Text style={[styles.filterChipText, view === "all" && styles.filterChipTextActive]}>All</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setStatusSelection({ kind: "view", view: "open" });
            }}
            style={[styles.filterChip, view === "open" && styles.filterChipActive]}
            testID="view-open"
          >
            <Text style={[styles.filterChipText, view === "open" && styles.filterChipTextActive]}>Open</Text>
          </Pressable>
        </> : null}
        <Pressable onPress={openFilters} style={[styles.filterChip, styles.iconChip, activeCount > 0 && styles.filterChipActive]}
          testID="filters-open" accessibilityLabel={`Filters${activeCount ? `, ${activeCount} active` : ""}`}>
          <Ionicons name="options-outline" size={15} color={activeCount ? colors.tint : colors.textSecondary} />
          <Text style={[styles.filterChipText, activeCount > 0 && styles.filterChipTextActive]}>
            Filters{activeCount ? ` (${activeCount})` : ""}
          </Text>
        </Pressable>
        {view !== "outstanding" ? <Pressable onPress={() => setStatusSelection((current) => transitionInvoiceStatusSelection(current, "zero_balance"))}
          style={[styles.filterChip, statuses.includes("zero_balance") && styles.filterChipActive]} testID="quick-zero-balance"
          accessibilityRole="checkbox" accessibilityState={{ checked: statuses.includes("zero_balance") }}>
          <Text style={[styles.filterChipText, statuses.includes("zero_balance") && styles.filterChipTextActive]}>$0 Balance</Text>
        </Pressable> : null}
        {view === "all" ? <Pressable onPress={() => setStatusSelection((current) => transitionInvoiceStatusSelection(current, "frozen"))}
          style={[styles.filterChip, statuses.includes("frozen") && styles.filterChipActive]} testID="quick-frozen"
          accessibilityRole="checkbox" accessibilityState={{ checked: statuses.includes("frozen") }}>
          <Text style={[styles.filterChipText, statuses.includes("frozen") && styles.filterChipTextActive]}>Frozen</Text>
        </Pressable> : null}
        <Pressable onPress={() => setSortSheetOpen(true)} style={[styles.filterChip, styles.iconChip]} testID="sort-open"
          accessibilityLabel={`Sort by ${sort}, ${sortDirection === "asc" ? "ascending" : "descending"}`}>
          <Ionicons name="swap-vertical" size={15} color={colors.textSecondary} />
          <Text style={styles.filterChipText}>Sort</Text>
        </Pressable>
        {filtersActive ? <Pressable onPress={clearAll} style={styles.clearChip} testID="clear-all">
          <Text style={styles.clearText}>Clear all</Text>
        </Pressable> : null}
      </ScrollView> : null}
      {isWeb ? <InvoiceStatusTabs summary={webSummary as StatusCountsSummary} selection={statusSelection} onSelect={selectStatusKey} compact={wideControls} styles={styles} /> : null}
      {isWeb ? <InvoicePager page={page} pageCount={pageCount} total={query.total ?? 0} pageSize={pageSize} loading={query.isFetching} onPage={setPage} onPageSize={setPageSize} wide={wideControls} styles={styles} /> : null}
      {isWeb && windowWidth >= 900 ? <InvoiceRegisterColumns total={webSummary?.sumTotal} balance={webSummary?.sumBalance} loading={query.isLoading} /> : null}
    </View>
  );

  const detailPanel = selectedId ? (
    <InvoiceDetailPanel
      invoiceId={selectedId}
      refreshToken={detailRefreshToken}
      onClose={() => {
        if (openedFromSalesReport) {
          router.back();
        } else {
          setSelectedId(null);
        }
      }}
      onEdit={(inv) => router.push(`/invoice-editor/${inv.id}` as never)}
      onRecordPayment={(inv) => { if (inv.caseId) router.push(`/case/${inv.caseId}?recordPaymentInvoiceId=${encodeURIComponent(inv.id)}` as never); }}
    />
  ) : null;

  if (selectedId && !isWeb) {
    return <View style={{ flex: 1 }} testID="invoice-detail-screen">{detailPanel}</View>;
  }

  return (
    <>
      <View style={{ flex: 1, flexDirection: "row" }}>
      <View style={{ flex: 1, minWidth: 0 }}>
      <ListScreen<CanonicalInvoice>
        title={isWeb ? "" : "Invoices"}
        subtitle={isWeb ? undefined : query.isLoading ? "Loading…" : `${query.total} invoice${query.total === 1 ? "" : "s"}`}
        query={filteredQuery}
        hasMore={query.hasNextPage}
        isLoadingMore={query.isFetchingNextPage}
        onLoadMore={query.fetchNextPage}
        onRefresh={manualRefresh}
        initialScrollOffset={scrollOffsetRef.current}
        onScrollOffsetChange={(offset) => {
          scrollOffsetRef.current = offset;
          const saved = invoiceRegisterSnapshots.get(scopeKey);
          if (saved) invoiceRegisterSnapshots.set(scopeKey, { ...saved, scrollOffset: offset });
        }}
        keyExtractor={(i) => i.id}
        emptyIcon="document-text-outline"
        emptyTitle="No invoices"
        emptyBody={filtersActive ? "No invoices match your filters." : "Invoices will appear here once they're created."}
        errorTitle="Couldn't load invoices"
        pinnedHeader={filterHeader}
        renderItem={(i) => isWeb ? (
          <InvoiceRegisterRow invoice={i} selected={selectedId === i.id} wide={windowWidth >= 900}
            canWrite={canEditOrg(me, (i as { labOrganizationId?: string | null }).labOrganizationId)}
            onPress={() => setSelectedId(i.id)}
            onEdit={(inv) => router.push(`/invoice-editor/${inv.id}` as never)}
            onRecordPayment={(inv) => { if (inv.caseId) router.push(`/case/${inv.caseId}?recordPaymentInvoiceId=${encodeURIComponent(inv.id)}` as never); }} />
        ) : (
          <Card style={styles.row} onPress={() => router.push(`/invoice-editor/${i.id}` as never)} testID={`invoice-${i.id}`}>
            <View style={styles.main}>
              <Text style={styles.name} numberOfLines={1}>{i.invoiceNumber || "Invoice"}</Text>
              {customerNameOf(i) ? <Text style={styles.customer} numberOfLines={1}>{customerNameOf(i)}</Text> : null}
               <Text style={styles.meta} numberOfLines={1}>Issued {formatInvoiceIssueDate(i.issuedAt ?? i.createdAt)} · Due {formatDate(i.dueAt)}</Text>
            </View>
            <View style={styles.right}>
              <Text style={styles.amount}>{formatMoney(i.balanceDue ?? i.total)}</Text>
              <View style={styles.badges}>
                <StatusBadge label={titleCase(i.status ?? "—")} variant={invoiceVariant(i.status)} size="sm" />
                {i.frozen ? <View style={[styles.frozenBadge, { backgroundColor: colors.warningLight }]}>
                  <Text style={[styles.frozenText, { color: colors.warning }]}>FROZEN</Text>
                </View> : null}
              </View>
            </View>
          </Card>
        )}
      />
      </View>
      {wideWeb && detailPanel ? <View style={{ width: 360, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border }}>{detailPanel}</View> : null}
      </View>
      {isWeb && !wideWeb && detailPanel ? <Modal visible animationType="slide" onRequestClose={() => setSelectedId(null)}>
        <View style={{ flex: 1 }} accessibilityViewIsModal role="dialog" aria-modal aria-label="Invoice detail" testID="invoice-detail-modal">{detailPanel}</View>
      </Modal> : null}

      <FormSheet visible={filterSheetOpen} title="Filter invoices" onClose={() => setFilterSheetOpen(false)}
        onSubmit={() => { setStatusSelection(draftStatusSelection); setFilters(draft); setFilterSheetOpen(false); }} submitLabel="Apply"
        submitDisabled={dateInvalid || overdueInvalid} testIDPrefix="invoice-filters">
        <FilterSection title="Status" styles={styles}>
          <View style={styles.wrapRow}>
            {UNIFIED_STATUS_FILTERS.filter((o) => isWeb || o.key !== "draft").map((option) => <ChoiceChip key={option.key} label={option.label}
              selected={option.key === "all"
                ? draftStatusSelection.kind === "all"
                : option.key === "open" || option.key === "outstanding"
                  ? draftView === option.key
                  : draftStatuses.includes(option.key)}
              onPress={() => {
                setDraftStatusSelection((current) =>
                  transitionInvoiceStatusSelection(current, option.key),
                );
                if (option.key === "outstanding") {
                  setDraft((d) => ({ ...d, overdue: "all", overdueStart: "", overdueEnd: "" }));
                }
              }}
              styles={styles} testID={`status-option-${option.key}`} />)}
          </View>
        </FilterSection>
        {canUseAdvancedFilters ? <>
          <FilterSection title="Practice" styles={styles}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.horizontalChoices}>
                <ChoiceChip label="Any" selected={!draft.practiceId} onPress={() => setDraft((d) => ({ ...d, practiceId: "" }))} styles={styles} testID="practice-option-all" />
                {practices.map((p) => <ChoiceChip key={p.id} label={p.name} selected={draft.practiceId === p.id}
                  onPress={() => setDraft((d) => ({ ...d, practiceId: p.id }))} styles={styles} testID={`practice-option-${p.id}`} />)}
              </View>
            </ScrollView>
          </FilterSection>
          <FilterSection title="Doctor" styles={styles}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.horizontalChoices}>
                <ChoiceChip label="Any" selected={!draft.doctorName} onPress={() => setDraft((d) => ({ ...d, doctorName: "" }))} styles={styles} testID="doctor-option-all" />
                {doctors.map((name) => <ChoiceChip key={name} label={name} selected={draft.doctorName === name}
                  onPress={() => setDraft((d) => ({ ...d, doctorName: name }))} styles={styles} testID={`doctor-option-${name}`} />)}
              </View>
            </ScrollView>
          </FilterSection>
          <View style={styles.switchRow}>
            <Text style={styles.sectionTitle}>AI-generated only</Text>
            <Switch value={draft.aiOnly} onValueChange={(aiOnly) => setDraft((d) => ({ ...d, aiOnly }))} testID="ai-only-toggle" accessibilityLabel="AI-generated invoices only" />
          </View>
        </> : null}
        <FilterSection title="Issued date" styles={styles}>
          <View style={styles.wrapRow}>
            {DATE_FILTERS.map((option) => <ChoiceChip key={option.key} label={option.label} selected={draft.date === option.key}
              onPress={() => setDraft((d) => ({ ...d, date: option.key }))} styles={styles} testID={`date-option-${option.key}`} />)}
          </View>
          {draft.date === "custom" ? <DateRangeFields prefix="issued" start={draft.dateStart} end={draft.dateEnd}
            onStart={(dateStart) => setDraft((d) => ({ ...d, dateStart }))}
            onEnd={(dateEnd) => setDraft((d) => ({ ...d, dateEnd }))} invalid={dateInvalid} styles={styles} /> : null}
        </FilterSection>
        {canUseAdvancedFilters && draftView !== "outstanding" ? <FilterSection title="Aging" styles={styles}>
          <View style={styles.wrapRow}>
            {OVERDUE_FILTERS.filter((option) => option.key !== "custom" || isAdminOrOwner).map((option) => <ChoiceChip key={option.key} label={option.label} selected={draft.overdue === option.key}
              onPress={() => setDraft((d) => ({ ...d, overdue: option.key }))} styles={styles} testID={`overdue-option-${option.key}`} />)}
          </View>
          {draft.overdue === "custom" ? <DateRangeFields prefix="overdue" start={draft.overdueStart} end={draft.overdueEnd}
            onStart={(overdueStart) => setDraft((d) => ({ ...d, overdueStart }))}
            onEnd={(overdueEnd) => setDraft((d) => ({ ...d, overdueEnd }))} invalid={overdueInvalid} styles={styles} /> : null}
        </FilterSection> : null}
      </FormSheet>

      <FormSheet visible={sortSheetOpen} title="Sort invoices" onClose={() => setSortSheetOpen(false)}
        onSubmit={() => setSortSheetOpen(false)} submitLabel="Done" testIDPrefix="invoice-sort">
        <FilterSection title="Sort by" styles={styles}>
          {([["practice", "Practice / customer"], ["issued", "Issued date"], ["due", "Due date"]] as const).map(([field, label]) =>
            <RadioRow key={field} label={label} selected={sort === field} onPress={() => setSort(field)} colors={colors} styles={styles} testID={`sort-field-${field}`} />)}
        </FilterSection>
        <FilterSection title="Direction" styles={styles}>
          <RadioRow label="Ascending" selected={sortDirection === "asc"} onPress={() => setSortDirection("asc")} colors={colors} styles={styles} testID="sort-direction-asc" />
          <RadioRow label="Descending" selected={sortDirection === "desc"} onPress={() => setSortDirection("desc")} colors={colors} styles={styles} testID="sort-direction-desc" />
        </FilterSection>
      </FormSheet>
    </>
  );
}

type StatusCountsSummary = { statusCounts?: Record<string, number> } | null | undefined;
const STATUS_TAB_DEFS = [
  ["all", "All Invoices"], ["open", "Open"], ["overdue", "Overdue"], ["paid", "Paid"], ["draft", "Draft"], ["void", "Void"],
] as const;

const STATUS_SELECT_OPTIONS = [
  { value: "all", label: "All statuses" }, { value: "open", label: "Open" }, { value: "overdue", label: "Overdue" },
  { value: "paid", label: "Paid" }, { value: "draft", label: "Draft" }, { value: "void", label: "Void" },
  { value: "zero_balance", label: "$0 Balance" }, { value: "frozen", label: "Frozen" },
];
function statusActiveKey(selection: InvoiceStatusSelection): string {
  const { view, statuses } = invoiceStatusSelectionToLegacy(selection);
  return selection.kind === "all" ? "all"
    : view === "outstanding" ? "overdue"
    : view === "open" && statuses.length === 0 ? "open"
    : view === "all" && statuses.length === 1 ? statuses[0] : "custom";
}

function InvoiceStatusTabs({ summary, selection, onSelect, compact, styles }: {
  summary: StatusCountsSummary; selection: InvoiceStatusSelection; onSelect: (key: string) => void; compact?: boolean; styles: ReturnType<typeof makeStyles>;
}) {
  const activeKey = statusActiveKey(selection);
  const chip = compact ? { minHeight: 34 } : null;
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.filterRow, compact && { paddingBottom: Spacing.sm }]} testID="invoice-status-tabs">
    {STATUS_TAB_DEFS.map(([key, label]) => {
      const n = summary?.statusCounts?.[key];
      const active = activeKey === key;
      return <Pressable key={key} onPress={() => onSelect(key)} style={[styles.filterChip, chip, active && styles.filterChipActive]}
        testID={`invoice-tab-${key}`} accessibilityRole="tab" accessibilityState={{ selected: active }}>
        <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{label} {n == null ? "—" : n}</Text>
      </Pressable>;
    })}
    {activeKey === "custom" ? <View style={[styles.filterChip, chip, styles.filterChipActive]} testID="invoice-tab-custom">
      <Text style={[styles.filterChipText, styles.filterChipTextActive]}>Custom</Text></View> : null}
  </ScrollView>;
}

function InvoicePager({ page, pageCount, total, pageSize, loading, onPage, onPageSize, wide, styles }: {
  wide?: boolean; page: number; pageCount: number; total: number; pageSize: number; loading: boolean; onPage: (p: number) => void; onPageSize: (n: number) => void; styles: ReturnType<typeof makeStyles>;
}) {
  if (total === 0) return null;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  const chipBase = wide ? { minHeight: 32, minWidth: 32, alignItems: "center" as const, paddingHorizontal: Spacing.sm } : null;
  const pagerBody = () => <View style={[styles.wrapRow, wide && { flexWrap: "nowrap", alignItems: "center" }]}>
    <Pressable disabled={page <= 1 || loading} onPress={() => onPage(page - 1)} style={[styles.filterChip, chipBase, page <= 1 && { opacity: 0.4 }]} testID="invoice-page-prev" accessibilityLabel="Previous page">
      <Text style={styles.filterChipText}>Prev</Text></Pressable>
    {pagerItems(page, pageCount).map((item, idx) => item === "gap"
      ? <Text key={`gap-${idx}`} style={[styles.filterChipText, { alignSelf: "center" }]}>...</Text>
      : <Pressable key={item} disabled={loading} onPress={() => onPage(item)} style={[styles.filterChip, chipBase, item === page && styles.filterChipActive]}
          testID={`invoice-page-${item}`} accessibilityState={{ selected: item === page }} accessibilityLabel={`Page ${item}`}>
          <Text style={[styles.filterChipText, item === page && styles.filterChipTextActive]}>{item}</Text></Pressable>)}
    <Pressable disabled={page >= pageCount || loading} onPress={() => onPage(page + 1)} style={[styles.filterChip, chipBase, page >= pageCount && { opacity: 0.4 }]} testID="invoice-page-next" accessibilityLabel="Next page">
      <Text style={styles.filterChipText}>Next</Text></Pressable>
  </View>;
  return <View style={[styles.pager, wide && { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: Spacing.sm }]} testID="invoice-pager">
    <Text style={styles.hint} testID="invoice-range">Showing {start}-{end} of {total}</Text>
    {wide ? <View style={{ flexDirection: "row", alignItems: "center", gap: Spacing.sm, justifyContent: "flex-end" }}>
      <WebSelect label="Rows per page" testID="invoice-page-size-select" value={String(pageSize)} width={110}
        options={INVOICE_PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} / page` }))} onChange={(v) => onPageSize(Number(v))} />
      {pagerBody()}
    </View> : <>
      <View style={styles.wrapRow}>
        {INVOICE_PAGE_SIZES.map((n) => <Pressable key={n} onPress={() => onPageSize(n)} style={[styles.filterChip, pageSize === n && styles.filterChipActive]}
          testID={`invoice-page-size-${n}`} accessibilityRole="radio" accessibilityState={{ selected: pageSize === n }}>
          <Text style={[styles.filterChipText, pageSize === n && styles.filterChipTextActive]}>{n} per page</Text></Pressable>)}
      </View>
      {pagerBody()}
    </>}
  </View>;
}

function FilterSection({ title, children, styles }: { title: string; children: React.ReactNode; styles: ReturnType<typeof makeStyles> }) {
  return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text>{children}</View>;
}

function ChoiceChip({ label, selected, onPress, styles, testID }: { label: string; selected: boolean; onPress: () => void; styles: ReturnType<typeof makeStyles>; testID: string }) {
  return <Pressable onPress={onPress} style={[styles.choiceChip, selected && styles.choiceChipActive]} testID={testID}
    accessibilityRole="checkbox" accessibilityState={{ checked: selected }}>
    <Text style={[styles.filterChipText, selected && styles.filterChipTextActive]}>{label}</Text>
  </Pressable>;
}

function RadioRow({ label, selected, onPress, colors, styles, testID }: { label: string; selected: boolean; onPress: () => void; colors: ThemeColors; styles: ReturnType<typeof makeStyles>; testID: string }) {
  return <Pressable onPress={onPress} style={styles.radioRow} accessibilityRole="radio" accessibilityState={{ selected }} testID={testID}>
    <Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={20} color={selected ? colors.tint : colors.textTertiary} />
    <Text style={[styles.radioText, selected && styles.radioTextActive]}>{label}</Text>
  </Pressable>;
}

function DateRangeFields({ prefix, start, end, onStart, onEnd, invalid, styles }: {
  prefix: string; start: string; end: string; onStart: (v: string) => void; onEnd: (v: string) => void;
  invalid: boolean; styles: ReturnType<typeof makeStyles>;
}) {
  return <View style={styles.dateFields}>
    <DateField title="From date" placeholder="Select start date" value={start || null} onChange={onStart}
      maxDate={end || undefined} testID={`${prefix}-date-start`} />
    <DateField title="To date" placeholder="Select end date" value={end || null} onChange={onEnd}
      minDate={start || undefined} testID={`${prefix}-date-end`} />
    <Text style={[styles.hint, invalid && styles.errorText]}>{invalid ? "Choose a valid range with the end on or after the start." : "Dates are inclusive."}</Text>
  </View>;
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    searchWrap: { marginHorizontal: Spacing.lg, marginBottom: Spacing.sm, minHeight: 42, flexDirection: "row", alignItems: "center", gap: Spacing.sm, paddingHorizontal: Spacing.md, borderRadius: Radius.lg, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
    searchInput: { ...Typography.body, color: c.text, flex: 1, paddingVertical: Spacing.sm },
    wideTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: Spacing.md, paddingBottom: Spacing.sm, paddingRight: Spacing.lg },
    webTitleRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
    webTitleIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#2563EB" },
    webTitle: { ...Typography.bodySemibold, fontSize: 18, color: c.text },
    webSubtitle: { ...Typography.caption, color: c.textSecondary },
    headerActions: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
    headerBtn: { minHeight: 44, justifyContent: "center", paddingHorizontal: Spacing.md, borderRadius: Radius.lg, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
    headerBtnPrimary: { backgroundColor: c.tint, borderColor: c.tint },
    headerBtnText: { ...Typography.captionSemibold, color: c.text },
    pager: { padding: Spacing.lg, gap: Spacing.sm },
    segment: { marginHorizontal: Spacing.lg, marginBottom: Spacing.sm, flexDirection: "row", padding: 3, borderRadius: Radius.full, backgroundColor: c.surface },
    segmentItem: { flex: 1, alignItems: "center", paddingVertical: Spacing.sm, borderRadius: Radius.full },
    segmentItemActive: { backgroundColor: c.tintLight },
    segmentText: { ...Typography.captionSemibold, color: c.textSecondary },
    segmentTextActive: { color: c.tint },
    filterRow: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md, gap: Spacing.sm },
    filterChip: { minHeight: 44, justifyContent: "center", paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2, borderRadius: Radius.full, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
    iconChip: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
    filterChipActive: { backgroundColor: c.tintLight, borderColor: c.tint },
    filterChipText: { ...Typography.captionSemibold, color: c.textSecondary },
    filterChipTextActive: { color: c.tint },
    clearChip: { paddingHorizontal: Spacing.sm, paddingVertical: Spacing.xs + 2, justifyContent: "center" },
    clearText: { ...Typography.captionSemibold, color: c.error },
    section: { gap: Spacing.sm, paddingBottom: Spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    sectionTitle: { ...Typography.captionSemibold, color: c.textSecondary },
    wrapRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
    horizontalChoices: { flexDirection: "row", gap: Spacing.sm },
    choiceChip: { minHeight: 44, justifyContent: "center", paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, borderRadius: Radius.full, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
    choiceChipActive: { borderColor: c.tint, backgroundColor: c.tintLight },
    switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: Spacing.xs },
    dateFields: { gap: Spacing.sm, marginTop: Spacing.xs },
    hint: { ...Typography.caption, color: c.textSecondary },
    errorText: { color: c.error },
    radioRow: { flexDirection: "row", alignItems: "center", gap: Spacing.md, minHeight: 44 },
    radioText: { ...Typography.body, color: c.text },
    radioTextActive: { ...Typography.bodySemibold, color: c.tint },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    main: { flex: 1, gap: 2 },
    name: { ...Typography.bodySemibold, color: c.text },
    customer: { ...Typography.caption, color: c.textSecondary },
    meta: { ...Typography.caption, color: c.textSecondary },
    right: { alignItems: "flex-end", gap: Spacing.xs },
    amount: { ...Typography.bodySemibold, color: c.text },
    badges: { flexDirection: "row", alignItems: "center", gap: Spacing.xs, flexWrap: "wrap", justifyContent: "flex-end" },
    frozenBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: Radius.full },
    frozenText: { fontSize: 10, fontFamily: "Inter_600SemiBold", letterSpacing: 0.4 },
  });
}
