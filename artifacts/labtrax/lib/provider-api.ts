// Request helper for provider-portal endpoints.
//
// Why this exists rather than calling resilientFetch directly everywhere:
// provider endpoints are tenant-scoped and the server answers 409
// PROVIDER_ORGANIZATION_REQUIRED when it cannot resolve which practice the
// request belongs to. That is not a generic failure — it means "show the
// practice picker". Routing every provider call through here keeps that
// distinction in one place so a section screen cannot accidentally render it
// as "Something went wrong".
//
// The active practice itself rides on `x-provider-organization-id`, stamped by
// the shared request layer (see setProviderOrganizationId in query-client).
//
// ── Which provider endpoints are in the shared API contract ────────────────
// Checked against lib/api-spec/openapi.yaml, which is what
// @workspace/api-client-react is generated from. The per-section tasks should
// use this to decide between a generated hook and `providerRequest` below.
//
// IN the contract (generated hooks exist — prefer them):
//   GET  /cases/provider                    — the provider's own cases
//   GET  /notifications, POST /notifications/mark-all-read
//   GET/PATCH /users/me/doctor-preferences  (also email- and sms-preferences)
//   /provider/autopay-authorization/**      — 9 paths
//   /provider/lab-autopay-authorization/**  — 2 paths
//
// NOT in the contract (use `providerRequest`; the generated client has no
// hook for them, and adding one means regenerating the spec):
//   GET  /provider/organizations            — the practice list, used here
//   POST /provider/selection                — server-side active practice
//   every other /api/provider/* route in artifacts/api-server/src/routes/
//     provider.ts (dashboard, invoices, statements, payment history, lab
//     card, checkout, stats), and all of /api/provider-messenger/*
//   POST /notifications/:id/read            — marking one notification read
//
// No server change was needed: the practice is resolved from the
// `x-provider-organization-id` header by provider-selection.ts, which mobile
// now sends on every request, multipart uploads included.
import { resilientFetch, getProviderOrganizationId } from "@/lib/query-client";

export const PROVIDER_SELECTION_REQUIRED_CODE = "PROVIDER_ORGANIZATION_REQUIRED";

export class ProviderSelectionRequiredError extends Error {
  constructor(message = "Select a practice before entering the provider portal.") {
    super(message);
    this.name = "ProviderSelectionRequiredError";
  }
}

// The practice provider registers here so a 409 raised by any provider request
// — including ones fired outside the React tree — reopens the picker.
let selectionRequiredHandler: (() => void) | null = null;

export function setProviderSelectionRequiredHandler(
  handler: (() => void) | null,
): void {
  selectionRequiredHandler = handler;
}

function errorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const details = (body as { details?: unknown }).details;
  if (details && typeof details === "object" && "code" in details) {
    const code = (details as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return `Request failed (${status}).`;
}

/**
 * Perform a provider-portal request and unwrap the `{ ok, data }` envelope.
 *
 * Throws {@link ProviderSelectionRequiredError} — and notifies the registered
 * handler — when the server reports that a practice must be selected first.
 */
export async function providerRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const requestedPractice = getProviderOrganizationId();
  const response = await resilientFetch(path, init);
  if (response.ok) {
    const body = (await response.json()) as { data?: T } | T;
    return body && typeof body === "object" && "data" in (body as object)
      ? ((body as { data: T }).data)
      : (body as T);
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON error body — fall back to the status code below.
  }

  if (response.status === 409 && errorCode(body) === PROVIDER_SELECTION_REQUIRED_CODE) {
    // An outgoing practice's delayed refusal must not clear a newer selection.
    if (requestedPractice === getProviderOrganizationId() &&
      path !== "/api/provider/organizations" && path !== "/api/provider/selection") {
      selectionRequiredHandler?.();
    }
    throw new ProviderSelectionRequiredError(errorMessage(body, response.status));
  }

  throw new Error(errorMessage(body, response.status));
}
