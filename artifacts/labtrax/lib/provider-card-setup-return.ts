// Where a provider lands after Stripe card setup.
//
// The lab shell answers the `labtrax://provider-billing?returned=1…` deep link
// by pushing the provider-billing settings screen. A provider has no lab
// settings: card setup is launched from the portal's My Account, so the return
// belongs there. Rather than pushing a second copy of the portal on top of the
// live one (which would lose the section the provider was on), the return is
// handed to the portal:
//   * the shell switches to My Account when a return arrives, and
//   * My Account consumes it exactly once and refreshes the card state.
//
// Kept as a module store rather than router params because the portal is a
// single already-mounted screen — there is nothing to navigate to.
//
// Which surface a return belongs to is a three-way answer, not a boolean. A
// deep link can arrive before anyone knows: on a cold start the initial URL is
// delivered while the account's memberships are still loading, and it can
// arrive while signed out entirely. Treating "not known yet" as "lab" would
// push a provider into a lab-only settings screen, so an unresolved shell
// queues the return until the answer arrives.
import { router } from "expo-router";

export interface ProviderCardSetupReturn {
  /** Stripe Checkout session for the setup attempt. */
  sessionId: string;
  /** The provider backed out of Stripe; no card was changed. */
  cancelled: boolean;
}

/** Which surface a finished card setup belongs to, once that is known. */
export type ProviderCardSetupShell = "provider" | "lab" | "unresolved";

type Listener = () => void;

let shell: ProviderCardSetupShell = "unresolved";
let pendingReturn: ProviderCardSetupReturn | null = null;
let queuedReturn: ProviderCardSetupReturn | null = null;
const listeners = new Set<Listener>();

/** Record a card-setup return for the portal to handle. */
export function recordProviderCardSetupReturn(value: ProviderCardSetupReturn): void {
  pendingReturn = value;
  for (const listener of [...listeners]) listener();
}

function deliver(value: ProviderCardSetupReturn): void {
  if (shell === "provider") {
    recordProviderCardSetupReturn(value);
    return;
  }
  // Lab users started card setup from the provider-billing settings screen,
  // which reads the session out of its own route params.
  router.push(
    `/settings/provider-billing?providerCardSetupSession=${encodeURIComponent(value.sessionId)}` as never,
  );
}

/**
 * Send a finished Stripe card setup to whichever surface started it, holding
 * it while the answer is still unknown.
 */
export function routeProviderCardSetupReturn(value: ProviderCardSetupReturn): void {
  if (shell === "unresolved") {
    queuedReturn = value;
    return;
  }
  deliver(value);
}

/**
 * Record which shell the signed-in user gets, and hand over anything that was
 * waiting on the answer. Delivery happens once: a later re-resolution (a
 * refetch, a remount) must not replay a return the provider already saw.
 */
export function setProviderCardSetupShell(next: ProviderCardSetupShell): void {
  shell = next;
  if (next === "unresolved") return;
  const queued = queuedReturn;
  queuedReturn = null;
  if (queued) deliver(queued);
}

/** Read a card-setup return out of deep-link parameters, if that's what they are. */
export function parseProviderCardSetupReturn(
  params: Record<string, unknown> | null | undefined,
): ProviderCardSetupReturn | null {
  if (!params) return null;
  if (params.returned !== "1") return null;
  const sessionId = params.providerCardSetupSession;
  if (typeof sessionId !== "string" || !sessionId) return null;
  return { sessionId, cancelled: params.cancelled === "1" };
}

/** True when a return is waiting for the portal to handle it. */
export function hasProviderCardSetupReturn(): boolean {
  return pendingReturn !== null;
}

/**
 * Take the pending return, clearing it.
 *
 * Both the mount path and the subscription path call this, so a return is
 * handled exactly once no matter which of them observes it first.
 */
export function consumeProviderCardSetupReturn(): ProviderCardSetupReturn | null {
  const value = pendingReturn;
  pendingReturn = null;
  return value;
}

/** Observe card-setup returns while mounted. */
export function subscribeProviderCardSetupReturn(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drop any unhandled return (test teardown). */
export function clearProviderCardSetupReturn(): void {
  pendingReturn = null;
  queuedReturn = null;
}

/**
 * Forget everything about card-setup routing.
 *
 * Used on sign-out: the next account may get the other shell, and a return
 * nobody handled belongs to the session that started it.
 */
export function resetProviderCardSetupRouting(): void {
  shell = "unresolved";
  clearProviderCardSetupReturn();
}
