/**
 * "New provider doctor → match against existing platform doctors → SMS"
 * trigger used by both register and lab-creates-doctor paths (Task #320).
 *
 * The trigger is intentionally fire-and-forget from the caller's POV: any
 * failure here must NOT block account creation. The function logs warnings
 * and returns; it never throws back to the request handler.
 */
import { and, eq, ne, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { db } from "@workspace/db";
import {
  accountLinkInvites,
  organizationMemberships,
  organizations,
  users,
} from "@workspace/db";
import {
  normalizeEmail,
  normalizePhoneE164,
  sendLinkInviteSms,
} from "./account-link-sms";

export interface MatchAndInviteArgs {
  newUser: {
    id: string;
    email?: string | null;
    phone?: string | null;
    platformAccountNumber?: string | null;
  };
  /** Display name of the lab adding the new doctor. Used in the SMS body. */
  newLabName: string;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * Look for existing provider users whose normalized email or phone matches
 * the newly-created provider user. For each match, send an SMS (idempotent
 * per (newUserId, existingUserId) pair) and insert an account_link_invites
 * row recording the outcome.
 */
export async function matchAndInviteCrossLabDoctors(
  args: MatchAndInviteArgs
): Promise<void> {
  try {
    const newPhoneE164 = normalizePhoneE164(args.newUser.phone);
    const newEmail = normalizeEmail(args.newUser.email);
    if (!newPhoneE164 && !newEmail) return;
    if (!args.newUser.platformAccountNumber) return;

    const allUsers = await db
      .select()
      .from(users)
      .where(
        and(
          ne(users.id, args.newUser.id),
          eq(users.userType, "provider"),
          or(
            newEmail
              ? sql`lower(${users.email}) = ${newEmail}`
              : sql`false`,
            newPhoneE164 ? sql`${users.phone} IS NOT NULL` : sql`false`
          )
        )
      );

    const matches = allUsers.filter((u: any) => {
      if (newEmail && normalizeEmail(u.email) === newEmail) return true;
      if (newPhoneE164 && normalizePhoneE164(u.phone) === newPhoneE164) {
        return true;
      }
      return false;
    });
    if (matches.length === 0) return;

    for (const existing of matches) {
      const matchedOn =
        newEmail && normalizeEmail((existing as any).email) === newEmail
          ? "email"
          : "phone";
      // Idempotency: never re-process the same (new, existing) pair.
      const existingInvite = await db.query.accountLinkInvites.findFirst({
        where: and(
          eq(accountLinkInvites.newUserId, args.newUser.id),
          eq(accountLinkInvites.existingUserId, (existing as any).id)
        ),
      });
      if (existingInvite) continue;

      const targetPhone = normalizePhoneE164((existing as any).phone);

      // Insert the invite row first so even SMS failures leave a paper
      // trail for the in-app "pending invites" UI.
      const [invite] = await db
        .insert(accountLinkInvites)
        .values({
          newUserId: args.newUser.id,
          existingUserId: (existing as any).id,
          matchedOn,
          sentToPhone: targetPhone,
          sentAt: targetPhone ? new Date() : null,
          status: "pending",
        })
        .onConflictDoNothing()
        .returning();
      if (!invite) continue;

      if (targetPhone) {
        const result = await sendLinkInviteSms({
          toPhoneE164: targetPhone,
          newLabName: args.newLabName,
          newAccountNumber: args.newUser.platformAccountNumber,
          log: args.log,
        });
        await db
          .update(accountLinkInvites)
          .set({
            twilioMessageSid: result.messageSid ?? null,
            twilioErrorCode: result.errorCode ?? null,
            twilioErrorMessage: result.errorMessage ?? null,
          })
          .where(eq(accountLinkInvites.id, invite.id));
      }
    }
  } catch (err: any) {
    args.log?.warn?.(
      { err: err?.message ?? String(err) },
      "matchAndInviteCrossLabDoctors failed (non-fatal)"
    );
  }
}

/**
 * Find a human-readable lab name for the supplied user (for SMS body).
 * Picks the user's first active lab membership, falling back to the
 * doctor's practice name, then "a LabTrax lab".
 */
export async function resolveLabNameForUser(
  userId: string
): Promise<string> {
  const memberships = await db.query.organizationMemberships.findMany({
    where: and(
      eq(organizationMemberships.userId, userId),
      eq(organizationMemberships.status, "active")
    ),
  });
  if (memberships.length === 0) return "a LabTrax lab";
  const orgIds = memberships.map((m: any) => m.labId as string);
  const orgRows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgIds[0]!));
  const labOrg =
    orgRows.find((o: any) => o.type === "lab") || orgRows[0] || null;
  return (labOrg as any)?.displayName || (labOrg as any)?.name || "a LabTrax lab";
}
