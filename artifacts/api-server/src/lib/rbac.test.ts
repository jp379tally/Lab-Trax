/**
 * Unit tests for rbac.ts, focused on the `getActiveMembership` choke point
 * that every permission check (`requireMembership`, `requireAnyRole`,
 * `requireCapability`, `hasCapability`) funnels through.
 *
 * This is a regression suite for the Quick Reference Notes outage: all six
 * QRN routes used to call `requireAnyRole(req as any, organizationId, roles)`,
 * passing the whole Express request object instead of a user id string. That
 * object reached `db.query.organizationMemberships.findFirst` as a bound
 * query parameter, which throws deep inside the pg driver while trying to
 * serialize it ("Converting circular structure to JSON") and poisons the
 * pooled connection — breaking the *next*, unrelated request too.
 *
 * No database is required here: `@workspace/db` is fully mocked so these
 * tests run everywhere, every time, and can never silently skip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindFirstMembership, mockFindManyDefs, mockFindFirstGrant } = vi.hoisted(() => ({
  mockFindFirstMembership: vi.fn(),
  mockFindManyDefs: vi.fn(),
  mockFindFirstGrant: vi.fn(),
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...orig,
    db: {
      query: {
        organizationMemberships: { findFirst: mockFindFirstMembership },
        labPermissionDefinitions: { findMany: mockFindManyDefs },
        labMemberPermissions: { findFirst: mockFindFirstGrant },
      },
    },
  };
});

import { logger } from "./logger.js";
import {
  getActiveMembership,
  requireAnyRole,
  requireCapability,
  requireMembership,
  hasCapability,
} from "./rbac.js";

describe("rbac.ts", () => {
  let loggerErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    loggerErrorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    mockFindManyDefs.mockResolvedValue([]);
  });

  afterEach(() => {
    loggerErrorSpy.mockRestore();
  });

  // ── The connection-poisoning regression ──────────────────────────────────
  describe("getActiveMembership rejects a non-string userId before touching the database", () => {
    const badUserIds: Array<[string, unknown]> = [
      ["an Express-request-shaped object", { auth: { userId: "u1" }, headers: {}, body: {} }],
      ["undefined", undefined],
      ["null", null],
      ["a number", 12345],
      ["an array", ["u1"]],
      ["an empty string", ""],
    ];

    it.each(badUserIds)("rejects %s with a 500 and never calls the db", async (_label, badId) => {
      await expect(getActiveMembership(badId as unknown as string, "org_1")).rejects.toMatchObject({
        statusCode: 500,
      });
      expect(mockFindFirstMembership).not.toHaveBeenCalled();
    });

    it("logs the userId's type for diagnosis, but never the value itself", async () => {
      const sensitive = { auth: { userId: "u1" }, cookies: { session: "leak-me-not" } };
      await expect(getActiveMembership(sensitive as unknown as string, "org_42")).rejects.toThrow(
        "Invalid user context for permission check.",
      );

      expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
      const [meta] = loggerErrorSpy.mock.calls[0] as [Record<string, unknown>, string];
      expect(meta).toMatchObject({ userIdType: "object", organizationId: "org_42" });
      expect(JSON.stringify(meta)).not.toContain("leak-me-not");
    });

    it("requireMembership propagates the same fail-fast rejection", async () => {
      await expect(requireMembership({} as unknown as string, "org_1")).rejects.toMatchObject({
        statusCode: 500,
      });
      expect(mockFindFirstMembership).not.toHaveBeenCalled();
    });

    it("requireAnyRole propagates the same fail-fast rejection", async () => {
      await expect(
        requireAnyRole({} as unknown as string, "org_1", ["owner", "admin"]),
      ).rejects.toMatchObject({ statusCode: 500 });
      expect(mockFindFirstMembership).not.toHaveBeenCalled();
    });

    it("requireCapability propagates the same fail-fast rejection", async () => {
      await expect(
        requireCapability({} as unknown as string, "org_1", "delete_cases" as never),
      ).rejects.toMatchObject({ statusCode: 500 });
      expect(mockFindFirstMembership).not.toHaveBeenCalled();
    });

    it("hasCapability propagates the same fail-fast rejection instead of swallowing it as false", async () => {
      await expect(
        hasCapability({} as unknown as string, "org_1", "delete_cases" as never),
      ).rejects.toMatchObject({ statusCode: 500 });
      expect(mockFindFirstMembership).not.toHaveBeenCalled();
    });
  });

  // ── Normal behavior, unaffected by the guard ─────────────────────────────
  describe("getActiveMembership normal behavior", () => {
    it("returns the active membership row when one is found", async () => {
      mockFindFirstMembership.mockResolvedValue({
        id: "m1",
        userId: "u1",
        labId: "org_1",
        role: "admin",
        status: "active",
      });

      const membership = await getActiveMembership("u1", "org_1");
      expect(membership).toMatchObject({ id: "m1", role: "admin" });
      expect(mockFindFirstMembership).toHaveBeenCalledTimes(1);
    });

    it("returns null (not an error) when no active membership exists", async () => {
      mockFindFirstMembership.mockResolvedValue(undefined);
      const membership = await getActiveMembership("u1", "org_1");
      expect(membership).toBeNull();
    });
  });

  describe("requireMembership", () => {
    it("resolves with the membership when active", async () => {
      mockFindFirstMembership.mockResolvedValue({ id: "m1", role: "user" });
      await expect(requireMembership("u1", "org_1")).resolves.toMatchObject({ role: "user" });
    });

    it("throws 403 (not 500) when there is no active membership", async () => {
      mockFindFirstMembership.mockResolvedValue(undefined);
      await expect(requireMembership("u1", "org_1")).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  describe("requireAnyRole", () => {
    it("resolves with the membership when the role is in the allowed list", async () => {
      mockFindFirstMembership.mockResolvedValue({ id: "m1", role: "admin" });
      await expect(requireAnyRole("u1", "org_1", ["owner", "admin"])).resolves.toMatchObject({
        role: "admin",
      });
    });

    it("throws 403 when the member's role is not in the allowed list", async () => {
      mockFindFirstMembership.mockResolvedValue({ id: "m1", role: "read_only" });
      await expect(requireAnyRole("u1", "org_1", ["owner", "admin", "user"])).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it("throws 403 when there is no membership at all", async () => {
      mockFindFirstMembership.mockResolvedValue(undefined);
      await expect(requireAnyRole("u1", "org_1", ["owner"])).rejects.toMatchObject({
        statusCode: 403,
      });
    });
  });

  describe("hasCapability", () => {
    it("returns true for owner/admin roles without checking custom grants", async () => {
      mockFindFirstMembership.mockResolvedValue({ id: "m1", role: "owner" });
      await expect(hasCapability("u1", "org_1", "delete_cases" as never)).resolves.toBe(true);
      expect(mockFindManyDefs).not.toHaveBeenCalled();
    });

    it("returns false when there is no membership", async () => {
      mockFindFirstMembership.mockResolvedValue(undefined);
      await expect(hasCapability("u1", "org_1", "delete_cases" as never)).resolves.toBe(false);
    });

    it("returns false for a non-admin role with no matching permission definitions", async () => {
      mockFindFirstMembership.mockResolvedValue({ id: "m1", role: "user" });
      mockFindManyDefs.mockResolvedValue([]);
      await expect(hasCapability("u1", "org_1", "delete_cases" as never)).resolves.toBe(false);
    });

    it("returns true for a non-admin role with a matching explicit grant", async () => {
      mockFindFirstMembership.mockResolvedValue({ id: "m1", role: "user" });
      mockFindManyDefs.mockResolvedValue([{ id: "def1" }]);
      mockFindFirstGrant.mockResolvedValue({ id: "grant1", membershipId: "m1", permissionDefinitionId: "def1" });
      await expect(hasCapability("u1", "org_1", "delete_cases" as never)).resolves.toBe(true);
    });
  });
});
