import { useSyncExternalStore } from "react";

let verifiedPin: { userId: string; pin: string } | null = null;
const listeners = new Set<() => void>();

const ADMIN_SETTINGS_PATHS = new Set([
  "/settings/users",
  "/settings/backup",
  "/settings/templates",
  "/settings/invoice-layout",
  "/settings/statement-layout",
  "/settings/correspondence-layout",
  "/settings/payment-receipt",
  "/settings/mobile-app",
  "/settings/platform-admin",
  "/settings/itero",
]);

export function isAdminSettingsPath(pathname: string): boolean {
  return ADMIN_SETTINGS_PATHS.has(pathname.split("?")[0] ?? "");
}

function notify() {
  for (const listener of listeners) listener();
}

export function setAdminSettingsPin(userId: string, pin: string): void {
  verifiedPin = { userId, pin };
  notify();
}

export function getAdminSettingsPin(userId?: string | null): string | null {
  if (!verifiedPin || userId === null || (userId && verifiedPin.userId !== userId)) return null;
  return verifiedPin.pin;
}

export function clearAdminSettingsPin(): void {
  if (!verifiedPin) return;
  verifiedPin = null;
  notify();
}

export function useAdminSettingsPin(userId?: string | null): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => Boolean(getAdminSettingsPin(userId)),
    () => false,
  );
}
