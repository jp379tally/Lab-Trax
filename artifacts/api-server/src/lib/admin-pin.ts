import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { systemSettings } from "@workspace/db";

// ─── Admin PIN cache ──────────────────────────────────────────────────────────
// The admin PIN is stored in system_settings (key "admin_pin"). When absent,
// the effective PIN defaults to the PLATFORM_ADMIN_PIN env var, and further
// falls back to "0000" in development only.
//
// This module-level cache lets the synchronous isPlatformAdmin() check use
// the DB value without blocking on every request.

export const SETTING_ADMIN_PIN = "admin_pin";

let _dbAdminPin: string | null = null;
let _dbAdminPinLoaded = false;

export async function loadAdminPinCache(): Promise<void> {
  if (_dbAdminPinLoaded) return;
  const rows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, SETTING_ADMIN_PIN))
    .limit(1);
  _dbAdminPin = rows[0]?.value ?? null;
  _dbAdminPinLoaded = true;
}

/**
 * Synchronous — requires that the cache has already been loaded via
 * `loadAdminPinCache()` or `getEffectiveAdminPinAsync()`.
 */
export function getEffectiveAdminPin(): string {
  if (_dbAdminPin) return _dbAdminPin;
  const envPin = process.env.PLATFORM_ADMIN_PIN;
  if (envPin && envPin !== "0000") return envPin;
  if (process.env.NODE_ENV === "production") {
    // Belt-and-suspenders: index.ts should have already blocked startup
    // if PLATFORM_ADMIN_PIN was missing or set to "0000". If this line is
    // somehow reached, fail loudly rather than silently accept "0000".
    throw new Error(
      "PLATFORM_ADMIN_PIN is not configured for production. " +
      "Set it in Replit environment secrets and redeploy.",
    );
  }
  // Development only: allow "0000" with a clear warning.
  console.warn(
    "[dev] PLATFORM_ADMIN_PIN is not set. Falling back to '0000' in development. " +
    "You must set PLATFORM_ADMIN_PIN in Replit secrets before publishing.",
  );
  return "0000";
}

/**
 * Async — loads the cache first if not already loaded, then returns
 * the effective PIN. Safe to call from any route handler.
 */
export async function getEffectiveAdminPinAsync(): Promise<string> {
  if (!_dbAdminPinLoaded) await loadAdminPinCache();
  return getEffectiveAdminPin();
}

/**
 * Returns true when the effective PIN is the dev fallback "0000",
 * i.e. neither a DB-stored custom PIN nor a non-default env var is set.
 * Requires the cache to be loaded.
 */
export function isAdminPinDefault(): boolean {
  if (_dbAdminPin) return false;
  const envPin = process.env.PLATFORM_ADMIN_PIN;
  if (envPin && envPin !== "0000") return false;
  return true;
}

/**
 * Returns true when the PIN is meaningfully configured — either a
 * custom PIN has been saved in the DB, or PLATFORM_ADMIN_PIN is set
 * to a value other than "0000".
 * Requires the cache to be loaded.
 */
export function isAdminPinConfigured(): boolean {
  if (_dbAdminPin) return true;
  const envPin = (process.env.PLATFORM_ADMIN_PIN ?? "").trim();
  return !!(envPin && envPin !== "0000");
}

/**
 * Async variant of isAdminPinConfigured — loads the cache first.
 */
export async function isAdminPinConfiguredAsync(): Promise<boolean> {
  if (!_dbAdminPinLoaded) await loadAdminPinCache();
  return isAdminPinConfigured();
}

/**
 * Mutate the in-memory cache after a DB write or reset.
 * Call with `null` to fall back to env var / dev default.
 */
export function setDbAdminPin(pin: string | null): void {
  _dbAdminPin = pin;
  _dbAdminPinLoaded = true;
}
