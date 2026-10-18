import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireVerifiedAccount } from "../middlewares/auth";
import { asyncHandler } from "../middlewares/async-handler";
import { BILLING_ROLES, ADMIN_ROLES, requireAnyRole } from "../lib/rbac";
import { HttpError, ok } from "../lib/http";
import {
  recoveryProposalSchema, recoveryPreviewSchema, listRecoveryBilling, proposeRecoveryBilling,
  previewRecoveryBilling, applyRecoveryProposal, doNotBillRecoveryCase, releaseRecoveryInvoice,
} from "../lib/recovery-billing";
import {
  RECOVERY_LAB_ID,
  RECOVERY_TIMEZONE,
  recoveryDataAvailable,
} from "../lib/recovery-billing-scope";
import { analyzeRecoveredPrescription } from "../lib/recovery-billing-analysis";
import { RECOVERY_SAFEGUARD_VERSION, recoveryDatabaseIdentity, recoveryApprovedDigest } from "../lib/recovery-billing-run";
import { assertRecoveryDataAvailable } from "../lib/recovery-billing-scope";

const router = Router();
// Contains no case or lab data; the operator checks that held-draft safeguards
// are actually serving in production before enabling any production writes.
router.get("/safeguards", asyncHandler(async (_req, res) => {
  assertRecoveryDataAvailable();
  res.json({
    version: RECOVERY_SAFEGUARD_VERSION, databaseFingerprint: await recoveryDatabaseIdentity(),
    approvalDigest: await recoveryApprovedDigest(),
  });
}));
router.get("/access", requireAuth, requireVerifiedAccount, asyncHandler(async (req, res) => {
  if (!recoveryDataAvailable) {
    res.json({ available: false });
    return;
  }
  try {
    const membership = await requireAnyRole((req as any).auth.userId, RECOVERY_LAB_ID, BILLING_ROLES);
    const role = membership.role === "owner" || membership.role === "admin" ? "admin" : "staff";
    res.json({ available: true, role });
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 403) {
      res.json({ available: false });
      return;
    }
    throw error;
  }
}));
router.use((_req, _res, next) => {
  assertRecoveryDataAvailable();
  next();
});
router.use(requireAuth, requireVerifiedAccount);
router.use(asyncHandler(async (req, _res, next) => {
  await requireAnyRole((req as any).auth.userId, RECOVERY_LAB_ID, BILLING_ROLES);
  next();
}));
router.get("/", asyncHandler(async (_req, res) => {
  ok(res, { timezone: RECOVERY_TIMEZONE, rows: await listRecoveryBilling() });
}));
router.post("/cases/:caseId/analyze", asyncHandler(async (req, res) => {
  const id = z.string().parse(req.params.caseId);
  const { evidenceAttachmentId } = z.object({ evidenceAttachmentId: z.string().min(1) }).strict().parse(req.body);
  ok(res, await analyzeRecoveredPrescription(id, evidenceAttachmentId, (req as any).auth.userId));
}));
router.post("/cases/:caseId/preview", asyncHandler(async (req, res) => {
  const id = z.string().parse(req.params.caseId);
  ok(res, await previewRecoveryBilling(id, recoveryPreviewSchema.parse(req.body), (req as any).auth.userId));
}));
router.post("/cases/:caseId/proposal", asyncHandler(async (req, res) => {
  const id = z.string().parse(req.params.caseId);
  ok(res, await proposeRecoveryBilling(id, recoveryProposalSchema.parse(req.body), (req as any).auth.userId));
}));
router.post("/cases/:caseId/do-not-bill", asyncHandler(async (req, res) => {
  const id = z.string().parse(req.params.caseId);
  const { reason } = z.object({ reason: z.string().trim().min(1).max(4000) }).strict().parse(req.body);
  ok(res, await doNotBillRecoveryCase(id, reason, (req as any).auth.userId));
}));
// Single-case owner/admin apply: creates the held replacement only. The
// operator batch (and its run approval) lives in the command-line tooling.
router.post("/cases/:caseId/apply", asyncHandler(async (req, res) => {
  await requireAnyRole((req as any).auth.userId, RECOVERY_LAB_ID, ADMIN_ROLES);
  const { proposalId } = z.object({ proposalId: z.string().min(1) }).strict().parse(req.body);
  ok(res, await applyRecoveryProposal(z.string().parse(req.params.caseId), proposalId, (req as any).auth.userId, "page"));
}));
router.post("/cases/:caseId/correct", asyncHandler(async (req, res) => {
  const { proposalId } = z.object({ proposalId: z.string().min(1) }).strict().parse(req.body);
  ok(res, await applyRecoveryProposal(z.string().parse(req.params.caseId), proposalId, (req as any).auth.userId, "correction"));
}));
router.post("/cases/:caseId/release", asyncHandler(async (req, res) => {
  const id = z.string().parse(req.params.caseId);
  await requireAnyRole((req as any).auth.userId, RECOVERY_LAB_ID, ADMIN_ROLES);
  const input = z.object({
    chargesReviewed: z.literal(true), historicalPaymentsReviewed: z.literal(true),
    historicalSettlement: z.literal("independent_evidence_of_no_payment"),
    evidenceNotes: z.string().trim().min(20).max(4000),
  }).strict().parse(req.body);
  ok(res, await releaseRecoveryInvoice(id, (req as any).auth.userId, input));
}));
export default router;
