import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLabLookupToken,
  resolveLabLookupToken,
  labLookupSelectionKey,
} from "./lab-lookup-token.js";

describe("public lab lookup tokens", () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = "lab-lookup-token-test-secret";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  it("resolves an encrypted organization reference without exposing its ID", () => {
    const organizationId = "org_very_private_internal_id";
    const token = createLabLookupToken(organizationId);

    expect(token).not.toContain(organizationId);
    expect(resolveLabLookupToken(token)).toBe(organizationId);
  });

  it("rejects tampered and expired tokens", () => {
    const token = createLabLookupToken("org_private");
    const lastChar = token.at(-1);
    const tampered = `${token.slice(0, -1)}${lastChar === "a" ? "b" : "a"}`;
    expect(resolveLabLookupToken(tampered)).toBeNull();

    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    expect(resolveLabLookupToken(token)).toBeNull();
  });

  it("uses a stable opaque selection key across independently issued tokens", () => {
    const id = "private_lab_id";
    expect(createLabLookupToken(id)).not.toBe(createLabLookupToken(id));
    expect(labLookupSelectionKey(id)).toBe(labLookupSelectionKey(id));
    expect(labLookupSelectionKey(id)).not.toContain(id);
    expect(labLookupSelectionKey(id)).not.toBe(labLookupSelectionKey("another_lab"));
    expect(resolveLabLookupToken(labLookupSelectionKey(id))).toBeNull();
  });
});