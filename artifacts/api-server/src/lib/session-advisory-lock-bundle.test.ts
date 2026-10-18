import { describe, expect, it, vi } from "vitest";
import { SessionAdvisoryLockBundle } from "./session-advisory-lock-bundle";

describe("SessionAdvisoryLockBundle", () => {
  it("unlocks in reverse order before returning the client", async () => {
    const events: string[] = [];
    const client = {
      query: vi.fn(async () => { events.push("safety-unlock"); }),
      release: vi.fn(() => { events.push("release-client"); }),
    };
    const bundle = new SessionAdvisoryLockBundle(client);
    bundle.registerUnlock(async () => { events.push("provider"); });
    bundle.registerUnlock(async () => { events.push("deposit"); });

    await bundle.release();

    expect(events).toEqual([
      "deposit",
      "provider",
      "safety-unlock",
      "release-client",
    ]);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it("continues cleanup after an unlock error and is idempotent", async () => {
    const providerUnlock = vi.fn(async () => {});
    const depositUnlock = vi.fn(async () => {
      throw new Error("deposit unlock failed");
    });
    const client = {
      query: vi.fn(async () => {}),
      release: vi.fn(),
    };
    const bundle = new SessionAdvisoryLockBundle(client);
    bundle.registerUnlock(providerUnlock);
    bundle.registerUnlock(depositUnlock);

    await expect(bundle.release()).rejects.toThrow("deposit unlock failed");
    await bundle.release();

    expect(depositUnlock).toHaveBeenCalledTimes(1);
    expect(providerUnlock).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("destroys the client when the safety unlock fails", async () => {
    const client = {
      query: vi.fn(async () => {
        throw new Error("safety unlock failed");
      }),
      release: vi.fn(),
    };
    const bundle = new SessionAdvisoryLockBundle(client);

    await expect(bundle.release()).rejects.toThrow("safety unlock failed");

    expect(client.release).toHaveBeenCalledWith(true);
  });

  it("rejects locks registered after cleanup", async () => {
    const bundle = new SessionAdvisoryLockBundle({
      query: vi.fn(async () => {}),
      release: vi.fn(),
    });
    await bundle.release();

    expect(() => bundle.registerUnlock(async () => {})).toThrow(
      "Cannot register an advisory lock after bundle release.",
    );
  });
});