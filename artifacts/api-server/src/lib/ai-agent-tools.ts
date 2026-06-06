/**
 * AI Agent Tool Registry
 *
 * Defines the set of operations the agentic AI assistant can perform.
 * Each tool is classified as "readonly" or "impactful". Impactful tools
 * require explicit user confirmation before execution; readonly tools
 * run inline within the tool-calling loop.
 *
 * Permission enforcement: every tool executor receives the authenticated
 * userId and derives org context from the DB — never from client input.
 */
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  bankTransactionInvoices,
  bankTransactions,
  caseEvents,
  cases,
  invoices,
  organizations,
  organizationConnections,
  organizationMemberships,
  payments,
  pricingTiers,
  pricingOverrides,
} from "@workspace/db";
import { writeAuditLog } from "./audit";
import { ADMIN_ROLES, BILLING_ROLES, requireAnyRole } from "./rbac";
import { notDeleted } from "./soft-delete";
import { runBatchSendStatements } from "./statements";
import { ensureInvoiceDeposit } from "./invoice-deposits";
import type { Request } from "express";

// ─── Tool classification ────────────────────────────────────────────────────

export type ToolKind = "readonly" | "impactful";

export interface AgentTool {
  name: string;
  kind: ToolKind;
  description: string;
  parameters: Record<string, unknown>;
  /** Human-readable summary for the confirmation card. */
  summarize: (args: Record<string, unknown>, context: ToolContext) => Promise<string>;
  /** Execute the tool. Throws on auth / validation failures. */
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  userId: string;
  req: Request;
  /** "lab" | "provider" — determines which tools are available */
  userType: string;
  /** Primary lab org ID resolved from the user's memberships (null for providers) */
  labOrganizationId: string | null;
  /** Provider org IDs for provider users (empty for lab staff) */
  providerOrgIds: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function requireLabId(ctx: ToolContext): Promise<string> {
  if (ctx.labOrganizationId) return ctx.labOrganizationId;
  const rows = await db
    .select({ labId: organizationMemberships.labId })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.userId, ctx.userId),
        eq(organizationMemberships.status, "active"),
      ),
    )
    .limit(1);
  const labId = rows[0]?.labId ?? null;
  if (!labId) throw new Error("You are not a member of any active lab.");
  return labId;
}

// ─── Tool: lookup_invoice ────────────────────────────────────────────────────

const lookupInvoiceTool: AgentTool = {
  name: "lookup_invoice",
  kind: "readonly",
  description:
    "Look up an invoice by invoice number or partial number. Returns the invoice status, total, balance due, practice name, and the internal ID needed for other actions.",
  parameters: {
    type: "object",
    properties: {
      invoiceNumber: {
        type: "string",
        description: "The invoice number or partial number (e.g. '1042' or 'INV-2025-01').",
      },
    },
    required: ["invoiceNumber"],
  },
  summarize: async (args) => `Look up invoice "${args.invoiceNumber}"`,
  execute: async (args, ctx) => {
    const q = String(args.invoiceNumber ?? "").trim();
    let whereClause;

    if (ctx.userType === "provider") {
      // Provider users search across their linked practices
      if (ctx.providerOrgIds.length === 0) {
        return { found: false, message: "No linked practices found for your account." };
      }
      whereClause = and(
        inArray(invoices.providerOrganizationId, ctx.providerOrgIds),
        or(ilike(invoices.invoiceNumber, `%${q}%`), eq(invoices.invoiceNumber, q)),
      );
    } else {
      const labId = await requireLabId(ctx);
      await requireAnyRole(ctx.userId, labId, BILLING_ROLES);
      whereClause = and(
        eq(invoices.labOrganizationId, labId),
        or(ilike(invoices.invoiceNumber, `%${q}%`), eq(invoices.invoiceNumber, q)),
      );
    }

    const rows = await db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        status: invoices.status,
        total: invoices.total,
        balanceDue: invoices.balanceDue,
        providerOrganizationId: invoices.providerOrganizationId,
        caseId: invoices.caseId,
        caseNumber: cases.caseNumber,
      })
      .from(invoices)
      .leftJoin(cases, eq(cases.id, invoices.caseId))
      .where(whereClause)
      .orderBy(desc(invoices.createdAt))
      .limit(5);

    if (rows.length === 0) {
      return { found: false, message: `No invoice matching "${q}" found.` };
    }

    const enriched = await Promise.all(
      rows.map(async (r) => {
        const org = r.providerOrganizationId
          ? await db.query.organizations.findFirst({
              where: eq(organizations.id, r.providerOrganizationId),
            })
          : null;
        return { ...r, practiceName: org?.displayName || org?.name || "Unknown" };
      }),
    );
    return { found: true, invoices: enriched };
  },
};

// ─── Tool: lookup_case ───────────────────────────────────────────────────────

const lookupCaseTool: AgentTool = {
  name: "lookup_case",
  kind: "readonly",
  description:
    "Look up a case by case number or patient name. Returns the case status, doctor, due date, and the internal ID needed for other actions.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Case number (e.g. '2025-001') or patient name (e.g. 'Jane Doe').",
      },
    },
    required: ["query"],
  },
  summarize: async (args) => `Look up case "${args.query}"`,
  execute: async (args, ctx) => {
    const q = String(args.query ?? "").trim();
    const nameFilter = or(
      ilike(cases.caseNumber, `%${q}%`),
      ilike(cases.patientFirstName, `%${q}%`),
      ilike(cases.patientLastName, `%${q}%`),
      sql`concat(${cases.patientFirstName}, ' ', ${cases.patientLastName}) ilike ${"%" + q + "%"}`,
    );

    let whereClause;
    if (ctx.userType === "provider") {
      if (ctx.providerOrgIds.length === 0) {
        return { found: false, message: "No linked practices found for your account." };
      }
      whereClause = and(
        inArray(cases.providerOrganizationId, ctx.providerOrgIds),
        isNull(cases.deletedAt),
        nameFilter,
      );
    } else {
      const labId = await requireLabId(ctx);
      await requireAnyRole(ctx.userId, labId, BILLING_ROLES);
      whereClause = and(eq(cases.labOrganizationId, labId), isNull(cases.deletedAt), nameFilter);
    }

    const rows = await db
      .select()
      .from(cases)
      .where(whereClause)
      .orderBy(desc(cases.createdAt))
      .limit(5);

    if (rows.length === 0) {
      return { found: false, message: `No case matching "${q}" found.` };
    }
    return { found: true, cases: rows };
  },
};

// ─── Tool: mark_invoice_paid ─────────────────────────────────────────────────

const markInvoicePaidTool: AgentTool = {
  name: "mark_invoice_paid",
  kind: "impactful",
  description:
    "Mark an invoice as fully paid by recording a payment equal to the remaining balance. Use lookup_invoice first to get the internal invoice ID.",
  parameters: {
    type: "object",
    properties: {
      invoiceId: {
        type: "string",
        description: "The internal ID of the invoice to mark paid (from lookup_invoice).",
      },
      paymentMethod: {
        type: "string",
        enum: ["check", "ach", "credit_card", "cash", "other"],
        description: "Payment method. Default: check.",
      },
      note: {
        type: "string",
        description: "Optional payment note.",
      },
    },
    required: ["invoiceId"],
  },
  summarize: async (args) => {
    const inv = await db.query.invoices.findFirst({
      where: eq(invoices.id, String(args.invoiceId)),
    });
    if (!inv) return `Mark invoice ${args.invoiceId} as paid`;
    const method = args.paymentMethod ?? "check";
    return `Mark invoice ${inv.invoiceNumber} as paid — record $${inv.balanceDue} ${method} payment`;
  },
  execute: async (args, ctx) => {
    const inv = await db.query.invoices.findFirst({
      where: eq(invoices.id, String(args.invoiceId)),
    });
    if (!inv) throw new Error("Invoice not found.");
    await requireAnyRole(ctx.userId, inv.labOrganizationId, BILLING_ROLES);
    if (inv.status === "paid") throw new Error("Invoice is already paid.");
    if (inv.status === "void") throw new Error("Cannot pay a voided invoice.");

    const amount = Number(inv.balanceDue);
    if (amount <= 0) throw new Error("Invoice has no balance due.");

    const method = String(args.paymentMethod ?? "check");

    const [pmt] = await db
      .insert(payments)
      .values({
        invoiceId: inv.id,
        amount: amount.toFixed(2),
        paymentMethod: method,
        referenceNumber: args.note ? String(args.note) : null,
        recordedByUserId: ctx.userId,
      })
      .returning();

    await db
      .update(invoices)
      .set({ balanceDue: "0.00", status: "paid", updatedByUserId: ctx.userId })
      .where(eq(invoices.id, inv.id));

    await ensureInvoiceDeposit(
      { id: inv.id, invoiceNumber: inv.invoiceNumber, total: inv.total, labOrganizationId: inv.labOrganizationId },
      ctx.userId,
    ).catch(() => {});

    await writeAuditLog({
      req: ctx.req,
      organizationId: inv.labOrganizationId,
      action: "invoice_paid_via_ai_agent",
      entityType: "invoice",
      entityId: inv.id,
      beforeJson: { status: inv.status, balanceDue: inv.balanceDue },
      afterJson: { status: "paid", balanceDue: "0.00", paymentId: pmt?.id },
    });

    return {
      success: true,
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      amountPaid: amount.toFixed(2),
    };
  },
};

// ─── Tool: void_invoice ──────────────────────────────────────────────────────

const voidInvoiceTool: AgentTool = {
  name: "void_invoice",
  kind: "impactful",
  description:
    "Void an invoice. Use lookup_invoice first to get the internal invoice ID. A reason is required.",
  parameters: {
    type: "object",
    properties: {
      invoiceId: {
        type: "string",
        description: "The internal ID of the invoice to void (from lookup_invoice).",
      },
      reason: {
        type: "string",
        description: "Reason for voiding the invoice.",
      },
    },
    required: ["invoiceId", "reason"],
  },
  summarize: async (args) => {
    const inv = await db.query.invoices.findFirst({
      where: eq(invoices.id, String(args.invoiceId)),
    });
    const num = inv?.invoiceNumber ?? args.invoiceId;
    return `Void invoice ${num} — reason: "${args.reason}"`;
  },
  execute: async (args, ctx) => {
    const inv = await db.query.invoices.findFirst({
      where: eq(invoices.id, String(args.invoiceId)),
    });
    if (!inv) throw new Error("Invoice not found.");
    await requireAnyRole(ctx.userId, inv.labOrganizationId, ADMIN_ROLES);
    if (inv.status === "void") throw new Error("Invoice is already voided.");

    const voidReason = String(args.reason ?? "").trim();
    if (!voidReason) throw new Error("A reason is required to void an invoice.");

    // Mirror the existing void route: reverse any auto-deposit if present.
    const depositLinks = await db
      .select({
        bankTransactionId: bankTransactionInvoices.bankTransactionId,
        txnSource: bankTransactions.source,
        txnStatus: bankTransactions.status,
      })
      .from(bankTransactionInvoices)
      .innerJoin(bankTransactions, eq(bankTransactions.id, bankTransactionInvoices.bankTransactionId))
      .where(eq(bankTransactionInvoices.invoiceId, inv.id));
    const autoDeposit = depositLinks.find(
      (l) => l.txnSource === "invoice" && l.txnStatus !== "void",
    );
    if (autoDeposit) {
      await db
        .update(bankTransactions)
        .set({ status: "void" })
        .where(eq(bankTransactions.id, autoDeposit.bankTransactionId));
    }

    const [updated] = await db
      .update(invoices)
      .set({
        status: "void",
        balanceDue: "0.00",
        voidedAt: new Date(),
        voidedByUserId: ctx.userId,
        voidReason,
        voidKind: "void",
        updatedByUserId: ctx.userId,
      })
      .where(eq(invoices.id, inv.id))
      .returning();

    // Fire case event if invoice is linked to a case.
    if (inv.caseId) {
      const user = (ctx.req as any).user;
      await db.insert(caseEvents).values({
        caseId: inv.caseId,
        eventType: "invoice_voided",
        actorUserId: ctx.userId,
        actorOrganizationId: inv.labOrganizationId,
        actorInitials: user?.initials || "AI",
        metadataJson: {
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          reason: voidReason,
          depositReversed: !!autoDeposit,
        },
      });
    }

    await writeAuditLog({
      req: ctx.req,
      organizationId: inv.labOrganizationId,
      action: "invoice_voided_via_ai_agent",
      entityType: "invoice",
      entityId: inv.id,
      beforeJson: { status: inv.status },
      afterJson: { ...updated, depositReversed: !!autoDeposit },
    });

    return {
      success: true,
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      depositReversed: !!autoDeposit,
    };
  },
};

// ─── Tool: send_statements ───────────────────────────────────────────────────

const sendStatementsTool: AgentTool = {
  name: "send_statements",
  kind: "impactful",
  description:
    "Generate and email statements to all practices with open invoices. Optionally scope to overdue-only or all invoices, and set a period label.",
  parameters: {
    type: "object",
    properties: {
      invoiceScope: {
        type: "string",
        enum: ["open", "open_overdue_90", "all"],
        description: "Which invoices to include: 'open' (default), 'open_overdue_90' (only 90+ days overdue), or 'all'.",
      },
      channels: {
        type: "array",
        items: { type: "string", enum: ["email", "sms"] },
        description: "Delivery channels. Default: ['email'].",
      },
      periodLabel: {
        type: "string",
        description: "Period label shown on statement, e.g. 'June 2026'.",
      },
    },
    required: [],
  },
  summarize: async (args, ctx) => {
    const labId = await requireLabId(ctx);
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, labId),
    });
    const scope = (args.invoiceScope as string) ?? "open";
    const channels = ((args.channels as string[]) ?? ["email"]).join(" & ");
    const period = args.periodLabel ? ` for ${args.periodLabel}` : "";
    return `Send ${scope} statements${period} via ${channels} for lab "${org?.displayName ?? org?.name ?? labId}"`;
  },
  execute: async (args, ctx) => {
    const labId = await requireLabId(ctx);
    await requireAnyRole(ctx.userId, labId, ADMIN_ROLES);

    const result = await runBatchSendStatements({
      labOrganizationId: labId,
      triggeredByUserId: ctx.userId,
      practiceIds: null,
      invoiceScope: ((args.invoiceScope as string) ?? "open") as any,
      channels: ((args.channels as string[]) ?? ["email"]) as any,
      emailSubject: null,
      emailBody: null,
      periodLabel: (args.periodLabel as string | null) ?? null,
    });

    await writeAuditLog({
      req: ctx.req,
      organizationId: labId,
      action: "statements_sent_via_ai_agent",
      entityType: "organization",
      entityId: labId,
      metadataJson: {
        sent: result.results.length,
        invoiceScope: args.invoiceScope,
        channels: args.channels,
        periodLabel: args.periodLabel,
      },
    });

    return { success: true, sentCount: result.results.length };
  },
};

// ─── Tool: merge_doctors ─────────────────────────────────────────────────────

const mergeDoctorsTool: AgentTool = {
  name: "merge_doctors",
  kind: "impactful",
  description:
    "Merge a duplicate doctor name into the canonical target name. All cases and pricing overrides referencing the source name will be re-attributed to the target.",
  parameters: {
    type: "object",
    properties: {
      sourceDoctorName: {
        type: "string",
        description: "The duplicate / incorrect doctor name to merge away.",
      },
      targetDoctorName: {
        type: "string",
        description: "The canonical doctor name to merge into.",
      },
    },
    required: ["sourceDoctorName", "targetDoctorName"],
  },
  summarize: async (args, ctx) => {
    const labId = await requireLabId(ctx);
    const sourceRows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(cases)
      .where(
        and(
          eq(cases.labOrganizationId, labId),
          sql`lower(${cases.doctorName}) = lower(${String(args.sourceDoctorName)})`,
          isNull(cases.deletedAt),
        ),
      );
    const count = Number(sourceRows[0]?.n ?? 0);
    return `Merge doctor "${args.sourceDoctorName}" → "${args.targetDoctorName}" (${count} case${count === 1 ? "" : "s"} will be re-attributed)`;
  },
  execute: async (args, ctx) => {
    const labId = await requireLabId(ctx);
    await requireAnyRole(ctx.userId, labId, ADMIN_ROLES);

    const sourceName = String(args.sourceDoctorName).trim();
    const targetName = String(args.targetDoctorName).trim();
    if (!sourceName || !targetName) throw new Error("Doctor names are required.");
    if (sourceName.toLowerCase() === targetName.toLowerCase()) {
      throw new Error("Source and target names are the same — nothing to merge.");
    }

    const matchedCases = await db
      .select({ id: cases.id })
      .from(cases)
      .where(
        and(
          eq(cases.labOrganizationId, labId),
          sql`lower(${cases.doctorName}) = lower(${sourceName})`,
          isNull(cases.deletedAt),
        ),
      );

    if (matchedCases.length > 0) {
      await db
        .update(cases)
        .set({ doctorName: targetName } as any)
        .where(inArray(cases.id, matchedCases.map((c) => c.id)));
    }

    await db
      .update(pricingOverrides)
      .set({ doctorName: targetName })
      .where(
        and(
          eq(pricingOverrides.labOrganizationId, labId),
          sql`lower(${pricingOverrides.doctorName}) = lower(${sourceName})`,
          isNull(pricingOverrides.deletedAt),
        ),
      );

    await writeAuditLog({
      req: ctx.req,
      organizationId: labId,
      action: "doctor_merged_via_ai_agent",
      entityType: "doctor",
      entityId: null,
      beforeJson: { doctorName: sourceName },
      afterJson: { doctorName: targetName },
      metadataJson: { casesMoved: matchedCases.length },
    });

    return { success: true, casesMoved: matchedCases.length, sourceDoctorName: sourceName, targetDoctorName: targetName };
  },
};

// ─── Tool: set_practice_pricing_tier ────────────────────────────────────────

const setPracticePricingTierTool: AgentTool = {
  name: "set_practice_pricing_tier",
  kind: "impactful",
  description:
    "Set the pricing tier for a practice in the lab. The tier name must match an existing tier exactly (case-insensitive).",
  parameters: {
    type: "object",
    properties: {
      practiceNameOrId: {
        type: "string",
        description: "The practice name or ID (e.g. 'Bright Dental').",
      },
      tierName: {
        type: "string",
        description: "The tier to assign (e.g. 'Standard', 'Premium'). Must match an existing tier name.",
      },
    },
    required: ["practiceNameOrId", "tierName"],
  },
  summarize: async (args) =>
    `Set pricing tier for "${args.practiceNameOrId}" to "${args.tierName}"`,
  execute: async (args, ctx) => {
    const labId = await requireLabId(ctx);
    await requireAnyRole(ctx.userId, labId, ADMIN_ROLES);

    const tierName = String(args.tierName).trim();
    const tier = await db.query.pricingTiers.findFirst({
      where: and(
        eq(pricingTiers.labOrganizationId, labId),
        sql`lower(${pricingTiers.name}) = lower(${tierName})`,
        notDeleted(pricingTiers),
      ),
    });
    if (!tier) throw new Error(`Tier "${tierName}" not found. Check your existing tier names.`);

    // Restrict practice lookup to orgs already connected to this lab — prevents
    // an admin from accidentally wiring a tier to a practice outside their network.
    const connectedIds = (
      await db
        .select({ pid: organizationConnections.providerOrganizationId })
        .from(organizationConnections)
        .where(eq(organizationConnections.labOrganizationId, labId))
    ).map((r) => r.pid);

    const practiceQuery = String(args.practiceNameOrId).trim();
    const practice = await db.query.organizations.findFirst({
      where: and(
        or(
          ilike(organizations.name, `%${practiceQuery}%`),
          ilike(organizations.displayName, `%${practiceQuery}%`),
          eq(organizations.id, practiceQuery),
        ),
        // Ensure the practice is already in this lab's network or is being
        // looked up by exact ID for a new-but-valid connection.
        connectedIds.length > 0 ? inArray(organizations.id, connectedIds) : sql`false`,
      ),
    });
    if (!practice) {
      const hint = connectedIds.length === 0
        ? " No practices are currently connected to this lab."
        : " Make sure the practice is already connected to your lab.";
      throw new Error(`Practice "${practiceQuery}" not found in this lab's network.${hint}`);
    }

    const existing = await db.query.organizationConnections.findFirst({
      where: and(
        eq(organizationConnections.labOrganizationId, labId),
        eq(organizationConnections.providerOrganizationId, practice.id),
      ),
    });

    if (existing) {
      await db
        .update(organizationConnections)
        .set({ tierName: tier.name })
        .where(eq(organizationConnections.id, existing.id));
    } else {
      await db.insert(organizationConnections).values({
        labOrganizationId: labId,
        providerOrganizationId: practice.id,
        tierName: tier.name,
        status: "active",
        requestedByOrgId: labId,
        requestedByUserId: ctx.userId,
      });
    }

    await writeAuditLog({
      req: ctx.req,
      organizationId: labId,
      action: "practice_pricing_tier_set_via_ai_agent",
      entityType: "organization",
      entityId: practice.id,
      beforeJson: { tierName: existing?.tierName ?? null },
      afterJson: { tierName: tier.name },
    });

    return { success: true, practiceName: practice.displayName ?? practice.name, tierName: tier.name };
  },
};

// ─── Tool: create_pricing_override ───────────────────────────────────────────

const createPricingOverrideTool: AgentTool = {
  name: "create_pricing_override",
  kind: "impactful",
  description:
    "Create or update a per-doctor custom pricing override, based on an existing tier's prices.",
  parameters: {
    type: "object",
    properties: {
      doctorName: {
        type: "string",
        description: "Full doctor name (e.g. 'Dr. Smith').",
      },
      tierName: {
        type: "string",
        description: "The existing tier to base prices on (e.g. 'Premium').",
      },
      notes: {
        type: "string",
        description: "Optional notes about this override.",
      },
    },
    required: ["doctorName", "tierName"],
  },
  summarize: async (args) =>
    `Set custom pricing for Dr. "${args.doctorName}" based on the "${args.tierName}" tier`,
  execute: async (args, ctx) => {
    const labId = await requireLabId(ctx);
    await requireAnyRole(ctx.userId, labId, ADMIN_ROLES);

    const doctorName = String(args.doctorName).trim();
    const tierName = String(args.tierName).trim();

    const tier = await db.query.pricingTiers.findFirst({
      where: and(
        eq(pricingTiers.labOrganizationId, labId),
        sql`lower(${pricingTiers.name}) = lower(${tierName})`,
        notDeleted(pricingTiers),
      ),
    });
    if (!tier) throw new Error(`Tier "${tierName}" not found.`);

    const existing = await db.query.pricingOverrides.findFirst({
      where: and(
        eq(pricingOverrides.labOrganizationId, labId),
        sql`lower(${pricingOverrides.doctorName}) = lower(${doctorName})`,
        isNull(pricingOverrides.deletedAt),
      ),
    });

    if (existing) {
      await db
        .update(pricingOverrides)
        .set({
          tierName: tier.name,
          pricesJson: tier.pricesJson,
          notes: args.notes ? String(args.notes) : existing.notes,
          updatedAt: new Date(),
        })
        .where(eq(pricingOverrides.id, existing.id));
    } else {
      await db.insert(pricingOverrides).values({
        labOrganizationId: labId,
        doctorName,
        tierName: tier.name,
        pricesJson: tier.pricesJson,
        notes: args.notes ? String(args.notes) : null,
        createdByUserId: ctx.userId,
      });
    }

    await writeAuditLog({
      req: ctx.req,
      organizationId: labId,
      action: "pricing_override_set_via_ai_agent",
      entityType: "pricing_override",
      entityId: existing?.id ?? null,
      afterJson: { doctorName, tierName: tier.name },
    });

    return { success: true, doctorName, tierName: tier.name, updated: !!existing };
  },
};

// ─── Tool: create_case ───────────────────────────────────────────────────────

const createCaseTool: AgentTool = {
  name: "create_case",
  kind: "impactful",
  description:
    "Create a new case in the lab with 'received' status. Patient name and doctor name are required.",
  parameters: {
    type: "object",
    properties: {
      patientFirstName: { type: "string", description: "Patient's first name." },
      patientLastName: { type: "string", description: "Patient's last name." },
      doctorName: { type: "string", description: "Full doctor name (e.g. 'Dr. Jane Smith')." },
      dueDate: {
        type: "string",
        description: "Due date in YYYY-MM-DD format, e.g. '2026-06-30'.",
      },
      priority: {
        type: "string",
        enum: ["normal", "rush"],
        description: "Case priority. Default: 'normal'.",
      },
    },
    required: ["patientFirstName", "patientLastName", "doctorName"],
  },
  summarize: async (args) => {
    const due = args.dueDate ? ` due ${args.dueDate}` : "";
    const priority = args.priority === "rush" ? " [RUSH]" : "";
    return `Create case for ${args.patientFirstName} ${args.patientLastName}, doctor ${args.doctorName}${due}${priority}`;
  },
  execute: async (args, ctx) => {
    if (ctx.userType === "provider") {
      throw new Error("Case creation is only available for lab staff accounts.");
    }
    const labId = await requireLabId(ctx);
    await requireAnyRole(ctx.userId, labId, ADMIN_ROLES);

    const { randomBytes } = await import("node:crypto");
    const caseId = randomBytes(16).toString("hex");

    // Use the same sequential case number format as the /next-case-number route.
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const [row] = await db
      .select({
        maxSeq: sql<string | null>`max(
          case when ${cases.caseNumber} ~ ${`^${yy}-(\\d+)$`}
          then regexp_replace(${cases.caseNumber}, ${`^${yy}-(\\d+)$`}, '\\1')::int
          else null end
        )`,
      })
      .from(cases)
      .where(eq(cases.labOrganizationId, labId));
    const next = (Number(row?.maxSeq ?? 0) || 0) + 1;
    const caseNumber = `${yy}-${next}`;

    const [created] = await db
      .insert(cases)
      .values({
        id: caseId,
        labOrganizationId: labId,
        caseNumber,
        patientFirstName: String(args.patientFirstName).trim(),
        patientLastName: String(args.patientLastName).trim(),
        doctorName: String(args.doctorName).trim(),
        status: "received",
        priority: args.priority === "rush" ? "rush" : "normal",
        dueDate: args.dueDate ? new Date(String(args.dueDate)) : null,
        createdByUserId: ctx.userId,
      } as any)
      .returning();

    await writeAuditLog({
      req: ctx.req,
      organizationId: labId,
      action: "case_created_via_ai_agent",
      entityType: "case",
      entityId: created.id,
      afterJson: created,
    });

    return {
      success: true,
      caseId: created.id,
      caseNumber: created.caseNumber,
      status: created.status,
    };
  },
};

// ─── Tool: update_case_status ────────────────────────────────────────────────

const updateCaseStatusTool: AgentTool = {
  name: "update_case_status",
  kind: "impactful",
  description:
    "Update the status of a case. Use lookup_case first to get the case ID.",
  parameters: {
    type: "object",
    properties: {
      caseId: {
        type: "string",
        description: "The internal case ID (from lookup_case).",
      },
      status: {
        type: "string",
        enum: ["received", "in_progress", "ready_for_pickup", "shipped", "complete"],
        description: "New status for the case.",
      },
    },
    required: ["caseId", "status"],
  },
  summarize: async (args) => {
    const c = await db.query.cases.findFirst({ where: eq(cases.id, String(args.caseId)) });
    const num = c?.caseNumber ?? args.caseId;
    return `Update case ${num} status → "${args.status}"`;
  },
  execute: async (args, ctx) => {
    const c = await db.query.cases.findFirst({
      where: and(eq(cases.id, String(args.caseId)), isNull(cases.deletedAt)),
    });
    if (!c) throw new Error("Case not found.");
    await requireAnyRole(ctx.userId, c.labOrganizationId, ADMIN_ROLES);

    const [updated] = await db
      .update(cases)
      .set({ status: String(args.status) as any, updatedAt: new Date() })
      .where(eq(cases.id, c.id))
      .returning();

    await writeAuditLog({
      req: ctx.req,
      organizationId: c.labOrganizationId,
      action: "case_status_updated_via_ai_agent",
      entityType: "case",
      entityId: c.id,
      beforeJson: { status: c.status },
      afterJson: { status: updated.status },
    });

    return { success: true, caseId: c.id, caseNumber: c.caseNumber, status: updated.status };
  },
};

// ─── Tool: update_case ───────────────────────────────────────────────────────

const updateCaseTool: AgentTool = {
  name: "update_case",
  kind: "impactful",
  description:
    "Edit one or more fields on a case — patient name, doctor name, due date, or priority. Use lookup_case first to get the case ID. Only provide the fields you want to change.",
  parameters: {
    type: "object",
    properties: {
      caseId: {
        type: "string",
        description: "The internal case ID (from lookup_case).",
      },
      patientFirstName: { type: "string", description: "Updated patient first name." },
      patientLastName: { type: "string", description: "Updated patient last name." },
      doctorName: { type: "string", description: "Updated doctor name." },
      dueDate: { type: "string", description: "Updated due date in YYYY-MM-DD format." },
      priority: {
        type: "string",
        enum: ["normal", "rush"],
        description: "Updated case priority.",
      },
    },
    required: ["caseId"],
  },
  summarize: async (args) => {
    const c = await db.query.cases.findFirst({ where: eq(cases.id, String(args.caseId)) });
    const num = c?.caseNumber ?? args.caseId;
    const changes: string[] = [];
    if (args.patientFirstName || args.patientLastName)
      changes.push(`patient → ${[args.patientFirstName, args.patientLastName].filter(Boolean).join(" ")}`);
    if (args.doctorName) changes.push(`doctor → ${args.doctorName}`);
    if (args.dueDate) changes.push(`due → ${args.dueDate}`);
    if (args.priority) changes.push(`priority → ${args.priority}`);
    return `Edit case ${num}: ${changes.join(", ") || "no fields specified"}`;
  },
  execute: async (args, ctx) => {
    const c = await db.query.cases.findFirst({
      where: and(eq(cases.id, String(args.caseId)), isNull(cases.deletedAt)),
    });
    if (!c) throw new Error("Case not found.");
    await requireAnyRole(ctx.userId, c.labOrganizationId, ADMIN_ROLES);

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (args.patientFirstName !== undefined) updates.patientFirstName = String(args.patientFirstName).trim();
    if (args.patientLastName !== undefined) updates.patientLastName = String(args.patientLastName).trim();
    if (args.doctorName !== undefined) updates.doctorName = String(args.doctorName).trim();
    if (args.priority !== undefined) updates.priority = String(args.priority);
    if (args.dueDate !== undefined) updates.dueDate = args.dueDate ? new Date(String(args.dueDate)) : null;

    if (Object.keys(updates).length === 1) throw new Error("No fields to update were provided.");

    const [updated] = await db
      .update(cases)
      .set(updates as any)
      .where(eq(cases.id, c.id))
      .returning();

    await writeAuditLog({
      req: ctx.req,
      organizationId: c.labOrganizationId,
      action: "case_edited_via_ai_agent",
      entityType: "case",
      entityId: c.id,
      beforeJson: {
        patientFirstName: c.patientFirstName,
        patientLastName: c.patientLastName,
        doctorName: c.doctorName,
        dueDate: c.dueDate,
        priority: c.priority,
      },
      afterJson: updates,
    });

    return {
      success: true,
      caseId: c.id,
      caseNumber: c.caseNumber,
      fieldsUpdated: Object.keys(updates).filter((k) => k !== "updatedAt"),
    };
  },
};

// ─── Tool: reset_invoice_layout ──────────────────────────────────────────────

const resetInvoiceLayoutTool: AgentTool = {
  name: "reset_invoice_layout",
  kind: "impactful",
  description:
    "Reset the lab's invoice print layout to the default template. Use this when the layout is broken or the lab wants to start fresh.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  summarize: async (_args, ctx) => {
    const labId = await requireLabId(ctx);
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, labId) });
    return `Reset invoice print layout to default for "${org?.displayName ?? org?.name ?? labId}"`;
  },
  execute: async (_args, ctx) => {
    const labId = await requireLabId(ctx);
    await requireAnyRole(ctx.userId, labId, ADMIN_ROLES);

    const existing = await db.query.organizations.findFirst({
      where: eq(organizations.id, labId),
      columns: { id: true, invoiceTemplate: true } as any,
    });
    if (!existing) throw new Error("Lab organization not found.");

    await db
      .update(organizations)
      .set({ invoiceTemplate: null as any, updatedAt: new Date() })
      .where(eq(organizations.id, labId));

    await writeAuditLog({
      req: ctx.req,
      organizationId: labId,
      action: "invoice_layout_reset_via_ai_agent",
      entityType: "organization",
      entityId: labId,
      beforeJson: { invoiceTemplate: (existing as any).invoiceTemplate ?? null },
      afterJson: { invoiceTemplate: null },
    });

    return { success: true, message: "Invoice layout reset to default." };
  },
};

// ─── Registry ────────────────────────────────────────────────────────────────

export const AGENT_TOOLS: AgentTool[] = [
  lookupInvoiceTool,
  lookupCaseTool,
  markInvoicePaidTool,
  voidInvoiceTool,
  sendStatementsTool,
  mergeDoctorsTool,
  setPracticePricingTierTool,
  createPricingOverrideTool,
  createCaseTool,
  updateCaseStatusTool,
  updateCaseTool,
  resetInvoiceLayoutTool,
];

export const TOOL_BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.name, t]));

/** Build the OpenAI tools array for the chat completion call. */
export function buildOpenAiTools(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return AGENT_TOOLS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
