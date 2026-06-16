import { useQuery } from "@tanstack/react-query";
import type { UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";
import type {
  CanonicalCase,
  CanonicalActivityEntry,
  CanonicalAttachment,
  CanonicalRestoration,
  CanonicalRemakeRef,
} from "./generated/api.schemas";

export interface CanonicalInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  total?: string | number | null;
  balanceDue?: string | number | null;
  issuedAt?: string | null;
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

export interface UseCasesParams {
  organizationId?: string;
  search?: string;
  status?: string;
  barcode?: string;
}

async function fetchCases(params?: UseCasesParams): Promise<CanonicalCase[]> {
  const qs = new URLSearchParams();
  if (params?.organizationId) qs.set("organizationId", params.organizationId);
  if (params?.search) qs.set("search", params.search);
  if (params?.status) qs.set("status", params.status);
  if (params?.barcode) qs.set("barcode", params.barcode);
  const queryString = qs.toString();
  const url = queryString ? `/api/cases?${queryString}` : "/api/cases";
  const data = await customFetch<unknown>(url);
  if (Array.isArray(data)) return data as CanonicalCase[];
  if (Array.isArray((data as any)?.data)) return (data as any).data as CanonicalCase[];
  return [];
}

export function useCases(
  params?: UseCasesParams,
  options?: Omit<UseQueryOptions<CanonicalCase[]>, "queryKey" | "queryFn">,
) {
  return useQuery<CanonicalCase[]>({
    queryKey: ["cases", params?.organizationId ?? "", params?.search ?? "", params?.status ?? "", params?.barcode ?? ""],
    queryFn: () => fetchCases(params),
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
}

async function fetchInvoices(params?: UseInvoicesParams): Promise<CanonicalInvoice[]> {
  const qs = new URLSearchParams();
  if (params?.caseId) qs.set("caseId", params.caseId);
  if (params?.practiceId) qs.set("practiceId", params.practiceId);
  if (params?.labOrganizationId) qs.set("labOrganizationId", params.labOrganizationId);
  if (params?.status) qs.set("status", params.status);
  const queryString = qs.toString();
  const url = queryString ? `/api/invoices?${queryString}` : "/api/invoices";
  const data = await customFetch<unknown>(url);
  if (Array.isArray(data)) return data as CanonicalInvoice[];
  if (Array.isArray((data as any)?.data)) return (data as any).data as CanonicalInvoice[];
  return [];
}

export function useInvoices(
  params?: UseInvoicesParams,
  options?: Omit<UseQueryOptions<CanonicalInvoice[]>, "queryKey" | "queryFn">,
) {
  return useQuery<CanonicalInvoice[]>({
    queryKey: ["invoices", params?.caseId ?? "", params?.practiceId ?? "", params?.labOrganizationId ?? "", params?.status ?? ""],
    queryFn: () => fetchInvoices(params),
    staleTime: 30_000,
    ...options,
  });
}

export function useInvoice(
  invoiceId: string | undefined | null,
  options?: Omit<UseQueryOptions<CanonicalInvoice | null>, "queryKey" | "queryFn">,
) {
  return useQuery<CanonicalInvoice | null>({
    queryKey: ["invoices", invoiceId ?? ""],
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
