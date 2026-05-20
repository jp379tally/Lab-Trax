import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { users } from "@workspace/db";
import { HttpError, ok } from "../lib/http";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";
import { mergeEmailPrefs } from "../lib/email-prefs";

const router = Router();

const emailPrefsInputSchema = z
  .object({
    caseNoteNotifications: z.boolean().optional(),
    orgInviteNotifications: z.boolean().optional(),
    statementEmails: z.boolean().optional(),
    billingReminders: z.boolean().optional(),
  })
  .strict();

router.get(
  "/me/email-preferences",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(404, "User not found.");
    return ok(res, mergeEmailPrefs(user.emailPreferences));
  })
);

router.patch(
  "/me/email-preferences",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(404, "User not found.");

    const updates = emailPrefsInputSchema.parse(req.body);
    if (Object.keys(updates).length === 0) {
      return ok(res, mergeEmailPrefs(user.emailPreferences));
    }

    const merged = mergeEmailPrefs(user.emailPreferences);
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined) (merged as Record<string, boolean>)[k] = v;
    }

    const [updated] = await db
      .update(users)
      .set({ emailPreferences: merged })
      .where(eq(users.id, userId))
      .returning();

    return ok(res, mergeEmailPrefs(updated.emailPreferences));
  })
);

export default router;
