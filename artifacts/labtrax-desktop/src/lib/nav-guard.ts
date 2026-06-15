// A tiny module-level navigation guard. While a blocker is registered (for
// example the InvoiceEditor has unsaved edits) every in-app route navigation is
// routed through it via the wouter Router's `aroundNav` hook, so the user can
// confirm before walking away from unsaved work.
//
// The guard is intentionally a singleton rather than React context: the wouter
// `aroundNav` handler lives outside the component tree that registers the
// blocker, and navigation interception must read the *current* blocker
// synchronously at click time.

type Proceed = () => void;
type NavBlocker = (proceed: Proceed) => void;

let activeBlocker: NavBlocker | null = null;
let bypass = false;

// Register (or clear with `null`) the active navigation blocker. The most
// recently registered blocker wins; callers must clear their own blocker on
// cleanup so it does not outlive the component that owns it.
export function setNavBlocker(blocker: NavBlocker | null): void {
  activeBlocker = blocker;
}

// Run `fn` with the navigation guard temporarily disabled, so an intentional
// in-app navigation (e.g. the editor's own "Go to case" jump) is not
// intercepted by its own dirty-state blocker.
export function runWithoutNavBlock(fn: () => void): void {
  bypass = true;
  try {
    fn();
  } finally {
    bypass = false;
  }
}

// Wrap a wouter navigate call. Returns true when the navigation was handed to
// the active blocker (and therefore deferred), false when it should proceed
// immediately. Used by the Router's `aroundNav` handler.
export function guardNavigation(proceed: Proceed): boolean {
  if (bypass || !activeBlocker) return false;
  activeBlocker(proceed);
  return true;
}
