import AsyncStorage from "@react-native-async-storage/async-storage";
export {
  FINANCE_INVOICES_QUERY_KEY,
  FINANCE_PAYMENT_HISTORY_QUERY_KEY,
  FINANCE_STATEMENT_SUMMARIES_QUERY_KEY,
} from "@workspace/api-client-react";
import { getApiUrl, resilientFetch } from "@/lib/query-client";

export const PROVIDER_BILLING_QUERY_KEY = ["provider-billing"] as const;
export const PROVIDER_STATEMENTS_QUERY_KEY = ["provider-statements"] as const;
export const PROVIDER_PAYMENT_HISTORY_QUERY_KEY = ["provider-payment-history"] as const;
export const PROVIDER_CHECKOUT_PENDING_KEY = "labtrax_provider_checkout_pending";

export function providerBillingReturnUrl(cancelled = false): string {
  const url = new URL("api/provider/mobile-payment-return", getApiUrl());
  if (cancelled) url.searchParams.set("cancelled", "1");
  return url.href;
}

export type AutoPayPreference = {
  enabled: boolean;
  chargeDay: number | null;
  authorization?: {
    authorizationId: string | null;
    authorizationStatus: string | null;
    nextRunAt: string | null;
    lastResult: string | null;
    lastFailureReason: string | null;
    updateCardRequired: boolean;
  };
};

export type ProviderCard = {
  providerOrganizationId: string | null;
  hasCard: boolean;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
};

export type ProviderLabBilling = {
  providerOrganizationId: string;
  labOrganizationId: string | null;
  labName: string | null;
  providerName: string;
  balanceDue: string | number;
  card: ProviderCard;
  invoiceAutoPay: AutoPayPreference;
};

export type ProviderBilling = {
  capabilities: { autoPayScheduling: boolean };
  card: ProviderCard;
  subscriptionAutoPay: AutoPayPreference;
  labs: ProviderLabBilling[];
};

export type AccountBalance = {
  labOrganizationId: string;
  providerOrganizationId: string;
  invoiceBalance: string;
  availableCredit: string;
  currentBalance: string;
  openInvoiceCount: number;
  calculatedAt: string;
};

export type ProviderStatement = {
  id: string;
  labOrganizationId: string;
  providerOrganizationId: string;
  labName: string | null;
  statementDate: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  totalAmount: string | number;
  balanceDue: string | number;
  invoiceCount: number;
  invoiceIds: string[];
};

export type ProviderPayment = {
  id: string;
  paidAt: string;
  invoiceId: string;
  invoiceNumber: string | null;
  patientName: string | null;
  amount: string | number;
  paymentMethod: string;
  referenceNumber?: string | null;
};

export type ProviderCheckoutStatus =
  | "pending"
  | "succeeded"
  | "cancelled"
  | "failed"
  | "expired";

export type ProviderCheckout = {
  checkoutId: string;
  status: ProviderCheckoutStatus;
  totalAmount?: string | number;
  failureReason?: string | null;
  settledAt?: string | null;
  allocations?: Array<{ invoiceId: string; amount: string | number }>;
};

export type ProviderCheckoutInput = {
  providerOrganizationId?: string;
  mode?: "full";
  allocations?: Array<{ invoiceId: string; amount: string | number }>;
  invoiceIds?: string[];
  amount?: string | number;
  savePaymentMethod?: boolean;
  idempotencyKey?: string;
  successUrl?: string;
  cancelUrl?: string;
};

export type ProviderCheckoutCreated = ProviderCheckout & {
  url: string | null;
};

export class ProviderBillingError extends Error {
  status: number;
  retryable: boolean;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "ProviderBillingError";
    this.status = status;
    this.retryable = status === 0 || status >= 500 || status === 408 || status === 429;
  }
}

function unwrap<T>(body: unknown): T {
  if (body && typeof body === "object" && "data" in body) {
    return (body as { data: T }).data;
  }
  return body as T;
}

async function request<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await resilientFetch(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ProviderBillingError("You appear to be offline. Check your connection and try again.");
  }
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const error = (await response.json()) as { error?: string; message?: string };
      message = error.error || error.message || message;
    } catch {
      // Keep the safe generic message for non-JSON responses.
    }
    throw new ProviderBillingError(message, response.status);
  }
  return unwrap<T>(await response.json());
}

export async function getProviderBilling(): Promise<ProviderBilling> {
  const [paymentMethod, preferences, statements] = await Promise.all([
    request<{
      card: Omit<ProviderCard, "hasCard"> | null;
      cards: Array<Omit<ProviderCard, "hasCard">>;
      hasCard: boolean;
    }>("GET", "/api/provider/payment-method"),
    request<{
      capabilities: { autoPayScheduling: boolean };
      subscription: AutoPayPreference;
      labs: Array<{
        providerOrganizationId: string;
        labOrganizationId: string | null;
        labName: string | null;
        providerName: string;
        enabled: boolean;
        chargeDay: number | null;
         authorization?: AutoPayPreference["authorization"];
       }>;
    }>("GET", "/api/provider/billing-preferences"),
    getProviderStatements(),
  ]);
  const cardByProvider = new Map(
    paymentMethod.cards.map((card) => [card.providerOrganizationId, card]),
  );
  const balances = await Promise.all(
    preferences.labs.map(async (lab) => {
      if (!lab.labOrganizationId) return [lab.providerOrganizationId, 0] as const;
      const balance = await getProviderAccountBalance(
        lab.labOrganizationId,
        lab.providerOrganizationId,
      );
      return [lab.providerOrganizationId, Number(balance.currentBalance)] as const;
    }),
  );
  const balanceByProvider = new Map(balances);
  const noCard: ProviderCard = {
    providerOrganizationId: null,
    hasCard: false,
    brand: null,
    last4: null,
    expMonth: null,
    expYear: null,
  };
  const labs = preferences.labs.map((lab) => {
    const card = cardByProvider.get(lab.providerOrganizationId);
    return {
      ...lab,
      balanceDue: balanceByProvider.get(lab.providerOrganizationId) ?? 0,
      card: card ? { ...card, hasCard: true } : { ...noCard },
       invoiceAutoPay: {
         enabled: lab.enabled,
         chargeDay: lab.chargeDay,
         authorization: lab.authorization,
       },
    };
  });
  const firstCard = paymentMethod.card
    ? { ...paymentMethod.card, hasCard: true }
    : noCard;
  return {
    capabilities: preferences.capabilities,
    card: firstCard,
    subscriptionAutoPay: preferences.subscription,
    labs,
  };
}

/**
 * Current balance for one lab ↔ provider relationship.
 *
 * The same endpoint the desktop billing screen reads, so the outstanding
 * figures the provider portal shows match desktop for the same account.
 */
export async function getProviderAccountBalance(
  labOrganizationId: string,
  providerOrganizationId: string,
): Promise<AccountBalance> {
  return request<AccountBalance>(
    "GET",
    `/api/billing/${encodeURIComponent(labOrganizationId)}/accounts/${encodeURIComponent(providerOrganizationId)}/balance`,
  );
}

export async function getProviderStatements(): Promise<ProviderStatement[]> {
  return request<ProviderStatement[]>("GET", "/api/provider/statements");
}

export async function getProviderPaymentHistory(): Promise<ProviderPayment[]> {
  return request<ProviderPayment[]>("GET", "/api/provider/payment-history");
}

export async function createProviderCardSetup(
  providerOrganizationId: string,
): Promise<{ url: string }> {
  return request<{ url: string }>("POST", "/api/provider/payment-method/setup-checkout", {
    providerOrganizationId,
    successUrl: providerBillingReturnUrl(),
    cancelUrl: providerBillingReturnUrl(true),
  });
}

export async function getProviderCardSetupStatus(
  sessionId: string,
): Promise<{ status: "pending" | "succeeded" | "expired"; card: ProviderCard | null }> {
  return request(
    "GET",
    `/api/provider/payment-method/setup-status/${encodeURIComponent(sessionId)}`,
  );
}

export async function updateSubscriptionAutoPay(preference: AutoPayPreference): Promise<AutoPayPreference> {
  const result = await request<{ subscription: AutoPayPreference }>("PATCH", "/api/provider/subscription-autopay", {
    enabled: preference.enabled,
    chargeDay: preference.chargeDay ?? 10,
  });
  return result.subscription;
}

export async function updateLabAutoPay(
  providerOrganizationId: string,
  preference: AutoPayPreference,
): Promise<AutoPayPreference> {
  const result = await request<{ lab: AutoPayPreference }>(
    "PATCH",
    `/api/provider/labs/${encodeURIComponent(providerOrganizationId)}/invoice-autopay`,
    {
      enabled: preference.enabled,
      // No day means no day: substituting a default here would read as a
      // charge-day change to the server, which then demands a fresh signed
      // authorization even though the provider is only switching auto-pay off.
      chargeDay: preference.chargeDay ?? null,
    },
  );
  return result.lab;
}

export async function createProviderCheckout(input: ProviderCheckoutInput): Promise<ProviderCheckoutCreated> {
  return request<ProviderCheckoutCreated>("POST", "/api/provider/payment-checkout", input);
}

export async function getProviderCheckoutStatus(checkoutId: string): Promise<ProviderCheckout> {
  return request<ProviderCheckout>(
    "GET",
    `/api/provider/payment-checkout/${encodeURIComponent(checkoutId)}`,
  );
}

export async function cancelProviderCheckout(checkoutId: string): Promise<ProviderCheckout> {
  return request<ProviderCheckout>(
    "POST",
    `/api/provider/payment-checkout/${encodeURIComponent(checkoutId)}/cancel`,
    {},
  );
}

/**
 * Which billing surface launched the checkout. Stripe's return link says a
 * return happened but not where it came from, so the launcher records it here
 * and the return handler reads it back.
 */
export type ProviderCheckoutOrigin = "portal" | "settings";

export type PendingProviderCheckout = {
  checkoutId?: string;
  idempotencyKey?: string;
  mode: string;
  invoiceIds?: string[];
  amount?: string;
  providerOrganizationId?: string;
  origin?: ProviderCheckoutOrigin;
  /**
   * Set when the provider came back through Stripe's cancel URL. Stripe leaves
   * the server-side checkout pending in that case, so the intent has to
   * survive a cold launch until the app can release the reservation.
   */
  cancelRequested?: boolean;
};

export async function savePendingProviderCheckout(
  checkout: PendingProviderCheckout,
): Promise<void> {
  await AsyncStorage.setItem(PROVIDER_CHECKOUT_PENDING_KEY, JSON.stringify(checkout));
}

export async function readPendingProviderCheckout(): Promise<PendingProviderCheckout | null> {
  try {
    const raw = await AsyncStorage.getItem(PROVIDER_CHECKOUT_PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      checkoutId?: unknown;
      mode?: unknown;
      invoiceIds?: unknown;
    };
    if (typeof parsed.mode !== "string") return null;
    return {
      checkoutId: typeof parsed.checkoutId === "string" ? parsed.checkoutId : undefined,
      idempotencyKey:
        typeof (parsed as { idempotencyKey?: unknown }).idempotencyKey === "string"
          ? (parsed as { idempotencyKey: string }).idempotencyKey
          : undefined,
      mode: parsed.mode,
      invoiceIds: Array.isArray(parsed.invoiceIds)
        ? parsed.invoiceIds.filter((value): value is string => typeof value === "string")
        : undefined,
      amount:
        typeof (parsed as { amount?: unknown }).amount === "string"
          ? (parsed as { amount: string }).amount
          : undefined,
      providerOrganizationId:
        typeof (parsed as { providerOrganizationId?: unknown }).providerOrganizationId === "string"
          ? (parsed as { providerOrganizationId: string }).providerOrganizationId
          : undefined,
      origin:
        (parsed as { origin?: unknown }).origin === "portal" ||
        (parsed as { origin?: unknown }).origin === "settings"
          ? ((parsed as { origin: ProviderCheckoutOrigin }).origin)
          : undefined,
      cancelRequested:
        (parsed as { cancelRequested?: unknown }).cancelRequested === true ? true : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Record that the provider came back through Stripe's cancel URL.
 *
 * Written before anything navigates: a cancelled Checkout session stays
 * pending on the server until the app asks for it to be released, and the app
 * may only get the chance after a cold launch.
 */
export async function markPendingProviderCheckoutCancelled(): Promise<void> {
  const existing = await readPendingProviderCheckout();
  if (!existing) return;
  await savePendingProviderCheckout({ ...existing, cancelRequested: true });
}

export async function prepareProviderCheckoutAttempt(input: {
  mode: string;
  invoiceIds?: string[];
  amount?: string;
  providerOrganizationId?: string;
  origin?: ProviderCheckoutOrigin;
}): Promise<{
  idempotencyKey: string;
  mode: string;
  invoiceIds?: string[];
  amount?: string;
  providerOrganizationId?: string;
  origin?: ProviderCheckoutOrigin;
}> {
  const normalized = {
    mode: input.mode,
    invoiceIds: input.invoiceIds ? [...input.invoiceIds].sort() : undefined,
    amount: input.amount,
    providerOrganizationId: input.providerOrganizationId,
    origin: input.origin,
  };
  const existing = await readPendingProviderCheckout();
  if (
    existing?.idempotencyKey &&
    existing.mode === normalized.mode &&
    existing.amount === normalized.amount &&
    existing.providerOrganizationId === normalized.providerOrganizationId &&
    JSON.stringify(existing.invoiceIds ? [...existing.invoiceIds].sort() : undefined) ===
      JSON.stringify(normalized.invoiceIds)
  ) {
    // The same payment resumed from another surface keeps its idempotency key
    // (and any checkout already created for it) but must record where the
    // provider is now, or Stripe's return lands on the surface they left.
    if (existing.origin !== normalized.origin) {
      await savePendingProviderCheckout({ ...existing, origin: normalized.origin });
    }
    return { ...normalized, idempotencyKey: existing.idempotencyKey };
  }
  const attempt = {
    ...normalized,
    idempotencyKey: `mobile-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
  await savePendingProviderCheckout(attempt);
  return attempt;
}

export async function clearPendingProviderCheckout(): Promise<void> {
  await AsyncStorage.removeItem(PROVIDER_CHECKOUT_PENDING_KEY);
}

export function validChargeDay(day: number | null | undefined): day is number {
  return typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 10;
}

export function checkoutStatusMessage(status: ProviderCheckoutStatus): {
  title: string;
  message: string;
  tone: "success" | "warning" | "error" | "neutral";
} {
  switch (status) {
    case "succeeded":
      return {
        title: "Payment confirmed",
        message: "The server confirmed your payment. Balances and payment history have been refreshed.",
        tone: "success",
      };
    case "cancelled":
      return { title: "Payment cancelled", message: "No invoice was changed. You can try again whenever you’re ready.", tone: "neutral" };
    case "failed":
      return { title: "Payment declined", message: "Your card was declined. No invoice was changed. Check the card and try again.", tone: "error" };
    case "expired":
      return { title: "Checkout expired", message: "This checkout has expired and no invoice was changed. Start a new payment.", tone: "warning" };
    default:
      return { title: "Payment still processing", message: "Stripe has not confirmed this payment yet. We’ll keep your invoices unchanged until it does.", tone: "warning" };
  }
}