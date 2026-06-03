import { describe, it, expect } from "vitest";
import { isUnauthenticatedPath } from "../unauthenticated-paths";

// Regression firewall for the TestFlight login-screen bug where the red banner
// "Connection error: Not authenticated: no bearer token available." appeared on
// the sign-in screen. Root cause: resilientFetch's no-bearer guard (added for
// the cookie-jar CSRF fix) was also blocking the PUBLIC auth endpoints that are
// called before a token exists, so the act of signing in threw before the
// request was ever sent.
//
// These tests pin the contract in BOTH directions:
//  1. Public, pre-auth endpoints MUST bypass the bearer guard (or login breaks).
//  2. Authenticated endpoints MUST NOT bypass it (or the cookie-jar CSRF trap
//     returns — see .agents/memory/mobile-cookie-jar-csrf-trap.md).

describe("isUnauthenticatedPath", () => {
  it.each([
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/2fa/challenge",
    "/api/auth/refresh",
  ])("treats public pre-auth endpoint %s as unauthenticated", (path) => {
    expect(isUnauthenticatedPath(path)).toBe(true);
  });

  it("ignores query strings when matching public paths", () => {
    expect(isUnauthenticatedPath("/api/auth/login?foo=bar")).toBe(true);
  });

  it("matches public paths given as absolute URLs", () => {
    expect(isUnauthenticatedPath("https://lab-trax.replit.app/api/auth/login")).toBe(true);
  });

  it.each([
    "/api/auth/me",
    "/api/auth/logout",
    "/api/auth/users/123/password",
    "/api/auth/users/123/profile",
    "/api/auth/2fa/status",
    "/api/auth/2fa/setup",
    "/api/cases",
    "/api/legacy/cases",
    "/api/invoices",
  ])("keeps authenticated endpoint %s subject to the bearer guard", (path) => {
    expect(isUnauthenticatedPath(path)).toBe(false);
  });

  it("does not treat a path that merely contains a public path as public", () => {
    expect(isUnauthenticatedPath("/api/auth/login/extra")).toBe(false);
    expect(isUnauthenticatedPath("/api/auth/refresh-token-admin")).toBe(false);
  });

  it("is strict about trailing slashes and case (only the exact path is public)", () => {
    expect(isUnauthenticatedPath("/api/auth/login/")).toBe(false);
    expect(isUnauthenticatedPath("/API/AUTH/LOGIN")).toBe(false);
  });
});
