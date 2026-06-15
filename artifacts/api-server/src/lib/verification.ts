/**
 * Durable one-time verification codes (Account epic Phase 2).
 *
 * Replaces the old in-memory `Map` used by the send/verify email/phone code
 * routes. Codes are persisted to the `verification_codes` table HASHED (SHA-256,
 * never plaintext) so the "is this contact verified?" signal survives restarts
 * and works across instances. Each code is single-use (`consumedAt`), expires
 * after {@link CODE_TTL_MS}, and is attempt-limited via {@link MAX_ATTEMPTS}.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { verificationCodes } from "@workspace/db";
import { sha256 } from "./crypto";
import { normalizePhone10 } from "./platform-account-number";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;

export type VerificationChannel = "email" | "sms";

/** Canonical lookup key for an email target (lowercased, trimmed). */
export function normalizeEmailTarget(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Canonical lookup key for a phone target. Prefers the strict 10-digit form;
 * falls back to a digits-only stripped value so malformed numbers still match
 * between send and verify within the same flow.
 */
export function normalizePhoneTarget(phone: string): string {
  return normalizePhone10(phone) ?? phone.replace(/\D/g, "");
}

/**
 * Persist a fresh code for (channel, target), first invalidating any prior
 * unconsumed codes for that pair so only the latest code is valid.
 */
export async function createVerificationCode(opts: {
  channel: VerificationChannel;
  target: string;
  code: string;
  userId?: string | null;
}): Promise<void> {
  const now = new Date();
  await db
    .update(verificationCodes)
    .set({ consumedAt: now })
    .where(
      and(
        eq(verificationCodes.target, opts.target),
        eq(verificationCodes.channel, opts.channel),
        isNull(verificationCodes.consumedAt)
      )
    );

  await db.insert(verificationCodes).values({
    userId: opts.userId ?? null,
    channel: opts.channel,
    target: opts.target,
    codeHash: sha256(opts.code),
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
  });
}

export type VerifyResult = {
  verified: boolean;
  error?: string;
  /** The userId the code was issued to, when known (signup-time flow). */
  userId?: string | null;
};

/**
 * Validate a submitted code against the latest unconsumed code for
 * (channel, target). On success the code is marked consumed (single-use).
 * On a wrong code the attempt counter is incremented and the code stays live
 * until {@link MAX_ATTEMPTS} is exhausted.
 */
export async function verifyCode(opts: {
  channel: VerificationChannel;
  target: string;
  code: string;
}): Promise<VerifyResult> {
  const row = await db.query.verificationCodes.findFirst({
    where: and(
      eq(verificationCodes.target, opts.target),
      eq(verificationCodes.channel, opts.channel),
      isNull(verificationCodes.consumedAt)
    ),
    orderBy: [desc(verificationCodes.createdAt)],
  });

  if (!row) {
    return { verified: false, error: "No code sent. Please request a new one." };
  }
  if (row.expiresAt.getTime() < Date.now()) {
    return { verified: false, error: "Code expired." };
  }
  if (row.attemptCount >= MAX_ATTEMPTS) {
    return {
      verified: false,
      error: "Too many attempts. Please request a new code.",
    };
  }
  if (row.codeHash !== sha256(opts.code.trim())) {
    await db
      .update(verificationCodes)
      .set({ attemptCount: row.attemptCount + 1 })
      .where(eq(verificationCodes.id, row.id));
    return { verified: false, error: "Incorrect code." };
  }

  await db
    .update(verificationCodes)
    .set({ consumedAt: new Date() })
    .where(eq(verificationCodes.id, row.id));
  return { verified: true, userId: row.userId };
}
