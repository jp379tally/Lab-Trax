import { Router, type RequestHandler } from "express";
import { RecoverAuditedOrganizationsBody } from "@workspace/api-zod";
import { asyncHandler } from "../middlewares/async-handler";
import {
  runAuditedOrganizationRecovery,
} from "../lib/audited-organization-recovery-operation";

export const requireRecoveryAutomation: RequestHandler = (req, res, next) => {
  const secret = process.env.PLATFORM_ADMIN_SECRET;
  if (!secret || req.headers["x-platform-admin-secret"] !== secret || (req as any).user?.role !== "admin") {
    res.status(403).json({ error: "Authenticated platform automation access required." });
    return;
  }
  next();
};

// Mounted only behind the existing authenticated automation-secret guard.
// This is not a Creator-session bypass or a tenant-admin recovery facility.
export function auditedOrganizationRecoveryRouter() {
  const router = Router();
  const input = RecoverAuditedOrganizationsBody.strict();
  router.post("/", asyncHandler(async (req, res) => {
    const parsed = input.safeParse(req.body ?? {});
    if (!parsed.success || (!parsed.data.dryRun && !parsed.data.confirm)) {
      res.status(400).json({ error: "Use the exact recovery confirmation; arbitrary records and fields are not accepted." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(await runAuditedOrganizationRecovery(parsed.data.dryRun, (req as any).user?.id ?? null));
  }));
  return router;
}
