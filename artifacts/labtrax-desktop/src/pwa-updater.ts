/// <reference types="vite-plugin-pwa/vanillajs" />

import { registerSW } from "virtual:pwa-register";

const UPDATE_CHECK_INTERVAL_MS = 60_000;

/**
 * Finds published web updates without requiring the user to manually reload.
 *
 * The service worker owns the activation/reload behavior. This client-side
 * registrar only makes update checks proactive while the app remains open.
 */
export function registerPwaUpdates() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;

  registerSW({
    immediate: true,
    onRegisteredSW(_serviceWorkerUrl, registration) {
      if (!registration) return;

      let updateInFlight = false;
      const checkForUpdate = async () => {
        if (updateInFlight) return;
        updateInFlight = true;
        try {
          await registration.update();
        } catch {
          // Update checks are opportunistic. The next focus or interval retry
          // will pick up a deployment if the network was temporarily offline.
        } finally {
          updateInFlight = false;
        }
      };

      void checkForUpdate();
      window.setInterval(() => void checkForUpdate(), UPDATE_CHECK_INTERVAL_MS);
      window.addEventListener("focus", () => void checkForUpdate());
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void checkForUpdate();
      });
    },
  });
}