import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { users } from "@workspace/db";
import { HttpError, ok } from "../lib/http";
import {
  formatDoctorPreferences,
  type DoctorPreferences,
} from "../lib/doctor-preferences";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";
import { mergeEmailPrefs } from "../lib/email-prefs";
import { mergeSmsPrefs } from "../lib/sms-prefs";
import { mergeInAppPrefs } from "../lib/in-app-prefs";

const router = Router();

const emailPrefsInputSchema = z
  .object({
    caseNoteNotifications: z.boolean().optional(),
    orgInviteNotifications: z.boolean().optional(),
    statementEmails: z.boolean().optional(),
    billingReminders: z.boolean().optional(),
    installerAlerts: z.boolean().optional(),
    backupAlerts: z.boolean().optional(),
    cleanupAlerts: z.boolean().optional(),
    // Lab-user notification preferences
    caseCreatedNotifications: z.boolean().optional(),
    messageReceivedNotifications: z.boolean().optional(),
    rushCaseNotifications: z.boolean().optional(),
    providerNoteNotifications: z.boolean().optional(),
  })
  .strict();

const smsPrefsInputSchema = z
  .object({
    accountLinkInvites: z.boolean().optional(),
    caseNoteNotifications: z.boolean().optional(),
    billingReminders: z.boolean().optional(),
  })
  .strict();

const inAppPrefsInputSchema = z
  .object({
    caseNoteNotifications: z.boolean().optional(),
  })
  .strict();

const DOCTOR_PREFERENCE_DEFAULTS = {
  occlusionAmount: null,
  occlusionUnit: null,
  proximalContactAmount: null,
  proximalContactUnit: null,
  anatomyPreference: null,
  anatomyOther: null,
  caseQuestionContactMethod: null,
  caseQuestionContactValue: null,
} as const;

const doctorPreferencesInputSchema = z
  .object({
    occlusionAmount: z.number().finite().nonnegative().nullable().optional(),
    occlusionUnit: z.enum(["mm", "microns"]).nullable().optional(),
    proximalContactAmount: z.number().finite().nonnegative().nullable().optional(),
    proximalContactUnit: z.enum(["mm", "microns"]).nullable().optional(),
    anatomyPreference: z
      .enum(["primary_only", "primary_and_secondary", "other"])
      .nullable()
      .optional(),
    anatomyOther: z.string().trim().max(100).nullable().optional(),
    caseQuestionContactMethod: z
      .enum(["text", "phone_call", "email"])
      .nullable()
      .optional(),
    caseQuestionContactValue: z.string().trim().max(320).nullable().optional(),
  })
  .strict();

function validateDoctorPreferences(preferences: DoctorPreferences): void {
  const errors: Record<string, string> = {};
  if (
    preferences.anatomyPreference === "other" &&
    !preferences.anatomyOther
  ) {
    errors.anatomyOther = "Describe the other anatomy preference.";
  }
  if (
    preferences.anatomyOther &&
    preferences.anatomyOther.length > 100
  ) {
    errors.anatomyOther = "Other anatomy must be 100 characters or fewer.";
  }

  const contact = preferences.caseQuestionContactValue;
  if (preferences.caseQuestionContactMethod === "email") {
    if (!contact) {
      errors.caseQuestionContactValue = "Enter an email address for case questions.";
    } else if (!z.string().email().safeParse(contact).success) {
      errors.caseQuestionContactValue = "Enter a valid email address.";
    }
  } else if (
    preferences.caseQuestionContactMethod === "text" ||
    preferences.caseQuestionContactMethod === "phone_call"
  ) {
    const digits = contact?.replace(/\D/g, "") ?? "";
    if (!contact) {
      errors.caseQuestionContactValue = "Enter a phone number for case questions.";
    } else if (
      !/^\+?[0-9\s().-]+$/.test(contact) ||
      digits.length < 7 ||
      digits.length > 15
    ) {
      errors.caseQuestionContactValue = "Enter a valid phone number.";
    }
  } else if (contact) {
    errors.caseQuestionContactValue =
      "Choose a contact method before entering contact details.";
  }

  if (Object.keys(errors).length > 0) {
    throw new HttpError(400, "Please correct the doctor preference fields.", {
      fields: errors,
    });
  }
}

function requireProviderDoctorPreferences(user: { userType?: string | null }) {
  if (user.userType !== "provider") {
    throw new HttpError(
      403,
      "Doctor preferences are available to provider accounts only.",
    );
  }
}

router.get(
  "/me/doctor-preferences",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(404, "User not found.");
    requireProviderDoctorPreferences(user);
    return ok(res, formatDoctorPreferences(user.doctorPreferences));
  }),
);

router.patch(
  "/me/doctor-preferences",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(404, "User not found.");
    requireProviderDoctorPreferences(user);

    const parsed = doctorPreferencesInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, "Please correct the doctor preference fields.", {
        fields: Object.fromEntries(
          parsed.error.issues.map((issue) => [
            issue.path.join(".") || "form",
            issue.message,
          ]),
        ),
      });
    }

    const current = formatDoctorPreferences(user.doctorPreferences);
    const merged = {
      ...DOCTOR_PREFERENCE_DEFAULTS,
      ...current,
      ...parsed.data,
    } as DoctorPreferences;
    if (merged.anatomyPreference !== "other") merged.anatomyOther = null;
    if (merged.caseQuestionContactMethod === null) {
      merged.caseQuestionContactValue = null;
    }
    validateDoctorPreferences(merged);

    const [updated] = await db
      .update(users)
      .set({ doctorPreferences: merged })
      .where(eq(users.id, userId))
      .returning();
    return ok(res, formatDoctorPreferences(updated.doctorPreferences));
  }),
);

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

router.get(
  "/me/sms-preferences",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(404, "User not found.");
    return ok(res, mergeSmsPrefs(user.smsPreferences));
  })
);

router.patch(
  "/me/sms-preferences",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(404, "User not found.");

    const updates = smsPrefsInputSchema.parse(req.body);
    if (Object.keys(updates).length === 0) {
      return ok(res, mergeSmsPrefs(user.smsPreferences));
    }

    const merged = mergeSmsPrefs(user.smsPreferences);
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined) (merged as Record<string, boolean>)[k] = v;
    }

    const [updated] = await db
      .update(users)
      .set({ smsPreferences: merged })
      .where(eq(users.id, userId))
      .returning();

    return ok(res, mergeSmsPrefs(updated.smsPreferences));
  })
);

router.get(
  "/me/in-app-preferences",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(404, "User not found.");
    return ok(res, mergeInAppPrefs(user.inAppPreferences));
  })
);

router.patch(
  "/me/in-app-preferences",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(404, "User not found.");

    const updates = inAppPrefsInputSchema.parse(req.body);
    if (Object.keys(updates).length === 0) {
      return ok(res, mergeInAppPrefs(user.inAppPreferences));
    }

    const merged = mergeInAppPrefs(user.inAppPreferences);
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined) (merged as Record<string, boolean>)[k] = v;
    }

    const [updated] = await db
      .update(users)
      .set({ inAppPreferences: merged })
      .where(eq(users.id, userId))
      .returning();

    return ok(res, mergeInAppPrefs(updated.inAppPreferences));
  })
);

export default router;
