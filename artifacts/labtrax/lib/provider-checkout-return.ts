// Where a provider lands after Stripe's hosted checkout.
//
// The hosted page returns through an API bridge that opens
// `labtrax://provider-billing?returned=1[&cancelled=1]`. That link says a
// return happened but not which billing surface started it, so the origin is
// read back from the pending-checkout record the launcher wrote:
//
//   • "portal"   → the mounted provider portal is told to show Billing and
//                  reconcile the checkout in place. Pushing the legacy
//                  settings screen over the portal would hide the outcome
//                  notice and drop the portal's selected-practice context.
//   • otherwise  → the settings screen keeps the behaviour it has always had,
//                  including the card-setup return.
//
// A cancelled return is recorded durably before anything navigates: Stripe
// leaves the server-side checkout pending when the provider backs out, and the
// app may only get to release that reservation after a cold launch.
import { router } from "expo-router";
import {
  markPendingProviderCheckoutCancelled,
  readPendingProviderCheckout,
} from "@/lib/provider-billing";

export type ProviderCheckoutReturn = {
  checkoutId: string | null;
  cardSetupSession: string | null;
  cancelled: boolean;
};

/**
 * Read a Stripe return out of a deep link, or null when the link is not one.
 *
 * Handles both shapes the app receives: the `labtrax://` link the API bridge
 * redirects to, and the https link Stripe itself can return to. The query is
 * split off by hand rather than parsed as a URL because `labtrax://` is not a
 * special scheme and does not survive every URL implementation.
 *
 * Nothing in the link is trusted as an outcome: it can say a return happened
 * and that the provider cancelled, never that a payment succeeded.
 */
export function parseProviderCheckoutReturnUrl(url: string): ProviderCheckoutReturn | null {
  const queryStart = url.indexOf("?");
  if (queryStart < 0) return null;
  const params = new URLSearchParams(url.slice(queryStart + 1).split("#")[0] ?? "");
  const checkoutId =
    params.get("providerPaymentCheckout") || params.get("checkoutId") || null;
  const returned = params.get("returned") === "1";
  if (!checkoutId && !returned) return null;
  return {
    checkoutId,
    cardSetupSession: params.get("providerCardSetupSession") || null,
    cancelled: params.get("cancelled") === "1",
  };
}

/** A return handed to the portal, with a token so a repeat return re-runs. */
export type ProviderCheckoutReturnSignal = ProviderCheckoutReturn & { token: string };

type Listener = (signal: ProviderCheckoutReturnSignal) => void;

const listeners = new Set<Listener>();
let lastSignal: ProviderCheckoutReturnSignal | null = null;
let sequence = 0;

export function subscribeToProviderCheckoutReturn(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The most recent portal return that has not been handled yet.
 *
 * A cold launch delivers the link before the portal mounts, so the portal
 * reads the pending signal on mount instead of only listening for new ones.
 */
export function latestProviderCheckoutReturn(): ProviderCheckoutReturnSignal | null {
  return lastSignal;
}

/** Drop a signal once the billing section has acted on it. */
export function consumeProviderCheckoutReturn(token: string): void {
  if (lastSignal?.token === token) lastSignal = null;
}

export function publishProviderCheckoutReturn(
  ret: ProviderCheckoutReturn,
): ProviderCheckoutReturnSignal {
  sequence += 1;
  const signal: ProviderCheckoutReturnSignal = { ...ret, token: `${Date.now()}-${sequence}` };
  lastSignal = signal;
  for (const listener of [...listeners]) listener(signal);
  return signal;
}

/** Test seam: forget any published return between cases. */
export function resetProviderCheckoutReturn(): void {
  lastSignal = null;
  sequence = 0;
  listeners.clear();
}

/**
 * Send a Stripe return to the billing surface that started it.
 *
 * Returns which surface handled it, so the caller (and its tests) can tell a
 * portal return from a settings return.
 */
export async function deliverProviderCheckoutReturn(
  ret: ProviderCheckoutReturn,
): Promise<"portal" | "settings"> {
  if (ret.cancelled) {
    // Recorded before routing: whichever surface handles the return has to
    // know the provider backed out, even if the app is relaunched first.
    await markPendingProviderCheckoutCancelled().catch(() => {});
  }
  const pending = await readPendingProviderCheckout().catch(() => null);
  // A card-setup return belongs to the settings screen that starts it; only a
  // payment checkout can have been launched from the portal.
  if (pending?.origin === "portal" && !ret.cardSetupSession) {
    publishProviderCheckoutReturn({
      ...ret,
      checkoutId: ret.checkoutId ?? pending.checkoutId ?? null,
    });
    // Anything pushed over the portal (a case detail, the scanner) would hide
    // the outcome notice the provider came back for.
    try {
      if (router.canDismiss?.()) router.dismissAll?.();
    } catch {
      // Nothing to dismiss — the portal is already the visible screen.
    }
    return "portal";
  }
  const href = ret.checkoutId
    ? `/settings/provider-billing?checkoutId=${encodeURIComponent(ret.checkoutId)}`
    : ret.cardSetupSession
      ? `/settings/provider-billing?providerCardSetupSession=${encodeURIComponent(ret.cardSetupSession)}`
      : "/settings/provider-billing";
  router.push(href as never);
  return "settings";
}
