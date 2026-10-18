import { and, eq, ilike, isNull } from "drizzle-orm";
import { db, systemSettings, users } from "@workspace/db";
import { hashPassword, verifyPassword } from "./crypto";
import { HttpError } from "./http";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../middlewares/async-handler";
import { writeAuditLogTx } from "./audit";

const KEY = "creator_security";
const TTL = 30 * 60 * 1000;
const WINDOW = 15 * 60 * 1000;
export const CREATOR_PIN_PATTERN = /^\d{7}$/;
type Security = {
  userId: string;
  hash: string | null;
  version: number;
  attempts: number;
  resetAt: number;
  unlocks: Record<string, { expiresAt: number; version: number }>;
};

// Binding happens once. A renamed/deleted JPP account never transfers access to
// a new account with the same name. No role, tenant, PIN header or secret bypass.
async function security<T>(work: (state: Security | null, tx: any) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    let [row] = await tx.select().from(systemSettings).where(eq(systemSettings.key, KEY));
    if (!row) {
      const candidates = await tx.select({ id: users.id }).from(users).where(and(
        ilike(users.username, "JPP"), eq(users.isActive, true), isNull(users.deletedAt),
      ));
      if (candidates.length !== 1) return work(null, tx);
      const initial: Security = { userId: candidates[0]!.id, hash: null, version: 1, attempts: 0, resetAt: 0, unlocks: {} };
      await tx.insert(systemSettings).values({ key: KEY, value: JSON.stringify(initial) }).onConflictDoNothing();
      await writeAuditLogTx(tx, { userId: candidates[0]!.id, action: "creator_identity_bound", entityType: "creator_security" });
    }
    [row] = await tx.select().from(systemSettings).where(eq(systemSettings.key, KEY)).for("update");
    if (!row) throw new HttpError(503, "Creator security is unavailable.");
    const state = JSON.parse(row.value ?? "{}") as Security;
    if (!state.userId || !Number.isInteger(state.version) || !state.unlocks) throw new HttpError(503, "Creator security is unavailable.");
    const initialPin = process.env.CREATOR_INITIAL_PIN;
    if (!state.hash && initialPin && CREATOR_PIN_PATTERN.test(initialPin)) {
      state.hash = await hashPassword(initialPin);
      await writeAuditLogTx(tx, { userId: state.userId, action: "creator_pin_provisioned", entityType: "creator_security" });
    }
    const now = Date.now();
    for (const [sid, unlock] of Object.entries(state.unlocks)) {
      if (unlock.expiresAt <= now || unlock.version !== state.version) delete state.unlocks[sid];
    }
    // Work must return error outcomes rather than throw after incrementing a
    // counter, otherwise rollback would let direct requests bypass throttling.
    const result = await work(state, tx);
    await tx.update(systemSettings).set({ value: JSON.stringify(state) }).where(eq(systemSettings.key, KEY));
    return result;
  });
}

export async function creatorAccess(userId: string, sessionId: string) {
  return security(async (state) => {
    const isCreator = Boolean(state && userId && state.userId === userId);
    const unlock = isCreator ? state!.unlocks[sessionId] : undefined;
    return {
      isCreator, pinConfigured: isCreator && Boolean(state!.hash),
      unlocked: Boolean(unlock), expiresAt: unlock ? new Date(unlock.expiresAt).toISOString() : null,
    };
  });
}

/** Internal delivery destination; never included in client capability data. */
export async function creatorRecipientId() {
  return security(async state => state?.userId ?? null);
}

export const requireCreator = [
  requireAuth,
  asyncHandler(async (req: any, _res: any, next: any) => {
    const access = await creatorAccess(req.auth.userId, req.auth.sessionId);
    if (!access.isCreator) throw new HttpError(403, "Creator account access required.");
    if (!access.unlocked) throw new HttpError(403, "Creator unlock required.");
    next();
  }),
];

export async function creatorCredential(req: any, operation: "unlock" | "rotate") {
  return security(async (state, tx) => {
    const execute = async () => {
    if (!state || req.auth.userId !== state.userId) return { status: 403, error: "Creator account access required." };
    if (!state.hash) return { status: 503, error: "Creator PIN has not been securely provisioned." };
    const now = Date.now();
    if (state.resetAt <= now) { state.attempts = 0; state.resetAt = now + WINDOW; }
    if (state.attempts >= 5) return { status: 429, error: "Too many Creator PIN attempts. Try again after 15 minutes.", retryAfter: Math.ceil((state.resetAt - now) / 1000) };
    state.attempts++;
    const pin = operation === "unlock" ? req.body?.pin : req.body?.currentPin;
    if (typeof pin !== "string" || !CREATOR_PIN_PATTERN.test(pin) || !await verifyPassword(pin, state.hash)) {
      return { status: 403, error: "Incorrect Creator PIN." };
    }
    if (operation === "rotate") {
      const { newPin, confirmPin } = req.body ?? {};
      if (typeof newPin !== "string" || !CREATOR_PIN_PATTERN.test(newPin) || newPin !== confirmPin) {
        return { status: 400, error: "Enter and confirm the same seven-digit new PIN." };
      }
      state.hash = await hashPassword(newPin);
      state.version++;
      state.unlocks = {};
    } else {
      state.unlocks[req.auth.sessionId] = { expiresAt: now + TTL, version: state.version };
    }
    return { status: 200, ok: true, expiresAt: operation === "unlock" ? new Date(now + TTL).toISOString() : null };
    };
    const outcome = await execute();
    await writeAuditLogTx(tx, { req, userId: req.auth.userId, action: `creator_${operation}_${outcome.status === 200 ? "succeeded" : "rejected"}`, entityType: "creator_security" });
    return outcome;
  });
}

export async function lockCreator(req: any) {
  await security(async (state, tx) => {
    if (!state || state.userId !== req.auth.userId) throw new HttpError(403, "Creator account access required.");
    delete state.unlocks[req.auth.sessionId];
    await writeAuditLogTx(tx, { req, userId: req.auth.userId, action: "creator_locked", entityType: "creator_security" });
  });
}
