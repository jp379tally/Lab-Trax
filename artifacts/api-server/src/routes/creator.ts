import { Router } from "express";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../middlewares/async-handler";
import { creatorAccess, creatorCredential, lockCreator, requireCreator } from "../lib/creator-auth";
import { creatorFeedbackRouter } from "./creator-feedback";
import { creatorRevenueRouter } from "./creator-revenue";

const router = Router();
router.get("/access", requireAuth, asyncHandler(async (req: any, res) => res.json(await creatorAccess(req.auth.userId, req.auth.sessionId))));
for (const [path, operation] of [["/unlock", "unlock"], ["/pin", "rotate"]] as const) {
  router.post(path, requireAuth, asyncHandler(async (req, res) => {
    const outcome = await creatorCredential(req, operation);
    if ("retryAfter" in outcome) res.setHeader("Retry-After", String(outcome.retryAfter));
    res.status(outcome.status).json(outcome);
  }));
}
router.post("/lock", requireAuth, asyncHandler(async (req, res) => { await lockCreator(req); res.json({ ok: true }); }));
router.use(requireCreator);
router.use("/feedback", creatorFeedbackRouter);
router.use("/revenue", creatorRevenueRouter);
export default router;
