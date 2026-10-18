/**
 * Guards the desktop API prefix convention (Task: prevent silent /api/api
 * 404s). Desktop `apiFetch`/`apiUrl` callers pass the path AFTER `/api`;
 * the helper prepends `/api` exactly once. Mobile resilientFetch callers
 * include `/api` themselves — copying such a path into a desktop call must
 * fail loudly here instead of producing a misleading server 404 (as in the
 * Quick Reference Notes outage).
 */
import { describe, it, expect } from "vitest";
import { apiUrl, apiFetch } from "../api";

describe("apiUrl prefix convention", () => {
  it("prepends /api exactly once to a hand-written endpoint path", () => {
    // Representative hand-written QRN endpoint (settings.tsx / cases.tsx).
    const orgId = "org-123";
    const url = apiUrl(`/organizations/${orgId}/quick-reference-notes`);
    expect(url).toBe(`/api/organizations/${orgId}/quick-reference-notes`);
    expect(url).not.toContain("/api/api");
  });

  it("normalizes a missing leading slash", () => {
    expect(apiUrl("cases")).toBe("/api/cases");
  });

  it("passes absolute http(s) URLs through untouched", () => {
    expect(apiUrl("https://example.com/x")).toBe("https://example.com/x");
  });

  it("rejects paths that already include the /api prefix (would become /api/api)", () => {
    expect(() => apiUrl("/api/organizations/org-123/quick-reference-notes")).toThrow(
      /\/api\/api/,
    );
    expect(() => apiUrl("api/cases")).toThrow(/\/api\/api/);
    expect(() => apiUrl("/api")).toThrow(/\/api\/api/);
  });

  it("does not reject legitimate paths that merely start with 'api' as a word", () => {
    expect(apiUrl("/api-keys")).toBe("/api/api-keys");
    expect(apiUrl("/apiary")).toBe("/api/apiary");
  });

  it("apiFetch rejects a mobile-style /api/... path before any network call", async () => {
    // No fetch mock needed: the guard must throw at URL construction,
    // before a request is ever issued.
    await expect(
      apiFetch("/api/organizations/org-123/quick-reference-notes"),
    ).rejects.toThrow(/\/api\/api/);
  });
});
