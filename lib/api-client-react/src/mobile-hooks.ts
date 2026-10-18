import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InfiniteData, UseInfiniteQueryOptions, UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";
import { getSalesInvoices } from "./generated/api";
import type { GetSalesInvoicesParams } from "./generated/api.schemas";
import { parseCasesOverview, type CasesOverview } from "./cases-overview";
export { parseCasesOverview, type CasesOverview } from "./cases-overview";
import type {
  CanonicalCase,
  CanonicalActivityEntry,
  CanonicalAttachment,
  InvoiceFilterFacets,
  CanonicalRestoration,
  CanonicalRemakeRef,
} from "./generated/api.schemas";
import {
  FINANCE_INVOICES_QUERY_KEY,
  FINANCE_STATEMENT_SUMMARIES_QUERY_KEY,
} from "./finance-query-keys";

export interface CanonicalInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  total?: string | number | null;
  balanceDue?: string | number | null;
  issuedAt?: string | null;
  createdAt?: string | null;
  dueAt?: string | null;
  caseId?: string | null;
  labOrganizationId?: string | null;
  providerOrganizationId?: string | null;
  providerOrganization?: {
    id?: string;
    name?: string | null;
    displayName?: string | null;
  } | null;
  lineItems?: CanonicalInvoiceLineItem[];
  items?: CanonicalInvoiceLineItem[];
  payments?: CanonicalInvoicePayment[];
  notes?: string | null;
  frozen?: boolean;
  caseDeletedAt?: string | null;
  caseDeletedNote?: string | null;
  [key: string]: unknown;
}

export interface CanonicalInvoiceLineItem {
  id: string;
  description?: string | null;
  quantity?: number | null;
  unitPrice?: string | number | null;
  lineTotal?: string | number | null;
  toothNumbers?: string | null;
  material?: string | null;
  [key: string]: unknown;
}

export interface CanonicalInvoicePayment {
  id: string;
  amount: string | number;
  paidAt?: string | null;
  method?: string | null;
  notes?: string | null;
  [key: string]: unknown;
}

// ─── Cases hooks ─────────────────────────────────────────────────────────────

export function useCasesOverview(
  options?: Omit<UseQueryOptions<CasesOverview>, "queryKey" | "queryFn">,
) {
  return useQuery<CasesOverview>({
    queryKey: ["cases", "overview"],
    queryFn: async () => {
      // Compute inside the request so polling, foreground refresh and midnight
      // always use the current local calendar day and time, not mount-time values.
      const now = new Date();
      const params = new URLSearchParams({
        localDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
        localTime: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
      });
      const response = await customFetch<{ data: CasesOverview }>(`/api/cases/overview?${params}`);
      return parseCasesOverview(response.data);
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    ...options,
  });
}

export interface UseCasesParams {
  organizationId?: string;
  search?: string;
  status?: string | string[];
  barcode?: string;
  category?: string;
  taxonomyType?: string;
  conflictsOnly?: boolean;
  createdStart?: string;
  createdEnd?: string;
  dueStart?: string;
  dueEnd?: string;
  overdueOnly?: boolean;
  localDate?: string;
  limit?: number;
  offset?: number;
  page?: number;
  pageSize?: number;
}

export interface CasesPage {
  rows: CanonicalCase[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  search: string;
  requestKey: string;
}
async function fetchCases(params?: UseCasesParams): Promise<CanonicalCase[]> {
  const data = await fetchCasesResponse(params);
  if (Array.isArray(data)) return data as CanonicalCase[];
  if (Array.isArray((data as any)?.data)) return (data as any).data as CanonicalCase[];
  if (Array.isArray((data as any)?.rows)) return (data as any).rows as CanonicalCase[];
  return [];
}

async function fetchCasesPage(params: UseCasesParams): Promise<CasesPage> {
  const { page: _page, pageSize: _pageSize, ...requestParams } = params;
  const requestKey = JSON.stringify(requestParams);
  const qs = new URLSearchParams();
  if (params.organizationId) qs.set("organizationId", params.organizationId);
  if (params.search) qs.set("search", params.search);
  if (params.status) {
    const statuses = Array.isArray(params.status) ? params.status : [params.status];
    statuses.forEach((status) => qs.append("status", status));
  }
  if (params.barcode) qs.set("barcode", params.barcode);
  if (params.category) qs.set("category", params.category);
  if (params.taxonomyType) qs.set("taxonomyType", params.taxonomyType);
  if (params.conflictsOnly) qs.set("conflictsOnly", "true");
  if (params.createdStart) qs.set("createdStart", params.createdStart);
  if (params.createdEnd) qs.set("createdEnd", params.createdEnd);
  if (params.dueStart) qs.set("dueStart", params.dueStart);
  if (params.dueEnd) qs.set("dueEnd", params.dueEnd);
  if (params.overdueOnly) {
    qs.set("overdueOnly", "true");
    if (params.localDate) qs.set("localDate", params.localDate);
  }
  qs.set("page", String(params.page ?? 1));
  qs.set("pageSize", String(params.pageSize ?? 10));
  const data = await customFetch<unknown>(`/api/cases/worklist?${qs.toString()}`);
  const page = (data as any)?.data ?? data;
  if (Array.isArray(page)) {
    return {
      rows: page,
      total: page.length,
      page: params.page ?? 1,
      pageSize: params.pageSize ?? page.length,
      hasMore: false,
      search: params.search ?? "",
      requestKey,
    };
  }
  return {
    rows: Array.isArray(page?.rows) ? page.rows : [],
    total: Number(page?.total ?? 0),
    page: Number(page?.page ?? params.page ?? 1),
    pageSize: Number(page?.pageSize ?? params.pageSize ?? 10),
    hasMore: Boolean(page?.hasMore),
    search: params.search ?? "",
    requestKey,
  };
}
export function useCases(
  params?: UseCasesParams,
  options?: Omit<UseQueryOptions<CanonicalCase[]>, "queryKey" | "queryFn">,
) {
  return useQuery<CanonicalCase[]>({
    queryKey: ["cases", params?.organizationId ?? "", params?.search ?? "", params?.status ?? "", params?.barcode ?? "", params?.limit ?? "", params?.offset ?? ""],
    queryFn: () => fetchCases(params),
    staleTime: 30_000,
    ...options,
  });
}

export function useCasesPage(
  params: UseCasesParams,
  options?: Omit<UseQueryOptions<CasesPage>, "queryKey" | "queryFn">,
) {
  return useQuery<CasesPage>({
    queryKey: ["cases", "paged", params],
    queryFn: () => fetchCasesPage(params),
    staleTime: 30_000,
    ...options,
  });
}
export function useCase(
  caseId: string | undefined | null,
  options?: Omit<UseQueryOptions<CanonicalCase | null>, "queryKey" | "queryFn">,
) {
  return useQuery<CanonicalCase | null>({
    queryKey: ["cases", caseId ?? ""],
    queryFn: async () => {
      if (!caseId) return null;
      const data = await customFetch<unknown>(`/api/cases/${encodeURIComponent(caseId)}`);
      const item = (data as any)?.case ?? (data as any)?.data ?? data;
      if (item && typeof item === "object" && "id" in item) return item as CanonicalCase;
      return null;
    },
    enabled: Boolean(caseId),
    staleTime: 30_000,
    ...options,
  });
}

// ─── Invoices hooks ───────────────────────────────────────────────────────────

export interface UseInvoicesParams {
  caseId?: string;
  practiceId?: string;
  labOrganizationId?: string;
  status?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Half-open UTC calendar-day boundaries for the paged invoice register. */
  issuedFrom?: string;
  issuedTo?: string;
  doctorName?: string;
  aiOnly?: boolean;
  overdueBucket?: string;
  dueDateFrom?: string;
  dueDateTo?: string;
  sortBy?: "issued" | "due" | "practice";
  sortDirection?: "asc" | "desc";
  view?: "open" | "outstanding";
}

interface OffsetPage<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** Authoritative whole-register aggregates, using the existing server semantics. */
export interface InvoiceRegisterSummary {
  openBalance: number;
  openCount: number;
  overdueBalance: number;
  overdueCount: number;
  paidThisMonth: number;
  paidCount: number;
  sumTotal: number;
  sumBalance: number;
  /** All-time invoices in the authorized, requested tenant/practice scope. */
  totalInvoices?: number;
  /** Counts with non-status filters applied, independent of the active tab. */
  statusCounts?: {
    all: number;
    open: number;
    overdue: number;
    paid: number;
    draft: number;
    void: number;
  };
}
function appendInvoiceParams(qs: URLSearchParams, params?: UseInvoicesParams) {
  if (!params) return;
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    qs.set(key, String(value));
  }
}

async function fetchInvoices(params?: UseInvoicesParams): Promise<CanonicalInvoice[]> {
  const qs = new URLSearchParams();
  appendInvoiceParams(qs, params);
  const queryString = qs.toString();
  const url = queryString ? `/api/invoices?${queryString}` : "/api/invoices";
  const data = await customFetch<unknown>(url);
  if (Array.isArray(data)) return data as CanonicalInvoice[];
  if (Array.isArray((data as any)?.data)) return (data as any).data as CanonicalInvoice[];
  return [];
}

async function fetchInvoicePage(
  params: UseInvoicesParams | undefined,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<InvoiceRegisterPage> {
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  appendInvoiceParams(qs, params);
  const data = await customFetch<unknown>(`/api/invoices?${qs.toString()}`, { signal });
  const page = ((data as any)?.data ?? data) as Partial<InvoiceRegisterPage>;
  if (Array.isArray(page)) {
    return {
      rows: page.slice(offset, offset + limit),
      total: page.length,
      limit,
      offset,
      hasMore: offset + limit < page.length,
    };
  }
  if (!Array.isArray(page.rows) || !Number.isFinite(page.total)) {
    throw new Error("The invoice server returned an invalid page.");
  }
  return {
    rows: Array.isArray(page.rows) ? page.rows : [],
    total: Number(page.total ?? 0),
    limit: Number(page.limit ?? limit),
    offset: Number(page.offset ?? offset),
    hasMore: Boolean(page.hasMore),
    summary: page.summary,
  };
}

export function useInvoiceFilterFacets(
  params?: Pick<UseInvoicesParams, "labOrganizationId" | "practiceId">,
) {
  return useQuery<InvoiceFilterFacets>({
    queryKey: [
      ...FINANCE_INVOICES_QUERY_KEY,
      "filter-facets",
      params?.labOrganizationId ?? "",
      params?.practiceId ?? "",
    ],
    queryFn: async () => {
      const qs = new URLSearchParams();
      appendInvoiceParams(qs, params);
      const queryString = qs.toString();
      const data = await customFetch<unknown>(
        queryString
          ? `/api/invoices/filter-facets?${queryString}`
          : "/api/invoices/filter-facets",
      );
      return (((data as any)?.data ?? data) as InvoiceFilterFacets) ??
        { practices: [], doctors: [] };
    },
    staleTime: 30_000,
  });
}

export function useInvoices(
  params?: UseInvoicesParams,
  options?: Omit<UseQueryOptions<CanonicalInvoice[]>, "queryKey" | "queryFn">,
) {
  return useQuery<CanonicalInvoice[]>({
    queryKey: [
      ...FINANCE_INVOICES_QUERY_KEY,
      params?.caseId ?? "",
      params?.practiceId ?? "",
      params?.labOrganizationId ?? "",
      params?.status ?? "",
    ],
    queryFn: () => fetchInvoices(params),
    staleTime: 30_000,
    ...options,
  });
}

export function usePagedInvoices(
  params?: UseInvoicesParams,
  options?: Omit<
    UseInfiniteQueryOptions<InvoiceRegisterPage, Error, InfiniteData<InvoiceRegisterPage>, readonly unknown[], number>,
    "queryKey" | "queryFn" | "initialPageParam" | "getNextPageParam"
  >,
) {
  const queryClient = useQueryClient();
  const queryKey = [...FINANCE_INVOICES_QUERY_KEY, "paged", params ?? {}] as const;
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchInvoicePage(params, pageParam, 10),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.hasMore
      ? lastPage.offset + lastPage.rows.length
      : undefined,
    staleTime: 30_000,
    // A new issue-day filter must not show rows or totals from the previous
    // query while its first page is loading.
    ...options,
  });
  const data = query.data?.pages.flatMap((page) => page.rows);
  const total = query.data?.pages[0]?.total ?? 0;
  const refresh = async () => {
    queryClient.setQueryData<InfiniteData<InvoiceRegisterPage>>(queryKey, (current) =>
      current?.pages.length
        ? { pages: [current.pages[0]], pageParams: [current.pageParams[0]] }
        : current,
    );
    return query.refetch();
  };
  const summary = query.data?.pages[0]?.summary;
  return { ...query, data, total, summary, refresh };
}

/** Browser-only numbered paging. Native callers retain usePagedInvoices. */
export function useInvoiceBrowserPage(
  params: UseInvoicesParams | undefined,
  { page, pageSize, enabled = true }: { page: number; pageSize: number; enabled?: boolean },
) {
  const query = useQuery({
    queryKey: [...FINANCE_INVOICES_QUERY_KEY, "browser-page", params ?? {}, page, pageSize],
    queryFn: ({ signal }) => fetchInvoicePage(params, Math.max(0, page - 1) * pageSize, pageSize, signal),
    enabled,
    staleTime: 30_000,
  });
  return {
    ...query,
    data: query.data?.rows,
    total: query.data?.total ?? 0,
    summary: query.data?.summary,
    offset: query.data?.offset ?? Math.max(0, page - 1) * pageSize,
    refresh: query.refetch,
    hasNextPage: Boolean(query.data?.hasMore),
    isFetchingNextPage: false,
    fetchNextPage: async () => {},
  };
}

/** Report-only persisted invoices: never substitute the legacy register bridge. */
export function useSalesInvoicePages(
  params: Pick<GetSalesInvoicesParams, "organizationId" | "dateFrom" | "dateTo">,
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: [...FINANCE_INVOICES_QUERY_KEY, "reports", "sales-invoices", params],
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) =>
      (await getSalesInvoices({ ...params, offset: pageParam, limit: 50 }, { signal })).data,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.offset + lastPage.rows.length : undefined,
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export interface DoctorDirectoryEntry {
  doctorName: string;
  practiceName?: string | null;
  totalCases?: number | null;
  openCases?: number | null;
  providerOrganizationId?: string | null;
  practicePhone?: string | null;
  doctorPhone?: string | null;
  practiceAccountNumber?: string | null;
}

export interface MobileStatementAccountSummary {
  practiceId: string;
  practiceName: string;
  billingEmail: string | null;
  openInvoiceCount: number;
  openInvoiceTotal: number;
  unpaidStatements: Array<{ id: string; date: string; remainingBalance: number }>;
  totalOpenBalance: number;
  overdueBalance: number;
}

function useOffsetPages<T>(
  queryKey: readonly unknown[],
  fetchPage: (offset: number, limit: number) => Promise<OffsetPage<T>>,
  enabled: boolean,
) {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam, 10),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.hasMore
      ? lastPage.offset + lastPage.rows.length
      : undefined,
    enabled,
    staleTime: 30_000,
  });
  const refresh = async () => {
    queryClient.setQueryData<InfiniteData<OffsetPage<T>>>(queryKey, (current) =>
      current?.pages.length
        ? { pages: [current.pages[0]], pageParams: [current.pageParams[0]] }
        : current,
    );
    return query.refetch();
  };
  return {
    ...query,
    data: query.data?.pages.flatMap((page) => page.rows),
    total: query.data?.pages[0]?.total ?? 0,
    refresh,
  };
}

export function useStatementAccountSummaries(labOrganizationId?: string | null) {
  const queryKey = [
    ...FINANCE_STATEMENT_SUMMARIES_QUERY_KEY,
    "paged",
    labOrganizationId ?? "",
  ] as const;
  return useOffsetPages<MobileStatementAccountSummary>(
    queryKey,
    async (offset, limit) => {
      const data = await customFetch<unknown>(
        `/api/lab-orgs/${encodeURIComponent(labOrganizationId!)}/statements/account-summaries?limit=${limit}&offset=${offset}`,
      );
      const page = ((data as any)?.data ?? data) as OffsetPage<MobileStatementAccountSummary>;
      return page;
    },
    Boolean(labOrganizationId),
  );
}

export function useDoctorDirectory(
  labOrganizationId?: string | null,
  params?: { search?: string; openOnly?: boolean },
) {
  const search = params?.search?.trim() ?? "";
  const openOnly = Boolean(params?.openOnly);
  const queryKey = ["doctors-search", "paged", labOrganizationId ?? "", search, openOnly] as const;
  return useOffsetPages<DoctorDirectoryEntry>(
    queryKey,
    async (offset, limit) => {
      const qs = new URLSearchParams({
        labOrganizationId: labOrganizationId!,
        limit: String(limit),
        offset: String(offset),
      });
      if (search) qs.set("q", search);
      if (openOnly) qs.set("openOnly", "true");
      const data = await customFetch<unknown>(`/api/doctors/search?${qs.toString()}`);
      const result = ((data as any)?.data ?? data) as {
        entries?: DoctorDirectoryEntry[];
        total?: number;
        limit?: number;
        offset?: number;
      };
      const rows = result.entries ?? [];
      const total = Number(result.total ?? rows.length);
      return {
        rows,
        total,
        limit: Number(result.limit ?? limit),
        offset: Number(result.offset ?? offset),
        hasMore: offset + rows.length < total,
      };
    },
    Boolean(labOrganizationId),
  );
}

export function useInvoice(
  invoiceId: string | undefined | null,
  options?: Omit<UseQueryOptions<CanonicalInvoice | null>, "queryKey" | "queryFn">,
) {
  return useQuery<CanonicalInvoice | null>({
    queryKey: [...FINANCE_INVOICES_QUERY_KEY, invoiceId ?? ""],
    queryFn: async () => {
      if (!invoiceId) return null;
      const data = await customFetch<unknown>(`/api/invoices/${encodeURIComponent(invoiceId)}`);
      const item = (data as any)?.invoice ?? (data as any)?.data ?? data;
      if (item && typeof item === "object" && "id" in item) return item as CanonicalInvoice;
      return null;
    },
    enabled: Boolean(invoiceId),
    staleTime: 30_000,
    ...options,
  });
}

// ─── Recent cases hook ────────────────────────────────────────────────────────

export interface LatestEvent {
  eventType: string;
  summary: string;
}

export type CaseWithLatestEvent = CanonicalCase & {
  latestEvent?: LatestEvent | null;
};

async function fetchRecentCases(): Promise<CaseWithLatestEvent[]> {
  const data = await customFetch<unknown>("/api/cases/recent");
  if (Array.isArray(data)) return data as CaseWithLatestEvent[];
  if (Array.isArray((data as any)?.data)) return (data as any).data as CaseWithLatestEvent[];
  return [];
}

export function useRecentCases(
  options?: Omit<UseQueryOptions<CaseWithLatestEvent[]>, "queryKey" | "queryFn">,
) {
  return useQuery<CaseWithLatestEvent[]>({
    queryKey: ["cases", "recent"],
    queryFn: fetchRecentCases,
    staleTime: 30_000,
    ...options,
  });
}

export function useCaseAttachments(
  caseId: string | undefined | null,
  options?: Omit<UseQueryOptions<CanonicalAttachment[]>, "queryKey" | "queryFn">,
) {
  return useQuery<CanonicalAttachment[]>({
    queryKey: ["cases", caseId ?? "", "attachments"],
    queryFn: async () => {
      if (!caseId) return [];
      const data = await customFetch<unknown>(`/api/cases/${encodeURIComponent(caseId)}/attachments`);
      if (Array.isArray(data)) return data as CanonicalAttachment[];
      if (Array.isArray((data as any)?.data)) return (data as any).data as CanonicalAttachment[];
      return [];
    },
    enabled: Boolean(caseId),
    staleTime: 30_000,
    ...options,
  });
}

async function fetchCasesResponse(params?: UseCasesParams): Promise<unknown> {
  const qs = new URLSearchParams();
  if (params?.organizationId) qs.set("organizationId", params.organizationId);
  if (params?.search) qs.set("search", params.search);
  if (params?.status) {
    const statuses = Array.isArray(params.status) ? params.status : [params.status];
    statuses.forEach((status) => qs.append("status", status));
  }
  if (params?.barcode) qs.set("barcode", params.barcode);
  if (params?.limit != null) qs.set("limit", String(params.limit));
  if (params?.offset != null) qs.set("offset", String(params.offset));
  const queryString = qs.toString();
  const url = queryString ? `/api/cases?${queryString}` : "/api/cases";
  return customFetch<unknown>(url);
}

interface InvoiceRegisterPage extends OffsetPage<CanonicalInvoice> {
  summary?: InvoiceRegisterSummary;
}
