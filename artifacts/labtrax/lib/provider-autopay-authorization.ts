import { getApiUrl, resilientFetch } from "@/lib/query-client";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

export type AuthorizationCategory = "subscription" | "lab";
export type AuthorizationStatus = "active" | "superseded" | "revoked" | string;

export type AutopayAuthorization = {
  id: string;
  category?: AuthorizationCategory;
  subscriptionFees?: boolean;
  labBills?: boolean;
  providerOrganizationId?: string | null;
  labOrganizationId?: string | null;
  labOrganizationIds?: string[];
  status: AuthorizationStatus;
  agreementVersion?: string | null;
  legalName?: string | null;
  labChargeDay?: number | null;
  card?: { brand?: string | null; last4?: string | null; expMonth?: number | null; expYear?: number | null; billingAddress?: Record<string, unknown> | null } | null;
  createdAt?: string | null;
  signedAt?: string | null;
  pdfUrl?: string | null;
};

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await resilientFetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (payload as { error?: string; message?: string }).error ||
      (payload as { message?: string }).message || `Request failed (${response.status}).`;
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return (payload && typeof payload === "object" && "data" in payload)
    ? (payload as { data: T }).data
    : payload as T;
}

export async function getProviderAuthorizations(providerOrganizationId: string): Promise<AutopayAuthorization[]> {
  try {
    const current = await request<AutopayAuthorization>(
      "GET", `/api/provider/autopay-authorization/current?providerOrganizationId=${encodeURIComponent(providerOrganizationId)}`,
    );
    return [current];
  } catch (error) {
    if (error instanceof Error && (error as Error & { status?: number }).status === 404) return [];
    throw error;
  }
}

export async function getProviderAuthorizationHistory(providerOrganizationId: string): Promise<AutopayAuthorization[]> {
  return request<AutopayAuthorization[]>(
    "GET", `/api/provider/autopay-authorization/history?providerOrganizationId=${encodeURIComponent(providerOrganizationId)}`,
  );
}

export async function submitProviderAuthorization(input: {
  providerOrganizationId: string;
  agreementVersion: string;
  agreementSha256: string;
  subscriptionFees: boolean;
  labBills: boolean;
  labOrganizationIds: string[];
  labChargeDay: number | null;
  typedLegalName: string;
  consent: true;
  signatureData: string;
}): Promise<AutopayAuthorization> {
  return request("POST", "/api/provider/autopay-authorization", input);
}

/** Lab-side management is deliberately separate: labs never submit a signature. */
export async function getLabProviderAuthorizationHistory(labOrganizationId: string, providerOrganizationId: string): Promise<AutopayAuthorization[]> {
  return request<AutopayAuthorization[]>(
    "GET", `/api/provider/lab-autopay-authorization/history?labOrganizationId=${encodeURIComponent(labOrganizationId)}&providerOrganizationId=${encodeURIComponent(providerOrganizationId)}`,
  );
}

export async function prepareLabAuthorizationRequest(input: {
  providerOrganizationId: string;
  labOrganizationId: string;
  subscriptionFees: boolean;
  labBills: boolean;
  labOrganizationIds: string[];
  labChargeDay: number | null;
  recipientEmail?: string;
  presentInPerson?: boolean;
  deliveryMode?: "email" | "in_person";
}): Promise<{ id: string; status: string; requestToken?: string }> {
  return request("POST", "/api/provider/autopay-authorization/requests", input);
}

export function providerAutopayDesktopHandoffUrl(id: string, token: string): string {
  const url = new URL("/desktop/", getApiUrl());
  url.searchParams.set("providerAutopayRequest", id);
  url.searchParams.set("providerAutopayToken", token);
  return url.href;
}

export async function listProviderAuthorizationRequests(labOrganizationId: string, providerOrganizationId: string): Promise<Array<{ id: string; status: string }>> {
  return request("GET", `/api/provider/autopay-authorization/requests?labOrganizationId=${encodeURIComponent(labOrganizationId)}&providerOrganizationId=${encodeURIComponent(providerOrganizationId)}`);
}

export async function cancelLabAuthorizationRequest(requestId: string): Promise<{ id: string; status: string }> {
  return request("POST", `/api/provider/autopay-authorization/requests/${encodeURIComponent(requestId)}/cancel`, {});
}

/** What the server hands back for a provider about to sign: the agreement to
 *  show and hash, the card the charges land on, and the labs it covers. */
export type PreparedProviderAuthorization = {
  agreementVersion?: string;
  agreementText?: string;
  agreementSha256?: string;
  card?: { brand?: string | null; last4?: string | null; billingAddress?: Record<string, unknown> | null } | null;
  labs?: Array<{ labOrganizationId?: string; labName?: string | null }>;
};

export async function prepareProviderAuthorization(providerOrganizationId: string): Promise<PreparedProviderAuthorization> {
  return request("GET", `/api/provider/autopay-authorization/prepare?providerOrganizationId=${encodeURIComponent(providerOrganizationId)}`);
}

export async function downloadAndShareProviderAuthorization(id: string, labOrganizationId?: string): Promise<void> {
  const path = labOrganizationId
    ? `/api/provider/lab-autopay-authorization/${encodeURIComponent(id)}/download?labOrganizationId=${encodeURIComponent(labOrganizationId)}`
    : `/api/provider/autopay-authorization/${encodeURIComponent(id)}/download`;
  const response = await resilientFetch(path);
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const uri = `${FileSystem.cacheDirectory ?? ""}provider-authorization-${id}.pdf`;
  await FileSystem.writeAsStringAsync(uri, btoa(binary), { encoding: FileSystem.EncodingType.Base64 });
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: "Share authorization PDF" });
}