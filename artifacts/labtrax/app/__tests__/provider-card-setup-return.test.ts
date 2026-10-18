// Where a finished Stripe card setup lands.
//
// A provider starts card setup inside the portal's My Account; a lab user
// starts it from the provider-billing settings screen. The deep link that
// brings them back carries no clue which of the two it was, and on a cold
// start it arrives before anyone knows: memberships are still loading, or the
// app is still on the login screen. The rule these tests hold to is that an
// unknown answer waits, rather than defaulting to the lab screen and dropping
// a provider into a surface they cannot use.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { router } from "expo-router";
import {
  clearProviderCardSetupReturn,
  consumeProviderCardSetupReturn,
  hasProviderCardSetupReturn,
  parseProviderCardSetupReturn,
  resetProviderCardSetupRouting,
  routeProviderCardSetupReturn,
  setProviderCardSetupShell,
  subscribeProviderCardSetupReturn,
} from "@/lib/provider-card-setup-return";

const push = router.push as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetProviderCardSetupRouting();
  push.mockClear();
});

// ── Reading the deep link ──────────────────────────────────────────────────
// Both handlers in app/_layout.tsx (the labtrax:// scheme and the https URL)
// feed their parameters through this, so the two agree by construction.
describe("reading a card-setup return out of a deep link", () => {
  it("takes the session and the cancelled flag", async () => {
    expect(
      parseProviderCardSetupReturn({
        returned: "1",
        providerCardSetupSession: "cs_test_1",
      }),
    ).toEqual({ sessionId: "cs_test_1", cancelled: false });

    expect(
      parseProviderCardSetupReturn({
        returned: "1",
        providerCardSetupSession: "cs_test_1",
        cancelled: "1",
      }),
    ).toEqual({ sessionId: "cs_test_1", cancelled: true });
  });

  it("is not a card-setup return without a session, or without the return flag", async () => {
    expect(parseProviderCardSetupReturn({ returned: "1" })).toBeNull();
    expect(
      parseProviderCardSetupReturn({ providerCardSetupSession: "cs_test_1" }),
    ).toBeNull();
    expect(parseProviderCardSetupReturn(null)).toBeNull();
  });

  it("reads the same way from an https return URL", async () => {
    const url = new URL(
      "https://labtrax.example/return?returned=1&providerCardSetupSession=cs_test_2&cancelled=1",
    );
    expect(
      parseProviderCardSetupReturn(Object.fromEntries(url.searchParams.entries())),
    ).toEqual({ sessionId: "cs_test_2", cancelled: true });
  });
});

// ── Cold start: the answer is not known yet ────────────────────────────────
describe("a return that arrives before the shell is known", () => {
  it("waits, then goes to the portal once the user turns out to be a provider", async () => {
    routeProviderCardSetupReturn({ sessionId: "cs_test_3", cancelled: false });

    // Nothing may happen yet: pushing now would be a guess.
    expect(push).not.toHaveBeenCalled();
    expect(hasProviderCardSetupReturn()).toBe(false);

    setProviderCardSetupShell("provider");

    expect(push).not.toHaveBeenCalled();
    expect(consumeProviderCardSetupReturn()).toEqual({
      sessionId: "cs_test_3",
      cancelled: false,
    });
  });

  it("waits, then opens the billing screen once the user turns out to be a lab user", async () => {
    routeProviderCardSetupReturn({ sessionId: "cs_test_4", cancelled: false });
    setProviderCardSetupShell("lab");

    expect(push).toHaveBeenCalledWith(
      "/settings/provider-billing?providerCardSetupSession=cs_test_4",
    );
    expect(hasProviderCardSetupReturn()).toBe(false);
  });

  it("keeps the cancelled flag across the wait", async () => {
    routeProviderCardSetupReturn({ sessionId: "cs_test_5", cancelled: true });
    setProviderCardSetupShell("provider");

    expect(consumeProviderCardSetupReturn()).toEqual({
      sessionId: "cs_test_5",
      cancelled: true,
    });
  });

  it("hands the return over once, however often the shell is re-published", async () => {
    routeProviderCardSetupReturn({ sessionId: "cs_test_6", cancelled: false });
    setProviderCardSetupShell("provider");
    expect(consumeProviderCardSetupReturn()).not.toBeNull();

    // A refetch or a remount republishes the same answer; the provider has
    // already seen this return and must not be shown it again.
    setProviderCardSetupShell("provider");
    expect(hasProviderCardSetupReturn()).toBe(false);
  });
});

// ── Once the shell is known ────────────────────────────────────────────────
describe("a return that arrives with the shell already known", () => {
  it("goes straight to the portal for a provider, and wakes My Account", async () => {
    const seen: Array<string | null> = [];
    const unsubscribe = subscribeProviderCardSetupReturn(() => {
      seen.push(hasProviderCardSetupReturn() ? "pending" : null);
    });
    setProviderCardSetupShell("provider");

    routeProviderCardSetupReturn({ sessionId: "cs_test_7", cancelled: false });

    expect(seen).toEqual(["pending"]);
    expect(push).not.toHaveBeenCalled();
    expect(consumeProviderCardSetupReturn()?.sessionId).toBe("cs_test_7");
    unsubscribe();
  });

  it("goes straight to the billing screen for a lab user", async () => {
    setProviderCardSetupShell("lab");

    routeProviderCardSetupReturn({ sessionId: "cs_test_8", cancelled: false });

    expect(push).toHaveBeenCalledWith(
      "/settings/provider-billing?providerCardSetupSession=cs_test_8",
    );
  });
});

// ── Signing out ────────────────────────────────────────────────────────────
describe("signing out", () => {
  it("drops a waiting return and forgets the shell", async () => {
    setProviderCardSetupShell("provider");
    routeProviderCardSetupReturn({ sessionId: "cs_test_9", cancelled: false });

    resetProviderCardSetupRouting();
    expect(hasProviderCardSetupReturn()).toBe(false);

    // The next account may get the other shell, so a return arriving now must
    // wait for that account's answer rather than reusing the last one.
    routeProviderCardSetupReturn({ sessionId: "cs_test_10", cancelled: false });
    expect(push).not.toHaveBeenCalled();
    expect(hasProviderCardSetupReturn()).toBe(false);

    setProviderCardSetupShell("lab");
    expect(push).toHaveBeenCalledWith(
      "/settings/provider-billing?providerCardSetupSession=cs_test_10",
    );
  });

  it("leaves nothing queued for the next sign-in", async () => {
    routeProviderCardSetupReturn({ sessionId: "cs_test_11", cancelled: false });
    clearProviderCardSetupReturn();

    setProviderCardSetupShell("provider");
    expect(hasProviderCardSetupReturn()).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });
});
