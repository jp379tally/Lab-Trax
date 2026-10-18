import { Router } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  employeeVacationBalances,
  employeeSchedules,
  notifications,
  organizationMemberships,
  users,
  vacationRequestDays,
  vacationRequests,
} from "@workspace/db";
import { HttpError, ok } from "../lib/http";
import { ADMIN_ROLES, requireAnyRole, requireMembership } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";
import { calculateRequestedHours } from "../lib/vacation-hours";

const router = Router();
router.use(requireAuth);

function uid(req: any): string {
  return req.auth.userId as string;
}

function currentYear(): number {
  return new Date().getFullYear();
}

async function getOrCreateBalance(
  labId: string,
  userId: string,
  year: number
) {
  const existing = await db.query.employeeVacationBalances.findFirst({
    where: and(
      eq(employeeVacationBalances.labId, labId),
      eq(employeeVacationBalances.userId, userId),
      eq(employeeVacationBalances.year, year)
    ),
  });
  if (existing) return existing;
  const [created] = await db
    .insert(employeeVacationBalances)
    .values({ labId, userId, year })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  return db.query.employeeVacationBalances.findFirst({
    where: and(
      eq(employeeVacationBalances.labId, labId),
      eq(employeeVacationBalances.userId, userId),
      eq(employeeVacationBalances.year, year)
    ),
  });
}

async function notifyAdmins(
  labId: string,
  type: string,
  title: string,
  body: string,
  dataJson: Record<string, unknown>
) {
  try {
    const adminMembers = await db.query.organizationMemberships.findMany({
      where: and(
        eq(organizationMemberships.labId, labId),
        eq(organizationMemberships.status, "active"),
        inArray(organizationMemberships.role, ADMIN_ROLES)
      ),
    });
    if (!adminMembers.length) return;
    await db.insert(notifications).values(
      adminMembers.map((m) => ({
        userId: m.userId,
        type,
        title,
        body,
        dataJson,
      }))
    );
  } catch {
    // Best-effort — notification failures must not block the business operation.
  }
}

async function notifyUser(
  userId: string,
  type: string,
  title: string,
  body: string,
  dataJson: Record<string, unknown>
) {
  try {
    await db.insert(notifications).values({ userId, type, title, body, dataJson });
  } catch {
    // Best-effort
  }
}

// ─────────────────────────── Employee endpoints ───────────────────────────

const createRequestSchema = z.object({
  organizationId: z.string().min(1),
  reason: z.string().max(500).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  days: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
        isAllDay: z.boolean().default(true),
        startTime: z
          .string()
          .regex(/^\d{2}:\d{2}$/, "Expected HH:MM")
          .optional()
          .nullable(),
        endTime: z
          .string()
          .regex(/^\d{2}:\d{2}$/, "Expected HH:MM")
          .optional()
          .nullable(),
      })
    )
    .min(1)
    .max(90),
});

router.post(
  "/requests",
  asyncHandler(async (req, res) => {
    const input = createRequestSchema.parse(req.body);
    const membership = await requireMembership(uid(req), input.organizationId);

    const totalHours = calculateRequestedHours(
      input.days.map((d) => ({
        isAllDay: d.isAllDay,
        startTime: d.startTime ?? null,
        endTime: d.endTime ?? null,
      }))
    );

    const year = currentYear();
    const balance = await getOrCreateBalance(
      input.organizationId,
      uid(req),
      year
    );
    if (!balance) throw new HttpError(500, "Could not resolve vacation balance.");

    const available =
      Number(balance.annualVacationHours) -
      Number(balance.usedVacationHours) -
      Number(balance.pendingVacationHours);

    if (totalHours > available) {
      throw new HttpError(
        409,
        `Request exceeds remaining vacation hours. Requested: ${totalHours.toFixed(2)} h, available: ${available.toFixed(2)} h.`
      );
    }

    const [request] = await db
      .insert(vacationRequests)
      .values({
        labId: input.organizationId,
        userId: uid(req),
        totalRequestedHours: totalHours.toFixed(2),
        reason: input.reason ?? null,
        notes: input.notes ?? null,
        status: "pending",
      })
      .returning();

    await db.insert(vacationRequestDays).values(
      input.days.map((d) => ({
        requestId: request.id,
        date: d.date,
        isAllDay: d.isAllDay,
        startTime: d.startTime ?? null,
        endTime: d.endTime ?? null,
      }))
    );

    await db
      .update(employeeVacationBalances)
      .set({
        pendingVacationHours: sql`${employeeVacationBalances.pendingVacationHours} + ${totalHours.toFixed(2)}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(employeeVacationBalances.labId, input.organizationId),
          eq(employeeVacationBalances.userId, uid(req)),
          eq(employeeVacationBalances.year, year)
        )
      );

    const submitterUser = await db.query.users.findFirst({
      where: eq(users.id, uid(req)),
    });
    const submitterName =
      [submitterUser?.firstName, submitterUser?.lastName]
        .filter(Boolean)
        .join(" ") || submitterUser?.username || "A team member";

    // TODO: email/SMS hook — call sendMail/sendSms here when required.
    await notifyAdmins(
      input.organizationId,
      "vacation_request_submitted",
      "Vacation request submitted",
      `${submitterName} submitted a vacation request for ${totalHours.toFixed(2)} h.`,
      { requestId: request.id, userId: uid(req), hours: totalHours }
    );

    const days = await db.query.vacationRequestDays.findMany({
      where: eq(vacationRequestDays.requestId, request.id),
      orderBy: vacationRequestDays.date,
    });

    return ok(res, { ...request, days }, 201);
  })
);

router.get(
  "/requests/mine",
  asyncHandler(async (req, res) => {
    const orgId = String(req.query.organizationId ?? "");
    if (!orgId) throw new HttpError(400, "organizationId is required.");
    await requireMembership(uid(req), orgId);

    const requests = await db.query.vacationRequests.findMany({
      where: and(
        eq(vacationRequests.labId, orgId),
        eq(vacationRequests.userId, uid(req))
      ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });

    const withDays = await Promise.all(
      requests.map(async (r) => {
        const days = await db.query.vacationRequestDays.findMany({
          where: eq(vacationRequestDays.requestId, r.id),
          orderBy: vacationRequestDays.date,
        });
        return { ...r, days };
      })
    );

    return ok(res, withDays);
  })
);

router.get(
  "/balances/mine",
  asyncHandler(async (req, res) => {
    const orgId = String(req.query.organizationId ?? "");
    if (!orgId) throw new HttpError(400, "organizationId is required.");
    await requireMembership(uid(req), orgId);

    const year = currentYear();
    const balance = await getOrCreateBalance(orgId, uid(req), year);
    return ok(res, balance);
  })
);

router.delete(
  "/requests/:id",
  asyncHandler(async (req, res) => {
    const request = await db.query.vacationRequests.findFirst({
      where: eq(vacationRequests.id, req.params.id),
    });
    if (!request) throw new HttpError(404, "Vacation request not found.");
    await requireMembership(uid(req), request.labId);

    if (request.userId !== uid(req)) {
      throw new HttpError(403, "You can only cancel your own requests.");
    }
    if (request.status !== "pending") {
      throw new HttpError(
        409,
        `Cannot cancel a request with status "${request.status}".`
      );
    }

    const [updated] = await db
      .update(vacationRequests)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(vacationRequests.id, request.id))
      .returning();

    const hours = Number(request.totalRequestedHours);
    await db
      .update(employeeVacationBalances)
      .set({
        pendingVacationHours: sql`GREATEST(0, ${employeeVacationBalances.pendingVacationHours} - ${hours.toFixed(2)})`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(employeeVacationBalances.labId, request.labId),
          eq(employeeVacationBalances.userId, request.userId),
          eq(employeeVacationBalances.year, currentYear())
        )
      );

    return ok(res, updated);
  })
);

// ─────────────────────────────── Admin endpoints ──────────────────────────

router.get(
  "/requests",
  asyncHandler(async (req, res) => {
    const orgId = String(req.query.organizationId ?? "");
    if (!orgId) throw new HttpError(400, "organizationId is required.");
    await requireAnyRole(uid(req), orgId, ADMIN_ROLES);

    const statusFilter = req.query.status as string | undefined;
    const employeeFilter = req.query.userId as string | undefined;

    const conditions = [eq(vacationRequests.labId, orgId)];
    if (statusFilter && statusFilter !== "all") {
      conditions.push(eq(vacationRequests.status, statusFilter));
    }
    if (employeeFilter) {
      conditions.push(eq(vacationRequests.userId, employeeFilter));
    }

    const requests = await db.query.vacationRequests.findMany({
      where: and(...conditions),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });

    const withDays = await Promise.all(
      requests.map(async (r) => {
        const days = await db.query.vacationRequestDays.findMany({
          where: eq(vacationRequestDays.requestId, r.id),
          orderBy: vacationRequestDays.date,
        });
        const employee = await db.query.users.findFirst({
          where: eq(users.id, r.userId),
        });
        return {
          ...r,
          days,
          employeeName:
            [employee?.firstName, employee?.lastName]
              .filter(Boolean)
              .join(" ") ||
            employee?.username ||
            null,
          employeeInitials: employee?.initials ?? null,
        };
      })
    );

    return ok(res, withDays);
  })
);

router.post(
  "/requests/:id/approve",
  asyncHandler(async (req, res) => {
    const request = await db.query.vacationRequests.findFirst({
      where: eq(vacationRequests.id, req.params.id),
    });
    if (!request) throw new HttpError(404, "Vacation request not found.");
    await requireAnyRole(uid(req), request.labId, ADMIN_ROLES);

    if (request.userId === uid(req)) {
      throw new HttpError(403, "You cannot approve your own vacation request.");
    }
    if (request.status !== "pending") {
      throw new HttpError(
        409,
        `Cannot approve a request with status "${request.status}".`
      );
    }

    const year = new Date(request.createdAt).getFullYear();
    const balance = await db.query.employeeVacationBalances.findFirst({
      where: and(
        eq(employeeVacationBalances.labId, request.labId),
        eq(employeeVacationBalances.userId, request.userId),
        eq(employeeVacationBalances.year, year)
      ),
    });

    if (balance) {
      const hours = Number(request.totalRequestedHours);
      const wouldUsed = Number(balance.usedVacationHours) + hours;
      if (wouldUsed > Number(balance.annualVacationHours)) {
        throw new HttpError(
          409,
          `Approval would exceed the employee's annual vacation allowance of ${balance.annualVacationHours} h.`
        );
      }

      await db
        .update(employeeVacationBalances)
        .set({
          usedVacationHours: sql`${employeeVacationBalances.usedVacationHours} + ${hours.toFixed(2)}`,
          pendingVacationHours: sql`GREATEST(0, ${employeeVacationBalances.pendingVacationHours} - ${hours.toFixed(2)})`,
          updatedAt: new Date(),
        })
        .where(eq(employeeVacationBalances.id, balance.id));
    }

    const [updated] = await db
      .update(vacationRequests)
      .set({
        status: "approved",
        approvedByUserId: uid(req),
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(vacationRequests.id, request.id))
      .returning();

    // TODO: email/SMS hook — call sendMail/sendSms to the employee here.
    await notifyUser(
      request.userId,
      "vacation_request_approved",
      "Vacation request approved",
      `Your vacation request for ${Number(request.totalRequestedHours).toFixed(2)} h has been approved.`,
      { requestId: request.id }
    );

    return ok(res, updated);
  })
);

const denySchema = z.object({
  adminDecisionNote: z.string().max(1000).optional().nullable(),
});

router.post(
  "/requests/:id/deny",
  asyncHandler(async (req, res) => {
    const input = denySchema.parse(req.body);
    const request = await db.query.vacationRequests.findFirst({
      where: eq(vacationRequests.id, req.params.id),
    });
    if (!request) throw new HttpError(404, "Vacation request not found.");
    await requireAnyRole(uid(req), request.labId, ADMIN_ROLES);

    if (request.status !== "pending") {
      throw new HttpError(
        409,
        `Cannot deny a request with status "${request.status}".`
      );
    }

    const hours = Number(request.totalRequestedHours);
    await db
      .update(employeeVacationBalances)
      .set({
        pendingVacationHours: sql`GREATEST(0, ${employeeVacationBalances.pendingVacationHours} - ${hours.toFixed(2)})`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(employeeVacationBalances.labId, request.labId),
          eq(employeeVacationBalances.userId, request.userId),
          eq(employeeVacationBalances.year, new Date(request.createdAt).getFullYear())
        )
      );

    const [updated] = await db
      .update(vacationRequests)
      .set({
        status: "denied",
        adminDecisionNote: input.adminDecisionNote ?? null,
        approvedByUserId: uid(req),
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(vacationRequests.id, request.id))
      .returning();

    // TODO: email/SMS hook — call sendMail/sendSms to the employee here.
    await notifyUser(
      request.userId,
      "vacation_request_denied",
      "Vacation request denied",
      `Your vacation request for ${Number(request.totalRequestedHours).toFixed(2)} h was not approved.${input.adminDecisionNote ? ` Note: ${input.adminDecisionNote}` : ""}`,
      { requestId: request.id }
    );

    return ok(res, updated);
  })
);

router.get(
  "/balances",
  asyncHandler(async (req, res) => {
    const orgId = String(req.query.organizationId ?? "");
    if (!orgId) throw new HttpError(400, "organizationId is required.");
    await requireAnyRole(uid(req), orgId, ADMIN_ROLES);

    const year =
      req.query.year ? Number(req.query.year) : currentYear();

    const members = await db.query.organizationMemberships.findMany({
      where: and(
        eq(organizationMemberships.labId, orgId),
        eq(organizationMemberships.status, "active")
      ),
    });

    const balances = await Promise.all(
      members.map(async (m) => {
        const balance = await getOrCreateBalance(orgId, m.userId, year);
        const user = await db.query.users.findFirst({
          where: eq(users.id, m.userId),
        });
        return {
          ...(balance ?? {
            id: null,
            labId: orgId,
            userId: m.userId,
            year,
            annualVacationHours: "0",
            usedVacationHours: "0",
            pendingVacationHours: "0",
          }),
          membershipRole: m.role,
          employeeName:
            [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
            user?.username ||
            null,
          employeeInitials: user?.initials ?? null,
        };
      })
    );

    return ok(res, balances);
  })
);

const updateBalanceSchema = z.object({
  annualVacationHours: z.coerce.number().min(0).max(10000),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
});

router.patch(
  "/balances/:memberId",
  asyncHandler(async (req, res) => {
    const input = updateBalanceSchema.parse(req.body);
    const orgId = String(req.query.organizationId ?? "");
    if (!orgId) throw new HttpError(400, "organizationId is required.");
    await requireAnyRole(uid(req), orgId, ADMIN_ROLES);

    const targetUserId = req.params.memberId;
    const year = input.year ?? currentYear();

    await requireMembership(targetUserId, orgId).catch(() => {
      throw new HttpError(404, "Member not found in this organization.");
    });

    const [balance] = await db
      .insert(employeeVacationBalances)
      .values({
        labId: orgId,
        userId: targetUserId,
        year,
        annualVacationHours: input.annualVacationHours.toFixed(2),
      })
      .onConflictDoUpdate({
        target: [
          employeeVacationBalances.labId,
          employeeVacationBalances.userId,
          employeeVacationBalances.year,
        ],
        set: {
          annualVacationHours: input.annualVacationHours.toFixed(2),
          updatedAt: new Date(),
        },
      })
      .returning();

    return ok(res, balance);
  })
);

// ─────────────────────────── Schedule CRUD (admin) ────────────────────────

router.get(
  "/schedules",
  asyncHandler(async (req, res) => {
    const orgId = String(req.query.organizationId ?? "");
    if (!orgId) throw new HttpError(400, "organizationId is required.");
    await requireAnyRole(uid(req), orgId, ADMIN_ROLES);

    const employeeFilter = req.query.userId as string | undefined;
    const conditions = [eq(employeeSchedules.labId, orgId)];
    if (employeeFilter) {
      conditions.push(eq(employeeSchedules.userId, employeeFilter));
    }

    const rows = await db.query.employeeSchedules.findMany({
      where: and(...conditions),
      orderBy: (t, { asc }) => [asc(t.userId), asc(t.dayOfWeek), asc(t.date)],
    });

    const withNames = await Promise.all(
      rows.map(async (s) => {
        const user = await db.query.users.findFirst({
          where: eq(users.id, s.userId),
        });
        return {
          ...s,
          employeeName:
            [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
            user?.username ||
            null,
        };
      })
    );

    return ok(res, withNames);
  })
);

const createScheduleSchema = z.object({
  organizationId: z.string().min(1),
  userId: z.string().min(1),
  scheduleType: z.enum(["recurring", "one_time"]).default("recurring"),
  dayOfWeek: z.number().int().min(0).max(6).optional().nullable(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  notes: z.string().max(500).optional().nullable(),
});

router.post(
  "/schedules",
  asyncHandler(async (req, res) => {
    const input = createScheduleSchema.parse(req.body);
    await requireAnyRole(uid(req), input.organizationId, ADMIN_ROLES);
    await requireMembership(input.userId, input.organizationId).catch(() => {
      throw new HttpError(404, "Target user is not a member of this organization.");
    });

    if (input.scheduleType === "recurring" && input.dayOfWeek == null) {
      throw new HttpError(400, "dayOfWeek is required for recurring schedules.");
    }
    if (input.scheduleType === "one_time" && !input.date) {
      throw new HttpError(400, "date is required for one_time schedules.");
    }

    const [row] = await db
      .insert(employeeSchedules)
      .values({
        labId: input.organizationId,
        userId: input.userId,
        scheduleType: input.scheduleType,
        dayOfWeek: input.dayOfWeek ?? null,
        date: input.date ?? null,
        startTime: input.startTime,
        endTime: input.endTime,
        notes: input.notes ?? null,
      })
      .returning();

    return ok(res, row, 201);
  })
);

const updateScheduleSchema = z.object({
  scheduleType: z.enum(["recurring", "one_time"]).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional().nullable(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  notes: z.string().max(500).optional().nullable(),
});

router.patch(
  "/schedules/:id",
  asyncHandler(async (req, res) => {
    const schedule = await db.query.employeeSchedules.findFirst({
      where: eq(employeeSchedules.id, req.params.id),
    });
    if (!schedule) throw new HttpError(404, "Schedule not found.");
    await requireAnyRole(uid(req), schedule.labId, ADMIN_ROLES);

    const input = updateScheduleSchema.parse(req.body);
    const [updated] = await db
      .update(employeeSchedules)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(employeeSchedules.id, schedule.id))
      .returning();

    return ok(res, updated);
  })
);

router.delete(
  "/schedules/:id",
  asyncHandler(async (req, res) => {
    const schedule = await db.query.employeeSchedules.findFirst({
      where: eq(employeeSchedules.id, req.params.id),
    });
    if (!schedule) throw new HttpError(404, "Schedule not found.");
    await requireAnyRole(uid(req), schedule.labId, ADMIN_ROLES);

    await db.delete(employeeSchedules).where(eq(employeeSchedules.id, schedule.id));
    return ok(res, { deleted: true });
  })
);

export default router;
