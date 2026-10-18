import { describe, expect, it } from "vitest";
import { isUnauthenticatedPath } from "../unauthenticated-paths";

describe("mobile unauthenticated endpoint allowlist", () => {
  it("allows the exact pre-auth 2FA challenge route and its query-string form", () => {
    expect(isUnauthenticatedPath("/api/auth/2fa/challenge")).toBe(true);
    expect(
      isUnauthenticatedPath("/api/auth/2fa/challenge?clientType=mobile"),
    ).toBe(true);
  });

  it("does not widen the allowlist to neighboring auth or challenge paths", () => {
    expect(isUnauthenticatedPath("/api/auth/2fa")).toBe(false);
    expect(isUnauthenticatedPath("/api/auth/2fa/challenge/extra")).toBe(false);
    expect(isUnauthenticatedPath("/api/auth/private")).toBe(false);
  });
});
