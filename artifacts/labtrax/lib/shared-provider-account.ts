import { resilientFetch } from "@/lib/query-client";

export type SharedProviderContactChanges = {
  name?: string;
  displayName?: string | null;
  billingEmail?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
};

export type SharedProviderContact = Required<SharedProviderContactChanges> & {
  source: "provider_organization";
  updatedAt: string;
};

export type SharedProviderCard = {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  status: "active" | "expiring" | "expired";
  updatedAt: string | null;
  source: "processor";
};

export type SharedProviderAccountChange = {
  id: string;
  labOrganizationId: string;
  providerOrganizationId: string;
  requestedByOrganizationId: string;
  requestedByUserId: string;
  source: "lab" | "provider";
  status: "pending" | "approved" | "rejected" | "stale";
  changes: SharedProviderContactChanges;
  reviewedByUserId?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SharedProviderAccount = {
  relationship: {
    labOrganizationId: string;
    providerOrganizationId: string;
  };
  contact: SharedProviderContact;
  card: SharedProviderCard | null;
  profileChangeRequests: SharedProviderAccountChange[];
};

export type LabCardContext = {
  hasCard: boolean;
  cardPresent: boolean;
  card: SharedProviderCard | null;
  autoPay: {
    enabled: boolean;
    dayOfMonth: number | null;
    context: "provider_invoice_autopay" | null;
  };
};

export class SharedProviderAccountError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function sharedProviderAccountQueryKey(
  labOrganizationId: string,
  providerOrganizationId: string,
) {
  return [
    "shared-provider-account",
    labOrganizationId,
    providerOrganizationId,
  ] as const;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await resilientFetch(path, init);
  const body = (await response.json().catch(() => null)) as
    | { data?: T; error?: string }
    | T
    | null;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Account request failed (${response.status}).`;
    throw new SharedProviderAccountError(message, response.status);
  }
  return body && typeof body === "object" && "data" in body
    ? (body as { data: T }).data
    : (body as T);
}

export function getSharedProviderAccount(
  labOrganizationId: string,
  providerOrganizationId: string,
): Promise<SharedProviderAccount> {
  const params = new URLSearchParams({
    labOrganizationId,
    providerOrganizationId,
  });
  return request(`/api/organizations/shared-accounts?${params.toString()}`);
}

export function getLabCardContext(
  labOrganizationId: string,
  providerOrganizationId: string,
): Promise<LabCardContext> {
  const params = new URLSearchParams({
    labOrganizationId,
    providerOrganizationId,
  });
  return request(`/api/provider/lab-card?${params.toString()}`);
}

export function createSharedProviderAccountChange(
  labOrganizationId: string,
  providerOrganizationId: string,
  changes: SharedProviderContactChanges,
): Promise<SharedProviderAccountChange> {
  return request("/api/organizations/shared-accounts/profile-change-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      labOrganizationId,
      providerOrganizationId,
      clientRequestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      changes,
    }),
  });
}

export function decideSharedProviderAccountChange(
  requestId: string,
  decision: "approve" | "reject",
): Promise<SharedProviderAccountChange> {
  return request(
    `/api/organizations/shared-accounts/profile-change-requests/${encodeURIComponent(requestId)}/${decision}`,
    { method: "POST" },
  );
}