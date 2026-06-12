import { Router } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { notifications } from "@workspace/db";
import { ok } from "../lib/http";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;

    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(50);

    return ok(res, rows);
  })
);

router.patch(
  "/:id/read",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const { id } = req.params;

    const [updated] = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(eq(notifications.id, id), eq(notifications.userId, userId))
      )
      .returning();

    if (!updated) {
      return ok(res, { ok: false, error: "not_found" });
    }

    return ok(res, updated);
  })
);

router.post(
  "/mark-all-read",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;

    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(eq(notifications.userId, userId), isNull(notifications.readAt))
      );

    return ok(res, { ok: true });
  })
);

export default router;
