import type { Response } from "express";

export class HttpError extends Error {
  statusCode: number;
  details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function ok<T>(res: Response, data: T, status = 200) {
  return res.status(status).json({ ok: true, data });
}

/**
 * Extract the PostgreSQL error code from a raw Drizzle / pg error.
 *
 * Drizzle (node-postgres adapter) may wrap the native DatabaseError in a
 * DrizzleQueryError whose `cause` holds the original pg error.  We check
 * both the top-level object and `cause` so the code is found regardless of
 * the wrapper version.
 */
export function extractPgCode(err: unknown): string | undefined {
  if (err == null || typeof err !== "object") return undefined;
  if ("code" in err) return (err as { code: unknown }).code as string | undefined;
  if (
    "cause" in err &&
    err.cause != null &&
    typeof err.cause === "object" &&
    "code" in err.cause
  ) {
    return (err as { cause: { code: unknown } }).cause.code as string | undefined;
  }
  return undefined;
}

/**
 * Convert a raw database error into a safe `HttpError` and throw it.
 *
 * Maps the most common PostgreSQL constraint violation codes to readable
 * HTTP status codes.  Any error that does NOT carry a recognised PG code is
 * mapped to 500 with a generic message so that no raw Drizzle / SQL text can
 * ever leak to API callers.
 *
 * Pass optional `messages` to override the per-code default text with
 * context-specific wording (e.g. "Practice already exists." instead of the
 * generic duplicate message).
 *
 * Usage:
 *   ```ts
 *   try {
 *     await db.insert(myTable).values(row);
 *   } catch (err) {
 *     wrapDbError(err, { duplicate: "That name is already taken." });
 *   }
 *   ```
 */
/**
 * Extract the PostgreSQL constraint name from a raw Drizzle / pg error.
 *
 * Works like `extractPgCode` but returns the `constraint` property that
 * identifies which unique/FK/check constraint fired.  Returns `undefined`
 * when the error is not a recognised pg error object.
 */
export function extractPgConstraintName(err: unknown): string | undefined {
  if (err == null || typeof err !== "object") return undefined;
  const pgLike =
    "code" in err
      ? (err as Record<string, unknown>)
      : "cause" in err &&
          err.cause != null &&
          typeof err.cause === "object" &&
          "code" in err.cause
        ? (err as { cause: Record<string, unknown> }).cause
        : null;
  if (!pgLike) return undefined;
  return typeof pgLike["constraint"] === "string"
    ? pgLike["constraint"]
    : undefined;
}

export function wrapDbError(
  err: unknown,
  messages?: {
    /** 23505 — unique constraint violation */
    duplicate?: string;
    /** 23502 — not-null constraint violation */
    notNull?: string;
    /** 23514 — check constraint violation */
    checkViolation?: string;
    /** catch-all for every other error code */
    fallback?: string;
  },
): never {
  const pgCode = extractPgCode(err);
  if (pgCode === "23505") {
    throw new HttpError(
      409,
      messages?.duplicate ?? "A record with this value already exists.",
    );
  }
  if (pgCode === "23502") {
    throw new HttpError(
      400,
      messages?.notNull ?? "A required field is missing.",
    );
  }
  if (pgCode === "23514") {
    throw new HttpError(
      400,
      messages?.checkViolation ?? "A field value is invalid.",
    );
  }
  throw new HttpError(
    500,
    messages?.fallback ?? "An unexpected error occurred. Please try again.",
  );
}
