import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db, cases, caseAttachments, caseEvents, caseRestorations, doctorProfiles,
  invoices, invoiceLineItems, organizations, payments, bankTransactionInvoices,
} from "@workspace/db";
import { z } from "zod";
import { HttpError } from "./http";
import { invoiceDueDate } from "./invoice-due-date";
import { buildBridgeAwareLineItems, parseConnectors, findConnectedComponents } from "./invoice-line-grouping";
import {
  insertGroupedLineItemsWithChildren, sumGroupedLineItemsTotal,
  type GroupedLineItemInsert,
} from "./invoice-sync";
import { resolveServerPriceWithSource } from "./pricing";
import { resolveRestorationPriceKey } from "./restoration-pricing";
import { normalizeCaseHierarchy } from "./case-category";
import { isPfmOrFcmMaterial } from "./material-mapping";
import { isRecoveryHeld, RECOVERY_DRAFT_STATUS } from "./recovery-billing-hold";
import { requireApprovedRecoveryRun } from "./recovery-billing-run";
import { ADMIN_ROLES, BILLING_ROLES, requireAnyRole } from "./rbac";
import {
  assertRecoveryDataAvailable, recoveryScope, RECOVERY_LAB_ID, RECOVERY_TAG, RECOVERY_TIMEZONE,
} from "./recovery-billing-scope";

export const recoveryWorkSchema = z.object({
  toothNumber: z.string().trim().max(16).default(""),
  restorationType: z.string().trim().min(1).max(100),
  restorationSubtype: z.string().trim().max(100).nullable().default(null),
  arch: z.enum(["upper", "lower"]).nullable().default(null),
  material: z.string().trim().max(100).nullable().default(null),
  shade: z.string().trim().max(100).nullable().default(null),
  quantity: z.number().int().positive().max(32).default(1),
}).strict();

export const recoveryProposalSchema = z.object({
  evidenceAttachmentId: z.string().min(1),
  restorations: z.array(recoveryWorkSchema).min(1).max(64),
  bridgeConnectors: z.string().max(200).nullable().default(null),
  prescriptionReviewed: z.literal(true),
  identityReviewed: z.literal(true),
  duplicateReviewed: z.literal(true),
  reviewNotes: z.string().trim().min(1).max(4000),
}).strict();

/** The entered work only: a price preview needs no review confirmations or notes. */
export const recoveryPreviewSchema = recoveryProposalSchema.pick({
  evidenceAttachmentId: true, restorations: true, bridgeConnectors: true,
}).strict();

type RecoveryWork = z.infer<typeof recoveryWorkSchema>;
type ProposalInput = z.infer<typeof recoveryProposalSchema>;
type PreviewInput = z.infer<typeof recoveryPreviewSchema>;
type PricingInput = Pick<ProposalInput, "evidenceAttachmentId" | "restorations" | "bridgeConnectors">;
type PricedWork = RecoveryWork & {
  id: string; unitPrice: string; priceSource: string | null;
  priceSourceId: string | null; priceSourceName: string | null; priceKey: string | null;
};
type Quote<I extends PricingInput> = {
  version: 1; caseFingerprint: string; input: I; rows: PricedWork[];
  lines: GroupedLineItemInsert[]; total: string; exceptions: string[];
  pricingAt: string; pricingBasis: "current_catalog";
  previousInvoiceId?: string; previousInvoiceFingerprint?: string; previousLinesFingerprint?: string;
  doctorIdentity: string | null;
};
type Proposal = Quote<ProposalInput>;

/**
 * How an exact staged proposal is applied. Only the operator batch carries a
 * rehearsed run approval; the page applies one case for an owner/admin, and
 * billing staff may only replace an existing held draft.
 */
export type RecoveryApplyMode = "operator" | "page" | "correction";

function isReleasedReplacement(invoice: { displayMetadataJson?: unknown }): boolean {
  const recovery = (invoice.displayMetadataJson as { recoveryBilling?: { state?: string; source?: string } } | null)?.recoveryBilling;
  return recovery?.state === "released" && recovery.source === RECOVERY_TAG;
}

export function recoveryFingerprint(value: unknown): string {
  // jsonb reorders keys. Hash the JSON value, never insertion order, so an
  // approved in-memory quote retains its identity after persistence/restoration.
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => [key, canonical(child)]));
    }
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(JSON.parse(JSON.stringify(value))))).digest("hex");
}

async function scopedCase(caseId: string, executor: Pick<typeof db, "query"> = db) {
  assertRecoveryDataAvailable();
  const source = recoveryScope.get(caseId);
  if (!source?.inWindow) throw new HttpError(409, "Case is outside the evidence-backed recovery billing window.");
  const row = await executor.query.cases.findFirst({ where: eq(cases.id, caseId) });
  if (!row || row.labOrganizationId !== RECOVERY_LAB_ID || row.aiImportSource !== RECOVERY_TAG) {
    throw new HttpError(404, "Verified recovered case not found.");
  }
  if (row.deletedAt) throw new HttpError(409, "Deleted cases cannot be reconstructed.");
  return row;
}

/** Historical scope comes from immutable reconstruction evidence, not dates edited later. */
export async function listRecoveryBilling() {
  assertRecoveryDataAvailable();
  const ids = [...recoveryScope].filter(([, source]) => source.inWindow).map(([id]) => id);
  const [caseRows, invoiceRows, restorationRows, events, attachments] = await Promise.all([
    db.select().from(cases).where(and(eq(cases.labOrganizationId, RECOVERY_LAB_ID), inArray(cases.id, ids))),
    db.select().from(invoices).where(inArray(invoices.caseId, ids)),
    db.select({ caseId: caseRestorations.caseId }).from(caseRestorations).where(inArray(caseRestorations.caseId, ids)),
    db.select().from(caseEvents).where(and(inArray(caseEvents.caseId, ids),
      sql`${caseEvents.eventType} LIKE 'billing_recovery_%'`)).orderBy(desc(caseEvents.createdAt), desc(caseEvents.id)),
    db.select().from(caseAttachments).where(inArray(caseAttachments.caseId, ids)),
  ]);
  return ids.map((id) => {
    const source = recoveryScope.get(id)!;
    const row = caseRows.find((candidate) => candidate.id === id);
    if (!row) return {
      caseId: id, caseNumber: source.caseNumber, historicalDate: source.historicalDate,
      patientName: "", doctorName: "", practiceId: null, rxNotes: null, sourceFlagged: source.flagged,
      state: "unresolved", proposalId: null, proposal: null, invoice: null, prescriptions: [], decision: null,
    };
    const foreignBilling = invoiceRows.some((invoice) => invoice.caseId === id && invoice.labOrganizationId !== RECOVERY_LAB_ID);
    const bills = invoiceRows.filter((invoice) => invoice.caseId === row.id && invoice.labOrganizationId === RECOVERY_LAB_ID);
    const decision = events.find((event) => event.caseId === row.id && event.eventType !== "billing_recovery_analyzed");
    const proposalEvent = events.find((event) => event.caseId === row.id && event.eventType === "billing_recovery_proposed");
    const proposal = (proposalEvent?.metadataJson as { proposal?: Proposal } | null)?.proposal ?? null;
    const invoice = bills.find((bill) => isRecoveryHeld(bill)) ?? bills[0] ?? null;
    const state = row.aiImportSource !== RECOVERY_TAG || foreignBilling ? "unresolved"
      : row.deletedAt ? "deleted_case"
      : decision?.eventType === "billing_recovery_do_not_bill" ? "do_not_bill"
      : bills.some((bill) => bill.deletedAt || bill.status === "void") ? "deleted_or_void_billing"
      : invoice ? isRecoveryHeld(invoice) ? "held"
        : bills.length === 1 && isReleasedReplacement(invoice) ? "released" : "existing_billing"
      : restorationRows.some((restoration) => restoration.caseId === row.id) ? "existing_work"
      : proposal ? proposal.exceptions.length ? "exception" : "proposed"
      : "needs_prescription_review";
    return {
      caseId: row.id, caseNumber: row.caseNumber, historicalDate: source.historicalDate,
      patientName: `${row.patientFirstName ?? ""} ${row.patientLastName ?? ""}`.trim(),
      doctorName: row.doctorName, practiceId: row.providerOrganizationId, rxNotes: row.rxNotes,
      sourceFlagged: source.flagged, state, proposalId: proposalEvent?.id ?? null, proposal,
      invoice: invoice ? {
        id: invoice.id, invoiceNumber: invoice.invoiceNumber, status: invoice.status,
        total: invoice.total, balanceDue: invoice.balanceDue, dueAt: invoice.dueAt ?? null,
        recoveryBilling: (invoice.displayMetadataJson as Record<string, unknown> | null)?.recoveryBilling ?? null,
      } : null,
      prescriptions: attachments.filter((attachment) => attachment.caseId === row.id &&
        !attachment.deletedAt && source.prescriptions.some((file) => attachment.storageKey?.endsWith(file)))
        .map((attachment) => ({ id: attachment.id, fileName: attachment.fileName })),
      decision: decision ? { eventType: decision.eventType, metadata: decision.metadataJson, createdAt: decision.createdAt } : null,
    };
  });
}

function validateWork(rows: RecoveryWork[]): string[] {
  const exceptions: string[] = [];
  const identities = new Set<string>();
  for (const row of rows) {
    const archWork = /removable|denture|partial|reline|rebase|tray|guard|appliance|orthodontic/i.test(row.restorationType);
    if (archWork && !row.arch) exceptions.push("Arch is required for removable/appliance work.");
    if (archWork && row.quantity !== 1) exceptions.push("Each arch must be represented once, not once per replacement tooth.");
    if (!archWork && !/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(row.toothNumber) &&
        !/alloy|service|repair/i.test(row.restorationType)) {
      exceptions.push("Per-tooth work requires an explicit supported tooth number.");
    }
    if (!archWork && /crown|bridge|pontic|veneer|inlay|onlay/i.test(row.restorationType) && row.quantity !== 1) {
      exceptions.push("Per-tooth fixed work must have quantity one; add each prescribed tooth explicitly.");
    }
    const key = /crown|bridge|pontic|veneer|inlay|onlay/i.test(row.restorationType)
      ? `fixed:${row.toothNumber}` : `${row.restorationType}:${row.toothNumber}:${row.arch}`;
    if (identities.has(key)) exceptions.push("Possible duplicate restoration/service.");
    identities.add(key);
    if (row.restorationType === "missing") exceptions.push("Missing-tooth markers are not billed services.");
  }
  return [...new Set(exceptions)];
}

async function priceProposal<I extends PricingInput>(caseRow: Awaited<ReturnType<typeof scopedCase>>, input: I): Promise<Quote<I>> {
  const exceptions = validateWork(input.restorations);
  const connectors = parseConnectors(input.bridgeConnectors);
  const toothNumbers = input.restorations.map((row) => Number(row.toothNumber)).filter((n) => n >= 1 && n <= 32);
  if (input.bridgeConnectors && (connectors.size === 0 ||
      input.bridgeConnectors.split(",").some((pair) => !/^\s*(?:[1-9]|[12]\d|3[0-2])\s*-\s*(?:[1-9]|[12]\d|3[0-2])\s*$/.test(pair)) ||
      [...connectors].some((pair) => pair.split("-").some((number) => !toothNumbers.includes(Number(number))) ||
        new Set(pair.split("-")).size !== 2))) {
    exceptions.push("Bridge connectors must reference distinct, explicitly prescribed teeth (for example 8-9,9-10).");
  }
  const components = findConnectedComponents(toothNumbers, connectors);
  for (const pontic of input.restorations.filter((row) => /pontic/i.test(row.restorationType))) {
    const span = components.find((teeth) => teeth.includes(Number(pontic.toothNumber)));
    if (!span || span.length < 2 || !input.restorations.some((row) =>
      !/pontic/i.test(row.restorationType) && span.includes(Number(row.toothNumber)))) {
      exceptions.push("Each pontic requires a reviewed bridge connector map and a prescribed abutment.");
    }
  }
  // Never infer whether a remake was free from its prescription wording.
  if (caseRow.remakeOfCaseId || caseRow.remakeReasonKey ||
      /\b(remake|re-?do|refabricate|no.?charge)\b/i.test(caseRow.rxNotes ?? "")) {
    exceptions.push("Remake/no-charge intent requires independent review; no automatic reconstruction.");
  }
  const identities = await db.query.doctorProfiles.findMany({ where: and(
    eq(doctorProfiles.labOrganizationId, RECOVERY_LAB_ID),
    eq(doctorProfiles.providerOrganizationId, caseRow.providerOrganizationId ?? ""),
    eq(doctorProfiles.doctorName, caseRow.doctorName),
  ) });
  const identity = identities.length === 1 ? identities[0] : undefined;
  if (!identity) exceptions.push("Doctor/practice identity must resolve to exactly one profile; missing or duplicate matches need review.");
  const rows: PricedWork[] = [];
  for (const work of input.restorations) {
    const fixed = /^(crown(?: & bridge)?|bridge|pontic|veneer|inlay|onlay|implant)$/i.test(work.restorationType);
    const knownType = fixed || /^(removable(?: repair)?|appliance|orthodontic|alloy)$/i.test(work.restorationType);
    if (fixed && !work.material) exceptions.push("Fixed restoration material is unspecified.");
    if (!knownType) {
      const explicitService = await resolveRestorationPriceKey({
        labOrganizationId: RECOVERY_LAB_ID, restorationType: work.restorationType,
        restorationSubtype: work.restorationSubtype, material: null,
      });
      if (!explicitService) exceptions.push(`Unsupported service: ${work.restorationType}.`);
    }
    const hierarchy = normalizeCaseHierarchy({
      caseType: work.restorationType, material: work.material, subtype: work.restorationSubtype ?? undefined,
    });
    const subtype = work.restorationSubtype ?? hierarchy.restorationSubtype;
    const price = await resolveServerPriceWithSource({
      labOrganizationId: RECOVERY_LAB_ID, doctorName: caseRow.doctorName,
      providerOrganizationId: caseRow.providerOrganizationId,
    }, work.material, work.restorationType, subtype);
    if (!price || price.amount <= 0 || !Number.isFinite(price.amount)) {
      exceptions.push(`Missing supported catalog price: ${work.restorationType} / ${work.material ?? "unspecified"}.`);
    }
    if (isPfmOrFcmMaterial(work.material)) {
      exceptions.push("PFM/alloy child charge needs an independently verified catalog-supported amount.");
    }
    rows.push({ ...work, restorationSubtype: subtype, id: randomUUID(),
      unitPrice: (price?.amount ?? 0).toFixed(2), priceSource: price?.source ?? null,
      priceSourceId: price?.sourceId ?? null, priceSourceName: price?.sourceName ?? null,
      priceKey: price?.key ?? null });
  }
  const lines = buildBridgeAwareLineItems(rows, input.bridgeConnectors, false).map((line, index) => ({
    ...line, invoiceId: "", sortOrder: index,
  }));
  if (lines.some((line) => line.childItems?.some((child) => child.priced === false))) {
    exceptions.push("One or more child charges have no supported price.");
  }
  return { version: 1, caseFingerprint: recoveryFingerprint(caseRow), input, rows, lines, doctorIdentity: identity?.id ?? null,
    total: sumGroupedLineItemsTotal(lines), exceptions: [...new Set(exceptions)],
    pricingAt: new Date().toISOString(), pricingBasis: "current_catalog" };
}

async function noExistingBilling(caseId: string, executor: Pick<typeof db, "query"> = db) {
  const [bills, work] = await Promise.all([
    executor.query.invoices.findMany({ where: eq(invoices.caseId, caseId) }),
    executor.query.caseRestorations.findMany({ where: eq(caseRestorations.caseId, caseId) }),
  ]);
  if (bills.length || work.length) throw new HttpError(409,
    "Existing, deleted, voided or already reconstructed billing/work takes precedence. No replacement was created.");
}

async function assertProposalTarget(caseId: string, executor: Pick<typeof db, "query"> = db) {
  const bills = await executor.query.invoices.findMany({ where: eq(invoices.caseId, caseId) });
  const held = bills.length === 1 && bills[0]!.status === RECOVERY_DRAFT_STATUS &&
    bills[0]!.frozen && isRecoveryHeld(bills[0]!) && !bills[0]!.deletedAt
    ? bills[0]! : null;
  const metadata = held?.displayMetadataJson as { recoveryBilling?: { source?: string } } | null;
  if (held && metadata?.recoveryBilling?.source === RECOVERY_TAG) return held;
  await noExistingBilling(caseId, executor);
  return null;
}

/** Eligibility and current-catalog pricing shared by staging and the no-write preview. Reads only. */
async function quoteRecoveryWork<I extends PricingInput>(caseId: string, input: I, actorUserId: string) {
  await requireAnyRole(actorUserId, RECOVERY_LAB_ID, BILLING_ROLES);
  const row = await scopedCase(caseId);
  const held = await assertProposalTarget(caseId);
  const priorDecision = await db.query.caseEvents.findFirst({ where: and(
    eq(caseEvents.caseId, caseId), eq(caseEvents.eventType, "billing_recovery_do_not_bill"),
  ) });
  if (priorDecision) throw new HttpError(409, "This case was deliberately marked do not bill. Reconstruction will not revive it.");
  const attachment = await db.query.caseAttachments.findFirst({ where: and(
    eq(caseAttachments.id, input.evidenceAttachmentId), eq(caseAttachments.caseId, caseId),
    sql`${caseAttachments.deletedAt} IS NULL`,
  ) });
  const source = recoveryScope.get(caseId)!;
  if (!attachment || !source.prescriptions.some((file) => attachment.storageKey?.endsWith(file))) {
    throw new HttpError(400, "Select the verified prescription attached to this recovered case.");
  }
  return { held, attachment, proposal: await priceProposal(row, input) };
}

/**
 * What staging this work would price at right now. Runs the staging checks and
 * resolver but writes no event, work or invoice, and needs no review sign-off.
 */
export async function previewRecoveryBilling(caseId: string, input: PreviewInput, actorUserId: string) {
  const { proposal } = await quoteRecoveryWork(caseId, input, actorUserId);
  return {
    rows: proposal.rows, lines: proposal.lines, total: proposal.total, exceptions: proposal.exceptions,
    pricingAt: proposal.pricingAt, pricingBasis: proposal.pricingBasis, persisted: false as const,
  };
}

export async function proposeRecoveryBilling(caseId: string, input: ProposalInput, actorUserId: string) {
  const { held, attachment, proposal } = await quoteRecoveryWork(caseId, input, actorUserId);
  if (held) {
    proposal.previousInvoiceId = held.id;
    proposal.previousInvoiceFingerprint = recoveryFingerprint(held);
    proposal.previousLinesFingerprint = recoveryFingerprint(await invoiceLines(held.id));
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${caseId}))`);
    await tx.select().from(cases).where(eq(cases.id, caseId)).for("update");
    const current = await scopedCase(caseId, tx);
    const currentInvoice = await assertProposalTarget(caseId, tx);
    if (recoveryFingerprint(current) !== proposal.caseFingerprint ||
        recoveryFingerprint(currentInvoice) !== recoveryFingerprint(held)) {
      throw new HttpError(409, "Case or billing changed while quoting; no proposal saved.");
    }
    const excluded = await tx.query.caseEvents.findFirst({ where: and(
      eq(caseEvents.caseId, caseId), eq(caseEvents.eventType, "billing_recovery_do_not_bill"),
    ) });
    if (excluded) throw new HttpError(409, "Case was marked do not bill while quoting.");
    const [event] = await tx.insert(caseEvents).values({
      caseId, eventType: "billing_recovery_proposed", actorUserId, actorOrganizationId: RECOVERY_LAB_ID,
      metadataJson: { proposal, evidenceAttachmentId: attachment.id, historicalPayments: "unknown" },
    }).returning();
    return { proposalId: event!.id, proposal };
  });
}

async function invoiceLines(invoiceId: string, executor: Pick<typeof db, "query"> = db) {
  const rows = await executor.query.invoiceLineItems.findMany({ where: eq(invoiceLineItems.invoiceId, invoiceId) });
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

async function assertNoSettlements(invoiceId: string, executor: Pick<typeof db, "query">) {
  const [payment, bankLink] = await Promise.all([
    executor.query.payments.findFirst({ where: eq(payments.invoiceId, invoiceId) }),
    executor.query.bankTransactionInvoices.findFirst({ where: eq(bankTransactionInvoices.invoiceId, invoiceId) }),
  ]);
  if (payment || bankLink) throw new HttpError(409, "Settlement evidence exists; reconcile it without changing this draft.");
}

export async function doNotBillRecoveryCase(caseId: string, reason: string, actorUserId: string) {
  reason = z.string().trim().min(1).max(4000).parse(reason);
  await requireAnyRole(actorUserId, RECOVERY_LAB_ID, BILLING_ROLES);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${caseId}))`);
    await tx.select().from(cases).where(eq(cases.id, caseId)).for("update");
    await scopedCase(caseId, tx);
    const held = await assertProposalTarget(caseId, tx);
    if (held) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${RECOVERY_LAB_ID}), hashtext(${held.providerOrganizationId ?? ""}))`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${held.id}))`);
      const [locked] = await tx.select().from(invoices).where(eq(invoices.id, held.id)).for("update");
      if (!locked || !isRecoveryHeld(locked)) throw new HttpError(409, "Draft changed; no decision saved.");
      await assertNoSettlements(held.id, tx);
      const metadata = locked.displayMetadataJson as Record<string, unknown>;
      await tx.update(invoices).set({
        status: "void", frozen: true, balanceDue: "0.00", voidedAt: new Date(),
        voidedByUserId: actorUserId, voidReason: reason, updatedByUserId: actorUserId,
        displayMetadataJson: { ...metadata, recoveryBilling: {
          ...(metadata.recoveryBilling as Record<string, unknown>), state: "not_billed", reason,
        } },
      }).where(eq(invoices.id, held.id));
    }
    const [event] = await tx.insert(caseEvents).values({
      caseId, eventType: "billing_recovery_do_not_bill", actorUserId,
      actorOrganizationId: RECOVERY_LAB_ID, metadataJson: { reason, invoiceId: held?.id ?? null },
    }).returning();
    return { decisionId: event!.id };
  });
}

/**
 * Per-case transaction boundary; a crashed batch can resume from the next case.
 * Every mode keeps the exact-latest-proposal, exception, case, pricing,
 * competing-billing, locking and replay checks; only `operator` (the batch
 * command) additionally requires the rehearsed run approval.
 */
export async function applyRecoveryProposal(caseId: string, proposalId: string, actorUserId: string, mode: RecoveryApplyMode = "operator") {
  await requireAnyRole(actorUserId, RECOVERY_LAB_ID, mode === "correction" ? BILLING_ROLES : ADMIN_ROLES);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${caseId}))`);
    const [caseRow] = await tx.select().from(cases).where(eq(cases.id, caseId)).for("update");
    const verified = await scopedCase(caseId, tx);
    if (!caseRow || !verified.providerOrganizationId) throw new HttpError(409, "Missing practice.");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${RECOVERY_LAB_ID}), hashtext(${verified.providerOrganizationId}))`);
    const existing = await tx.query.invoices.findMany({ where: eq(invoices.caseId, caseId) });
    const same = existing.find((invoice) => {
      const meta = invoice.displayMetadataJson as { recoveryBilling?: { proposalId?: string } } | null;
      return meta?.recoveryBilling?.proposalId === proposalId;
    });
    if (same) return { invoiceId: same.id, total: same.total, outcome: "already_applied" };
    const latest = await tx.query.caseEvents.findFirst({ where: and(
      eq(caseEvents.caseId, caseId), inArray(caseEvents.eventType, [
        "billing_recovery_proposed", "billing_recovery_do_not_bill", "billing_recovery_held", "billing_recovery_released",
      ]),
    ), orderBy: [desc(caseEvents.createdAt), desc(caseEvents.id)] });
    if (latest?.id !== proposalId || latest.eventType !== "billing_recovery_proposed") {
      throw new HttpError(409, "Proposal was superseded or this case was marked do not bill.");
    }
    const proposal = (latest.metadataJson as { proposal: Proposal }).proposal;
    const run = mode === "operator" ? await requireApprovedRecoveryRun(caseId, proposalId, recoveryFingerprint(proposal), tx) : null;
    const correcting = await assertProposalTarget(caseId, tx);
    if (mode === "correction" && !correcting) throw new HttpError(409, "Billing staff can correct only an existing held replacement.");
    if (mode === "page" && correcting) {
      throw new HttpError(409, "This case already has a held replacement. Use Apply held correction to replace it; nothing was applied.");
    }
    if (correcting) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${correcting.id}))`);
      const [locked] = await tx.select().from(invoices).where(eq(invoices.id, correcting.id)).for("update");
      if (!locked || !isRecoveryHeld(locked) || locked.deletedAt ||
          proposal.previousInvoiceId !== locked.id ||
          proposal.previousInvoiceFingerprint !== recoveryFingerprint(locked) ||
          proposal.previousLinesFingerprint !== recoveryFingerprint(await invoiceLines(locked.id, tx))) {
        throw new HttpError(409, "Held draft changed since review; corrections were not applied.");
      }
      const meta = locked.displayMetadataJson as { recoveryBilling: { pricingSnapshot: PricedWork[] } };
      const stored = await tx.query.caseRestorations.findMany({ where: eq(caseRestorations.caseId, caseId) });
      const snapshot = meta.recoveryBilling.pricingSnapshot;
      const clinicalPriceState = (work: RecoveryWork & { id: string; unitPrice: string }) => ({
        id: work.id, toothNumber: work.toothNumber, restorationType: work.restorationType,
        restorationSubtype: work.restorationSubtype, arch: work.arch, material: work.material,
        shade: work.shade, quantity: work.quantity, unitPrice: work.unitPrice,
      });
      const normalized = (rows: Array<RecoveryWork & { id: string; unitPrice: string }>) =>
        rows.map(clinicalPriceState).sort((a, b) => a.id.localeCompare(b.id));
      if (!snapshot || recoveryFingerprint(normalized(stored as PricedWork[])) !== recoveryFingerprint(normalized(snapshot))) {
        throw new HttpError(409, "Staff changed restoration work after reconstruction; preserve it and reconcile manually.");
      }
      await assertNoSettlements(locked.id, tx);
    }
    if (proposal.exceptions.length) throw new HttpError(409, "Resolve all proposal exceptions before application.");
    if (proposal.caseFingerprint !== recoveryFingerprint(verified)) throw new HttpError(409, "Case changed since staging; review a fresh proposal.");
    // Lock source pricing against concurrent edits before resolving the snapshot
    // again. The normal resolver remains the sole authority for dollar amounts.
    await tx.execute(sql`LOCK TABLE organizations, doctor_profiles, pricing_tiers, pricing_overrides, organization_connections, lab_item_labels IN SHARE MODE`);
    const current = await priceProposal(verified, proposal.input);
    const priceState = (priced: Proposal) => ({
      doctorIdentity: priced.doctorIdentity,
      rows: priced.rows.map(({ id: _id, ...row }) => row),
    });
    if (current.exceptions.length || recoveryFingerprint(priceState(current)) !== recoveryFingerprint(priceState(proposal))) {
      throw new HttpError(409, "Current pricing or identity changed; stage and review again.");
    }
    const canonicalLines = buildBridgeAwareLineItems(proposal.rows, proposal.input.bridgeConnectors, false)
      .map((line, sortOrder) => ({ ...line, invoiceId: "", sortOrder }));
    if (sumGroupedLineItemsTotal(canonicalLines) !== proposal.total) {
      throw new HttpError(409, "Proposal total does not match canonical saved work; no billing written.");
    }
    const invoiceId = correcting?.id ?? randomUUID();
    const invoiceNumber = `REC-${verified.caseNumber}`;
    const collision = await tx.query.invoices.findFirst({ where: and(
      eq(invoices.labOrganizationId, RECOVERY_LAB_ID), eq(invoices.invoiceNumber, invoiceNumber),
    ) });
    if (collision && collision.id !== invoiceId) throw new HttpError(409, "Recovery invoice-number collision; no changes applied.");
    if (correcting) {
      const oldMetadata = correcting.displayMetadataJson as { recoveryBilling: { pricingSnapshot: PricedWork[] } };
      await tx.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId));
      const ids = oldMetadata.recoveryBilling.pricingSnapshot.map((work) => work.id);
      if (ids.length) await tx.delete(caseRestorations).where(and(eq(caseRestorations.caseId, caseId), inArray(caseRestorations.id, ids)));
    }
    await tx.insert(caseRestorations).values(proposal.rows.map(({ id, ...work }) => ({
      ...work, id, caseId, notes: `Current-rate reconstruction; proposal ${proposalId}`,
    })));
    const priorRecovery = (correcting?.displayMetadataJson as {
      recoveryBilling?: {
        runPlanSha256?: string; runCutoff?: string; backupSha256?: string; rehearsalSha256?: string;
        appliedVia?: string; appliedBy?: string; appliedAt?: string;
      };
    } | null)?.recoveryBilling;
    // A correction replaces the draft's charges but keeps who first applied it, and how.
    const appliedVia = mode === "page" ? "page" : mode === "operator" ? "operator_run" : "held_correction";
    const application = correcting
      ? { appliedVia: priorRecovery?.appliedVia ?? null, appliedBy: priorRecovery?.appliedBy ?? null, appliedAt: priorRecovery?.appliedAt ?? null }
      : { appliedVia, appliedBy: actorUserId, appliedAt: new Date().toISOString() };
    const values = {
      id: invoiceId, invoiceNumber, caseId, labOrganizationId: RECOVERY_LAB_ID,
      providerOrganizationId: verified.providerOrganizationId, createdByUserId: actorUserId,
      doctorIdentity: proposal.doctorIdentity,
      status: RECOVERY_DRAFT_STATUS, frozen: true, subtotal: proposal.total, total: proposal.total,
      balanceDue: "0.00", issuedAt: null, dueAt: null,
      aiGenerated: true, aiPricingWarning: "Replacement priced at current rates. Original amounts and historical payments are unknown. Not collectible.",
      notes: "Reconstructed replacement — not a restored original invoice. Held for charge and historical-payment review.",
      displayMetadataJson: {
        reviewedCharges: true,
        recoveryBilling: { state: "held", source: RECOVERY_TAG, proposalId,
          pricingBasis: "current_catalog", pricingAt: proposal.pricingAt,
          historicalPayments: "unknown", evidenceAttachmentId: proposal.input.evidenceAttachmentId,
          timezone: RECOVERY_TIMEZONE, executionCutoff: new Date().toISOString(),
          runPlanSha256: run?.planSha256 ?? priorRecovery?.runPlanSha256 ?? null,
          runCutoff: run?.cutoff ?? priorRecovery?.runCutoff ?? null,
          backupSha256: run?.backupSha256 ?? priorRecovery?.backupSha256 ?? null,
          rehearsalSha256: run?.rehearsalSha256 ?? priorRecovery?.rehearsalSha256 ?? null,
          ...application,
          pricingSnapshot: proposal.rows, chargeReviewNotes: proposal.input.reviewNotes },
        recoveryCaseFingerprint: proposal.caseFingerprint,
      },
    };
    if (correcting) {
      await tx.update(invoices).set({
        ...values, createdByUserId: correcting.createdByUserId, updatedByUserId: actorUserId,
      }).where(eq(invoices.id, invoiceId));
    } else {
      await tx.insert(invoices).values(values);
    }
    await insertGroupedLineItemsWithChildren(tx, canonicalLines.map((line) => ({ ...line, invoiceId })));
    const savedLines = await invoiceLines(invoiceId, tx);
    await tx.update(invoices).set({
      displayMetadataJson: { ...values.displayMetadataJson,
        recoveryLinesFingerprint: recoveryFingerprint(savedLines) },
    }).where(eq(invoices.id, invoiceId));
    await tx.insert(caseEvents).values({
      caseId, eventType: "billing_recovery_held", actorUserId, actorOrganizationId: RECOVERY_LAB_ID,
      metadataJson: { invoiceId, proposalId, total: proposal.total, historicalPayments: "unknown",
        appliedVia, appliedBy: actorUserId },
    });
    return { invoiceId, total: proposal.total, outcome: "created_held" };
  });
}

export async function releaseRecoveryInvoice(caseId: string, actorUserId: string, input: {
  chargesReviewed: true; historicalPaymentsReviewed: true;
  historicalSettlement: "independent_evidence_of_no_payment"; evidenceNotes: string;
}) {
  input = z.object({
    chargesReviewed: z.literal(true), historicalPaymentsReviewed: z.literal(true),
    historicalSettlement: z.literal("independent_evidence_of_no_payment"),
    evidenceNotes: z.string().trim().min(20).max(4000),
  }).strict().parse(input);
  await requireAnyRole(actorUserId, RECOVERY_LAB_ID, ADMIN_ROLES);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${caseId}))`);
    await tx.select().from(cases).where(eq(cases.id, caseId)).for("update");
    const row = await scopedCase(caseId, tx);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${RECOVERY_LAB_ID}), hashtext(${row.providerOrganizationId ?? ""}))`);
    const bills = await tx.query.invoices.findMany({ where: eq(invoices.caseId, caseId) });
    const held = bills.find((invoice) => invoice.status === RECOVERY_DRAFT_STATUS && invoice.frozen && isRecoveryHeld(invoice));
    if (!held || bills.length !== 1) throw new HttpError(409, "There must be exactly one held replacement and no recovered original bill.");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${held.id}))`);
    const [locked] = await tx.select().from(invoices).where(eq(invoices.id, held.id)).for("update");
    if (!locked || !isRecoveryHeld(locked) || locked.deletedAt) throw new HttpError(409, "Draft changed or was removed.");
    const [recordedPayments, bankLinks] = await Promise.all([
      tx.query.payments.findMany({ where: eq(payments.invoiceId, locked.id) }),
      tx.query.bankTransactionInvoices.findMany({ where: eq(bankTransactionInvoices.invoiceId, locked.id) }),
    ]);
    if (recordedPayments.length || bankLinks.length) throw new HttpError(409, "Settlement evidence exists; release is blocked pending reconciliation.");
    const meta = locked.displayMetadataJson as Record<string, unknown>;
    if (meta.recoveryCaseFingerprint !== recoveryFingerprint(row)) {
      throw new HttpError(409, "Case changed after charge review; review a fresh correction before release.");
    }
    const recovery = meta.recoveryBilling as Record<string, unknown>;
    if (recovery.source !== RECOVERY_TAG ||
        meta.recoveryLinesFingerprint !== recoveryFingerprint(await invoiceLines(locked.id, tx))) {
      throw new HttpError(409, "Saved charges changed or draft provenance is unverified; do not release.");
    }
    const work = await tx.query.caseRestorations.findMany({ where: eq(caseRestorations.caseId, caseId) });
    const snapshot = recovery.pricingSnapshot as PricedWork[];
    const pricedState = (rows: Array<RecoveryWork & { id: string; unitPrice: string }>) =>
      rows.map(({ id, toothNumber, restorationType, restorationSubtype, arch, material, shade, quantity, unitPrice }) =>
        ({ id, toothNumber, restorationType, restorationSubtype, arch, material, shade, quantity, unitPrice }))
        .sort((a, b) => a.id.localeCompare(b.id));
    if (!snapshot || recoveryFingerprint(pricedState(work as PricedWork[])) !== recoveryFingerprint(pricedState(snapshot))) {
      throw new HttpError(409, "Restoration work changed after review; reconcile it before release.");
    }
    // Released replacements are issued now (never backdated) and follow the
    // lab's normal due-date rule so they age like every other open invoice.
    const lab = await tx.query.organizations.findFirst({
      where: eq(organizations.id, RECOVERY_LAB_ID), columns: { invoiceDueDayOfMonth: true },
    });
    const releasedAt = new Date();
    await tx.update(invoices).set({
      status: "open", frozen: false, balanceDue: locked.total, issuedAt: releasedAt,
      dueAt: invoiceDueDate(releasedAt, lab?.invoiceDueDayOfMonth),
      aiReviewedAt: releasedAt, aiReviewedByUserId: actorUserId, updatedByUserId: actorUserId,
      displayMetadataJson: { ...meta, reviewedCharges: true, recoveryBilling: {
        ...recovery, state: "released", releasedBy: actorUserId, releasedAt: releasedAt.toISOString(),
        historicalPayments: input.historicalSettlement, settlementReviewNotes: input.evidenceNotes,
      } },
    }).where(eq(invoices.id, locked.id));
    await tx.insert(caseEvents).values({
      caseId, eventType: "billing_recovery_released", actorUserId, actorOrganizationId: RECOVERY_LAB_ID,
      metadataJson: { invoiceId: locked.id, ...input },
    });
    return { invoiceId: locked.id, total: locked.total, outcome: "released" };
  });
}
