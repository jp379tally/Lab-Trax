/**
 * Provider-portal endpoints that are scoped to the authenticated provider
 * user rather than to a specific lab org.  Mounted at /provider.
 */
import { Router } from "express";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import { db } from "@workspace/db";
import {
  cases,
  invoices,
  organizations,
  payments,
  practiceStatements,
  providerPaymentAllocations,
  providerPaymentCheckouts,
  providerPaymentCustomers,
  subscriptions,
  providerAutopayAuthorizations,
  providerAutopayAuthorizationLabs,
  providerAutopayAuthorizationRequests,
  providerAutoPayAttempts,
  users,
} from "@workspace/db";
import { HttpError, ok } from "../lib/http";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth, requireVerifiedAccount } from "../middlewares/auth";
import { getProviderOrgIdsForUserAndLinks } from "../lib/cross-lab-doctor";
import { notDeleted } from "../lib/soft-delete";
import {
  getUncachableStripeClient,
} from "../lib/stripeClient";
import { ADMIN_ROLES, BILLING_ROLES, requireAnyRole } from "../lib/rbac";
import {
  markProviderPaymentCheckoutFailed,
  settleProviderPaymentCheckout,
} from "../lib/provider-invoice-payments";
import { getSubjectForUser } from "../lib/entitlement";
import {
  assertLinkedProviderCapability,
  requireLinkedProviderCapability,
} from "../lib/provider-capabilities";
import { writeAuditLog, writeAuditLogTx } from "../lib/audit";
import {
  getActiveProviderOrganizations,
  requireSelectedProviderOrganization,
} from "../lib/provider-selection";
import {
  getCachedSharedCardSummary,
  refreshSharedCardSummary,
  type SharedCardSummary,
} from "../lib/provider-shared-account";
import {
  deleteCaseMediaFromObjectStorage,
  openCaseMediaObjectStream,
  writeCaseMediaToObjectStorage,
} from "../lib/case-media-object-storage";
import { getAppBaseUrl, sendMail } from "../lib/mail";

const router = Router();

type ProviderStatementInvoiceDetail = {
  invoiceNumber: string;
  patientName: string | null;
  billTo: string | null;
  issuedAt?: string | null;
  dueAt?: string | null;
  status?: string;
};

function providerStatementInvoiceIds(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((id): id is string => typeof id === "string" && !!id)))
    : [];
}

function providerStatementInvoiceDetails(
  value: unknown,
): Map<string, ProviderStatementInvoiceDetail> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return new Map();
  return new Map(
    Object.entries(value as Record<string, unknown>).flatMap(([invoiceId, raw]) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const detail = raw as Record<string, unknown>;
      if (typeof detail.invoiceNumber !== "string") return [];
      const hasIssuedAt = Object.prototype.hasOwnProperty.call(detail, "issuedAt");
      const hasDueAt = Object.prototype.hasOwnProperty.call(detail, "dueAt");
      return [[invoiceId, {
        invoiceNumber: detail.invoiceNumber,
        patientName: typeof detail.patientName === "string" ? detail.patientName : null,
        billTo: typeof detail.billTo === "string" ? detail.billTo : null,
        ...(hasIssuedAt && (detail.issuedAt === null || typeof detail.issuedAt === "string")
          ? { issuedAt: detail.issuedAt } : {}),
        ...(hasDueAt && (detail.dueAt === null || typeof detail.dueAt === "string")
          ? { dueAt: detail.dueAt } : {}),
        ...(typeof detail.status === "string" ? { status: detail.status } : {}),
      }] as const];
    }),
  );
}

function providerStatementInvoiceAmounts(value: unknown): Map<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return new Map();
  return new Map(
    Object.entries(value as Record<string, unknown>).flatMap(([id, amount]) =>
      typeof amount === "string" || typeof amount === "number"
        ? [[id, Number(amount).toFixed(2)] as const]
        : []),
  );
}

// Stripe requires an HTTPS return URL, while the mobile app authenticates with
// bearer tokens and cannot rely on a browser cookie. This public bridge carries
// no payment state; it only hands control back to the registered app scheme.
router.get("/mobile-payment-return", (req, res) => {
  const cancelled = req.query.cancelled === "1";
  const setupSession =
    typeof req.query.providerCardSetupSession === "string"
      ? req.query.providerCardSetupSession
      : null;
  const params = new URLSearchParams({ returned: "1" });
  if (cancelled) params.set("cancelled", "1");
  if (setupSession) params.set("providerCardSetupSession", setupSession);
  const target = `labtrax://provider-billing?${params.toString()}`;
  const attributeTarget = target.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  res
    .status(200)
    .type("html")
    .send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${attributeTarget}"><title>Return to LabTrax</title></head>
<body><p>Returning to LabTrax…</p><p><a href="${attributeTarget}">Open LabTrax</a></p>
<script>window.location.replace(${JSON.stringify(target)});</script></body></html>`);
});

router.use(requireAuth);
router.use(requireVerifiedAccount);
const providerSelectionHeader = "x-provider-organization-id";

router.get("/organizations", asyncHandler(async (req, res) => {
  const orgs = await getActiveProviderOrganizations((req as any).auth.userId as string);
  return ok(res, orgs.map((org) => ({
    id: org.id,
    name: org.displayName || org.name,
    displayName: org.displayName,
    phone: org.phone,
    addressLine1: org.addressLine1,
    addressLine2: org.addressLine2,
    city: org.city,
    state: org.state,
    zip: org.zip,
    parentLabOrganizationId: org.parentLabOrganizationId,
    accountNumber: org.accountNumber,
  })));
}));

router.post("/selection", asyncHandler(async (req, res) => {
  const callerId = (req as any).auth.userId as string;
  const requestedId = typeof req.body?.providerOrganizationId === "string"
    ? req.body.providerOrganizationId : null;
  const org = await requireSelectedProviderOrganization(callerId, requestedId);
  await writeAuditLog({
    req,
    action: "provider_organization_switched",
    entityType: "organization",
    entityId: org.id,
    metadataJson: { providerOrganizationId: org.id },
  });
  return ok(res, { providerOrganizationId: org.id });
}));

// Every authenticated provider-portal operation is tenant-scoped. Public
// return bridges above this point and processor webhooks mounted elsewhere do
// not pass through this middleware.
router.use(asyncHandler(async (req, _res, next) => {
  if ((req as any).user?.userType === "provider") {
    const org = await requireSelectedProviderOrganization(
      (req as any).auth.userId as string,
      req.header("x-provider-organization-id"),
    );
    (req as any).providerOrganizationId = org.id;
  }
  next();
}));
// Keep the retired endpoint deterministic for old clients. It cannot mutate
// accounting and should not depend on current subscription state.
router.post(
  "/pay",
  asyncHandler(async () => {
    throw new HttpError(
      410,
      "Provider payments must be completed through Stripe Checkout.",
    );
  }),
);
// All /provider routes are billing/payment portal APIs. Standard and Premium
// provider plans may use them; lab users do not receive a provider-plan gate.
router.use(requireLinkedProviderCapability("billing"));

// ─────────────────────────────────────────────────────────────────────────────
// GET /provider/statements
//
// Returns the 12 most-recent statement runs for the authenticated provider's
// practice(s). Each row carries: labName, statementDate (= periodEnd),
// periodStart, periodEnd, totalAmount (totalBilled), balanceDue, invoiceCount,
// and invoiceIds so the client can fetch the individual invoice details.
//
// The provider org set is derived entirely from the caller's identity and
// cannot be widened by any client-supplied input.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/statements",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;

    // Resolve the caller's linked provider org ids
    const providerOrgIds = [(req as any).providerOrganizationId as string];
    if (providerOrgIds.length === 0) return ok(res, []);

    // Fetch the 12 most-recent practice_statements rows for those provider orgs
    const rows = await db
      .select()
      .from(practiceStatements)
      .where(inArray(practiceStatements.providerOrganizationId, providerOrgIds))
      .orderBy(desc(practiceStatements.createdAt))
      .limit(12);

    if (rows.length === 0) return ok(res, []);

    // Resolve lab names for the statement rows
    const labOrgIds = Array.from(new Set(rows.map((r) => r.labOrganizationId)));
    const labOrgs = labOrgIds.length
      ? await db
          .select({
            id: organizations.id,
            name: organizations.name,
            displayName: organizations.displayName,
          })
          .from(organizations)
          .where(inArray(organizations.id, labOrgIds))
      : [];
    const labById = new Map(labOrgs.map((o) => [o.id, o]));

    // Compute LIVE balanceDue from the invoices table rather than the stale
    // practiceStatements.balanceDue snapshot (which is never updated after
    // provider payments are recorded).
    const allInvoiceIds = Array.from(
      new Set(
        rows.flatMap((r) =>
          Array.isArray(r.invoiceIdsJson) ? (r.invoiceIdsJson as string[]) : []
        )
      )
    );
    const liveInvoices = allInvoiceIds.length
      ? await db
          .select({ id: invoices.id, balanceDue: invoices.balanceDue })
          .from(invoices)
          .where(and(
            inArray(invoices.id, allInvoiceIds),
            isNull(invoices.deletedAt),
            ne(invoices.status, "void"),
          ))
      : [];
    const liveBalanceMap = new Map(
      liveInvoices.map((inv) => [inv.id, Number(inv.balanceDue ?? 0)])
    );

    const result = rows.map((row) => {
      const lab = labById.get(row.labOrganizationId);
      const labName = lab ? lab.displayName || lab.name : null;
      const rowInvoiceIds = Array.isArray(row.invoiceIdsJson)
        ? (row.invoiceIdsJson as string[])
        : [];
      const liveBalanceDue = rowInvoiceIds.reduce(
        (s, id) => s + (liveBalanceMap.get(id) ?? 0),
        0
      );
      return {
        id: row.id,
        labOrganizationId: row.labOrganizationId,
        providerOrganizationId: row.providerOrganizationId,
        labName,
        // statementDate is the end of the billing period (most meaningful to providers)
        statementDate: row.periodEnd,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        invoiceCount: row.invoiceCount,
        totalAmount: row.totalBilled,
        // Live balance derived from current invoice balances — not the stale snapshot.
        balanceDue: liveBalanceDue.toFixed(2),
        invoiceIds: row.invoiceIdsJson,
        createdAt: row.createdAt,
      };
    });

    return ok(res, result);
  })
);

router.get(
  "/statements/:statementId",
  asyncHandler(async (req, res) => {
    const providerOrganizationId = (req as any).providerOrganizationId as string;
    const statement = await db.query.practiceStatements.findFirst({
      where: and(
        eq(practiceStatements.id, String(req.params.statementId)),
        eq(practiceStatements.providerOrganizationId, providerOrganizationId),
      ),
    });
    if (!statement) throw new HttpError(404, "Statement not found.");

    const ids = providerStatementInvoiceIds(statement.invoiceIdsJson);
    const rows = ids.length
      ? await db.select().from(invoices).where(and(
          inArray(invoices.id, ids),
          eq(invoices.labOrganizationId, statement.labOrganizationId),
          eq(invoices.providerOrganizationId, providerOrganizationId),
          isNull(invoices.deletedAt),
        ))
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const details = providerStatementInvoiceDetails(statement.invoiceDetailsJson);
    const amounts = providerStatementInvoiceAmounts(statement.invoiceAmountsJson);
    const invoiceRows = ids.flatMap((id) => {
      const row = byId.get(id);
      const detail = details.get(id);
      if (!row && !detail) return [];
      const metadata = row?.displayMetadataJson &&
        typeof row.displayMetadataJson === "object"
        ? row.displayMetadataJson as Record<string, unknown>
        : null;
      const patientName = detail
        ? detail.patientName
        : typeof metadata?.patientName === "string" ? metadata.patientName : null;
      return [{
        id,
        invoiceNumber: detail?.invoiceNumber ?? row!.invoiceNumber,
        status: detail?.status ?? row?.status ?? "deleted",
        issuedAt: detail && "issuedAt" in detail ? detail.issuedAt : row?.issuedAt ?? null,
        dueAt: detail && "dueAt" in detail ? detail.dueAt : row?.dueAt ?? null,
        total: amounts.get(id) ?? row?.total ?? "0.00",
        balanceDue: row && row.status !== "void" ? row.balanceDue : "0.00",
        currentBalanceDue: row && row.status !== "void" ? row.balanceDue : "0.00",
        eligibleForPayment:
          !!row &&
          ["open", "partially_paid", "overdue"].includes(row.status) &&
          Number(row.balanceDue) > 0,
        patientName,
        displayMetadata: { patientName },
      }];
    });
    return ok(res, {
      id: statement.id,
      labOrganizationId: statement.labOrganizationId,
      providerOrganizationId,
      periodStart: statement.periodStart,
      periodEnd: statement.periodEnd,
      invoices: invoiceRows,
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Provider invoice card checkout
// ─────────────────────────────────────────────────────────────────────────────
const currencyAmountSchema = z
  .union([z.string(), z.number()])
  .superRefine((value, ctx) => {
    const raw = String(value);
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw) || Number(raw) <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Amount must be a positive USD value with at most two decimal places.",
      });
    }
  })
  .transform((value) => Math.round(Number(value) * 100));

const providerCheckoutSchema = z.object({
  providerOrganizationId: z.string().min(1).optional(),
  // Full mode asks the server to select every currently payable invoice for
  // the authenticated provider organization and calculate the live balance.
  mode: z.literal("full").optional(),
  // Explicit allocations are used for selected invoice amounts.
  allocations: z
    .array(
      z.object({
        invoiceId: z.string().min(1),
        amount: currencyAmountSchema,
      }),
    )
    .max(500)
    .optional(),
  // invoiceIds without allocations means "pay each selected invoice in full".
  invoiceIds: z.array(z.string().min(1)).max(500).optional(),
  // An amount without allocations is allocated oldest-first across the selected
  // invoices (or all payable invoices when invoiceIds is omitted).
  amount: currencyAmountSchema.optional(),
  savePaymentMethod: z.boolean().default(false),
  idempotencyKey: z.string().min(1).max(200).optional(),
  successUrl: z.string().max(2000).optional(),
  cancelUrl: z.string().max(2000).optional(),
}).superRefine((value, ctx) => {
  if (value.allocations && value.allocations.length > 0 && value.amount != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["amount"],
      message: "Use amount only when allocations are not supplied.",
    });
  }
  if (
    (!value.allocations || value.allocations.length === 0) &&
    !value.amount &&
    (!value.invoiceIds || value.invoiceIds.length === 0) &&
    value.mode !== "full"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allocations"],
      message: "Provide invoice allocations, invoiceIds, amount, or full mode.",
    });
  }
});

// Inline card collection deliberately accepts identifiers and allocation data
// only.  Card numbers, CVCs, and expiry values must go directly to Stripe.js.
const PAYABLE_PROVIDER_INVOICE_STATUSES = new Set([
  "open",
  "partially_paid",
  "overdue",
]);

function providerReturnOrigins(): string[] {
  const configuredOrigins = (process.env.PROVIDER_PAYMENT_RETURN_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const replitOrigins = (process.env.REPLIT_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim())
    .filter(Boolean)
    .map((domain) => `https://${domain}`);
  const origins = [...configuredOrigins, ...replitOrigins].filter((origin) => {
    try {
      const parsed = new URL(origin);
      return parsed.protocol === "https:" || parsed.hostname === "localhost";
    } catch {
      return false;
    }
  });
  if (origins.length > 0) return [...new Set(origins)];
  if (process.env.NODE_ENV !== "production") {
    return [`http://localhost:${process.env.PORT ?? "5000"}`];
  }
  throw new HttpError(503, "Provider payment return origins are not configured.");
}

function safeReturnUrl(candidate: string | undefined, fallback: string): string {
  if (!candidate) return fallback;
  try {
    const direct = new URL(candidate);
    if (
      direct.protocol === "labtrax:" &&
      !direct.username &&
      !direct.password
    ) {
      return direct.toString();
    }
    const allowedOrigins = providerReturnOrigins();
    const parsed = new URL(candidate, allowedOrigins[0]);
    if (!allowedOrigins.includes(parsed.origin)) {
      throw new HttpError(400, "Return URL must use this application.");
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid return URL.");
  }
}

async function getProviderCheckoutAllocations(
  providerOrgIds: string[],
  input: z.infer<typeof providerCheckoutSchema>,
): Promise<{
  providerOrganizationId: string;
  allocations: Array<{ invoiceId: string; amount: string; amountCents: number }>;
}> {
  if (providerOrgIds.length === 0) {
    throw new HttpError(403, "No provider organization found for your account.");
  }
  if (
    input.providerOrganizationId &&
    !providerOrgIds.includes(input.providerOrganizationId)
  ) {
    throw new HttpError(403, "That provider billing relationship is unavailable.");
  }
  const scopedProviderIds = input.providerOrganizationId
    ? [input.providerOrganizationId]
    : providerOrgIds;

  const explicitIds = input.allocations?.map((allocation) => allocation.invoiceId) ??
    input.invoiceIds ??
    [];
  if (new Set(explicitIds).size !== explicitIds.length) {
    throw new HttpError(400, "Each invoice may only be allocated once.");
  }

  const rows = await db
    .select()
    .from(invoices)
    .where(
      and(
        inArray(invoices.providerOrganizationId, scopedProviderIds),
        isNull(invoices.deletedAt),
        explicitIds.length > 0
          ? inArray(invoices.id, explicitIds)
          : undefined,
      ),
    );
  if (explicitIds.length > 0 && rows.length !== explicitIds.length) {
    throw new HttpError(403, "One or more invoices are not available to this account.");
  }
  const orderedRows = explicitIds.length > 0
    ? explicitIds.map((id) => rows.find((row) => row.id === id)!)
    : rows;
  if (orderedRows.length === 0) {
    throw new HttpError(400, "No payable invoices were selected.");
  }

  const providerIds = new Set(
    orderedRows.map((row) => row.providerOrganizationId).filter(Boolean),
  );
  if (providerIds.size !== 1) {
    throw new HttpError(400, "A checkout must use one provider organization.");
  }
  const providerOrganizationId = [...providerIds][0] as string;
  if (input.allocations && input.allocations.length > 0) {
    const byId = new Map(input.allocations.map((allocation) => [
      allocation.invoiceId,
      allocation.amount,
    ]));
    return {
      providerOrganizationId,
      allocations: orderedRows.map((row) => {
        if (!PAYABLE_PROVIDER_INVOICE_STATUSES.has(row.status)) {
          throw new HttpError(400, `Invoice ${row.invoiceNumber} cannot accept payment.`);
        }
        const amountCents = byId.get(row.id)!;
        const balanceCents = Math.round(Number(row.balanceDue) * 100);
        if (amountCents > balanceCents) {
          throw new HttpError(400, `Payment exceeds the balance due for invoice ${row.invoiceNumber}.`);
        }
        return {
          invoiceId: row.id,
          amount: (amountCents / 100).toFixed(2),
          amountCents,
        };
      }),
    };
  }

  const requestedAmountCents = input.amount == null
    ? orderedRows.reduce(
        (total, row) =>
          PAYABLE_PROVIDER_INVOICE_STATUSES.has(row.status)
            ? total + Math.max(0, Math.round(Number(row.balanceDue) * 100))
            : total,
        0,
      )
    : input.amount;
  let remainingCents = requestedAmountCents;
  const allocations: Array<{ invoiceId: string; amount: string; amountCents: number }> = [];
  for (const row of orderedRows) {
    if (!PAYABLE_PROVIDER_INVOICE_STATUSES.has(row.status)) {
      if (input.invoiceIds?.includes(row.id)) {
        throw new HttpError(400, `Invoice ${row.invoiceNumber} cannot accept payment.`);
      }
      continue;
    }
    const availableCents = Math.max(0, Math.round(Number(row.balanceDue) * 100));
    const appliedCents = Math.min(remainingCents, availableCents);
    if (appliedCents > 0) {
      allocations.push({
        invoiceId: row.id,
        amount: (appliedCents / 100).toFixed(2),
        amountCents: appliedCents,
      });
      remainingCents -= appliedCents;
    }
    if (remainingCents === 0) break;
  }
  if (remainingCents > 0 || allocations.length === 0) {
    throw new HttpError(400, "Requested amount exceeds the payable invoice balances.");
  }
  return { providerOrganizationId, allocations };
}

export async function getOrCreateProviderPaymentCustomer(
  providerOrganizationId: string,
  stripe: import("stripe").default,
): Promise<string> {
  const [existing] = await db
    .select()
    .from(providerPaymentCustomers)
    .where(eq(providerPaymentCustomers.providerOrganizationId, providerOrganizationId))
    .limit(1);
  if (existing) return existing.stripeCustomerId;

  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, providerOrganizationId))
    .limit(1);
  if (!organization) throw new HttpError(404, "Provider organization not found.");

  const customer = await stripe.customers.create(
    {
      name: organization.displayName ?? organization.name,
      email: organization.billingEmail ?? undefined,
      metadata: { providerOrganizationId },
    },
    { idempotencyKey: `provider-payment-customer-${providerOrganizationId}` },
  );
  try {
    await db.insert(providerPaymentCustomers).values({
      providerOrganizationId,
      stripeCustomerId: customer.id,
    });
  } catch {
    // A concurrent request may have won the unique provider-org insert.
    const [winner] = await db
      .select()
      .from(providerPaymentCustomers)
      .where(eq(providerPaymentCustomers.providerOrganizationId, providerOrganizationId))
      .limit(1);
    if (winner) return winner.stripeCustomerId;
    throw new HttpError(503, "Could not save the Stripe customer.");
  }
  return customer.id;
}

type ProviderRelationship = {
  providerOrganizationId: string;
  labOrganizationId: string | null;
  labName: string | null;
  providerName: string;
};

async function getProviderRelationships(
  callerId: string,
  selectedProviderOrganizationId?: string,
): Promise<ProviderRelationship[]> {
  const providerOrgIds = selectedProviderOrganizationId
    ? [selectedProviderOrganizationId]
    : (await getProviderOrgIdsForUserAndLinks(callerId)).providerOrgIds;
  if (providerOrgIds.length === 0) return [];
  const providerRows = await db
    .select({
      providerOrganizationId: organizations.id,
      providerName: organizations.displayName,
      providerNameFallback: organizations.name,
      labOrganizationId: organizations.parentLabOrganizationId,
    })
    .from(organizations)
    .where(inArray(
      organizations.id,
      selectedProviderOrganizationId ? [selectedProviderOrganizationId] : providerOrgIds,
    ));
  const labIds = providerRows
    .map((row) => row.labOrganizationId)
    .filter((id): id is string => Boolean(id));
  const labRows = labIds.length
    ? await db
        .select({
          id: organizations.id,
          name: organizations.displayName,
          nameFallback: organizations.name,
        })
        .from(organizations)
        .where(inArray(organizations.id, labIds))
    : [];
  const labById = new Map(labRows.map((row) => [
    row.id,
    row.name || row.nameFallback,
  ]));
  return providerRows.map((row) => ({
    providerOrganizationId: row.providerOrganizationId,
    labOrganizationId: row.labOrganizationId,
    labName: row.labOrganizationId
      ? labById.get(row.labOrganizationId) ?? null
      : null,
    providerName: row.providerName || row.providerNameFallback,
  }));
}

type ProviderCard = {
  providerOrganizationId: string;
  labName: string | null;
} & SharedCardSummary;

async function getProviderCard(
  relationship: ProviderRelationship,
  stripe: import("stripe").default | null,
): Promise<ProviderCard | null> {
  let card = await getCachedSharedCardSummary(
    relationship.providerOrganizationId,
  );
  if (stripe) {
    card = (
      await refreshSharedCardSummary(
        relationship.providerOrganizationId,
        stripe,
      )
    ).card;
  }
  if (!card) return null;
  return {
    providerOrganizationId: relationship.providerOrganizationId,
    labName: relationship.labName,
    ...card,
  };
}

function providerSetupReturnUrl(
  returnUrl: string,
  sessionId: string,
  providerOrganizationId: string,
  cancelled = false,
): string {
  const result = new URL(returnUrl);
  result.searchParams.set("providerCardSetupSession", sessionId);
  result.searchParams.set("providerOrganizationId", providerOrganizationId);
  if (cancelled) result.searchParams.set("cancelled", "1");
  return result.toString();
}

const providerPreferenceSchema = z.object({
  enabled: z.boolean(),
  // Parse/validate the day only when enabling. Disabling must remain possible
  // with payloads from old clients containing a stale or invalid day.
  chargeDay: z.unknown().optional(),
}).superRefine((value, ctx) => {
  if (value.enabled) {
    const day = typeof value.chargeDay === "number"
      ? value.chargeDay
      : Number(value.chargeDay);
    if (!Number.isInteger(day) || day < 1 || day > 10) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["chargeDay"], message: "Charge day must be between 1 and 10." });
    }
  }
}).transform((value) => ({
  enabled: value.enabled,
  chargeDay: value.enabled ? Number(value.chargeDay) : null,
}));
const PROVIDER_AUTO_PAY_SCHEDULING_AVAILABLE = true;

function requireProviderAutoPayCapability() {
  if (!PROVIDER_AUTO_PAY_SCHEDULING_AVAILABLE) {
    throw new HttpError(
      503,
      "Automatic payment scheduling is not available yet.",
    );
  }
}

const AUTOPAY_AGREEMENT_VERSION = "2025-01";
const AUTOPAY_AGREEMENT_TEXT =
  "This authorization permits LabTrax to automatically pay the selected provider subscription fees and lab bills using the masked card summary shown. Payments are due by the 10th of each month.";
const autopayInput = z.object({
  requestId: z.string().optional(),
  requestToken: z.string().min(20).optional(),
  providerOrganizationId: z.string().min(1),
  agreementVersion: z.string().min(1),
  agreementSha256: z.string().regex(/^[a-f0-9]{64}$/),
  subscriptionFees: z.boolean().default(false),
  labBills: z.boolean().default(false),
  labOrganizationIds: z.array(z.string()).default([]),
  labChargeDay: z.number().int().min(1).max(10).nullable().optional(),
  typedLegalName: z.string().trim().min(1).max(200),
  consent: z.literal(true),
  signatureData: z.string().min(1).max(2_000_000),
});

const authorizationRequestInput = z.object({
  providerOrganizationId: z.string().min(1),
  labOrganizationId: z.string().min(1),
  subscriptionFees: z.boolean().default(false),
  labBills: z.boolean().default(false),
  labOrganizationIds: z.array(z.string()).default([]),
  labChargeDay: z.number().int().min(1).max(10).nullable().optional(),
  recipientEmail: z.string().email().optional(),
  deliveryMode: z.enum(["email", "in_person"]).optional(),
  presentInPerson: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (value.deliveryMode === "email" && value.presentInPerson === true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Choose email or in-person delivery." });
  }
  if (value.deliveryMode === "in_person" && value.recipientEmail) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "In-person requests cannot specify an email." });
  }
});

async function pdfBuffer(text: string, signature: Buffer): Promise<Buffer> {
  const doc = new PDFDocument({ size: "LETTER", margin: 54 });
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(16).text("Provider Auto-Pay Authorization");
    doc.moveDown().fontSize(11).text(text, { width: 490 });
    doc.moveDown().text("Drawn signature:");
    try {
      doc.image(signature, { fit: [240, 100] });
    } catch {
      reject(new HttpError(400, "Signature PNG cannot be decoded."));
      return;
    }
    doc.end();
  });
}

export function providerAutopaySignatureBytes(value: string): Buffer {
  const match = value.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new HttpError(400, "signatureData must be a base64 data URL.");
  const encoded = match[1];
  if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded) ||
      encoded.indexOf("=") >= 0 && encoded.indexOf("=") < encoded.length - 2) {
    throw new HttpError(400, "Invalid drawn signature.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e ||
      bytes[3] !== 0x47 || bytes[4] !== 0x0d || bytes[5] !== 0x0a ||
      bytes[6] !== 0x1a || bytes[7] !== 0x0a) throw new HttpError(400, "Signature must be a PNG image.");
  return bytes;
}

function publicAuthorization(row: typeof providerAutopayAuthorizations.$inferSelect, labs: string[]) {
  return {
    id: row.id, providerOrganizationId: row.providerOrganizationId,
    agreementVersion: row.agreementVersion, agreementText: row.agreementText, agreementSha256: row.agreementSha256,
    subscriptionFees: row.subscriptionFees, labBills: row.labBills,
    labChargeDay: row.labChargeDay, labOrganizationIds: labs,
    typedLegalName: row.typedLegalName, consent: row.consent,
    signedAt: row.signedAt, status: row.status,
    card: { brand: row.cardBrand, last4: row.cardLast4, expMonth: row.cardExpMonth,
      expYear: row.cardExpYear, status: row.cardStatus, billingAddress: row.cardBillingAddressJson },
  };
}

async function currentAutopayAuthorization(
  providerOrganizationId: string,
  category: "subscription" | "invoice",
  labOrganizationId?: string | null,
  labChargeDay?: number | null,
) {
  const rows = await db
    .select({ authorization: providerAutopayAuthorizations, lab: providerAutopayAuthorizationLabs.labOrganizationId })
    .from(providerAutopayAuthorizations)
    .leftJoin(
      providerAutopayAuthorizationLabs,
      eq(providerAutopayAuthorizationLabs.authorizationId, providerAutopayAuthorizations.id),
    )
    .where(and(
      eq(providerAutopayAuthorizations.providerOrganizationId, providerOrganizationId),
      eq(providerAutopayAuthorizations.status, "active"),
      eq(providerAutopayAuthorizations.agreementVersion, AUTOPAY_AGREEMENT_VERSION),
      category === "subscription"
        ? eq(providerAutopayAuthorizations.subscriptionFees, true)
        : eq(providerAutopayAuthorizations.labBills, true),
      labOrganizationId ? eq(providerAutopayAuthorizationLabs.labOrganizationId, labOrganizationId) : undefined,
      category === "invoice" && labChargeDay != null
        ? eq(providerAutopayAuthorizations.labChargeDay, labChargeDay)
        : undefined,
    ))
    .orderBy(desc(providerAutopayAuthorizations.createdAt));
  const row = rows[0]?.authorization;
  if (!row || row.cardStatus !== "active" || !row.consent) return null;
  return row;
}

function authorizationMatchesCard(
  authorization: typeof providerAutopayAuthorizations.$inferSelect,
  customer: typeof providerPaymentCustomers.$inferSelect,
): boolean {
  const now = new Date();
  const cardIsExpired =
    authorization.cardExpYear < now.getUTCFullYear() ||
    (authorization.cardExpYear === now.getUTCFullYear() &&
      authorization.cardExpMonth < now.getUTCMonth() + 1);
  return !cardIsExpired &&
    customer.cardStatus === "active" &&
    authorization.cardBrand === customer.cardBrand &&
    authorization.cardLast4 === customer.cardLast4 &&
    authorization.cardExpMonth === customer.cardExpMonth &&
    authorization.cardExpYear === customer.cardExpYear;
}

function preferenceVisibility(
  authorization: typeof providerAutopayAuthorizations.$inferSelect | null,
  attempts: Array<typeof providerAutoPayAttempts.$inferSelect>,
  chargeDay: number,
  kind: "subscription" | "invoice" = "invoice",
  trialEndAt?: Date | null,
  authorizationUsable = true,
) {
  const last = attempts[0] ?? null;
  const next = new Date();
  next.setUTCHours(0, 0, 0, 0);
  if (kind === "subscription" && trialEndAt && next >= trialEndAt) {
    const anchor = new Date(trialEndAt);
    anchor.setUTCHours(0, 0, 0, 0);
    const elapsed = Math.max(0, Math.floor((next.getTime() - anchor.getTime()) / 86_400_000));
    next.setTime(anchor.getTime() + (Math.floor(elapsed / 30) + 1) * 30 * 86_400_000);
  } else {
    const day = next.getUTCDate();
    next.setUTCDate(day <= chargeDay ? chargeDay : 1);
    if (day > chargeDay) next.setUTCMonth(next.getUTCMonth() + 1);
  }
  return {
    authorizationId: authorization?.id ?? null,
    authorizationStatus: authorization
      ? authorizationUsable ? authorization.status : "blocked"
      : null,
    nextRunAt: next.toISOString(),
    lastResult: last?.status ?? null,
    lastFailureReason: last?.failureReason ?? null,
    updateCardRequired: !authorizationUsable ||
      last?.failureReason === "shared_card_unavailable" ||
      last?.failureReason === "card_declined",
  };
}

async function requireProviderAutopayAccess(callerId: string, requestedProviderId?: string, selectedContextId?: string) {
  if (selectedContextId && requestedProviderId && selectedContextId !== requestedProviderId) {
    throw new HttpError(403, "That provider organization is not selected.");
  }
  const selected = await requireSelectedProviderOrganization(callerId, selectedContextId ?? requestedProviderId);
  await requireAnyRole(callerId, selected.id, BILLING_ROLES);
  return selected;
}

router.get("/autopay-authorization/prepare", asyncHandler(async (req, res) => {
  const requested = typeof req.query.providerOrganizationId === "string"
    ? req.query.providerOrganizationId : undefined;
  const selectedProvider = await requireProviderAutopayAccess((req as any).auth.userId, requested, (req as any).providerOrganizationId);
  const relationships = await getProviderRelationships((req as any).auth.userId);
  const selected = relationships.filter((r) => r.providerOrganizationId === selectedProvider.id);
  if (!selected.some((r) => r.providerOrganizationId === selectedProvider.id)) {
    throw new HttpError(403, "That provider relationship is unavailable.");
  }
  const stripe = requested ? await getUncachableStripeClient() : null;
  const preparedCard = requested && selected[0] ? await getProviderCard(selected[0], stripe) : null;
  return ok(res, {
    agreementVersion: AUTOPAY_AGREEMENT_VERSION,
    agreementText: AUTOPAY_AGREEMENT_TEXT,
    agreementSha256: createHash("sha256").update(AUTOPAY_AGREEMENT_TEXT).digest("hex"),
    providerOrganizationId: requested ?? null,
    providerChoices: relationships.map((r) => ({ providerOrganizationId: r.providerOrganizationId, providerName: r.providerName })),
    labs: selected.flatMap((r) => r.labOrganizationId ? [r] : []),
    card: preparedCard,
    labChargeDay: { minimum: 1, maximum: 10 },
  });
}));

// Lab billing users may prepare a provider authorization, but cannot sign it.
router.post("/autopay-authorization/requests", asyncHandler(async (req, res) => {
  const callerId = (req as any).auth.userId as string;
  const input = authorizationRequestInput.parse(req.body);
  const inPerson = input.deliveryMode === "in_person" || input.presentInPerson === true;
  if (input.recipientEmail && inPerson) throw new HttpError(400, "In-person requests cannot specify an email.");
  if (input.deliveryMode === "email" && !input.recipientEmail) {
    throw new HttpError(400, "Email delivery requires recipientEmail.");
  }
  await requireAnyRole(callerId, input.labOrganizationId, BILLING_ROLES);
  await requireLabProviderRelationship(callerId, input.labOrganizationId, input.providerOrganizationId)
    .catch(async (error) => {
      // The relationship helper intentionally requires admin for card operations;
      // requests use billing role while retaining the same tenant relationship check.
      if (error instanceof HttpError && error.statusCode === 403) {
        const [provider] = await db.select({ parent: organizations.parentLabOrganizationId })
          .from(organizations).where(eq(organizations.id, input.providerOrganizationId)).limit(1);
        if (!provider || provider.parent !== input.labOrganizationId) throw error;
      } else throw error;
    });
  if (!input.subscriptionFees && !input.labBills) throw new HttpError(400, "Select a billing category.");
  if (input.labBills && (!input.labChargeDay || !input.labOrganizationIds.length)) throw new HttpError(400, "Lab bills require labs and a charge day.");
  const [provider] = await db.select({
    id: organizations.id, type: organizations.type, isActive: organizations.isActive,
    parentLabOrganizationId: organizations.parentLabOrganizationId,
  }).from(organizations).where(and(eq(organizations.id, input.providerOrganizationId),
    isNull(organizations.deletedAt))).limit(1);
  if (!provider || provider.type !== "provider" || !provider.isActive ||
      provider.parentLabOrganizationId !== input.labOrganizationId) {
    throw new HttpError(404, "Active provider organization not found for this lab.");
  }
  const selectedLabRows = input.labOrganizationIds.length
    ? await db.select({ id: organizations.id, type: organizations.type, deletedAt: organizations.deletedAt })
      .from(organizations).where(inArray(organizations.id, input.labOrganizationIds))
    : [];
  if (selectedLabRows.length !== input.labOrganizationIds.length ||
      selectedLabRows.some((lab) => lab.type !== "lab" || lab.deletedAt) ||
      input.labOrganizationIds.some((id) => id !== input.labOrganizationId)) {
    throw new HttpError(403, "Selected labs must be the requesting lab relationship.");
  }
  const [relationship] = await db.select({ providerName: organizations.name })
    .from(organizations).where(eq(organizations.id, input.providerOrganizationId)).limit(1);
  const stripe = await getUncachableStripeClient();
  const card = await getProviderCard({
    providerOrganizationId: input.providerOrganizationId,
    providerName: relationship?.providerName ?? "Unnamed provider",
    labOrganizationId: input.labOrganizationId,
    labName: null,
  }, stripe);
  if (!card || card.status !== "active") throw new HttpError(409, "An active shared card is required.");
  const agreementSha256 = createHash("sha256").update(AUTOPAY_AGREEMENT_TEXT).digest("hex");
  const id = randomUUID();
  const token = randomUUID() + randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 86400000);
  const [created] = await db.insert(providerAutopayAuthorizationRequests).values({
    id, providerOrganizationId: input.providerOrganizationId, labOrganizationId: input.labOrganizationId,
    requestedByUserId: callerId, agreementVersion: AUTOPAY_AGREEMENT_VERSION, agreementText: AUTOPAY_AGREEMENT_TEXT,
    agreementSha256, subscriptionFees: input.subscriptionFees, labBills: input.labBills,
    labOrganizationIds: input.labOrganizationIds, labChargeDay: input.labChargeDay ?? null,
    cardBrand: card.brand, cardLast4: card.last4, cardExpMonth: card.expMonth, cardExpYear: card.expYear,
    cardStatus: card.status, cardBillingAddressJson: card.billingAddress, recipientEmail: input.recipientEmail ?? null,
    tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt,
  }).returning({ id: providerAutopayAuthorizationRequests.id, status: providerAutopayAuthorizationRequests.status, expiresAt: providerAutopayAuthorizationRequests.expiresAt });
  await writeAuditLog({ req, userId: callerId, organizationId: input.labOrganizationId,
    action: "provider_autopay_authorization_request_prepared", entityType: "provider_autopay_authorization_request",
    entityId: id, metadataJson: { providerOrganizationId: input.providerOrganizationId, agreementVersion: AUTOPAY_AGREEMENT_VERSION } });
  let mail: { sent: boolean; reason?: string } | undefined;
  if (input.recipientEmail) {
    mail = await sendMail({
      to: input.recipientEmail,
      subject: "LabTrax provider billing authorization",
      text: `Review and sign the provider authorization: ${getAppBaseUrl()}/desktop/?providerAutopayRequest=${id}&providerAutopayToken=${token}`,
      html: `<p>Review and sign the provider authorization in LabTrax.</p><p><a href="${getAppBaseUrl()}/desktop/?providerAutopayRequest=${id}&providerAutopayToken=${token}">Review authorization</a></p>`,
    });
    if (mail.sent) {
      await db.update(providerAutopayAuthorizationRequests).set({ status: "sent", sentAt: new Date() })
        .where(and(eq(providerAutopayAuthorizationRequests.id, id),
          eq(providerAutopayAuthorizationRequests.status, "prepared")));
    } else {
      await db.update(providerAutopayAuthorizationRequests).set({ status: "cancelled", tokenHash: null })
        .where(and(eq(providerAutopayAuthorizationRequests.id, id),
          eq(providerAutopayAuthorizationRequests.status, "prepared")));
      await writeAuditLog({ req, userId: callerId, organizationId: input.labOrganizationId,
        action: "provider_autopay_authorization_request_delivery_failed",
        entityType: "provider_autopay_authorization_request", entityId: id,
        metadataJson: { reason: mail.reason ?? "mail delivery failed" } });
      throw new HttpError(503, "Authorization email could not be sent; retry the request.");
    }
    if (mail.sent) await writeAuditLog({ req, userId: callerId, organizationId: input.labOrganizationId,
      action: "provider_autopay_authorization_request_sent", entityType: "provider_autopay_authorization_request",
      entityId: id, metadataJson: { recipient: input.recipientEmail } });
  }
  return res.status(201).json({ ok: true, data: { ...created, mailSent: mail?.sent ?? false,
    deliveryMode: inPerson ? "in_person" : "email",
    ...(inPerson || process.env.VITEST ? { requestToken: token } : {}) } });
}));

router.get("/autopay-authorization/requests/:id", asyncHandler(async (req, res) => {
  const callerId = (req as any).auth.userId as string;
  const [row] = await db.select().from(providerAutopayAuthorizationRequests).where(eq(providerAutopayAuthorizationRequests.id, req.params.id)).limit(1);
  if (!row) throw new HttpError(404, "Authorization request not found.");
  const [requestCaller] = await db.select({ userType: users.userType }).from(users)
    .where(eq(users.id, callerId)).limit(1);
  if (requestCaller?.userType === "provider") {
    await requireProviderAutopayAccess(callerId, row.providerOrganizationId, (req as any).providerOrganizationId);
  } else {
    await requireAnyRole(callerId, row.labOrganizationId, BILLING_ROLES);
    const [provider] = await db.select({ id: organizations.id }).from(organizations).where(and(
      eq(organizations.id, row.providerOrganizationId), eq(organizations.type, "provider"),
      eq(organizations.parentLabOrganizationId, row.labOrganizationId),
      eq(organizations.isActive, true), isNull(organizations.deletedAt))).limit(1);
    if (!provider) throw new HttpError(403, "That provider relationship is unavailable.");
  }
  if (row.expiresAt && row.expiresAt < new Date() && ["prepared", "sent"].includes(row.status)) {
    await db.update(providerAutopayAuthorizationRequests).set({ status: "expired" })
      .where(and(eq(providerAutopayAuthorizationRequests.id, row.id),
        inArray(providerAutopayAuthorizationRequests.status, ["prepared", "sent"])));
    throw new HttpError(410, "Authorization request expired.");
  }
  const frozenLabIds = Array.isArray(row.labOrganizationIds)
    ? row.labOrganizationIds.filter((id): id is string => typeof id === "string")
    : [];
  const frozenLabs = frozenLabIds.length
    ? await db.select({ id: organizations.id, name: organizations.name, displayName: organizations.displayName })
      .from(organizations).where(inArray(organizations.id, frozenLabIds))
    : [];
  const labNames = new Map(frozenLabs.map((lab) => [lab.id, lab.displayName || lab.name || null]));
  return ok(res, { id: row.id, providerOrganizationId: row.providerOrganizationId, agreementVersion: row.agreementVersion,
    agreementText: row.agreementText, agreementSha256: row.agreementSha256, subscriptionFees: row.subscriptionFees,
    labBills: row.labBills, labOrganizationIds: row.labOrganizationIds, labChargeDay: row.labChargeDay,
    labs: frozenLabIds.map((labOrganizationId) => ({
      labOrganizationId, labName: labNames.get(labOrganizationId) ?? null,
    })),
    card: { brand: row.cardBrand, last4: row.cardLast4, expMonth: row.cardExpMonth, expYear: row.cardExpYear, status: row.cardStatus, billingAddress: row.cardBillingAddressJson },
    status: row.status, expiresAt: row.expiresAt });
}));

router.get("/autopay-authorization/requests", asyncHandler(async (req, res) => {
  const callerId = (req as any).auth.userId as string;
  const providerId = typeof req.query.providerOrganizationId === "string" ? req.query.providerOrganizationId : null;
  const labId = typeof req.query.labOrganizationId === "string" ? req.query.labOrganizationId : null;
  if (!providerId && !labId) throw new HttpError(400, "A provider or lab is required.");
  if (labId) {
    await requireAnyRole(callerId, labId, BILLING_ROLES);
    if (providerId) {
      const [provider] = await db.select({
        id: organizations.id, type: organizations.type, isActive: organizations.isActive,
        parentLabOrganizationId: organizations.parentLabOrganizationId,
      }).from(organizations).where(and(eq(organizations.id, providerId),
        isNull(organizations.deletedAt))).limit(1);
      if (!provider || provider.type !== "provider" || !provider.isActive ||
          provider.parentLabOrganizationId !== labId) {
        throw new HttpError(404, "Active provider organization not found for this lab.");
      }
    }
  } else if (providerId) {
    await requireProviderAutopayAccess(callerId, providerId, (req as any).providerOrganizationId);
  }
  const filters = [providerId ? eq(providerAutopayAuthorizationRequests.providerOrganizationId, providerId) : undefined,
    labId ? eq(providerAutopayAuthorizationRequests.labOrganizationId, labId) : undefined].filter(Boolean) as any[];
  const rows = await db.select({
    id: providerAutopayAuthorizationRequests.id, providerOrganizationId: providerAutopayAuthorizationRequests.providerOrganizationId,
    labOrganizationId: providerAutopayAuthorizationRequests.labOrganizationId, status: providerAutopayAuthorizationRequests.status,
    agreementVersion: providerAutopayAuthorizationRequests.agreementVersion, expiresAt: providerAutopayAuthorizationRequests.expiresAt,
    completedAt: providerAutopayAuthorizationRequests.completedAt, completedAuthorizationId: providerAutopayAuthorizationRequests.completedAuthorizationId,
    labOrganizationIds: providerAutopayAuthorizationRequests.labOrganizationIds,
  }).from(providerAutopayAuthorizationRequests).where(and(...filters)).orderBy(desc(providerAutopayAuthorizationRequests.createdAt));
  const listed = await Promise.all(rows.map(async (item) => {
    const ids = Array.isArray(item.labOrganizationIds)
      ? item.labOrganizationIds.filter((id): id is string => typeof id === "string") : [];
    const names = ids.length ? await db.select({ id: organizations.id, name: organizations.name, displayName: organizations.displayName })
      .from(organizations).where(inArray(organizations.id, ids)) : [];
    const byId = new Map(names.map((org) => [org.id, org.displayName || org.name || null]));
    const { labOrganizationIds: _ids, ...status } = item;
    return { ...status, labs: ids.map((labOrganizationId) => ({ labOrganizationId, labName: byId.get(labOrganizationId) ?? null })) };
  }));
  return ok(res, listed);
}));

router.post("/autopay-authorization/requests/:id/cancel", asyncHandler(async (req, res) => {
  const callerId = (req as any).auth.userId as string;
  const [row] = await db.select().from(providerAutopayAuthorizationRequests).where(eq(providerAutopayAuthorizationRequests.id, req.params.id)).limit(1);
  if (!row) throw new HttpError(404, "Authorization request not found.");
  await requireAnyRole(callerId, row.labOrganizationId, BILLING_ROLES);
  if (!["prepared", "sent"].includes(row.status)) throw new HttpError(409, "Request cannot be cancelled.");
  if (row.expiresAt && row.expiresAt <= new Date()) {
    await db.update(providerAutopayAuthorizationRequests).set({ status: "expired" })
      .where(and(eq(providerAutopayAuthorizationRequests.id, row.id),
        inArray(providerAutopayAuthorizationRequests.status, ["prepared", "sent"])));
    throw new HttpError(410, "Authorization request expired.");
  }
  const [cancelled] = await db.update(providerAutopayAuthorizationRequests).set({ status: "cancelled" })
    .where(and(eq(providerAutopayAuthorizationRequests.id, row.id),
      inArray(providerAutopayAuthorizationRequests.status, ["prepared", "sent"]),
      sql`${providerAutopayAuthorizationRequests.expiresAt} > now()`))
    .returning({ id: providerAutopayAuthorizationRequests.id });
  if (!cancelled) {
    const [expired] = await db.update(providerAutopayAuthorizationRequests).set({ status: "expired" })
      .where(and(eq(providerAutopayAuthorizationRequests.id, row.id),
        inArray(providerAutopayAuthorizationRequests.status, ["prepared", "sent"]),
        sql`${providerAutopayAuthorizationRequests.expiresAt} <= now()`))
      .returning({ id: providerAutopayAuthorizationRequests.id });
    if (expired) throw new HttpError(410, "Authorization request expired.");
    throw new HttpError(409, "Request cannot be cancelled.");
  }
  await writeAuditLog({ req, userId: callerId, organizationId: row.labOrganizationId,
    action: "provider_autopay_authorization_request_cancelled", entityType: "provider_autopay_authorization_request",
    entityId: row.id });
  return ok(res, { id: row.id, status: "cancelled" });
}));

router.post("/autopay-authorization", asyncHandler(async (req, res) => {
  const callerId = (req as any).auth.userId as string;
  const input = autopayInput.parse(req.body);
  const [caller] = await db.select({ userType: users.userType }).from(users)
    .where(eq(users.id, callerId)).limit(1);
  if (caller?.userType !== "provider") throw new HttpError(403, "Only provider users can sign an authorization.");
  await requireProviderAutopayAccess(callerId, input.providerOrganizationId, (req as any).providerOrganizationId);
  let authorizationRequest: typeof providerAutopayAuthorizationRequests.$inferSelect | null = null;
  if (input.requestId) {
    [authorizationRequest] = await db.select().from(providerAutopayAuthorizationRequests)
      .where(eq(providerAutopayAuthorizationRequests.id, input.requestId)).limit(1);
    if (!authorizationRequest || !input.requestToken ||
        authorizationRequest.tokenHash !== createHash("sha256").update(input.requestToken).digest("hex")) {
      throw new HttpError(404, "Authorization request not found.");
    }
    if (!["prepared", "sent"].includes(authorizationRequest.status)) {
      throw new HttpError(409, "Authorization request is no longer available.");
    }
    if (authorizationRequest.providerOrganizationId !== input.providerOrganizationId ||
        authorizationRequest.agreementVersion !== input.agreementVersion ||
        authorizationRequest.agreementSha256 !== input.agreementSha256 ||
        authorizationRequest.subscriptionFees !== input.subscriptionFees ||
        authorizationRequest.labBills !== input.labBills ||
        JSON.stringify(authorizationRequest.labOrganizationIds) !== JSON.stringify(input.labOrganizationIds) ||
        authorizationRequest.labChargeDay !== (input.labChargeDay ?? null)) {
      throw new HttpError(409, "Authorization request terms are stale.");
    }
  }
  if (new Set(input.labOrganizationIds).size !== input.labOrganizationIds.length) {
    throw new HttpError(400, "Duplicate lab relationships are not allowed.");
  }
  if (!input.subscriptionFees && !input.labBills) {
    throw new HttpError(400, "Select subscription fees, lab bills, or both.");
  }
  if (input.labBills && (input.labChargeDay == null || input.labOrganizationIds.length === 0)) {
    throw new HttpError(400, "Lab bills require selected labs and a charge day from 1 through 10.");
  }
  if (!input.labBills && (input.labOrganizationIds.length || input.labChargeDay != null)) {
    throw new HttpError(400, "Lab selections require lab-bill authorization.");
  }
  const relationships = await getProviderRelationships(callerId);
  const providerOrganizationId = input.providerOrganizationId;
  if (!relationships.some((r) => r.providerOrganizationId === input.providerOrganizationId)) {
    throw new HttpError(403, "That provider relationship is unavailable.");
  }
  if (!providerOrganizationId) throw new HttpError(403, "No provider billing relationship is available.");
  const expectedAgreementSha256 = createHash("sha256").update(AUTOPAY_AGREEMENT_TEXT).digest("hex");
  if (!authorizationRequest &&
      (input.agreementVersion !== AUTOPAY_AGREEMENT_VERSION || input.agreementSha256 !== expectedAgreementSha256)) {
    throw new HttpError(409, "Authorization terms are stale; prepare the agreement again.");
  }
  const signingAgreementVersion = authorizationRequest?.agreementVersion ?? AUTOPAY_AGREEMENT_VERSION;
  const signingAgreementText = authorizationRequest?.agreementText ?? AUTOPAY_AGREEMENT_TEXT;
  const signingAgreementSha256 = authorizationRequest?.agreementSha256 ?? expectedAgreementSha256;
  if (createHash("sha256").update(signingAgreementText).digest("hex") !== signingAgreementSha256) {
    throw new HttpError(409, "Authorization request terms are invalid.");
  }
  // Signing is deliberately limited to a direct active provider membership;
  // linked lab access must never confer signing authority.
  await requireAnyRole(callerId, providerOrganizationId, BILLING_ROLES);
  const selectedRelationships = relationships.filter((r) => r.providerOrganizationId === providerOrganizationId);
  const allowed = new Map(selectedRelationships.filter((r) => r.labOrganizationId)
    .map((r) => [r.labOrganizationId as string, r]));
  if (input.labOrganizationIds.some((id) => !allowed.has(id))) {
    throw new HttpError(403, "One or more lab relationships are unavailable.");
  }
  const stripe = await getUncachableStripeClient();
  const card = await getProviderCard(
    relationships.find((r) => r.providerOrganizationId === providerOrganizationId)!,
    stripe,
  );
  if (!card || card.status !== "active") throw new HttpError(409, "Add an active shared card before signing an authorization.");
  if (authorizationRequest && (
    authorizationRequest.cardBrand !== card.brand ||
    authorizationRequest.cardLast4 !== card.last4 ||
    authorizationRequest.cardExpMonth !== card.expMonth ||
    authorizationRequest.cardExpYear !== card.expYear ||
    authorizationRequest.cardStatus !== card.status ||
    JSON.stringify(authorizationRequest.cardBillingAddressJson ?? null) !== JSON.stringify(card.billingAddress ?? null)
  )) {
    throw new HttpError(409, "The shared card changed; prepare the authorization again.");
  }
  const signature = providerAutopaySignatureBytes(input.signatureData);
  const authorizationId = randomUUID();
  const signatureKey = `provider-autopay/${authorizationId}/signature`;
  const documentKey = `provider-autopay/${authorizationId}/authorization.pdf`;
  const signedAt = new Date();
  const selectedLabs = input.labOrganizationIds.map((id) => allowed.get(id)!).map((r) =>
    `${r.labOrganizationId}: ${r.labName ?? "Unnamed lab"}`).join("\n");
  const providerRelationship = selectedRelationships[0];
  const signatureChecksum = createHash("sha256").update(signature).digest("hex");
  const recordText = [
    `Authorization ID: ${authorizationId}`, `Provider organization ID: ${providerOrganizationId}`,
    `Provider organization name: ${providerRelationship?.providerName ?? "Unnamed provider"}`,
     `Agreement version: ${signingAgreementVersion}`,
     signingAgreementText, `Subscription fees: ${input.subscriptionFees}`,
    `Lab bills: ${input.labBills}`, `Selected labs:\n${selectedLabs || "None"}`,
    `Lab charge day: ${input.labChargeDay ?? "N/A"}`, `Typed legal name: ${input.typedLegalName}`,
    `Consent: ${input.consent}`, `Signer user ID: ${callerId}`, `Signed at: ${signedAt.toISOString()}`,
    `Signer IP: ${req.ip ?? "unknown"}`, `Signer user-agent: ${req.get("user-agent") ?? "unknown"}`,
    `Card: ${card.brand} ending ${card.last4}, expires ${card.expMonth}/${card.expYear}, status ${card.status}`,
    `Signature artifact: ${signatureKey}`, `Signature SHA-256: ${signatureChecksum}`,
  ].join("\n\n");
  const document = await pdfBuffer(recordText, signature);
  let signatureStored = false;
  let documentStored = false;
  try {
    signatureStored = await writeCaseMediaToObjectStorage(signatureKey, signature, "image/png");
    documentStored = signatureStored && await writeCaseMediaToObjectStorage(documentKey, document, "application/pdf");
    if (!documentStored) throw new HttpError(503, "Private authorization storage is not configured.");
  } catch (error) {
    if (documentStored) await deleteCaseMediaFromObjectStorage(documentKey);
    if (signatureStored) await deleteCaseMediaFromObjectStorage(signatureKey);
    throw error;
  }
  const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  let transactionResult: { created: typeof providerAutopayAuthorizations.$inferSelect; supersededIds: string[] };
  try {
    transactionResult = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${providerOrganizationId}))`);
      const superseded = await tx.select({ id: providerAutopayAuthorizations.id })
        .from(providerAutopayAuthorizations)
        .where(and(eq(providerAutopayAuthorizations.providerOrganizationId, providerOrganizationId),
          eq(providerAutopayAuthorizations.status, "active")));
      await tx.update(providerAutopayAuthorizations).set({ status: "superseded", supersededAt: signedAt })
        .where(and(eq(providerAutopayAuthorizations.providerOrganizationId, providerOrganizationId),
          eq(providerAutopayAuthorizations.status, "active")));
      const [created] = await tx.insert(providerAutopayAuthorizations).values({
       id: authorizationId, providerOrganizationId, agreementVersion: signingAgreementVersion,
       agreementText: signingAgreementText, agreementSha256: signingAgreementSha256,
       subscriptionFees: input.subscriptionFees,
      labBills: input.labBills, labChargeDay: input.labChargeDay ?? null, signerUserId: callerId,
      typedLegalName: input.typedLegalName, consent: true, signerIp: req.ip ?? "unknown",
      signerUserAgent: req.get("user-agent") ?? "unknown", signedAt, signatureObjectKey: signatureKey,
      signatureChecksum, documentObjectKey: documentKey, documentChecksum: digest(document),
      cardBrand: card.brand, cardLast4: card.last4, cardExpMonth: card.expMonth,
      cardExpYear: card.expYear, cardStatus: card.status,
       cardBillingAddressJson: card.billingAddress,
      }).returning();
      if (input.labOrganizationIds.length) await tx.insert(providerAutopayAuthorizationLabs)
        .values(input.labOrganizationIds.map((labOrganizationId) => ({ authorizationId, labOrganizationId })));
      if (authorizationRequest) {
        const requestHash = createHash("sha256").update(input.requestToken!).digest("hex");
        const [completedRequest] = await tx.update(providerAutopayAuthorizationRequests).set({
          status: "completed", completedAt: signedAt, completedAuthorizationId: authorizationId,
          tokenHash: null,
        }).where(and(eq(providerAutopayAuthorizationRequests.id, authorizationRequest.id),
          inArray(providerAutopayAuthorizationRequests.status, ["prepared", "sent"]),
          sql`${providerAutopayAuthorizationRequests.expiresAt} > now()`,
          eq(providerAutopayAuthorizationRequests.tokenHash, requestHash)))
          .returning({ id: providerAutopayAuthorizationRequests.id });
        if (!completedRequest) {
          const [state] = await tx.select({
            expired: sql<boolean>`${providerAutopayAuthorizationRequests.expiresAt} <= now()`,
          }).from(providerAutopayAuthorizationRequests)
            .where(eq(providerAutopayAuthorizationRequests.id, authorizationRequest.id)).limit(1);
          if (state?.expired) {
            await tx.update(providerAutopayAuthorizationRequests).set({ status: "expired" })
              .where(and(eq(providerAutopayAuthorizationRequests.id, authorizationRequest.id),
                inArray(providerAutopayAuthorizationRequests.status, ["prepared", "sent"]),
                sql`${providerAutopayAuthorizationRequests.expiresAt} <= now()`));
            throw new HttpError(410, "Authorization request expired.");
          }
          throw new HttpError(409, "Authorization request was already completed or the token was consumed.");
        }
        await writeAuditLogTx(tx, { req, userId: callerId, organizationId: authorizationRequest.labOrganizationId,
          action: "provider_autopay_authorization_request_completed",
          entityType: "provider_autopay_authorization_request", entityId: authorizationRequest.id,
          metadataJson: { authorizationId } });
      }
      await writeAuditLogTx(tx, { req, userId: callerId, organizationId: providerOrganizationId,
        action: "provider_autopay_authorization_created", entityType: "provider_autopay_authorization",
        entityId: authorizationId, metadataJson: { agreementVersion: AUTOPAY_AGREEMENT_VERSION } });
      for (const supersededId of superseded.map((item) => item.id)) {
        await writeAuditLogTx(tx, { req, userId: callerId, organizationId: providerOrganizationId,
          action: "provider_autopay_authorization_superseded", entityType: "provider_autopay_authorization",
          entityId: supersededId, metadataJson: { replacementAuthorizationId: authorizationId } });
      }
      return { created, supersededIds: superseded.map((item) => item.id) };
    });
  } catch (error) {
    await deleteCaseMediaFromObjectStorage(documentKey);
    await deleteCaseMediaFromObjectStorage(signatureKey);
    throw error;
  }
  const row = transactionResult.created;
  return res.status(201).json({ ok: true, data: publicAuthorization(row, input.labOrganizationIds) });
}));

async function authorizationForCaller(callerId: string, id?: string, currentOnly = false, selectedProviderId?: string, selectedContextId?: string) {
  const selected = await requireProviderAutopayAccess(callerId, selectedProviderId, selectedContextId);
  const scopedProviderIds = [selected.id];
  const [row] = scopedProviderIds.length ? await db.select().from(providerAutopayAuthorizations)
    .where(id
      ? and(eq(providerAutopayAuthorizations.id, id), inArray(providerAutopayAuthorizations.providerOrganizationId, scopedProviderIds))
      : currentOnly
        ? and(eq(providerAutopayAuthorizations.status, "active"), inArray(providerAutopayAuthorizations.providerOrganizationId, scopedProviderIds))
        : inArray(providerAutopayAuthorizations.providerOrganizationId, scopedProviderIds))
    .orderBy(desc(providerAutopayAuthorizations.createdAt)).limit(1) : [];
  if (!row) throw new HttpError(404, "Authorization not found.");
  const labs = await db.select({ labOrganizationId: providerAutopayAuthorizationLabs.labOrganizationId })
    .from(providerAutopayAuthorizationLabs).where(eq(providerAutopayAuthorizationLabs.authorizationId, row.id));
  return { row, labs: labs.map((l) => l.labOrganizationId) };
}

router.get("/autopay-authorization/current", asyncHandler(async (req, res) => {
  const selected = typeof req.query.providerOrganizationId === "string"
    ? req.query.providerOrganizationId : (req as any).providerOrganizationId;
  const { row, labs } = await authorizationForCaller((req as any).auth.userId, undefined, true, selected, (req as any).providerOrganizationId);
  return ok(res, publicAuthorization(row, labs));
}));
router.get("/autopay-authorization/history", asyncHandler(async (req, res) => {
  const callerId = (req as any).auth.userId as string;
  const selected = typeof req.query.providerOrganizationId === "string"
    ? req.query.providerOrganizationId : (req as any).providerOrganizationId;
  const selectedProvider = await requireProviderAutopayAccess(callerId, selected, (req as any).providerOrganizationId);
  const ids = [selectedProvider.id];
  const rows = ids.length ? await db.select().from(providerAutopayAuthorizations)
    .where(inArray(providerAutopayAuthorizations.providerOrganizationId, ids))
    .orderBy(desc(providerAutopayAuthorizations.createdAt)) : [];
  const result = await Promise.all(rows.map(async (row) => {
    const labs = await db.select({ labOrganizationId: providerAutopayAuthorizationLabs.labOrganizationId })
      .from(providerAutopayAuthorizationLabs).where(eq(providerAutopayAuthorizationLabs.authorizationId, row.id));
    return publicAuthorization(row, labs.map((l) => l.labOrganizationId));
  }));
  return ok(res, result);
}));
router.get("/autopay-authorization/:id/download", asyncHandler(async (req, res) => {
  const { row } = await authorizationForCaller((req as any).auth.userId, req.params.id, false, (req as any).providerOrganizationId, (req as any).providerOrganizationId);
  const object = await openCaseMediaObjectStream(row.documentObjectKey, "application/pdf");
  if (!object) throw new HttpError(404, "Authorization document not found.");
  res.type(object.contentType).set("Content-Disposition", `attachment; filename="authorization-${row.id}.pdf"`);
  object.stream.pipe(res);
}));
router.get("/autopay-authorization/:id/signature", asyncHandler(async (req, res) => {
  const { row } = await authorizationForCaller((req as any).auth.userId, req.params.id, false, (req as any).providerOrganizationId, (req as any).providerOrganizationId);
  const object = await openCaseMediaObjectStream(row.signatureObjectKey, "image/png");
  if (!object) throw new HttpError(404, "Signature artifact not found.");
  res.type(object.contentType); object.stream.pipe(res);
}));

// Lab billing history is explicitly scoped by the lab/provider relationship;
// provider-tenant history above must not be used as a cross-tenant shortcut.
router.get("/lab-autopay-authorization/history", asyncHandler(async (req, res) => {
  const callerId = (req as any).auth.userId as string;
  const labOrganizationId = typeof req.query.labOrganizationId === "string" ? req.query.labOrganizationId : "";
  const providerOrganizationId = typeof req.query.providerOrganizationId === "string" ? req.query.providerOrganizationId : "";
  if (!labOrganizationId || !providerOrganizationId) throw new HttpError(400, "Lab and provider are required.");
  await requireAnyRole(callerId, labOrganizationId, BILLING_ROLES);
  const [provider] = await db.select({ parent: organizations.parentLabOrganizationId }).from(organizations)
    .where(and(eq(organizations.id, providerOrganizationId), eq(organizations.type, "provider"))).limit(1);
  if (!provider || provider.parent !== labOrganizationId) throw new HttpError(404, "Provider relationship not found.");
  const ids = await db.select({ authorizationId: providerAutopayAuthorizationLabs.authorizationId })
    .from(providerAutopayAuthorizationLabs).where(eq(providerAutopayAuthorizationLabs.labOrganizationId, labOrganizationId));
  const rows = ids.length ? await db.select().from(providerAutopayAuthorizations)
    .where(and(eq(providerAutopayAuthorizations.providerOrganizationId, providerOrganizationId),
      inArray(providerAutopayAuthorizations.id, ids.map((x) => x.authorizationId))))
    .orderBy(desc(providerAutopayAuthorizations.createdAt)) : [];
  return ok(res, rows.map((row) => publicAuthorization(row, [labOrganizationId])));
}));

router.get("/lab-autopay-authorization/:id/download", asyncHandler(async (req, res) => {
  const callerId = (req as any).auth.userId as string;
  const labOrganizationId = typeof req.query.labOrganizationId === "string" ? req.query.labOrganizationId : "";
  if (!labOrganizationId) throw new HttpError(400, "Lab is required.");
  await requireAnyRole(callerId, labOrganizationId, BILLING_ROLES);
  const [link] = await db.select().from(providerAutopayAuthorizationLabs)
    .where(and(eq(providerAutopayAuthorizationLabs.authorizationId, req.params.id),
      eq(providerAutopayAuthorizationLabs.labOrganizationId, labOrganizationId))).limit(1);
  if (!link) throw new HttpError(404, "Authorization not found.");
  const [row] = await db.select().from(providerAutopayAuthorizations)
    .where(eq(providerAutopayAuthorizations.id, req.params.id)).limit(1);
  if (!row) throw new HttpError(404, "Authorization not found.");
  const object = await openCaseMediaObjectStream(row.documentObjectKey, "application/pdf");
  if (!object) throw new HttpError(404, "Authorization document not found.");
  res.type(object.contentType).set("Content-Disposition", `attachment; filename="authorization-${row.id}.pdf"`);
  object.stream.pipe(res);
}));

async function findProviderSubscription(userId: string, providerOrganizationId?: string) {
  const subject = providerOrganizationId
    ? { subjectType: "provider_org" as const, subjectId: providerOrganizationId }
    : await getSubjectForUser(userId);
  if (subject.subjectType !== "provider_org") {
    throw new HttpError(403, "Provider billing preferences are only available to providers.");
  }
  const [subscription] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.subjectType, subject.subjectType),
        eq(subscriptions.subjectId, subject.subjectId),
        isNull(subscriptions.deletedAt),
      ),
    )
    .limit(1);
  return subscription ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider card and automatic-payment preferences
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/payment-method",
  asyncHandler(async (req, res) => {
    const relationships = await getProviderRelationships((req as any).auth.userId as string, (req as any).providerOrganizationId);
    const stripe = await getUncachableStripeClient();
    const cards = (
      await Promise.all(
        relationships.map((relationship) =>
          getProviderCard(relationship, stripe).catch(() => null),
        ),
      )
    ).filter((card): card is ProviderCard => card !== null);
    return ok(res, {
      card: cards[0] ?? null,
      cards,
      hasCard: cards.length > 0,
    });
  }),
);

const labCardRelationshipSchema = z.object({
  labOrganizationId: z.string().min(1),
  providerOrganizationId: z.string().min(1),
});

const labCardSetupSchema = labCardRelationshipSchema.extend({
  successUrl: z.string().max(2000).optional(),
  cancelUrl: z.string().max(2000).optional(),
});

const labCardChargeSchema = labCardRelationshipSchema.extend({
  allocations: z.array(z.object({
    invoiceId: z.string().min(1),
    amount: currencyAmountSchema,
  })).min(1).max(500),
  idempotencyKey: z.string().min(1).max(200),
});

async function requireLabProviderRelationship(
  callerId: string,
  labOrganizationId: string,
  providerOrganizationId: string,
) {
  // Shared credentials and definitive charges are Receive Payments actions;
  // billing-only members must not be able to inspect or use them.
  await requireAnyRole(callerId, labOrganizationId, ADMIN_ROLES);
  const [provider] = await db
    .select({
      id: organizations.id,
      type: organizations.type,
      isActive: organizations.isActive,
      parentLabOrganizationId: organizations.parentLabOrganizationId,
    })
    .from(organizations)
    .where(and(
      eq(organizations.id, providerOrganizationId),
      isNull(organizations.deletedAt),
    ))
    .limit(1);
  if (
    !provider ||
    provider.type !== "provider" ||
    !provider.isActive ||
    provider.parentLabOrganizationId !== labOrganizationId
  ) {
    throw new HttpError(404, "Active provider organization not found for this lab.");
  }
  return provider;
}

async function getProviderCustomerId(providerOrganizationId: string) {
  const [customer] = await db
    .select({ stripeCustomerId: providerPaymentCustomers.stripeCustomerId })
    .from(providerPaymentCustomers)
    .where(eq(providerPaymentCustomers.providerOrganizationId, providerOrganizationId))
    .limit(1);
  return customer?.stripeCustomerId ?? null;
}

async function getSharedCard(
  stripe: import("stripe").default,
  customerId: string,
) {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return null;
  const [binding] = await db.select({ authorizedPaymentMethodId: providerPaymentCustomers.authorizedPaymentMethodId })
    .from(providerPaymentCustomers).where(eq(providerPaymentCustomers.stripeCustomerId, customerId)).limit(1);
  const defaultPaymentMethod = customer.invoice_settings.default_payment_method;
  const defaultId = binding?.authorizedPaymentMethodId ?? (typeof defaultPaymentMethod === "string"
    ? defaultPaymentMethod
    : defaultPaymentMethod?.id);
  if (!defaultId || defaultId === "none") return null;
  const paymentMethod = await stripe.paymentMethods.retrieve(defaultId);
  if (
    paymentMethod.type !== "card" ||
    !paymentMethod.card ||
    (typeof paymentMethod.customer === "string" ? paymentMethod.customer : paymentMethod.customer?.id) !== customerId
  ) {
    return null;
  }
  return paymentMethod;
}

function maskedCard(paymentMethod: import("stripe").default.PaymentMethod | null) {
  if (!paymentMethod?.card) return null;
  return {
    brand: paymentMethod.card.brand,
    last4: paymentMethod.card.last4,
    expMonth: paymentMethod.card.exp_month,
    expYear: paymentMethod.card.exp_year,
  };
}

export type PendingLabCardReservationNextStep =
  | "automatic_reconciliation"
  | "support_review";

export function pendingLabCardReservationGuidance(input: {
  stripePaymentIntentId: string | null;
  failureReason: string | null;
}) {
  const nextStep: PendingLabCardReservationNextStep =
    input.stripePaymentIntentId &&
    input.failureReason !== "settlement_conflict_refund_review_required"
      ? "automatic_reconciliation"
      : "support_review";
  return {
    message:
      nextStep === "automatic_reconciliation"
        ? "Stripe is still confirming a prior card attempt. The invoice remains reserved while automatic reconciliation runs; do not submit another charge."
        : "A prior card attempt has an uncertain processor outcome. Support review is required before this invoice can be charged; do not submit another charge.",
    details: {
      code: "CARD_PAYMENT_ATTEMPT_BLOCKED" as const,
      nextStep,
      safeToRetry: false as const,
    },
  };
}

export class PendingLabCardReservationError extends HttpError {
  constructor(
    readonly checkoutId: string,
    input: {
      stripePaymentIntentId: string | null;
      failureReason: string | null;
    },
  ) {
    const guidance = pendingLabCardReservationGuidance(input);
    super(409, guidance.message, guidance.details);
  }
}

export async function reserveLabCardCharge(
  labOrganizationId: string,
  providerOrganizationId: string,
  requested: Array<{ invoiceId: string; amount: number }>,
  idempotencyKey: string,
  initiatedByUserId: string,
  chargeAmountCents?: number,
  lockAlreadyHeld = false,
  savePaymentMethod = false,
  expiresAt: Date | null = null,
) {
  if (new Set(requested.map((allocation) => allocation.invoiceId)).size !== requested.length) {
    throw new HttpError(400, "Each invoice may only be allocated once.");
  }
  const ids = requested.map((allocation) => allocation.invoiceId);
  const requestedSignature = requested
    .map((allocation) => `${allocation.invoiceId}:${(allocation.amount / 100).toFixed(2)}`)
    .sort()
    .join("|");

  return db.transaction(async (tx) => {
    if (!lockAlreadyHeld) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(
        hashtext(${labOrganizationId}), hashtext(${providerOrganizationId})
      )`);
    }
    // Lock an existing replay first. A pending checkout with this exact key is
    // the caller's own reservation and may safely resume Stripe confirmation.
    const [existing] = await tx.select().from(providerPaymentCheckouts).where(and(
      eq(providerPaymentCheckouts.providerOrganizationId, providerOrganizationId),
      eq(providerPaymentCheckouts.clientRequestId, idempotencyKey),
    )).for("update").limit(1);
    if (existing) {
      if (existing.status !== "pending" && existing.status !== "succeeded") {
        throw new HttpError(409, "This card payment attempt has expired. Start a new payment.");
      }
      if (existing.savePaymentMethod !== savePaymentMethod) {
        throw new HttpError(409, "This idempotency key was already used for another payment.");
      }
      if (chargeAmountCents != null &&
        Math.round(Number(existing.totalAmount) * 100) !== chargeAmountCents) {
        throw new HttpError(409, "This idempotency key was already used for another card amount.");
      }
      const stored = await tx.select().from(providerPaymentAllocations)
        .where(eq(providerPaymentAllocations.checkoutId, existing.id));
      const storedSignature = stored
        .map((allocation) => `${allocation.invoiceId}:${allocation.amount}`)
        .sort()
        .join("|");
      if (storedSignature !== requestedSignature) {
        throw new HttpError(409, "This idempotency key was already used for another payment.");
      }
      return {
        checkout: existing,
        allocations: stored.map((allocation) => ({
          invoiceId: allocation.invoiceId,
          amount: allocation.amount,
          amountCents: Math.round(Number(allocation.amount) * 100),
        })),
      };
    }

    // All competing charges lock rows in the same order. Revalidate after the
    // lock, then reserve the invoice with a pending checkout before release.
    const rows = await tx.select().from(invoices).where(and(
      inArray(invoices.id, ids),
      eq(invoices.labOrganizationId, labOrganizationId),
      eq(invoices.providerOrganizationId, providerOrganizationId),
      isNull(invoices.deletedAt),
    )).orderBy(asc(invoices.id)).for("update");
    if (rows.length !== ids.length) {
      throw new HttpError(403, "One or more invoices are not available for this provider.");
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    const allocations = requested.map((allocation) => {
      const invoice = byId.get(allocation.invoiceId)!;
      const balanceCents = Math.round(Number(invoice.balanceDue) * 100);
      if (!PAYABLE_PROVIDER_INVOICE_STATUSES.has(invoice.status) || balanceCents <= 0) {
        throw new HttpError(400, `Invoice ${invoice.invoiceNumber} cannot accept payment.`);
      }
      if (allocation.amount > balanceCents) {
        throw new HttpError(400, `Payment exceeds the balance due for invoice ${invoice.invoiceNumber}.`);
      }
      return {
        invoiceId: invoice.id,
        amount: (allocation.amount / 100).toFixed(2),
        amountCents: allocation.amount,
      };
    });
    // A same-key request may have started before its peer inserted the
    // checkout, then waited on these invoice locks. Check again after locking
    // so that replay joins its own pending reservation rather than rejecting it
    // as a competing charge.
    const [racedExisting] = await tx.select().from(providerPaymentCheckouts).where(and(
      eq(providerPaymentCheckouts.providerOrganizationId, providerOrganizationId),
      eq(providerPaymentCheckouts.clientRequestId, idempotencyKey),
    )).for("update").limit(1);
    if (racedExisting) {
      if (racedExisting.status !== "pending" && racedExisting.status !== "succeeded") {
        throw new HttpError(409, "This card payment attempt has expired. Start a new payment.");
      }
      if (racedExisting.savePaymentMethod !== savePaymentMethod) {
        throw new HttpError(409, "This idempotency key was already used for another payment.");
      }
      if (chargeAmountCents != null &&
        Math.round(Number(racedExisting.totalAmount) * 100) !== chargeAmountCents) {
        throw new HttpError(409, "This idempotency key was already used for another card amount.");
      }
      const stored = await tx.select().from(providerPaymentAllocations)
        .where(eq(providerPaymentAllocations.checkoutId, racedExisting.id));
      const storedSignature = stored
        .map((allocation) => `${allocation.invoiceId}:${allocation.amount}`)
        .sort()
        .join("|");
      if (storedSignature !== requestedSignature) {
        throw new HttpError(409, "This idempotency key was already used for another payment.");
      }
      return {
        checkout: racedExisting,
        allocations: stored.map((allocation) => ({
          invoiceId: allocation.invoiceId,
          amount: allocation.amount,
          amountCents: Math.round(Number(allocation.amount) * 100),
        })),
      };
    }
    const pendingReservation = await tx
      .select({
        checkoutId: providerPaymentCheckouts.id,
        stripePaymentIntentId: providerPaymentCheckouts.stripePaymentIntentId,
        failureReason: providerPaymentCheckouts.failureReason,
      })
      .from(providerPaymentAllocations)
      .innerJoin(
        providerPaymentCheckouts,
        eq(providerPaymentAllocations.checkoutId, providerPaymentCheckouts.id),
      )
      .where(and(
        inArray(providerPaymentAllocations.invoiceId, ids),
        eq(providerPaymentCheckouts.status, "pending"),
      ))
      .limit(1);
    if (pendingReservation.length > 0) {
      throw new PendingLabCardReservationError(
        pendingReservation[0]!.checkoutId,
        pendingReservation[0]!,
      );
    }
    const totalAmount = (
      (chargeAmountCents ?? allocations.reduce((total, allocation) => total + allocation.amountCents, 0)) / 100
    ).toFixed(2);
    const [checkout] = await tx.insert(providerPaymentCheckouts).values({
      providerOrganizationId,
      initiatedByUserId,
      clientRequestId: idempotencyKey,
      totalAmount,
      currency: "usd",
      savePaymentMethod,
      expiresAt,
      status: "pending",
    }).returning();
    await tx.insert(providerPaymentAllocations).values(allocations.map((allocation) => ({
      checkoutId: checkout.id, invoiceId: allocation.invoiceId, amount: allocation.amount,
    })));
    return { checkout, allocations };
  });
}

function isDefinitiveStripeFailure(error: unknown): boolean {
  const stripeError = error as { type?: string };
  return stripeError?.type === "StripeCardError" ||
    stripeError?.type === "StripeInvalidRequestError";
}

export async function confirmReservedLabCardCharge(
  stripe: import("stripe").default,
  checkout: typeof providerPaymentCheckouts.$inferSelect,
  allocations: Array<{ invoiceId: string; amount: string; amountCents: number }>,
  lockAlreadyHeld = false,
): Promise<{
  status: "succeeded" | "failed" | "pending";
  totalAmount: string;
  failureReason: string | null;
}> {
  const totalCents = Math.round(Number(checkout.totalAmount) * 100);
  const totalAmount = (totalCents / 100).toFixed(2);
  if (checkout.failureReason === "settlement_conflict_refund_review_required") {
    if (!checkout.stripeChargeId) {
      return {
        status: "pending",
        totalAmount,
        failureReason: "settlement_conflict_refund_review_required",
      };
    }
    try {
      await stripe.refunds.create(
        { charge: checkout.stripeChargeId },
        {
          idempotencyKey:
            `provider-lab-card-settlement-refund-${checkout.id}-${checkout.stripeChargeId}`,
        },
      );
      await markProviderPaymentCheckoutFailed(
        checkout.id,
        "failed",
        "settlement_conflict_refunded",
        checkout.stripePaymentIntentId,
      );
      return {
        status: "failed",
        totalAmount,
        failureReason: "settlement_conflict_refunded",
      };
    } catch {
      return {
        status: "pending",
        totalAmount,
        failureReason: "settlement_conflict_refund_review_required",
      };
    }
  }
  const customerId = await getProviderCustomerId(checkout.providerOrganizationId);
  if (!customerId) {
    await markProviderPaymentCheckoutFailed(checkout.id, "failed", "shared_card_not_on_file");
    throw new HttpError(400, "No shared card is on file for this provider.");
  }
  let card: import("stripe").default.PaymentMethod | null;
  try {
    card = await getSharedCard(stripe, customerId);
  } catch (error) {
    if (isDefinitiveStripeFailure(error)) {
      const reason = "stripe_preconfirmation_failed";
      await markProviderPaymentCheckoutFailed(checkout.id, "failed", reason);
      return { status: "failed", totalAmount, failureReason: reason };
    }
    throw error;
  }
  if (!card) {
    await markProviderPaymentCheckoutFailed(checkout.id, "failed", "shared_card_not_on_file");
    throw new HttpError(400, "No shared card is on file for this provider.");
  }
  const params = {
    amount: totalCents,
    currency: "usd" as const,
    customer: customerId,
    payment_method: card.id,
    off_session: true,
    confirm: true,
    metadata: {
      providerPaymentCheckoutId: checkout.id,
      providerOrganizationId: checkout.providerOrganizationId,
    },
  };
  const idempotencyKey = `provider-lab-card-charge-${checkout.id}`;
  let intent: import("stripe").default.PaymentIntent | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      intent = await stripe.paymentIntents.create(params, { idempotencyKey });
      break;
    } catch (error) {
      if (isDefinitiveStripeFailure(error)) {
        const reason = "stripe_payment_declined";
        await markProviderPaymentCheckoutFailed(checkout.id, "failed", reason);
        return { status: "failed", totalAmount, failureReason: reason };
      }
      // A connection/API failure can occur after Stripe accepted the request.
      // Replay the *identical* idempotency key once to ask Stripe for its
      // authoritative result; never release the invoice reservation on doubt.
      if (attempt === 1) {
        return { status: "pending", totalAmount, failureReason: null };
      }
    }
  }
  if (!intent) return { status: "pending", totalAmount, failureReason: null };
  if (intent.status === "succeeded") {
    const chargeId = typeof intent.latest_charge === "string"
      ? intent.latest_charge
      : intent.latest_charge?.id ?? null;
    try {
      await settleProviderPaymentCheckout(checkout.id, intent.id, chargeId, lockAlreadyHeld);
      return { status: "succeeded", totalAmount, failureReason: null };
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 409) {
        // A transient accounting/database failure is not proof that applying
        // the payment is impossible. Preserve the pending checkout for the
        // normal exactly-once reconciliation path.
        throw error;
      }
      // Stripe has charged the card but accounting could not safely apply the
      // allocations. Reverse that known charge before terminally releasing the
      // reservation; the settlement transaction has rolled back its writes.
      if (!chargeId) {
        await db.update(providerPaymentCheckouts).set({
          failureReason: "settlement_conflict_refund_review_required",
          stripePaymentIntentId: intent.id,
          updatedAt: new Date(),
        }).where(and(
          eq(providerPaymentCheckouts.id, checkout.id),
          eq(providerPaymentCheckouts.status, "pending"),
        ));
        return {
          status: "pending",
          totalAmount,
          failureReason: "settlement_conflict_refund_review_required",
        };
      }
      try {
        await stripe.refunds.create(
          { charge: chargeId },
          { idempotencyKey: `provider-lab-card-settlement-refund-${checkout.id}-${chargeId}` },
        );
        await markProviderPaymentCheckoutFailed(
          checkout.id,
          "failed",
          "settlement_conflict_refunded",
          intent.id,
        );
        return {
          status: "failed",
          totalAmount,
          failureReason: "settlement_conflict_refunded",
        };
      } catch {
        // An ambiguous refund must keep its invoice reservation. A same-key
        // replay retries this exact refund idempotency key; distinct keys stay
        // blocked until Stripe confirms compensation.
        await db.update(providerPaymentCheckouts).set({
          failureReason: "settlement_conflict_refund_review_required",
          stripePaymentIntentId: intent.id,
          stripeChargeId: chargeId,
          updatedAt: new Date(),
        }).where(and(
          eq(providerPaymentCheckouts.id, checkout.id),
          eq(providerPaymentCheckouts.status, "pending"),
        ));
        return {
          status: "pending",
          totalAmount,
          failureReason: "settlement_conflict_refund_review_required",
        };
      }
    }
  }
  const failureReason = `stripe_payment_intent_${intent.status}`;
  await markProviderPaymentCheckoutFailed(checkout.id, "failed", failureReason, intent.id);
  return { status: "failed", totalAmount, failureReason };
}

// Lab billing users may view and charge the provider organization's shared
// card. Auto-pay is projected read-only; provider consent remains the only
// write path.
router.get("/lab-card", asyncHandler(async (req, res) => {
  const callerId = (req as any).auth.userId as string;
  const input = labCardRelationshipSchema.parse(req.query);
  await requireLabProviderRelationship(callerId, input.labOrganizationId, input.providerOrganizationId);
  const stripe = await getUncachableStripeClient();
  let card = await getCachedSharedCardSummary(input.providerOrganizationId);
  if (stripe) {
    card = (
      await refreshSharedCardSummary(input.providerOrganizationId, stripe)
    ).card;
  }
  const [customer] = await db
    .select({
      enabled: providerPaymentCustomers.invoiceAutoPayEnabled,
      chargeDay: providerPaymentCustomers.invoiceAutoPayChargeDay,
    })
    .from(providerPaymentCustomers)
    .where(
      eq(
        providerPaymentCustomers.providerOrganizationId,
        input.providerOrganizationId,
      ),
    )
    .limit(1);
  return ok(res, {
    hasCard: !!card,
    cardPresent: !!card,
    card,
    autoPay: {
      enabled: customer?.enabled ?? false,
      dayOfMonth: customer?.chargeDay ?? 10,
      context: "provider_invoice_autopay",
    },
  });
}));

router.post("/lab-card/setup", asyncHandler(async (req, res) => {
  const callerId = (req as any).auth.userId as string;
  const input = labCardSetupSchema.parse(req.body);
  await requireLabProviderRelationship(callerId, input.labOrganizationId, input.providerOrganizationId);
  const stripe = await getUncachableStripeClient();
  if (!stripe) throw new HttpError(503, "Stripe card payments are not configured.");
  const customerId = await getOrCreateProviderPaymentCustomer(input.providerOrganizationId, stripe);
  const origin = providerReturnOrigins()[0]!;
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "setup",
    payment_method_types: ["card"],
    success_url: safeReturnUrl(input.successUrl, `${origin}/desktop/?providerLabCardSetup=success`),
    cancel_url: safeReturnUrl(input.cancelUrl, `${origin}/desktop/?providerLabCardSetup=cancelled`),
    metadata: {
      providerLabCardSetup: "true",
      providerOrganizationId: input.providerOrganizationId,
    },
  });
  return ok(res, { url: session.url, sessionId: session.id }, 201);
}));

router.get("/lab-card/setup-status/:sessionId", asyncHandler(async (req, res) => {
  const callerId = (req as any).auth.userId as string;
  const input = z
    .object({ labOrganizationId: z.string().min(1) })
    .strict()
    .parse(req.query);
  const stripe = await getUncachableStripeClient();
  if (!stripe) throw new HttpError(503, "Stripe card payments are not configured.");
  const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
  const providerOrganizationId = session.metadata?.providerOrganizationId;
  if (
    session.metadata?.providerLabCardSetup !== "true" ||
    !providerOrganizationId ||
    typeof session.customer !== "string"
  ) {
    throw new HttpError(404, "Card setup session not found.");
  }
  await requireLabProviderRelationship(
    callerId,
    input.labOrganizationId,
    providerOrganizationId,
  );
  const customerId = await getProviderCustomerId(providerOrganizationId);
  if (!customerId || customerId !== session.customer) {
    throw new HttpError(404, "Card setup session not found.");
  }
  let setupSucceeded = false;
  const setupIntentId =
    typeof session.setup_intent === "string" ? session.setup_intent : null;
  if (session.status === "complete" && setupIntentId) {
    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
    const setupCustomer =
      typeof setupIntent.customer === "string"
        ? setupIntent.customer
        : setupIntent.customer?.id;
    const paymentMethodId =
      typeof setupIntent.payment_method === "string"
        ? setupIntent.payment_method
        : setupIntent.payment_method?.id;
    setupSucceeded =
      setupIntent.status === "succeeded" &&
      setupCustomer === customerId &&
      !!paymentMethodId;
    if (setupSucceeded && paymentMethodId) {
      const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
      const paymentCustomer =
        typeof paymentMethod.customer === "string"
          ? paymentMethod.customer
          : paymentMethod.customer?.id;
      if (
        paymentMethod.type !== "card" ||
        !paymentMethod.card ||
        paymentCustomer !== customerId
      ) {
        throw new HttpError(404, "Card setup session not found.");
      }
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
      await db.update(providerPaymentCustomers).set({ authorizedPaymentMethodId: paymentMethodId })
        .where(eq(providerPaymentCustomers.providerOrganizationId, providerOrganizationId));
    }
  }
  const refreshed = await refreshSharedCardSummary(
    providerOrganizationId,
    stripe,
  );
  if (setupSucceeded && refreshed.changed) {
    await writeAuditLog({
      req,
      organizationId: input.labOrganizationId,
      action: "provider_shared_card_refreshed",
      entityType: "provider_payment_customer",
      entityId: providerOrganizationId,
      beforeJson: refreshed.previous,
      afterJson: refreshed.card,
      metadataJson: {
        source: "lab",
        providerOrganizationId,
      },
    });
  }
  return ok(res, {
    status:
      session.status === "expired"
        ? "expired"
        : setupSucceeded
          ? "succeeded"
          : "pending",
    providerOrganizationId,
    card: refreshed.card,
  });
}));

router.post("/lab-card/charge", asyncHandler(async (req, res) => {
  const callerId = (req as any).auth.userId as string;
  const input = labCardChargeSchema.parse(req.body);
  await requireLabProviderRelationship(callerId, input.labOrganizationId, input.providerOrganizationId);
  const stripe = await getUncachableStripeClient();
  if (!stripe) throw new HttpError(503, "Stripe card payments are not configured.");
  let reservation: Awaited<ReturnType<typeof reserveLabCardCharge>> | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      reservation = await reserveLabCardCharge(
        input.labOrganizationId, input.providerOrganizationId, input.allocations,
        input.idempotencyKey, callerId,
      );
      break;
    } catch (error) {
      if (!(error instanceof PendingLabCardReservationError)) throw error;
      const [blocked] = await db.select().from(providerPaymentCheckouts)
        .where(eq(providerPaymentCheckouts.id, error.checkoutId)).limit(1);
      if (!blocked || blocked.status !== "pending") continue;
      if (blocked.failureReason === "settlement_conflict_refund_review_required") {
        throw new HttpError(409, error.message, error.details);
      }
      const blockedAllocations = await db.select().from(providerPaymentAllocations)
        .where(eq(providerPaymentAllocations.checkoutId, blocked.id));
      const reconciliation = await confirmReservedLabCardCharge(
        stripe,
        blocked,
        blockedAllocations.map((allocation) => ({
          invoiceId: allocation.invoiceId,
          amount: allocation.amount,
          amountCents: Math.round(Number(allocation.amount) * 100),
        })),
      );
      if (reconciliation.status === "pending") {
        throw new HttpError(409, error.message, error.details);
      }
    }
  }
  if (!reservation) throw new HttpError(409, "An invoice is already being charged.");
  const { checkout, allocations } = reservation;
  if (checkout.status !== "pending") {
    return ok(res, {
      checkoutId: checkout.id, status: checkout.status,
      totalAmount: checkout.totalAmount, failureReason: checkout.failureReason,
    });
  }
  const result = await confirmReservedLabCardCharge(stripe, checkout, allocations);
  return ok(res, {
    checkoutId: checkout.id,
    status: result.status,
    totalAmount: result.totalAmount,
    failureReason: result.failureReason,
  });
}));

router.post(
  "/payment-method/setup-checkout",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const relationships = await getProviderRelationships(callerId, (req as any).providerOrganizationId);
    const requestedId =
      typeof req.body?.providerOrganizationId === "string"
        ? req.body.providerOrganizationId
        : relationships[0]?.providerOrganizationId;
    const relationship = relationships.find(
      (item) => item.providerOrganizationId === requestedId,
    );
    if (!relationship) {
      throw new HttpError(403, "That provider billing relationship is unavailable.");
    }
    const stripe = await getUncachableStripeClient();
    if (!stripe) throw new HttpError(503, "Stripe card payments are not configured.");
    const customerId = await getOrCreateProviderPaymentCustomer(
      relationship.providerOrganizationId,
      stripe,
    );
    const origin = providerReturnOrigins()[0]!;
    const successUrl = safeReturnUrl(
      req.body?.successUrl,
      `${origin}/desktop/`,
    );
    const cancelUrl = safeReturnUrl(
      req.body?.cancelUrl,
      `${origin}/desktop/`,
    );
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "setup",
      payment_method_types: ["card"],
      success_url: successUrl.includes("providerCardSetupSession")
        ? successUrl
        : providerSetupReturnUrl(
              successUrl,
            "{CHECKOUT_SESSION_ID}",
            relationship.providerOrganizationId,
          ),
      cancel_url: cancelUrl.includes("providerCardSetupSession")
        ? cancelUrl
        : providerSetupReturnUrl(
              cancelUrl,
            "{CHECKOUT_SESSION_ID}",
            relationship.providerOrganizationId,
            true,
          ),
      client_reference_id: relationship.providerOrganizationId,
      metadata: {
        providerOrganizationId: relationship.providerOrganizationId,
        initiatedByUserId: callerId,
        providerCardSetup: "true",
      },
      setup_intent_data: {
        metadata: {
          providerOrganizationId: relationship.providerOrganizationId,
          initiatedByUserId: callerId,
          providerCardSetup: "true",
        },
      },
    });
    return ok(res, {
      sessionId: session.id,
      url: session.url,
      providerOrganizationId: relationship.providerOrganizationId,
      status: "pending",
    }, 201);
  }),
);

router.get(
  "/payment-method/setup-status/:sessionId",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const relationships = await getProviderRelationships(callerId, (req as any).providerOrganizationId);
    const relationshipIds = new Set(
      relationships.map((item) => item.providerOrganizationId),
    );
    const stripe = await getUncachableStripeClient();
    if (!stripe) throw new HttpError(503, "Stripe card payments are not configured.");
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    const organizationId = session.metadata?.providerOrganizationId;
    if (
      session.metadata?.providerCardSetup !== "true" ||
      !organizationId ||
      !relationshipIds.has(organizationId) ||
      (typeof session.customer !== "string")
    ) {
      throw new HttpError(404, "Card setup session not found.");
    }
    const relationship = relationships.find(
      (item) => item.providerOrganizationId === organizationId,
    )!;
    const customerId = await getProviderCustomerId(organizationId);
    if (!customerId || customerId !== session.customer) {
      throw new HttpError(404, "Card setup session not found.");
    }
    const setupIntentId =
      typeof session.setup_intent === "string" ? session.setup_intent : null;
    let setupSucceeded = false;
    if (session.status === "complete" && setupIntentId) {
      const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
      setupSucceeded = setupIntent.status === "succeeded";
      const paymentMethodId =
        typeof setupIntent.payment_method === "string"
          ? setupIntent.payment_method
          : setupIntent.payment_method?.id;
      const setupCustomerId =
        typeof setupIntent.customer === "string"
          ? setupIntent.customer
          : setupIntent.customer?.id;
      setupSucceeded =
        setupSucceeded &&
        setupCustomerId === customerId &&
        !!paymentMethodId;
      if (setupSucceeded && paymentMethodId) {
        const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
        const paymentCustomerId =
          typeof paymentMethod.customer === "string"
            ? paymentMethod.customer
            : paymentMethod.customer?.id;
        if (
          paymentMethod.type !== "card" ||
          !paymentMethod.card ||
          paymentCustomerId !== customerId
        ) {
          throw new HttpError(404, "Card setup session not found.");
        }
        await stripe.customers.update(customerId, {
          invoice_settings: { default_payment_method: paymentMethodId },
        });
        await db.update(providerPaymentCustomers).set({ authorizedPaymentMethodId: paymentMethodId })
          .where(eq(providerPaymentCustomers.providerOrganizationId, organizationId));
      }
    }
    const refreshed = await refreshSharedCardSummary(organizationId, stripe);
    if (setupSucceeded && refreshed.changed) {
      await writeAuditLog({
        req,
        organizationId: relationship.labOrganizationId,
        action: "provider_shared_card_refreshed",
        entityType: "provider_payment_customer",
        entityId: organizationId,
        beforeJson: refreshed.previous,
        afterJson: refreshed.card,
        metadataJson: {
          source: "provider",
          providerOrganizationId: organizationId,
        },
      });
    }
    const card = refreshed.card
      ? {
          providerOrganizationId: organizationId,
          labName: relationship.labName,
          ...refreshed.card,
        }
      : null;
    return ok(res, {
      status:
        session.status === "expired"
          ? "expired"
          : setupSucceeded
            ? "succeeded"
            : "pending",
      card,
    });
  }),
);

router.get(
  "/billing-preferences",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const subscription = await findProviderSubscription(callerId, (req as any).providerOrganizationId);
    const relationships = await getProviderRelationships(callerId, (req as any).providerOrganizationId);
    const providerIds = relationships.map((item) => item.providerOrganizationId);
    const customerRows = providerIds.length
      ? await db
          .select()
          .from(providerPaymentCustomers)
          .where(inArray(providerPaymentCustomers.providerOrganizationId, providerIds))
      : [];
    const customerByOrg = new Map(
      customerRows.map((row) => [row.providerOrganizationId, row]),
    );
    const attemptRows = providerIds.length
      ? await db.select().from(providerAutoPayAttempts)
        .where(inArray(providerAutoPayAttempts.providerOrganizationId, providerIds))
        .orderBy(desc(providerAutoPayAttempts.createdAt))
      : [];
    return ok(res, {
      capabilities: {
        autoPayScheduling: PROVIDER_AUTO_PAY_SCHEDULING_AVAILABLE,
      },
      subscription: {
        enabled: subscription?.autoPayEnabled ?? false,
        chargeDay: subscription?.autoPayChargeDay ?? 10,
        authorization: subscription
          ? await (async () => {
              const authorization = await currentAutopayAuthorization(subscription.subjectId, "subscription");
              const [customer] = await db.select().from(providerPaymentCustomers)
                .where(eq(providerPaymentCustomers.providerOrganizationId, subscription.subjectId)).limit(1);
              return preferenceVisibility(
                authorization,
                attemptRows.filter((a) => a.kind === "subscription"),
                subscription.autoPayChargeDay,
                "subscription",
                subscription.trialEndAt,
                !authorization || (!!customer && authorizationMatchesCard(authorization, customer)),
              );
            })()
          : preferenceVisibility(null, [], 10),
      },
      labs: await Promise.all(relationships.map(async (relationship) => {
        const row = customerByOrg.get(relationship.providerOrganizationId);
        const authorization = await currentAutopayAuthorization(
          relationship.providerOrganizationId,
          "invoice",
          relationship.labOrganizationId,
            row?.invoiceAutoPayChargeDay ?? 10,
        );
        const auth = preferenceVisibility(
          authorization,
          attemptRows.filter((a) => a.providerOrganizationId === relationship.providerOrganizationId && a.kind === "invoice"),
          row?.invoiceAutoPayChargeDay ?? 10,
          "invoice",
          undefined,
          !authorization || (!!row && authorizationMatchesCard(authorization, row)),
        );
        return {
          providerOrganizationId: relationship.providerOrganizationId,
          labOrganizationId: relationship.labOrganizationId,
          labName: relationship.labName,
          providerName: relationship.providerName,
          enabled: row?.invoiceAutoPayEnabled ?? false,
          chargeDay: row?.invoiceAutoPayChargeDay ?? 10,
          authorization: auth,
        };
      })),
    });
  }),
);

router.patch(
  "/subscription-autopay",
  asyncHandler(async (req, res) => {
    requireProviderAutoPayCapability();
    const callerId = (req as any).auth.userId as string;
    const input = providerPreferenceSchema.parse(req.body);
    const subscription = await findProviderSubscription(callerId, (req as any).providerOrganizationId);
    if (!subscription) {
      throw new HttpError(409, "Assign a provider subscription before changing automatic payment settings.");
    }
    const authorization = await currentAutopayAuthorization(subscription.subjectId, "subscription");
    if (input.enabled || (input.chargeDay != null && input.chargeDay !== subscription.autoPayChargeDay)) {
        if (!authorization) {
          throw new HttpError(409, "A current signed subscription auto-pay authorization is required.");
        }
        const [paymentCustomer] = await db.select().from(providerPaymentCustomers)
          .where(eq(providerPaymentCustomers.providerOrganizationId, subscription.subjectId))
          .limit(1);
        if (!paymentCustomer || !authorizationMatchesCard(authorization, paymentCustomer)) {
          throw new HttpError(409, "The shared card changed after authorization. Sign a new authorization before enabling auto-pay.");
        }
        const relationships = await getProviderRelationships(callerId, (req as any).providerOrganizationId);
        const relationship = relationships.find(
          (item) => item.providerOrganizationId === subscription.subjectId,
        );
        const stripe = await getUncachableStripeClient();
        if (!relationship || !stripe || !(await getProviderCard(relationship, stripe))) {
          throw new HttpError(409, "Add a shared card before enabling subscription auto-pay.");
        }
    }
    const effectiveChargeDay = input.chargeDay ?? subscription.autoPayChargeDay;
    const [updated] = await db
      .update(subscriptions)
      .set({
        autoPayEnabled: input.enabled,
        autoPayChargeDay: effectiveChargeDay,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, subscription.id))
      .returning({
        enabled: subscriptions.autoPayEnabled,
        chargeDay: subscriptions.autoPayChargeDay,
      });
    const attempts = await db.select().from(providerAutoPayAttempts)
      .where(and(eq(providerAutoPayAttempts.providerOrganizationId, subscription.subjectId), eq(providerAutoPayAttempts.kind, "subscription")))
      .orderBy(desc(providerAutoPayAttempts.createdAt));
    return ok(res, {
      subscription: {
        ...updated,
        authorization: preferenceVisibility(authorization, attempts, updated.chargeDay, "subscription", subscription.trialEndAt),
      },
    });
  }),
);

router.patch(
  "/labs/:providerOrganizationId/invoice-autopay",
  asyncHandler(async (req, res) => {
    requireProviderAutoPayCapability();
    const callerId = (req as any).auth.userId as string;
    const input = providerPreferenceSchema.parse(req.body);
    const relationships = await getProviderRelationships(callerId, (req as any).providerOrganizationId);
    const relationship = relationships.find(
      (item) => item.providerOrganizationId === req.params.providerOrganizationId,
    );
    if (!relationship) throw new HttpError(403, "That lab relationship is unavailable.");
    let [row] = await db
      .select()
      .from(providerPaymentCustomers)
      .where(
        eq(
          providerPaymentCustomers.providerOrganizationId,
          relationship.providerOrganizationId,
        ),
      )
      .limit(1);
    if (!row && input.enabled) {
      const stripe = await getUncachableStripeClient();
      if (!stripe) throw new HttpError(503, "Stripe card payments are not configured.");
      await getOrCreateProviderPaymentCustomer(
        relationship.providerOrganizationId,
        stripe,
      );
      const [created] = await db
        .select()
        .from(providerPaymentCustomers)
        .where(eq(providerPaymentCustomers.providerOrganizationId, relationship.providerOrganizationId))
        .limit(1);
      if (!created) throw new HttpError(503, "Could not initialize provider billing.");
      // Keep the rest of this transition on the same durable customer row.
      // (The local const is intentionally reassigned below for legacy callers.)
      row = created;
    }
    // Turning billing off is always allowed, including when a stale client
    // sends a null day and no processor customer has ever been created.
    if (!row && !input.enabled) {
      return ok(res, {
        lab: {
          providerOrganizationId: relationship.providerOrganizationId,
          enabled: false,
          chargeDay: 10,
          authorization: preferenceVisibility(null, [], 10),
        },
      });
    }
    const authorization = await currentAutopayAuthorization(
      relationship.providerOrganizationId,
      "invoice",
      relationship.labOrganizationId,
      input.chargeDay,
    );
    if (input.enabled || (input.chargeDay != null && input.chargeDay !== row?.invoiceAutoPayChargeDay)) {
        if (!authorization) {
          throw new HttpError(409, "A current signed lab-bill auto-pay authorization is required.");
        }
        if (!authorizationMatchesCard(authorization, row)) {
          throw new HttpError(409, "The shared card changed after authorization. Sign a new authorization before enabling auto-pay.");
        }
    }
    if (input.enabled) {
      const stripe = await getUncachableStripeClient();
      if (!stripe || !(await getProviderCard(relationship, stripe))) {
        throw new HttpError(
          409,
          "Add a shared card before enabling invoice auto-pay.",
        );
      }
    }
    const [updated] = await db
      .update(providerPaymentCustomers)
      .set({
        invoiceAutoPayEnabled: input.enabled,
        invoiceAutoPayChargeDay: input.chargeDay ?? row.invoiceAutoPayChargeDay,
        updatedAt: new Date(),
      })
      .where(
        eq(
          providerPaymentCustomers.providerOrganizationId,
          relationship.providerOrganizationId,
        ),
      )
      .returning({
        providerOrganizationId: providerPaymentCustomers.providerOrganizationId,
        enabled: providerPaymentCustomers.invoiceAutoPayEnabled,
        chargeDay: providerPaymentCustomers.invoiceAutoPayChargeDay,
      });
    const attempts = await db.select().from(providerAutoPayAttempts)
      .where(and(eq(providerAutoPayAttempts.providerOrganizationId, relationship.providerOrganizationId), eq(providerAutoPayAttempts.kind, "invoice")))
      .orderBy(desc(providerAutoPayAttempts.createdAt));
    return ok(res, {
      lab: {
        ...updated,
        authorization: preferenceVisibility(authorization, attempts, updated.chargeDay),
      },
    });
  }),
);

router.post(
  "/payment-checkout",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const input = providerCheckoutSchema.parse(req.body);
    const providerOrgIds = [(req as any).providerOrganizationId as string];
    const clientRequestId =
      (typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"]
        : undefined) ??
      input.idempotencyKey ??
      null;
    let recoverableCheckout: typeof providerPaymentCheckouts.$inferSelect | null = null;
    let resolved:
      | Awaited<ReturnType<typeof getProviderCheckoutAllocations>>
      | null = null;
    if (clientRequestId && providerOrgIds.length > 0) {
      const [existing] = await db
        .select()
        .from(providerPaymentCheckouts)
        .where(
          and(
            inArray(providerPaymentCheckouts.providerOrganizationId, providerOrgIds),
            eq(providerPaymentCheckouts.clientRequestId, clientRequestId),
          ),
        )
        .limit(1);
      if (existing) {
        const storedAllocations = await db
          .select()
          .from(providerPaymentAllocations)
          .where(eq(providerPaymentAllocations.checkoutId, existing.id));
        const storedSignature = storedAllocations
          .map((allocation) => `${allocation.invoiceId}:${allocation.amount}`)
          .sort()
          .join("|");
        const requestedSignature = input.allocations
          ?.map(
            (allocation) =>
              `${allocation.invoiceId}:${(allocation.amount / 100).toFixed(2)}`,
          )
          .sort()
          .join("|");
        const storedIds = new Set(storedAllocations.map((allocation) => allocation.invoiceId));
        const requestedIdsMatch = input.invoiceIds
          ? input.amount == null
            ? input.invoiceIds.length === storedAllocations.length &&
              input.invoiceIds.every((id) => storedIds.has(id))
            : storedAllocations.every((allocation) =>
                input.invoiceIds!.includes(allocation.invoiceId),
              )
          : true;
        const storedTotalCents = Math.round(Number(existing.totalAmount) * 100);
        if (
          (input.providerOrganizationId != null &&
            existing.providerOrganizationId !== input.providerOrganizationId) ||
          existing.savePaymentMethod !== input.savePaymentMethod ||
          (requestedSignature != null && requestedSignature !== storedSignature) ||
          !requestedIdsMatch ||
          (input.amount != null && input.amount !== storedTotalCents)
        ) {
          throw new HttpError(
            409,
            "This idempotency key was already used for another payment.",
          );
        }
        if (existing.status !== "pending" || existing.stripeCheckoutSessionId) {
          return ok(res, {
            checkoutId: existing.id,
            sessionId: existing.stripeCheckoutSessionId,
            url: existing.checkoutUrl,
            status: existing.status,
            totalAmount: existing.totalAmount,
          });
        }
        recoverableCheckout = existing;
        resolved = {
          providerOrganizationId: existing.providerOrganizationId,
          allocations: storedAllocations.map((allocation) => ({
            invoiceId: allocation.invoiceId,
            amount: allocation.amount,
            amountCents: Math.round(Number(allocation.amount) * 100),
          })),
        };
      }
    }
    resolved ??= await getProviderCheckoutAllocations(providerOrgIds, input);
    const totalCents = resolved.allocations.reduce(
      (total, allocation) => total + allocation.amountCents,
      0,
    );
    const totalAmount = (totalCents / 100).toFixed(2);

    const stripe = await getUncachableStripeClient();
    if (!stripe) throw new HttpError(503, "Stripe card payments are not configured.");

    let checkout: typeof providerPaymentCheckouts.$inferSelect;
    if (recoverableCheckout) {
      checkout = recoverableCheckout;
    } else {
      try {
        checkout = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(providerPaymentCheckouts)
            .values({
              providerOrganizationId: resolved.providerOrganizationId,
              initiatedByUserId: callerId,
              clientRequestId,
              totalAmount,
              currency: "usd",
              savePaymentMethod: input.savePaymentMethod,
              status: "pending",
            })
            .returning();
          await tx.insert(providerPaymentAllocations).values(
            resolved.allocations.map((allocation) => ({
              checkoutId: created.id,
              invoiceId: allocation.invoiceId,
              amount: allocation.amount,
            })),
          );
          return created;
        });
      } catch (error) {
        if (clientRequestId) {
          const [existing] = await db
            .select()
            .from(providerPaymentCheckouts)
            .where(
              and(
                eq(providerPaymentCheckouts.providerOrganizationId, resolved.providerOrganizationId),
                eq(providerPaymentCheckouts.clientRequestId, clientRequestId),
              ),
            )
            .limit(1);
          if (existing) {
            return ok(res, {
              checkoutId: existing.id,
              sessionId: existing.stripeCheckoutSessionId,
              url: existing.checkoutUrl,
              status: existing.status,
              totalAmount: existing.totalAmount,
            });
          }
        }
        throw error;
      }
    }

    let stripeSession: import("stripe").default.Checkout.Session | null = null;
    try {
      const customerId = await getOrCreateProviderPaymentCustomer(
        resolved.providerOrganizationId,
        stripe,
      );
      const origin = providerReturnOrigins()[0]!;
      const successUrl = safeReturnUrl(
        input.successUrl,
        `${origin}/desktop/?providerPaymentCheckout=${encodeURIComponent(checkout.id)}`,
      );
      const cancelUrl = safeReturnUrl(
        input.cancelUrl,
        `${origin}/desktop/?providerPaymentCheckout=${encodeURIComponent(checkout.id)}&cancelled=1`,
      );
      const session = await stripe.checkout.sessions.create(
        {
          customer: customerId,
          mode: "payment",
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: { name: "LabTrax invoice payment" },
                unit_amount: totalCents,
              },
              quantity: 1,
            },
          ],
          payment_intent_data: {
            setup_future_usage: input.savePaymentMethod ? "off_session" : undefined,
            metadata: {
              providerPaymentCheckoutId: checkout.id,
              providerOrganizationId: resolved.providerOrganizationId,
            },
          },
          saved_payment_method_options: {
            payment_method_save: input.savePaymentMethod ? "enabled" : "disabled",
            allow_redisplay_filters: ["always", "limited"],
          },
          success_url: successUrl,
          cancel_url: cancelUrl,
          client_reference_id: checkout.id,
          metadata: {
            providerPaymentCheckoutId: checkout.id,
            providerOrganizationId: resolved.providerOrganizationId,
          },
        },
        { idempotencyKey: `provider-payment-checkout-${checkout.id}` },
      );
      stripeSession = session;
      const expiresAt = session.expires_at
        ? new Date(session.expires_at * 1000)
        : null;
      await db
        .update(providerPaymentCheckouts)
        .set({
          stripeCheckoutSessionId: session.id,
          checkoutUrl: session.url,
          expiresAt,
          updatedAt: new Date(),
        })
        .where(eq(providerPaymentCheckouts.id, checkout.id));

      return ok(res, {
        checkoutId: checkout.id,
        sessionId: session.id,
        url: session.url,
        status: "pending",
        totalAmount,
      }, 201);
    } catch (error) {
      if (stripeSession) {
        try {
          await stripe.checkout.sessions.expire(stripeSession.id);
          await markProviderPaymentCheckoutFailed(
            checkout.id,
            "failed",
            "stripe_checkout_persistence_failed",
          );
        } catch {
          // Leave the attempt pending. Its Stripe metadata still points to the
          // durable checkout id, so a later verified success can settle it.
        }
      } else {
        // Session creation failures are ambiguous: Stripe may have accepted the
        // idempotent request even when its response was lost. Keep this attempt
        // pending so a retry can recover that same session or its webhook can
        // settle safely.
      }
      throw error;
    }
  }),
);

router.get(
  "/payment-checkout/:checkoutId",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const providerOrgIds = [(req as any).providerOrganizationId as string];
    const [checkout] = await db
      .select()
      .from(providerPaymentCheckouts)
      .where(
        and(
          eq(providerPaymentCheckouts.id, req.params.checkoutId),
          inArray(providerPaymentCheckouts.providerOrganizationId, providerOrgIds),
        ),
      )
      .limit(1);
    if (!checkout) throw new HttpError(404, "Payment checkout not found.");

    // A return-link request may beat the webhook. Reconcile from Stripe, but
    // never use a client-supplied status/query parameter as proof of payment.
    if (checkout.status === "pending" && checkout.stripeCheckoutSessionId) {
      const stripe = await getUncachableStripeClient();
      if (stripe) {
        try {
          const session = await stripe.checkout.sessions.retrieve(
            checkout.stripeCheckoutSessionId,
          );
          const paymentIntentId =
            typeof session.payment_intent === "string" ? session.payment_intent : null;
          if (session.payment_status === "paid") {
            await settleProviderPaymentCheckout(checkout.id, paymentIntentId);
          } else if (session.status === "expired") {
            await markProviderPaymentCheckoutFailed(checkout.id, "expired", "checkout_expired");
          }
        } catch {
          // Webhook delivery remains the authoritative retry path.
        }
      }
    }

    const [current] = await db
      .select()
      .from(providerPaymentCheckouts)
      .where(eq(providerPaymentCheckouts.id, checkout.id))
      .limit(1);
    const allocations = await db
      .select({
        invoiceId: providerPaymentAllocations.invoiceId,
        amount: providerPaymentAllocations.amount,
      })
      .from(providerPaymentAllocations)
      .where(eq(providerPaymentAllocations.checkoutId, checkout.id));
    return ok(res, {
      checkoutId: current.id,
      status: current.status,
      totalAmount: current.totalAmount,
      currency: current.currency,
      stripePaymentIntentId: current.stripePaymentIntentId,
      failureReason: current.failureReason,
      settledAt: current.settledAt,
      allocations,
    });
  }),
);

router.post(
  "/payment-checkout/:checkoutId/cancel",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const providerOrgIds = [(req as any).providerOrganizationId as string];
    const [checkout] = await db
      .select()
      .from(providerPaymentCheckouts)
      .where(
        and(
          eq(providerPaymentCheckouts.id, req.params.checkoutId),
          inArray(providerPaymentCheckouts.providerOrganizationId, providerOrgIds),
        ),
      )
      .limit(1);
    if (!checkout) throw new HttpError(404, "Payment checkout not found.");
    if (checkout.status === "pending") {
      if (checkout.stripeCheckoutSessionId) {
        const stripe = await getUncachableStripeClient();
        if (!stripe) {
          throw new HttpError(503, "Stripe card payments are not configured.");
        }
        try {
          await stripe.checkout.sessions.expire(checkout.stripeCheckoutSessionId);
        } catch {
          const session = await stripe.checkout.sessions.retrieve(
            checkout.stripeCheckoutSessionId,
          );
          const paymentIntentId =
            typeof session.payment_intent === "string" ? session.payment_intent : null;
          if (session.payment_status === "paid") {
            await settleProviderPaymentCheckout(checkout.id, paymentIntentId);
            return ok(res, { checkoutId: checkout.id, status: "succeeded" });
          }
          if (session.status !== "expired") {
            throw new HttpError(409, "Stripe Checkout could not be cancelled.");
          }
        }
      }
      await markProviderPaymentCheckoutFailed(checkout.id, "cancelled", "cancelled_by_provider");
    }
    return ok(res, { checkoutId: checkout.id, status: checkout.status === "pending" ? "cancelled" : checkout.status });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /provider/payment-history
//
// Returns all payment rows for the authenticated provider's invoices, newest
// first (by paidAt).  Each row carries: id, paidAt, invoiceId, invoiceNumber,
// patientName (from invoice displayMetadata), amount, paymentMethod, and
// referenceNumber.
//
// The provider org set is derived entirely from the caller's identity —
// no client-supplied parameter can widen the scope.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/payment-history",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;

    const providerOrgIds = [(req as any).providerOrganizationId as string];
    if (providerOrgIds.length === 0) return ok(res, []);

    // Find all invoices that belong to the caller's provider org(s).
    const providerInvoices = await db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        displayMetadataJson: invoices.displayMetadataJson,
      })
      .from(invoices)
      .where(inArray(invoices.providerOrganizationId, providerOrgIds));

    if (providerInvoices.length === 0) return ok(res, []);

    const invoiceIds = providerInvoices.map((i) => i.id);
    const invoiceMap = new Map(providerInvoices.map((i) => [i.id, i]));

    // Fetch all payment rows for those invoices, newest first.
    const rows = await db
      .select()
      .from(payments)
      .where(inArray(payments.invoiceId, invoiceIds))
      .orderBy(desc(payments.paidAt));

    const result = rows.map((p) => {
      const inv = invoiceMap.get(p.invoiceId);
      const meta = inv?.displayMetadataJson as
        | { patientName?: string | null }
        | null
        | undefined;
      return {
        id: p.id,
        paidAt: p.paidAt,
        invoiceId: p.invoiceId,
        invoiceNumber: inv?.invoiceNumber ?? null,
        patientName: meta?.patientName ?? null,
        amount: p.amount,
        paymentMethod: p.paymentMethod,
        referenceNumber: p.referenceNumber ?? null,
      };
    });

    return ok(res, result);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /provider/stats
//
// Returns remake metrics computed over the provider's complete case history.
// Unlike GET /cases/provider (capped at 500 for UI performance), this query
// has no LIMIT so totals are always accurate regardless of account size.
//
// Response shape:
//   { totalCases, remakeCount, remakePct, reasonCounts: [{reason, count}] }
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/stats",
  asyncHandler(async (req, res) => {
    await assertLinkedProviderCapability(
      (req as any).auth.userId as string,
      "provider_portal",
    );
    const callerId = (req as any).auth.userId as string;

    const providerOrgIds = [(req as any).providerOrganizationId as string];
    if (providerOrgIds.length === 0) {
      return ok(res, {
        totalCases: 0,
        remakeCount: 0,
        remakePct: 0,
        reasonCounts: [] as Array<{ reason: string; count: number }>,
      });
    }

    // Fetch only the two remake columns — no LIMIT so accuracy is guaranteed.
    const rows = await db
      .select({
        remakeOfCaseId: cases.remakeOfCaseId,
        remakeReason: cases.remakeReason,
        remakeReasonKey: cases.remakeReasonKey,
      })
      .from(cases)
      .where(
        and(
          inArray(cases.providerOrganizationId, providerOrgIds),
          notDeleted(cases),
        ),
      );

    const totalCases = rows.length;
    const remakeRows = rows.filter((r) => r.remakeOfCaseId != null);
    const remakeCount = remakeRows.length;
    const remakePct =
      totalCases === 0 ? 0 : Math.round((remakeCount / totalCases) * 100);

    const reasonMap = new Map<string, number>();
    for (const r of remakeRows) {
      const reason =
        r.remakeReasonKey === "other"
          ? "Other"
          : r.remakeReason?.trim() || "Unspecified";
      reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);
    }
    const reasonCounts = Array.from(reasonMap.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    return ok(res, { totalCases, remakeCount, remakePct, reasonCounts });
  }),
);

export default router;
