import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import express from "express";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";
import { HttpError } from "./http";

const fixture = vi.hoisted(() => ({
  lab: crypto.randomUUID(), practice: crypto.randomUUID(), owner: crypto.randomUUID(), staff: crypto.randomUUID(),
  scope: new Map<string, { inWindow: boolean; caseNumber: string; historicalDate: string; flagged: boolean; prescriptions: string[] }>(),
}));
vi.mock("./recovery-billing-scope", () => ({
  RECOVERY_LAB_ID: fixture.lab, RECOVERY_TAG: "recovery-test-fixture",
  RECOVERY_TIMEZONE: "UTC", RECOVERY_START: "2026-01-01", RECOVERY_END: "2026-01-31",
  RECOVERY_SAFEGUARD_VERSION: "recovery-safeguards-test-v1",
  recoveryScope: fixture.scope,
  recoveryDataAvailable: true,
  assertRecoveryDataAvailable: vi.fn(),
}));
vi.mock("./rbac", async (original) => {
  const actual = await original<typeof import("./rbac")>();
  return { ...actual, requireAnyRole: vi.fn(async (user: string, lab: string, roles: string[]) => {
    const role = user === fixture.owner ? "admin" : user === fixture.staff ? "billing" : "none";
    if (lab !== fixture.lab || !roles.includes(role)) throw new HttpError(403, "Fixture role denied.");
  }) };
});
// Route checks sign in as whichever fixture user the request names.
vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { auth: { userId: string } }).auth = { userId: String(req.headers["x-fixture-user"] ?? "") };
    next();
  },
  requireVerifiedAccount: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import {
  db, users, organizations, cases, caseAttachments, caseRestorations, caseEvents,
  doctorProfiles, pricingTiers, invoices, invoiceLineItems, systemSettings,
} from "@workspace/db";
import { applyRecoveryProposal, proposeRecoveryBilling, recoveryProposalSchema, releaseRecoveryInvoice,
  doNotBillRecoveryCase, listRecoveryBilling, recoveryFingerprint, previewRecoveryBilling,
  recoveryPreviewSchema } from "./recovery-billing";
import { RECOVERY_RUN_KEY, recoveryDatabaseIdentity, RECOVERY_SAFEGUARD_VERSION } from "./recovery-billing-run";
import { finalizedInvoiceSql } from "./recovery-billing-hold";
import { materialToPriceKey } from "./material-mapping";
import { syncInvoiceFromRestorations } from "./invoice-sync";
import { invoiceDueDate } from "./invoice-due-date";
import { cleanupPaymentFixtures } from "../test-utils/payment-cleanup";
import router from "../routes/recovery-billing";

const app = express().use(express.json()).use("/billing-recovery", router);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(error instanceof HttpError ? error.statusCode : 500)
    .json({ message: error instanceof HttpError ? error.message : "Unexpected error" });
});

const maybe = process.env.DATABASE_URL ? describe : describe.skip;
maybe("recovery billing isolated tenant fixtures", () => {
  const caseIds: string[] = [];
  const tier = randomUUID();
  const priceKey = materialToPriceKey("Zirconia", "Crown & Bridge")!;
  const input = (attachmentId: string) => recoveryProposalSchema.parse({
    evidenceAttachmentId: attachmentId, prescriptionReviewed: true, identityReviewed: true, duplicateReviewed: true,
    reviewNotes: "Fixture prescription, practice identity and duplicate search explicitly reviewed.",
    restorations: [{ toothNumber: "8", restorationType: "Crown & Bridge", material: "Zirconia", quantity: 1 }],
  });
  const preview = (attachmentId: string) => recoveryPreviewSchema.parse({
    evidenceAttachmentId: attachmentId, restorations: input(attachmentId).restorations,
  });
  const release = { chargesReviewed: true, historicalPaymentsReviewed: true,
    historicalSettlement: "independent_evidence_of_no_payment",
    evidenceNotes: "Fixture independent original-account reconciliation confirms no prior settlement." } as const;
  // The operator batch approval must play no part in single-case page application.
  const revokeRunApproval = () => db.delete(systemSettings).where(eq(systemSettings.key, RECOVERY_RUN_KEY));
  const caseWrites = async (caseId: string) => ({
    events: (await db.query.caseEvents.findMany({ where: eq(caseEvents.caseId, caseId) })).length,
    invoices: (await db.query.invoices.findMany({ where: eq(invoices.caseId, caseId) })).length,
    work: (await db.query.caseRestorations.findMany({ where: eq(caseRestorations.caseId, caseId) })).length,
  });

  beforeAll(async () => {
    await db.insert(users).values([
      { id: fixture.owner, username: `recovery_${fixture.owner}`, password: "fixture-only" },
      { id: fixture.staff, username: `recovery_${fixture.staff}`, password: "fixture-only" },
    ]);
    await db.insert(organizations).values([
      { id: fixture.lab, type: "lab", name: "Isolated recovery fixture" },
      { id: fixture.practice, type: "provider", name: "Isolated recovery practice", parentLabOrganizationId: fixture.lab },
    ]);
    await db.insert(doctorProfiles).values({
      id: randomUUID(), labOrganizationId: fixture.lab, providerOrganizationId: fixture.practice, doctorName: "Recovery Fixture Doctor",
    });
    await db.insert(pricingTiers).values({ id: tier, labOrganizationId: fixture.lab, name: "Fixture current catalog", pricesJson: { [priceKey]: 100 } });
  });
  afterAll(async () => {
    await cleanupPaymentFixtures({ organizationIds: [fixture.lab, fixture.practice], userIds: [fixture.owner, fixture.staff] });
    const bills = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.labOrganizationId, fixture.lab));
    if (bills.length) await db.delete(invoiceLineItems).where(inArray(invoiceLineItems.invoiceId, bills.map((bill) => bill.id)));
    await db.delete(invoices).where(eq(invoices.labOrganizationId, fixture.lab));
    if (caseIds.length) await db.delete(cases).where(inArray(cases.id, caseIds));
    await db.delete(systemSettings).where(eq(systemSettings.key, RECOVERY_RUN_KEY));
    await db.delete(pricingTiers).where(eq(pricingTiers.id, tier));
    await db.delete(doctorProfiles).where(eq(doctorProfiles.labOrganizationId, fixture.lab));
    await db.delete(organizations).where(eq(organizations.id, fixture.practice));
    await db.delete(organizations).where(eq(organizations.id, fixture.lab));
    await db.delete(users).where(inArray(users.id, [fixture.owner, fixture.staff]));
  });
  async function newCase(notes: string | null = null) {
    const caseId = randomUUID(), attachmentId = randomUUID(), caseNumber = `fixture-${caseIds.length}`;
    fixture.scope.set(caseId, { inWindow: true, caseNumber, historicalDate: "2026-01-02", flagged: false, prescriptions: ["fixture-rx.pdf"] });
    caseIds.push(caseId);
    await db.insert(cases).values({
      id: caseId, caseNumber, labOrganizationId: fixture.lab, providerOrganizationId: fixture.practice,
      createdByUserId: fixture.owner, patientFirstName: "Fixture", patientLastName: "Only",
      doctorName: "Recovery Fixture Doctor", aiImportSource: "recovery-test-fixture", rxNotes: notes,
    });
    await db.insert(caseAttachments).values({ id: attachmentId, caseId, uploadedByUserId: fixture.owner,
      uploadedByOrganizationId: fixture.lab,
      fileName: "fixture-rx.pdf", fileType: "application/pdf", storageKey: "/case-media/fixture-rx.pdf" });
    return { caseId, attachmentId };
  }
  async function quoteAndApprove(record: Awaited<ReturnType<typeof newCase>>, work = input(record.attachmentId)) {
    const quoted = await proposeRecoveryBilling(record.caseId, work, fixture.staff);
    const now = new Date().toISOString();
    const approval = {
      version: RECOVERY_SAFEGUARD_VERSION, labOrganizationId: fixture.lab, timezone: "UTC",
      cutoff: now, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      backupTakenAt: now, backupSha256: "a".repeat(64), rehearsalSha256: "b".repeat(64),
      databaseFingerprint: await recoveryDatabaseIdentity(), sourceRecoveryCheckedAt: now,
      proposals: { [record.caseId]: quoted.proposalId },
      proposalFingerprints: { [record.caseId]: recoveryFingerprint(quoted.proposal) },
      planSha256: "c".repeat(64), targetMode: "production", approvalNonce: randomUUID(),
    };
    await db.insert(systemSettings).values({ key: RECOVERY_RUN_KEY, value: JSON.stringify(approval) })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: JSON.stringify(approval) } });
    return quoted;
  }
  it("fails closed without authorization, leaving no work or invoice", async () => {
    const record = await newCase();
    const quoted = await proposeRecoveryBilling(record.caseId, input(record.attachmentId), fixture.staff);
    await expect(applyRecoveryProposal(record.caseId, quoted.proposalId!, fixture.owner)).rejects.toThrow(/disabled/);
    expect(await db.query.caseRestorations.findMany({ where: eq(caseRestorations.caseId, record.caseId) })).toHaveLength(0);
    expect(await db.query.invoices.findMany({ where: eq(invoices.caseId, record.caseId) })).toHaveLength(0);
  });
  it("atomically saves rates and totals, serializes concurrent reruns and excludes held sales", async () => {
    const record = await newCase(), quoted = await quoteAndApprove(record);
    const [first, second] = await Promise.all([
      applyRecoveryProposal(record.caseId, quoted.proposalId!, fixture.owner),
      applyRecoveryProposal(record.caseId, quoted.proposalId!, fixture.owner),
    ]);
    expect(first.invoiceId).toBe(second.invoiceId);
    expect([first.outcome, second.outcome].sort()).toEqual(["already_applied", "created_held"]);
    const bill = await db.query.invoices.findFirst({ where: eq(invoices.id, first.invoiceId) });
    expect(bill).toMatchObject({ status: "recovery_draft", frozen: true, total: "100.00", balanceDue: "0.00", issuedAt: null });
    expect(await db.select().from(invoices).where(eq(invoices.id, first.invoiceId))).toHaveLength(1);
    expect(await db.select().from(invoices).where(sqlAnd(first.invoiceId))).toHaveLength(0);
    await syncInvoiceFromRestorations({ caseId: record.caseId, actorUserId: fixture.owner });
    expect((await db.query.invoices.findFirst({ where: eq(invoices.id, first.invoiceId) }))?.total).toBe("100.00");
    await expect(releaseRecoveryInvoice(record.caseId, fixture.staff, release)).rejects.toThrow(/role denied/);
    await expect(releaseRecoveryInvoice(record.caseId, fixture.owner, { ...release, chargesReviewed: false } as never)).rejects.toThrow();
    await releaseRecoveryInvoice(record.caseId, fixture.owner, release);
    expect((await db.query.invoices.findFirst({ where: eq(invoices.id, first.invoiceId) }))?.balanceDue).toBe("100.00");
  });
  it("preserves existing zero-dollar, voided and deleted billing rather than regenerating", async () => {
    for (const status of ["open", "void", "deleted"]) {
      const record = await newCase();
      await db.insert(invoices).values({
        id: randomUUID(), invoiceNumber: `existing-${record.caseId}`, caseId: record.caseId,
        labOrganizationId: fixture.lab, providerOrganizationId: fixture.practice, createdByUserId: fixture.owner,
        status: status === "deleted" ? "open" : status, deletedAt: status === "deleted" ? new Date() : null,
      });
      await expect(proposeRecoveryBilling(record.caseId, input(record.attachmentId), fixture.staff)).rejects.toThrow(/takes precedence/);
      await expect(previewRecoveryBilling(record.caseId, preview(record.attachmentId), fixture.staff)).rejects.toThrow(/takes precedence/);
    }
    // An ordinary open bill is never presented as a released replacement.
    const ordinary = await newCase();
    await db.insert(invoices).values({
      id: randomUUID(), invoiceNumber: `existing-${ordinary.caseId}`, caseId: ordinary.caseId,
      labOrganizationId: fixture.lab, providerOrganizationId: fixture.practice, createdByUserId: fixture.owner,
      status: "open", total: "80.00", balanceDue: "80.00",
    });
    expect((await listRecoveryBilling()).find((row) => row.caseId === ordinary.caseId)?.state).toBe("existing_billing");
  });
  it("refuses stale case data, changed prices, foreign scope and remake intent", async () => {
    const record = await newCase(), quote = await quoteAndApprove(record);
    await db.update(cases).set({ patientLastName: "Staff correction" }).where(eq(cases.id, record.caseId));
    await expect(applyRecoveryProposal(record.caseId, quote.proposalId!, fixture.owner)).rejects.toThrow(/Case changed/);
    const rateRecord = await newCase(), rateQuote = await quoteAndApprove(rateRecord);
    await db.update(pricingTiers).set({ pricesJson: { [priceKey]: 120 } }).where(eq(pricingTiers.id, tier));
    await expect(applyRecoveryProposal(rateRecord.caseId, rateQuote.proposalId!, fixture.owner)).rejects.toThrow(/pricing or identity changed/);
    await db.update(pricingTiers).set({ pricesJson: { [priceKey]: 100 } }).where(eq(pricingTiers.id, tier));
    await expect(proposeRecoveryBilling(randomUUID(), input(record.attachmentId), fixture.staff)).rejects.toThrow(/outside/);
    const remake = await newCase("No-charge remake");
    const remakeQuote = await proposeRecoveryBilling(remake.caseId, input(remake.attachmentId), fixture.staff);
    expect(remakeQuote.proposal.exceptions).toContain("Remake/no-charge intent requires independent review; no automatic reconstruction.");
  });
  it("allows staff corrections only on held replacements and permanently honors do-not-bill", async () => {
    const record = await newCase(), quote = await quoteAndApprove(record);
    const saved = await applyRecoveryProposal(record.caseId, quote.proposalId!, fixture.owner);
    const changed = input(record.attachmentId);
    changed.restorations.push({ ...changed.restorations[0]!, toothNumber: "9" });
    const corrected = await proposeRecoveryBilling(record.caseId, changed, fixture.staff);
    await applyRecoveryProposal(record.caseId, corrected.proposalId!, fixture.staff, "correction");
    expect((await db.query.invoices.findFirst({ where: eq(invoices.id, saved.invoiceId) }))?.total).toBe("200.00");
    await doNotBillRecoveryCase(record.caseId, "Reviewed duplicate; preserve recovered case.", fixture.staff);
    expect(await db.query.cases.findFirst({ where: eq(cases.id, record.caseId) })).toBeDefined();
    expect((await db.query.invoices.findFirst({ where: eq(invoices.id, saved.invoiceId) }))?.status).toBe("void");
    await expect(proposeRecoveryBilling(record.caseId, changed, fixture.staff)).rejects.toThrow();
    expect((await listRecoveryBilling()).find((row) => row.caseId === record.caseId)?.state).toBe("do_not_bill");
  });
  it("does not choose a doctor arbitrarily if legacy profile matching returns duplicates", async () => {
    // Current storage enforces uniqueness; simulate only a legacy match result,
    // never remove that constraint or plant ambiguous records in the shared DB.
    const record = await newCase();
    const profile = (await db.query.doctorProfiles.findFirst({
      where: eq(doctorProfiles.labOrganizationId, fixture.lab),
    }))!;
    const matching = vi.spyOn(db.query.doctorProfiles, "findMany")
      .mockResolvedValueOnce([profile, { ...profile, id: randomUUID() }]);
    try {
      const quote = await proposeRecoveryBilling(record.caseId, input(record.attachmentId), fixture.staff);
      expect(quote.proposal.doctorIdentity).toBeNull();
      expect(quote.proposal.exceptions.some((reason) => reason.includes("duplicate matches"))).toBe(true);
      expect(await db.query.invoices.findMany({ where: eq(invoices.caseId, record.caseId) })).toHaveLength(0);
    } finally {
      matching.mockRestore();
    }
  });
  it("previews the price staging would save without writing anything", async () => {
    const record = await newCase();
    const before = await caseWrites(record.caseId);
    const priced = await previewRecoveryBilling(record.caseId, preview(record.attachmentId), fixture.staff);
    expect(priced).toMatchObject({ total: "100.00", exceptions: [], pricingBasis: "current_catalog", persisted: false });
    expect(priced.rows.map((row) => [row.restorationType, row.toothNumber, row.unitPrice])).toEqual([["Crown & Bridge", "8", "100.00"]]);
    expect(await caseWrites(record.caseId)).toEqual(before);
    await expect(previewRecoveryBilling(record.caseId, preview(record.attachmentId), randomUUID())).rejects.toThrow(/role denied/);
    const staged = await proposeRecoveryBilling(record.caseId, input(record.attachmentId), fixture.staff);
    const priceState = (rows: typeof priced.rows) => rows.map(({ id: _id, ...row }) => row);
    const lineState = (lines: typeof priced.lines) => lines.map(({ description, quantity, unitPrice, lineTotal }) =>
      ({ description, quantity, unitPrice, lineTotal }));
    expect(staged.proposal.total).toBe(priced.total);
    expect(priceState(staged.proposal.rows)).toEqual(priceState(priced.rows));
    expect(lineState(staged.proposal.lines)).toEqual(lineState(priced.lines));
    const remake = await newCase("No-charge remake");
    const blocked = await previewRecoveryBilling(remake.caseId, preview(remake.attachmentId), fixture.staff);
    expect(blocked.exceptions).toContain("Remake/no-charge intent requires independent review; no automatic reconstruction.");
    expect(await caseWrites(remake.caseId)).toEqual({ events: 0, invoices: 0, work: 0 });
  });
  it("applies one case from the page for owners/admins without the operator run approval", async () => {
    await revokeRunApproval();
    const record = await newCase();
    const quoted = await proposeRecoveryBilling(record.caseId, input(record.attachmentId), fixture.staff);
    await expect(applyRecoveryProposal(record.caseId, quoted.proposalId, fixture.staff, "page")).rejects.toThrow(/role denied/);
    // The operator batch path still refuses the very same proposal without its approval.
    await expect(applyRecoveryProposal(record.caseId, quoted.proposalId, fixture.owner)).rejects.toThrow(/disabled/);
    await expect(applyRecoveryProposal(record.caseId, quoted.proposalId, fixture.owner, "operator")).rejects.toThrow(/disabled/);
    expect(await caseWrites(record.caseId)).toMatchObject({ invoices: 0, work: 0 });
    const [first, second] = await Promise.all([
      applyRecoveryProposal(record.caseId, quoted.proposalId, fixture.owner, "page"),
      applyRecoveryProposal(record.caseId, quoted.proposalId, fixture.owner, "page"),
    ]);
    expect(second.invoiceId).toBe(first.invoiceId);
    expect([first.outcome, second.outcome].sort()).toEqual(["already_applied", "created_held"]);
    const bill = await db.query.invoices.findFirst({ where: eq(invoices.id, first.invoiceId) });
    expect(bill).toMatchObject({ status: "recovery_draft", frozen: true, total: "100.00", balanceDue: "0.00", issuedAt: null, dueAt: null });
    expect((bill!.displayMetadataJson as { recoveryBilling: Record<string, unknown> }).recoveryBilling).toMatchObject({
      state: "held", proposalId: quoted.proposalId, appliedVia: "page", appliedBy: fixture.owner,
      historicalPayments: "unknown", runPlanSha256: null, backupSha256: null, rehearsalSha256: null,
    });
    const held = await db.query.caseEvents.findFirst({ where: and(
      eq(caseEvents.caseId, record.caseId), eq(caseEvents.eventType, "billing_recovery_held"),
    ) });
    expect(held?.actorUserId).toBe(fixture.owner);
    expect(held?.metadataJson).toMatchObject({ invoiceId: first.invoiceId, proposalId: quoted.proposalId, appliedVia: "page", appliedBy: fixture.owner });
    expect(await db.select().from(invoices).where(sqlAnd(first.invoiceId))).toHaveLength(0);
    expect(await applyRecoveryProposal(record.caseId, quoted.proposalId, fixture.owner, "page"))
      .toEqual({ invoiceId: first.invoiceId, total: "100.00", outcome: "already_applied" });
    expect(await caseWrites(record.caseId)).toMatchObject({ invoices: 1, work: 1 });
    expect((await listRecoveryBilling()).find((row) => row.caseId === record.caseId))
      .toMatchObject({ state: "held", invoice: { id: first.invoiceId, total: "100.00", balanceDue: "0.00", dueAt: null } });
    // A later staged correction goes through the held-correction path, never a second page apply.
    const changed = input(record.attachmentId);
    changed.restorations.push({ ...changed.restorations[0]!, toothNumber: "9" });
    const correction = await proposeRecoveryBilling(record.caseId, changed, fixture.staff);
    await expect(applyRecoveryProposal(record.caseId, correction.proposalId, fixture.owner, "page")).rejects.toThrow(/already has a held replacement/);
    expect((await db.query.invoices.findFirst({ where: eq(invoices.id, first.invoiceId) }))?.total).toBe("100.00");
  });
  it("keeps every other safeguard on page application", async () => {
    await revokeRunApproval();
    const remake = await newCase("No-charge remake");
    const remakeQuote = await proposeRecoveryBilling(remake.caseId, input(remake.attachmentId), fixture.staff);
    await expect(applyRecoveryProposal(remake.caseId, remakeQuote.proposalId, fixture.owner, "page")).rejects.toThrow(/Resolve all proposal exceptions/);
    const edited = await newCase();
    const editedQuote = await proposeRecoveryBilling(edited.caseId, input(edited.attachmentId), fixture.staff);
    await db.update(cases).set({ patientLastName: "Staff correction" }).where(eq(cases.id, edited.caseId));
    await expect(applyRecoveryProposal(edited.caseId, editedQuote.proposalId, fixture.owner, "page")).rejects.toThrow(/Case changed/);
    const repriced = await newCase();
    const repricedQuote = await proposeRecoveryBilling(repriced.caseId, input(repriced.attachmentId), fixture.staff);
    await db.update(pricingTiers).set({ pricesJson: { [priceKey]: 120 } }).where(eq(pricingTiers.id, tier));
    try {
      await expect(applyRecoveryProposal(repriced.caseId, repricedQuote.proposalId, fixture.owner, "page")).rejects.toThrow(/pricing or identity changed/);
    } finally {
      await db.update(pricingTiers).set({ pricesJson: { [priceKey]: 100 } }).where(eq(pricingTiers.id, tier));
    }
    const restaged = await newCase();
    const stale = await proposeRecoveryBilling(restaged.caseId, input(restaged.attachmentId), fixture.staff);
    await proposeRecoveryBilling(restaged.caseId, input(restaged.attachmentId), fixture.staff);
    await expect(applyRecoveryProposal(restaged.caseId, stale.proposalId, fixture.owner, "page")).rejects.toThrow(/superseded/);
    const billed = await newCase();
    const billedQuote = await proposeRecoveryBilling(billed.caseId, input(billed.attachmentId), fixture.staff);
    await db.insert(invoices).values({
      id: randomUUID(), invoiceNumber: `existing-${billed.caseId}`, caseId: billed.caseId,
      labOrganizationId: fixture.lab, providerOrganizationId: fixture.practice, createdByUserId: fixture.owner, status: "open",
    });
    await expect(applyRecoveryProposal(billed.caseId, billedQuote.proposalId, fixture.owner, "page")).rejects.toThrow(/takes precedence/);
    for (const record of [remake, edited, repriced, restaged]) {
      expect(await caseWrites(record.caseId)).toMatchObject({ invoices: 0, work: 0 });
    }
    expect(await caseWrites(billed.caseId)).toMatchObject({ invoices: 1, work: 0 });
  });
  it("puts a released replacement on the customer's balance, due by the lab's normal rule", async () => {
    await revokeRunApproval();
    await db.update(organizations).set({ invoiceDueDayOfMonth: 15 }).where(eq(organizations.id, fixture.lab));
    try {
      const record = await newCase();
      const quoted = await proposeRecoveryBilling(record.caseId, input(record.attachmentId), fixture.staff);
      const applied = await applyRecoveryProposal(record.caseId, quoted.proposalId, fixture.owner, "page");
      await expect(releaseRecoveryInvoice(record.caseId, fixture.staff, release)).rejects.toThrow(/role denied/);
      expect(await releaseRecoveryInvoice(record.caseId, fixture.owner, release))
        .toEqual({ invoiceId: applied.invoiceId, total: "100.00", outcome: "released" });
      const bill = (await db.query.invoices.findFirst({ where: eq(invoices.id, applied.invoiceId) }))!;
      expect(bill).toMatchObject({ status: "open", frozen: false, total: "100.00", balanceDue: "100.00" });
      expect(bill.issuedAt).toBeInstanceOf(Date);
      expect(bill.dueAt?.toISOString()).toBe(invoiceDueDate(bill.issuedAt!, 15).toISOString());
      expect((bill.displayMetadataJson as { recoveryBilling: Record<string, unknown> }).recoveryBilling).toMatchObject({
        state: "released", appliedVia: "page", appliedBy: fixture.owner, releasedBy: fixture.owner,
        historicalPayments: "independent_evidence_of_no_payment",
      });
      expect(await db.select().from(invoices).where(sqlAnd(applied.invoiceId))).toHaveLength(1);
      const listed = (await listRecoveryBilling()).find((row) => row.caseId === record.caseId);
      expect(listed).toMatchObject({ state: "released",
        invoice: { id: applied.invoiceId, status: "open", total: "100.00", balanceDue: "100.00" } });
      expect(listed?.invoice?.dueAt?.toISOString()).toBe(bill.dueAt?.toISOString());
      expect(await applyRecoveryProposal(record.caseId, quoted.proposalId, fixture.owner, "page"))
        .toMatchObject({ invoiceId: applied.invoiceId, outcome: "already_applied" });
      await expect(releaseRecoveryInvoice(record.caseId, fixture.owner, release)).rejects.toThrow(/exactly one held replacement/);
    } finally {
      await db.update(organizations).set({ invoiceDueDayOfMonth: null }).where(eq(organizations.id, fixture.lab));
    }
  });
  it("serves the price preview to billing staff and the page apply to owners/admins only", async () => {
    await revokeRunApproval();
    const record = await newCase();
    const post = (user: string, action: string, body: object) =>
      request(app).post(`/billing-recovery/cases/${record.caseId}/${action}`).set("x-fixture-user", user).send(body);
    const priced = await post(fixture.staff, "preview", preview(record.attachmentId));
    expect(priced.status).toBe(200);
    expect(priced.body.data).toMatchObject({ total: "100.00", exceptions: [], persisted: false });
    expect(await caseWrites(record.caseId)).toEqual({ events: 0, invoices: 0, work: 0 });
    const staged = await post(fixture.staff, "proposal", input(record.attachmentId));
    expect(staged.status).toBe(200);
    expect(staged.body.data.proposal.total).toBe(priced.body.data.total);
    const proposalId = staged.body.data.proposalId as string;
    const refused = await post(fixture.staff, "apply", { proposalId });
    expect(refused.status).toBe(403);
    expect(await caseWrites(record.caseId)).toMatchObject({ invoices: 0, work: 0 });
    const applied = await post(fixture.owner, "apply", { proposalId });
    expect(applied.status).toBe(200);
    expect(applied.body.data).toMatchObject({ outcome: "created_held", total: "100.00" });
    const replay = await post(fixture.owner, "apply", { proposalId });
    expect(replay.body.data).toEqual({ invoiceId: applied.body.data.invoiceId, total: "100.00", outcome: "already_applied" });
    expect(await caseWrites(record.caseId)).toMatchObject({ invoices: 1, work: 1 });
  });
});

function sqlAnd(id: string) { return and(eq(invoices.id, id), finalizedInvoiceSql()); }
