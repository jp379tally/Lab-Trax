import { Router } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db, savedCardSetupAnalytics } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router = Router();
export const savedCardSetupOutcomeSchema = z.object({
  outcome: z.enum(["started", "succeeded", "expired"]),
}).strict();
export type SavedCardSetupOutcome = z.infer<typeof savedCardSetupOutcomeSchema>["outcome"];

export async function recordSavedCardSetupOutcome(
  outcome: SavedCardSetupOutcome,
  database: Pick<typeof db, "insert"> = db,
): Promise<void> {
  await database.insert(savedCardSetupAnalytics)
    .values({ outcome, count: 1 })
    .onConflictDoUpdate({
      target: savedCardSetupAnalytics.outcome,
      set: {
        count: sql`${savedCardSetupAnalytics.count} + 1`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Record one of the fixed outcomes for the hosted lab saved-card flow.
 * The endpoint intentionally accepts no identifiers or arbitrary properties.
 * A telemetry failure is reported as 204: callers must never gate setup UX on
 * this best-effort aggregate.
 */
router.post("/saved-card-setup", requireAuth, async (req, res) => {
  const parsed = savedCardSetupOutcomeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid saved-card setup outcome." });
  }
  try {
    await recordSavedCardSetupOutcome(parsed.data.outcome);
  } catch {
    // Aggregate analytics is deliberately non-critical.
  }
  return res.status(204).send();
});

export default router;