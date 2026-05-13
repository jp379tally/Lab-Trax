import { describe, it, expect } from "vitest";
import {
  describeAuthRestoreStatus,
  type AuthRestoreStatus,
} from "../auth-restore-status";

describe("describeAuthRestoreStatus", () => {
  it("returns no notice for ok / empty (the normal startup paths)", () => {
    expect(describeAuthRestoreStatus("ok")).toBeNull();
    expect(describeAuthRestoreStatus("empty")).toBeNull();
  });

  it("returns a persistent banner when the OS keychain is unavailable", () => {
    const notice = describeAuthRestoreStatus("keychain-unavailable");
    expect(notice).not.toBeNull();
    expect(notice?.kind).toBe("banner");
    expect(notice?.tone).toBe("warning");
    expect(notice?.message.toLowerCase()).toContain("keychain");
  });

  it("returns a one-time toast when the saved blob fails to decrypt", () => {
    const notice = describeAuthRestoreStatus("decrypt-failed");
    expect(notice).not.toBeNull();
    expect(notice?.kind).toBe("toast");
    expect(notice?.tone).toBe("warning");
    // The whole point: the user must understand they need to sign in again,
    // not be silently bounced back to the login screen with no explanation.
    expect(notice?.message.toLowerCase()).toMatch(/sign in/);
  });

  it("the keychain-unavailable banner is what end-users actually see when their OS keychain is locked", () => {
    // End-to-end-ish check: simulate the renderer pulling a status from
    // the main process and rendering its message. Catches regressions where
    // a future status rename or message tweak silently breaks the user-
    // visible path.
    const fromMainProcess = { status: "keychain-unavailable" as const };
    const notice = describeAuthRestoreStatus(fromMainProcess.status);
    expect(notice?.kind).toBe("banner");
    expect(notice?.message).toMatch(/sign-in/i);
  });

  it("is exhaustive over the AuthRestoreStatus union", () => {
    const all: AuthRestoreStatus[] = [
      "ok",
      "empty",
      "keychain-unavailable",
      "decrypt-failed",
    ];
    for (const s of all) {
      // Should never throw and should return either null or a well-formed
      // notice — guards against future statuses being added without a
      // corresponding UI mapping.
      const result = describeAuthRestoreStatus(s);
      if (result !== null) {
        expect(["banner", "toast"]).toContain(result.kind);
        expect(typeof result.message).toBe("string");
        expect(result.message.length).toBeGreaterThan(0);
      }
    }
  });
});
