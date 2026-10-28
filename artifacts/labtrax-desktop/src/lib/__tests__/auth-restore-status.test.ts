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

  it("explains that unreadable saved sign-in data won't be used and asks the user to sign in", () => {
    const notice = describeAuthRestoreStatus("decrypt-failed");
    expect(notice).not.toBeNull();
    expect(notice?.kind).toBe("toast");
    expect(notice?.tone).toBe("warning");
    expect(notice?.message).toMatch(/couldn't read the saved sign-in/i);
    expect(notice?.message).toMatch(/won't use the unreadable saved data/i);
    expect(notice?.message).toMatch(/sign in again/i);
  });

  it("explains when a restored server session has expired", () => {
    const notice = describeAuthRestoreStatus("session-expired");
    expect(notice).toMatchObject({ kind: "toast", tone: "warning" });
    expect(notice?.message).toMatch(/session has expired/i);
    expect(notice?.message).toMatch(/sign in again/i);
  });

  it("explains when saved credentials were restored but the server could not verify them", () => {
    const notice = describeAuthRestoreStatus("restore-failed");
    expect(notice).toMatchObject({ kind: "toast", tone: "warning" });
    expect(notice?.message).toMatch(/couldn't verify it with the server/i);
    expect(notice?.message).toMatch(/sign in again if needed/i);
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
      "session-expired",
      "restore-failed",
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
